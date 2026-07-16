# Decisions

- 2026-07-15: Analysis execution is modeled as a local/subscription-backed runner extension (default `codex-cli`), not a hosted LLM API dependency. This follows the owner's direction to use a personal subscription inside the Fly machine.
- 2026-07-15: X ingestion uses the currently installable `@jtsang/bird` package and is constrained to read-only operations by Threadline's integration capabilities.
- 2026-07-15: Auth uses Auth.js v5 with Google OAuth and an explicit `OWNER_EMAIL` allowlist; application sessions are JWT-backed so no extra auth tables are required.
