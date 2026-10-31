# Outbound

Owner-only outbound for [Offstage](https://offstage.cloud): find teams that
need Macs for CI or agents, research them with AI, and run email + LinkedIn
sequences where every message waits for your approval.

See `AGENTS.md` for how it works and `PRODUCT.md` for why.

## Daily use

1. **Find** — search YC companies, scan GitHub for macOS CI workflows, pull
   Hacker News launches, paste a list, or run the CLI with your own logins:

   ```sh
   pnpm scout yc "ios app, mac ci"   # Bookface search via your `yc` CLI login
   pnpm scout github                 # uses `gh auth token`
   pnpm scout hn --dry               # print without importing
   ```

   The CLI posts to `$OUTBOUND_URL/api/import` with `IMPORT_TOKEN` (both in
   `.env.local`). Install the YC CLI with
   `curl -fsSL https://bookface.ycombinator.com/cli/install.sh | bash && yc login`.

2. **Prospects** — select companies → *Research with AI* → open the best ones →
   *Find people* → *Enroll*.
3. **Today** — edit and send each draft. *Check replies* (also runs daily at
   15:00 UTC) detects replies/bounces and drafts follow-ups that came due.

## Setup

```sh
pnpm install
cp .env.example .env.local   # fill in
pnpm db:migrate
pnpm dev
```

Connect accounts in **Settings**:

- **Gmail** — OAuth with `gmail.send` + `gmail.readonly`. The Google OAuth
  client must allow `…/api/integrations/gmail/callback`.
- **LinkedIn** — a [Linked API](https://linkedapi.io) token pair (runs your own
  account in a cloud browser; unofficial).
- **GitHub token** — fine-grained, no extra permissions; enables workflow search.
- **Apollo key** — optional; adds people search by domain and verified emails.

Generate secrets with `openssl rand -base64 32` (`AUTH_SECRET`,
`INTEGRATION_ENCRYPTION_KEY`, `CRON_SECRET`, `IMPORT_TOKEN`).

## Tests

`pnpm test` runs everything against in-memory PGlite. Set
`TEST_DATABASE_URL` to a disposable Postgres database whose name contains
"test" to run the integration suite against real Postgres (it is wiped).

## Deploy

```sh
pnpm check
DATABASE_URL=$(aws secretsmanager get-secret-value --secret-id threadline/database-url \
  --query SecretString --output text) pnpm db:migrate
vercel pull --environment=production --yes
vercel build --prod
vercel deploy --prebuilt --prod --archive=tgz
```
