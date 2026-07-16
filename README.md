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
- `pnpm test` — run unit and component tests.
- `pnpm build` — create a production build.
- `pnpm db:generate` — generate a migration from `lib/db/schema.ts`.
- `pnpm db:migrate` — apply checked-in migrations to `DATABASE_URL`.
- `pnpm test:e2e` — run Playwright against the local app.

## Architecture

- `lib/domain` owns stable channel-agnostic contracts and validation.
- `lib/db` owns the Drizzle schema, connection, migrations, and repositories.
- `lib/auth` owns owner-only identity checks and Auth.js configuration.
- `lib/security` owns encrypted credential envelopes and safety invariants.
- Channel implementations should live in their own directories and depend on these interfaces rather than changing shared manifests or schema ad hoc.

Analysis jobs deliberately target a local, subscription-backed runner extension (`codex-cli`) rather than a hosted LLM API. No OpenAI API key is part of the foundation.
