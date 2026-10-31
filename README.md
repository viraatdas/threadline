# Outbound

Owner-only outbound for [Offstage](https://offstage.cloud): find teams that
need Macs for CI or agents, research them with AI, and run email, LinkedIn and
X sequences where every message waits for your approval.

See `AGENTS.md` for how it works and `PRODUCT.md` for why.

## Daily use

1. **Find** — search YC companies, scan GitHub for macOS CI workflows, pull
   Hacker News launches, paste a list, or run the CLI with your own logins:

   ```sh
   pnpm scout yc "ios app, mac ci"   # Bookface search via your `yc` CLI login
   pnpm scout github                 # uses `gh auth token`
   pnpm scout hn --dry               # print without importing
   pnpm scout x                      # X posts about Mac pain via `bird`
   ```

   The CLI posts to `$OUTBOUND_URL/api/import` with `IMPORT_TOKEN` (both in
   `.env.local`). Install the YC CLI with
   `curl -fsSL https://bookface.ycombinator.com/cli/install.sh | bash && yc login`.
   For X, install `bird` (`npm i -g @jtsang/bird@0.8.1`), stay logged in to
   x.com in your browser, and check `bird whoami`; `bird` reads those cookies
   locally and nothing about X is stored on the server.

2. **Prospects** — select companies → *Research with AI* → open the best ones →
   *Find people* → *Enroll*.
3. **Today** — edit and send each draft. X DMs open in X prefilled (you press
   send there). *Check replies* (also runs daily at 15:00 UTC) detects email
   and LinkedIn replies/bounces and drafts follow-ups that came due; mark X
   replies yourself on the prospect.

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
- **LinkedIn** — runs through our own [browser-use](https://github.com/browser-use/browser-use)
  worker (`browser/`, see below), whose browser goes out through your
  Tailscale exit node so LinkedIn sees your home connection. Set
  `BROWSER_WORKER_URL` and `BROWSER_WORKER_TOKEN`, sign in to linkedin.com,
  then paste a cookie export (Cookie-Editor → Export → JSON) into Settings, or
  run `pnpm linkedin-login` on your Mac (needs `OUTBOUND_URL` + `IMPORT_TOKEN`
  in `.env.local`). Do it again when Settings says LinkedIn is signed out.
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

### LinkedIn browser worker

`browser/` is a small Python service (browser-use + Chromium under Xvfb) on
Fly, app `threadline-browser`, with a 1 GB volume for the session. Its browser
only reaches the internet through Tailscale, via an exit node on your home
network (your laptop: Tailscale menu → Exit Node → Run as exit node, then
approve it in the admin console). While the exit node is offline, LinkedIn
actions wait in the queue.

Secrets: `BROWSER_WORKER_TOKEN` (the same value as the app's),
`OPENROUTER_API_KEY`, `TS_AUTHKEY` (a one-off, pre-approved Tailscale auth key;
only used on first boot, the node identity then lives on the volume) and
`TS_EXIT_NODE` (the exit node's Tailscale name or IP).

```sh
cd browser
fly secrets set BROWSER_WORKER_TOKEN=… OPENROUTER_API_KEY=… TS_AUTHKEY=… TS_EXIT_NODE=… -a threadline-browser
fly deploy
```

Offline tests: `pip install -r requirements.txt pytest httpx && pytest -q test_worker.py`.
