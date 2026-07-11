# Playground Progress

In-browser Milo playground: the TS compiler (lexer→parser→checker→lower→**codegen-js**)
bundles to a single ESM file that runs in the browser, compiles Milo source to JS, and
evals it with captured output. No LLVM — the JS backend (`src/codegen-js.ts`) is the
browser target. (LLVM-in-browser is impractical; JS backend is the right call.)

## Working
- `playground/compiler.ts` — browser entry: resolves imports from bundled stdlib
  (prelude + `std/*.milo`, minus a BLOCKED list of native-only modules), compiles Milo →
  JS via `generateBody` (body only), evals with a captured-output runtime.
- `playground/build.ts` — bundles compiler + all `std/*.milo` into one ESM, stubs Node
  APIs. `bun run playground/build.ts` → `dist/compiler.js` (~1.45 MB).
- `playground/index.html` — dark-theme UI, editor, output panel, 6 examples, Ctrl+Enter.
- **All 6 built-in examples compile + run in-browser, byte-identical to the native
  binary** (fizzbuzz, structs, enums, closures, generics, vec).

## Recently fixed
- **Crash on every program**: `resolveImportsPlayground` built a `Program` without
  `typeAliases`/`interfaces`/`globals` (added to the AST after the playground was
  written) → checker threw `undefined is not an object (program.typeAliases)`. Now
  collects + merges all three. (`e55ab05`)
- **Stale examples**: structs/enums used the old explicit `&x` call-site borrow (now
  requires `unsafe`; use auto-borrow) and structs missed the `std/math` sqrt import.
  Updated to current syntax. (`e55ab05`)
- **Float formatting**: `codegen-js` printed floats with JS `String()` (`78.53975`); now
  uses a `__fmtG` C-`%g` emulation (`78.5397`), matching the native binary. (`9b3fdb9`)

## Next steps
1. **codegen-js coverage sweep** — run diverse programs through `emit-js`, diff vs native,
   find backend gaps (HashMap, Result/`?`, string methods, match guards, generics edge
   cases). Each gap fixed = more programs the playground can run.
2. Real-browser smoke test (bun test uses `process`; browser falls back to console — the
   captured runtime avoids both, but verify in a live page + serve `python3 -m http.server`).
3. UX: "show JS" toggle, shareable URLs via hash, error-panel formatting, minify bundle.

## Milo syntax reminders (for examples)
- Closures: `(x: i32): i32 => x * 2` (NOT `|x| x*2`).
- Call sites auto-borrow: `f(x)` for a `&T` param, NOT `f(&x)` (explicit `&` = raw ptr,
  needs `unsafe`).
- No semicolons; newline-separated statements.
