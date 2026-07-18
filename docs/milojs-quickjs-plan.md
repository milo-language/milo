# milojs QuickJS-parity plan

Working plan for driving `scripts/quickjs-sweep.ts` toward 100%. Written for agents
picking up individual lanes; each lane is independent and lists exact anchors.
Current: **55/149 cases (36.9%)**. Delete lanes here as they land.

## Ground rules (read first, all of them)

1. **Coordinate on dirty files.** Another agent may hold `ast.milo` / `eval.milo` /
   `modules.milo` uncommitted. `git status` before touching `examples/apps/milojs/`;
   if your target file is dirty with work that isn't yours, take a different lane.
   Commit atomically with explicit file lists — never `git add -A` (a sweep once
   swallowed a colleague's uncommitted work).
2. **Build the engine at default -O2, never `--fast`.** `--fast` frames are large
   enough that the native stack dies ~60 JS frames deep — *before* the JS-level
   `callDepth >= 400` guard (eval.milo:2646) fires — so recursion tests segfault
   at -O0/--fast and pass at -O2. This cost a debugging session; don't repeat it.
3. **Measure loop:**
   ```bash
   bun run src/main.ts build examples/apps/milojs/milojs-engine.milo -o /tmp/milojs-engine
   MILOJS_ENGINE=/tmp/milojs-engine bun scripts/quickjs-sweep.ts        # summary
   MILOJS_ENGINE=/tmp/milojs-engine bun scripts/quickjs-sweep.ts -v    # per-case list
   MILOJS_ENGINE=/tmp/milojs-engine bun scripts/quickjs-sweep.ts -f loop  # one file
   ```
   Suite lives at `~/git/quickjs/tests/`. The sweep splits each file at its trailing
   `test_x();` call list and runs the body once per call, so one parse error in a
   shared helper no longer hides a whole file — but it also means a parse fix can
   flip 30 cases at once.
4. **Regression gates before commit:** `examples/apps/milojs/tests/run.sh` (every
   `tests/*.js` must stay byte-identical to `bun`), then `bun test` before push.
5. Tests importing `qjs:std` / `qjs:os` / workers / bjson are host-facility tests,
   not conformance gaps — they stay in `SKIP_FILES` in the sweep.

## Lane 1 — ESM import/export: 44 cases, the whale

`import` is not a token today; it evaluates as an undefined identifier →
`ReferenceError: import is not defined` × 44. Strategy: **desugar ESM onto the
existing CJS machinery at parse time** — no new module system.

Forms actually used by the suite (frequency-ordered — implement all):

```js
import { assert } from "./assert.js";            // named, ± trailing semi/spaces
import { assert, assertThrows } from "./x.js";
import * as std from "qjs:std";                  // namespace (resolves to missing → throw)
import { b as c } from "./x.js";                 // rename
import { "string-name" as s } from "./x.js";     // string-named import (T_STR inside braces)
import "./x.js";                                 // bare, side-effect only
export function f() {}                           // decl exports
export class C {}
export const x = 1;                              // also let/var, also multi-declarator
export const { a, b } = obj;                     // destructured export (destructured-export.js)
export { a, b as c };                            // list export
export { "string-export" as x };                 // string-named export
export default expr;
import("./x.js")                                 // dynamic — see note at end
```

### Step A — lexer (`examples/apps/milojs/lexer.milo`)
Add `T_IMPORT` / `T_EXPORT` token constants (grep `T_ASYNC =` for the constant
block) and entries in `keywordKind` (lexer.milo:149). `from` / `as` stay contextual
identifiers — match on `.text == "from"` in the parser; do NOT make them keywords
(they appear as plain identifiers all over real code).

### Step B — parser desugar (`parser.milo`, statement dispatch near :1277)
Emit plain CJS statements into the arena — no new AST nodes needed:

- `import {a, b as c, "s" as d} from "spec"` →
  `const __esm_N = require("spec"); const a = __esm_N.a; const c = __esm_N.b; const d = __esm_N["s"]`
  (`__esm_N` = a fresh synthetic name per import; build the require call as
  Expr.Call with a string-literal arg, the reads as member/index expressions,
  wrapped in the existing MultiDecl machinery.)
- `import * as ns from "spec"` → `const ns = require("spec")`
- `import "spec"` → expression-statement `require("spec")`
- `export function f(){}` / `export class C {}` → the decl itself, then append
  statement `exports.f = f`. Hoisting is unaffected (hoistBlock sees the FuncDecl;
  the exports-assignment runs in source order — fine, CJS semantics).
- `export const/let/var …` → the decl, then one `exports.x = x` per declared name.
  For the destructured form, enumerate the binding names from the pattern the
  same way the declarator code does.
- `export { a, b as c }` → `exports.a = a; exports.c = b`
- `export default expr` → `exports.default = expr`
- Suite does NOT use `export … from "x"` re-export chains — skip them, leave a
  clear parse error if hit.

Live-binding semantics are deliberately NOT implemented (exports are snapshots at
the assignment). The suite tolerates this everywhere except exotic cyclic cases
already in SKIP_FILES; `bug567.js` imports itself — the existing partial-exports
cycle path (runModule, eval.milo:1657) covers it.

### Step C — discovery (`modules.milo`)
`scanRequires` (modules.milo:366) finds `require("lit")` in the token stream so
`preloadGraph` (modules.milo:393) can parse the whole graph before execution
(mid-eval parsing is impossible — the evaluator holds an immutable `&Prog`).
Extend the same scan to collect:
- `T_IMPORT … <ident "from"> T_STR` (scan forward bounded, e.g. ≤40 tokens)
- `T_IMPORT T_STR` (bare)
- `T_IMPORT T_LPAREN T_STR` (dynamic)
- `T_EXPORT … <ident "from"> T_STR` (harmless to support in the scanner even
  though the parser rejects re-exports)

### Step D — engine entry must preload (`milojs-engine.milo` + `driver.milo`)
Today the engine calls `runSource` (driver.milo:61) directly — **no module
registry is ever populated**, so any `require` the desugar emits would hit
"module was not pre-loaded" (requireModule, eval.milo:1699; dispatched at
eval.milo:4224). Mirror the runtime's flow (milojs.milo:242): make the engine
`preloadGraph(path)` then run the entry via `runModule`, minus the node-shim
prelude. Keep `runSource` for the REPL path. Note `runModule` gives the entry
CJS scope (`module`/`exports`/`__filename`) — harmless for plain scripts.

Unresolvable specs (`qjs:std`…) already throw catchable `Error: Cannot find
module` via requireModule — correct for the skip-listed tests, no work needed.

### Step E — lock it
Add `examples/apps/milojs/tests/esm.js` + `.expected` exercising every form above
(bun runs ESM in `.js` natively, so `run.sh`'s byte-identical-vs-bun contract
works unchanged). Re-run the sweep; expect the 44 to convert to a mix of passes
and *newly visible* runtime gaps — those become new lanes, add them here.

Dynamic `import()` (1 case, `dynamic_import_rejection_handled.js`): desugar to a
Promise wrapping `require` — resolve with the exports, reject with the thrown
error. Needs the promise machinery already in eval.milo. Do this last; it's 1 case.

## Lane 2 — yield as an *expression*: 29 cases — GENERATOR AGENT'S LANE

c3f7d11 added `function*` syntax, but `yield` is still not a token: test_builtin.js
dies at line 1146 `ret = 2 + (yield 1)` → "expected …, found number", killing all
29 remaining cases in the file. **The parse-only fix is the whole 29-case win**:
generator *semantics* stay behind the existing runtime TypeError (eval.milo:2652)
and only `test_generator` itself needs them. Parse `yield [expr]` / `yield* expr`
at assignment-expression level, only valid inside a generator body.

## Lane 3 — small fixes, ~6 cases, one sitting

Run the sweep with `-v` to get exact file:case names, then:

1. **Parse errors must become SyntaxError** (~1-2 cases + broad fidelity win).
   Parser reports via eprint + limps on; a negative-syntax test (`bug1354.js`)
   needs `Uncaught SyntaxError` + exit 1. In the entry path: if `p.errored`,
   print `Uncaught SyntaxError: <msg>` and exit 1 instead of executing.
2. **`print` global** (1 case): QuickJS defines global `print`. Alias it to the
   console.log native in `setupGlobals` (eval.milo).
3. **FinalizationRegistry stub** (2 cases): `bug1352.js`, `bug648.js` only need
   construction + `register()` to not throw — GC-behavior asserts don't exist in
   them. Stub class: constructor stores the callback, `register`/`unregister`
   no-ops. Verify WeakMap-with-Symbol-keys works while in there (bug1352 uses it).
4. **padStart/padEnd length cap** (1 case): `str-pad-leak.js` currently burns the
   10s timeout allocating. Throw RangeError above a sane max (e.g. 2^30), which
   is what the test expects.
5. **Investigate individually** (3 cases): `cannot read property of a non-object`
   ×2, `toString is not a function` ×1, the one real `assertion failed`. Each is
   a genuine semantic bug — bisect the test body the way lane 2 was found
   (binary-search `head -n N` prefixes against the engine).

## Deferred (agreed, don't pick up without a new decision)

- **`eval()`** (3 cases, test_closure.js): direct eval needs parse-into-Prog
  mid-execution, which the immutable-`&Prog` design forbids by construction.
  Real design work, 3 cases — not now.
- **Resizable ArrayBuffer / DisposableStack** (3 cases: bug1296/1297/1564):
  exotic one-offs (`maxByteLength`+`resize` mid-sort, `Symbol.dispose`). Low ROI.
- **Generator runtime semantics**: tree-walker coroutines are Stage-4 (bytecode
  VM) territory per docs/milojs-roadmap.md; parse-only unblocks everything else.

## Scoreboard discipline

After each lane lands, run the full sweep, update the number at the top of this
file, and delete the lane. The number only moves up; a regression is a stop-ship.
