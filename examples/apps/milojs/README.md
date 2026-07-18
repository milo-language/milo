# milojs

A JavaScript interpreter written in Milo. Long-term goal: replace the
JavaScriptCore dependency in `examples/apps/minibun.milo` with a pure-Milo
engine.

## Stage 1 (this) — tree-walking interpreter

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
append-only arena (`Vec<Scope>`, parent links by index) so closures capture
their environment by index; nothing is freed yet, which is exactly what stage
2's GC addresses.

## Run

```bash
bun run src/main.ts run examples/apps/milojs/milojs.milo -- examples/apps/milojs/tests/basics.js
```

`tests/*.js` each have a `tests/*.expected` file; output is byte-identical to
`bun <script>` for both.

## Roadmap

- Stage 2: managed heap + mark-sweep GC (scopes and heap cells become
  collectable; cycles work)
- Stage 3: objects, arrays, prototypes, `this`, closures over heap cells
- Stage 4: bytecode VM (compile AST → bytecode, dispatch loop)
- Stage 5: enough builtins (JSON, Math, String/Array methods, timers) to run
  minibun's node shims without JSC
- Stage 6: test262 conformance lock
