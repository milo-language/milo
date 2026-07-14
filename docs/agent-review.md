<!-- doc-meta
system: agent-review
purpose: how cross-model / multi-persona review works, when to run it, and what each persona looks for
key-files: scripts/agent_review.sh, CONVENTIONS.md, AGENT_WORKFLOW.md
update-when: a persona is added/changed, a review CLI is wired in, or review gates move
last-verified: 2026-07-11
-->

# Agent Review

The reviewer should not be the author. A model reviewing its own diff rubber-stamps its own blind spots. This system routes each review to (a) a *different model* when one is available, and (b) a set of *personas* that each read the code through one lens.

Driver: `scripts/agent_review.sh <stage> [--persona <name>] [--diff <ref>]`. See [docs/scripts.md](docs/scripts.md).

## Gates — when to review
Run a review at each major point (from [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)):

| Stage | What's reviewed | Trigger |
|---|---|---|
| `research` | the approach/understanding, before you commit to a plan | non-trivial change |
| `plan` | the plan: right decomposition? missing cases? | multi-file / semantic change |
| `implementation` | the diff | before commit |
| `wrap-up` | the whole change + docs/tests updated | end of task / shift |

## Different model, not different prompt
`agent_review.sh` prefers an external agent CLI when present (`codex`, `cursor-agent`, `gemini`, `aider`) so the reviewer is a genuinely different model. **None are installed today**, so it falls back to `claude -p` running each persona as a fresh, adversarial subagent with no memory of writing the code. That still separates author-context from reviewer-context; install an external CLI to get true model diversity, and the script picks it up automatically (no edits).

## Personas
Each persona reads the diff for one thing and **owns the docs for its domain** (keeps them current — a stale doc in your domain is your finding to file):

| Persona | Looks for | Owns |
|---|---|---|
| **correctness** | logic bugs, missed cases, checker-vs-codegen gaps, UB in `unsafe` | `docs/design.md`, `docs/language-reference.md` |
| **security / safety** | memory-safety holes, guard bypasses, injection, unsafe FFI | `docs/safety-roadmap.md`, guard rules in `CLAUDE.md` |
| **performance** | needless allocation/copies, algorithmic regressions, hot-path cost | `benchmarks/` |
| **maintainability** | naming, dead code, duplication, over-abstraction, clarity | `CONVENTIONS.md`, `docs/scripts.md` |
| **ai-smells** | hallucinated APIs, plausible-but-wrong code, copy-paste, tests that assert nothing, comments that lie | — |
| **testing** | coverage gaps, false-confidence tests, missing error/edge fixtures | `docs/testing.md` |
| **domain** | compiler/PL-specific: type-system soundness, ABI correctness, LLVM IR validity | — |

Pick personas by what the change touches; run all for a big change. `--persona all` runs the set.

## How to act on findings
- Fix confirmed issues before commit. For a disputed finding, have the author-context and reviewer-context argue it out in the worksheet, then decide.
- A finding that keeps recurring across reviews belongs in `scripts/lint.ts` (mechanical) or `CONVENTIONS.md` (judgment) — stop paying for it every time.
- Log noisy/low-value personas or false positives in [feedback/README.md](feedback/README.md) so the review set improves.
