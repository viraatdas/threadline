# X DM authentication

Threadline reads X direct messages with the same `auth_token` and `ct0` cookies used by Bird. The cookies are extracted on your local machine and immediately encrypted into the `integration_accounts` table. The helper never prints cookie values.

## Browser setup

Make sure the local environment contains `DATABASE_URL`, `INTEGRATION_ENCRYPTION_KEY`, and `INTEGRATION_ENCRYPTION_KEY_VERSION`, then run one of:

```bash
pnpm tsx scripts/x-auth/install.ts --cookie-source chrome
pnpm tsx scripts/x-auth/install.ts --cookie-source safari
pnpm tsx scripts/x-auth/install.ts --cookie-source firefox --firefox-profile default-release
```

Arc, Brave, and other Chromium browsers can supply an explicit profile directory or cookie database path; the server never assumes Arc exists:

```bash
pnpm tsx scripts/x-auth/install.ts \
  --cookie-source chrome \
  --chrome-profile-dir "$HOME/Library/Application Support/Arc/User Data/Default"
```

For a headless or manually provisioned machine, keep the values out of command history and provide them through the process environment:

```bash
AUTH_TOKEN="$(security find-generic-password -s threadline-x-auth-token -w)" \
CT0="$(security find-generic-password -s threadline-x-ct0 -w)" \
pnpm tsx scripts/x-auth/install.ts
```

After installation, `GET /api/integrations/x/health` checks the cookie-authenticated read session and `POST /api/integrations/x/sync` mirrors DMs. Neither endpoint performs X writes.

## Transport behavior

The pinned `@jtsang/bird@0.8.1` package does not currently expose `bird dms`. Threadline keeps Birdclaw's `bird dms --json` response contract isolated in the adapter so a compatible binary can be selected with `BIRD_DM_COMMAND`. When the pinned command reports that DMs are unsupported, Threadline falls back to X's read-only web DM endpoints without putting cookie values in command arguments or logs.

Private X endpoints can rotate. Their paths and feature parameters live only in `src/integrations/x/endpoints.ts`; rotation or malformed payloads mark the integration as needing attention and do not advance the encrypted sync cursor.
