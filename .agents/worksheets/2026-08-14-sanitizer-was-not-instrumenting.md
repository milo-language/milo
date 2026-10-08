# Worksheet: the sanitizer that linked, ran, reported, and checked nothing

- **Slug / tag:** `ws/sanitizer-not-instrumenting`
- **Started:** 2026-08-14
- **Status:** done
- **Related:** `scripts/selfhost-asan.ts`, `scripts/fuzz-ownership.ts`,
  `tests/sanitize.test.ts`, `project_uaf_proof_technique`, `feedback_silent_success`

## Goal

Give `scripts/fuzz-ownership.ts` a second oracle. Its existing one — MallocScribble
plus a predicted stdout — only sees a use-after-free whose freed bytes something else
has since overwritten. A read of a block nothing has touched yet prints the correct
answer and passes, which is the exact direction the harness exists to test.

The plan was one flag: run accepted programs under `--sanitize`.

## What the flag turned out to be

`--sanitize` linked the ASan runtime and instrumented **zero functions**.

```
$ nm -u $(milo build --sanitize foo.milo -o foo; echo foo) | grep asan
___asan_init
___asan_register_image_globals
___asan_unregister_image_globals
___asan_version_mismatch_check_apple_clang_1700
```

No `__asan_report_load*` / `__asan_report_store*`. clang attaches the
`sanitize_address` function attribute in the **frontend**, which a `.ll` input bypasses
entirely, and the AddressSanitizer pass instruments only functions carrying it. Milo's
emitted IR had no function attributes at all (`grep -c '^attributes' foo.ll` → 0), so
the pass ran over 1579 functions and marked none of them.

Proof, same program both ways:

```
$ milo run --sanitize uaf.milo
70                                        # silent garbage

$ sed -E 's/^(define [^{]*)\{$/\1#0 {/' uaf.ll > attr.ll
$ printf 'attributes #0 = { sanitize_address }\n' >> attr.ll
$ clang -O2 -fsanitize=address attr.ll -o attr.bin -lm && ./attr.bin
==11805==ERROR: AddressSanitizer: heap-use-after-free ... READ of size 4
```

## Why nobody noticed

Because the sanitizer still worked, just not at the thing it is mostly reached for.
The malloc/free **interceptors** are independent of instrumentation, so double-free,
invalid-free and (on Linux) leaks were still reported normally. Only load/store checking
was missing — which is to say, only use-after-free **reads**.

That is the exact profile of every bug `scripts/selfhost-asan.ts` has ever found: a
struct field read out of a container it did not own, a `Heap<T>` box copied as a bare
pointer, `*box` on an indexed element. All three hand out a second owner of one
allocation, and all three surface at the second `free` — interceptor territory. The
harness looked productive while blind in one eye.

Its census inherited the hole: 594 fixtures reported clean, and an empty known-bad
manifest reported as the goal state, for a bug class the binary could not observe.

## The fix

- `src/codegen.ts` marks every emitted `define` with `#0` and appends
  `attributes #0 = { sanitize_address }`. The group reference is inserted **before** any
  `!dbg` attachment — LLVM requires metadata last, so `-g --sanitize` would otherwise
  emit IR that does not parse.
- `scripts/selfhost-asan.ts` applies the same transform to milo-self's IR itself.
  `src-milo` is frozen at the fixpoint (`docs/selfhost-endgame-decision.md`), so the
  harness instruments the `.ll` rather than the compiler that produced it.
- `scripts/fuzz-ownership.ts` runs `--sanitize` as its primary oracle, keeping
  MallocScribble underneath. An accepted program that prints exactly the right bytes off
  a freed block is now reported as `unsound-accept`, not a pass.

## The part worth generalising

Two of the three changes above are guards on the oracle, not on the compiler:

- `selfhost-asan.ts` refuses to run a census against a binary with no
  `__asan_report_*` references.
- `fuzz-ownership.ts` compiles a deliberate use-after-free read at startup and exits 2
  unless ASan reports it.

Both exist because the failure mode here was not a wrong answer. It was **the right
answer, printed by something that never looked** — a harness whose pass and its
not-running are the same output. That is the `feedback_silent_success` class, and the
countermeasure is the same every time: before trusting the oracle to pass, prove it can
fail. The self-check was verified by mutating its expected verdict and watching it
report `got: heap-use-after-free` — i.e. the guard fires for the right reason, and the
real check passes for the right reason.

## Results

- 60 `src/` fixtures under real instrumentation: clean, no new noise.
- `selfhost-asan.ts` census re-measured with instrumentation live: **594/594 still
  clean**. The number did not move, but it now means what it says.
- `--all` (fixtures + examples, 753 programs): **753/753 clean**. The examples corpus is
  the biggest real code milo-self compiles and had never been measured instrumented.
- 360 ownership-fuzz cases (seeds 11/12/13) under the ASan oracle: no findings.
- `tests/sanitize.test.ts` pins all of it: attribute on every define, ordering vs `!dbg`,
  `__asan_report_*` present in a built binary, a real UAF reported, and no attribute
  without the flag.

## Left behind

- The census is clean, which is the good outcome and also the unsatisfying one: the fix
  bought coverage, not a bug. The read-UAF class is now observable; whether src-milo has
  one is a question this can finally answer, and today it answers no over 753 programs.
- Nothing here was a host-language problem. A missing attribute in emitted output is not
  a type error in TypeScript, Rust or Milo — see `docs/plans/compiler-host-language.md`,
  whose measured conclusion this is one more data point for.
