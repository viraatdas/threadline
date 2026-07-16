# Decisions

Shared, agent-authored log of cross-cutting decisions the fleet must honor. The conductor records plan/steer decisions here; workers record interface contracts + adjustments. Re-read before each significant step.

## Plan approved
- **What:** Approved a 10-task plan for: build me like a nice webapp and deploy it on threadline.viraat.dev (viraat.dev is on netlify) the idea of threadline is that it reads my emails and udnerstands if it's a customer outreach. it tries to track a few things about them, the company and their role. the llm should help out with this. additioanlly on the LLM, I should be able to see like who i plan to reach out to who i have reached out to and last time i reached out to and number of times, and if they have replied and if i haven't. Most of this should be autoamted. same thing for linkedin it should go through my linkedin messages and for twitter. you can see how i read twitter with this project /Users/viraat/code/churper but the project is called bird cli for linkedin maybe we can use this (https://github.com/Linked-API/linkedapi-mcp.git) I want to use my codex subscription as much as I can maybe we can fly.io sandbox use codex and use gpt 5.6 luna something like that. Tasks: Establish Threadline foundation; Build subscription Codex worker; Add Gmail ingestion; Add LinkedIn ingestion; Add X DM ingestion; Build intelligence overview; Build people and outreach workspace; Unify sync orchestration; Integrate and harden application; Deploy production Threadline.
- **Why:** user-approved plan; workers implement these nodes in isolated workspaces, honoring the dependency edges
- **By:** conductor · 1784161569264

## Foundation architecture
- 2026-07-15: Analysis execution is modeled as a local/subscription-backed runner extension (default `codex-cli`), not a hosted LLM API dependency. This follows the owner's direction to use a personal subscription inside the Fly machine.
- 2026-07-15: X ingestion uses the currently installable `@jtsang/bird` package and is constrained to read-only operations by Threadline's integration capabilities.
- 2026-07-15: Auth uses Auth.js v5 with Google OAuth and an explicit `OWNER_EMAIL` allowlist; application sessions are JWT-backed so no extra auth tables are required.

## n0: Established the complete Threadline shared foundation: pinned Next.js 16/React
- **Did:** Established the complete Threadline shared foundation: pinned Next.js 16/React 19/pnpm dependency graph, product and design contracts, owner-only Auth.js shell, strict domain/Zod contracts, Drizzle Postgres schema with generated migration, encrypted credentials, read-only safety guards, idempotent repositories, and Vitest/Playwright tooling. Verified frozen-lockfile install, Drizzle migration consistency, design detector, production auth redirect/sign-in smoke test, lint, typecheck, tests, and build.
- **Interfaces:** package.json and pnpm-lock.yaml; ChannelConnector/AnalysisRunner/CredentialVault in lib/domain/contracts.ts; Zod ingestion and analysis schemas in lib/domain/schemas.ts; Drizzle tables/types in lib/db/schema.ts; createRepositories and per-area repositories in lib/db/repositories/**; auth/requireOwner in lib/auth/**; sealCredential/openCredential, read-only guards, and idempotency helpers in lib/security/**; AppShell and shell primitives in components/shell/**; initial migration migrations/0000_even_quicksilver.sql
- **Follow-ups:**
  - Implement channel connectors [out of lane] — Gmail, LinkedIn MCP, and X/Bird workers can now implement ChannelConnector in isolated channel directories and write through the shared repositories.
  - Provision production services and deploy [out of lane] — The deployment lane must configure Postgres, Google OAuth, encryption/auth secrets, apply migrations, and attach threadline.viraat.dev.
  - Implement subscription-backed analysis runner [out of lane] — The AnalysisRunner contract and codex-cli job fields exist, but Fly-hosted personal-login execution belongs to the analysis/runtime lane.
- **By:** n0 · 2026-07-16T00:48:30.843Z
## n0: Resolved the jj merge conflicts in .gitignore and DECISIONS.md,
- **Did:** Resolved the jj merge conflicts in .gitignore and DECISIONS.md, preserving both Rudder orchestration context and the complete Threadline foundation decisions. Added Rudder-generated directory exclusions to ESLint and TypeScript so validation remains stable in the main integrated workspace. Fresh frozen-lockfile install plus lint, typecheck, tests, and build all pass.
- **Interfaces:** .gitignore Rudder/tooling exclusions; DECISIONS.md combined plan, architecture, and n0 foundation report; eslint.config.mjs and tsconfig.json exclude .rudder and .rudder-worktrees generated artifacts
- **By:** n0 · 2026-07-16T00:57:51.425Z

## n5: Built the production relationship-intelligence overview as a typed, read-only
- **Did:** Built the production relationship-intelligence overview as a typed, read-only server-rendered dashboard. It prioritizes next actions, then shows planned/due/contacted/replied/unreplied/reply-rate metrics, channel mix, stale relationships, recent conversations, connector sync health, analysis queue health, and source-grounded model rationales. Added safe copy/open-only follow-up affordances plus loading, empty, error, and query-driven demo states. Verified lint, typecheck, repository tests, 7 dashboard accessibility/component tests, production build, and authenticated Chromium smoke tests at 1440x1000 and 390x844 with keyboard copy and overflow assertions.
- **Interfaces:** Root overview route is app/(dashboard)/page.tsx (replacing the foundation app/page.tsx placeholder); typed DashboardSnapshot and related view contracts in components/dashboard/types.ts; DashboardOverview/DashboardEmpty/DashboardError/DashboardLoading and createDashboardDemoData exported from components/dashboard/index.ts; demo mode at /?demo=1; read-only links assume /people, /people/:contactId, and /settings; no server actions or external mutations.
- **Follow-ups:**
  - Honor dashboard people-link routes [out of lane] — The overview opens relationship records through /people and /people/:contactId; the people workspace lane should preserve those paths or add compatible redirects.
  - Keep browser smoke in integrated CI [out of lane] — tests/dashboard/dashboard.browser.ts validates authenticated desktop/mobile rendering, keyboard copy behavior, and horizontal overflow against a running production server on port 3105.
- **By:** n5 · 2026-07-16T01:16:40.853Z


## n3: LinkedIn read-only safety boundary
- 2026-07-15: Production LinkedIn sync uses Linked API inbox/conversation reads and sync-monitoring workflows only. Linked API `fetchPerson`/`fetchCompany` page workflows remain available for mocked normalization coverage but are disabled by default in the production connector because opening person pages can create LinkedIn profile-view side effects, which the task explicitly prohibits.
- 2026-07-15: Queued Linked API workflow IDs and operation names are persisted in encrypted sync-cursor records so retries poll the exact existing workflow instead of starting duplicate cloud-browser work.
## n6: Built the typed people, person detail, company detail, and
- **Did:** Built the typed people, person detail, company detail, and outreach workspaces with URL-backed filters, responsive table/card views, cross-channel chronology and reply metrics, evidence/provenance distinctions, manual add/edit/merge/correction/planning flows, optimistic undo, draft status and copy-only controls, queue transitions, audit history, loading/error states, and explicit no-send guarantees. Added seven focused interaction tests; typecheck, scoped and repository lint, focused tests, global tests, design detector, and production build pass.
- **Interfaces:** Routes: /people, /people/[personId], /people/companies/[companyId], /outreach. Typed UI contracts: components/people/types.ts. Typed snapshot/query adapter: components/people/sample-data.ts. Queue classification: outreachQueueGroup/groupOutreachPlans in components/outreach/queue-utils.ts. Client workspaces: PeopleWorkspace, PersonDetail, CompanyDetail, OutreachWorkspace. Focused test config and suites: tests/people-outreach/**.
- **Follow-ups:**
  - Wire global navigation to delivered routes [out of lane] — The shared shell currently links Companies to /companies and Plans to /plans; the integration lane should point those entries to /people?view=companies and /outreach (or add global aliases).
  - Bind UI adapters to live repositories [out of lane] — The feature lane uses a fully typed serializable snapshot and reversible client mutations because shared live query/update/merge endpoints are not yet exposed; integration should replace the adapter with repository-backed loaders and mutations while preserving these component contracts.
- **By:** n6 · 2026-07-16T01:21:02.200Z

## n3: Implemented a server-side, read-only Linked API integration with encrypted
- **Did:** Implemented a server-side, read-only Linked API integration with encrypted credentials, safe connection/status endpoints, inbox and conversation polling, resumable exact-ID workflow coordination, cursor pagination, normalization into shared conversation/contact models, idempotent persistence and analysis enqueueing, rate-limit/backoff handling, and mocked server verification. Production profile-opening enrichment is disabled to honor the no-profile-view boundary while normalization support remains covered by mocks.
- **Interfaces:** src/integrations/linkedin/index.ts exports LinkedApiClient, LinkedinConnector, LinkedinWorkflowCoordinator, DatabaseWorkflowRegistry, DatabaseLinkedinIngestionSink, syncLinkedin, normalization/cursor/account helpers, and risk/capability types; owner-only APIs at /api/integrations/linkedin/connection, /api/integrations/linkedin/status, and /api/integrations/linkedin/sync; tests use tests/linkedin/vitest.config.ts
- **Follow-ups:**
  - Choose non-view professional enrichment source [out of lane] — Linked API fetchPerson opens person pages and is disabled in production to prevent LinkedIn profile-view side effects; another read source is needed for automatic role/company refreshes.
  - Include LinkedIn mock suite in integrated CI [out of lane] — The root Vitest include currently targets tests/unit, so run pnpm exec vitest run --config tests/linkedin/vitest.config.ts or add it to the integration lane later.
- **By:** n3 · 2026-07-16T01:23:01.564Z

## n2: Implemented a complete read-only Gmail integration with owner-bound offline
- **Did:** Implemented a complete read-only Gmail integration with owner-bound offline OAuth, encrypted tokens and history cursors, initial backfill plus incremental History API synchronization, stale-cursor recovery, RFC/MIME normalization, alias-aware inbound/outbound and reply tracking, idempotent shared-model persistence, and one classify_outreach analysis job per changed conversation. Added owner-only connect, callback, disconnect, status, and manual sync routes plus recorded synthetic fixture coverage. Verified focused Gmail tests, formatting, scoped lint/typecheck, repository lint/typecheck/tests, mutation and secret audits, and production build.
- **Interfaces:** src/integrations/gmail/index.ts exports GmailConnector, GoogleGmailApi, PostgresGmailStore, runGmailSync, syncConnectedGmailAccount, OAuth helpers, types, normalization, retry, and constants; owner-only routes at /api/integrations/gmail/connect, /callback, /disconnect, /status, and /sync; analysis queue contract inserts jobType classify_outreach for entityType conversation with deterministic inputHash and normalized Gmail payload; tests use tests/gmail/vitest.config.ts and tests/gmail/tsconfig.json.
- **Follow-ups:**
  - Schedule incremental Gmail synchronization [out of lane] — The orchestration lane should call syncConnectedGmailAccount on a cadence so History API changes mirror continuously beyond manual syncs and the initial callback backfill.
  - Provision production Google OAuth settings [out of lane] — Deployment must configure AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, GMAIL_OAUTH_REDIRECT_URI, OWNER_EMAIL, encryption keys, and register the exact callback URI.
  - Include Gmail fixtures in integrated CI [out of lane] — The root Vitest config only includes tests/unit, so the integration lane should add the focused tests/gmail/vitest.config.ts command to CI without changing this worker-owned scope.
- **By:** n2 · 2026-07-16T01:26:44.115Z

## n4: Implemented read-only X DM ingestion with a Bird-compatible CLI
- **Did:** Implemented read-only X DM ingestion with a Bird-compatible CLI seam and cookie-authenticated X web fallback. Added normalization for direct/group conversations, handles, directions, unavailable messages, deterministic reply state, encrypted resumable cursors, atomic Postgres persistence, participant/contact/touchpoint updates, content-addressed analysis enqueueing, owner-only health/sync APIs, and a local browser-cookie installer that never prints token values. Verified formatting, lint, typecheck, 9 shared tests, 7 focused X fixture tests, helper startup, and the Next.js production build.
- **Interfaces:** src/integrations/x exports XDirectMessageConnector, BirdCliDmTransport, XWebDmTransport, BirdWithWebFallbackTransport, DatabaseXSyncStore, syncXDirectMessages, runDatabaseXSync, checkDatabaseXIntegrationHealth, installXIntegrationAccount, X_DM_RESOURCE, XIntegrationError, and isolated endpoint config; app/api/integrations/x/health GET and app/api/integrations/x/sync POST; scripts/x-auth/install.ts and scripts/x-auth/README.md; tests/x fixture suite and dedicated Vitest config
- **Follow-ups:**
  - Schedule X DM sync [out of lane] — The unified sync orchestration lane should invoke runDatabaseXSync for connected X accounts and surface partial/attention-required runs.
  - Install production X cookies [out of lane] — Deployment must provision DATABASE_URL and encryption variables, then run the local x-auth installer against the production database before X sync can succeed.
- **By:** n4 · 2026-07-16T01:27:09.464Z

## n1: Built the private subscription-backed Codex classification worker with atomic
- **Did:** Built the private subscription-backed Codex classification worker with atomic SKIP LOCKED job claims, strict normalized output validation, hostile-content prompt boundaries, bounded inputs, retries/dead-letter handling, transactional normalized updates with manual-override preservation, ChatGPT-only file auth health checks, graceful shutdown, Fly volume/runtime configuration, and a credential-free Docker image. Verified unit/security fixtures, real-Postgres exact-once and rollback integration tests, lint, typecheck, foundation tests, Next build, Fly config validation, Docker build, non-root/auth-permission smoke tests, liveness/readiness behavior, and clean SIGTERM exit.
- **Interfaces:** worker/codex/index.ts exports CodexCliAnalysisRunner, CodexWorker, PostgresAnalysisJobStore, FakeCodexExecutable, strict classification schemas, config, and store types; worker/codex/classification-output.schema.json is the Codex --output-schema contract; Dockerfile.worker and infra/fly/fly.toml define the one-machine private persistent worker; infra/fly/README.md documents secure auth.json provisioning.
- **Follow-ups:**
  - Provision and deploy the Fly worker [out of lane] — The deployment lane must create the Fly app/volume, set DATABASE_URL, upload the owner’s existing ChatGPT Codex auth.json directly to the volume, scale to exactly one Machine, and confirm /readyz with real credentials.
- **By:** n1 · 2026-07-16T01:31:03.381Z

## followup: Completed the Gmail recovery implementation within n2-owned paths: preserved
- **Did:** Completed the Gmail recovery implementation within n2-owned paths: preserved the existing read-only OAuth/backfill/history ingestion, added delivery-header alias recognition for inbound mail, and made persisted touchpoints update reply state when later Gmail replies arrive. Synthetic Gmail fixtures, scoped formatting/lint/typecheck, shared typecheck, production build, and a Gmail mutation-method audit all pass.
- **Interfaces:** src/integrations/gmail/normalize.ts owner alias discovery; src/integrations/gmail/store.ts idempotent touchpoint reply-state updates; tests/gmail/normalization.test.ts synthetic inbound-alias fixture coverage; existing owner-only Gmail connect/callback/disconnect/status/sync APIs remain unchanged
- **By:** followup · 2026-07-16T07:07:47.303Z

## worker: Implemented unified read-only Gmail, LinkedIn, and X synchronization with
- **Did:** Implemented unified read-only Gmail, LinkedIn, and X synchronization with owner-authenticated manual sync, secret-authenticated scheduled sync, per-account enablement, bounded concurrency, retry/timeout policy, durable Postgres run leases, cursor checkpointing, channel-isolated outcomes, transactional exact-email identity reconciliation, relationship metric recomputation, and semantic exactly-once analysis coverage. Added focused sync tests and verified all requested repository checks.
- **Interfaces:** src/sync exports UnifiedSyncOrchestrator, PostgresSyncCoordinatorStore, PostgresSyncReconciler, runUnifiedSync, channel executors, retry/checkpoint/auth helpers, and sync request/result types; app/api/sync POST is the owner-authenticated manual entrypoint; app/api/cron/sync GET/POST is the CRON_SECRET-authenticated scheduled entrypoint; tests/sync/vitest.config.ts runs the focused sync suite.
- **Follow-ups:**
  - Provision scheduled sync secret and cadence [out of lane] — Production must set CRON_SECRET and configure a scheduler to call /api/cron/sync.
  - Run live credential smoke sync [out of lane] — Gmail OAuth, Linked API credentials, X cookies, Postgres, encryption settings, and the Codex worker must be provisioned before a real production cross-channel sync can be exercised.
- **By:** worker · 2026-07-16T08:43:21.443Z

