# Threadline Agent Notes

## Execute: Orphans

- Docker container `threadline-release-pg` on port 65432 — remove with `docker rm -f threadline-release-pg` when release verification no longer needs the disposable `threadline_test` database — created 2026-07-16 by the release execution task.

## Execute: Discoveries

- Destructive Postgres integration tests must use `postgres://threadline:threadline@127.0.0.1:65432/threadline_test` via `TEST_DATABASE_URL`; never point them at `DATABASE_URL` or production.
- postgres.js returns raw aggregate timestamps as strings unless the Drizzle SQL expression uses `.mapWith(<timestamp column>)`; contact merge metrics must preserve that decoder before updating timestamp columns.
- Person and company detail routes must use the scoped workspace loaders; the full workspace loader is reserved for list aggregation, and list/outreach serializers intentionally remove unused detail-only provenance, notes, and actor emails before crossing the server boundary.
- The repository targets Node 24.x. Local verification under Node 26 works but emits an expected `engines` warning.

## Execute: Dead-ends tried

- Fly.io worker app creation cannot proceed while the Fly organization has an overdue invoice; retries return the same billing restriction, so deployment requires the account balance to be cleared first.
- Vercel source deployments stalled at the deployment-creation request on 2026-07-16; `vercel pull --environment=production`, `vercel build --prod`, then `vercel deploy --prebuilt --prod --archive=tgz` produced the READY deployment.
- GitHub's Actions REST endpoint returned HTTP 503 on three consecutive post-push checks on 2026-07-16; stop polling and use the already-passed local `pnpm check` evidence until the API recovers.
