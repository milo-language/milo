# Requirements in Milo: the short version

One function, two requirements, one test file. For the full DO-178C walkthrough (requirement
hierarchy, a Cortex-M3 binary traced to the byte), see [../pid](../pid).

## 1. Write down what the code must do

[`requirements.json`](requirements.json), in plain English:

```json
{ "id": "R-1", "text": "The heater command is always between 0 and 100 percent." },
{ "id": "R-2", "text": "A reading at or above the target turns the heater off." }
```

## 2. Link the code to it

In [`heater.milo`](heater.milo), `@req(ID)` says which requirement a piece of code is for. On a
function it means "implements"; on a contract clause it means "this clause is the requirement,
stated precisely":

```milo
@req(R-1)
@req(R-2)
pub fn heaterPercent(reading: i32, target: i32): i32
    requires reading >= -1000 && reading <= 2000
    requires target >= 0 && target <= 1000
    @req(R-1) ensures result >= 0 && result <= 100
    @req(R-2) ensures reading >= target ==> result == 0
```

`main` is only the demo harness. It traces to `D-1`, a **derived** requirement: behaviour the
implementation needs that no higher requirement asked for. Derived requirements are written
down like any other, so they can be reviewed at the system level; the trace lists them separately.

## 3. Test it

In [`heater_test.milo`](heater_test.milo), the same `@req(ID)` on a test function means "this test
verifies R-1". A function is a test when it is named `test*` in a `*_test.milo` file, the rule
`milo test` uses.

```milo
@req(R-1)
fn testCommandStaysInRange() {
    assert(heaterPercent(-1000, 1000) == 100)
}
```

## 4. Check the whole chain

```text
$ milo trace examples/assured/intro/heater.milo --strict
R-1  The heater command is always between 0 and 100 percent.
  implemented   heater.milo:6 heaterPercent
  formalized    PROVEN   heater.milo:9 @req(R-1) ensures result >= 0 && result <= 100  [heaterPercent]
  verified      PASS      heater_test.milo:4 testCommandStaysInRange

R-2  A reading at or above the target turns the heater off.
  implemented   heater.milo:6 heaterPercent
  formalized    PROVEN   heater.milo:10 @req(R-2) ensures reading >= target ==> result == 0  [heaterPercent]
  verified      PASS      heater_test.milo:10 testAtTargetTurnsOff

D-1  Derived: a demo entry point prints one heater command. Not part of the controller.
  implemented   heater.milo:24 demoCommand  (derived)
  implemented   heater.milo:29 main  (derived)
  verified      PASS      heater_test.milo:16 testDemoPrintsHalfPower

untraced fns: none
requirements with no implementation: none
requirements with no verifying test: none
derived (feed back to the system level):
  heater.milo:24 demoCommand
  heater.milo:29 main
dead branches: none
unknown: 0

strict: ok
```

Every requirement is implemented, **proven** for every input (by z3), and tested.

## 5. Break it

Change the saturation `return 100` to `return gap`, so a large gap returns more than 100:

```text
$ milo trace heater.milo --strict
R-1  The heater command is always between 0 and 100 percent.
  formalized    FAILED   heater.milo:9 @req(R-1) ensures result >= 0 && result <= 100  [heaterPercent]
strict: 3 failures
  error: requirement R-1 is not verified: its verifying test fails (testCommandStaysInRange)
```

The proof fails (there is an input that breaks R-1) and the test fails too, and the report says
which requirement broke, not just which line.

## 6. Lock the spec

Code may change freely; intent may not change silently. `milo spec heater.milo` prints the intent
surface (every requirement, contract clause and invariant, with its `@req`), and
`milo spec --diff <git-ref> heater.milo` compares it with the spec at a ref. Additions and
strengthenings pass; removals, requirement text changes and weakenings need a sign-off.

Weaken R-1's `ensures` to `result >= 0` (drop the upper bound) and diff against the last commit:

```text
$ milo spec --diff HEAD heater.milo
spec diff against HEAD: 1 change
  NEEDS SIGN-OFF: clause weakened: heater.milo:heaterPercent ensures @R-1  [hash 753e36230c02]
      was: result >= 0 && result <= 100
      now: result >= 0
      weakened: an outcome the new contract allows and the old one forbade
      counterexample: result = 101, target = 0, reading = 0
1 change needs sign-off in spec-signoff.json
```

z3 found an outcome (101) the old contract forbade and the new one allows. Now strengthen instead
(`result >= 0 && result <= 80`):

```text
$ milo spec --diff HEAD heater.milo
spec diff against HEAD: 1 change
  ok: clause strengthened: heater.milo:heaterPercent ensures @R-1  [hash 1256feec3787]
      was: result >= 0 && result <= 100
      now: result >= 0 && result <= 80
      new implies old under the old requires
spec lock: ok
```

A human accepts a weakening by adding it to `spec-signoff.json` beside `requirements.json`, with the
id and hash the diff printed:

```json
{ "signoffs": [{ "id": "heater.milo:heaterPercent ensures @R-1", "hash": "753e36230c02", "who": "cs", "why": "the actuator clamps at 100" }] }
```

In CI, `milo trace heater.milo --strict --spec-base <merge-base>` (and strict builds given the same
flag) fails on any unsigned change. Without `--spec-base` nothing changes. Review edits to
`spec-signoff.json` like any change to the requirements.

## 7. Test it independently

Tests written by whoever wrote the code tend to mirror it. `milo spec --packet` writes everything a
separate test author may see and nothing else: `requirements.json`, and a stub of each source file
with declarations, signatures and contracts kept and every body replaced by `todo`.

```text
$ milo spec --packet /tmp/packet heater.milo
/tmp/packet: 3 files
$ milo check /tmp/packet/heater.milo
/tmp/packet/heater.milo: ok
```

Private functions, `main` and comments are gone. The author writes `@req` tests against the
requirement text and the contracts, type-checks them there, and drops them into the real project. A
non-empty output directory is refused.

## Where to go next

- Without `--strict`, gaps are warnings: use that while developing.
- `"profile": "app"` in `milo.json` turns this on for a whole project; see
  [safety profiles](../../../docs/site/language/safety-profiles.md).
- [../pid](../pid): requirement hierarchy (HLR/LLR), call sites that break a requirement, and the
  binary traced back to these lines.
