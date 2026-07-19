<!-- doc-meta
system: milojs
purpose: per-lane work plan driving scripts/quickjs-sweep.ts conformance toward 100%
key-files: scripts/quickjs-sweep.ts, examples/apps/milojs/parser.milo, examples/apps/milojs/modules.milo, docs/milojs-roadmap.md
update-when: a lane lands (update the score, delete the lane) or the sweep harness changes
-->

# milojs QuickJS-parity plan

Working plan for driving `scripts/quickjs-sweep.ts` toward 100%. Written for agents
picking up individual lanes; each lane is independent and lists exact anchors.
Current: **67/149 cases (45.0%)**. Delete lanes here as they land.

Engine-level spec builtins now live in `lib/engine-prelude.js` (loaded by
`milojs-engine.milo` into the shared `Prog` before the entry runs) — distinct from
`lib/prelude.js`, which is the *node runtime's* prelude. Anything the ECMAScript
spec defines that is easier to write in JS than as a native belongs there:
`Symbol.for`/`keyFor`, `escape`/`unescape`, `WeakRef`, `FinalizationRegistry`,
`DOMException`, `Error.captureStackTrace`, `Array.fromAsync`. Note `WeakRef` and
`FinalizationRegistry` hold targets STRONGLY (no weak refs in the collector), so a
test asserting a target was actually collected will correctly fail rather than
pass vacuously.

Engine bugs found by measuring and since FIXED (all were real language bugs, not
suite artifacts — the suite is earning its keep as a bug-finder even where it
doesn't move the score):
- ~~array/object rest in destructuring~~ (30c689b): `...` was never handled in
  `patternDecls`, so `const [g, ...h] = [7,8,9]` bound `h = 9` and
  `const {x, ...y}` bound `y = undefined`. Array rest lowers to `src.slice(i)`;
  object rest to an `__objRest(src, boundKeys)` helper in the engine prelude.
  The node runtime now loads `engine-prelude` too (it is engine + node shims, so
  it needs the spec layer as well).
- ~~reading a property of null/undefined returned undefined~~ (e66377a): now
  throws `TypeError: cannot read property 'x' of null`, matching the spec text.
  Optional chaining (`?.`) is a separate AST node and still yields undefined.

- ~~`Array.prototype.fill` ignored its range args~~ (fea6143): `[1,2,3].fill(0,1)`
  overwrote the whole array. `fill(value, start, end)` now honors both, negative
  indices included.

- ~~symbols leaked their internal representation~~ (f2095e5): `String(sym)` and
  `sym.toString()` returned `@@sym:d:1`; `.description` was undefined.
  **Milo gotcha found here:** `isSymbolValue(ov)` inside `match ov { JSValue.Str(s) => … }`
  silently returns false — matching MOVES the value, so reading the original
  binding in the arm sees a zeroed slot. The check compiles and runs, it is just
  always false. Use the arm's own binding (`isSymbolStr(s)`) instead. Worth
  remembering: this failure mode is invisible, no error and no warning.

- ~~no iterator protocol at all~~ (ef6c5fc): `Symbol.iterator` did not exist, and
  `for-of` worked only by special-casing arrays/strings/Map/Set — a user object
  with `[Symbol.iterator]` threw "not iterable". Now `for-of` drives the real
  protocol, calling `next()` **lazily**, one pull per iteration, so iterators with
  side effects observe JS ordering and `break` stops pulling. Spread also learned
  Set and string (`[...new Set(x)]` silently produced `[]` before).
  Well-known symbol keys are fixed interned strings (`@@sym:Symbol.iterator:0`);
  counter 0 is reserved since user symbols start at 1.

- ~~`Object.freeze` was a no-op~~ (1d51cbe): it returned the object and froze
  nothing, so code relying on it for immutability got silent non-protection —
  arguably the worst class of bug here. Now a `frozen` flag on `JSObj`, enforced
  in `setMember`, in `arrayMethod` (push/pop/sort/… write through `arrPush` and
  bypass `setMember`), and in both `delete` branches (`Expr.Member` AND
  `Expr.Index` — the computed one is separate and was missed on the first pass).
  `Object.isFrozen` added alongside; primitives report frozen, per spec.
- ~~`e.message` was decorated with the module name~~ (1d51cbe): `throwNullMember`
  appended `currentModule(st)`, so `e.message` never equalled the spec text any
  comparison expects. Dropped for spec-defined messages.

Still open, found the same way:
- error objects have no `.constructor`, so `e.constructor.name` throws.
- **no sparse arrays**: `delete arr[1]` stores `undefined` rather than a hole, so
  `1 in arr` stays true (`bug1430.js`). A real fix needs a `Hole` variant in
  `JSValue`, threaded through every array op — faking it via "undefined means
  absent" would break `[undefined]`, where `0 in a` must be true. Left alone
  deliberately.
- `Object.freeze` is shallow and does not stop internal `objSet` calls; engine
  internals can still mutate a frozen object. Fine today, worth knowing.
- **spread does not honor `[Symbol.iterator]`** on user objects (for-of does).
  `spreadInto` takes an immutable `&Interp` and so cannot call back into user
  code; fixing it means threading `prog` + `&mut Interp` through its 3 call sites.
- `Array.prototype.entries`/`keys`/`values` and `String.prototype.matchAll` can be
  built on the protocol now — they return iterator objects, which is expressible.
- `Number.prototype.toPrecision` ignores its argument (`(123.456).toPrecision(4)`
  → `123.4560`, want `123.5`).

## Lane 4 — missing standard builtins (inventoried, mechanical)

**Key constraint discovered: `Array.prototype` and `String.prototype` are NOT
extensible from JS.** Array and string methods are dispatched natively by name
(`isArrayMethod` / `stringMethod`), never through a prototype chain, so assigning
`Array.prototype.at = …` in the prelude parses and runs but the method is
unreachable. Anything on those two prototypes must be added in Milo. `Number.*`
and other constructor statics DO accept assignment, so they belong in the prelude.

Confirmed missing, grouped by where the fix goes:

- ~~**Prelude**~~ DONE — `Number.*` statics and constants (fea6143).
- ~~**`eval.milo`, array methods**~~ DONE (fea6143, 54db2d7): `at`, `findLast`,
  `findLastIndex`, `copyWithin`, `reduceRight`, `flatMap`. Still open: the
  iterator trio `entries`/`keys`/`values`, which need an iterator protocol first.
- ~~**`builtins.milo`, string methods**~~ DONE (1299f8c): `at`, `codePointAt`,
  `replaceAll`, `localeCompare`, `normalize`. Still open: `matchAll` (needs the
  regex iterator). Note `codePointAt`/`localeCompare` are byte-oriented, matching
  the ASCII-only limit the rest of that file already carries.
- ~~**`Object`**~~ DONE (1d51cbe): `isFrozen` (native, real), `fromEntries` (prelude).
- ~~**`Array.of`**~~ DONE (1d51cbe, prelude).

Adding an array method means two edits: the name must be added to the
`isArrayMethod` gate list or the dispatch is never reached.

**All infrastructure blockers are gone.** Lanes 1 and 2 landed; every remaining
failure is a genuine engine gap rather than a file that won't load. The profile is
a long tail — no single remaining fix is worth more than a handful of cases, so
from here it is incremental builtin and semantics work.

Current top buckets (`-v` for the per-case list):

| n | cause | likely lane |
|---|---|---|
| 15 | `value is not a constructor` | `Proxy` / `Reflect` / resizable `ArrayBuffer` — need evaluator traps, NOT expressible in the prelude |
| 14 | `assertion failed: got \|…\|` | real semantic divergences — bisect individually |
| 12 | `cannot read property of a non-object` | missing builtin objects |
| 6 | `cannot read property of undefined` | surfaced by e66377a; each needs a look |
| 5 | parse errors | BigInt literals, `for await` |
| 5 | `eval is not defined` | deferred by design, see below |
| 3 | `generator functions are not supported` | needs Stage-4 VM |

The cheap-builtin seam is exhausted: what is left in the constructor bucket is
`Proxy`/`Reflect`, which cannot be written in JS and needs evaluator support.

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

## Lane 1 — ESM import/export: DONE (c846eb7, da5a4b8)

Landed as a parse-time desugar onto the CommonJS loader, deliberately touching
only `parser.milo` / `lexer.milo` / `milojs-engine.milo` to avoid colliding with
another agent holding `modules.milo` at the time:

- `T_IMPORT` / `T_EXPORT` tokens; `from` and `as` stay contextual identifiers.
- `parseImport` emits ONE `MultiDecl` per import (`const __esm_N = require(spec),
  a = __esm_N["a"], …`), which is why no extra statements need to escape
  `parseStmt`. Named imports use `Index` not `Member` so string-named imports work.
- `export` is handled in `parseProgram` (top-level only, as the spec requires),
  appending `exports.x = x` after the declaration — so no `PState` field was
  needed, which would have forced edits in every construction site.
- Discovery: module preloading scans *tokens*, before the desugar exists, so
  `scanImports` in `milojs-engine.milo` walks the ESM edges and `preloadWithImports`
  BFSes them into `preloadGraph`. The engine only takes the module path when the
  file actually has imports; plain scripts still run in global scope via `runSource`.
- `qjs:std` / `qjs:os` stubs (`lib/qjs-*.js`) + a real `gc()` global wired to
  `collect()`. One unresolvable host import was killing all 30 `test_builtin.js`
  cases; `gc()` collects for real rather than no-opping, so the GC tests that call
  it aren't passing vacuously.

**Known limits** (fine for the suite, revisit if real code hits them): exports are
snapshots, not ESM live bindings; no default *imports* (`import x from "m"`); no
re-export chains (`export … from "m"`); `import` is a keyword everywhere, so
`obj.import` would misparse.

## Lane 1b — old ESM notes, kept for the forms table

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

## Lane 2 — yield as an expression: DONE (24a0099)

`T_YIELD` in the lexer; `yield` / `yield*` parsed in `parseExpr` (looser than
ternary, tighter than comma) as `Expr.Un("yield", …)`, mirroring how `await` is
handled. Operandless `yield` is detected by peeking for a closing token. Parse-only
by design — calling a generator still throws TypeError in `callFunction`, so the
`Un("yield")` node is never evaluated and `eval.milo` needed no change.

Caveat left behind: `yield` is now a keyword *everywhere*, not only inside
generator bodies, so `var yield = 1` in sloppy-mode code no longer parses. Real JS
reserves it contextually. Nothing in the suite or `tests/*.js` hits this; fix by
threading an `inGenerator` flag through `PState` if it ever bites.

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
4. ~~**padStart/padEnd length cap**~~ DONE (a0ccf92) — throws RangeError past 2^29.
   Worth 0 cases (the test already completed inside the timeout at -O2); kept
   because V8's behavior is to throw and the old path could allocate gigabytes.
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
