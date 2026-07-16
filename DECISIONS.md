# Decisions

Shared, agent-authored log of cross-cutting decisions the fleet must honor. The conductor records plan/steer decisions here; workers record interface contracts + adjustments. Re-read before each significant step.

## Plan approved
- **What:** Approved a 10-task plan for: build me like a nice webapp and deploy it on threadline.viraat.dev (viraat.dev is on netlify) the idea of threadline is that it reads my emails and udnerstands if it's a customer outreach. it tries to track a few things about them, the company and their role. the llm should help out with this. additioanlly on the LLM, I should be able to see like who i plan to reach out to who i have reached out to and last time i reached out to and number of times, and if they have replied and if i haven't. Most of this should be autoamted. same thing for linkedin it should go through my linkedin messages and for twitter. you can see how i read twitter with this project /Users/viraat/code/churper but the project is called bird cli for linkedin maybe we can use this (https://github.com/Linked-API/linkedapi-mcp.git) I want to use my codex subscription as much as I can maybe we can fly.io sandbox use codex and use gpt 5.6 luna something like that. Tasks: Establish Threadline foundation; Build subscription Codex worker; Add Gmail ingestion; Add LinkedIn ingestion; Add X DM ingestion; Build intelligence overview; Build people and outreach workspace; Unify sync orchestration; Integrate and harden application; Deploy production Threadline.
- **Why:** user-approved plan; workers implement these nodes in isolated workspaces, honoring the dependency edges
- **By:** conductor · 1784161569264

## n0: Established the complete Threadline shared foundation: pinned Next.js 16/React
- **Did:** Established the complete Threadline shared foundation: pinned Next.js 16/React 19/pnpm dependency graph, product and design contracts, owner-only Auth.js shell, strict domain/Zod contracts, Drizzle Postgres schema with generated migration, encrypted credentials, read-only safety guards, idempotent repositories, and Vitest/Playwright tooling. Verified frozen-lockfile install, Drizzle migration consistency, design detector, production auth redirect/sign-in smoke test, lint, typecheck, tests, and build.
- **Interfaces:** package.json and pnpm-lock.yaml; ChannelConnector/AnalysisRunner/CredentialVault in lib/domain/contracts.ts; Zod ingestion and analysis schemas in lib/domain/schemas.ts; Drizzle tables/types in lib/db/schema.ts; createRepositories and per-area repositories in lib/db/repositories/**; auth/requireOwner in lib/auth/**; sealCredential/openCredential, read-only guards, and idempotency helpers in lib/security/**; AppShell and shell primitives in components/shell/**; initial migration migrations/0000_even_quicksilver.sql
- **Follow-ups:**
  - Implement channel connectors [out of lane] — Gmail, LinkedIn MCP, and X/Bird workers can now implement ChannelConnector in isolated channel directories and write through the shared repositories.
  - Provision production services and deploy [out of lane] — The deployment lane must configure Postgres, Google OAuth, encryption/auth secrets, apply migrations, and attach threadline.viraat.dev.
  - Implement subscription-backed analysis runner [out of lane] — The AnalysisRunner contract and codex-cli job fields exist, but Fly-hosted personal-login execution belongs to the analysis/runtime lane.
- **By:** n0 · 2026-07-16T00:48:30.843Z

