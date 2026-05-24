# Contracts & Safety

Milo lets you write down what your functions promise — and then prove it.

- **Contracts** (`requires`, `ensures`, `invariant`) are annotations that say what a function expects, what it guarantees, and what stays true inside loops. The compiler type-checks them alongside your code — no separate annotation language, no external tool needed just to write them.
- **Safety profiles** enforce coding standards from domains like avionics (DO-178C), automotive (ISO 26262), and medical devices (IEC 62304) — as compiler flags, not expensive third-party tools.

A few things worth knowing up front:

- **Zero runtime cost.** Contracts are checked for well-formedness at compile time but never inserted into the binary.
- **Proving is separate.** The compiler catches ill-formed contracts (type errors, bad references). To verify contracts actually *hold*, run `milo verify` to export SMT-LIB2 and pipe it to a solver like [Z3](https://github.com/Z3Prover/z3). This is the same architecture used by SPARK/Ada and Dafny.
- **Ownership already covers memory safety.** Contracts extend that to *logic errors* — the class of bugs that use-after-free protection can't catch.

## Why types aren't enough

Types catch a lot — you can't pass a `String` where an `i64` is expected. But they can't express *value* constraints. Consider a square root function:

```milo
fn sqrt(n: f64): f64 {
    // ...
}
```

The type system says `n` is an `f64`. It doesn't say `n` must be non-negative — so a caller can pass `-1.0` and get garbage (or a panic) at runtime. That's a logic error hiding behind a perfectly valid type signature.

With a contract, the constraint is explicit and compiler-checked:

```milo
fn sqrt(n: f64): f64
  requires n >= 0.0
  ensures result >= 0.0
{
    // ...
}
```

`result` is a special keyword in `ensures` clauses — it refers to the return value of the function.

Now anyone reading this function knows exactly what it needs and what it promises.

But wait — what about runtime values? If `n` comes from a sensor reading, nobody can prove it's non-negative at compile time. That's not what verification does. What `milo verify` + Z3 actually checks is the *chain of proof obligations*: if you call `sqrt(sensorValue)` without first checking `sensorValue >= 0.0`, the verifier flags it. You still write a runtime check at the boundary where unknown data enters — the proof just guarantees you never forgot one.

```milo
fn processSensor(raw: f64): f64 {
    if raw < 0.0 {
        return 0.0           // handle the bad case
    }
    return sqrt(raw)          // verifier knows raw >= 0.0 here
}
```

This is the gap contracts fill: **types describe the shape of data, contracts describe the rules about values.** Milo's ownership system prevents memory bugs (use-after-free, data races, null dereferences). Contracts extend that to logic errors — the bugs that memory safety alone can't catch, and that runtime checks alone can't guarantee you remembered everywhere.

## Why an SMT solver?

The compiler checks that contracts are **well-typed** — every `requires`, `ensures`, and `invariant` must be a valid `bool` expression using in-scope variables. That's a syntactic and type-level check, similar to how the compiler rejects `let x: i64 = "hello"`.

But type-checking a contract doesn't tell you whether it *holds*. Consider:

```milo
fn clamp(value: i64, lo: i64, hi: i64): i64
  requires lo <= hi
  ensures result >= lo && result <= hi
{ ... }
```

The compiler confirms `lo <= hi` is a valid boolean expression over `i64` parameters. It does **not** analyze callers to verify they always pass `lo <= hi`, nor does it trace the function body to prove the postcondition. Those are *semantic* properties that require reasoning about values, paths, and arithmetic — exactly what SMT solvers are designed for.

`milo verify` bridges the gap: it translates your contracts into SMT-LIB2 formulas that encode the question "can this contract be violated?" If Z3 answers `unsat`, no violation is possible. If it answers `sat`, there's a concrete counterexample. This is the same architecture used by SPARK/Ada and Dafny — contracts live in the source, proofs run externally.

**In short:** the compiler catches *ill-formed* contracts (type errors, unknown variables). The SMT solver catches *violated* contracts (logic errors, missed edge cases). Both are needed.

## WCET analysis

Worst-Case Execution Time (WCET) analysis determines the maximum time a function can take to execute — a hard requirement for real-time systems like flight controllers, ABS brakes, and pacemakers. Missing a deadline in these systems is as bad as computing the wrong answer.

WCET analysis tools need to bound every execution path, which means the code must satisfy structural constraints: no unbounded loops, no recursion, no dynamic allocation (which has unpredictable latency), and bounded complexity. These are exactly the constraints that Milo's safety profiles enforce.

When you compile with `--safety=do178c-a` or `--safety=iec61508-4`:

- **No recursion** → call graph is a DAG, so execution time is statically bounded
- **Bounded loops** → every `while` loop has an `invariant`, providing the foundation for iteration bounds
- **No dynamic allocation** → no heap allocator jitter, no GC pauses
- **Complexity limits** → functions stay small enough for path enumeration

This means code that passes `milo safety` is structurally ready for WCET analysis by tools like [aiT](https://www.absint.com/ait/) or [Bound-T](https://www.bound-t.com/). Without these constraints, WCET tools must either reject the code or produce pessimistic bounds that overestimate timing by orders of magnitude.

Contracts add further value: a `requires` clause like `requires n <= 1000` gives WCET tools an explicit bound on input ranges, tightening the analysis. Combined with the safety profile's structural guarantees, you get a codebase that is both *provably correct* (via SMT) and *provably timely* (via WCET).

---

## Contracts

Three keywords: `requires` (precondition), `ensures` (postcondition), and `invariant` (loop invariant). Each takes a boolean expression.

### Preconditions — `requires`

State what must be true when a function is called:

```milo
fn clamp(value: i64, lo: i64, hi: i64): i64
  requires lo <= hi
{
    if value < lo { return lo }
    if value > hi { return hi }
    return value
}
```

Multiple `requires` clauses are allowed — all must hold:

```milo
fn divide(a: i64, b: i64): i64
  requires b != 0
  requires a >= 0
{
    return a / b
}
```

### Postconditions — `ensures`

State what the function guarantees about its return value. The special variable `result` refers to the return value:

```milo
fn clamp(value: i64, lo: i64, hi: i64): i64
  requires lo <= hi
  ensures result >= lo && result <= hi
{
    if value < lo { return lo }
    if value > hi { return hi }
    return value
}
```

### Loop invariants — `invariant`

State what remains true across every iteration of a loop:

```milo
fn sumTo(n: i64): i64
  requires n >= 0
  ensures result >= 0
{
    var total: i64 = 0
    var i: i64 = 1
    while i <= n
      invariant total >= 0
      invariant i >= 1
    {
        total = total + i
        i = i + 1
    }
    return total
}
```

### What the compiler checks

The compiler type-checks contract expressions — every `requires`, `ensures`, and `invariant` must evaluate to `bool`. Non-boolean expressions are rejected at compile time:

```
error: requires clause must be bool, got i64
  --> example.milo:2:12
  |
2 |   requires x + 1
  |            ^^^^^
```

Note: the compiler does **not** verify that contracts hold — it only checks that they are well-typed. To prove correctness, export verification conditions with `milo verify` and check them with an SMT solver (see below).

## Verification condition export — `milo verify`

The `verify` command translates contracts into [SMT-LIB2](https://smtlib.cs.uiowa.edu/) format — the standard input language for theorem provers like [Z3](https://github.com/Z3Prover/z3) and [CVC5](https://cvc5.github.io/).

```bash
milo verify flight_controller.milo
```

This outputs verification conditions that you can pipe to Z3:

```
── precondition ── clamp ──
precondition of clamp: (<= lo hi)
(set-logic QF_LIA)
(declare-const value Int)
(declare-const lo Int)
(declare-const hi Int)
(assert (not (<= lo hi)))
(check-sat)
; sat = precondition can be violated, unsat = always holds
```

If Z3 returns `unsat`, the condition always holds. If it returns `sat`, there exists a counterexample where the contract can be violated.

**Current limitations:** Verification condition generation currently covers preconditions and loop invariants. Postcondition verification requires modeling the function body (weakest-precondition analysis), which is not yet implemented — postcondition VCs are exported but do not model the relationship between inputs and return values. This is an active area of development.

This approach — contracts as source-level annotations with SMT export — is similar to SPARK/Ada and Dafny. Unlike SPARK, Milo does not bundle a solver or run verification automatically; you need Z3 or CVC5 installed separately. The advantage over external annotation languages is that contracts use Milo syntax and are type-checked alongside your code.

## Safety profiles — `milo safety`

Safety-critical domains have coding standards that restrict what language features are allowed. Milo can check your code against these standards at compile time.

```bash
milo safety flight_controller.milo --safety=do178c-a
```

### Available profiles

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

### What gets checked

Each profile is a combination of constraints, tuned to the standard's requirements:

| Constraint | Description | Strictest at |
|------------|-------------|-------------|
| No recursion | Direct self-calls banned | DO-178C A, IEC 61508 SIL 4 |
| Bounded loops | `while` loops must have `invariant` clauses | DO-178C A, NASA A |
| No dynamic allocation | No Vec, String, HashMap construction | IEC 61508 SIL 4 |
| Require contracts | All functions need `requires`/`ensures` | DO-178C A, NASA A |
| No floating point | Integer-only arithmetic | IEC 61508 SIL 4 |
| Complexity limit | Cyclomatic complexity cap per function | IEC 61508 SIL 4 (max 15) |
| No unsafe blocks | `unsafe { }` banned entirely | All profiles |
| Full match coverage | All `match` arms required | Most profiles |

Example output when violations are found:

```
safety check failed: do178c-a — 3 violation(s)

  error: [do178c-a] function 'processInput' must have requires/ensures contracts
  error: [do178c-a] function 'processInput' contains recursion (banned at this safety level)
  error: [do178c-a] while loop in 'processInput' must have an invariant clause for bounded execution
```

### Integrating with CI

Add safety checking to your build pipeline:

```bash
milo safety src/controller.milo --safety=do178c-a || exit 1
```

The command exits with code 1 if any errors are found, making it suitable for CI gates.
