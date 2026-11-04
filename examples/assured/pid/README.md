# Requirements-traced PID

A fixed-point PID controller where every function, contract clause and test is tied to a
requirement, and `milo trace` shows whether each requirement is implemented, proved and
tested. Based on [`examples/embedded/pidStep.milo`](../../embedded/pidStep.milo).

| File | What it is |
|---|---|
| `requirements.json` | two high-level (HLR) and three low-level (LLR) requirements, with `parent` links |
| `pid.milo` | the controller; `@req(ID)` on fns, on contract clauses, and one `@derived` helper |
| `pid_test.milo` | tests that verify requirements, tagged `@req(ID)` |
| `pid_bad_caller.milo` | one caller that breaks LLR-3, to show what a violation looks like |

Every command below was run from the repository root; the output is pasted as printed.
The proofs here are nonlinear (`a * b`), which the default `std/smt` solver reports as
`unknown`, so the commands pass `--solver=z3`.

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

## How `milo prove --rte` found the overflow

The original `pidStep` has no preconditions on its inputs. `milo prove --rte` generates a
proof obligation for every arithmetic operation and asks whether it can overflow:

```text
$ milo prove examples/embedded/pidStep.milo --rte --solver=z3
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
  ? [overflow] settle (overflow in settle:76: setpoint - measured (i32)): unknown — the value of 'measured' after the loop at line 73 (no invariant names it) is unconstrained, so any counterexample here is not reproducible
  ? [overflow] settle (overflow in settle:77: integral + (error >> 8) (i32)): unknown — the value of 'integral' after the loop at line 73 (no invariant names it), 'measured' after the loop at line 73 (no invariant names it) is unconstrained, so any counterexample here is not reproducible
  ✓ [overflow] settle (overflow in settle:77: 0 - iLimit (i32)): proven
  ? [overflow] settle (overflow in settle:79: measured + (cmd >> 8) (i32)): unknown — the value of 'measured' after the loop at line 73 (no invariant names it), 'pidStep(…)' after a call to 'pidStep' (it declares no 'ensures' to model its result by) is unconstrained, so any counterexample here is not reproducible
  ✓ [postcondition] settle: proven
  ✓ [precondition] main: proven
  ✓ [overflow] main (overflow in main:90: 100 * one (i32)): proven
  ✓ [overflow] main (overflow in main:95: 255 * one (i32)): proven
```

`setpoint - measured`, `integral + error` and the sum of the three terms each have a
counterexample: with unconstrained i32 inputs, `pidStep` can overflow. That finding is
requirement LLR-3 (sensor and setpoint within +/-32767, gains within +/-16.0), written as
`requires` clauses on `pidStep` and `fpMul`, so every caller has to prove it. Rerunning with
the new `pid.milo` proves all 30 obligations:

```text
$ milo prove examples/assured/pid/pid.milo --rte --solver=z3
verification: 30 conditions
  proven: 30  failed: 0  unknown: 0  errors: 0

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
  ✓ [overflow] controlTick (overflow in controlTick:98: 255 * one (i32)): proven
  ✓ [precondition] main: proven
  ✓ [precondition] main: proven
```

## The trace matrix

```text
$ milo trace examples/assured/pid/pid.milo --solver=z3 --strict
requirements trace: examples/assured/pid/pid.milo  (examples/assured/pid/requirements.json, 5 requirements)

HLR-1  The actuator command shall always lie within the configured output range.
  implemented   pid.milo:92 controlTick
  implemented   pid.milo:102 main
  verified      pid_test.milo:15 testStepOutputWithinRange

  LLR-1  Every command is clamped to [outLo, outHi] on its way out of the PID step.
    implemented   pid.milo:27 clampI32
    implemented   pid.milo:44 pidStep
    formalized    PROVEN   pid.milo:30 ensures result >= lo && result <= hi  [clampI32]
    formalized    PROVEN   pid.milo:57 ensures result >= outLo && result <= outHi  [pidStep]
    verified      pid_test.milo:7 testClampKeepsValueInRange
    verified      pid_test.milo:15 testStepOutputWithinRange

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
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:48 requires measured >= -32767 && measured <= 32767  [pidStep]
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:50 requires prevError >= -65534 && prevError <= 65534  [pidStep]
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:52 requires kp >= -1048576 && kp <= 1048576 && ki >= -1048576 && ki <= 1048576 && kd >= -1048576 && kd <= 1048576  [pidStep]
                call site PROVEN  pid.milo:98 controlTick
    verified      pid_test.milo:35 testInputClampedToSensorRange

HLR-2  The integral term shall not wind up: it shall stay within a fixed limit.
  implemented   (through LLR-2)
  verified      (through LLR-2)

  LLR-2  The integral accumulator is clamped to +/-1000000 after every tick.
    implemented   pid.milo:73 nextIntegral
    formalized    PROVEN   pid.milo:54 requires integral >= -1000000 && integral <= 1000000  [pidStep]
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:77 ensures result >= -1000000 && result <= 1000000  [nextIntegral]
    formalized    PROVEN   pid.milo:94 requires integral >= -1000000 && integral <= 1000000  [controlTick]
                call site PROVEN  pid.milo:103 main
    verified      pid_test.milo:26 testIntegralDoesNotWindUp

untraced fns: none
requirements with no implementation: none
requirements with no verifying test: none
derived (feed back to the system level):
  pid.milo:83 clampInput
unknown: 0

strict: ok
```

Reading it: a parent (`HLR-1`) is traced through its children, so it needs no code of its
own. Each `formalized` row is a contract clause tagged `@req`, with the verdict `milo prove`
gives that exact clause. A `requires` clause is judged at every call site, with the line
of the call. `unknown: 0` counts formalizing clauses the prover could not decide.

## A caller that breaks LLR-3

`pid_bad_caller.milo` passes a raw sensor value straight to `pidStep`:

```text
return pidStep(100, rawSensor, one / 2, one / 100, one / 10, integral, prevError, 0, 255 * one)
```

```text
$ milo trace examples/assured/pid/pid_bad_caller.milo --solver=z3 --strict
requirements trace: examples/assured/pid/pid_bad_caller.milo  (examples/assured/pid/requirements.json, 5 requirements)
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
                call site PROVEN  pid.milo:98 controlTick
    formalized    FAILED   pid.milo:48 requires measured >= -32767 && measured <= 32767  [pidStep]
                        counterexample exists
                call site FAILED  pid_bad_caller.milo:12 controlTickUnclamped  counterexample exists
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:50 requires prevError >= -65534 && prevError <= 65534  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:52 requires kp >= -1048576 && kp <= 1048576 && ki >= -1048576 && ki <= 1048576 && kd >= -1048576 && kd <= 1048576  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:98 controlTick
    verified      pid_test.milo:35 testInputClampedToSensorRange
...
strict: 1 failure
  error: pid_bad_caller.milo:12: call from 'controlTickUnclamped' violates LLR-3: requires clause of 'pidStep' (counterexample exists)
exit 1
```

The clause `requires measured >= -32767 && measured <= 32767` is `FAILED` at exactly one
call site, `pid_bad_caller.milo:12`, and strict mode turns it into an error (exit 1).

The fix is `controlTick` in `pid.milo`: it clamps the reading with `clampInput` first, and the
same call site is then `PROVEN` (see `pid.milo:98` in the matrix above).

## Strict mode and the DO-178C profile

Without a profile the matrix is a report and exits 0. `--strict`, or a DO-178C `--safety`
profile, makes these errors: a fn with no `@req` (`@derived` and `@deactivated` are
exempt), a requirement with no implementation or no verifying test, and a formalizing
clause that is `FAILED` or `UNKNOWN`. A law must be `PROVEN`, `@req`-tested or `@assume`d;
`UNKNOWN` fails otherwise. An `UNKNOWN` clause
prints as `UNKNOWN (tested)` or `UNKNOWN (assumed)` when one of those stands behind it.

```text
$ milo build examples/assured/pid/pid.milo --safety=do178c-a --target=cortex-m3 --solver=z3 -o pid.elf
warning: @cLayout/@cSig guards skipped — a bare-metal target is freestanding, so the host's headers don't describe it
compiled examples/assured/pid/pid.milo -> pid.elf in 2.69s
$ milo verify examples/assured/pid/pid.milo --profile do178c-a --solver=z3
profile do178c-a: ok
requirements: ok (5 requirements, 0 unknown)
proofs (prove --rte): 30 proven, 0 failed, 0 unknown
verify: PASS
```

`build --safety` runs the profile's rules (no recursion, bounded loops, no allocation,
contracts on every public fn, ...) and, for a DO-178C profile, the strict matrix. The same
build on the bad caller stops:

```text
$ milo build examples/assured/pid/pid_bad_caller.milo --safety=do178c-a --target=cortex-m3 --solver=z3
requirements trace: examples/assured/pid/pid_bad_caller.milo  (examples/assured/pid/requirements.json, 5 requirements)

HLR-1  The actuator command shall always lie within the configured output range.
  implemented   pid_bad_caller.milo:7 controlTickUnclamped
  implemented   pid.milo:92 controlTick
  verified      pid_test.milo:15 testStepOutputWithinRange

  LLR-1  Every command is clamped to [outLo, outHi] on its way out of the PID step.
    implemented   pid.milo:27 clampI32
    implemented   pid.milo:44 pidStep
    formalized    PROVEN   pid.milo:30 ensures result >= lo && result <= hi  [clampI32]
    formalized    PROVEN   pid.milo:57 ensures result >= outLo && result <= outHi  [pidStep]
    verified      pid_test.milo:7 testClampKeepsValueInRange
    verified      pid_test.milo:15 testStepOutputWithinRange

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
                call site PROVEN  pid.milo:98 controlTick
    formalized    FAILED   pid.milo:48 requires measured >= -32767 && measured <= 32767  [pidStep]
                        counterexample exists
                call site FAILED  pid_bad_caller.milo:12 controlTickUnclamped  counterexample exists
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:50 requires prevError >= -65534 && prevError <= 65534  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:52 requires kp >= -1048576 && kp <= 1048576 && ki >= -1048576 && ki <= 1048576 && kd >= -1048576 && kd <= 1048576  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:98 controlTick
    verified      pid_test.milo:35 testInputClampedToSensorRange

HLR-2  The integral term shall not wind up: it shall stay within a fixed limit.
  implemented   (through LLR-2)
  verified      (through LLR-2)

  LLR-2  The integral accumulator is clamped to +/-1000000 after every tick.
    implemented   pid.milo:73 nextIntegral
    formalized    PROVEN   pid.milo:54 requires integral >= -1000000 && integral <= 1000000  [pidStep]
                call site PROVEN  pid_bad_caller.milo:12 controlTickUnclamped
                call site PROVEN  pid.milo:98 controlTick
    formalized    PROVEN   pid.milo:77 ensures result >= -1000000 && result <= 1000000  [nextIntegral]
    formalized    UNKNOWN (tested) pid.milo:94 requires integral >= -1000000 && integral <= 1000000  [controlTick]
                        no call site in the program: callers outside it are unchecked
    verified      pid_test.milo:26 testIntegralDoesNotWindUp

untraced fns: none
requirements with no implementation: none
requirements with no verifying test: none
derived (feed back to the system level):
  pid.milo:83 clampInput
unknown: 1

strict: 1 failure
  error: pid_bad_caller.milo:12: call from 'controlTickUnclamped' violates LLR-3: requires clause of 'pidStep' (counterexample exists)
error: 1 traceability failure(s) under --safety=do178c-a
exit 1
```

## Not covered yet

Tests are traced, not run: `milo trace` checks that a `@req` test exists, and
`milo test examples/assured/pid` runs it. Line and branch coverage of the implementing fns by
the verifying tests is a later task.
