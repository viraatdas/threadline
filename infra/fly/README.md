# Threadline private Codex worker

This Fly app has no public service definition. It runs one persistent Machine, polls Postgres serially, and keeps ChatGPT-managed Codex credentials in `/data/codex/auth.json` on the attached Fly Volume.

## Provision

1. Ensure local Codex uses file-backed ChatGPT authentication and that `~/.codex/auth.json` exists. Never add that file to this repository or a Docker build context.
2. Create the Fly app and its single volume:

   ```sh
   fly apps create threadline-codex-worker
   fly volumes create threadline_codex_data --app threadline-codex-worker --region sjc --size 1 --snapshot-retention 14
   fly secrets set --app threadline-codex-worker DATABASE_URL='postgresql://...'
   fly deploy --app threadline-codex-worker --config infra/fly/fly.toml
   fly scale count 1 --app threadline-codex-worker --yes
   ```

3. Upload the existing login cache directly to the mounted volume, lock its permissions, and restart the Machine so the unprivileged worker can refresh it in place:

   ```sh
   fly ssh console --app threadline-codex-worker --command 'install -d -m 700 -o node -g node /data/codex'
   fly ssh sftp put ~/.codex/auth.json /data/codex/auth.json --app threadline-codex-worker --mode 0600
   fly ssh console --app threadline-codex-worker --command 'chown node:node /data/codex/auth.json && chmod 600 /data/codex/auth.json'
   fly machine restart --app threadline-codex-worker
   ```

Do not configure `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN`. The child process receives neither variable and is forced to use file-backed ChatGPT login.

## Verify

```sh
fly scale show --app threadline-codex-worker
fly checks list --app threadline-codex-worker
fly ssh console --app threadline-codex-worker --command "node -e \"fetch('http://127.0.0.1:8080/readyz').then(async r=>{console.log(r.status, await r.text())})\""
```

`/livez` reports process liveness. `/readyz` additionally requires Postgres, the Codex executable, a writable `0600` auth file, and the output schema. The worker logs job IDs and lifecycle codes only; it never logs message bodies, model output, or credentials.
