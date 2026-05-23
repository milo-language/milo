# Contracts & Safety

Milo has built-in support for **design-by-contract** annotations and **safety profile checking**. Contracts let you state what a function expects and guarantees. The compiler type-checks them, and can export them as formal verification conditions for SMT solvers like Z3. Safety profiles enforce domain-specific coding standards (DO-178C, ISO 26262, NASA, IEC 61508, IEC 62304) at compile time.

This is compile-time only — no runtime assertions, no overhead. The compiler proves your code is correct or rejects it.

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

Contracts are type-checked — every `requires`, `ensures`, and `invariant` expression must be `bool`. The compiler rejects non-boolean contract expressions at compile time:

```
error: requires clause must be bool, got i64
  --> example.milo:2:12
  |
2 |   requires x + 1
  |            ^^^^^
```

## Formal verification — `milo verify`

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

If Z3 returns `unsat`, the condition always holds — your contract is mathematically proven. If it returns `sat`, there exists a counterexample where the contract can be violated.

This is the same approach used in SPARK/Ada (the only other systems language with built-in formal verification) and Dafny. The difference: Milo doesn't require a separate toolchain or annotation language. Contracts are part of the language.

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

## Why this matters

Most languages bolt safety analysis on after the fact with expensive third-party tools (LDRA, Polyspace, Coverity). In Milo, it's part of the compiler:

- **Contracts are code, not comments.** They're type-checked, versioned, and can't drift from the implementation.
- **Formal verification without a separate toolchain.** One command generates SMT-LIB2 from the same source file.
- **Standards compliance as a compiler flag.** No separate static analysis pass, no proprietary tool licenses.
- **Zero runtime cost.** Everything is checked at compile time. Your binary is just as fast with contracts as without.

Combined with Milo's existing ownership system (no use-after-free, no data races, no null pointer dereferences), contracts close the gap on *logic errors* — the class of bugs that memory safety alone can't catch.
