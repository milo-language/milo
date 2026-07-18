# Playground Progress

In-browser Milo playground: the TS compiler (lexer→parser→checker→lower→**codegen-js**)
bundles to a single ESM file that runs in the browser, compiles Milo source to JS, and
evals it with captured output. No LLVM — the JS backend (`src/codegen-js.ts`) is the
browser target. (LLVM-in-browser is impractical; JS backend is the right call.)

## Working
- `scripts/playground/compiler.ts` — browser entry: resolves imports from bundled stdlib
  (prelude + `std/*.milo`, minus a BLOCKED list of native-only modules), compiles Milo →
  JS via `generateBody` (body only), evals with a captured-output runtime.
- `scripts/playground/build.ts` — bundles compiler + all `std/*.milo` into one ESM, stubs Node
  APIs. `bun run scripts/playground/build.ts` → `dist/compiler.js` (~1.45 MB).
- `scripts/playground/index.html` — dark-theme UI, editor, output panel, 6 examples, Ctrl+Enter.
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

## codegen-js coverage — `bun scripts/js-sweep.ts` (mirrors run.test.ts)

**231 / 339 fixtures run byte-identical to native** (0 compile-err). Widened from 183 by
fixing, in order: if-expressions, `?` propagation, interface/trait dispatch, struct/enum
Display, Vec/HashMap ops (swap/insert/remove/reverse/getOrDefault), char/string byte
semantics (ASCII), `String.withCapacity`, `eprint`→stderr, and `&mut`-primitive boxing
(the big one — the JSON parser threads `&mut i64 pos`; JS passes primitives by value, so
mutations were lost until locals/params became `{v:…}` boxes). The other ~95 "run-err"
fixtures use unsafe/systems/thread/C-FFI features that are out of playground scope by
design (and BLOCKED in `compiler.ts`).

The 13 remaining DIFFs are all **fundamental or disproportionate**, deliberately deferred:
- **Deterministic Drop (5)** — dropUser/WithFields/EarlyReturn/ZeroFirstField,
  moveVarIntoEnumReturn. JS is GC'd; no destructor timing. Fundamental.
- **64-bit / unsigned integer (5)** — intLiteral64, u64Arithmetic, unsigned,
  wrapping/saturatingArith. JS numbers are f64; needs BigInt. Fundamental (per loop scope).
- **Multibyte UTF-8 (2)** — unicodeCodepoints, hexEscape. milo strings are UTF-8 byte
  buffers; JS strings are UTF-16. Byte-accurate `.len()`/index/build needs a Uint8Array
  string representation (a full rewrite of every string op); doing it per-op via
  TextEncoder is O(n²) and risks timeouts. Disproportionate for 2 fixtures.
- **Custom iterators (1)** — forIterator. `for x in c` over a user type with `next()`
  lowers (in lower.ts, shared with native) to a "vec"-fallback ForEach with no
  custom-iterator signal; codegen-js can't distinguish it. A frontend/lowering concern,
  not codegen-js.

## Other next steps
1. Real-browser smoke test (bun test uses `process`; browser falls back to console — the
   captured runtime avoids both, but verify in a live page + serve `python3 -m http.server`).
2. UX: "show JS" toggle, shareable URLs via hash, error-panel formatting, minify bundle.

## Milo syntax reminders (for examples)
- Closures: `(x: i32): i32 => x * 2` (NOT `|x| x*2`).
- Call sites auto-borrow: `f(x)` for a `&T` param, NOT `f(&x)` (explicit `&` = raw ptr,
  needs `unsafe`).
- No semicolons; newline-separated statements.
