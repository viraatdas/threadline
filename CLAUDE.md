# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) first.** It is the single source of truth for
this repository: what the product is, the hard invariants, the layout, how a
prospect moves through the system, the commands, and the gotchas.

Quick orientation:

- Outbound is a private, owner-only outbound tool for selling Offstage:
  find → research → enroll → approve → reply.
- Nothing contacts a prospect without an owner click on Today
  (`sendMessage` in `lib/engine.ts` is the only send path). Keep it that way.
- Never log message content, model output, or credentials.
- Run `pnpm check` before any production deploy.

Other docs: `PRODUCT.md` (purpose and principles), `DESIGN.md` (visual system),
`README.md` (setup and deployment), `DECISIONS.md` (append-only history).
