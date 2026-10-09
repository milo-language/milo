<!-- doc-meta
system: selfhost-endgame-decision
purpose: the precommitted rule that decides whether src-milo replaces src/ or freezes as proof, written before the census that feeds it
key-files: scripts/selfhost-rejects.ts, scripts/selfhost-stamp.ts, docs/self-hosting.md
update-when: the census runs and trips a threshold, or the endgame is decided
last-verified: 2026-08-08 (census + classification complete; VERDICT: proof-only — misscoped+uncalled = 14/99, rule 3 required 50%)
-->

# Self-host endgame: the decision rule

Written **before** the census ran, on purpose. A histogram read after the fact
gets narrated into whichever endgame you already wanted. This file is the
precommitment; the census either trips a threshold or it does not.

## The question

`src-milo/` is 38k LOC tracking a moving 41k LOC. Two endgames, and the middle
is the tar pit — transcribe forever, never delete `src/`, carry two compilers.

- **Replacement** — close the reject gap, HIR ratchet to 0, delete `src/`.
- **Proof-only** — the fixpoint already shipped the deliverable. Freeze
  `src-milo/` at the fixpoint, bank it, stop paying the sync tax.

## What gets measured

**255** negative tests — `tests/errors/` (236) plus `tests/runtime-errors/` (19).
118 behave correctly under milo-self, so **137** are outstanding. (The number
that circulated before this census was "236 tests, 118 outstanding"; both halves
were wrong, and they were wrong in opposite directions, which is why the ratio
looked plausible.)

That 137 is the pre-split number and **is not the denominator** — it mixes three
different backlogs. Split first:

| lane | meaning | counts toward the decision? |
|---|---|---|
| accepted silently | unsoundness — milo-self compiles a program it must reject | **yes, this is N** |
| wrong-message | the pass fired, the diagnostic is off | no — cheap, separate list |
| build-failed / over-reject | feature gap (`contractRequiresFail`, i32/i64) | no — not a checker gap at all |

**N = silent accepts only.** Every threshold below is a fraction of N, not of 137.

Measured 2026-08-08: **N = 99** (96 `accepted` + 3 `did-not-trap`), 37
`wrong-message`, 1 `build-failed`. Zero `unmeasured`. 96 + 3 + 37 + 1 = 137. ✓

Bucket key is the **`src/checker.ts` emission site** — the function in the
oracle that produces the diagnostic milo-self failed to produce. Not the error
string: the same message can come from different missing passes, and different
messages from one missing pass. That is the
`feedback_silent_success.md` class — a plausible histogram that prices nothing.

## The rule

Evaluated in order. First match wins.

0. **N ≤ 25** → **replacement**. The worry evaporates at that size regardless of
   shape; a quarter of checker work closes it.
1. **≤12 buckets cover ≥80% of N** → **replacement**. Concentrated cause means
   scheduled passes, not an open-ended transcription. Commit, schedule them,
   plan to delete `src/`.
2. **Top bucket <10 AND singletons ≥40% of N** → **proof-only**. A long
   singleton tail is N independent defects wearing a trenchcoat. Freeze at the
   fixpoint.
3. **Neither** → tiebreak on the census's third column, not on gut. If ≥50% of N
   sits in buckets marked `misscoped` or `uncalled` — wiring an existing pass,
   not writing a new one — → **replacement**. Otherwise → **proof-only**.

Rule 3 exists because rules 1 and 2 do not partition the space (13 buckets at
82%, or a top bucket of 15 with 55 singletons, match neither), and an unhandled
case is where the motivated reading gets back in.

**Outcome, 2026-08-08.** Rule 0 misses (N=99). Rule 1 misses — 51 buckets, top 12
cover 51/99 = **52%**, well short of 80%. Rule 2 misses — top bucket is 8 (<10),
but singletons are 31 buckets = **31%** of N, short of 40%. **Rule 3 decides.**
The shape landed in exactly the gap the first two arms left open, which is the
argument for having written a third arm before seeing data rather than after.

## Bucket shape (2026-08-08)

51 buckets over N=99. 83 of the 96 `accepted` emit from `src/checker.ts`; the
other 13 emit from `verifyCDecls` in `codegen.ts`/`main.ts` (8), `parser.ts` (3),
`resolver.ts` (1), `lower.ts` (1).

Bucket key is the emitting **function**, not `function:line` — `checkCValue`
emitting from four lines is one missing pass, not four. The exception is
`checkProgram` and its inline `<anonymous>` closures, where the checker top level
inlines genuinely distinct features, so there the line *is* the feature.

Largest coherent theme is not any single bucket: C-FFI attribute verification
spans `verifyCDecls` (8) + `checkCValue` (4) + `checkCLayout` (3) + `checkCSig`
(3) + two `cOpaque` fixtures = **20 of 99 in one feature area**. If rule 3 lands
on replacement, that cluster is the obvious first pass.

## Verdict (2026-08-08): proof-only

Rule 3's column, measured over all 51 buckets:

| state | fixtures | buckets |
|---|---|---|
| `uncalled` | **0** | 0 |
| `misscoped` | **14** | 8 |
| `absent` | **85** | 43 |
| `unknown` | 0 | 0 |

`misscoped + uncalled = 14/99 = 14%`. Rule 3 requires ≥50%. **Proof-only:
freeze `src-milo/` at the fixpoint, bank it, stop paying the sync tax.**

The verdict survives the most generous defensible re-reading. 21 of the 85
`absent` fixtures (9 buckets) are `absent [live-site]` — the enclosing pass
exists and runs, only the rule is unwritten, which is arguably as cheap as
`misscoped`. Counting those as cheap gives `35/99 = 35%`, still short of 50.
Strictly-absent, needing a genuinely new pass: **64 fixtures in 34 buckets.**

`project_srcmilo_varinfo_byvalue_hazard` predicted `misscoped` would dominate.
It did not. That prediction was the main reason to expect the cheap outcome, and
measuring it is what this census was for.

### The one fact that argues the other way, recorded rather than acted on

The 85-fixture `absent` mass is not 85 scattered defects. It concentrates in
whole features `src-milo` never implemented: C-decl verification (8), Send/Sync
(5), `@pure` (5), contracts (7 across buckets 13/16/17/19), extern/repr
validation (14). That is a different cost shape from a long tail of one-offs,
and it is the strongest available argument for the replacement endgame.

It is recorded here and deliberately NOT used to override the rule. The rule was
written before the data precisely so this kind of after-the-fact reading could
not quietly decide the outcome. Reopening the precommitment is legitimate, but
it has to be an explicit decision made in the open, not a reinterpretation.

### Known soft spot in the column

Bucket 10 (`checkCallSiteExclusivity`, 3 fixtures) is the one place static
reading and the manifest disagree: the pass exists, is called, and by code
reading *should* reject `viewAliasesContainerArg` / `mutViewAliasesContainerArg`
— yet the census measured both as accepted. The fact is settled (they are
accepted); only the cause is not. It cannot move the verdict: 3 fixtures against
a 36-fixture gap.

The classification column is code reading, NOT empirically verified — the
classification could not build `milo-self` at all, because of the guard bug
fixed in `91479476`. Re-running it now that guarded builds work would firm up
the column, but the verdict is not sensitive at this margin: `misscoped` would
have to be under-counted by 3.5x to reach 50.

## Attribution method

For whoever repeats this: patch the diagnostic emitter to
append a stack trace, then run the oracle on each fixture. Every diagnostic then
carries its own emitting frame. Grepping the message text back to a source line
cannot disambiguate two sites that emit the same string, and guessing from the
message is how this becomes the histogram it was designed not to be.

## Deliverable that the rule consumes

One table. Anything less does not decide anything.

| cause (`src/checker.ts` fn) | count | `src-milo/checker/*` file + fn that needs it | state |
|---|---|---|---|

`state ∈ {absent, uncalled, misscoped}`. Plus the singleton count — the number
rule 2 turns on. `project_srcmilo_varinfo_byvalue_hazard` predicts `misscoped`
dominates; if it does, that is the cheap outcome and rule 3 catches it.

## Not in scope for this decision

`DefaultValue`/`isMove` wiring through the real HIR path is execution — correct
under either endgame. It waits for the census only so it lands as one pass over
every site in `project_milo_self_drop_glue`'s checklist instead of a fourth
one-off patch. The `??` bug being the third instance of one cause is the whole
argument for waiting.
