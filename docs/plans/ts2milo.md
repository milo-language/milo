<!-- doc-meta
system: ts2milo
purpose: plan and rules for generating the Milo frontend from src/*.ts with a thin transpiler, fixed before the stage 1 (lexer) result
key-files: scripts/ts2milo.ts, scripts/ts2milo/subset.ts, scripts/ts-portable.ts, scripts/ts2milo-lexer-diff.ts, scripts/ts2milo/runtime.milo
update-when: a stage result is measured, the portable subset changes, or the approach is dropped
last-verified: 2026-11-04 (stage 1 and the stage 3 checker-mutability probe measured; stage 2 not started)
status: spike, stage 1 passed, stage 3 probe go by the rule with the full AST not building
-->

# ts2milo: generate the Milo frontend from `src/*.ts`

## Why this again

`src-milo/` was frozen on 2026-08-09 because keeping a hand-written port in sync with a
moving `src/` never ends ([selfhost-endgame-decision.md](../selfhost-endgame-decision.md)).
Two things changed since: MLIR is now the only backend, so the port no longer has to carry
the LLVM-text codegen (`emit-mlir` is the lowering and `milo-opt` does the rest), and a
generated port has no sync tax: the Milo is output, rebuilt from the TypeScript, never edited.

## Approach

Keep the transpiler thin. When a construct is awkward to map, change the TypeScript into a
form that maps directly instead of teaching the tool a rule. `src/` keeps working and shipping
the whole time; each refactor is a TypeScript change that must not change behaviour.

- One rule list, `scripts/ts2milo/subset.ts`, defines the portable subset. The transpiler
  refuses anything outside it (file:line and construct name), and `scripts/ts-portable.ts`
  counts what is outside it, so the checker and the tool cannot disagree.
- `bun scripts/ts-portable.ts` prints one count per frontend file. `--check` fails when a file
  exceeds `scripts/ts-portable-baseline.json`, so counts only shrink. That table is the visible
  number for the whole project.
- Order: lexer, parser, resolver, checker, emit-mlir.
- Types come from the TypeScript checker, never from guessing at syntax.
- Overrides (`scripts/ts2milo/overrides/<file>.<fn>.milo`) replace one whole function by hand.
  Each is counted as not automatic and is a last resort that needs a written reason.
- Generated output is deterministic, carries a header, is never hand-edited, and is not
  committed yet. `--check` fails if a committed copy is stale.

### Gates

- Per refactor: the TypeScript behaviour is unchanged. For the lexer that is a token dump
  byte-identical before and after over the corpus; from the parser on, `emit-mlir` text
  byte-identical over the corpus before and after.
- Per stage, the rule below.
- End gate: the generated frontend's `emit-mlir` text is byte-identical to the TypeScript
  compiler's over the corpus.
- A refactor raises the percent automatic, because it removes the construct the tool would
  have needed a rule or an override for. The percent-automatic rule applies to the transpiler
  as it stands, not to a version that grew special cases to pass.

## Rule, fixed in advance

- Stage 1 lexer: gate 100% same, >=95% automatic. Else stop and write down why.
- Stage 2 parser: `emit-ast --spans` JSON byte-identical over the corpus, >=90% automatic.
  Else stop.
- Stage 3 checker: decide only after measuring stored object references (64 Map keyed by
  object, 213 Map/Set fields, 219 field assignments, 391 casts, 331 spreads across the
  frontend today). Not attempted in this task.

## What this would and would not give

Would give: a Milo frontend (lexer through emit-mlir) generated from the one source of truth,
with no hand-sync; a faster frontend if the compiled Milo beats Bun; one more large real
program to run the Milo compiler on; a standing number (violations per file) that says how
far the TypeScript is from portable.

Would not give: a compiler with no C++. `milo-opt` (`mlir/*.cpp`, the dialect, desugar and the
LLVM passes) stays C++, so the output is a Milo frontend that emits the milo dialect and hands
it to the same C++ backend. It also does not make the TypeScript compiler go away: `src/`
stays the source, and Bun stays a build dependency of the generated frontend.

## Stage 1 result (lexer), measured 2026-11-04

Gate `bun scripts/ts2milo-lexer-diff.ts`: **same 1952 / 1952** (tests/fixtures 1071,
tests/errors 761, std 120; tokens, line, col, raw, leading and trailing trivia, and the 19
files that fail to lex, with the same message). Neutering one emit rule (`x++` emitting
`+= 2`, which breaks every column) gives `same 0 / 1952`; restored, 1952 / 1952.

`functions: 27 total, 27 automatic, 0 overrides = 100.0% automatic` (rule: >=95%, met). No
overrides.

**The rule passes.** Two qualifications, stated plainly:

- The 100% is after the lexer was refactored to fit (below). The tool did not map the lexer
  as it was written: regex literals, `BigInt`, `Record`/`in`, `x++` inside an expression,
  numeric truthiness, string ordering, a non-null `!` and a push-then-mutate on a token all
  fall outside the subset. Each was rewritten in TypeScript, behaviour unchanged.
- The hand-written runtime (`scripts/ts2milo/runtime.milo`, about 230 lines) is not counted in
  the percentage. It holds the JS string model, `parseInt`, number formatting, and mirrors of
  `Diagnostic`, `Span` and `ParseError` from the untranspiled `diagnostics.ts` and `ast.ts`.

Speed, one process each, lexing the whole corpus (589,661 tokens), files already in memory:
TypeScript lexer on Bun 57 to 59 ms; compiled Milo lexer 350 ms at the default `-O2`, 192 ms
with `--release`. So the generated lexer is 3.3x to 6x slower than Bun's JIT, not faster.
The cause is the JS string model: every `s[i]` allocates a one-unit string, and `peek`
and `advance` return strings. A subset that lexes over char codes instead of one-char strings
would remove it; that is a refactor, not a tool change.

### Refactors made to `src/lexer.ts` (token dump byte-identical over the corpus, plus 54 edge inputs run old vs new)

- Regex tests (`/[a-zA-Z_]/`, `/^[0-9a-fA-F]+$/` and the identifier class) became
  `isDigitCode`, `isHexCode`, `isIdentStartCode`, `isHexString` over `charCodeAt`.
- `BigInt("0x" + raw).toString()` became `radixToDecimal`, a schoolbook multiply-add on decimal
  digits that stays exact past 2^53 and divides by 10 with subtraction.
- The three `Record<string, ...>` escape and single-char tables plus `esc in escapes` became
  `stringEscape`, `charEscape` and `singleKind` (if-chains returning `""`, `-1` and `Eof` for
  "not found").
- `this.source[this.pos++]` became two statements; truthiness (`if (arr.length)`) became
  `> 0`; `let value: number;` became `let value = 0`; string ordering (`ch >= "0"`) became
  `isDigitCode(this.codeAt(i))`; `.codePointAt(0)! & 0xff` became `.charCodeAt(0) & 0xff`.
- `tokenize` pushed a token and then attached trailing trivia to it. The port copies values
  on push, so the trivia is attached before the push. This is the stage 3 problem in
  miniature: object identity (a reference kept in an array and mutated afterwards) does not
  survive translation to value semantics, and the tool cannot detect it.
- `lexNumber`'s hex and binary branches merged into `lexRadix`.

### Per-file violations (`bun scripts/ts-portable.ts`)

| file | violations |
|---|---|
| src/tokens.ts | 0 |
| src/lexer.ts | 0 |
| src/ast.ts | 99 |
| src/types.ts | 183 |
| src/scaffold.ts | 200 |
| src/mlir-debug.ts | 21 |
| src/mlir-backend.ts | 180 |
| src/mlir-ctx.ts | 324 |
| src/mlir-glue.ts | 309 |
| src/mlir-llvm.ts | 224 |
| src/backend-program.ts | 286 |
| src/parser.ts | 548 |
| src/resolver.ts | 725 |
| src/emit-forms.ts | 985 |
| src/emit-mlir.ts | 3489 |
| src/checker-closure-env.ts | 137 |
| src/checker-derive.ts | 463 |
| src/checker-mutability.ts | 195 |
| src/checker-sql.ts | 337 |
| src/checker-program-passes.ts | 2282 |
| src/checker.ts | 8497 |
| total | 19484 |

Counts come from a deliberately narrow subset (no `for`, `switch`, `null`, spread, arrow
functions, `Map`, generics, `?.`, non-boolean conditions, discriminated unions), so they say
how much refactoring is ahead, not how hard each item is. Most are small and mechanical;
a few are not.

### What the parser would need (estimate)

`parser.ts` has 548 violations. The big ones: 123 object literals typed by a union (every AST
node is a member of a discriminated union such as `Expr`), 52 numeric or object truthiness
conditions, 44 `null`, 24 spreads, 13 `switch` clauses, 13 arrow functions, 12 `for...of`, 13
optional chains. The mechanical groups (conditions, `null`, spreads, loops, arrows) are
refactors of the parser by hand or with a codemod, perhaps 2 to 3 days. The hard one is the
AST: `ast.ts` is a union of about 60 tagged interfaces, which maps onto Milo enums with payloads
and needs a real design (one rule for the tag, constructors, narrowing in `if (e.kind === ...)`
chains), and every consumer of the AST (resolver, checker, emit) depends on it. That decision
is the real size of stage 2, and the 90% bar is not safe until `ast.ts` has a mapping. The
parser also keeps lookahead state and error recovery in classes, which fit the class rule that
already works. My estimate: the parser reaches the gate only after the AST tagged-union rule
exists; with it, the work is a few days of refactors; without it, stop at stage 2 and write
down why.

## Stage 3 probe: checker-mutability

Fixed before any work on it, unchanged by anything measured after. The slice is
`src/checker-mutability.ts`, chosen because it hits the hard class on purpose: AST as a tagged
union, a reflective walker, and facts keyed by object identity. Small, so a bad answer is cheap.

- GO needs all of: findings 100% identical to TS across the corpus; at least 90% of the
  slice's functions automatic, counting the `ast.ts` helpers it needs; the object-identity
  refactor expressible as a repeatable rule, not a one-off.
- NO-GO if any fails after a real effort. Then the project stops, useful cleanups stay, and
  src-milo stays frozen.
- Recorded, not a threshold: the `milo prove --rte` proved / unknown / failed counts on the
  generated slice. This measures the payoff, which is assurance on the compiler itself. A slice
  that is nearly all unknown is stated plainly as weakening the case.

### Stage 3 probe result (checker-mutability), measured 2026-11-04

**Verdict: GO by the rule above, as written.** The rule did not test the thing that decides the
checker, though: whether the full AST builds in Milo. It does not (below). Read the GO as "this
slice passes", not "the checker follows".

Gate `bun scripts/ts2milo-mut-diff.ts`: **same 2136 / 2136**, findings 45 on both sides (22
`unwritten-mut-param`, 23 `var-never-reassigned`), byte for byte, notes included. Corpus: 2177
programs (tests/fixtures, tests/errors, std, examples, tests/ts2milo-mut); 41 skipped, all "does not
parse or resolve" (tests/errors files that fail before the checker). The natural corpus has 2
findings (1 + 1); the other 43 are planted in `tests/ts2milo-mut/` (21 and 22), plus a file of
writes that must not fire. Neuter check: rewriting one rule in the generated pass (FieldAccess as a
read parent) gives `same 2 / 3` on the planted files; restored, 3 / 3.

- **Automatic: 40 / 40 functions, 0 overrides = 100%** (rule: >= 90%). `ast.ts` helpers the slice
  needs: 0 of 6. Nothing is hand-written in `runtime.milo` (230 lines before and after). Hand-written
  Milo: `mut-driver.milo`, 80 lines of file reading and printing.
- **Identity rule: met.** A fact keyed by node object becomes a fact keyed by the node's pre-order
  position, which the generated walker (`scripts/gen-ast-walk.ts`, `--check`) computes in TS and
  Milo alike. `src/checker-mutability-host.ts` (85 lines, hand-written) is the one place that still
  sees objects: it numbers each body with the same traversal and restates the checker's sets as id
  lists. The pass itself is plain data in, findings out. The precedent is `ExprNode.id` in
  src-milo/ast.milo. Caveat: this works for a pass that runs after the checker; the checker, which
  produces the facts, would need ids at node creation. Rollout count, from
  `bun scripts/ts2milo-identity-census.ts`: 140 collection declarations keyed by a node (checker.ts
  113, checker-program-passes.ts 22, emit-forms.ts 4, emit-mlir.ts 1), 367 `get/set/has/add/delete`
  sites on them (checker.ts 213, emit-forms.ts 69, checker-program-passes.ts 66), 49 assignments to
  AST fields (parser.ts 25, resolver.ts 12, checker.ts 7, checker-derive.ts 5).
- **`milo prove --rte`** on the generated files: proven 17, failed 12, unknown 90 (errors 5), of 119
  obligations. The slice proper (checker-mutability, mutability-scan, ast-walk): 17 / 12 / 71. 76%
  unknown weakens the payoff case. Unknowns are missing SMT rules, not bad code: `HashSet.contains`,
  `Vec` indexing, `Option` tags. The 12 failures are real, unconstrained preconditions
  (`self.next + 1` overflow, `kids[0]`, `f.params[i]`).
- **Speed**, whole corpus, pass only (JSON load and decode excluded): TS 3.4 s, Milo 5.5 s, 1.65x
  slower, over 24.3M nodes. The lexer's `s[i]` allocation does not recur: this pass never loops over
  characters. The string costs here are equality and hashing of UTF-16 names and `spanKey` building a
  string per call argument. Building the generated pass takes about 25 s (the lexer took seconds).
- **Tool cost.** `ts2milo.ts` 686 -> 920 lines, `subset.ts` +54, `ast-model.ts` 412 and
  `gen-ast-walk.ts` 266 new: about +970 lines, against a stage 1 tool that was 686. Not thin any more.
  New rules, each needed by this slice: tagged unions (enum, one struct-carrying variant per kind,
  common-field accessors), `if (x.kind === "K")` and `if (x !== undefined)` as `if let` narrowing
  (also through `&&`), borrowed parameters with `&mut` inferred to a fixpoint and `&mut x` at call
  sites, `.clone()` where a non-Copy value leaves a borrowed place (refused when the type has no
  Clone), `Heap<T>` fields and reads, `for (const x of array)`, `Map` and `Set.add`. The subset
  baseline total falls 19484 -> 15768; part of that is the widened subset, not refactors.
  `checker-mutability.ts` 195 -> 0, `ast.ts` 99 -> 32.

What the slice hit in the Milo compiler, none visible from the TypeScript:

1. **MLIR type text is structural and unrolled.** The full `ast.ts` types (58 types, 431 lines of
   Milo) exhaust the JS string limit in `moduleText` ("Out of memory") while building even the
   decoder; one operand line of the pass was 1.4 MB. The slice builds only because the generator
   carries just the AST fields the input files read (313 lines). A checker reads nearly every field.
   This is the finding that matters for stage 3.
2. A value of 128 bytes or more cannot be a `Heap` deref passed as an argument, so the generator
   boxes the largest optional or struct fields of any variant until the estimate is under 112 bytes
   (10 fields). `Vec<Heap<T>>` cannot be indexed and dereffed (`*v[i]` is "a temporary box"); arrays
   of cyclic types are walked with `for x in v`.
3. `@derive(Clone)` fails on mutually recursive types, so AST nodes have no `clone`.
4. `Option == Option` is refused, `unwrapOr` on `Option<string>` is refused, `Json.curHolds` is true
   for a JSON `null`.

**Estimate for the checker: unknown, leaning to months, not days.** The slice is 40 functions and
took most of the work in tool rules and in finding the compiler limits above; the checker is about
15,000 lines (checker.ts 8,500) with 140 node-keyed collections, and it needs the whole AST, which
today does not build. Before any checker work the AST representation needs a different shape: a
flat node table (ids and arrays, which is also what the data-oriented direction wants) or a Milo
backend change so that recursive struct types print by name. Either is a decision for the owner
before stage 2 (the parser), not a mechanical step. The gate builds
and deletes everything it generates (`bun scripts/ts2milo-mut-diff.ts`, about 25 minutes over the
whole corpus, mostly the Milo process over multi-MB dumps).
