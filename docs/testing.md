<!-- doc-meta
system: testing
purpose: how to write/run tests, what to avoid, and an index of every test file and what it covers
key-files: tests/run.test.ts, tests/fixtures/, tests/errors/, tests/known-red.txt, tests/*.test.ts, tools/wasm/float-diff.sh
update-when: a test file or out-of-band harness is added/removed/repurposed, or the fixture protocol changes
last-verified: 2026-09-22 (--contracts applies a drawn sequence of mutator calls to a constructed struct param; builds struct params from their constructors and draws Vec<int>; 09-20: corpus census gate listed)
-->

# Testing

Run targeted subsets while iterating; run the full suite before commit.

```bash
bun test                                        # everything
bun test tests/run.test.ts -t "arithmetic"      # one fixture by @name/description
bun test tests/safety.test.ts                   # one file
```

`-t` is cheap: the fixture/error/runtime-error lanes narrow their `beforeAll` compile
fan-out to the same pattern, so a targeted run builds only what it will execute (one
fixture is ~1s, not the ~34s it cost when every lane compiled all 577 first). Bun scrubs
`-t` from `process.argv` before a test file loads, so the pattern is recovered from the
process's own command line — set `MILO_TEST_FILTER` instead if you are invoking the suite
in a way that hides it. Both fail open: no pattern found means compile everything.

## `milo test` — tests written in Milo

The compiler's own suite is the TS driver above. `milo test` is the runner **Milo programs**
use, including packages outside this repo.

```bash
milo test                          # sweep cwd for *_test.milo, recursively
milo test path/to/foo_test.milo    # one file (any filename works when named explicitly)
milo test tests/ -t "Parser"       # only tests matching a substring or regex
```

A test is a **top-level `fn test*()` taking no parameters**, in a file named
`*_test.milo`. Tests are discovered from the parsed AST, not by scanning text, so a
`fn testFoo(` inside a comment or string is not a test and one written unusually is not
missed. Anything named `test*` that cannot be run — it takes parameters, or it is generic —
is **reported as skipped with a reason**, never dropped quietly.

Each file compiles once, then **every test runs in its own process**. That is what makes a
trap (failed assert, overflow, out-of-bounds, unwrap-on-`None`) fail only its own test
instead of ending the file. Runs are parallel (`MILO_TEST_JOBS` to size the pool) and every
child is guarded with a memory cap and a 30s timeout. A `-t` pattern that matches nothing
exits 1 — a mistyped filter is not a green run.

Assertions live in `std/testing`. `assertEq`/`assertNe` are generic and print both sides;
they take `&T`, so asserting on a value does not move it:

```milo
from "std/testing" import { assertEq, assertNear, assertVecEq }

fn testDoubling(): void {
    assertEq(double(21), 42)
}
```

Use `assertNear` for floats — `0.1 + 0.2 != 0.3` in binary floating point, so an exact
comparison fails a correct program.

`tests/milo-tests/` holds the runner's own coverage, driven by
`tests/miloTestRunner.test.ts`. Its deliberately-failing cases live in
`isolationCases.milo` — *not* `*_test.milo` — so a repo-wide `milo test` sweep stays green
while the driver can still run them by explicit path.

## `milo test --contracts`: property tests written by the contracts

```bash
milo test --contracts std examples        # what CI runs (both the macOS and Linux jobs)
MILO_CONTRACT_SEED=7 milo test --contracts std/string.milo
```

`--contracts` scans **every** `.milo` file under the given paths (not just `*_test.milo`)
and synthesizes one property test per fn carrying a `requires`/`ensures`. Each test draws
200 inputs, discards those the `requires` rejects, calls the fn, and checks the `ensures`.
A refutation prints the arguments that produced it. This is a different question from
`milo prove`: the prover asks whether the contract is *provable*, this asks whether it is
*true on drawn inputs*, and it finds the contract that is too weak rather than too strong.
Its first sweep of std found five contracts promising results that exhaust memory
(`strRepeat`, both pads, `Pool.new`, `inflate.zeros`) and one missing character-boundary
precondition on `strCharAt`.

The seed is fixed so a red run reproduces; `MILO_CONTRACT_SEED` draws a different sample.
`MILO_CONTRACT_TRACE=1` prints every call a test makes on stderr *before* it runs, which is
how a case that dies mid-sequence (a failed assert, an out-of-bounds store) is reproduced:
a trap takes the process with it, so a message buffered until the end of the case would
never print, and the last traced line is the call that died.

**How a struct parameter is built.** Never field by field. A `Bump { used: 1, cap: 0 }`
violates the invariant every constructor maintains, so it would refute a contract that is
true of every value the program can reach, and a false refutation costs more trust than a
skip does. Instead the harness looks for a **constructor** in the same file (a
non-extern, non-generic, receiver-less fn returning `T`, `Result<T>` or `Option<T>` whose
own parameters are all drawable scalars) and builds the value by calling it with drawn
arguments that satisfy that constructor's own `requires`. A fallible constructor returning
`Err`/`None` is a discarded draw, not a failure. The first qualifying constructor in
declaration order wins, so one file always generates one harness. This is what puts
`&mut Bump`, `&mut Pool`, `&Store` and `&mut Pid` in reach. A refutation prints the
constructor call rather than the struct (`a=bumpNew(capacity=7)`), because that is what
reproduces the case and a struct has no `Display` anyway.

`Vec<T>` for an integer `T` is drawn directly: a length in `0..=32`, then that many drawn
elements. A refutation prints the elements as they were *before* the call, so a fn that
sorted its `&mut Vec` in place still shows the input that provoked it.

**What it does not reach.** A fn is skipped, with the reason printed, when it has a type
parameter, when a contract mentions `old()` (the harness cannot snapshot a value it does
not own), or when a parameter is a type it cannot build: a struct with no qualifying
constructor *in the same file* (the contracts path parses without resolving imports), a
`Vec` of anything but integers, a pointer, an array. A `&mut` parameter of such a type
still reports that it is `&mut`.

**How a state a constructor cannot return is reached.** After building a struct parameter
the harness applies a drawn sequence of **mutator** calls to it: a length in `0..=8`, then
that many calls picked uniformly. A mutator is a same-file, non-extern, non-generic fn with
exactly one `&mut T` parameter and every other parameter a drawable by-value scalar
(methods are out: there is no receiver to generate). This is what puts `poolFree`'s
`requires p.liveCount > 0` in reach, since only `poolAlloc` makes that true.

It buys reach without giving up the invariant above, because **every call in the sequence
is gated by that call's own `requires`**, re-printed over the harness's locals and checked
at runtime immediately before it. A drawn call the gate rejects is skipped and the rest of
the sequence still runs: discarding the whole draw would throw away the states the earlier
calls reached, and calling it anyway would fabricate one no program reaches.
`tests/contracts/contractTestsSkipMutator.milo` pins that (its `neverBump` has a `requires`
no argument satisfies and must appear in no refutation).

An integer a call in the sequence returned is offered back to later calls as an argument,
and *taken* rather than copied when used. A pool block is only ever a number `poolAlloc`
handed out, so no drawn `i64` would ever satisfy `poolFree`'s address preconditions; and
using the same handle twice is a double free, a state no correct program reaches and one no
`requires` here can rule out. A refutation prints the sequence next to the constructor call
(`p=poolNew(size=16, count=4) then poolAlloc(p) poolFree(p, block=...)`), which is what
reproduces the state. One caveat on reproducibility: the *draws* are fixed by the seed, but
a value the program returned is not (an allocator hands back a heap address), so a contract
that compares against one reproduces in shape rather than byte for byte.

There is still a limit, reported per test rather than per fn. The sequence can only use
calls the file itself declares, so a `requires` that no constructor and no drawn sequence
establishes is never satisfied: a struct with no mutator at all, for instance. Such a test
prints `⊘ <name>` naming the constructed parameter and is counted as `unreachable`,
neither a pass nor a failure. `tests/contracts/contractTestsStructs.milo::sealedStamp` pins
that shape, and `::counterDrained` pins the other half: `hits > 0` is reachable only
through `counterBump`, so that test must run real cases rather than report unreachable.

That skip is scoped to constructed values, and deliberately so. When every parameter is a
scalar the draw space IS the type, so zero satisfying draws means the `requires` is
unsatisfiable: a real defect, and a hard failure. A property test that never ran is not
green (`tests/contracts/contractTestsVacuous.milo`).

## The fixture protocol (no code changes to add a test)
`tests/run.test.ts` walks two directories:
- `tests/fixtures/*.milo` — **compiled + executed.** stdout must match the `// @expect: <line>` annotations, one per expected output line.
- `tests/errors/*.milo` — **must fail type-check.** Error output must contain the `// @error: <substring>` annotation.

Add a test by dropping a `.milo` file in the right directory with the right annotation. That's it. (<!-- stat:fixtures -->742<!-- /stat --> fixtures, <!-- stat:error-fixtures -->428<!-- /stat --> error cases, <!-- stat:runtime-error-fixtures -->29<!-- /stat --> runtime-error cases.)

**Known-red fixtures.** `tests/known-red.txt` lists fixtures that reproduce an *open*
soundness hole (today: the `hole*` reproducers from
[plans/soundness-sweep-2026-09.md](plans/soundness-sweep-2026-09.md)). The driver skips
their `@expect` comparison, registers each as a skip that names the reason, and prints
`known-red: N fixtures skipped (tests/known-red.txt)`. Nothing else honours the list:
`bun run test:asan` (`scripts/asan-sweep.ts --all`, also the CI step) still builds and runs
them under AddressSanitizer, labels the report line `known-red`, and exits 1, which is where
the hole stays visible. `scripts/gen-spec.ts` leaves them out of `docs/spec.md`, since a
listed program is one the language must eventually reject. Each entry names the work package
that closes it; delete the entry in that change (a stale entry throws in the driver).

There's also `tests/runtime-errors/` for programs that compile but must fail at runtime.

## Examples as smoke tests
`bun run scripts/run-examples.ts` compiles **every** example entrypoint (`examples/**/*.milo` with a `fn main`) — a hard gate — and runs the ones that opt in:
- `// @run: <args>` near the top → runs with those args, must exit 0. Bare `// @run:` = no args.
- `// @stdin: <text>` → fed on stdin (a trailing newline is added).
- No annotation → compile-only (right for servers, TUIs, and tools needing setup). Library modules (no `main`) are skipped automatically.

When you add or change an example, add a `// @run:` if it can run deterministically, so it's exercised and not just built. This is part of the mandatory Run gate ([AGENT_WORKFLOW.md](../AGENT_WORKFLOW.md)).

## How to write a good test
- **Assert the thing the test names.** A test called `move_after_use_errors` must fail if move-checking breaks — not pass because of an unrelated compile error. Prefer `tests/errors/` with a specific `@error:` substring over a vague one.
- **Minimal fixture.** Smallest program that exercises the behavior; unrelated code hides the signal.
- **One concept per fixture.** Easier to name, easier to bisect when it breaks.
- Feature work touches checker + lower + codegen + **formatter + LSP** — so a feature usually needs fixtures *and* a `formatter.test.ts` / `lsp.test.ts` case.

## What to avoid (false-confidence smells)
- A fixture whose `@expect` would pass even if the feature it names were deleted. If deleting the feature keeps it green, it tests nothing.
- Asserting a coincidence (an output that happens to match for the wrong reason).
- `test.only` / `.skip` committed — the linter blocks these; they silently shrink the suite.
- Testing only the happy path when the interesting behavior is the error/edge path.
- Periodically run a false-confidence audit: pick a claim, break the code that should satisfy it, confirm a test goes red. If none do, the coverage is a mirage.

## Test file index
| File | Covers |
|---|---|
| `run.test.ts` | fixture driver — compiles+runs `fixtures/`, checks `errors/` fail-to-typecheck |
| `safety.test.ts` | memory-safety / move-checking / borrow rules |
| `unsafeLint.test.ts` | `unsafe` block linting |
| `abi.test.ts` | struct-by-value C FFI / native ABI lowering |
| `modules.test.ts` | import resolution + cross-file merge |
| `formatter.test.ts` | `milo fmt` output stability |
| `lsp.test.ts` / `lspProject.test.ts` | LSP diagnostics/hover/go-to-def; project-wide LSP |
| `selfhost.test.ts` | milo-self bootstrap convergence (guarded) |
| `debugInfo.test.ts` | DWARF emission (`-g`) |
| `wcet.test.ts` / `wcetCycles.test.ts` | worst-case-execution-time analysis |
| `allocaHoist.test.ts` / `zeroStore.test.ts` | codegen optimizations |
| `swapCodegen.test.ts` | large-aggregate swap alias-safe lowering |
| `guard.test.ts` | memory/timeout guard wrapper |
| `docs.test.ts` / `stdDocs.test.ts` / `apiDocs.test.ts` | doc + stdlib-API-doc consistency |
| `header.test.ts` | generated C header correctness |
| `embedded.test.ts` | embedded/no-runtime target |

Keep this table current — it's the map reviewers and the sweep skill use to reason about coverage.

## Out-of-band differential harnesses
Not `bun test` — they need a toolchain CI supplies but a checkout may not, so run them by hand when you touch the target they cover.

| Harness | Covers | Needs |
|---|---|---|
| `tools/wasm/float-diff.sh` | wasm64 float formatting/parsing (`tools/wasm/runtime.c`'s dtoa + strtod) against the host libc, byte for byte — ~53k lines across a C-level probe (`float-selftest.c`: `%f`/`%e`/`%g` at fifteen precisions, `strtod` endptr/ties/subnormals) and a compiler-level one (`float-diff.milo`) | node + a clang with a wasm64 backend |
| `scripts/windows-sweep.ts` | every fixture cross-compiled to windows-x64 and run under Wine | `MILO_WINDOWS_SDK`, wine |
| `scripts/corpus-census.ts --check` | non-FFI `unsafe` blocks per root across the org's `.milo` corpus, shrink-only against `scripts/corpus-census.baseline.json`; a new one means the ownership model pushed a program out, and it owes a comment saying why | the sibling checkouts under `~/git/milo-language` (absent ones are named, not measured) |

The first two are differential: the native build is the oracle, so "it compiled" is never the pass condition. Before trusting a green run, break the thing under test on purpose and confirm the harness goes red.
