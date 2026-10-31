# Outbound (repo: threadline) — Agent Guide

The single source of truth for working in this repo. Supporting docs:
`PRODUCT.md` (why), `DESIGN.md` (visual system), `README.md` (setup/deploy),
`DECISIONS.md` (append-only history).

## What this is

A private, single-owner outbound tool for selling **Offstage**
(https://offstage.cloud — macOS sandboxes for agents and CI). Think a
one-person Monaco: **find** companies that need Macs, **research** them with AI,
**enroll** their people in email + LinkedIn sequences, **approve** every
message, and **stop** automatically when they reply.

It replaced "Threadline" (a read-only Gmail/LinkedIn/X relationship-history
mirror) on 2026-10-31. That sync/backfill/analysis machinery is gone.

## Hard invariants

1. **Nothing is sent without an owner click.** `sendMessage` in `lib/engine.ts`
   is the only code path that contacts a prospect, and only Today's Send
   button (`sendAction`) calls it, for one draft at a time. Crons and refreshes
   draft, detect replies, and confirm queued LinkedIn actions; they never send.
2. **Replies stop sequences.** Before any send to someone already contacted,
   Gmail is re-checked for a reply. A reply (or bounce) skips open drafts.
3. **Owner-only.** Pages go through `requireOwner()`; every server action
   starts with `assertOwner()` (via `run()` in `app/(app)/actions.ts`); machine
   routes check a bearer secret in constant time (`lib/auth/machine.ts`).
4. **Credentials are sealed.** Gmail/LinkedIn/GitHub/Apollo credentials live
   AES-256-GCM sealed in `connections` (`lib/store.ts`, AAD = provider), keyed
   by `INTEGRATION_ENCRYPTION_KEY`. Never log message bodies, model output, or
   credentials.
5. **Scraped text is hostile.** Website/HN/YC/LinkedIn content reaches the model
   fenced in `<untrusted>` tags (`lib/ai.ts`); website fetches go through the
   SSRF guard in `lib/sources/website.ts`.
6. **No GitHub email harvesting.** GitHub's AUP forbids using its data for
   unsolicited email. GitHub is an account-level signal only.

## Stack

Next.js 16 App Router · React 19 · TypeScript (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Tailwind v4 · Drizzle on Postgres (AWS RDS) ·
Zod 4 · Auth.js (Google, allowlisted `OWNER_EMAIL`) · AI SDK 7 + OpenRouter ·
Vitest (+ PGlite) · pnpm 10 · Node 24.

## Layout

| Path | Owns |
| --- | --- |
| `lib/domain.ts` | Stages, channels, campaign step schema, settings schema + Offstage defaults, the default campaign. |
| `lib/db/schema.ts` | 7 tables: `connections`, `settings`, `companies`, `people`, `signals`, `campaigns`, `messages`. Text columns typed in TS — no pg enums. |
| `lib/sources/` | Pure fetch+parse finders returning `FindResult` (`types.ts`): `yc.ts` (YC directory, YC company pages → founders, YC CLI JSON), `github.ts` (macOS CI workflows), `hn.ts`, `website.ts` (SSRF-guarded scrape), `apollo.ts`, `email-guess.ts`. Never touch the DB. |
| `lib/ingest.ts` | Upserts `FindResult`s: dedupes companies by domain/GitHub login/YC slug, people by email/LinkedIn/name-at-company, signals by `dedupeKey`. Fills gaps only. |
| `lib/engine.ts` | Research, find people, enroll, draft due steps, send, skip, reply/bounce detection, `refresh()`. |
| `lib/ai.ts` | `researchCompany` (Haiku: score 0–100, fit, hook, titles) and `draftStep` (Sonnet). |
| `lib/gmail.ts` | OAuth (`gmail.send` + `gmail.readonly`), token refresh, MIME building, threaded sends, reply/bounce lookup. Plain fetch, no googleapis. |
| `lib/linkedin.ts` | Linked API client: people search, connection requests, messages, inbox poll. Workflows are async: start → poll. |
| `lib/queries.ts` | Read-side loaders for each page. |
| `lib/store.ts` | Settings, runtime state, sealed connections, API keys (DB first, env fallback). |
| `app/(app)/` | Pages: Today (`/`), Find, Prospects (+ `[id]`), Campaigns, Settings; `actions.ts` holds every mutation. |
| `app/api/` | Auth, `integrations/gmail/{connect,callback}`, `cron` (daily refresh), `import` (CLI push). |
| `components/` | One client component per page + `ui.tsx` primitives + `shell/`. |
| `scripts/scout.ts` | Local CLI: `pnpm scout yc|yc-json|github|hn` using the owner's own `yc`/`gh` logins, pushing to `/api/import`. |

## How a prospect moves

1. **Find** (`findAction` or `pnpm scout`) → `ingest` → companies + signals
   (+ people when the source has them).
2. **Research** (`researchCompanyById`): fetch website, check the GitHub org
   for macOS workflows if a token exists, add a `website` signal, then Haiku
   scores fit and writes a hook.
3. **Find people** (`findPeopleForCompany`): YC founder page → Apollo (if key)
   → LinkedIn search (if connected, only when <2 found). Missing emails get a
   `first@domain` guess (only if the domain has MX), marked `guessed`.
4. **Enroll** sets `stage=active, nextStep=0, nextStepAt=now` and calls
   `draftDue`, which writes one draft per due step. Steps the person can't
   receive (no email / bounced / no LinkedIn) are recorded as `skipped` and the
   sequence moves on in the same pass.
5. **Send** (Today): claim the row (`draft|failed → sending`) so double clicks
   send once, check daily limits (rolling 24h), re-check replies, send.
   Follow-up emails reuse the Gmail `threadId`, `Re: <first subject>`, and
   `In-Reply-To` = the stored RFC Message-ID. LinkedIn sends wait up to 30s for
   the workflow; otherwise stay `sending` until the next refresh confirms them.
   "Already connected/pending" counts as done.
6. `advance` schedules the next step at `sentAt + waitDays`. After the last step
   the person gets 7 days, then closes as `no_reply`.
7. **Refresh** (daily cron 15:00 UTC + Today's "Check replies"): confirm queued
   LinkedIn workflows, check Gmail threads/addresses for replies and bounces,
   poll the LinkedIn inbox, then `draftDue`.

Stages: `new → active → replied → meeting`, or `closed` (`closedReason`:
`no_reply`, `owner`, …). Message statuses: `draft | sending | sent | failed |
skipped | received`; a partial unique index allows one outbound message per
(person, campaign, step).

## AI

`lib/ai.ts` uses OpenRouter when `OPENROUTER_API_KEY` is set (the Vercel AI
Gateway free tier blocks Claude), else the gateway. Defaults:
`AI_RESEARCH_MODEL=anthropic/claude-haiku-5.5` (~$0.0005/company),
`AI_DRAFT_MODEL=anthropic/claude-sonnet-5.5`. Length limits are applied after
generation (clip), never in the schema — an overshoot must not fail a run.

## Commands

```
pnpm dev        pnpm build      pnpm lint       pnpm typecheck
pnpm test       # vitest: sources, units, engine integration (PGlite, or real
                # Postgres when TEST_DATABASE_URL is set — that DB is wiped)
pnpm db:generate  pnpm db:migrate  pnpm db:check
pnpm scout <yc|yc-json|github|hn> [args] [--dry]
pnpm check      # lint + typecheck + db:check + test + build — before any deploy
```

## Deployment

Vercel project `threadline` (domain `threadline.viraat.dev`, functions pinned
to `sfo1` next to RDS) · AWS RDS `threadline-db` (Postgres 17, `us-west-1`,
TLS required; URL in Secrets Manager `threadline/database-url`). Apply
migrations with `pnpm db:migrate` before traffic. Reliable deploy path:
`vercel pull --environment=production` → `vercel build --prod` →
`vercel deploy --prebuilt --prod --archive=tgz`.

Env: `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL`,
`OWNER_EMAIL`, `DATABASE_URL`, `INTEGRATION_ENCRYPTION_KEY`(+`_VERSION`),
`CRON_SECRET`, `IMPORT_TOKEN`, `GMAIL_OAUTH_REDIRECT_URI`,
`OPENROUTER_API_KEY`; optional `GITHUB_TOKEN`, `APOLLO_API_KEY` (or paste them
in Settings), `AI_RESEARCH_MODEL`, `AI_DRAFT_MODEL`, `LINKED_API_BASE_URL`.

## Gotchas

- Drizzle renders column refs inside raw `sql` unqualified — correlated
  subqueries must spell out aliases (see `loadProspects`).
- Raw `sql` params skip column encoders: pass timestamps as ISO strings with
  `::timestamptz`, never `Date`.
- PGlite's socket server mishandles concurrent extended-protocol queries; use
  it for unit-speed tests only, real Postgres for anything concurrent.
- The Gmail callback path stays `/api/integrations/gmail/callback` because the
  Google OAuth client and `GMAIL_OAUTH_REDIRECT_URI` are registered with it.
- `pnpm find` is a pnpm builtin — the CLI is `pnpm scout`.
- lucide-react 1.x has no brand icons (no `Github`, `Linkedin`).
- Vercel Hobby crons run at most daily; Today's "Check replies" is the manual
  trigger.

## Conventions

- `exactOptionalPropertyTypes`: build optional fields with
  `...(value ? { key: value } : {})`.
- Validate every external/user input with Zod at the boundary; parse
  third-party arrays row by row so one bad row costs one row.
- Comments explain *why*. Colors are OKLCH tokens from `DESIGN.md`; status is
  never color-alone.

## Version control

Plain git on `main`. Do not push or deploy unless asked.
