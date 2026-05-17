# Playground Progress

## Done
- `playground/compiler.ts` — browser entry point, resolves imports from bundled stdlib, compiles Milo → JS, evals + captures output
- `playground/build.ts` — bundles compiler + all std/*.milo into single ESM file, stubs Node APIs (fs/path/os/process)
- `playground/index.html` — dark theme UI, code editor, output panel, 6 example programs, Ctrl+Enter to run
- `playground/dist/compiler.js` — 664KB bundle, verified zero Node imports leaked
- Build works: `bun run playground/build.ts`
- Simple programs compile+run correctly (fizzbuzz verified end-to-end)

## Issue to Fix
- `compileAndRun` hangs on struct examples when run via bun. Likely the regex stripping the runtime preamble fails and creates an infinite loop or stack overflow in the eval'd code.
- Root cause: the regex in `compileAndRun` that strips the codegen runtime (`result.js!.replace(/^"use strict";\n\n\/\/ runtime\n(?:.*\n){6}\n/, "")`) probably doesn't match, so the runtime gets double-defined (two `__out`, two `__flush`) causing conflict.
- Fix: instead of regex-stripping, just use the full codegen output as-is inside the Function constructor, but override __print/__flush/__out with captured versions. OR: emit codegen-js without the runtime preamble (add a flag to CodegenJS).

## Recommended Fix
Add `generateBody(module)` to CodegenJS that emits everything EXCEPT the runtime preamble. Then `compileAndRun` calls that instead, and prepends its own captured-output runtime.

## Closure Syntax Note
Milo closures: `(x: i32): i32 => x * 2` (NOT Rust-style `|x| x * 2`)
Examples in index.html already fixed for this.

## Next Steps
1. Fix the runtime double-definition hang
2. Test all 6 examples end-to-end
3. Test in actual browser (server was started on port 8765, kill with `kill 7112`)
4. Consider: minify bundle, add "show JS" toggle, add shareable URLs via hash
