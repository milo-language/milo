# Requirements-traced PID

A fixed-point PID controller where every function, contract clause and test is tied to a
requirement, and `milo trace` shows whether each requirement is implemented, proved and
tested. Based on [`examples/embedded/pidStep.milo`](../../embedded/pidStep.milo).

| File | What it is |
|---|---|
| `requirements.json` | two high-level (HLR), three low-level (LLR) and one derived (DR) requirement, with `parent` links |
| `pid.milo` | the controller; `@req(ID)` on fns, on contract clauses, and the `@derived` helper and harness |
| `pid_test.milo` | tests that verify requirements, tagged `@req(ID)` |
| `pid_bad_caller.milo` | one caller that breaks LLR-3, to show what a violation looks like |

Every command below was run from the repository root; the output is pasted as printed.
`milo prove` needs z3 installed (`brew install z3` / `apt install z3`). It decides every obligation here,
including the nonlinear `a * b` in `fpMul` (see [How the product is proved](#how-the-product-is-proved)).

## The syntax

```text
@req(LLR-3)                      // on a fn, struct or (as @!req(ID)) a file: implements LLR-3
pub fn fpMul(a: i32, b: i32): i32
@req(LLR-3)                      // before a clause: this clause formalizes LLR-3
requires a >= -1048576 && a <= 1048576
```

A `test*` fn tagged `@req(ID)` verifies ID. `@assume(ID)` marks a trusted axiom,
`@derived(ID)` code that exists for a derived requirement, and `@deactivated("reason")`
code that is present but not active. Run `milo explain @req` for the full text.

`main` and `demoCommand` are the demo harness, not an implementation of HLR-1 (the controller
is `controlTick`). They are tagged `@derived(DR-1)` rather than exempted from the "every fn has an
`@req`" rule: DO-178C treats a test harness as test code, and a blanket entry-point exemption
would also let a real flight entry point go untraced. A derived requirement is listed under
"derived (feed back to the system level)", which is where a reviewer wants to see it.

## How `milo prove --rte` found the overflow

The original `pidStep` has no preconditions on its inputs. `milo prove --rte` generates a
proof obligation for every arithmetic operation and asks whether it can overflow:

```text
$ milo prove examples/embedded/pidStep.milo --rte
verification: 23 conditions
  proven: 12  failed: 8  unknown: 3  errors: 0

  ✓ [overflow] fpMul (overflow in fpMul:22: CastExpr * CastExpr (i64)): proven
  ✓ [postcondition] fpMul: proven
  ✓ [postcondition] clampI32: proven
  ✗ [precondition] pidStep: failed — counterexample exists
  ✗ [precondition] pidStep: failed — counterexample exists
  ✗ [precondition] pidStep: failed — counterexample exists
  ✓ [precondition] pidStep: proven
  ✗ [overflow] pidStep (overflow in pidStep:45: setpoint - measured (i32)): failed — counterexample exists
  ✗ [overflow] pidStep (overflow in pidStep:46: integral + error (i32)): failed — counterexample exists
  ✗ [overflow] pidStep (overflow in pidStep:47: error - prevError (i32)): failed — counterexample exists
  ✗ [overflow] pidStep (overflow in pidStep:53: p + i (i32)): failed — counterexample exists
  ✗ [overflow] pidStep (overflow in pidStep:53: (p + i) + d (i32)): failed — counterexample exists
  ✓ [precondition] settle: proven
  ✓ [precondition] settle: proven
  ✓ [precondition] settle: proven
  ? [overflow] settle (overflow in settle:76: setpoint - measured (i32)): unknown — the value of 'measured' after the loop at line 73 (no invariant names it) is unconstrained, so any counterexample he
  ? [overflow] settle (overflow in settle:77: integral + (error >> 8) (i32)): unknown — the value of 'integral' after the loop at line 73 (no invariant names it), 'measured' after the loop at line 73 
  ✓ [overflow] settle (overflow in settle:77: 0 - iLimit (i32)): proven
  ? [overflow] settle (overflow in settle:79: measured + (cmd >> 8) (i32)): unknown — the value of 'measured' after the loop at line 73 (no invariant names it), 'pidStep(…)' after a call to 'pidStep' 
  ✓ [postcondition] settle: proven
  ✓ [precondition] main: proven
  ✓ [overflow] main (overflow in main:90: 100 * one (i32)): proven
  ✓ [overflow] main (overflow in main:95: 255 * one (i32)): proven
```

`setpoint - measured`, `integral + error` and the sum of the three terms each have a
counterexample: with unconstrained i32 inputs, `pidStep` can overflow. (`fpMul` is `unknown` here:
with no bound on either factor there is no interval to bound the product by.) That finding is
requirement LLR-3 (sensor and setpoint within +/-32767, gains within +/-16.0), written as
`requires` clauses on `pidStep` and `fpMul`, so every caller has to prove it. Rerunning with
the new `pid.milo` proves every obligation:

```text
$ milo prove examples/assured/pid/pid.milo --rte
verification: 32 conditions
  proven: 32  failed: 0  unknown: 0  errors: 0

  ✓ [overflow] fpMul (overflow in fpMul:22: CastExpr * CastExpr (i64)): proven
  ✓ [postcondition] fpMul: proven
  ✓ [postcondition] clampI32: proven
  ✓ [precondition] pidStep: proven
  ✓ [precondition] pidStep: proven
  ✓ [precondition] pidStep: proven
  ✓ [precondition] pidStep: proven
  ✓ [precondition] pidStep: proven
  ✓ [precondition] pidStep: proven
  ✓ [precondition] pidStep: proven
  ✓ [overflow] pidStep (overflow in pidStep:59: setpoint - measured (i32)): proven
  ✓ [overflow] pidStep (overflow in pidStep:60: integral + error (i32)): proven
  ✓ [overflow] pidStep (overflow in pidStep:61: error - prevError (i32)): proven
  ✓ [overflow] pidStep (overflow in pidStep:67: p + i (i32)): proven
  ✓ [overflow] pidStep (overflow in pidStep:67: (p + i) + d (i32)): proven
  ✓ [postcondition] pidStep: proven
  ✓ [precondition] nextIntegral: proven
  ✓ [overflow] nextIntegral (overflow in nextIntegral:79: integral + (error >> 8) (i32)): proven
  ✓ [postcondition] nextIntegral: proven
  ✓ [precondition] clampInput: proven
  ✓ [postcondition] clampInput: proven
  ✓ [precondition] controlTick: proven
  ✓ [precondition] controlTick: proven
  ✓ [precondition] controlTick: proven
  ✓ [precondition] controlTick: proven
  ✓ [precondition] controlTick: proven
  ✓ [precondition] controlTick: proven
  ✓ [overflow] controlTick (overflow in controlTick:100: 255 * one (i32)): proven
  ✓ [postcondition] controlTick: proven
  ✓ [precondition] demoCommand: proven
  ✓ [precondition] demoCommand: proven
  ✓ [postcondition] demoCommand: proven
```

## How the product is proved

`fpMul` multiplies two variables, which is nonlinear integer arithmetic. z3 decides it exactly, using the
bounds in the constraint set (the `requires` clauses, the type ranges); there is no interval
approximation in the translator. The gates are
`tests/prove/productIntervalProven.milo` (a true bound proves),
`tests/prove/productIntervalNoFalseProof.milo` (`|a*b| <= A*B - 1` is refuted, never proven) and
`tests/prove/productUnboundedFactor.milo`, plus `scripts/prove-soundness-fuzz.ts`.

## The trace matrix

`milo trace` also runs the tests: each `@req` test goes through `milo test`'s runner, one process
per test, and its row says `PASS` or `FAIL` (`--no-run` skips them and prints `NOT RUN`).

```text
$ milo trace examples/assured/pid/pid.milo --strict
requirements trace: examples/assured/pid/pid.milo  (examples/assured/pid/requirements.json, 6 requirements)

HLR-1  The actuator command shall always lie within the configured output range.
  implemented   pid.milo:92 controlTick
  formalized    PROVEN   pid.milo:97 ensures result >= 0 && result <= 16711680  [controlTick]
  verified      PASS      pid_test.milo:15 testStepOutputWithinRange

  LLR-1  Every command is clamped to [outLo, outHi] on its way out of the PID step.
    implemented   pid.milo:27 clampI32
    implemented   pid.milo:44 pidStep
    formalized    PROVEN   pid.milo:30 ensures result >= lo && result <= hi  [clampI32]
    formalized    PROVEN   pid.milo:57 ensures result >= outLo && result <= outHi  [pidStep]
    verified      PROOF     2 formalizing clauses PROVEN
    verified      PASS      pid_test.milo:7 testClampKeepsValueInRange
    verified      PASS      pid_test.milo:15 testStepOutputWithinRange

  LLR-3  Sensor and setpoint shall be within +/-32767 (gains within +/-16.0 in Q16.16), so no intermediate value overflows i32.
    implemented   pid.milo:13 fpMul
    implemented   pid.milo:83 clampInput  (derived)
    formalized    PROVEN   pid.milo:15 requires a >= -1048576 && a <= 1048576  [fpMul]
                call site PROVEN  pid.milo:63 pidStep
                call site PROVEN  pid.milo:64 pidStep
                call site PROVEN  pid.milo:65 pidStep
    formalized    PROVEN   pid.milo:17 requires b >= -2000000 && b <= 2000000  [fpMul]
                call site PROVEN  pid.milo:63 pidStep
                call site PROVEN  pid.milo:64 pidStep
                call site PROVEN  pid.milo:65 pidStep
    formalized    PROVEN   pid.milo:19 ensures result >= -33000000 && result <= 33000000  [fpMul]
    formalized    PROVEN   pid.milo:46 requires setpoint >= -32767 && setpoint <= 32767  [pidStep]
                call site PROVEN  pid.milo:100 controlTick
    formalized    PROVEN   pid.milo:48 requires measured >= -32767 && measured <= 32767  [pidStep]
                call site PROVEN  pid.milo:100 controlTick
    formalized    PROVEN   pid.milo:50 requires prevError >= -65534 && prevError <= 65534  [pidStep]
                call site PROVEN  pid.milo:100 controlTick
    formalized    PROVEN   pid.milo:52 requires kp >= -1048576 && kp <= 1048576 && ki >= -1048576 && ki <= 1048576 && kd >= -1048576 && kd <= 1048576  [pidStep]
                call site PROVEN  pid.milo:100 controlTick
    verified      PROOF     7 formalizing clauses PROVEN
    verified      PASS      pid_test.milo:36 testInputClampedToSensorRange

DR-1  The demo harness drives the controller from a fixed sensor reading and reports the command.
  implemented   pid.milo:106 demoCommand  (derived)
  implemented   pid.milo:114 main  (derived)
  verified      PASS      pid_test.milo:45 testHarnessDrivesController

HLR-2  The integral term shall not wind up: it shall stay within a fixed limit.
  implemented   (through LLR-2)
  verified      PASS      pid_test.milo:27 testIntegralDoesNotWindUp

  LLR-2  The integral accumulator is clamped to +/-1000000 after every tick.
    implemented   pid.milo:73 nextIntegral
    formalized    PROVEN   pid.milo:54 requires integral >= -1000000 && integral <= 1000000  [pidStep]
                call site PROVEN  pid.milo:100 controlTick
    formalized    PROVEN   pid.milo:77 ensures result >= -1000000 && result <= 1000000  [nextIntegral]
    formalized    PROVEN   pid.milo:94 requires integral >= -1000000 && integral <= 1000000  [controlTick]
                call site PROVEN  pid.milo:109 demoCommand
    verified      PROOF     3 formalizing clauses PROVEN
    verified      PASS      pid_test.milo:27 testIntegralDoesNotWindUp

untraced fns: none
requirements with no implementation: none
requirements with no verifying test: none
derived (feed back to the system level):
  pid.milo:83 clampInput
  pid.milo:106 demoCommand
  pid.milo:114 main
unknown: 0

strict: ok
```

Reading it: a parent (`HLR-1`) is implemented through its children, so it needs no code of its
own. Each `formalized` row is a contract clause tagged `@req`, with the verdict `milo prove`
gives that exact clause. A `requires` clause is judged at every call site, with the line
of the call. `unknown: 0` counts formalizing clauses the prover could not decide.

How a requirement counts as verified follows DO-333 (the formal-methods supplement):

- a low-level requirement (one with a parent) is verified by a `PROOF` row, meaning it has
  formalizing clauses and every one is `PROVEN`, or by a passing test;
- a high-level requirement (no parent) needs a passing test of its own, even when all its
  children are proven: a proof checks code against the spec, not that the spec is right or that
  the binary behaves on target;
- a requirement with no formalizing clause must be tested.

A failing test is a strict error, and a requirement whose only tests fail is unverified.

## A caller that breaks LLR-3

`pid_bad_caller.milo` passes a raw sensor value straight to `pidStep`:

```text
return pidStep(100, rawSensor, one / 2, one / 100, one / 10, integral, prevError, 0, 255 * one)
```

```text
$ milo trace examples/assured/pid/pid_bad_caller.milo --strict
requirements trace: examples/assured/pid/pid_bad_caller.milo  (examples/assured/pid/requirements.json, 6 requirements)
  ...
  LLR-3  Sensor and setpoint shall be within +/-32767 (gains within +/-16.0 in Q16.16), so no intermediate value overflows i32.
    implemented   pid.milo:13 fpMul
    implemented   pid.milo:83 clampInput  (derived)
    formalized    PROVEN   pid.milo:15 requires a >= -1048576 && a <= 1048576  [fpMul]
                call site PROVEN  pid.milo:63 pidStep
                call site PROVEN  pid.milo:64 pidStep
                call site PROVEN  pid.milo:65 pidStep
    formalized    PROVEN   pid.milo:17 requires b >= -2000000 && b <= 2000000  [fpMul]
                call site PROVEN  pid.milo:63 pidStep
                call site PROVEN  pid.milo:64 pidStep
                call site PROVEN  pid.milo:65 pidStep
    formalized    PROVEN   pid.milo:19 ensures result >= -33000000 && result <= 33000000  [fpMul]
    formalized    PROVEN   pid.milo:46 requires setpoint >= -32767 && setpoint <= 32767  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:100 controlTick
    formalized    FAILED   pid.milo:48 requires measured >= -32767 && measured <= 32767  [pidStep]
                        counterexample: rawSensor = 32768, integral = 0, prevError = 0, pidStep__ret0 = 0
                call site FAILED  pid_bad_caller.milo:12 controlTickUnclamped  counterexample: rawSensor = 32768, integral = 0, prevError = 0, pidStep__ret0 = 0
                call site PROVEN  pid.milo:100 controlTick
    formalized    PROVEN   pid.milo:50 requires prevError >= -65534 && prevError <= 65534  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:100 controlTick
    formalized    PROVEN   pid.milo:52 requires kp >= -1048576 && kp <= 1048576 && ki >= -1048576 && ki <= 1048576 && kd >= -1048576 && kd <= 1048576  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:100 controlTick
    verified      PASS      pid_test.milo:36 testInputClampedToSensorRange

...
strict: 1 failure
  error: pid_bad_caller.milo:12: call from 'controlTickUnclamped' violates LLR-3: requires clause of 'pidStep' (counterexample: rawSensor = 32768, integral = 0, prevError = 0, pidStep__ret0 = 0)
exit 1
```

The clause `requires measured >= -32767 && measured <= 32767` is `FAILED` at exactly one
call site, `pid_bad_caller.milo:12`, with a concrete counterexample, and strict mode turns it
into an error (exit 1).

The fix is `controlTick` in `pid.milo`: it clamps the reading with `clampInput` first, and the
same call site is then `PROVEN` (see `pid.milo:98` in the matrix above).

## Dev, strict and baseline: what a profile checks vs how hard it enforces

A safety profile (`milo safety --list`) says WHAT is checked. Two of its fields matter here:
`traceability` (`strict` for every DO-178C, ISO 26262, IEC 61508 and NASA level and IEC 62304
B and C; `report` for IEC 62304 A) and `coverage` (the structural-coverage criterion the standard
names; no gate reads it yet). How hard a build enforces it is the build's choice:

- **dev** (`milo build --safety=<profile>`): every traceability gap and every binary-check finding
  is a warning and the build succeeds. Tests are not run, so a dev build stays fast.
- **release / CI** (`--strict`, and `milo verify` always): the same gaps are errors, the `@req`
  tests are run, and a binary-check finding removes the binary.
- **adoption** (`--baseline <file>`): gaps listed in the baseline stay warnings even under
  `--strict`; a new gap fails. A baseline only ever shrinks: `milo trace --write-baseline`
  refuses to add a gap to an existing file, and a baseline entry for a gap that has been fixed
  warns `remove it`.

```text
$ milo build examples/assured/pid/pid.milo --safety=do178c-a --target=cortex-m3 -o pid.elf
warning: @cLayout/@cSig guards skipped — a bare-metal target is freestanding, so the host's headers don't describe it
compiled examples/assured/pid/pid.milo -> /tmp/q/pid.elf in 919ms
/tmp/q/pid.elf against do178c-a
  pinned build: -O2, none LTO, 1 codegen unit, LLVM 23, milo-opt 44127db147cd
  10 defined symbols, 0 imports, 0 indirect call sites, 0 runtime allocation paths
binary check passed
$ milo verify examples/assured/pid/pid.milo --profile do178c-a
profile do178c-a: ok
requirements: ok (6 requirements, 0 unknown)
proofs (prove --rte): 32 proven, 0 failed, 0 unknown
verify: PASS
```

`build --safety` runs the profile's rules (no recursion, bounded loops, no allocation,
contracts on every public fn, ...), which stay errors, then the traceability check, then
re-checks the linked binary. On the bad caller the dev build warns and succeeds:

```text
$ milo build examples/assured/pid/pid_bad_caller.milo --safety=do178c-a --target=cortex-m3 -o bad.elf
warning: traceability gap: pid_bad_caller.milo:12: call from 'controlTickUnclamped' violates LLR-3: requires clause of 'pidStep' (counterexample: rawSensor = 32768, integral = 0, prevError = 0, pidStep__ret0 = 0)
warning: 1 traceability gap(s) under --safety=do178c-a; --strict makes these errors
warning: @cLayout/@cSig guards skipped — a bare-metal target is freestanding, so the host's headers don't describe it
compiled examples/assured/pid/pid_bad_caller.milo -> /tmp/q/bad.elf in 654ms
/tmp/q/bad.elf against do178c-a
  pinned build: -O2, none LTO, 1 codegen unit, LLVM 23, milo-opt 44127db147cd
  10 defined symbols, 0 imports, 0 indirect call sites, 0 runtime allocation paths
binary check passed
```

`--strict` is the release gate:

```text
$ milo build examples/assured/pid/pid_bad_caller.milo --safety=do178c-a --target=cortex-m3 --strict -o bad.elf
  ...
strict: 1 failure
  error: pid_bad_caller.milo:12: call from 'controlTickUnclamped' violates LLR-3: requires clause of 'pidStep' (counterexample: rawSensor = 32768, integral = 0, prevError = 0, pidStep__ret0 = 0)
error: 1 traceability failure(s) under --safety=do178c-a
exit 1
```

To adopt a profile on code that is not clean yet, record today's gaps and enforce that none are
added:

```text
$ milo trace examples/assured/pid/pid_bad_caller.milo --write-baseline baseline.json
baseline: 1 gap(s) written to /tmp/q/out/baseline.json
$ cat baseline.json
{
  "schema": 1,
  "gaps": [
    "call-site:LLR-3|pidStep|requires|requires measured >= -32767 && measured <= 32767|controlTickUnclamped"
  ]
}
$ milo build examples/assured/pid/pid_bad_caller.milo --safety=do178c-a --target=cortex-m3 --strict --baseline baseline.json -o bad.elf
warning: baselined traceability gap: pid_bad_caller.milo:12: call from 'controlTickUnclamped' violates LLR-3: requires clause of 'pidStep' (counterexample: rawSensor = 32768, integral = 0, prevError = 0, pidStep__ret0 = 0)
warning: @cLayout/@cSig guards skipped — a bare-metal target is freestanding, so the host's headers don't describe it
compiled examples/assured/pid/pid_bad_caller.milo -> /tmp/q/bad.elf in 903ms
/tmp/q/bad.elf against do178c-a
  pinned build: -O2, none LTO, 1 codegen unit, LLVM 23, milo-opt 44127db147cd
  10 defined symbols, 0 imports, 0 indirect call sites, 0 runtime allocation paths
binary check passed
```

The keys name a gap (`untraced:<fn>`, `no-verifying-test:<id>`, `clause-unknown:...`,
`call-site:...`, `test-failed:<test>`), not a line number, so editing nearby code does not
invalidate the baseline.

## Not covered yet

Line and branch coverage of the implementing fns by the verifying tests is a later task; the
profile's `coverage` field records which criterion the standard asks for.
