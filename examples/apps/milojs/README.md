# milojs

A JavaScript interpreter written in Milo. Long-term goal: replace the
JavaScriptCore dependency in `examples/apps/minibun.milo` with a pure-Milo
engine.

## Stage 1 — tree-walking interpreter

Implements a small JS subset end to end: lexer → AST → evaluator.

- Values: number (f64), string, bool, null, undefined, functions
- Variables (`let`/`var`/`const`, all block-scoped), assignment
- Arithmetic `+ - * / %` with JS coercion (`+` concatenates if either side is
  a string), comparisons, `== !=` (loose-ish), `&& ||` (short-circuit, yield
  operand values), unary `- !`
- `if`/`else`, `while`, blocks
- Function declarations, anonymous function expressions, `return`, recursion,
  and real closures (a function captures its defining scope)
- `console.log` with JS output formatting (integral numbers without `.0`,
  shortest round-trip float text, `NaN`/`Infinity`)

Out of scope for stage 1: objects, arrays, prototypes, `this`, GC, `for`,
ternary, exceptions/`try`, regex, bytecode.

Internals: the AST is index-based (enums holding i64 indices into flat arenas
in `Prog`) — recursive structure without stored references. Scopes live in an
arena (`Vec<Scope>`, parent links by index) so closures capture their
environment by index.

## Stage 2 — mark-sweep GC over the scope arena

Dead scopes are now reclaimed. Design: **stable slots + free-list reuse, no
compaction** — closures (`Func(fn, envIdx)`) and parent links reference scopes
by index, so slots can never move. Roots are global scope 0 plus an explicit
dynamic-call-stack `Vec` (a recursive frame's parent is its *lexical* scope, not
its caller, so the parent chain alone under-roots the live call stack). GC runs
**only at statement boundaries** — the one safepoint where every live value sits
in a scope binding and no closure is in-flight mid-expression — which keeps the
collector ~130 lines of plain loops with no `unsafe` and no lifetime plumbing.

`tests/gc.js` (~800k scope allocations) stays byte-identical to `bun`; run it
with `MILOJS_GC_STATS=1` to watch the arena stay capped near the GC threshold
(~1028 slots) instead of growing to ~800k.

## Run

```bash
bun run src/main.ts run examples/apps/milojs/milojs.milo -- examples/apps/milojs/tests/basics.js
MILOJS_GC_STATS=1 bun run src/main.ts run examples/apps/milojs/milojs.milo -- examples/apps/milojs/tests/gc.js
```

`tests/*.js` each have a `tests/*.expected` file; output is byte-identical to
`bun <script>` for all.

## Roadmap

- Stage 3: objects, arrays, prototypes, `this` — add an `Obj(u32)` heap cell as
  a new `JSValue` variant, collected by the same `markScope` (extra variants,
  same index-walk shape)
- Stage 4: bytecode VM (compile AST → bytecode, dispatch loop)
- Stage 5: enough builtins (JSON, Math, String/Array methods, timers) to run
  minibun's node shims without JSC
- Stage 6: test262 conformance lock
