<!-- doc-meta
system: contracts-safety-guide
purpose: how-to guide to contracts, proof, loop invariants and runtime checks (safety profiles live in safety-profiles.md)
key-files: src/verify.ts, src/codegen.ts
update-when: contract semantics, proof obligations, runtime checks, or the solver change
last-verified: 2026-07-24
-->

# Contracts & proofs

Milo lets you write down what your functions promise — and then prove it.

- **Contracts** — `requires`, `ensures`, `invariant`, `decreases`: what a function expects, what it guarantees, what stays true in a loop or of a type, and why a recursion ends. Type-checked like the rest of your code.
- **`milo prove`** checks that they hold — for every input, without running the program.
- **Safety profiles** (DO-178C, ISO 26262, IEC 62304 and friends, enforced as compiler flags) have their own page: [Safety profiles](/language/safety-profiles).

## Walkthrough

Let's say you have a function that computes an integer square root. It is undefined for negative input, and it never returns a negative one. The contract says exactly that: the caller must pass `n >= 0` (`requires`), and in return the result is never negative (`ensures`):

```milo
// sqrt.milo
pub fn sqrt(n: i64): i64
requires n >= 0
ensures result >= 0
{
    var r: i64 = 0
    while (r + 1) * (r + 1) <= n {
        r += 1
    }
    return r
}
```

`result` is a keyword, valid in `ensures` clauses: it stands for the return value.

With the contract in place, there are three ways it gets enforced.

### 1. A static value — rejected at compile time

If the compiler can determine the value, it will enforce it. Here we pass -1 directly.

```milo error
pub fn sqrt(n: i64): i64
requires n >= 0
ensures result >= 0
{
    var r: i64 = 0
    while (r + 1) * (r + 1) <= n {
        r += 1
    }
    return r
}

pub fn main(): i32 {
    print(sqrt(-1))
    return 0
}
```

Notice it catches this and prints an error:
```
$ milo build sqrt.milo -o sqrt
error: requires clause 'n >= 0' violated
  ──> sqrt.milo:14:11
   │
14 │     print(sqrt(-1))
   │           ^
```

### 2. An unpredictable value — abort at runtime

Let's say the value passed to `sqrt` is no longer a constant, but a number drawn at runtime. There is nothing left for the compiler to fold:

```milo
from "std/random" import { Random }

pub fn sqrt(n: i64): i64
requires n >= 0
ensures result >= 0
{
    var r: i64 = 0
    while (r + 1) * (r + 1) <= n {
        r += 1
    }
    return r
}

pub fn main(): i32 {
    let reading: i64 = Random.range(-100, 100)
    print(sqrt(reading))
    return 0
}
```

This compiles and runs. Let's see what happens on a debug build:
```
$ milo build sqrt.milo --debug -o sqrt && ./sqrt
runtime error: requires clause violated at sqrt.milo:5
$ echo $?
1
```

In a debug build, every `requires`, `ensures`, and `invariant` becomes a runtime assert. If it fails, it names the clause that failed and its line.

Now let's see what happens on a release build:

```
$ milo build sqrt.milo -o sqrt && ./sqrt
0
$ echo $?
0
```
Whoops, the sqrt returned 0 and continued on. Nothing asserted or aborted. If you don't like this potentially violation of the contract, see the next option.

`--contract-checks` turns those same asserts on at any optimization level, if you want them in a release build. It is its own switch — `--overflow-checks` covers arithmetic, not contracts.

### 3. `milo prove` — proven for every input, before you run it

Neither of the two cases above covers what you actually worry about: a value that only goes negative on some input you never thought to test. That is what the prover is for. Let's say a `scale` function forwards its argument straight through without checking it:

```milo
pub fn sqrt(n: i64): i64
requires n >= 0
ensures result >= 0
{
    var r: i64 = 0
    while (r + 1) * (r + 1) <= n {
        r += 1
    }
    return r
}

pub fn scale(raw: i64): i64 {
    return sqrt(raw)
}
```

```
$ milo prove sqrt.milo
verification: 2 conditions
  proven: 1  failed: 1  unknown: 0  errors: 0

  ✓ [postcondition] sqrt: proven
  ✗ [precondition] scale: failed — counterexample: raw = -1
$ echo $?
1
```

Nothing was run and no input was supplied: the solver found a `raw` below zero by itself. Notice the other line too. `sqrt`'s postcondition is **proven** even though `(r + 1) * (r + 1)` is nonlinear, because Z3 decides nonlinear integer arithmetic. When it cannot decide an obligation the line reads **unknown**, never proven.

**Now that we have the violation of the contract, we can modify the code to satisfy it, then run the prover again.**

```milo
pub fn sqrt(n: i64): i64
requires n >= 0
ensures result >= 0
{
    var r: i64 = 0
    while (r + 1) * (r + 1) <= n {
        r += 1
    }
    return r
}

pub fn scale(raw: i64): i64 {
    if raw < 0 {
        return 0
    }
    return sqrt(raw)
}
```

```
$ milo prove sqrt.milo
verification: 2 conditions
  proven: 2  failed: 0  unknown: 0  errors: 0

  ✓ [postcondition] sqrt: proven
  ✓ [precondition] scale: proven
$ echo $?
0
```

The negative never reaches `sqrt` now — `raw < 0` returns `0`, a defined result on a path you wrote — so there is nothing left to abort on, and no runtime assert is doing the work.

The precondition is discharged, and the prover still will not let that stand unqualified: the proof *assumes* `sqrt` meets its own postcondition, which this run did not establish, so it says so and counts it. `proven` means every input is handled in ordinary code; a runtime assert only backstops what you haven't established. Anything still `unknown` is yours to catch, and `milo prove` exits non-zero on a failure, so CI enforces the difference.

### `milo test --contracts` — the same contracts as property tests

Where the prover says *unknown* (a nonlinear `ensures`, a string, anything outside the
linear fragment), the contracts can still be tested rather than proved. `milo test
--contracts <files|dir>` writes one property test per contract-bearing fn: it draws
inputs (edges first, and a `requires key.len == 32` is drawn at exactly that length),
skips draws that fail `requires`, calls the fn, and checks every `ensures` with `result`
bound. A violation names the inputs that refute it.

```
$ milo test --contracts std/string.milo
std/string.milo
  ✓ testContract_strIndexOfFrom [24ms]
  ✗ testContract_strRepeat
      [guard] SIGKILL: process tree exceeded 2048 MB
```

That second line is the kind of thing it finds: `requires n >= 0` promised that any
count works, and `n = i64::MAX` exhausted memory instead. Its first sweep of the standard
library tightened five contracts that way. A struct parameter is built by calling a
constructor the same file declares, with drawn arguments that satisfy that constructor's
own `requires`, never by drawing the struct's fields, which would refute contracts with
values no program can hold. Generic fns, methods and parameters with no such constructor
are reported as skipped rather than silently passed over; a test whose `requires` no draw
satisfies fails rather than passing on zero cases.

### Loop invariants

The prover does not unroll loops — the trip count usually isn't known. Everything a loop assigns is therefore unknown after it, and an `invariant` is what survives to say something about it.

```milo
pub fn sumTo(n: i64): i64
requires n >= 0
ensures result >= 0
{
    var total: i64 = 0
    var i: i64 = 1
    while i <= n
    invariant total >= 0
    invariant i >= 1
    {
        total += i
        i += 1
    }
    return total
}
```

```
$ milo prove sumTo.milo
verification: 5 conditions
  proven: 5  failed: 0  unknown: 0  errors: 0
```

Each invariant costs two conditions: it must hold on entry, and one pass through the body must re-establish it. That second half is the catch — being true on every real run isn't enough, the invariant has to prove *itself* from one iteration to the next. Drop `i >= 1` here and `total >= 0` stops being provable: on its own, nothing in it rules out a negative `i`.

`for in` takes an invariant in the same place and needs less of one: the range is itself a fact, so the prover already knows `0 <= i < n` in the body without being told.

### `old` — what a function did to a `&mut`

A function that writes through a `&mut` has no `result` to describe. `old(e)` names the value `e` held on entry, which is what makes such a function specifiable at all.

```milo
fn bump(n: &mut i64): void
ensures n == old(n) + 100
{
    n += 100
}
```

The payoff is at the call site: past `bump(x)` the prover would otherwise know nothing at all about `x`, and this contract tells it `x` grew by exactly 100.

`old` is legal only inside `ensures`, and only on a scalar — snapshotting a `Vec` or struct on entry would alias or clone. Use a scalar projection instead: `old(v.len)`.

### `decreases` — why the recursion ends

`decreases` takes an integer measure that must stay non-negative and get strictly smaller at every recursive call. Without one, a function that recurses forever would prove any `ensures` you wrote.

```milo
fn countdown(n: i64): i64
requires n >= 0
decreases n
{
    if n == 0 { return 0 }
    return countdown(n - 1)
}
```

```
  ✓ [termination] countdown: proven
```

Loops take a `decreases` too, but there it is optional.

### Struct invariants — a fact the type carries

Some facts belong to a type rather than to any one function. A ROM image's program bank is at least 16KB — the loader guarantees it, every reader depends on it, and re-checking it at each use is noise that also fails to prove anything.

Write it on the struct, after the closing brace, over the field names with no receiver:

```milo
struct Rom {
    prg: Vec<u8>,
    mapper: i64,
}
invariant prg.len >= 16384
```

Now this is provable, with nothing in it bounding `prg.len`:

```milo
struct Rom {
    prg: Vec<u8>,
    mapper: i64,
}
invariant prg.len >= 16384

fn readAt(r: &Rom, i: i64): i64
requires i >= 0
requires i < r.prg.len
{
    return r.prg[i] as i64
}

fn readLow(r: &Rom): i64 {
    return readAt(r, 100)     // proven: 100 < prg.len follows from the invariant
}
```

An invariant that was only ever *assumed* would be a hole with a keyword in front of it, so it is also **owed** — at every struct literal, and in every function that takes the type by `&mut`:

```milo skip
// Illustrative: `zeros(n)` stands in for whatever builds the bank. The second line is
// meant to FAIL the prover, so this fence is not compiled.
fn makeRom(): Rom { return Rom { prg: zeros(16384), mapper: 0 } }   // ✓ proven
fn makeBad(): Rom { return Rom { prg: zeros(16), mapper: 0 } }      // ✗ failed
```

If a mutator's obligation comes back `unknown` — it does something the translator cannot follow — then every proof that leaned on the invariant is downgraded to conditional, naming it. A fact nothing established never renders as a checkmark.

### Floats

`f32`/`f64` contracts are proved the same way, over the reals rather than the integers. Write the literals with a decimal point — `0.0`, not `0` — since that is what tells the solver the value is not an integer:

```milo
fn halve(x: f64): f64
requires x >= 0.0 && x <= 10.0
ensures result >= 0.0 && result <= 5.0
{
    return x * 0.5
}
```

### Which solver

`milo prove` sends every obligation to [Z3](https://github.com/Z3Prover/z3), the only solver. It is a runtime requirement of `milo prove`, `--rte`, `--dead`, `milo trace` and `milo verify`: install it with `brew install z3` or `apt install z3`; without it those commands stop with an install hint. Pass `--emit-smt` to print the obligations as SMT-LIB2 for another tool.

A recursive function *is* modelled — the self-call is handled by induction, assuming the function's own `ensures` — but that assumption is only sound if the recursion terminates, which is what `decreases` above is for. Whether the resulting obligation is decided is a separate question: Z3 answers `unknown` on some it cannot settle.


## Requirements

A certification review asks which requirement each piece of code implements, which clause
formalizes it, and which test verifies it. `@req(ID)` records that in the source, against a
`requirements.json` next to the entry file:

```json
{ "requirements": [
  { "id": "HLR-1", "text": "The actuator command stays within the output range." },
  { "id": "LLR-1", "parent": "HLR-1", "text": "Every command is clamped to [outLo, outHi]." }
] }
```

What `@req` means depends on what it is written on:

| On | Meaning |
|---|---|
| a `fn`, `struct`, or a whole file (`@!req(ID)`) | implements ID |
| a `requires` / `ensures` / `invariant` clause (written before the clause) | formalizes ID |
| a `test*` fn | verifies ID |

`@assume(ID)` marks a fn whose contract is a trusted axiom, `@derived(ID)` code for a
derived requirement, and `@deactivated("reason")` code that is present but not active. IDs
use letters, numbers, `-`, `_` and `.`, or a quoted string. An unknown ID, a duplicate ID, a
`parent` that does not exist and a cycle in the parents are compile errors.

`milo trace <entry.milo>` prints the matrix: per requirement (a tree by `parent`), the
implementing fns, the formalizing clauses with their `milo prove` verdict (`PROVEN`,
`FAILED` or `UNKNOWN`), and the verifying tests. A `requires` clause is judged at every
call site, with the file and line, so a caller that cannot meet it shows up as `FAILED` where
it is written. Below the matrix: fns with no `@req`, requirements with no implementation or
test, and the count of unknowns. `--json` prints the same as data.

Without a profile the matrix is a report. With `--strict`, or `--safety=` a profile whose
`traceability` field is `strict` (also on `milo build --strict` and `milo verify --profile`; a dev
`build --safety` only warns, and `--baseline <file>` keeps listed gaps warnings), these are errors: a fn with no `@req`
(`@derived` and `@deactivated` are exempt), a requirement with no implementation or no
verification (DO-333: a low-level requirement needs a fully `PROVEN` set of clauses or a passing test;
a high-level one, or one with no clause, needs a passing test of its own), a failing `@req` test, and a
formalizing clause that is `FAILED` or `UNKNOWN`. A law has to be `PROVEN`, covered by a passing `@req`
test, or `@assume`d. `milo trace` runs the tests (`--no-run` skips them); line coverage is not measured yet.

A clause that proves itself (`ensures result == result`) would trace a requirement to
nothing, so the [`vacuous-contract`](/language/warnings-and-errors#vacuous-contract) warning
flags it. A worked example, with the overflow that `milo prove --rte` found becoming a
requirement, is in
[examples/assured/pid](https://github.com/milo-language/milo/tree/main/examples/assured/pid).

## Safety profiles

Checking code against DO-178C, ISO 26262 and other coding standards with `milo safety` has its own page: [Safety profiles](/language/safety-profiles).
