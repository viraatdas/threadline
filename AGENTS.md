# Threadline — Agent Guide

The single source of truth for working in this repo. Read this before touching code.
Supporting docs: `PRODUCT.md` (why), `DESIGN.md` (visual system), `README.md`
(setup/deploy prose), `DECISIONS.md` (append-only history).

## What this is

A private, **single-user** relationship-intelligence workspace. It ingests the
owner's Gmail / LinkedIn / X history **read-only**, reconstructs who was
contacted, when, through which channel, and whether they replied — then surfaces
that as a Kanban board, a people/company directory, and a follow-up queue.

It is not a CRM. No teams, no tenants, no pipeline theater. One owner, one
database, source-grounded conclusions the owner can override.

## Hard invariants — do not break these

1. **Read-only external boundary.** Threadline may read, classify, and *draft*.
   It must never send, reply, post, modify, delete, or connect through Gmail,
   LinkedIn, or X. Enforced by `lib/security/read-only.ts`
   (`READ_ONLY_CAPABILITIES`, `assertExternalActionAllowed`) and by a database
   CHECK constraint: `integration_accounts.read_only = true`. Gmail requests only
   `gmail.readonly`.
2. **Owner-only access.** Every page goes through `requireOwner()`; every API
   route checks `isOwnerSession()` or `isAuthorizedCronRequest()` (timing-safe
   `CRON_SECRET` compare). Auth is Google OAuth via Auth.js, allowlisted to the
   normalized `OWNER_EMAIL`.
3. **Never log message content.** Sync/worker/enrich logs carry counts, status,
   and lifecycle IDs only — never bodies, model output, or credential values.
   Treat all provider message content as hostile input.
4. **Credentials never touch source.** Provider credentials live AES-256-GCM
   sealed in `integration_accounts.credential_ciphertext` (envelope schema in
   `lib/security/credentials.ts`, keyed by `INTEGRATION_ENCRYPTION_KEY` +
   `…_KEY_VERSION`). Secrets go in Vercel/Fly secret stores only.
5. **Owner overrides win.** Anything with `has_manual_override = true` is not
   re-derived by sync, reconciliation, or enrichment.

## Stack

Next.js 16 App Router · React 19 · TypeScript (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Tailwind v4 · Radix · Drizzle ORM on generic
Postgres · Zod · Auth.js · Vitest + Playwright · pnpm 10 · Node 24.

## Layout and ownership

| Path | Owns |
| --- | --- |
| `lib/domain/` | Channel-agnostic enums (`constants.ts`), Zod schemas, connector/runner interfaces (`contracts.ts`). Changing an enum here ripples into the DB enum — needs a migration. |
| `lib/db/` | Drizzle schema, client, migrations, repositories, and `workspace.ts` (the big read-side loaders). |
| `lib/auth/` · `lib/security/` | Owner identity; credential vault, env validation, idempotency hashing, read-only guard. |
| `src/integrations/{gmail,linkedin,x}/` | Per-channel connector + normalizer + persistence. Each implements `ChannelConnector` and stays behind the domain interfaces. |
| `src/sync/` | Cross-channel orchestration: orchestrator, per-channel executors, Postgres coordinator store, reconciler, retry, checkpointing, backfill chaining. |
| `src/enrichment/` | Cheap-model conversation digests + deterministic signature-block title extraction. |
| `app/(dashboard)/` | Board / People / Outreach / Settings pages + `workspace-actions.ts` (all owner mutations). |
| `app/api/` | Auth, per-channel integration routes, `/api/sync` (owner), `/api/cron/sync`, `/api/cron/enrich`. |
| `components/` | `shell/` nav, `people/` (board, workspace, detail), `outreach/`, `settings/`, `dashboard/`. |
| `worker/codex/` + `infra/fly/` | The private Fly analysis worker and its deploy config. |

## Data model (`lib/db/schema.ts`)

`integration_accounts` → `channel_identities` → `contacts` (⇢ `companies`).
Ingested threads become `conversations` + `conversation_participants` +
`messages`; every contact-facing event is also a `touchpoints` row (the unit the
timeline and metrics are computed from). Follow-ups are `outreach_plans`.
Analysis is `analysis_jobs` → `analysis_results`. Sync bookkeeping is
`sync_cursors` + `sync_runs`. Owner actions land in `audit_events`.

Cross-cutting column groups: `sourceColumns` (provenance/confidence),
`overrideColumns` (manual override trail), `timestamps`.

Every ingested row carries an `idempotency_key` from
`createIdempotencyKey(namespace, ...parts)` under a unique index — re-ingesting
the same thread is a no-op, not a duplicate.

## How sync actually works

`/api/sync` (owner session, also accepts a plain `GET` link for manual backfills)
and `/api/cron/sync` (Bearer `CRON_SECRET`) both call `runUnifiedSync` →
`UnifiedSyncOrchestrator`:

1. List enabled accounts for the requested channels; run ≤3 concurrently.
2. Per account: **claim a lease** (`claimRun`) so two invocations can't overlap,
   run the channel executor under retry + timeout, then `completeRun` with counts.
   A channel failure is isolated — it never fails the others.
3. After all accounts, **reconcile**: conservative email-based contact merges and
   recomputed relationship metrics/reply state. Scoped by `touchedSince` (the run
   window) — recomputing every historical contact blows the function budget.

### Gmail backfill (the fiddly part)

Hobby-tier functions cap at ~240s, so the 1.5-year backfill is *resumable and
self-chaining*:

- `runWindowedBackfill` walks history newest-first and writes a durable watermark
  (`oldestCoveredAt`) after **every page**. A killed run resumes exactly there.
- Pages are `BACKFILL_PAGE_SIZE` (25) threads; the orchestrator caps a channel
  run at 240s and only a completed page checkpoints, so pages must stay short.
  Functions are pinned to `sfo1` (`vercel.json` `regions`) next to the RDS
  database in `us-west-1`; from `iad1` each thread cost ~2s and pages timed out.
- A 120s soft budget stops the run *between* pages so it resolves as `partial`
  rather than being killed mid-flight (which would discard the work).
- If work remains, the response reports `backfillPending`, and
  `continueBackfillIfPending` dispatches the next link server-side via `after()`
  using the cron secret (`_chain=N`, capped at 400). The chain self-terminates;
  the daily cron backstops any dropped link.
- Chained links intentionally **ignore the request signal** — the parent hangs up
  after a few seconds and honoring it would abort the child. The dispatch timeout
  is 30s to survive a cold start.
- The incremental history cursor is only promoted once the whole window is
  covered. An expired history cursor falls back to a windowed backfill.
- A completed backfill is a no-op on re-run (`done` + target depth check).

Target depth is `GMAIL_BACKFILL_TARGET_DAYS` (548 days, ~1.5 years) in
`src/integrations/gmail/constants.ts`; the chain link, `vercel.json`, and the
Fly hourly machine all use it, and a test pins `vercel.json` to the constant.
Cron: `vercel.json` runs `/api/cron/sync?gmailForceBackfill=1&gmailBackfillDays=548&channels=gmail`
daily at 15:00 UTC.

## The board

`/` redirects to `/people?view=board`. Four columns collapse the 7-value
`relationship_stage` enum into the only four answers that matter: **Planned**
(not sent) → **Waiting for reply** (their turn) → **Replied** (your turn) →
**Closed**.

Lenses (`components/people/people-board.tsx`), narrowest → widest:
- `outreach` — threads *the owner started*: first stored message is outbound,
  not a noise sender, not the owner's own domain. Uses the server-computed
  `firstMessageDirection`, because list payloads ship with an empty timeline.
- `conversations` — anything with an outbound touch, a reply, or a manual edit.
- `all`.

The initial lens is the narrowest one that actually has people, so the board
never opens blank while data is sparse or still syncing.

`isNoiseEmail` (`components/people/formatters.ts`) filters no-reply/newsletter
locals and bulk-sender domains. Campaigns are a **client-side, localStorage**
grouping (`components/people/campaigns.ts`) — no server state.

Deleting a relationship is an **archive**, not a delete:
`metadata.archivedAt` is set (undoable) so a later sync cannot resurrect it.

## Read path and caching

`lib/db/workspace.ts` loads everything, then narrows per surface:
`loadPeopleListWorkspaceData` / `loadOutreachWorkspaceData` are `unstable_cache`d
(60s, tag `WORKSPACE_CACHE_TAG`) and **strip detail-only fields** (evidence,
overrides, notes, timelines, actor emails) before crossing the server boundary.
Detail pages use the scoped `loadPersonWorkspaceData` / `loadCompanyWorkspaceData`
loaders — never the full loader.

Mutations live in `app/(dashboard)/workspace-actions.ts` (`"use server"`): each
one validates with Zod, runs in a transaction, records a `ManualOverride` +
`audit_events` row, then `revalidateTag(WORKSPACE_CACHE_TAG)` + `revalidatePath`.

## Analysis and enrichment (two separate things)

- **Codex worker** (`worker/codex/`, deployed to Fly) — one serialized machine
  polling `analysis_jobs`, claiming with a lease, running the local
  subscription-backed `codex` CLI (`gpt-5.6-luna`) against a strict output schema,
  writing `analysis_results`. Auth is a file-backed ChatGPT login persisted at
  `/data/codex/auth.json`; **no `OPENAI_API_KEY`, ever**. Health at
  `/livez` / `/readyz`.
- **Enrichment cron** (`app/api/cron/enrich/route.ts`) — pass 1 fills missing
  titles from inbound signature blocks (deterministic, no model); pass 2 writes a
  one-sentence conversation digest via the Vercel AI Gateway
  (`AI_DIGEST_MODEL`, default `openai/gpt-5-nano`) into `contacts.metadata.aiDigest`
  using a jsonb concat so concurrent writers survive. Only re-digests contacts
  touched since the last pass. **This route is not in `vercel.json`** — the only
  Vercel cron is the daily sync. Enrichment is driven externally: as of
  2026-07-27 an hourly Fly machine (`threadline-hourly-sync`, in the
  `threadline-codex-worker` app) called plain sync + a forced-backfill no-op +
  `/api/cron/enrich`. Verify that machine still exists before assuming digests
  are being produced.

## Commands

```
pnpm dev            pnpm build          pnpm lint       pnpm typecheck
pnpm test           # all vitest suites (unit, dashboard, people-outreach, gmail,
                    # linkedin, x, sync, codex-worker)
pnpm e2e            # owner-authenticated Playwright release suite
pnpm test:dashboard-browser
pnpm db:generate    pnpm db:migrate     pnpm db:check
pnpm check          # everything above — run before any production deploy
```

CI (`.github/workflows/ci.yml`) runs `pnpm check` on PRs and pushes to `main`
against a Postgres 17 service on port 65432.

Destructive Postgres integration tests read `TEST_DATABASE_URL` and must point at
a disposable database (`postgres://threadline:threadline@127.0.0.1:65432/threadline_test`).
**Never point them at `DATABASE_URL` or production.**

## Deployment topology

Three private pieces: **Postgres** (AWS RDS instance `threadline-db`,
Postgres 17, `us-west-1`, account `597088032164`; TLS required, so
`DATABASE_URL` carries `sslmode=require`; the master URL is also kept in AWS
Secrets Manager as `threadline/database-url`) · **Vercel** (Next.js app, project
`threadline`, domain `threadline.viraat.dev`) · **one Fly machine** (Codex
worker, `infra/fly/`). Postgres moved off Supabase on 2026-09-09 after the free
org hit its egress quota and gated every connection. Migrations are applied with `pnpm db:migrate` before
traffic.

Required env (see `.env.example`): `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `AUTH_URL`, `OWNER_EMAIL`, `DATABASE_URL`,
`INTEGRATION_ENCRYPTION_KEY`(+`_VERSION`), `CRON_SECRET`,
`GMAIL_OAUTH_REDIRECT_URI`; optional `LINKED_API_BASE_URL`, `AI_DIGEST_MODEL`.

X cookies are installed locally and encrypted straight into Postgres via
`scripts/x-auth/install.ts` — values never print.

## Conventions

- `exactOptionalPropertyTypes` is on: build optional fields with
  `...(value ? { key: value } : {})`, never `key: undefined`.
- Comments explain *why* (especially non-obvious ordering, budgets, and
  boundaries). Match the surrounding density — the sync and backfill code is
  deliberately well-commented; UI code is not.
- Validate every external/user input at the boundary with Zod.
- New channel work goes behind `ChannelConnector` in its own
  `src/integrations/<channel>/` directory. Don't reach into another channel's
  internals or edit shared enums/schema ad hoc.
- Colors are OKLCH tokens from `DESIGN.md`. No gradients, no purple "AI" accents,
  no card soup. Status is never color-alone.

## Gotchas discovered the hard way

- postgres.js returns raw aggregate timestamps as **strings** unless the Drizzle
  SQL expression uses `.mapWith(<timestamp column>)`. Contact merge metrics broke
  on this — preserve the decoder before writing timestamp columns.
- Repo targets Node 24.x. Node 26 works locally but warns on `engines`.
- Vercel source deployments have stalled at deployment creation; the reliable
  path is `vercel pull --environment=production` → `vercel build --prod` →
  `vercel deploy --prebuilt --prod --archive=tgz`.
- Gmail API must be **enabled in the GCP project** or prod Gmail connect 500s
  with a 403. Prod secrets are write-only; `vercel logs` is a one-shot fetch.
- Fly deploys are blocked while the Fly org has an overdue invoice — the error is
  a billing restriction, not a config problem.
- Docker container `threadline-release-pg` on port 65432 may linger from release
  verification; remove with `docker rm -f threadline-release-pg`.

## Version control

This checkout is jj (Jujutsu) colocated with git; `jj status` / `jj diff` /
`jj log` are authoritative. Branch: work happens off `main`. Do not push or
deploy unless the request explicitly asks for it.
