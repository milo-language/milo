<!-- doc-meta
system: doc-standards
purpose: the greppable doc-meta header convention and the self-healing-docs rule every system doc follows
key-files: AGENTS.md, scripts/lint.ts
update-when: the header schema changes or the self-healing policy changes
last-verified: 2026-07-11
-->

# Documentation Standards

Docs in this repo are **self-healing**: whoever changes a system fixes its doc in the same change. A stale doc is a bug, filed against the persona that owns it ([docs/agent-review.md](docs/agent-review.md)).

## The `doc-meta` header

Every system doc (and the top-level `*.md` routers) starts with this exact block, as the first bytes of the file, so it renders as nothing but greps as everything:

```
<!-- doc-meta
system: <kebab-name>        # unique handle, grep by this
purpose: <one line>         # what this doc is for
key-files: <comma paths>    # the code this doc describes
update-when: <trigger>      # the event that makes this doc go stale
last-verified: <YYYY-MM-DD> # date a human/agent confirmed it matches reality
-->
```

Optional 6th/7th lines when useful: `owner-persona:` and `depends-on:`. Keep the whole block ≤7 content lines — it's a summary, not the doc.

### Why this shape
- **Greppable routing.** Find the doc for a system without reading any of them: `grep -rl "system: codegen" docs *.md`. `AGENTS.md` routes on this.
- **Staleness is explicit.** `update-when` tells the next agent exactly when to distrust the doc; `last-verified` says how old the trust is.
- HTML comment → invisible in rendered Markdown, so it costs the reader nothing.

## Rules
1. **New system → new doc with a meta block.** `scripts/lint.ts` warns on a tracked `docs/*.md` missing the block.
2. **Touched a system → reconcile its doc, bump `last-verified`.** Confirm the `key-files` still exist and say what the doc claims.
3. **First 7 lines carry the summary.** Someone grepping should learn what the doc covers without scrolling. Put the orienting paragraph right after the title.
4. **Don't duplicate.** A fact lives in one doc; others link to it. `CLAUDE.md` owns operational rules; `AGENTS.md` owns routing; system docs own their system.

## Retrofit
Existing docs predate this convention. When you next touch one, add its meta block. No big-bang migration — it heals as it's used.
