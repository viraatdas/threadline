# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) first.** It is the single source of truth for
this repository: what Threadline is, the hard invariants, the layout, the data
model, how sync/backfill/enrichment work, the commands, and the gotchas.

Everything an agent needs lives there — do not duplicate it here.

Quick orientation:

- Threadline is a private, owner-only, **read-only** relationship-intelligence
  workspace over Gmail / LinkedIn / X.
- Never add code that sends, replies, posts, modifies, deletes, or connects
  through a provider. See "Hard invariants" in `AGENTS.md`.
- Never log message content, model output, or credentials.
- Run `pnpm check` before any production deploy.

Other docs: `PRODUCT.md` (purpose and principles), `DESIGN.md` (visual system),
`README.md` (setup and deployment prose), `DECISIONS.md` (append-only history).
