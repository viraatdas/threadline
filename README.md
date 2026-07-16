# Threadline

Threadline is a private, owner-only relationship-intelligence workspace for read-only Gmail, LinkedIn, and X history. It connects contacts, companies, conversations, touchpoints, replies, and follow-up plans while preserving source provenance and manual control.

## Safety boundary

The v1 integration contract is read-only. Threadline may ingest data, classify outreach, and store suggested drafts. It must never send, modify, delete, connect, post, or reply through Gmail, LinkedIn, or X.

## Stack

- Next.js 16 App Router, React 19, TypeScript, and Tailwind CSS v4
- Auth.js with Google OAuth restricted to `OWNER_EMAIL`
- Drizzle ORM with generic Postgres through `DATABASE_URL`
- Zod contracts, AES-256-GCM credential encryption, Vitest, and Playwright
- `googleapis`, MCP SDK support for Linked API, and verified `@jtsang/bird` support for read-only X ingestion

## Setup

1. Install Node 22+ and pnpm 10+.
2. Copy `.env.example` to `.env.local` and fill in the required values.
3. Run `pnpm install`.
4. Apply the schema with `pnpm db:migrate`.
5. Start the app with `pnpm dev`.

Generate an encryption key with:

```bash
openssl rand -base64 32
```

## Commands

- `pnpm lint` — lint the full repository.
- `pnpm typecheck` — run strict TypeScript checks.
- `pnpm test` — run every unit and integration Vitest suite.
- `pnpm build` — create a production build.
- `pnpm db:generate` — generate a migration from `lib/db/schema.ts`.
- `pnpm db:migrate` — apply checked-in migrations to `DATABASE_URL`.
- `pnpm e2e` — run the owner-authenticated Playwright release suite.

## Production deployment

Threadline deploys as three private pieces: Postgres, the Vercel Next.js app, and one serialized Fly worker. Never put credential values in source files, build arguments, deployment archives, or command output.

1. Provision Postgres and store its pooled `DATABASE_URL` in Vercel and Fly secret stores.
2. Apply checked-in migrations with `pnpm db:migrate` against the production database before serving traffic.
3. Configure Vercel secrets for `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL`, `OWNER_EMAIL`, `DATABASE_URL`, `INTEGRATION_ENCRYPTION_KEY`, `INTEGRATION_ENCRYPTION_KEY_VERSION`, `CRON_SECRET`, `GMAIL_OAUTH_REDIRECT_URI`, and optional `LINKED_API_BASE_URL`.
4. Register the exact Google callbacks for Auth.js and Gmail OAuth at `https://threadline.viraat.dev/api/auth/callback/google` and `https://threadline.viraat.dev/api/integrations/gmail/callback`.
5. Deploy the app to Vercel, attach `threadline.viraat.dev`, and point the Netlify `threadline` CNAME to `cname.vercel-dns.com`.
6. Follow `infra/fly/README.md` to deploy exactly one private worker with a persistent `/data` volume, `CODEX_HOME=/data/codex`, `CODEX_MODEL=gpt-5.6-luna`, and the owner's file-backed ChatGPT-managed Codex login. Do not configure an OpenAI API key.
7. Install Linked API and X credentials through their secure operator flows so encrypted values land in the production credential store without passing through source control.

Vercel cron calls `/api/cron/sync` with `CRON_SECRET`; owner-triggered sync uses `/api/sync`. Both paths use the same channel-isolated, lease-protected orchestration and never invoke a provider mutation.

## Release verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm e2e` before every production deployment. After deployment, verify owner sign-in, migrations, `/settings` integration health, manual sync, the Fly `/readyz` check, restart persistence of `/data/codex/auth.json`, and the absence of send/reply/post controls.

## Security notes

- Google authentication is restricted to the normalized `OWNER_EMAIL` allowlist.
- Gmail requests only `gmail.readonly`; LinkedIn and X connectors expose read-only capabilities and prohibit external mutations.
- Integration credentials use AES-256-GCM envelopes with versioned key metadata and remain server-side.
- OAuth state, cron authorization, bounded idempotency keys, database leases, and strict worker output schemas protect the main trust boundaries.
- Message content is treated as hostile input. The worker logs lifecycle identifiers only and never logs provider messages, model output, or credential values.

## Architecture

- `lib/domain` owns stable channel-agnostic contracts and validation.
- `lib/db` owns the Drizzle schema, connection, migrations, and repositories.
- `lib/auth` owns owner-only identity checks and Auth.js configuration.
- `lib/security` owns encrypted credential envelopes and safety invariants.
- Channel implementations should live in their own directories and depend on these interfaces rather than changing shared manifests or schema ad hoc.

Analysis jobs deliberately target a local, subscription-backed runner extension (`codex-cli`) rather than a hosted LLM API. No OpenAI API key is part of the foundation.
