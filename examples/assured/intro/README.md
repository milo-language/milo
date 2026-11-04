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

`main` is only the demo harness, so it is `@derived(R-1)`: code that is needed but isn't the
requirement itself.

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

untraced fns: none
requirements with no verifying test: none
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

## Where to go next

- Without `--strict`, gaps are warnings: use that while developing.
- `"profile": "app"` in `milo.json` turns this on for a whole project; see
  [safety profiles](../../../docs/site/language/safety-profiles.md).
- [../pid](../pid): requirement hierarchy (HLR/LLR), call sites that break a requirement, and the
  binary traced back to these lines.
