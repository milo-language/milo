<!-- doc-meta
system: safety-profiles
purpose: how to check code against a safety-critical coding standard (DO-178C, ISO 26262, NASA, IEC 61508, IEC 62304) with milo safety
key-files: src/safety.ts, src/main.ts
update-when: a profile is added or retuned, a constraint is added, or the milo safety CLI or its exit code changes
last-verified: 2026-11-04
-->

# Safety profiles

Safety-critical domains have coding standards that restrict what language features are allowed. Milo can check your code against the language-level rules of these standards at compile time.

A profile is a coding-standard check, not certification. Certifying software under DO-178C, ISO 26262 or IEC 61508 also takes requirements traceability, structural coverage, independent review and a qualified toolchain (DO-330, ISO 26262-8 tool confidence). The Milo compiler is not qualified under any of them. A passing profile is evidence for one objective in that process.

```bash
milo safety flight_controller.milo --safety=do178c-a
```

## The ladder: from an app to a certified one

Most programs are not chasing a standard. Two presets cover the first rungs, set once in
`milo.json` and read by `milo build` and `milo trace` when no `--safety` flag is given (the flag
wins, and `--safety=app` spells the same preset):

```json
{ "name": "myapp", "version": "0.1.0", "profile": "app" }
```

| Rung | `"profile"` | Adds |
|------|-------------|------|
| 1 | none | contracts, invariants and `@req` are checked where you write them; nothing is demanded |
| 2 | `app` | the requirements matrix (if the project has a `requirements.json`) is reported on every build; CI fails on new gaps with `--strict --baseline gaps.json`; no pinned toolchain, no object checks |
| 3 | `hardened` | `app`, plus every `prove --rte` failure (overflow, bounds, division) is a build error, and `unsafe` is banned outside std |
| 4 | `do178c-*`, `iso26262-*`, `nasa-*`, `iec61508-*`, `iec62304-*` | everything below: the full source rules, a pinned toolchain, the object checks, strict traceability |

The certification profiles keep all of it; a preset never weakens one. `milo safety --list`
prints the presets next to the profiles. Adopt `app` on an existing project by recording today's
gaps (`milo trace app.milo --write-baseline gaps.json`) and failing CI on anything new.

## Available profiles

```bash
milo safety --list
```

| Domain | Standard | Profiles | Governs |
|--------|----------|----------|---------|
| Avionics | DO-178C | `do178c-a`, `do178c-b`, `do178c-c` | Airborne software (DAL A–C) |
| Automotive | ISO 26262 | `iso26262-a` through `iso26262-d` | Vehicle ECUs, ADAS (ASIL A–D) |
| Spacecraft | NASA-STD-8739.8 | `nasa-a`, `nasa-b` | Flight software (Class A–B) |
| Industrial | IEC 61508 | `iec61508-3`, `iec61508-4` | Nuclear, rail signaling (SIL 3–4) |
| Medical | IEC 62304 | `iec62304-a`, `iec62304-b`, `iec62304-c` | Device software (Class A–C) |

## What gets checked

Each profile is a combination of constraints, tuned to the standard's requirements:

| Constraint | Description | Strictest at |
|------------|-------------|-------------|
| No recursion | Direct self-calls banned | DO-178C A, IEC 61508 SIL 4 |
| Bounded loops | `while` loops must have `invariant` clauses | DO-178C A, NASA A |
| No dynamic allocation | No Vec, String, HashMap construction | IEC 61508 SIL 4 |
| Require contracts | All functions need `requires`/`ensures` | DO-178C A, NASA A |
| No floating point | Integer-only arithmetic (no `f32`/`f64` in signatures, locals, casts, or literals) | IEC 61508 SIL 4 |
| No recursive types | Self-referential types banned even through `Heap<T>`: recursive data has unbounded traversal depth | DO-178C A, IEC 61508 SIL 4 |
| Max call depth | Longest static call chain bounded (call graph is a DAG since recursion is banned) | IEC 61508 SIL 4 (max 20) |
| Complexity limit | Cyclomatic complexity cap per function | IEC 61508 SIL 4 (max 15) |
| No unsafe blocks | `unsafe { }` banned entirely | All profiles |
| Full match coverage | All `match` arms required (enforced by the type checker's exhaustiveness pass) | Most profiles |
| Used results | A discarded `Option`, `Result` or `@mustUse` result (the `unused-result` warning) is an error | DO-178C A–C, NASA A–B |

The command exits nonzero and names the profile on every violation:

```
safety check failed: do178c-a, 4 violation(s)

  error: [do178c-a] function 'processInput' must have requires/ensures contracts
  error: [do178c-a] while loop in 'processInput' must have an invariant clause for bounded execution (line 3:5)
  error: [do178c-a] recursion detected: processInput -> processInput (banned at this safety level)
  error: [do178c-a] static call depth (unbounded) starting at 'processInput' exceeds max 30
```

## Integrating with CI

Add safety checking to your build pipeline:

```bash
milo safety src/controller.milo --safety=do178c-a || exit 1
```

The command exits with code 1 if any errors are found, making it suitable for CI gates.

## Requirements traceability: what a profile checks, how hard a build enforces it

Each profile carries two fields (`milo safety --list` prints them): `traceability`, which is
`strict` for every DO-178C, ISO 26262, IEC 61508 and NASA level and for IEC 62304 B and C
(bidirectional requirement traces are an objective there) and `report` for IEC 62304 A, and
`coverage`, the structural-coverage criterion the standard names (`statement`, `branch`, `mcdc`;
no gate reads it yet). A `strict` profile checks the `milo trace` matrix: a function with no
`@req`, a requirement with no implementation or no verification, a failing `@req` test, a clause
the prover cannot discharge. The profile says what is checked; the build decides how hard:

```bash
milo build app.milo --safety=iso26262-d                     # dev: every gap is a warning, the build succeeds
milo build app.milo --safety=iso26262-d --strict            # release: gaps are errors, @req tests are run
milo verify app.milo --profile iso26262-d                   # always strict
milo trace app.milo --write-baseline gaps.json              # record today's gaps
milo build app.milo --safety=iso26262-d --strict --baseline gaps.json
```

The profile's source rules (contracts, bounded loops, no allocation, ...) are errors in every mode.
Binary-check findings are warnings in a dev build and remove the binary under `--strict`.
A baselined gap stays a warning even under `--strict`; a gap that is not in the baseline fails. A
baseline only shrinks: `--write-baseline` refuses to add a gap to an existing file, and a baseline
entry whose gap has been fixed warns `remove it`. Verification follows DO-333: a low-level
requirement is verified by a fully `PROVEN` set of clauses or a passing test, a high-level one
(no parent) and one with no clause need a passing test of their own. The worked example is
[examples/assured/pid](https://github.com/milo-language/milo/tree/main/examples/assured/pid).

## Checked on the binary

A profile is also a claim about the program you ship, so the same profile is re-checked on
the linked binary. `--safety` on `build` fixes the toolchain (`-O2`, the milo-opt pass
pipeline, no LTO, one codegen unit, LLVM 23), writes that record into the binary, runs the
checks below on the result and deletes the binary if any fails:

```bash
milo build controller.milo --target=cortex-m3 --safety=do178c-a -o controller.elf
milo verify --profile do178c-a controller.elf     # any binary, any time; --json, --all
```

`verify` refuses a binary with no record, one built for another profile, or one whose
opt level, pass pipeline, LTO, codegen units or LLVM version differ from the pin. Then:

- **noDynamicAllocation**: no call path from `main` (or the reset handler) to `malloc`,
  `calloc`, `realloc`, `free`, `mmap` and friends. Each path is printed and labelled
  program or runtime.
- **noRecursion**: the object's call graph has no cycle (direct calls and tail jumps).
  Indirect calls have no static target; they are listed, and fail at DAL A, ASIL D, SIL 4
  and NASA A.
- **Runtime symbol allowlist**: any libc import (or libc shim the image defines) not on the
  profile's list fails. No-allocation profiles allow only the freestanding core, `printf`
  and `exit` for the fail-stop trap path, pure libm and compiler helpers.

A hosted binary (Linux, macOS) links the full Milo runtime: scheduler, replay heap, string and
Vec growth. It allocates and has indirect calls, so it fails `do178c-a`, and the report shows
where. A bare-metal image (`--target=cortex-m3`) has a bump allocator, no scheduler and no
libc, and `examples/embedded/pidStep.milo` passes. Limits: indirect tail jumps are not call
edges, a dynamic binary's libc is opaque, and the record is evidence of an honest build, not
tamper-proofing.
