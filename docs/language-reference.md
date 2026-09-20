<!-- doc-meta
system: language-reference
purpose: the syntax-and-semantics reference for Milo — types, control flow, ownership, slices, Heap, arenas, generics
key-files: src/parser.ts, src/checker.ts, docs/grammar.ebnf, std/arena.milo
update-when: surface syntax or a language feature changes, or a stdlib type gets first-class reference docs
last-verified: 2026-09-19 (@copyOnly section added and compiled; full snippet sweep last run 2026-07-31)
-->

# The Milo Language Guide


> This document is prose: it explains the language and is not verifiable. The **normative**
> requirements — what a conforming implementation shall do, each traceable to the test that
> discharges it — are in [spec.md](spec.md), generated from the suite. Syntax is
> [grammar.ebnf](grammar.ebnf).

A memory-safe systems language with simple syntax — Rust's semantics with a lighter, more TypeScript-like surface. Compiles to native code via LLVM.

> **This file is the authoritative reference.** It is the exhaustive spec, kept in step with
> `src/parser.ts` and `src/checker.ts`, and it is what agents and contributors should read.
> The published [Language Overview](https://milo-language.github.io/milo/language/) is the
> teaching version of the same material — shorter, example-led, and aimed at newcomers. When
> the two disagree, this file is right and the site page needs updating.

## Getting Started

```bash
# Install prerequisites: Bun (https://bun.sh) and LLVM/Clang

# Compile and run
bun run src/main.ts build examples/hello.milo -o hello
./hello

# Inspect the compiler's intermediate forms (useful for understanding what it does)
bun run src/main.ts emit-ast examples/hello.milo   # parsed AST as JSON (no types yet)
bun run src/main.ts emit-hir examples/hello.milo   # typed HIR as JSON (every expr carries its type)
bun run src/main.ts emit-ir examples/hello.milo    # LLVM IR

# Search the standard library (auto-discovered from std/**/*.milo)
bun run src/main.ts api time                  # ranked signature search by name + doc
bun run src/main.ts api --module std/datetime # dump one module's full API
```

Reach for `milo api` before hand-writing something the stdlib already provides.

## Hello, Milo

```milo
fn main(): i32 {
    print("Hello, Milo!")
    return 0
}
```

Every Milo program starts at `main`, which returns an `i32` exit code.

---

## Variables

`let` declares an immutable binding. `var` declares a mutable one.

```milo
fn mightFail(): i32 { return 0 }

let x: i32 = 42       // immutable — cannot be reassigned
var count: i32 = 0     // mutable — can be reassigned
count = count + 1

let name = "Milo"      // type inference works

let _ = mightFail()    // `_` discards a result; it may be repeated in one scope
```

Under the hood, `let` maps to an SSA register and `var` maps to a stack allocation.
This means what you write is what LLVM sees — no hidden costs.

### No shadowing

A binding may not reuse a name that is already in scope, anywhere in the enclosing
function — not in a nested block, not as a loop or match binding. Unlike Rust,
where shadowing is idiomatic, this is an error:

```milo error
let row = 5
for row in nums { … }   // error: 'row' shadows an outer binding — pick a different name
```

The reason is readability: with shadowing allowed, a line mentioning `row` a screen
below means whichever `row` is nearest, and the reader has to reconstruct the block
structure to know which. Names starting with `_` are exempt, since nothing reads
them — two `match` arms may both bind `_e`.

Sibling scopes are not shadowing: two loops in the same function may each bind `i`,
because neither is inside the other.

### Semicolons

Statements are separated by newlines — no terminator required. A trailing `;` is
allowed but optional (`let x = 1;` and `let x = 1` are identical), so habit doesn't
fight you; `milo fmt` strips it, keeping the canonical form newline-only. Unlike
Rust, a `;` never changes a value — a block's value is its last expression whether
or not a `;` follows. A `;` *inside* an expression is still an error.

---

## Primitive Types

| Type | Description |
|------|-------------|
| `i8`, `i16`, `i32`, `i64` | Signed integers |
| `u8`, `u16`, `u32`, `u64` | Unsigned integers |
| `f32`, `f64` | Floating-point |
| `bool` | Boolean (`true` / `false`) |
| `int` | Alias for `i64` |
| `float` | Alias for `f64` |
| `byte` | Alias for `u8` |

The float types carry the IEEE special values as namespace constants: `f64.NAN`, `f64.INF`, `f64.NEG_INF` (and the `f32` equivalents). Because `NaN` is not equal to itself, `x == f64.NAN` is always false — the compiler warns on it and points you to `isNan(x)`; `isInf(x)` and `isFinite(x)` live alongside it in `std/math`.

### Type Aliases

```milo
type Meters = f64
type Altitude = i32(0..50000)     // with range constraint
type Handler<T, R> = (T) => R     // parameterized
type Table<K, V> = HashMap<K, V>
```

An alias may take type parameters, so a name can stand for a **shape** rather than for one
type. It is **expanded at the use site, not instantiated**: `Table<string, i64>` *is*
`HashMap<string, i64>` to everything downstream, so it needs no monomorphization, has no
identity of its own, and passes anywhere the underlying type is accepted. Aliases nest, and
the wrappers compose — with `type Slot<T> = *T`, `Slot<Point>` is `*Point`, and a `&Pair<T>`
parameter borrows the `Vec` the alias names.

Two rules follow from expansion. The argument count must match (`Pair<i64, bool>` on a
one-parameter alias is an error naming the alias, not an unknown type), and a parameter
**cannot carry a bound**: a bound constrains what a body does with a parameter, an alias has
no body, so `type Shown<T: Show> = Vec<T>` is rejected rather than accepted and never
checked. Put the bound on the function or struct that uses the alias.

### Number Literals

```milo
let dec: i32 = 1_000_000      // decimal with underscores for readability
let hex: i32 = 0xFF            // hexadecimal
let bin: i32 = 0b1010_1010     // binary
```

An integer literal with **no type context** defaults to `i64` (arithmetic, indices and
loop counters are `i64`-dominant; `i32` and the narrower widths are the annotated exception).
Where a type *is* in context — an annotation, a function parameter, a struct field or an enum
payload — the literal adopts that type instead:

```milo
let a = 5             // i64 (no context)
let b: i32 = 5        // i32 (annotation drives the width)
let c = a + 1         // i64  — `1` takes `a`'s width
```

Float literals work the same way. A bare `1.0` is `f64`, but in an expression with
an `f32` it narrows to `f32` rather than forcing a cast or a named constant:

```milo
fn lerp(a: f32, b: f32, t: f32): f32 {
    return a * (1.0 - t) + b * t     // `1.0` is f32 here
}
```

### Integer Overflow Safety

Milo prevents silent integer overflow at multiple levels:

**Compile-time** — literals and constant expressions are range-checked:

```milo error
let x: i8 = 200              // error: integer literal 200 overflows i8 (range -128..127)
let y: i32 = 2147483647 + 1  // error: constant expression overflows i32
```

**Runtime** — arithmetic traps on overflow, in **every build mode**, with source location:

```milo
let x: i32 = 2147483647
let y = x + 1     // runtime error: integer overflow at main.milo:2  (aborts)
```

The rule is uniform: **every operation is total — it produces the correct value or it traps; nothing is silently wrong.** There is no debug-vs-release difference in meaning (Milo does not follow Rust's debug-trap/release-wrap split). A trap calls `abort()` — `SIGABRT`, so a supervisor sees an abnormal exit, the OS can drop a core dump, and `lldb`/`gdb` break at the fault. Add `-g` for DWARF debug info (source-level stepping) — see `docs/site/getting-started/debugging.md`.

Checked operations: `+`, `-`, `*`, unary negation (`-x`), integer division/remainder (`/` `%`, including signed `INT_MIN / -1`), and shift-by-out-of-range (`<<`/`>>` with an amount ≥ the operand's bit width). Array/slice bounds and ranged-type bounds trap the same way.

For a perf-critical build that cannot afford the checks on `+ - *`, `--no-overflow-checks` (or `--fast`) restores silent two's-complement wrapping; `--overflow-checks` forces trapping. These change *only* the plain `+ - *` operators — everything else stays total.

The cost depends entirely on how integer-dense the inner loop is (measured 2026-08-23 on macOS/aarch64; reproduce with `sh benchmarks/run-overflow.sh`): float math, parsing and allocation-bound work pay 0–2%; byte scanning about 16%; tight loops over unconstrained integers 21–31%. Where the range prover can discharge an operation it emits no check at all, but an unconstrained `i64` parameter cannot be discharged, so recursive integer code pays the full cost today. Float-heavy code is cheap for a different reason: the checks are emitted on the loop indices, they are simply dwarfed by the f64 work. Branch narrowing (ranged integers L3, planned) is what would close that gap: `n - 1` under an `if n < 2` guard is provably safe and still emits a check.

**Explicit overflow control** — wrapping is otherwise reached only by *naming* it, per operation:

```milo
let a: u8 = 255
a.wrappingAdd(1)     // 0 — two's-complement wrap
a.saturatingAdd(1)   // 255 — clamps to max
let r = a.checkedAdd(1)  // Option.None — returns None on overflow

let q: i32 = 10
q.checkedDiv(0)      // Option.None — None on divide-by-zero
q.checkedRem(0)      // Option.None — None on divide-by-zero
```

Available: `wrappingAdd/Sub/Mul/Neg`, `saturatingAdd/Sub/Mul`, `checkedAdd/Sub/Mul/Div/Rem/Neg`.
`checkedDiv`/`checkedRem` also return `None` on signed `INT_MIN / -1` overflow; `checkedNeg` returns `None` at signed `INT_MIN`.

**Whole-routine wrapping — `@wrapping`.** Some routines are *inherently* modular — a CPU
emulator's ALU, a hash mixer, a PRNG — where every `+`/`-`/`*` is meant to wrap and per-op
methods would be thousands of edits. Annotate the function:

```milo skip
@wrapping
fn step(cpu: &mut Cpu) {
    cpu.a = cpu.a + operand      // wraps; no trap, no method call
    cpu.pc = cpu.pc + 1          // 16-bit program counter, modular by design
}
```

Inside a `@wrapping` fn, `+ - * -x`, signed `INT_MIN / -1` division, and shift-amount-≥-width
all use defined modular arithmetic (two's-complement wrap; shift amount masked to `& (width-1)`).
It is a **correctness dial only** — it does **not** touch memory safety: array/slice bounds,
ranged-type bounds, and division **by zero** still trap inside a `@wrapping` fn. `as` casts are
unaffected (conversion is a separate dial).

`@wrapping` sets the routine's *default*, not a lock — the per-op methods override it either
way: `.checkedAdd`/`.saturatingAdd` opt a single operation back *into* checking inside a
`@wrapping` fn, just as `.wrappingAdd` opts one op *out* inside an ordinary (checked) fn.

For a file that is modular throughout — an emulator CPU core, a hash/PRNG module — put the
directive once at the top as an **inner attribute** (Rust `#![...]` analog):

```milo skip
@!wrapping          // every fn in THIS file is @wrapping

fn step(...) { ... }
fn adc(...)  { ... }
```

`@!wrapping` applies only to functions defined in that file, not to anything it imports — so
a CPU core marked `@!wrapping` runs modular while the ROM parser it calls (a separate file)
keeps its overflow traps. It is equivalent to writing `@wrapping` on every function in the
file, and the same tier rule holds: bounds and division-by-zero still trap.

> **Non-goal:** there is no `--no-bounds-checks` flag and never will be. `--no-overflow-checks`
> trades away *overflow* trapping (a correctness property) for speed; bounds checking is a
> *memory-safety* property and stays on in every build. Opting out of a bounds check is
> possible only per-site, inside `unsafe`. This keeps "memory-safe in release" unconditional.

Bit intrinsics: `countOnes`, `leadingZeros`, `trailingZeros` return an `i64` count (LLVM `ctpop`/`ctlz`/`cttz`; zero-count equals the type's bit width). `rotateLeft(n)`/`rotateRight(n)` (funnel shift, `n` taken mod bit-width) and `reverseBits()` return the same width as the receiver.

### Ranged Integer Types

Type aliases with range constraints, inspired by Ada/SPARK. Range checks are always-on in all build modes.

Note: range-type bounds are **inclusive** on both ends — `i32(0..50000)` accepts 0 and 50000. This differs from `for` loop ranges, where `0..n` excludes `n`.

```milo
type Altitude = i32(0..50000)
type Temperature = i32(-100..100)

let alt: Altitude = 30000         // ok
let top: Altitude = 50000         // ok — bounds are inclusive
```

```milo error
type Altitude = i32(0..50000)
let bad: Altitude = 60000         // compile error: value 60000 is out of range
```

Dynamic values are checked at runtime:

```milo
type Altitude = i32(0..50000)

fn readSensor(): i32 {
    return 30000
}

let alt: Altitude = readSensor()  // runtime check: traps if value outside 0..50000
```

**Range propagation** — the compiler tracks ranges through arithmetic and eliminates runtime checks when it can prove the result fits:

```milo
type SmallInt = i32(0..100)
type MediumInt = i32(0..200)

let a: SmallInt = 50
let b: SmallInt = 100
let sum: MediumInt = a + b   // no runtime check — compiler proves (0..100)+(0..100) ⊆ (0..200)
```

### Bitwise Operators

Integer-only. C-style precedence: `~` (unary) > `<<` `>>` > `&` > `^` > `|`.

```milo
let a: i32 = 0b1100
let b: i32 = 0b1010
let mask: i32 = 0xFF & 0x0F    // 15
let combined = a | b
let toggled = a ^ b
let shifted = a << 2
let negated = ~a               // ones-complement
```

### Number → String

```milo
let n: i64 = 42
let s = n.toString()          // "42"
let pi: f64 = 3.14
let t = pi.toString()         // "3.14"
```

A float prints as the **shortest decimal that reads back as the same value**, so
`toString`, string interpolation, struct display and `jsonStringify` all round-trip:

```milo
print((1.0 / 3.0).toString())     // 0.3333333333333333
print((0.1 + 0.2).toString())     // 0.30000000000000004
print((100.0).toString())         // 100      — not 1e+02
print((1e21).toString())          // 1e+21    — exponent form only when fixed would be absurd
```

An `f32` round-trips at `f32` precision (`(1.0 / 3.0) as f32` prints `0.33333334`, not the
promoted double's digits). Non-finite values print as `inf`, `-inf` and `nan` — note those
are not legal JSON, so a `NaN` reaching `jsonStringify` produces output no parser will
accept.

### Type Casts

Use `as` to convert between numeric types:

```milo
let big: i64 = 42
let small = big as i32

let f: f64 = 3.7
let n = f as i32       // truncates to 3

let b: u8 = 200
let wide = b as i32
```

Float→integer casts **saturate**: a value above the target's max clamps to the max, below the min clamps to the min, and `NaN` maps to `0`. The cast is total — every input has a defined result, there is no undefined behavior on overflow (unlike C, and matching Rust's `as`). Integer→integer casts truncate/extend by bit width and wrap silently; use the `checked*`/`saturating*` methods above when you need to detect or clamp overflow instead.

### Character Literals

Character literals produce `u8` values:

```milo
let ch: u8 = 'A'       // 65
let newline = '\n'
```

---

## Functions

```milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: string): void {
    print("hello, ", name)
}
```

A `return` with no value exits a `void` function. Like every other statement it ends
at the newline — an expression on the next line is the next statement, not the
returned value — and since nothing after it can run, a following statement in the
same block is a compile error:

```milo
fn f(x: i64) {
    if x < 0 {
        return
    }
    print(x)      // fine: reached when x >= 0
}
```

```milo error
fn g(x: i64) {
    return
    print(x)      // error: unreachable code
}
```

### Generic Functions

```milo
fn identity<T>(x: T): T {
    return x
}

let n = identity(42)       // T inferred as i64
let s = identity("hello")  // T inferred as string
```

### Built-in Functions

| Function | Description |
|----------|-------------|
| `print(fmt, ...)` | Print formatted text with trailing newline |
| `exit(code)` | Exit the process |
| `replace(place, value)` | Store `value` into a mutable `place`, returning its old contents. Move-in/move-out — needs no `clone`, works on non-copyable types |
| `swap(a, b)` | Exchange two mutable places of the same type. Move-only, no `clone` |
| `forget(x)` | Consume `x` WITHOUT running its drop. For seams where ownership leaves through a raw pointer the checker cannot see — the alternative there is a double free or a leak. Memory-safe (leaking is safe), so it needs no `unsafe`; it is merely usually wrong |

`forget` is the give direction. The take direction is [`std/foreign`](std/foreign.md)'s `adopt(p)` / `adoptSlice(p, len)`, which turn a raw pointer back into an owned `Heap<T>` / `Vec<T>` whose drop frees it. They are not built-ins: they are `@unsafe fn`s in one module, because the assertion they carry (the pointer came from a Milo allocation of this type, nothing aliases it, and it has not been adopted before) is not one the compiler can check, and adopting the same pointer twice is a double free. `forget` needs no `unsafe` because leaking is safe; `adopt` does, because un-leaking is not.

```milo
from "std/foreign" import { adopt }

struct Thing {
    n: i64,
}

// The C-ABI close entry point: C hands back a pointer Milo allocated earlier, and
// this is where its drop finally runs.
@externalLinkage
pub fn closeThing(p: *Thing): i32 {
    unsafe {
        match adopt(p) {
            Option.Some(thing) => {
                print((*thing).n)
                return 0            // thing drops here, freeing the allocation
            }
            Option.None => {
                return -1           // p was null; there is nothing to free
            }
        }
    }
}
```

| `jsonStringify(val)` | Serialize a flat struct (scalar fields only) to JSON string |
| `@embedFile(path)` | Embed file contents as string at compile time (see [Compile-Time File Embedding](#compile-time-file-embedding)) |
| `@targetOs()` | Compile-time OS string (`"darwin"`/`"linux"`/`"windows"`); folds `if` branches (see [Compile-Time Target OS](#compile-time-target-os)) |

`replace` and `swap` are the sound way to move a value out of a place you only hold mutably — the move checker forbids a bare `x = someNewValue` from yielding the old `x`, and `x.clone(); x = ...` is a move disguised as a copy. They take the place *bare* (`replace(x, v)`, not `replace(&x, v)`), since [borrows are implicit](#references-second-class).

```milo
var anchor: string = "hello"
let old = replace(anchor, "")   // old == "hello", anchor == ""  (no allocation, no clone)
var v = [10, 20, 30]
swap(v[0], v[2])                // v == [30, 20, 10] — exchange two elements in place
```

### Contracts

Functions can declare preconditions (`requires`), postconditions (`ensures`), loop invariants (`invariant`), and termination measures (`decreases`). These are type-checked at compile time — every clause must be a `bool` expression, except `decreases`, which must be an integer. In `ensures` clauses, `result` refers to the return value and `old(e)` to the value `e` held at entry.

In debug builds (`--debug`), contracts are asserted at runtime: `requires` at function entry, `ensures` at every return, and `invariant` at each iteration (for a `while` loop that is the condition block, so entry, every iteration, and exit; a `for` loop checks the top of each iteration). `decreases` has no runtime meaning — it is discharged statically. A violation prints `runtime error: <kind> clause violated at file:line` and exits with code 1. Release builds compile contracts out entirely. Call-site `requires` violations with compile-time-constant arguments are still rejected at compile time.

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

Loop invariants go between the loop header and the body — on `while` and on `for in` alike:

```milo
let n: i64 = 10
var total: i64 = 0
var i: i64 = 1
while i <= n
  invariant total >= 0
  invariant i >= 1
{
    total = total + i
    i = i + 1
}
```

```milo
let n: i64 = 10
var total: i64 = 0
for i in 0..n
  invariant total >= 0
{
    total = total + i
}
```

A `for` loop needs no `invariant i >= 0`: the prover already knows the binding lies in the
range, and after the loop it knows the invariant holds at the final index.

#### Iterating your own types

`for x in c` works over any value whose type has a `next(self: &mut Self): Option<T>`
method: the loop calls `next` and binds each `Some(x)` until the first `None`.

```milo
struct Countdown { n: i64 }
impl Countdown {
    fn next(self: &mut Self): Option<i64> {
        if self.n == 0 { return Option.None }
        self.n = self.n - 1
        return Option.Some(self.n)
    }
}

var c = Countdown { n: 3 }
for x in c { print(x) }   // 2, 1, 0
```

**Protocol laws.** The loop calls `next` repeatedly until the first `None`, then stops — it
does **not** call `next` again after that, and it does **not** call `next` after a `break`.
Whether `next` keeps returning `None` once exhausted is up to the iterator, but
implementations **should** be fused (stay `None`); the standard library's are. Hash values
and iteration are unrelated here — this is purely the stop condition.

To iterate a custom *container* without copying each element, hand out a slice view (`&[T]`,
a non-owning fat pointer over the backing store) and iterate that: `for x in c.view()` where
`fn view(self: &Self): &[T]`. The elements are borrowed, not cloned.

**`@iter` — a newtype iterates its field.** A struct that wraps a container marks the
field, and `for x in wrapper` walks that field exactly as the container itself would —
same bindings, same borrow, nothing allocated:

```milo
struct Ids {
    @iter v: Vec<i64>,
}

let ids = Ids { v: [1, 2, 3] }
for x in ids { print(x) }        // 1, 2, 3 — x is &i64, as for any Vec
for i, x in ids { print(i) }     // the two-binding form comes through too
```

Mark a `Vec`, `HashMap`, array, or `string` field, at most one per struct (two would make
`for x in wrapper` ambiguous). `@iter` is what makes `HashSet` enumerable: a set cannot
write a `next` method, because the iterator would have to hold a reference into the set,
and references are second-class. Delegating to the backing `HashMap` costs nothing —
without it, enumerating a set would mean snapshotting it into a `Vec` first.

A struct with no `@iter` field falls back to the `next` protocol above.

**The `Iterator` marker trait.** `impl Iterator for X {}` marks `X` as iterable so it
satisfies an `<I: Iterator>` bound and can be named in a prover contract over "any
iterator". It is a marker: the `next` contract above is what the `for` loop actually
requires and is checked at each iteration site (Milo has no associated types, so the
element type is not named in the trait). A generic function may iterate a bounded
parameter — `fn sum<I: Iterator>(it: I) { for x in it { ... } }` — and `next` is resolved
when the function is monomorphized to a concrete type.

#### `old` — the value at entry

Inside an `ensures`, `old(e)` is the value `e` held when the function was entered. It is the
only way to specify a function that writes through a `&mut` parameter, since `ensures` can
otherwise talk only about `result`:

```milo
fn bump(n: &mut i64): void
  ensures n == old(n) + 100
{
    n = n + 100
}
```

A caller gets to use that: after `bump(x)`, the prover knows `x` is 100 more than it was,
instead of losing track of it entirely.

`old` is legal only in `ensures`, and only on a scalar (integer, float, or bool) — a
contract-checking build snapshots the value at entry, and copying a `Vec` or a struct there
would either alias the caller's buffer or clone on every call. Snapshot a scalar projection
instead: `old(v.len)`.

#### `decreases` — termination

A self-recursive call is proved by assuming the function's own `ensures`. That is induction,
and it is only sound if the recursion bottoms out. `decreases` supplies the measure: an
integer expression — not a boolean claim — that must be non-negative and strictly fall at
every self-call.

```milo
fn countdown(n: i64): i64
  requires n >= 0
  decreases n
{
    if n == 0 { return 0 }
    return countdown(n - 1)
}
```

Without a discharged measure the proof still runs, but is reported as *conditional*: it
assumes a termination nothing checked. `decreases` also works on a loop, where it buys total
correctness rather than soundness — a non-terminating loop makes a postcondition vacuously
true rather than provable from nothing.

#### Struct invariants

A `struct` may carry `invariant` clauses after its closing brace, written over its own field
names with no receiver. The clause is a property of the *type*:

```milo
struct Rom {
    prg: Vec<u8>,
    mapper: i64,
}
invariant prg.len >= 16384
```

It is **assumed** wherever a value of that type is observed — which is what lets a function
index `prg` without re-checking a bound the loader already established — and correspondingly
**owed** at every struct literal and in every function that takes the type by `&mut`. A
constructor that builds a short `prg` is refuted; a mutator that could break the clause and
cannot be shown not to is reported as unknown, and every proof that leaned on the invariant
is then marked conditional.

Use `milo prove file.milo` to discharge contracts against the built-in `std/smt` prover (`--solver=z3` for theories it doesn't model, `--emit-smt` to print the raw SMT-LIB2 conditions instead of solving them). Contracts are not emitted at `-O1`+; `--debug` and `--contract-checks` turn them into runtime asserts. Use `milo safety file.milo --safety=do178c-a` to check against domain-specific safety profiles (DO-178C, ISO 26262, NASA, IEC 61508, IEC 62304).

### Thread boundaries — `@thread` and `@synchronized`

A data race can only enter a program somewhere, and `@thread` marks that somewhere: a
function that hands a closure to a **real OS thread**. Two functions in `std` carry it,
`spawnOsThreadDetached` and `Promise.blocking`. The checker reads the annotation rather
than keeping its own list of entry points, and holds any closure crossing one to `Send`,
rejecting unsynchronized mutable globals reached from its body.

Written `@thread` on the line above the function, as `std/runtime` does for
`spawnOsThreadDetached` and `Promise.blocking`.

That indirection is not decoration. The checker used to hardcode the boundary list, the
list drifted, and a spawn that had never been given an arm shipped a pointer into a dead
frame to another thread. Declaring the boundary beside the function that *is* the
boundary is what stops the two going out of step.

`@synchronized` is its counterpart, and marks a method whose closure argument is a
**critical section** — the primitive itself supplies the mutual exclusion and the
happens-before edge, so a global written inside is not racing:

`std/sync` writes it on `Once.run`, the one method in the standard library that
qualifies.

Without it, the canonical one-shot initializer reports as the very race it prevents.
The scan stops at the boundary instead of modelling the primitive, so a new
synchronization type only has to declare itself rather than teach the checker how it
works.

Both are enforced annotations, not documentation: `milo lang --json` reports the whole
attribute vocabulary, so an editor or linter outside this repo can discover them.

### Purity — `@pure`

A signature already tells you what a function may *mutate*: only what it was passed,
and only through a `&mut` parameter, because references are second-class and nothing
is aliased. It does not tell you whether the function printed, read a file, or touched
module state. `@pure` closes that gap for the functions that opt in.

```milo
@pure
fn sumSquares(v: &Vec<i64>): i64 {
    var total = 0
    for x in v { total = total + x * x }
    return total
}
```

A `@pure` function reads and writes only its parameters and its own locals. It may not

- call a function that is not itself `@pure`;
- call an `extern`, unless that extern is declared `@pure`;
- call through a function value, a fn-typed field, or an interface method (purity is not
  part of a fn type yet, so the compiler cannot see what such a call does);
- read or write a mutable module-level `var`;
- contain an `unsafe` block.

It **may** mutate through a `&mut` parameter — that effect is in the signature, so it is
not ambient — and it may allocate. `@pure` works on free functions, on methods in an
`impl`, and on generic functions (every instantiation is checked separately).

**`@pure` is not totality.** A pure function can still trap (overflow, a failed bounds
check, a violated contract) or loop forever. Trapping is a refusal to continue, not an
observable effect. The strong reading — safe to cache, reorder, or retry — holds for a
`@pure` function whose parameters are all by-value or `&T`.

On an `extern`, `@pure` is an *assertion*, not a check: there is no body here to inspect.
This is the FFI trust boundary, stated at the declaration rather than assumed.

```milo
@pure extern fn sqrt(x: f64): f64
```

`std/math` is annotated throughout on this basis, so numeric code can be pure:

```milo
from "std/math" import { Math }

@pure
fn hypot(a: f64, b: f64): f64 {
    return Math.sqrt(a * a + b * b)
}
```

Purity and contracts are designed to meet: a `@pure` function has no frame conditions to
encode and no hidden state between calls, which is exactly the shape `milo prove` reasons
about best. See [docs/effects-and-capabilities.md](effects-and-capabilities.md) for the
wider design — what is shipped, and what capability-passing would add.

---

## Strings

Strings are owned UTF-8 byte buffers (similar to Rust's `String`). They are heap-allocated
with a `{ptr, len, cap}` layout.

```milo
let greeting = "hello"
let name = "world"

// Concatenation
let message = greeting + " " + name

// Length
let n = message.len

// Byte indexing
let firstByte = message[0]    // u8

// Slicing — zero-copy view (returns &string, no allocation)
let hello = message[0..5]       // &string, borrows from message
print(hello)                    // auto-deref: methods/print/indexing all work
var view = message[0..3]
view = message[3..5]            // reassignable, just updates the pointer

// Iterating views — a whole text pass with no allocation
for line in message.lines() {        // line: &string, one per '\n' ('\r\n' handled)
    for field in line.splitView("\t") {   // field: &string, one per separator
        print(field)
    }
}

// Owned copy — when you need a string that outlives the source
let owned = message.substr(0, 5)  // allocates new string

// Deep copy
let copy = greeting.clone()

// Comparison
if greeting == "hello" {
    print("match!")
}

// Building strings character by character
var s: string = ""
s.push('h')
s.push('i')
```

### String Methods

```milo
let s = "Hello, World!"

s.toLower()         // "hello, world!"
s.toUpper()         // "HELLO, WORLD!"
s.trim()            // strip leading/trailing whitespace
s.trimStart()       // strip leading whitespace
s.trimEnd()         // strip trailing whitespace
s.split(",")        // Vec<string>: ["Hello", " World!"]
s.contains("World") // true
s.startsWith("He")  // true
s.endsWith("!")     // true
s.indexOf("World")      // Some(7), or None if not found
s.lastIndexOf("l")      // Some(10), or None if not found
s.replace("World", "Milo")  // "Hello, Milo!"
s.padStart(15, " ")     // "  Hello, World!"
s.padEnd(15, ".")       // "Hello, World!.."
s.isEmpty()             // false
s.charAt(0)             // "H"
s.reverse()             // "!dlroW ,olleH"
s.replaceFirst("l", "L") // "HeLlo, World!"
s.repeat(3)             // "Hello, World!Hello, World!Hello, World!"
"42".parseInt()         // Option<i64> — Some(42); "42x" and "" are None
"3.14".parseF64()       // Option<f64> — Some(3.14); "abc" is None
s.substr(0, 5)          // "Hello" (owned copy)
```

#### Iterating views — `lines()` and `splitView()`

`split` copies: every piece is an owned `string` in a fresh `Vec`. `lines()` and
`splitView(sep)` copy nothing — each piece is a `&string` view into the receiver:

```milo
let text = "a,b\nc,d\n"
for line in text.lines() {                // line: &string, no allocation
    for field in line.splitView(",") {    // field: &string, no allocation
        print(field)
    }
}
```

Both take the enumerate form too: `for i, line in text.lines()` binds a 0-based index.

Both are **loop forms, not expressions**: `let parts = s.splitView(",")` is an error,
because a view has nowhere to live outside the loop that borrowed the receiver for it.
The receiver is frozen for the loop — it cannot be mutated, moved or reassigned while
pieces of it are live — and a piece cannot escape (`.clone()` it to keep one).

`splitView` matches `split` piece for piece, empty pieces and all (`"a,,b,"` yields
`"a"`, `""`, `"b"`, `""`). `lines()` splits on `'\n'`, drops a trailing `'\r'`, and does
not yield an empty final line after a trailing newline.

### String Utility Functions (std/string)

```milo
let words = "Hello, World!".splitWords()         // ["hello", "world"] (lowercased, alpha-only)
let tokens = "a  b\tc".splitWhitespace()         // ["a", "b", "c"]
```

Strings auto-coerce to `*u8` when passed to FFI functions.

---

## Structs

Structs are value types with move semantics.

```milo
struct Point {
    x: i32,
    y: i32,
}

let p = Point { x: 10, y: 20 }
print(p.x)

// Mutable struct
var q = Point { x: 1, y: 2 }
q.x = 99
```

#### Field shorthand

When an in-scope binding already has the field's name, `{ x }` is shorthand for `{ x: x }`. Mixes freely with explicit fields.

```milo
struct Point { x: i32, y: i32 }
let x: i32 = 10
let y: i32 = 20
let p = Point { x, y }        // same as Point { x: x, y: y }
let q = Point { x, y: 99 }    // shorthand + explicit
```

### Newtypes — distinct type from a single field

A struct with one field is a **newtype**: a zero-cost, distinct type wrapping a value. It compiles to exactly its inner type (the wrapper is elided — same registers, same ABI), but the type checker keeps it separate from the raw type and from every other newtype. This is the idiom for type-safe IDs and indices: give each pool or key space its own newtype and the compiler rejects cross-pool confusion that a bare `i64` would wave through.

```milo error
struct NodeId { idx: i64 }
struct EdgeId { idx: i64 }

fn nodeAt(nodes: Vec<Node>, id: NodeId): Node {
    return nodes.get(id.idx)
}

let e = EdgeId { idx: 3 }
nodeAt(nodes, e)   // compile error: expected NodeId, got EdgeId
```

There is no special newtype syntax — it is just a single-field struct, so it inherits everything structs already have: auto-derived equality, use as a HashMap key (see below), methods via `impl`, and move semantics. Equality and hashing of a newtype are exactly the equality and hashing of the value it wraps.

### Generic Structs

```milo
struct Pair<A, B> {
    first: A,
    second: B,
}

let p = Pair { first: 42, second: "hello" }
```

### Methods (Inherent `impl`)

```milo
struct Dog {
    age: i32,
}

impl Dog {
    fn getAge(self: &Self): i32 {
        return self.age
    }
}

let d = Dog { age: 7 }
print(d.getAge())
```

---

## Enums (Sum Types)

Enums are tagged unions. Variants can carry payloads.

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
```

### Integer-Repr Enums

A C-like enum with an explicit integer representation — `enum Name: i32 { ... }` — carries no payloads and maps each variant to an integer discriminant. Discriminants auto-assign from `0`, or you set them explicitly with `= N` (sparse and out-of-order is fine; counting resumes after an explicit value):

```milo
enum Opcode: i32 {
    LDA = 169,
    STA = 141,
    NOP,            // 142 — resumes after the previous value
}
```

The forward conversion `op as i32` is **always defined** — every variant has a discriminant. The reverse is partial (most integers are not a variant), so it is spelled `Opcode.tryFrom(n): Option<Opcode>` — `Some(variant)` for a known discriminant, `None` otherwise:

```milo skip
let raw = readByte()                          // some i32 off the wire
let Opcode.Some(op) = Opcode.tryFrom(raw) else {
    return handleUnknownOpcode(raw)
}
```

`tryFrom` is generated from the same discriminant list as the cast, so the round-trip law `Opcode.tryFrom(k as i32) == Some(k)` holds for every variant `k` by construction — there is no hand-maintained table to drift. Prefer `tryFrom` over a trapping conversion: on untrusted input (a parser, a decoder) a trap is a denial-of-service, and `Opcode.tryFrom(n)!` gives you the trap in one character when you truly want it.

### Pattern Matching

`match` is exhaustive — the compiler requires you to handle every variant that can hold a
value. A variant whose payload is **uninhabited** is skipped, because there is nothing to
handle: `Result<T, Never>` (where `enum Never { }` has no variants) needs no `Err` arm. Writing
one anyway is legal, and `match e { }` inside it is the explicit way to say the case cannot
occur — an argument the compiler checks, rather than an `abort()` or a comment. A type counts
as uninhabited when it is an empty enum, an enum all of whose variants are uninhabited, a
struct with an uninhabited field, or a fixed-size array of one; a type that reaches itself is
assumed inhabited.

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r) => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
        Shape.Point => { return 0.0 }
    }
}
```

The enum name may be left off when the subject's type already fixes it, which is
usually the case. Both forms are accepted, and they can be mixed:

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

fn area(s: Shape): f64 {
    match s {
        Circle(r) => { return 3.14159 * r * r }
        Rect(w, h) => { return w * h }
        Point => { return 0.0 }
    }
}

var v: Vec<i64> = Vec.new()
v.push(1)

match v.pop() {
    Some(n) => { print(n.toString()) }
    None => { print("empty") }
}

if let Some(n) = v.pop() { print(n.toString()) }
```

A written-out prefix that disagrees with the subject is still an error — eliding is
not the same as ignoring the type.

Use `_` as a wildcard to match remaining variants:

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Point,
}

let s = Shape.Circle(3.14)
match s {
    Shape.Circle(r) => { print("circle") }
    _ => { print("something else") }
}
```

### Generic Enums

Both `Option` and `Result` are built into the language with special syntax support
(see below) — the compiler registers them, no `.milo` file declares them. Their shapes,
for reference only: redeclaring either one is a compile error, since the sugar stays
bound to the builtin and prelude signatures already name it.

```milo skip
enum Option<T> {
    Some(T),
    None,
}

enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

---

## Option and Result

### Option Sugar

`T?` is shorthand for `Option<T>`:

```milo
fn find(id: i32): i32? {
    if id == 1 {
        return Option.Some(42)
    }
    return Option.None
}
```

### Unwrap, Propagate, Default

Every fallible call site must be explicitly handled — `!`, `?`, or `??`. This makes error paths visible in source code, unlike languages where exceptions can silently propagate.

```milo
fn unwrapIt(opt: i32?): i32 {
    return opt!          // unwrap — panic if None (with source location)
}

fn orDefault(opt: i32?): i32 {
    return opt ?? 0      // default — use 0 if None
}

fn doubled(opt: i32?): i32? {
    let v = opt?         // propagate — return None from current function if None
    return Option.Some(v * 2)
}
```

On panic, `!` prints the source location and error message, then exits:
```
error at 12:38: connection refused
```

### Option Combinators

Builtin methods on any `Option<T>`, for the cases where `!`/`?`/`??` don't fit:

```milo
fn half(n: &i32): Option<i32> {
    if n % 2 != 0 { return Option.None }
    return Option.Some(n / 2)
}

fn combinators(opt: i32?): void {
    print(opt.isSome())                       // bool
    print(opt.isNone())                       // bool
    print(opt.unwrapOr(0))                    // T — the default is evaluated eagerly
    print(opt.unwrapOrElse(() => 0))          // T — the closure runs ONLY if None
    print(opt.map((n) => n * 2)!)             // Option<U> — Some(42); None maps to None
    print(opt.andThen((n) => half(n))!)       // Option<U> — f returns an Option; None short-circuits
    print(opt.orElse(() => Option.Some(1))!)  // Option<T> — f runs ONLY if None
}
```

`unwrapOr` and `??` are the same operation; `??` is the terse form, and unlike `unwrapOr`
it has no Copy restriction — `opt ?? "d"` works on an `Option<string>` where
`opt.unwrapOr("d")` is rejected.

`map` transforms the payload; `andThen` is for a callback that is *itself* fallible, so
the result stays one `Option` deep instead of nesting. That is what makes a multi-step
lookup a chain rather than a pyramid of `match`:

```milo
from "std/json" import { Json }

fn name(doc: &Json): string {
    return doc.get("user").andThen((u) => u.str("name")) ?? "anonymous"
}
```

`orElse` is the mirror on the empty side: the callback runs only when the receiver is
`None`, and it returns a whole `Option`, so alternatives chain left to right and the first
`Some` wins. Use `??` instead when you want to leave `Option` and land on a value.

Three rules worth knowing, all consequences of how the payload is reached:

- **`unwrapOr`/`unwrapOrElse` require a Copy inner.** They load the payload out, so for an
  owned type (`string`, `Vec<T>`) that would produce a second owner and a double free. The
  compiler rejects it and points you at `match`, which can move the value out safely.
- **`map` and `andThen` have no such restriction.** Their callbacks receive the payload by
  reference, so nothing is moved out of the receiver — the original stays usable afterwards:

```milo
let s: string? = Option.Some("hello")
let n = s.map((v) => v.len).unwrapOr(0)   // 5
match s { Option.Some(v) => { print(v) } Option.None => {} }   // still owns "hello"
```

- **`orElse` consumes a non-Copy receiver.** Its `Some` branch forwards the receiver's
  payload into the result, so for an owned `T` both would own one buffer; the receiver is
  moved instead, and using it afterwards is a use-after-move error. Clone at the call site
  to keep it. This is the same rule the Result combinators use for their forwarded side.

`map`'s result type is independent of `T` — `Option<i64>.map((n) => n > 5)` is
`Option<bool>`. `andThen`'s is whatever `Option` the callback returns; `orElse`'s is always
the receiver's own type.

### Result Combinators

`Result` carries the same seven combinators as `Option` — `isOk`/`isErr` for
`isSome`/`isNone`, then `unwrapOr`, `unwrapOrElse`, `map`, `andThen`, `orElse` — plus
`mapErr`, which has no Option analogue because `None` carries no payload to map.

The one place the two shapes differ is where the types genuinely differ: **a Result's
failure carries information**, so every callback on the error side receives it.
`Option.unwrapOrElse` takes no arguments; `Result.unwrapOrElse` is handed the error.

```milo
fn halve(n: &i64): Result<i64, string> {
    if n % 2 != 0 { return Result.Err("odd") }
    return Result.Ok(n / 2)
}

fn halveI(n: &i64): Result<i64, i64> {
    if n % 2 != 0 { return Result.Err(-1) }
    return Result.Ok(n / 2)
}

fn combinators(r: Result<i64, string>): void {
    print(r.isOk())                          // bool
    print(r.isErr())                         // bool
    print(r.unwrapOr(0))                     // T — Copy inner only, like Option
    print(r.unwrapOrElse((e) => e.len))      // T — the closure runs ONLY on Err, and sees it
    // E is `string` (non-Copy), so map/andThen each consume `r` — one call per value.
    print(r.map((n) => n * 2).isOk())        // Result<U,E> — Ok payload transformed, Err passed through unchanged
}

fn copyErr(r: Result<i64, i64>): void {
    // E is Copy here, so `r` stays live across every call.
    print(r.map((n) => n * 2).isOk())        // Result<U,E>
    print(r.mapErr((e) => e * 2).isErr())    // Result<T,F> — Err payload transformed, Ok passed through unchanged
    print(r.andThen((n) => halveI(n)).isOk()) // Result<U,E> — f returns a Result; an Err receiver short-circuits
    print(r.orElse((e) => halveI(e)).isOk())  // Result<T,F> — the Err-side andThen: recover, or retype the error
}
```

`map` and `andThen` pass the Ok payload to the callback by reference; `mapErr`, `orElse` and
`unwrapOrElse` do the same with the Err payload. Nothing is moved out of the receiver on the
callback's side, so there is no Copy gate on it. `unwrapOrElse` is the exception, for the
same reason `unwrapOr` is: it *loads the Ok payload out*, so it needs a Copy `T`.

The *other* side is different. Each combinator forwards the variant it does not transform
into its result untouched — `map` and `andThen` carry the Err payload through, `mapErr` and
`orElse` carry the Ok payload through. When that forwarded payload is non-Copy the receiver
and the result would both own one heap buffer and both free it, so the combinator
**consumes the receiver** in that case: use it afterwards and you get a use-after-move
error. Clone at the call site to keep it. When the forwarded payload is Copy, duplicating it
is sound and the receiver stays usable — the same Copy gate `unwrapOr` uses.

`Option.map` and `Option.andThen` need no such rule: the variant they forward is `None`,
which carries no payload, so there is never anything to double-own. `Option.orElse` does
need it — `Some` is the variant it forwards.

The forwarded side is also what pins each combinator's free type parameter. `andThen`'s
callback must return a `Result` whose **error** type equals the receiver's, because the
short-circuit path forwards the receiver's error verbatim and there is no conversion
available there. `orElse` is the mirror: its callback is free to change the error type but
its **ok** type must match, since that is the side being forwarded.

Five combinators from Rust are deliberately absent. `ok()`/`err()` discard the other
variant's payload, and with no GC that payload has to be dropped somewhere — a combinator
that silently frees half its input is the wrong place, so `match` stays the conversion.
`okOr()` is covered by `let else`, which does the same job without `unwrapOr`'s Copy gate.
`expect()` would be `!` plus a message, but it loads the payload out, so it would be
rejected on exactly the owned payloads where `!` works. `filter()` forwards the payload,
so it would consume a non-Copy receiver to answer a question — `opt.map(pred) ?? false`
asks it without taking anything.

`!`, `?` and `??` also work with `Result`. Writing `Result<T>` with one type argument defaults the error type to `string` — `Result<i32>` is `Result<i32, string>`:

Fallible commands with no success data return `Result<Unit, E>`. `Unit` is the
single-value type from the prelude; construct it as `Unit {}`. `void` describes
a function that returns no value and therefore cannot be stored inside `Result`.

```milo
fn finish(): Result<Unit, string> {
    return Result.Ok(Unit {})
}
```

```milo
fn validate(x: i32): Result<i32> {
    if x < 0 {
        return Result.Err("negative")
    }
    return Result.Ok(x)
}

fn doubleValid(x: i32): Result<i32> {
    let v = validate(x)?                // propagate Err
    return Result.Ok(v * 2)
}
```

### if let

For when you only care about one variant:

```milo
let x = Option.Some(42)
if let Option.Some(val) = x {
    print("got ", val)
}
```

Prefer it over a `match` whose other arms are empty. `--deny=single-variant-match`
finds that shape and prints the `if let` to replace it with; the two forms bind the
payload identically (by borrow or by value, same rule as a match arm), so the rewrite
is mechanical. The lint is opt-in.

### while let

Loop as long as the subject matches the pattern, binding the payload each iteration:

```milo
fn readLine(n: i32): Option<string> {
    if n < 3 { return Option.Some("line") }
    return Option.None
}

var i: i32 = 0
while let Option.Some(line) = readLine(i) {
    print(line)
    i = i + 1
}
```

### match as an expression

`match` can appear in expression position — each arm yields a value. Arms may be
a bare expression (`P => v`) or a braced block whose tail is the value:

```milo
let n = 1
let name = match n {
    0 => "zero",
    1 => "one",
    _ => "many"
}

let r: Result<i32> = Result.Ok(21)
let doubled = match r {
    Result.Ok(v)  => { let d = v * 2  d }
    Result.Err(e) => 0
}
```

All arms must agree on a type, and the match must still be exhaustive.

---

## Arrays

Fixed-size, stack-allocated, bounds-checked.

```milo
let arr = [10, 20, 30]
print(arr[0])
print(arr.len)

// Repeat syntax
let zeros = [0; 100]      // 100 zeros

// Mutable arrays
var buf: [u8; 8192] = [0; 8192]
buf[0] = 42
```

Out-of-bounds access is a runtime panic, not silent corruption.

---

## Vec\<T\> — Dynamic Arrays

```milo
var v: Vec<i32> = Vec.new()
v.push(10)
v.push(20)
v.push(30)

print(v[0])           // bounds-checked
print(v.len)

let last = v.pop()            // removes and returns last element
```

Vec owns its elements and frees them when it goes out of scope.

### Constructors

```milo
var a: Vec<i64> = Vec.new()              // empty, no allocation
var b: Vec<i64> = Vec.withCapacity(1024) // empty, pre-sized (no realloc up to 1024 pushes)
var c: Vec<u8>  = Vec.filled(4096, 0)    // 4096 copies of 0 — zeroed buffer
```

`Vec.filled(n, v)` requires `v` to be a `Copy` type (the value is duplicated into
every slot); build a non-`Copy` Vec with a `push` loop.

```milo
// Vec of strings
var names: Vec<string> = Vec.new()
names.push("Alice")
names.push("Bob")
print(names[0])
```

### Functional methods

```milo
let nums: Vec<i32> = [1, 2, 3, 4, 5]
let doubled = nums.map((n: &i32) => n * 2)       // [2, 4, 6, 8, 10]
let evens = nums.filter((n: &i32) => n % 2 == 0)  // [2, 4]
let hasNeg = nums.any((n: &i32) => n < 0)          // false
let allPos = nums.all((n: &i32) => n > 0)          // true
let total = nums.fold(0, (acc: i32, n: &i32) => acc + n)  // 15
nums.each((n: &i32) => print(n))             // side effects
nums.enumerate((i: i64, n: &i32) => {              // index + element
    print(i.toString() + ": " + n.toString())
})

let words: Vec<string> = ["hello", "world"]
print(words.join(", "))                             // "hello, world"
words.contains("hello")                             // true
words.isEmpty()                                     // false
```

`fold(init, (acc, elem) => acc)` is the accumulate half of the set — the callback's
return type must match `init`, which is what the result type comes from. `reduce` is
accepted as a synonym. The initial value is mandatory, so an empty `Vec` returns it
rather than failing.

### Reading elements

`v[i]` panics out of range. The total reads return `Option<T>` instead, cloning the
element out — a reference into the buffer could not survive the next `push`.

```milo
let v: Vec<i64> = [3, 1, 4]
v.get(0)          // Some(3)
v.get(99)         // None
v.first()         // Some(3)
v.last()          // Some(4)
v.min()           // Some(1)
v.max()           // Some(4)
v.indexOf(4)      // Some(2)  — where, not what
v.position((n: &i64) => n > 3)   // Some(2) — the predicate form
v.find((n: &i64) => n > 3)       // Some(4) — the value, not the index
```

`min`/`max`/`indexOf` take the same comparable elements `sort` does — int, float,
string, bool. There is no ordering on a struct (equality and hashing are derived
facts; ordering is an opinion), so use `sortByKey` then `first`, or `fold`.

There is no `binarySearch`: its contract is "the Vec is already sorted", which the
compiler cannot check and a wrong answer does not announce. There is no
`chunks`/`windows` either — both hand back a collection of slices, and a slice is a
second-class reference that cannot be stored in a `Vec`.

### Growing and shrinking

```milo
var a: Vec<string> = ["a"]
var b: Vec<string> = ["b", "c"]
a.extend(b)               // ["a", "b", "c"] — b is moved in, not copied
a.retain((s: &string) => s != "b")   // ["a", "c"] — in place, no second buffer

a.capacity()              // slots allocated
a.reserve(100)            // room for 100 MORE, on top of the current len
```

`extend` takes ownership: the elements transfer bitwise, nothing is cloned, and the
source is gone afterwards (`v.extend(other.clone())` if you still need it).

`retain(pred)` is `filter`'s in-place twin — `filter` allocates a second `Vec`,
`retain` compacts this one and runs drop glue on the elements it discards.

`print` renders a `Vec` as `[a, b, c]` and a `HashMap` as `{k: v}`, recursing into
elements — a `Vec<Vec<i64>>` prints `[[1, 2], [3]]`, and string elements are quoted
so they can't be confused with the separators.

### Mutating methods

```milo
struct User { name: string, age: i32 }

var v: Vec<i32> = [3, 1, 2]
v.sort()                  // [1, 2, 3] — in-place, ascending
v.reverse()               // [3, 2, 1] — in-place

// custom comparator: negative = a first, positive = b first
var users: Vec<User> = [
    User { name: "Alice", age: 30 },
    User { name: "Bob", age: 25 },
]
users.sortBy((a: &User, b: &User) => a.age - b.age)  // full control

// key extractor: just return the field to sort on
users.sortByKey((u: &User) => u.age)                  // simpler
users.sortByKey((u: &User) => u.name)                 // works with strings too
```

```milo
var v: Vec<string> = ["a", "b", "c"]
v.truncate(1)             // ["a"] — elements at index >= 1 are dropped
v.clear()                 // [] — same thing with 0
```

`truncate(n)` runs each discarded element's drop glue, so owned elements (strings,
nested `Vec`s, `Drop` types) are freed rather than leaked. A length at or past the
end is a no-op — it never grows the Vec — and a negative length empties it.

`sort` works on Vec of int, float, string, or bool. `sortBy` and `sortByKey` work on any type. All require `var`.

### clone

`clone()` returns a deep copy: every element is cloned too, so the copy owns independent heap data and later mutations to either side are invisible to the other.

```milo
var v: Vec<string> = ["a", "b"]
var w = v.clone()
w.push("c")                     // v is still ["a", "b"]

var nested: Vec<Vec<string>> = [["x"]]
var n = nested.clone()
n[0].push("y")                  // nested[0] is still ["x"] — elements are cloned, not shared
```

The common use is passing a Vec somewhere the original is still needed. A call that takes both a `&var` argument and a `&` argument reached through the same variable is rejected, because the mutation could reallocate what the shared reference points into — an inline `clone()` breaks the aliasing:

```milo
struct State { keys: Vec<string>, log: Vec<string> }

fn recordLookup(st: &mut State, keys: &Vec<string>): bool {
    st.log.push("lookup")       // may reallocate st's storage
    return keys.len() > 0
}

var st = State { keys: ["a"], log: [] }
// recordLookup(st, st.keys) is rejected — st is borrowed mutably and shared
let found = recordLookup(st, st.keys.clone())   // ok — the callee gets its own copy
```

`clone()` is unavailable on `Vec<SomeInterface>` (the concrete type is erased and the itable carries no clone slot) and on Vec of closures.

### Slices — `&[T]`

A slice is a **non-owning view** over a contiguous run of elements — a fat pointer (`{ptr, len}`) into a `Vec`'s (or array's) backing store. It copies no elements and owns nothing; the source stays alive for the slice's life (the borrow is tracked).

```milo
fn sum(xs: &[i64]): i64 {
    var s = 0
    for x in xs { s = s + x }   // iterate a view — no copy
    return s
}

var v: Vec<i64> = Vec.new()
v.push(10); v.push(20); v.push(30)

print(sum(v))          // a whole Vec coerces to &[i64]
let mid = v[1..3]      // sub-view [20, 30]
print(mid.len)         // 2
print(mid[0])          // 20 — indexed, bounds-checked
print(sum(mid))        // 50
```

A **method** may return a `&[T]` view of its own receiver's storage — the idiom for
exposing a container for zero-copy iteration:

```milo
struct Ring { data: Vec<i64> }
impl Ring {
    fn items(self: &Self): &[i64] { return self.data[0..self.data.len] }
}
// for x in r.items() { ... }   // iterates the view, borrows each element
```

This is the one place a reference leaves a function, and it is bounded on both ends. The
view must be of storage reachable through `self` — a view of a method-local, or of another
`&` parameter, is rejected, since neither survives the freeze the caller takes. And the
call freezes the receiver for the life of the binding, exactly as an inline `r.data[0..n]`
would: while the view is alive, `r` cannot be pushed to, reassigned, moved, or dropped.
A view also cannot be captured by a closure, stored in a struct, or put in a collection.
Free functions cannot return references at all.

`&mut [T]` works as a *parameter* view: a `var` Vec coerces to it, writes land in the
backing store, and the source is frozen for the borrow's life. Two `&mut` views into the
same storage at one call site are rejected when the overlap is decidable:

```milo skip
fn touch(a: &mut [i64], b: &mut [i64]) { a[0] = 1  b[0] = 2 }

touch(v[0..2], v[2..4])    // ok — disjoint
touch(v[0..2], v[1..3])    // error: ranges overlap and are both borrowed mutably
```

One current limit: the bounds have to be literals for that check to fire, and there is no
`splitMut` — no way to hand N workers N disjoint windows into one buffer in a single call.
Range disjointness is linear scalar arithmetic, which `milo prove` already discharges, so
the dynamic case is a planned extension rather than a hole in the model.

---

## HashMap\<K, V\>

Open-addressing hash table with FNV-1a hashing.

```milo
var m: HashMap<string, i32> = HashMap.new()
m.insert("hello", 42)
m.insert("world", 99)

print(m.len)

if m.contains("hello") {
    print("found it")
}

let val = m.get("hello")       // returns Option<i32>
if let Option.Some(v) = val {
    print("value: ", v)
}

let v = m.getOrDefault("hello", 0)  // returns i32 directly (0 if missing)

m.remove("hello")

print(m.isEmpty())
let copy = m.clone()               // deep copy; the two share no heap data
m.clear()                          // drop every entry, keep the table's capacity
```

`HashMap.withCapacity(n)` presizes the table so `n` inserts never rehash:

```milo
var counts: HashMap<string, i64> = HashMap.withCapacity(1000)
```

### keys() and values()

```milo
var m: HashMap<string, i64> = HashMap.new()
m.insert("a", 1)
var ks = m.keys()      // Vec<K>, a deep copy of every live key
var vs = m.values()    // Vec<V>
ks.sort()
```

Both snapshot the map into a fresh `Vec`, so mutating the map afterwards does not
disturb the snapshot. This is the supported way to get a **stable** order out of a
map — collect, then sort (see the order note below). To read entries without
copying, use `for k, v in m`, which borrows.

There is no `entry` / `getOrInsert`. Both hand back a mutable reference *into* the
table, and Milo's references are second-class — they cannot be returned. Count with
the two-lookup form instead:

```milo
var m: HashMap<string, i64> = HashMap.new()
let word = "hello"
m.insert(word, m.getOrDefault(word, 0) + 1)
```

### Iteration

`for` over a map yields keys; the two-binding form yields key and value together:

```milo
var m: HashMap<string, i32> = HashMap.new()

for k in m {
    print(k)
}

for k, v in m {
    print(k, " -> ", v)
}
```

Both bindings are **by reference**, like every other `for-in` — no copy is made, and
neither is assignable inside the loop body.

**Iteration order is unspecified, and deliberately varies run to run.** It follows the
table's internal bucket layout, and the hash is seeded from the OS entropy source once per
process — so the same program over the same keys enumerates in a different order on every
run. That is a HashDoS defense, not an accident: an attacker who picks your keys cannot
force every one of them into the same bucket. Consequences:

- Do not print a map entry-by-entry and compare the output — a test written that way passes
  locally and fails in CI. Accumulate into a sum, or collect into a `Vec` and sort first.
- Do not persist or transmit anything derived from the order or from a hash value.
- Do not mutate the map while iterating it.

### Keys

A key type must be **hashable**: an integer, `bool`, `string`, or a **struct all of whose fields are hashable** (recursively). Struct keys are hashed and compared *structurally* — field by field — so newtypes and small value types work as keys with no boilerplate:

```milo
struct Point { x: i64, y: i64 }
var grid: HashMap<Point, string> = HashMap.new()
grid.insert(Point { x: 1, y: 2 }, "wall")
grid.get(Point { x: 1, y: 2 })   // Some("wall")
```

Two guarantees, and one non-guarantee:

- **Equality and hashing agree.** Both derive from the same field recursion, so `a == b` implies `hash(a) == hash(b)` by construction — the coherence law a hand-written hash could violate.
- **Ordering is not automatic.** Equality and hashing are structural *facts* and are derived for you; ordering embeds an *opinion* (which field ranks first) and is not. There is no `<` on structs and no `sort()` on a `Vec` of them unless you opt in — sort by an explicit key with `sortBy` instead.
- **Hash values are not stable** across compiler versions or program runs. Do not persist them, hash across a wire, or otherwise depend on a specific value — they are for in-memory lookup only.

---

## Heap\<T\> — Heap Allocation

`Heap<T>` is a single-owner heap pointer. Useful for recursive data structures.

```milo
// Recursive enum — must heap-allocate the recursive case
enum Tree {
    Node(Heap<Tree>, Heap<Tree>),
    Leaf(i32),
}

fn sum(t: Tree): i32 {
    match t {
        Tree.Leaf(n) => { return n }
        Tree.Node(left, right) => {
            return sum(*left) + sum(*right)
        }
    }
}

let tree = Tree.Node(
    Heap(Tree.Leaf(1)),
    Heap(Tree.Leaf(2))
)
print(sum(tree))   // 3
```

Heap auto-frees when it goes out of scope.

`Heap<T>` is single-owner (like Rust's `Box`) — it models trees and recursive types, not cycles or cross-references. For those, use an arena.

## Arenas — cyclic & shared data

`std/arena` provides `Arena<T>` plus a `Copy` generational `Handle<T>`. Nodes store *handles* to each other (never `&T`), so linked lists, graphs, and parent-pointer trees work without lifetimes or `Rc<RefCell>`. A freed handle bumps the slot's generation, so a stale handle reads back as `None` — use-after-free is caught, not UB.

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaModifyMut }

struct GNode { id: i32, edges: Vec<Handle<GNode>> }   // handles stored freely — Copy

var g = arenaNew<GNode>()
let a = arenaAlloc(g, GNode { id: 0, edges: Vec.new() })
let b = arenaAlloc(g, GNode { id: 1, edges: Vec.new() })
arenaModifyMut(g, a, (n: &mut GNode) => { n.edges.push(b) })   // a -> b, no borrow stored
```

Slices (`v[a..b]`), `Heap<T>`, and `std/arena` together cover the cases Rust uses lifetimes for. The one thing none of them express is a type that *stores a borrow* (`struct Parser<'a> { src: &'a str }`) — own the data or hold an index instead. See [ownership-model.md](ownership-model.md) for the full Rust→Milo mapping.

---

## Ownership and Move Semantics

Values have a single owner. Assignment transfers ownership.

```milo
let a = "hello"
let b = a          // a is moved into b
// a is now invalid — using it here is a compile error
print(b)         // fine
```

This applies to structs, enums, strings, Vec, HashMap, and Heap.
Primitive types (`i32`, `bool`, `f64`, etc.) are copied, not moved.

A struct whose fields are all Copy is itself Copy, and so is never move-tracked.

Ownership is tracked per **place**, not per variable, so a field can be moved out on
its own and the rest of the struct stays usable:

```milo
struct Pair {
    a: string,
    b: string,
}

fn main() {
    var p = Pair { a: "one", b: "two" }
    let x = p.a        // p.a is moved out; p.b is untouched
    print(x)
    print(p.b)         // fine — a different place
    p.a = "three"      // assignment puts a value back
    print(p.a)         // fine again
}
```

Using the field after it was moved is an error, the same as for a whole variable:

```milo error
struct Pair {
    a: string,
    b: string,
}

fn main() {
    let p = Pair { a: "one", b: "two" }
    let x = p.a
    print(x)
    print(p.a)         // error: use of moved value 'p.a'
}
```

And once a field has left, the struct is no longer whole, so passing it on is an
error too — it would hand the next owner an empty field dressed up as data:

```milo error
struct Pair {
    a: string,
    b: string,
}

fn take(p: Pair): i64 {
    return p.b.len()
}

fn main() {
    let p = Pair { a: "one", b: "two" }
    let x = p.a
    print(x)
    print(take(p))     // error: 'p.a' was already moved out of it
}
```

Using the struct **as a whole** while a field is missing is an error as well, since it
would show the emptied field as if it were data:

```milo error
struct Pair {
    a: string,
    b: string,
}

fn main() {
    let p = Pair { a: "one", b: "two" }
    let x = p.a
    print(x)
    print(p)           // error: 'p' is incomplete: 'p.a' was moved out of it
}
```

A type with a `Drop` impl cannot be taken apart at all. `drop` runs against the whole
value, so a destructor that found one of its fields already gone would be reading an
empty one:

```milo error
struct Res {
    name: string,
}

impl Drop for Res {
    fn drop(self: &mut Self) {
        print("dropping " + self.name)
    }
}

fn main() {
    let r = Res { name: "alpha" }
    let stolen = r.name    // error: cannot move 'r.name' out of 'Res', which implements Drop
    print(stolen)
}
```

An index is a runtime value, so `v[i]` is not tracked this way — see
[docs/backlog.md](backlog.md) on the container-dependent answer.

### `@noCopy` — move-tracked handles

That rule is wrong for one important shape: the **resource handle**. A GL texture name,
a file descriptor, an index into a foreign table — each is an integer, so the all-fields-
Copy rule makes it Copy, and move checking never engages for exactly the type most likely
to be used after it has been released.

`@noCopy` says the type is move-tracked however plain its fields are:

```milo error
@noCopy
struct Texture {
    id: u32,
    w: i64,
}

impl Texture {
    // Borrows — call as often as you like.
    fn bind(self: &Self) {
        print(self.id)
    }

    // Consumes — ends the handle's life.
    fn free(self: Self) {
        print(self.id)
    }
}

let t = Texture { id: 7, w: 640 }
t.bind()
t.free()
t.bind()    // error: use of moved variable 't'
```

The attribute takes no arguments, and every instantiation of a `@noCopy` generic inherits
it: `Slot<i32>` is no more copyable than the `Slot<T>` it came from.

**A `Drop` impl already implies this** — a type with a destructor is never Copy. Reach for
`@noCopy` when the release has an ordering requirement the compiler cannot see, so a
destructor would be wrong: `glDeleteTextures` needs the GL context that made the texture
to still be current, and a `Drop` firing during teardown or on a thread with no context is
undefined behaviour rather than a leak. `@noCopy` is move-tracked with **no destructor** —
forgetting to release is still a leak, but releasing twice, or using after release, is a
compile error.

### `@copyOnly` — generics that may only hold Copy types

The dual of `@noCopy`. A generic that moves elements through a raw pointer, such as
`std/shard`'s `Shard<T>` reading `self.base[i]`, performs a bitwise copy of `T`. For a
Copy `T` that is the value; for a `string` it is a second owner of the same heap block,
freed twice. There is no `T: Copy` bound grammar. `@copyOnly` on the generic struct or
generic fn says every instantiation must use Copy type arguments, and a violation is
reported where the type was written or inferred, naming the type you wrote and not the
monomorphized instance:

```milo error
@copyOnly
struct Cells<T> {
    first: T,
    len: i64,
}

let c: Cells<Vec<i64>> = Cells { first: Vec.new(), len: 0 }
// error: 'Cells<Vec<i64>>' is not allowed: 'Cells' is @copyOnly and 'Vec<i64>' is not a Copy type (it owns heap memory)
```

Copy is structural: scalars, `bool`, raw pointers, payload-free enums, and structs and
enums whose fields are all Copy. `Drop` and `@noCopy` types are never Copy. Bare,
`@copyOnly` constrains every type parameter; `@copyOnly(T)` names the ones it applies
to, for a generic such as `parallelMapWith<T, S>` whose per-worker state `S` never
crosses the raw pointer and may own a `Vec`. It is rejected on a declaration with no
type parameters. The standard library writes it on `Shard`, `Shards`, `parallelMap` and
`parallelMapWith`, which is why `shatter` of a `Vec<string>` does not compile.

The attribute cannot be forgotten by omission. A generic body is only ever checked as
an instance, and the unsound instance is the one nobody wrote, so the compiler scans
the generic *template*: inside a generic fn or a generic struct's method that is not
`@copyOnly`, reading an element by value through a raw pointer declared `*T` (`p[i]`,
`self.base[i]`) is an error, `reading 'T' by value through a raw pointer copies it
bitwise; 'T' may own memory`. Writes (`self.base[i] = v`), borrows (`self.base[i].len`)
and `memcpy`/`memset`/`zeroed` moves are untouched; `std/sync`'s `Channel<T>` moves
values through its ring buffer that way and stays clean.

### Move in Branches

The compiler tracks moves through control flow:

```milo
struct Point { x: i32, y: i32 }

fn consume(p: Point): void {
    print(p.x)
}

let condition = true
let p = Point { x: 1, y: 2 }
if condition {
    consume(p)     // p moved here
} else {
    consume(p)     // p moved here — OK, only one branch executes
}
// p is invalid after the if/else regardless of which branch ran
```

---

## References (Second-Class)

References can appear as function parameters and local variables, but cannot be
returned from functions or stored in structs/collections. This eliminates dangling
references by construction — no lifetime annotations needed.

```milo
// Immutable reference
fn length(s: &string): i64 {
    return s.len
}

// Mutable reference
fn double(x: &mut i32) {
    x = x * 2
}

var n: i32 = 21
double(n)          // n is now 42

// Ref locals — zero-copy slices
fn process(content: &string): void {
    let header = content[0..80]   // &string slice, no allocation
    print(header.len)             // auto-deref for methods/fields
}
```

Two things to be aware of:

- **Borrowing is implicit at call sites.** `double(n)` mut-borrows `n` and `consume(s)` moves `s`, but the calls look identical — the function signature, not the call site, tells you which happens. The compiler still rejects any use-after-move, so mistakes are compile errors, not bugs.
- **Assignment through `&mut` has no deref sigil.** Inside `double`, `x = x * 2` writes through the reference to the caller's variable. (Reassigning a `&string` slice *local*, by contrast, just rebinds the view — see [Strings](#strings).)

**What you can't do:**

```milo error
fn bad(s: &string): &string {     // COMPILE ERROR: can't return a reference
    return s
}
```

```milo error
struct Bad { r: &string }         // COMPILE ERROR: can't store a reference
```

You also cannot move a non-`Copy` value *out* of a reference — not the whole pointee, and
not one of its fields. Both would shallow-copy a heap buffer the borrow does not own, leaving
two owners and a double free:

```milo error
struct Doc { text: string }

fn describe(d: &Doc): string {
    return d.text                 // COMPILE ERROR: cannot move the borrowed value out of 'd'
}
```

Write `return d.text.clone()` to take an owned copy. `clone()` exists on every type for this
reason, including `Copy` scalars where it is the identity — so a generic
`fn get<T>(w: &Wrapper<T>): T { return w.val.clone() }` compiles for `T = i64` and
`T = string` alike.

`sortByKey`'s key extractor is the one exemption: the sort reads the key to compare it and
never stores or drops it, so `users.sortByKey((u: &User) => u.name)` is the supported way to
sort by a string field. Every other closure is subject to the rule, `map` included — it
*keeps* what the closure returns, so `users.map((u: &User) => u.name.clone())` needs the
clone, and the allocation it costs is meant to be visible.

This is Milo's key insight: by restricting where references can live, you get
memory safety without a borrow checker or lifetime annotations.

For *why* this design is shaped this way — how it compares to Rust's lifetimes,
why it's "guardrails, not magic," and how to do zero-copy work without stored
references — see **[ownership-model.md](ownership-model.md)**.

---

## Traits

Traits define shared behavior across types.

```milo
trait Eq {
    fn eq(self: &Self, other: &Self): bool
}

struct Point { x: i32, y: i32 }

impl Eq for Point {
    fn eq(self: &Self, other: &Self): bool {
        return self.x == other.x && self.y == other.y
    }
}
```

### Default Methods

```milo
trait Greet {
    fn greet(self: &Self): i32 {
        return 42    // default implementation
    }
}

struct Cat { name: i32 }
impl Greet for Cat {}    // uses the default
```

### Generic Bounds

```milo
fn printIfEqual<T: Eq>(a: &T, b: &T) {
    if a.eq(b) {
        print("equal!")
    }
}
```

Multiple bounds:

```milo
trait Hash {
    fn hash(self: &Self): i64
}

fn process<T: Eq + Hash>(a: &T, b: &T): i64 {
    if a.eq(b) {
        return a.hash()
    }
    return b.hash()
}
```

A generic struct can carry bounds too, and they are enforced at every
instantiation — the bound is what makes the wrapper's own methods legal to write:

```milo
struct Buffered<R: Reader> {
    inner: R,
}
```

`Buffered<i64>` is then rejected where it is spelled, not deep inside the
wrapper's body. Bounds on an `impl` block are parsed but carry no meaning; write
the bound on the struct or enum declaration.

### Supertraits

```milo
trait Ord: Eq {
    fn compare(self: &Self, other: &Self): i32
}
```

### @derive

Auto-generate implementations:

```milo
@derive(Eq)
struct Point { x: i32, y: i32 }

@derive(Json)
struct Config { host: string, port: i32 }
```

`Eq` synthesizes field-wise equality. `Clone` synthesizes a field-wise `clone()`: Copy
fields are copied, heap fields cloned. `Json` synthesizes `toJson` / `fromJson` /
`fromJsonNode` — see [JSON Serialization](#json-serialization). They compose:
`@derive(Eq, Clone, Json)`.

`Eq` and `Clone` are also derived **automatically** for every non-generic struct whose
fields support them, so both work with no annotation on plain data. `Clone` skips resource
types: a struct with a `Drop` impl or `@noCopy` never receives an automatic `clone()`,
since each copy would release the resource again, and an explicit `@derive(Clone)` on one
is an error naming the reason.

### Writing your own derive

`derive <Trait> { … }` declares the impl body a `@derive(Trait)` expands to, so a derive
ships in a library instead of in the compiler:

```milo
pub trait Describe { fn describe(self: &Self): string }

pub derive Describe {
    fn describe(self: &Self): string {
        var out = "@Self("
        @fields {
            out.pushStr($"@name=@{self.@name} ")
        }
        return out + ")"
    }
}

@derive(Describe)
struct Point { x: i64, y: i64 }
```

The body is a template, not code. It is expanded per struct by substitution and the result
is handed to the ordinary parser, so a derive can produce nothing you could not have typed
by hand, and the generated code is bound by the same checker rules.

| Hole | Substitutes |
|---|---|
| `@Self` | the struct's name, as an identifier |
| `@SelfStr` | the struct's name, as a string literal |
| `@count` | the number of fields, as an integer literal |
| `@fields { … }` | repeats the block once per field |
| `@name` | the field's name, as an identifier — inside `@fields` only |
| `@nameStr` | the field's name, as a string literal |
| `@type` | the field's written type |
| `@typeStr` | the field's written type, as a string literal |
| `@index` | the field's position, as an integer literal |
| `@@` | a literal `@` |

Holes also substitute inside string and f-string literals, which is what makes a template
readable. A field hole outside `@fields` is an error rather than an empty string.

`@fields` is the only control construct, and it repeats over a list the struct declaration
fixes, so expansion always terminates — this is deliberately a template mechanism and not
a macro system. Nesting `@fields` inside `@fields` is an error, a template may not take a
built-in derive's name (`Eq`, `Clone`, `Json`), and a derive is private to its file unless marked
`pub`.

Generic structs are not supported: `@derive` skips a struct with type parameters, built-in
or user-defined.

#### How this differs from Rust's `#[derive]`

The surface looks the same and the mechanism is deliberately much weaker. Rust's derives are
**procedural macros**: arbitrary Rust that runs at compile time, takes a token stream and
returns one, shipped in a separate crate compiled for the host. Milo's are substitution over
a template, with no user code running at compile time and one control construct that repeats
over a list the struct declaration fixes — so expansion always terminates, needs no separate
compilation target, and produces only what you could have typed by hand.

The reason that is not the limitation it sounds like: **what makes Rust's derives powerful
is not the macro, it is the blanket impls.** `serde` branches on field types through
`impl<T: Serialize> Serialize for Vec<T>`; its macro mostly emits `self.field.serialize()`.
A Milo template emits the same thing and gets the same dispatch from ordinary traits — a
complete recursive JSON codec is about twenty lines
(`tests/fixtures/deriveTemplateJson.milo`). Where it stops today is container fields, for
want of `impl ToJson for Vec<T>`, not for want of macro power.

So if you are reaching for compile-time code execution to make a derive work, the thing to
ask for is usually the missing impl, not the missing macro.

---

## Interfaces (Runtime Polymorphism)

Interfaces enable dynamic dispatch via structural typing. Any type with matching methods satisfies an interface — no explicit declaration needed.

```milo
interface Greeter {
    fn greet(self: &Self): string
}

struct Dog { name: string }
impl Dog {
    fn greet(self: &Self): string {
        return "woof from " + self.name
    }
}

struct Cat {}
impl Cat {
    fn greet(self: &Self): string {
        return "meow"
    }
}

fn sayHello(g: &Greeter) {
    print(g.greet())
}

fn main(): i32 {
    let d = Dog { name: "Rex" }
    let c = Cat {}
    sayHello(d)  // woof from Rex
    sayHello(c)  // meow
    return 0
}
```

### How It Works

- Interface values are fat pointers: `{ data_ptr, itable_ptr }`
- The compiler generates an itable (interface table) for each concrete type / interface pair
- Method dispatch is an indirect call through the itable — like Go, unlike C++ vtables embedded in objects
- Structural satisfaction: if a type has all required methods with matching signatures, it satisfies the interface

### Interfaces vs Traits

| | Traits | Interfaces |
|---|---|---|
| Dispatch | Static (monomorphization) | Dynamic (vtable/itable) |
| Typing | Nominal (`impl Trait for Type`) | Structural (methods match → satisfies) |
| Use case | Generic bounds, operator overloading, `@derive` | Runtime polymorphism, heterogeneous collections |

Both inherent methods (`impl Type`) and trait methods (`impl Trait for Type`) count toward interface satisfaction.

### Restrictions (v1)

- Interface methods must take `self: &Self` (by reference, not by value)
- No generic parameters on interfaces
- No interface inheritance
- No downcasting from `&Interface` to `&ConcreteType`

---

## Closures

Arrow syntax. Closures can be passed as function arguments
or stored in local variables.

```milo
// Expression closure
let double = (x: i32) => x * 2

// Block closure
let clamp = (x: i32): i32 => {
    if x < 0 { return 0 }
    if x > 100 { return 100 }
    return x
}

// Passed as argument
fn apply(f: (i32) => i32, x: i32): i32 {
    return f(x)
}
let result = apply(double, 21)   // 42
```

### Capturing Variables

Regular closures capture by reference — mutations are visible outside:

```milo
var count: i32 = 0
let inc = () => { count = count + 1 }
inc()
inc()
print(count)   // 2
```

### Move Closures

`move` closures capture by value (copy into a heap-allocated environment).
Safe to return from functions, store in structs, and send to threads.

Because it holds that environment, a `move` closure that captured something **owns** it,
and its type says so: `move (T) => R`. That type is not `Copy` — there is exactly one of
the value, and passing it on transfers it:

```milo
fn run(f: move () => void): void {
    f()
}
```

The reason is ownership, not ceremony. A closure value is a pair of pointers, one of them
to the environment; if the value could be duplicated, two copies would own one environment
and any release of it would be a double free. That is why a plain function pointer and a
by-reference closure stay `Copy` — they own nothing — and why only a `move` closure that
actually captured something is restricted. `move` with no captures owns nothing either, so
it is `Copy` like the rest.

A non-owning value passes to a `move` parameter freely, since nothing is lost by
transferring something that owns nothing:

```milo
fn bare(): void {
    print("hi")
}

fn run(f: move () => void): void {
    f()
}

fn demo(): void {
    run(bare)                       // a function value
    run((): void => {               // a by-reference closure
        print("hi")
    }
    )
}
```

A closure **literal** passed to a function that takes an owned `Fn` parameter has `move` inferred — no keyword needed — because a literal has no other user. That inference is the only place it happens, and it declines when a capture is a `var`, since move-capturing would drop the write-back to the original.

Everywhere else, a closure that captures by reference **may not escape the function it was written in**. It is a pointer into that frame, so it is safe to call and unsafe to keep, and all of these are rejected:

```milo error
fn make(): () => i64 {
    let s = "hello"
    return () => s.len()        // cannot return a closure that captures 's' by reference
}
```

The same applies to every other way out of the frame — a field, a collection, or a callee
that keeps what you hand it:

```milo error
struct Box {
    f: (i64) => i64,
}

fn wrap(g: (i64) => i64): Box {
    return Box { f: g }         // (fine here: `g` is wrap's own parameter)
}

fn make(): Box {
    let n = 5
    let f = (x: i64) => x + n
    var b = Box { f: move (x: i64) => x }
    b.f = f                     // cannot store … — the field outlives the frame
    return wrap(f)              // cannot pass … to 'wrap', which keeps it
}
```

Whether a callee *keeps* its argument is worked out from its body, not declared: a fn-typed parameter that is only ever **called** is consumed during the call, so passing it a borrowing closure is fine. `each` below is accepted for that reason, and so is a one-line wrapper that forwards to it.

```milo
fn each(g: (i64) => i64) { print(g(1)) }

let n = 5
let f = (x: i64) => x + n
each(f)                         // fine — `each` calls `g`, it does not keep it
```

`move` is the escape hatch in every case, including a `var` capture. It is deliberately not applied for you: the allocation is real, and a `move` you wrote is a move the checker can see at the point it happens — so a read of the capture afterwards is a proper `use of moved variable` rather than a silently empty value.

```milo
fn makeAdder(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x + n
    }
}

fn makeMultiplier(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x * n
    }
}

let add5 = makeAdder(5)
print(add5(3))    // 8
print(add5(10))   // 15

// Compose closures
fn compose(f: (i32) => i32, g: (i32) => i32): (i32) => i32 {
    return move (x: i32): i32 => { return f(g(x)) }
}
let add5ThenDouble = compose(makeMultiplier(2), makeAdder(5))
```

### Closures in Structs

```milo
struct Handler {
    name: string,
    callback: (i32) => i32,
}

fn makeMultiplier(n: i32): (i32) => i32 {
    return move (x: i32): i32 => {
        return x * n
    }
}

let h = Handler { name: "doubler", callback: makeMultiplier(2) }
let cb = h.callback
print(cb(10))   // 20
```

---

## Control Flow

```milo
let x: i32 = 5
let n: i32 = 42

// if/else
if x > 0 {
    print("positive")
} else if x == 0 {
    print("zero")
} else {
    print("negative")
}

// if-else expression — both branches must have same type
let label = if x > 0 { "positive" } else { "negative" }

// else-if chains work too
let size = if n < 10 { "small" } else if n < 100 { "medium" } else { "big" }

// while
var i: i32 = 0
while i < 10 {
    if i == 5 { break }
    if i % 2 == 0 {
        i = i + 1
        continue
    }
    print(i)
    i = i + 1
}
```

---

## Modules and Imports

```milo
// Import specific items (required — no wildcard imports)
from "std/http" import { Context, Response, Router, serveRouter }
```

```milo skip
// Import from a relative path (resolved against the importing file's directory)
from "lib/math" import { add, multiply }
```

All imports must be explicit — list exactly which symbols you use. No `import *` or bare `import "path"`. The LSP provides autocomplete for both module paths and symbols.

---

## Visibility

Declarations are **file-private by default**. A name is visible only inside the file
that declares it; `pub` exports it so other files can import or reference it.

```milo skip
pub fn parse(s: string): Result<Doc, Error> { ... }   // exported — importable elsewhere
fn scanToken(s: string, i: i64): Token { ... }        // file-private — this file only
```

Referencing a non-`pub` declaration from a different file is a compile error. The
unit of privacy is the file, matching how imports already work.

`pub` applies to top-level declarations: `fn`, `struct`, `enum`, `trait`, `type`,
`interface`, and globals (`let`, `var`, `thread_local`). A `pub struct` exposes its
fields — field-level visibility is all-or-nothing per struct.

Two things `pub` does **not** mark:

- **`impl` blocks.** An impl's visibility follows the type it implements — there is
  no separate spelling for it.
- **`import`s.** An import binds a name locally; it does not re-export it.

`pub` is distinct from `@externalLinkage`, which forces external C linkage (see
[C FFI](#c-ffi)). A `pub fn` is visible to other Milo files; an `@externalLinkage fn`
is visible to the C linker.

`pub` is a **soft keyword**: it is only special immediately before a declaration, so
it remains usable as an ordinary identifier (`var pub = 5`, `fn pub()`).

---

## C FFI

### Extern Functions

Declare external C functions with `extern`:

```milo
extern fn puts(s: *u8): i32
extern fn printf(fmt: *u8, ...): i32
extern fn malloc(size: u64): *u8
```

### Safe vs Unsafe Extern Calls

The compiler determines whether an extern call needs `unsafe` based on the argument types and return type.

**Safe** (no `unsafe` needed) when:
- All pointer params receive auto-coerced args: `string`→`*u8`, `[T;N]`→`*T`, matching `*T`→`*T`
- Function-typed params receive a matching Milo function
- By-value `extern struct` args (exact type match) — a POD bit-copy with no provenance
- Return type is scalar, `void`, or a by-value `extern struct`

**Unsafe** when:
- Return type is a pointer (`*T`) — unknown provenance
- A param takes a raw `*T` that isn't from auto-coercion

```milo
extern fn puts(s: *u8): i32
extern fn write(fd: i32, buf: *u8, len: i64): i64
extern fn malloc(size: u64): *u8

fn main(): i32 {
    puts("Hello from C!")             // safe — string auto-coerces, returns i32
    write(1, "output", 6)             // safe — string auto-coerces, returns i64
    unsafe { let p = malloc(64) }     // unsafe — returns *u8
    return 0
}
```

### Unsafe Blocks

`unsafe { }` is required for operations the compiler can't verify:

```milo
extern fn malloc(size: i64): *u8

var x: i32 = 5
unsafe {
    let p = malloc(64)        // extern returning pointer
    p[0] = 42 as u8           // pointer indexing
    let val = *p              // pointer deref
    let q = x.addrOf() as *u8 // address of a variable (see below)
}
```

Exception: `0 as *T` (null pointer literal) does not require `unsafe`.

#### `@unsafe fn`: an obligation the caller carries

Every rule above triggers on an *operation*. A function can be built entirely from
operations the compiler checks and still be unsound to call with the wrong arguments:
`std/foreign`'s `withRaw(p, len, f)` does nothing but a null test and a slice construction,
and the length is the caller's word. `@unsafe` on the declaration puts the obligation where
the knowledge is:

```milo skip
@unsafe
pub fn withRaw<T, R>(p: *T, len: i64, f: (&[T]) => R): Option<R> { ... }

unsafe {
    let n = withRaw(buf, count, (bytes: &[u8]): i64 => bytes.len)
}
```

Calling one outside an `unsafe` block is an error. Nothing about the body is checked
differently. The attribute is a claim about the *contract*, so it is never inferred and
never applies to an `extern fn`, whose unsafety is already decided by its signature.

### string.cstr()

Returns the string's `*u8` data pointer without `unsafe`. The string remains alive in the caller's scope, so the pointer is valid.

```milo
let msg = "hello"
let ptr = msg.cstr()               // *u8, no unsafe needed
extern fn strlen(s: *u8): i64
let len = strlen(ptr)              // safe — *u8 arg matches *u8 param
```

### Raw pointers: `v.ptr()`, `h.ptr()` and `x.addrOf()`

`&` is a borrow marker: it appears only in a **type** (`&T` = a borrowed
parameter), never in an expression. To take a raw pointer, use a method, split by
what it points at:

- **`v.ptr(): *T`** — a `Vec`'s backing data pointer (its first element). Safe to
  call (like `string.cstr()`); the `Vec` stays alive in the caller.
  ```milo
  var buf: Vec<u8> = [72, 73, 10]
  extern fn write(fd: i32, p: *u8, n: i64): i64
  unsafe { write(1, buf.ptr(), 3) }
  ```
- **`h.ptr(): *T`** — a `Heap<T>`'s box pointer: the allocation itself, not the
  slot holding it. Safe to call for the same reason `v.ptr()` is, and the give leg
  that [`adopt`](std/foreign.md) is the take leg of. A `Heap<T>` whose `T` has its
  own `ptr` method keeps that method; `Heap<SomeInterface>` has no `ptr()` at all,
  because an interface box is a pair (allocation, vtable) and no single raw pointer
  stands for it.
  ```milo
  from "std/foreign" import { adopt }
  struct Point { x: i64, y: i64 }
  let h = Heap(Point { x: 1, y: 2 })
  unsafe {
      let raw = h.ptr()              // *Point — hand this to C
      forget(h)                      // Milo's ownership ends here
      let _back = adopt(raw)         // ...and comes back with adopt
  }
  ```
- **`x.addrOf(): *T`** — the address of any lvalue (a variable, field, or index).
  Requires `unsafe`; `addrOf` is a reserved method name.
  ```milo
  extern fn write(fd: i32, p: *u8, n: i64): i64
  var count: i64 = 5
  unsafe { write(1, count.addrOf() as *u8, 8) }
  ```

For a `Vec`, `v.ptr()` is the data buffer's address; `v.addrOf()` is the `Vec`
header's address. The same split holds for a `Heap<T>`: `h.ptr()` is the box,
`h.addrOf()` is the slot that points at it. A fixed array `[T; N]` coerces to `*T` at an FFI call — pass it
bare. A pointer to an absolute address is `<int> as *T` (in `unsafe`).

### Opaque Foreign Types

`extern type` declares a type with no known size or layout. It can only exist behind a pointer:

```milo
extern type sqlite3
extern type sqlite3_stmt

extern fn sqlite3_open(path: *u8, db: **sqlite3): i32
extern fn sqlite3_close(db: *sqlite3): i32
```

The compiler rejects using an opaque type by value — only `*sqlite3` is valid. `*sqlite3` is a distinct type from `*sqlite3_stmt` and `*u8`, preventing handle mixups at compile time.

```milo
// null pointer to opaque type — always safe
let db: *sqlite3 = 0 as *sqlite3
```

### Extern Structs

`extern struct` declares a C-layout struct. The compiler knows field offsets and generates GEP instructions for field access:

```milo
extern struct SockAddrIn {
    sin_family: u16,
    sin_port: u16,
    sin_addr: u32,
    sin_zero: [u8; 8],
}
```

#### C function-pointer fields

A field typed `(A, B) => R` inside an `extern struct` is a **thin C function pointer**: one
word, the code pointer alone. Everywhere else in the language a fn value is a
`{ code, environment }` pair; only the code half has a C representation, so this field is
laid out, `sizeOf`'d, `@cLayout`-checked and published by `milo build-lib` exactly as C's
`int32_t (*read)(uint8_t*, int32_t)`.

```milo
extern struct Ops {
    read: (*u8, i32) => i32,
}

fn readCount(_p: *u8, n: i32): i32 {
    return n
}

fn main() {
    let ops = Ops {
        read: readCount,
    }
    unsafe {
        print(ops.read(0 as *u8, 41))       // indirect call, no environment argument
    }
    print(isNull(ops.read))                 // the only other thing you may do with it
}
```

Two values may be stored: a top-level `fn` whose signature matches exactly, and another
fn-pointer field of the same type (a pointer copy). A closure is rejected — the field has
nowhere to put its environment, so the C call would read garbage.

Two things may be done with one: call it, which requires `unsafe` (it may be null, and its
real signature is the declaration's word, exactly as in C), and `isNull(s.field)`, because a
C ops table routinely leaves an optional callback null. Binding it to a local, passing it to
a `(A, B) => R` parameter, returning it, or storing it in a collection are all errors: each
would need the thin pointer to become a fat one, which means inventing an environment.

The parameter and return types of such a field must themselves be C-representable, by the
same rule the surrounding struct obeys. A `move (A, B) => R` field is rejected rather than
thinned: it owns a heap environment, which is the one thing a C field cannot hold.

#### Verifying a signature: `@cSig`

An `extern fn` is the same kind of claim an `extern struct` is, and nothing checks it —
C linkage has no mangling, so a wrong parameter type or arity links fine and corrupts at
the ABI seam. `@cSig(header, signature)` verifies it at build time:

```milo
@cSig("unistd.h", "long sysconf(int)")
extern fn sysconf(name: i32): i64
```

Why you write the C signature rather than the compiler deriving it: **Milo's type system
can't express C type identity.** `i64` is a 64-bit integer, but C distinguishes `long`
from `long long` — on macOS `int64_t` *is* `long long`, so a derived declaration would
reject the correct `sysconf` above. The signature states which C type is meant; the build
then checks three independent claims, and says which one broke:

1. the stated signature really is what the header declares (via `__builtin_types_compatible_p`)
2. the Milo return type's width and signedness match that C return type
3. each Milo parameter's width — and, for a pointer, its pointee's width — matches the C
   parameter in the same position

```
error[c-decl]: a declaration does not match the C header it claims to describe
  sysconf: Milo declares a 4-byte return, C returns a different width
```

Write the signature exactly as the header spells it, including pointer types
(`"ssize_t read(int, void *, size_t)"`) — that's what makes pointer-taking functions
checkable at all.

Claim 3 is the one an out-param needs. An out-param is the callee writing into the
caller's frame, so the pointee width *is* the contract, and nothing else in the pipeline
can see it — the ABI passes one machine word whatever the pointee:

```
error[c-decl]: a declaration does not match the C header it claims to describe
  glGetShaderiv parameter 3: Milo writes through a *u16 (2-byte pointee), OpenGL/gl3.h says 'GLint *'
```

A Milo `*u8` parameter is the **opt-out**: it stands for C's `void *` and for any pointer
whose pointee Milo does not model, and its pointee is never checked. Spell the real
pointee whenever you know it.

Arity is checked in the type checker, before any header is read — a signature listing a
different number of parameters than the declaration would shift every comparison above by
one. Parameter *signedness* is not checked (a C `size_t` against a Milo `i64` is common
and harmless), and neither is any parameter of a signature that takes a function pointer.

**When the header has no portable name**, separate alternates with `|` — the first one
`__has_include` finds wins — and prefix a path with `+`-separated feature macros it needs
before it declares anything:

```milo
@cSig("OpenGL/gl3.h|GL_GLEXT_PROTOTYPES+GL/glcorearb.h", "void glGenBuffers(GLsizei, GLuint *)")
extern fn glGenBuffers(n: i32, ids: *u32)
```

A header that is absent skips **its own** claims, with a warning naming it, and leaves
every other header's claims checked.

**When the C declaration differs by platform**, the declaration belongs in the stdlib
platform split (`std/platform.windows.milo` and friends), not in a conditional
annotation — the file name states which C library is being described, so the claim in it
is unconditionally true. Windows spells POSIX `read` as `_read` and returns `int` where
POSIX returns `ssize_t`; that is two declarations in two files, not one annotation with
an escape hatch.

Like `@cLayout`, it's opt-in and skipped for bare-metal targets.

#### Verifying the layout: `@cLayout`

An `extern struct` is a **claim** about a C type. The compiler believes it and computes
field offsets from the declaration, so a field that disagrees with the real header reads
its neighbour and returns plausible garbage — no crash, no diagnostic. `unsafe` does not
help: it tracks provenance, not layout.

`@cLayout(cType, header)` turns the claim into something the build checks. The compiler
generates a throwaway C translation unit of `_Static_assert`s against the real header,
compiles it with the system C compiler, and discards it. If the layout ever drifts — an
OS update, a new architecture — the **build breaks** instead of the program lying:

```milo
@cLayout("struct timespec", "time.h")
extern struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}
```

```
error[c-layout]: an extern struct's declared layout does not match the C header
  Timespec.tv_sec: Milo says offset 0, C header disagrees
```

Each field is checked for both its offset and its own size — offsets alone miss a wrong
width on the last field, and elsewhere a too-narrow field can hide inside the next
field's padding. Milo field names are used as the C field names.

Declaring only a **prefix** of a C struct is supported and common: the struct's total
size is checked with `>=`, not `==`, so you may stop early and ignore trailing platform
fields. Field *order* must still match from the start.

`@cLayout` is skipped for bare-metal targets, which are freestanding and cross-compiled —
the host's headers are not the ones the program runs against.

**Finding what isn't verified.** `@cLayout` is opt-in, so an unannotated `extern struct`
looks exactly like a verified one. `--deny=unverified-extern` turns that into an error:

```
error: extern struct 'Stat' has no @cLayout — its layout is an unverified claim about C
```

It's off by default, and deliberately so: an `extern struct` paired with a local `.c`
file has no header to name, which is a legitimate shape `@cLayout` can't express. Turn it
on for a project where every layout should be pinned to a real header. It only reports
structs in the file being compiled — a struct inside a library you imported isn't yours
to annotate.

Field access through a pointer auto-derefs (requires `unsafe` for the pointer deref):

```milo
extern fn malloc(size: i64): *u8
extern fn htons(x: u16): u16

struct SockAddrIn {
    sin_family: u16,
    sin_port: u16,
    sin_addr: u32,
}

unsafe {
    let addr: *SockAddrIn = malloc(16) as *SockAddrIn
    addr.sin_family = 2       // GEP + store, no byte arithmetic
    addr.sin_port = htons(80)
    let family = addr.sin_family
}
```

### Passing Structs by Value

An `extern struct` may cross the C ABI **by value** — as an argument and as a return
value. The compiler classifies each struct per the platform ABI (AAPCS64 on ARM64,
System V on x86-64): small structs are coerced into registers, homogeneous-float
structs go in SIMD/SSE registers, larger ones pass indirectly (`byval`) and return via
a hidden pointer (`sret`). The lowering matches what clang emits, so calls interoperate
with real C libraries.

```milo
extern struct Vec2 {
    x: f64,
    y: f64,
}

extern fn vec2_add(a: Vec2, b: Vec2): Vec2

fn main(): i32 {
    let a = Vec2 { x: 1.0, y: 2.0 }
    let b = Vec2 { x: 3.0, y: 4.0 }
    let c = vec2_add(a, b)        // safe — by-value extern struct, no unsafe needed
    print(c.x)
    return 0
}
```

**Rules and limits:**

- Only an `extern struct` may cross by value. A regular struct passed by value to an
  extern function is a compile error — declare it `extern struct`, or pass it by
  reference (`&T`).
- Extern-struct fields must be C-representable: integers, floats, `bool`, pointers
  (`*T`), C function pointers (`(A, B) => R`, see above), nested extern structs, and
  fixed arrays of those. `string`, `Vec`, enums, and
  other managed types are rejected — every extern struct is plain-old-data (Copy, no
  drop glue), so passing one leaves the original usable.
- Not supported (compile error, pass `&T` instead): a struct in a variadic (`...`)
  position, an `enum` crossing the ABI, a function-pointer parameter that itself passes
  a struct by value, and struct-by-value on bare-metal ARM (AAPCS32).

### Generating C Headers

`build-lib` writes a companion C header next to the archive so C code can call into a
Milo library:

```bash
milo build-lib mathlib.milo -o libmathlib.a   # also writes libmathlib.h
milo emit-obj mathlib.milo --emit-header       # writes mathlib.h next to mathlib.o
```

`pub` is the API boundary: only `pub` functions are declared, so a non-`pub` helper stays
out of the published surface. (The object still carries an external symbol for it — the
header is the contract, not yet the linkage; see `docs/backlog.md`.)

Alongside them the header declares the extern structs (opaque `extern type`
declarations become forward `typedef struct X X;`). Anything without a stable C
spelling — a `Vec`/`String`/enum in a signature, or (until define-side ABI lowering
lands) an exported function that passes or returns a struct by value — is emitted as a
`/* skipped: ... */` comment so the header stays valid and the gap stays visible.

```bash
$ milo emit-obj mathlib.milo -o mathlib.o --emit-header
$ clang main.c mathlib.o -o demo    # or: clang main.c -L. -lmathlib -o demo
```

### Nullable extern references: `?&mut T` and `?&T`

A C function that takes `GifFileType *` may be handed a null pointer, and the C prototype
does not say so. `?&mut T` is the Milo spelling for exactly that parameter: **the ABI is
`T *` — one pointer, no tag, no wrapper struct** — and the compiler makes the null test
impossible to skip.

```milo
extern struct GifFileType {
    SWidth: i32,
    SHeight: i32,
}

@externalLinkage
pub fn DGifGetScreenDesc(gif: ?&mut GifFileType): i32 {
    let g = gif else {
        return 0            // GIF_ERROR — giflib's convention, chosen here
    }
    // g: &mut GifFileType
    g.SWidth = 640
    return 1                // GIF_OK
}
```

**Where it is legal:** on a parameter of an `extern` or `@externalLinkage` function, and
nowhere else. Not a return type, not a struct field, not a local, not a `Vec` element, not
a closure parameter, not a type argument — not even nested inside an otherwise-legal
extern parameter. It is a spelling for a signature seam, not a type, so there is no
`?&mut T` value to store anywhere.

**How to unwrap:** `let NAME = param else { … }`. The else block runs when the pointer was
null, and must diverge (`return` / `break` / `continue`) — otherwise control would reach
code where the binding does not exist. What the else block *does* is yours: only you know
whether this C API answers `GIF_ERROR`, `0`, `void`, or sets `errno`. The compiler
deliberately does not choose for you, which is why there is no null-checking wrapper.

Any other use of the parameter is a compile error:

```milo error
extern struct GifFileType { SWidth: i32 }

@externalLinkage
pub fn bad(gif: ?&mut GifFileType): i32 {
    return gif.SWidth        // COMPILE ERROR: must be unwrapped before use
}
```

```milo error
extern struct GifFileType { SWidth: i32 }

@externalLinkage
pub fn worse(gif: ?&mut GifFileType): i32 {
    let held = Option.Some(gif)   // COMPILE ERROR: must be unwrapped before use
    return 0
}
```

That second one is the point of the design. `Option<&mut T>` is an enum with a reference
payload, which the checker already rejects as storage; a nullable extern reference must
never become one. It exists only between the call boundary and the unwrap.

**After the unwrap, `g` is an ordinary second-class `&mut T`** and obeys every rule any
other reference does: it cannot be returned, cannot be stored, cannot outlive the call. A
`?&T` unwraps to a shared `&T`, which cannot be written through. One thing the unwrap adds:
a second live unwrap of the same `?&mut T` is rejected, because it would hand the body two
`&mut T` to one object. The borrow is scoped, so unwrapping once per arm of an `if` is fine.

`@cSig` verifies the spelling against the real header, and it verifies clean, because the
C type genuinely is `T *`:

```milo
@cSig("time.h", "time_t time(time_t *)")
extern fn time(t: ?&mut i64): i64
```

`milo build-lib` declares it in the generated header the same way — `int32_t
point_bump(Point* p);` — so a C caller passes `&p` or `NULL` with no shim in between.

Note the two positions of `?` mean different things: a **leading** `?` before `&` is this
feature, and a **trailing** `?` (`T?`) is `Option<T>` shorthand. See
[docs/foreign-memory.md](foreign-memory.md) for why the two must not be the same thing.

### Typed Function Pointers in Extern Decls

Extern functions can declare function-typed parameters. Passing a matching Milo function requires no cast:

```milo
extern fn qsort(base: *u8, num: i64, size: i64, cmp: (*u8, *u8) => i32): void

fn cmpI32(a: *u8, b: *u8): i32 {
    unsafe {
        let va = *(a as *i32)
        let vb = *(b as *i32)
        return va - vb
    }
}

fn main(): i32 {
    var arr: [i32; 5] = [50, 10, 99, 30, 70]
    unsafe { qsort(arr[0].addrOf() as *u8, 5, 4, cmpI32) }   // cmpI32 passed directly
    return 0
}
```

---

## JSON Serialization

### `@derive(Json)` — struct ⇄ JSON

`@derive(Json)` generates three methods on a struct:

| Method | Signature |
|---|---|
| `toJson` | `fn toJson(self: &Self): string` |
| `fromJson` | `fn fromJson(text: string): Result<T, JsonError>` |
| `fromJsonNode` | `fn fromJsonNode(doc: &Json, cur: i64): Result<T, JsonError>` — decode a sub-node; what nested fields call |

```milo
@derive(Json)
struct Address { city: string, zip: i64 }

@derive(Json)
struct User {
    name: string,
    age: i32,
    email: Option<string>,
    tags: Vec<string>,
    address: Address,
    @json("legacy_id") legacyId: u32,
}

var tags: Vec<string> = Vec.new()
tags.push("math")
let user = User {
    name: "ada", age: 36, email: Option.None, tags: tags,
    address: Address { city: "London", zip: 1 }, legacyId: 77,
}
let text = user.toJson()
// {"name":"ada","age":36,"email":null,"tags":["math"],"address":{"city":"London","zip":1},"legacy_id":77}

match User.fromJson(text) {
    Result.Ok(u) => { print(u.name) }
    Result.Err(e) => { print(e.message()) }   // "field 'address.zip': expected integer, got string"
}
```

The import of `std/json` is injected for you — the attribute is self-contained. The
derive emits ordinary Milo source and hands it back to the compiler, so it obeys the same
move and borrow rules everything else does; `MILO_DUMP_DERIVES=1 milo build …` prints the
generated impls to stderr.

**Supported field types.** `string`, `bool`, every integer and float width, payload-free
enums (encoded as the variant name), `Option<T>` (absent *and* `null` decode to `None`),
`Vec<T>`, and any struct that also has a codec. They nest freely: `Vec<Vec<i64>>`,
`Option<Vec<Address>>`. Anything else — `HashMap`, `Heap<T>`, a payload-carrying enum, a
struct with no codec — is a compile error naming the field.

**Decoding is strict.** A non-Option field that is absent is `JsonError.Missing`; a value
of the wrong kind is `JsonError.Mismatch`. A `u8` field will not take `300` from the wire
and store `44`, and an `i32` field will not take `1.5` and store `1`; both are
`Mismatch`. Unknown keys in the document are ignored.

```milo skip
pub enum JsonError {
    Syntax(string),         // the text was not JSON; the parser's message
    Missing(string),        // dotted path of the absent field, e.g. "address.zip"
    Mismatch(JsonMismatch), // { path, expected, actual }
}
```

`e.path()` gives the dotted path (`"friends[3].city"`), `e.message()` a one-line
description. Paths are built only on the failure path, so decoding a correct document
allocates none.

**Escape hatch.** A type whose wire form is not an object — a date that encodes as a
string, say — can hand-write `toJson` and `fromJsonNode` with the same signatures, and
deriving structs will embed it. Deriving a struct that already defines one of the three
names is an error rather than a silent override.

**Not covered:** `HashMap` fields, payload-carrying enums, `#[serde(default)]`-style
defaults for non-Option fields, and rejecting unknown keys. An integer written in
exponent form (`1e2`) does not decode into an integer field. `Option<Option<T>>` is
rejected — `Some(None)` and an absent field are both `null`, so it cannot round-trip.

A generic struct gets a codec per instantiation, and a generic field *inside* a derived
struct decodes fine, but the top-level `Box<i64>.fromJson(…)` entry point is unreachable:
a static call on a generic type has no spelling yet.

### `jsonStringify`

`jsonStringify` is a built-in that serializes a flat struct to a JSON string. Supported field types: `string` (escaped automatically), integers, floats, and `bool` — anything else is a compile error. Prefer `@derive(Json)`, which handles every field shape and can also read:

```milo
struct User {
    name: string,
    age: i32,
    active: bool,
}

let user = User { name: "Chad", age: 30, active: true }
let json = jsonStringify(user)
// {"name":"Chad","age":30,"active":true}
```

For nested objects, arrays, or JSON built up dynamically, use the fluent builders in `std/json`:

```milo
from "std/json" import { Json }

let doc = Json.obj()
    .str("type", "capabilities")
    .int("seq", 3)
    .obj("inner", Json.obj().bool("ok", true))
    .arr("tags", Json.arr().str("a").str("b"))
    .build()
// {"type":"capabilities","seq":3,"inner":{"ok":true},"tags":["a","b"]}
```

Builder methods: `.str/.int/.float/.bool/.nil/.obj/.arr/.val` (chainable, consume and return the builder; string values are escaped). `Json.arr()` has the same set minus keys.

### Indenting for humans

Every JSON producer above emits one compact line. `jsonPretty(text, indent)` is the
`JSON.stringify(v, null, indent)` knob: `indent > 0` indents by that many spaces per
level, `indent <= 0` minifies. It reformats *text*, so it applies to any of them:
a builder, `jsonStringify`, `@derive(Json)`, or a payload that arrived off a socket
and was never parsed. Key order, escapes and number spelling are preserved byte for
byte (an id past 2^53 does not go through an f64 on the way out).

```milo
from "std/json" import { Json, jsonPretty }

print(Json.obj().str("a", "x").arr("b", Json.arr().int(1)).buildPretty(2))
// {
//   "a": "x",
//   "b": [
//     1
//   ]
// }

let body = Json.obj().str("a", "x").build()
let indented = jsonPretty(body, 2)

print(jsonPretty(body, 2))          // any JSON text, not just builders
print(Json.parse(body)!.pretty(2))  // a parsed document
print(jsonPretty(indented, 0))      // back to one line
```

`.buildPretty(n)` on a builder and `.pretty(n)` on a parsed `Json` are the same
function reached the short way.

### Reading a nested value

`get(key)` returns `Option<Json>`, so walking three levels down nests three Options.
The `*Path` accessors collapse the whole walk into one, which `??` can finish:

```milo
from "std/json" import { Json }

let body = "{\"headers\":{\"Host\":\"example.com\"},\"items\":[{\"count\":3}],\"pi\":3.5,\"ok\":true}"
let doc = Json.parse(body)!

print(doc.strPath("headers.Host") ?? "(none)")   // example.com
print(doc.i64Path("items[0].count") ?? 0)        // 3
print(doc.f64Path("pi") ?? 0.0)                  // 3.5
print(doc.boolPath("ok") ?? false)               // true
let first = doc.path("items[0]")                 // Option<Json>, to keep walking
```

A path segment is a key, or `[n]` for an array index. A missing key, an out-of-range
index, or a value of the wrong kind all yield `None` — the walk never panics, whatever
the document turns out to contain. Keys containing `.` or `[` are not addressable this
way; use `get`/`at` for those.

---

## Compile-Time File Embedding

`@embedFile` inlines file contents as a string at compile time:

```milo
let html = @embedFile("index.html")
```

The `@` marks it as compiler magic rather than an ordinary call — like `@cLayout`,
`@cSig`, and `@link`, it is handled by the compiler, not at runtime. The argument
must be a string literal (nothing else is known at compile time) and the path is
resolved relative to the file containing the call, not the entry file. Contents are
read as raw bytes, so binary assets (PNGs, fonts, wasm) embed intact.

The bare spelling `embedFile("index.html")` still compiles, but warns:

```
warning: 'embedFile' is a compile-time builtin — write '@embedFile(...)'
```

Silence it with `--allow=bare-embedfile`, or make it fatal with
`--deny=bare-embedfile`.

### Compile-Time Target OS

`@targetOs()` is a compile-time constant naming the OS being built for — one of
`"darwin"`, `"linux"`, or `"windows"`:

```milo
let bucket = if @targetOs() == "windows" { "NUL" } else { "/dev/null" }
```

It exists so ordinary code — not just the stdlib's per-OS file split — can branch on
the target. Both arms of the `if` are type-checked, but the compiler evaluates the
condition and keeps only the taken arm: the other is never lowered or code-generated.
That means the dead branch may reference symbols that exist on no other platform (a
Windows-only extern, an `@embedFile` of a per-OS asset) without breaking the build:

```milo
// Declared everywhere, linked only on Windows. The dead branch is folded out
// before codegen elsewhere, so the reference never reaches the linker there.
extern fn startWinsock(): void

fn main(): i32 {
    if @targetOs() == "windows" {
        startWinsock()
    }
    return 0
}
```

The fold triggers on any statically-known condition — `@targetOs()` compared with a
string literal, and `!`/`&&`/`||` over such comparisons. Like `@embedFile`, the `@`
marks it as compiler magic; the bare spelling `targetOs()` warns (`bare-targetos`).

For a C declaration that differs by platform, prefer the stdlib file split
(`std/foo.windows.milo`) over `@targetOs()` — the filename states the OS
unconditionally. `@targetOs()` is for application code that has no such split.

---

## HTTP Server (Standard Library)

Milo includes a Hono-inspired HTTP server in `std/http` with a router, context object, middleware, path params, query strings, cookies, and request body access.

### Basic Server

For simple cases, `serve` takes a port and a handler:

```milo
from "std/http" import { Request, Response, serve }

fn handler(req: &Request): Response {
    if req.path == "/" {
        return Response.Html("<h1>Hello!</h1>")
    }
    return Response.NotFound
}

fn main(): i32 {
    serve(8080, handler)
    return 0
}
```

### Router + Context

For real apps, use `Router` with route handlers that receive a mutable `Context`:

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r = Router.new()

    r.get("/", (ctx: &mut Context) => {
        return ctx.text("Hello from Milo!")
    })

    r.get("/users/:id", (ctx: &mut Context) => {
        let id = ctx.param("id") ?? ""
        ctx.setHeader("X-User-Id", id.clone())
        return ctx.json($"\{\"id\": \"{id}\"}")
    })

    r.get("/search", (ctx: &mut Context) => {
        // None only when there is no ?q= at all; `?q=` is Some("").
        let Option.Some(q) = ctx.query("q") else {
            ctx.setStatus(400)
            return ctx.text("missing ?q=")
        }
        return ctx.text($"results for: {q}")
    })

    let _ = serveRouter(8080, r)
    return 0
}
```

### Route Methods

```milo
from "std/http" import { Context, Response, Router }

fn handleReq(ctx: &mut Context): Response {
    return ctx.text("ok")
}

var r: Router = Router.new()
r.get("/things", handleReq)      // GET
r.post("/things", handleReq)     // POST
r.put("/things", handleReq)      // PUT
r.delete("/things", handleReq)   // DELETE
r.all("/things", handleReq)      // any method
```

### Context Methods

| Method | Description |
|--------|-------------|
| `ctx.param("name")` | Path parameter (`:name` in pattern) → `Option<string>` |
| `ctx.query("key")` | Query string value (`?key=value`) → `Option<string>` |
| `ctx.header("name")` | Request header, case-insensitive → `Option<string>` |
| `ctx.cookie("name")` | Cookie value from the request → `Option<string>` |
| `ctx.req.body` | Access raw request body |
| `ctx.setStatus(code)` | Set response status code |
| `ctx.setHeader(name, value)` | Add response header |
| `ctx.setCookie(name, value)` | Set response cookie |
| `ctx.setCookieWithOptions(name, value, opts)` | Set cookie with options (`"Path=/; HttpOnly"`) |
| `ctx.deleteCookie(name)` | Delete cookie (Max-Age=0) |
| `ctx.text(body)` | Return text/plain response |
| `ctx.json(body)` | Return application/json response |
| `ctx.html(body)` | Return text/html response |
| `ctx.redirect(url)` | Return 302 redirect |

The four lookups return `Option<string>` because absent and present-but-empty are
different: `?q=` and a `Cookie: sid=` are *present* with an empty value, and only
`Option` can say so. Collapse them with `??` when the distinction does not matter
(`ctx.query("q") ?? ""`), and bind with `let … else` when it does.

### Middleware

Middleware wraps handlers with a next-function pattern:

```milo
from "std/http" import { Context, Response, Router }
from "std/time" import { now, since }

fn timing(ctx: &mut Context, next: (&mut Context) => Response): Response {
    let start = now()
    let resp = next(ctx)
    let ms = since(start).toMillis()
    ctx.setHeader("X-Response-Time", ms.toString() + "ms")
    return resp
}

var r: Router = Router.new()
r.use(timing)
```

### Path Parameters and Wildcards

```milo
from "std/http" import { Context, Response, Router }

fn handleReq(ctx: &mut Context): Response {
    return ctx.text("ok")
}

var r: Router = Router.new()
r.get("/users/:id/posts/:postId", handleReq)  // named params
r.get("/static/*", handleReq)                  // wildcard suffix
```

### Response Variants

`Text(string)`, `Html(string)`, `Json(string)`, `NotFound`, `Status(i32, string, string)`.

---

## Complete Example: JSON Parser

This example exercises enums with complex payloads, Heap, Vec, structs, recursion, and string operations. See [`examples/basics/json.milo`](../examples/basics/json.milo) for the full source.

```milo
struct JsonKV {
    key: string,
    value: Heap<JsonValue>,
}

enum JsonValue {
    Null,
    Bool(bool),
    Number(i64),
    Str(string),
    Array(Vec<Heap<JsonValue>>),
    Object(Vec<JsonKV>),
}

fn skipWs(s: &string, pos: &mut i64): void {
    while pos < s.len && s[pos] == ' ' { pos = pos + 1 }
}

fn parseString(s: &string, pos: &mut i64): Heap<JsonValue> { return Heap(JsonValue.Null) }
fn parseObject(s: &string, pos: &mut i64): Heap<JsonValue> { return Heap(JsonValue.Null) }
fn parseArray(s: &string, pos: &mut i64): Heap<JsonValue> { return Heap(JsonValue.Null) }

fn parseValue(s: &string, pos: &mut i64): Heap<JsonValue> {
    skipWs(s, pos)
    let ch = s[pos]
    if ch == '"' { return parseString(s, pos) }
    if ch == '{' { return parseObject(s, pos) }
    if ch == '[' { return parseArray(s, pos) }
    return Heap(JsonValue.Null)  // ... numbers, bools, null
}
```

---

## Complete Example: FizzBuzz

```milo
fn main(): i32 {
    for i in 1..21 {
        if i % 15 == 0 {
            print("FizzBuzz")
        } else if i % 3 == 0 {
            print("Fizz")
        } else if i % 5 == 0 {
            print("Buzz")
        } else {
            print(i)
        }
    }
    return 0
}
```

---

## Complete Example: Binary Tree

```milo
enum Tree {
    Node(Heap<Tree>, Heap<Tree>),
    Leaf(i32),
}

fn sum(t: Tree): i32 {
    match t {
        Tree.Leaf(n) => { return n }
        Tree.Node(left, right) => {
            return sum(*left) + sum(*right)
        }
    }
}

fn main(): i32 {
    let tree = Tree.Node(
        Heap(Tree.Node(Heap(Tree.Leaf(1)), Heap(Tree.Leaf(2)))),
        Heap(Tree.Node(Heap(Tree.Leaf(3)), Heap(Tree.Leaf(4))))
    )
    print($"sum: {sum(tree)}")   // sum: 10
    return 0
}
```

---

## String Interpolation (F-Strings)

Use `$"..."` for string interpolation. Expressions inside `{...}` are evaluated and converted to strings.

```milo
let name = "Milo"
let version: i32 = 1
let msg = $"Hello {name}, version {version}!"

let x: i32 = 10
let y: i32 = 20
print($"{x} + {y} = {x + y}")   // 10 + 20 = 30
```

The `$` goes **before** the quote, and the braces hold the expression alone — there is
no `$` inside them. A plain `"..."` is never interpolated, so the JavaScript spelling
emits its own characters:

```milo
let name = "world"
print("hello ${name}")    // prints: hello ${name}
print($"hello {name}")    // prints: hello world
```

Because that is silent rather than a type error, the compiler warns
([`missing-interpolation`](site/language/warnings-and-errors.md)) whenever a plain
literal holds `${name}` or `{name}` and `name` is a real binding in scope.

Write a literal brace with `\{` / `\}`:

```milo
let id = "7"
print($"\{\"id\": \"{id}\"}")   // {"id": "7"}
```

F-strings desugar to `format()` calls. The `format()` builtin is also available directly:

```milo
let name = "milo"
let version = "0.1"
let msg = format("Hello ", name, ", version ", version, "!")
```

---

## Operator Overloading

Implement the `Add`, `Sub`, `Mul`, `Div`, or `Eq` traits to overload operators on your types.

```milo
struct Vec2 { x: i32, y: i32 }

impl Add for Vec2 {
    fn add(self: &Self, other: &Self): Self {
        return Vec2 { x: self.x + other.x, y: self.y + other.y }
    }
}

impl Sub for Vec2 {
    fn sub(self: &Self, other: &Self): Self {
        return Vec2 { x: self.x - other.x, y: self.y - other.y }
    }
}

let a = Vec2 { x: 1, y: 2 }
let b = Vec2 { x: 3, y: 4 }
let c = a + b   // Vec2 { x: 4, y: 6 }
let d = a - b   // Vec2 { x: -2, y: -2 }
```

### Equality with @derive(Eq)

`@derive(Eq)` generates field-wise equality, enabling `==` and `!=`:

```milo
@derive(Eq)
struct Point { x: i32, y: i32 }

let a = Point { x: 1, y: 2 }
let b = Point { x: 1, y: 2 }
print(a == b)   // true
print(a != b)   // false
```

| Operator | Trait | Method |
|----------|-------|--------|
| `+` | `Add` | `add(self: &Self, other: &Self): Self` |
| `-` | `Sub` | `sub(self: &Self, other: &Self): Self` |
| `*` | `Mul` | `mul(self: &Self, other: &Self): Self` |
| `/` | `Div` | `div(self: &Self, other: &Self): Self` |
| `==` / `!=` | `Eq` | `eq(self: &Self, other: &Self): bool` |

---

## Concurrency

Milo's primary concurrency model is **green tasks**: `Task.spawn` runs a closure on a cooperative, single-threaded scheduler. Blocking I/O and channel operations automatically yield to other tasks — there is no async/await coloring and no event loop to run by hand. `Promise<T>`, `Channel`, `select`, and `WaitGroup` all park the *task* (not the OS thread), so they compose freely. The one way onto a real OS thread is `Promise.blocking`, for CPU-bound parallelism and blocking FFI (see [Escape hatch: OS threads](#escape-hatch-os-threads)).

### Choosing a tool

| Need | Use |
|------|-----|
| One-shot result off the main flow | `Promise(fn)` → `.await()!`; fan-out with `Promise.all`, first-wins with `Promise.race` |
| Stream of values over time | `Channel<T>` — producer `send`s + `close()`s, consumer `for val in ch` |
| Fleet of fire-and-forget workers | `Task.spawn` + `WaitGroup` |
| Wait on first-of-many sources | `std/select` |
| CPU-bound work or blocking FFI | `Promise.blocking(fn)` → `.await()!`; fan out across cores via `Promise.all` |
| Shared state across parallel workers | channels (pass ownership) or atomics (counters, flags) |

Most programs need only the first row. `Promise` is the familiar promise/await model with no event loop and no function coloring, and `await()` frees the promise's resources itself — there is nothing to `destroy()`.

### Tasks

```milo
from "std/runtime" import { Task }

let t = Task.spawn(move (): void => {
    print("hello from a task")
})
t.join()   // block until the task finishes
```

**Exit semantics are Go's:** when `main` returns, the process exits and any tasks still running are abandoned. Waiting is always explicit — nothing drains outstanding tasks for you. Join a specific task, or use a `WaitGroup` / `Channel` / `Promise`:

```milo
from "std/runtime" import { Task }
from "std/sync" import { WaitGroup }

let wg = WaitGroup.new()
for i in 0..8 {
    wg.add(1)
    let n = i
    let wgc = wg.clone()               // share an owning handle with the task
    Task.spawn(move (): void => {
        print(n.toString())
        wgc.done()
    })
}
wg.wait()          // returns once all 8 have called done()
// no destroy: wg and every clone free themselves when their last owner drops
```

`Task.join()` must be called before the joined task can complete (i.e. right after `spawn`, before you yield or drive the scheduler) — the cooperative scheduler guarantees the registration lands first. A server that spawns an accept loop and should run forever can drive the scheduler explicitly with `schedulerRunToCompletion()` (runs every spawned task to quiescence, then tears the scheduler down):

```milo
from "std/runtime" import { Task, schedulerRunToCompletion }

fn acceptLoop(fd: i32): void {
    // accept connections and spawn a handler task per client, forever
}

Task.spawn(move (): void => { acceptLoop(0) })   // never returns in a real server
schedulerRunToCompletion()                       // main blocks here
```

### Escape hatch: OS threads

There is one way to reach a real OS thread — [`Promise.blocking`](#promiseblocking--cpu-bound-work-and-blocking-ffi), for CPU-bound work or FFI that must block. Everything else is green tasks. There is no separate `Thread`/`Mutex`/`RwLock`/`parallel` surface: results flow back through `await`, and shared state across blocking workers is expressed with channels or atomics.

### Thread Safety (Send / Sync)

The compiler enforces thread safety at compile time. Because `Promise.blocking` runs its closure on a real OS thread, it requires every captured variable to implement `Send` — safe to transfer across threads. (Green `Task`/`Promise.run` closures stay on one thread and carry no such requirement.)

**Send types** (safe to move to another thread): all primitives, `string`, `Heap<T>`, `Vec<T>`, `HashMap<K,V>`, and structs/enums where every field is Send. This is derived structurally; ordinary user types need no annotation.

**Sync types** (safe to share via `&T` across threads): the same structural rule.

**Non-Send types**: raw pointers (`*T`) and structs containing them.

```milo error
from "std/runtime" import { Promise }

// This compiles — i64 and string are Send
let msg = "hello"
let p = Promise<i64>.blocking(move (): i64 => { print(msg); return 0 })

// This is a compile error — *u8 is not Send
var x: i32 = 42
unsafe {
    let raw = (&x) as *u8
    let bad = Promise<i64>.blocking(move (): i64 => {    // error: cannot send 'raw' of type '*u8' across threads
        return raw as i64
    })
}
```

Pointer-backed synchronization primitives sometimes uphold thread safety through invariants the type checker cannot prove. A manual override is therefore an explicit unsafe implementation, like Rust's `unsafe impl Send`:

```milo
struct MyHandle {
    _ptr: *u8,
}

// Safety: every access to the pointee is serialized by its mutex.
unsafe impl Send for MyHandle {}
unsafe impl Sync for MyHandle {}
```

The compiler reports which field prevents structural derivation. `unsafe impl` is a proof obligation for the author and reviewer, not a way to silence that error casually. On a generic wrapper the override covers its representation only; each concrete type argument must still implement the same marker, so `Wrapper<*u8>` remains non-Send even after `unsafe impl Send for Wrapper<T> {}`.

### Promises

For most concurrent work, reach for `Promise<T>`. It runs a function on a green thread and returns the result. `Promise(fn)` is shorthand for `Promise<T>.run(fn)` with the type inferred from the closure's return type:

```milo
from "std/runtime" import { Promise }

fn expensiveComputation(): i64 {
    return 42
}

let p = Promise((): i64 => {
    return expensiveComputation()
})
let result = p.await()!
```

`Promise.all()` runs multiple tasks and collects all results. `Promise.race()` returns whichever finishes first:

```milo
from "std/runtime" import { Promise }

fn fetchA(): i64 { return 1 }
fn fetchB(): i64 { return 2 }

var tasks: Vec<Promise<i64>> = Vec.new()
tasks.push(Promise((): i64 => { return fetchA() }))
tasks.push(Promise((): i64 => { return fetchB() }))

let results = Promise.all(tasks).await()!   // [resultA, resultB]
```

Promises run on green threads with cooperative scheduling — no async/await coloring, no event loop. Blocking I/O automatically yields to other tasks.

#### `Promise.blocking` — CPU-bound work and blocking FFI

The green scheduler is single-threaded and cooperative: a closure that spins on the CPU or calls a C function that blocks never yields, so it starves every other task. `Promise.blocking(fn)` runs `fn` on a real OS thread instead — the one escape hatch for work that can't cooperate. The result comes back through the same `await()`, so from the caller's side it is just a `Promise`:

```milo
from "std/runtime" import { Promise }

fn crunch(): i64 { return 0 }   // heavy pure computation

let p = Promise<i64>.blocking(move (): i64 => { return crunch() })
let r = p.await()!   // caller never blocks; the work runs in parallel
```

The closure's captures must be `Send` (it crosses to another thread) — the compiler enforces this exactly as for the closures below. Use `Promise.blocking` **only** for CPU-bound work or FFI that must block; ordinary I/O already yields on a plain `Promise`, so a thread would only add overhead.

Split work across cores by fanning `Promise.blocking` handles into `Promise.all` — no dedicated parallel construct needed:

```milo
from "std/runtime" import { Promise }

fn sumRange(lo: i64, hi: i64): i64 { return (lo + hi - 1) * (hi - lo) / 2 }

var parts: Vec<Promise<i64>> = Vec.new()
for k in 0..8 {
    let lo = (k as i64) * 1000
    parts.push(Promise<i64>.blocking(move (): i64 => { return sumRange(lo, lo + 1000) }))
}
let sums = Promise.all(parts).await()!   // 8 threads, joined through one await
```

Awaiting inside a green task is the normal case and keeps the scheduler running. Awaiting at the top level of `main` does too: whenever a program can spawn, `main` itself runs as a green task, so an await there parks it and lets every other task run. (Before that, `main` was not a task, and awaiting in it blocked the one thread the scheduler runs on.)

### Channels

Bounded FIFO channels for streaming values between threads. Use channels when a producer sends many values over time — for one-shot results, prefer Promise.

Channel is a reference-counted handle — `.clone()` to give another owner (a worker) its own handle; the queue frees itself when the last owner drops. Safe to capture in move closures without `unsafe`.

```milo
from "std/runtime" import { Promise }
from "std/sync" import { Channel }

var ch = Channel<i64>.new(8)!
let chW = ch.clone()              // the worker's owning handle

let producer = Promise<i64>.blocking(move (): i64 => {
    chW.send(10)!
    chW.send(20)!
    chW.close()
    return 0
})

for val in ch {   // main consumes as the worker produces
    print(val)
}
producer.await()!
// no destroy: ch and chW free the queue when the last of them drops
```

Here the producer is a `Promise.blocking` worker so it runs while `main` consumes. Between two green tasks the same channel works with no thread — and `main` may be one end of it: because `main` runs as a green task in any program that spawns, blocking it on a channel only a green producer fills parks it and runs the producer, rather than deadlocking as it once did.

Call `close()` to signal no more values will be sent. Remaining items are delivered before iteration ends. `send()` on a closed channel returns `Result.Err`.

Non-blocking variants for polling:

```milo
from "std/sync" import { Channel }

let ch = Channel<i64>.new(4)!
ch.trySend(42)               // returns true if sent, false if full
let val = ch.tryRecv()        // returns Option<i64> — None if empty
match val {
    Option.Some(v) => { print(v) }
    Option.None => { print("empty") }
}
print(ch.len())               // current number of items
```

### Sharing state across blocking workers

Green tasks never run in parallel, so plain sequencing protects task-to-task state. Across `Promise.blocking` workers, which do run in parallel, share through channels (pass ownership) or atomics (lock-free counters and flags) rather than a lock. Move-capture gives each worker its own copy of what it captures, so a fan-out that returns results through `await` needs no synchronization at all.

### Atomics

Lock-free atomic types for cross-thread counters and flags. No mutex needed.

```milo
from "std/sync" import { AtomicI64, AtomicI32, AtomicU64, AtomicBool }

let counter = AtomicI64.new(0)
counter.add(1)                  // returns old value
print(counter.load())           // 1
counter.store(42)
let old = counter.cas(42, 99)   // compare-and-swap, returns old value

let flag = AtomicBool.new(false)
flag.store(true)
let prev = flag.swap(false)     // returns old value
// no destroy: counter and flag free themselves when their last owner drops
```

Four types: `AtomicI64`, `AtomicI32`, `AtomicU64`, `AtomicBool`. The integer ones carry `load`, `store`, `add`, `sub`, `swap`, `cas`; `AtomicBool` carries `load`, `store`, `swap`, `cas`. Every mutating operation returns the **old** value.

**All atomic operations use sequential consistency (`seq_cst`)** — a `cas` is seq_cst on both its success and its failure ordering. There is no ordering parameter and there are no acquire/release/relaxed forms: the cheaper orderings are a correctness cliff invisible in the source, and nothing in std or its consumers has been bound by the difference. Read every atomic call as a full barrier.

`add`/`sub` **wrap** on overflow, unlike ordinary Milo arithmetic, which traps. No atomic read-modify-write instruction has a checked form; to detect overflow, write a `cas` loop and inspect the old value.

There is no `AtomicPtr`. A raw pointer is only dereferenceable inside `unsafe`, so an `AtomicPtr` would be `AtomicI64` plus a cast with no safety added — and Milo has no way to state that the pointee outlives the load, so a safe-looking `AtomicPtr` would be a lifetime claim the compiler cannot check. Share an index into a `Vec` or an arena `Handle` instead.

All four use audited `unsafe impl Send` / `Sync` markers because their raw-pointer internals are accessed only through those atomic operations. To share one across `Promise.blocking` workers, `.clone()` it — the handle is a reference-counted owner (Arc-style), and the storage frees when the last owner drops. No manual `destroy`.

### Once and lazy statics

`Once` runs one initializer exactly once, however many green tasks or `Promise.blocking` threads reach it at the same time. The losers block until the winner finishes, so every caller that returns from `run` has seen the initializer's writes. A green waiter parks (the scheduler keeps running), an OS-thread waiter blocks on a condition variable, and the main thread with a live scheduler drives it. Re-entering `run` from inside its own initializer would wait for itself forever, so it aborts with that message rather than hanging.

A module-level `var` already runs a real initializer, in dependency order, before `main` — so an *eager* static needs no `Once`:

```milo
fn buildTable(): Vec<i64> {
    return [1, 2, 3]
}

var gTable: Vec<i64> = buildTable()   // runs before main

fn main(): i32 {
    print(gTable.len)
    return 0
}
```

Reach for `Once` when initialization must be deferred past the start of `main` (it needs argv or a config file) or is expensive and usually unwanted. The shape is a global plus a guard function, because a getter cannot hand back a `&T` — references are second-class:

```milo
from "std/sync" import { Once }

fn buildTable(): Vec<i64> {
    return [1, 2, 3]
}

var gTable: Vec<i64> = []
var gTableOnce: Once = Once.new()

fn ensureTable(): void {
    gTableOnce.run((): void => {
        gTable = buildTable()
    })
}

fn main(): i32 {
    ensureTable()
    print(gTable.len)
    return 0
}
```

Callers do `ensureTable()` and then read `gTable` directly. There is no `Lazy<T>` or `OnceCell<T>`: with no way to return a reference, every `get()` would deep-copy the cached value, turning a cache into a per-access allocation.

### Pitfalls

1. **`main` returning abandons running tasks.** Exit semantics are Go's — wait explicitly (`join`, `WaitGroup`, `Promise`, channel) or the work silently dies with the process. `exit(code)` terminates immediately from anywhere.
2. **Call `Task.join()` immediately after `spawn`.** The registration must land before the task can complete; joining after you've yielded or blocked elsewhere is a lost wakeup.
3. **The green scheduler is single-threaded and cooperative.** A task that spins on CPU or calls blocking FFI starves every other task — nothing preempts it. Move that work to `Promise.blocking`; long compute loops that must stay on a task should `schedulerYield()` periodically.
4. **`Promise.blocking` is the only OS thread.** Its closure runs in parallel and its captures must be `Send`; a plain `Promise`/`Task` closure stays on the scheduler and has no such requirement. Use `blocking` only for CPU-bound work or blocking FFI — ordinary I/O already yields on a green task.
5. **`Channel`, `WaitGroup`, `Once`, and atomics are reference-counted handles — `.clone()` to share, no manual free.** They are move-only owners; cloning gives another owner and the storage frees when the last owner drops (Arc-style). A worker task takes its own `.clone()`. (`Promise` also frees itself on `await` — nothing to clone or destroy.)
6. **Channels must be `close()`d** or the consumer's `for val in ch` never ends. `send` on a closed channel returns `Result.Err`, not a panic. Bounded `send` blocking when full is backpressure, not a bug — poll with `trySend`/`tryRecv`.
7. **Move closures capture copies.** Mutating a captured `var` inside a task or worker is invisible outside. Communicate results through a `Channel`/`Promise`, or share through an atomic — never through captured locals.

### Concurrency API

| Function | Description |
|----------|-------------|
| `Task.spawn(move () => {...})` | Spawn a green task |
| `t.join()` | Wait for a task to finish |
| `Promise(fn)` / `Promise<T>.run(fn)` | Run `fn` on a green task, result via `await` |
| `Promise<T>.blocking(fn)` | Run `fn` on an OS thread (CPU-bound / blocking FFI) |
| `p.await()` | Wait for a promise's result |
| `Promise.all(v)` / `Promise.race(v)` | Collect all results / first to finish |
| `Channel.new(cap)` | Create bounded channel |
| `ch.send(val)` | Send value (blocks if full) |
| `ch.recv()` | Receive value (blocks if empty) |
| `ch.trySend(val)` | Non-blocking send, returns `bool` |
| `ch.tryRecv()` | Non-blocking receive, returns `Option<T>` |
| `ch.close()` | Signal no more values |
| `ch.len()` | Current items in channel |
| `ch.clone()` | Owning handle to share with a task (frees at last drop) |
| `WaitGroup.new()` | Create a wait group |
| `wg.add(n)` / `wg.done()` / `wg.wait()` | Track and await a fleet of tasks |
| `wg.clone()` | Owning handle to share with a task (frees at last drop) |
| `AtomicI64.new(v)` / `AtomicI32.new(v)` / `AtomicU64.new(v)` / `AtomicBool.new(v)` | Create atomic |
| `a.load()` | Atomic read |
| `a.store(v)` | Atomic write |
| `a.add(v)` / `a.sub(v)` | Atomic add/sub, wrapping (returns old) |
| `a.cas(exp, des)` | Compare-and-swap (returns old) |
| `a.swap(v)` | Atomic swap (returns old) |
| `a.clone()` | Owning handle to share with a worker (frees at last drop) |
| `Once.new()` | Create a run-exactly-once guard |
| `o.run(fn)` | Run `fn` once; later callers block until it finishes |
| `o.isDone()` | True once the initializer has completed |

---

## Green Threads

Green threads are lightweight, user-space threads for high-concurrency I/O. You can run thousands concurrently with minimal memory overhead. There are no `async`/`await` keywords — the same code works in both OS threads and green threads.

### Spawning Green Threads

```milo
from "std/runtime" import { Task }

fn main(): i32 {
    Task.spawn(move (): void => {
        print("hello from green thread")
    })
    return 0
}
```

Green threads run cooperatively. When `main` returns, the process exits and any tasks still running are abandoned — nothing waits for them. Waiting is always explicit: `t.join()`, a `WaitGroup`/`Channel`/`Promise`, or `schedulerRunToCompletion()` for a run-forever server (see [Concurrency](#concurrency)).

### Cooperative Yielding

Green threads yield control explicitly with `schedulerYield()`:

```milo
from "std/runtime" import { Task, schedulerYield }

fn main(): i32 {
    Task.spawn(move (): void => {
        print("A1")
        schedulerYield()
        print("A2")
    })
    Task.spawn(move (): void => {
        print("B1")
        schedulerYield()
        print("B2")
    })
    return 0
}
// Output: A1, B1, A2, B2
```

### I/O Waiting

Green threads can yield until a file descriptor is ready for reading or writing. This integrates with the platform event loop (kqueue on macOS, epoll on Linux):

```milo
from "std/runtime" import { Task, schedulerWaitRead, schedulerWaitWrite }
from "std/event" import { setNonblocking }

let fd: i32 = 0    // e.g. an accepted socket
Task.spawn(move (): void => {
    setNonblocking(fd)
    // ... attempt read ...
    // if EAGAIN:
    schedulerWaitRead(fd)    // yields until fd is readable
    // ... retry read ...
})
```

### Transparent Async I/O

`stream.recv()` and `stream.send()` from `std/net` automatically detect when they're running inside a green thread. They set the socket non-blocking and yield on EAGAIN — no code changes needed:

```milo
from "std/net" import { TcpStream, resolve }
from "std/runtime" import { Task }

let ip = resolve("example.com")!
let port: u16 = 80
Task.spawn(move (): void => {
    let stream = TcpStream.connect(ip, port)!
    stream.send("hello")!         // yields if socket buffer full
    let data = stream.recv()!     // yields until data arrives
    print(data)
})
```

The same `stream.send()`/`stream.recv()` calls work identically outside green threads — they just block normally.

### Echo Server Example

A concurrent echo server handling multiple clients with green threads:

```milo
from "std/os" import { socket, bind, listen, accept, setsockopt, getsockname, ntohs }
from "std/platform" import { read, write, close, makeSockaddr, makeZeroedSockaddrStorage, sockAddrStorageLen, solSocket, soReuseaddr, getErrno, eagain }
from "std/event" import { setNonblocking }
from "std/runtime" import { Task, schedulerWaitRead }

fn main(): i32 {
    unsafe {
        let serverFd = socket(2, 1, 0)
        // ... bind, listen, setNonblocking(serverFd) ...

        Task.spawn(move (): void => {
            while true {
                // accept lets the kernel pick the peer's family, so the buffer is
                // sockaddr_storage-sized — a v6 peer does not fit a 16-byte sockaddr_in
                var clientAddr = makeZeroedSockaddrStorage()
                var addrlen: u32 = sockAddrStorageLen()
                let clientFd = accept(serverFd, clientAddr, addrlen)
                if clientFd < 0 {
                    if getErrno() == eagain() {
                        schedulerWaitRead(serverFd)
                        continue
                    }
                    continue
                }
                setNonblocking(clientFd)
                let fd = clientFd
                Task.spawn(move (): void => {
                    var buf: [u8 ; 4096] = [0 ; 4096]
                    // read + echo back, yielding on EAGAIN
                    let n = read(fd, buf, 4096)
                    if n > 0 { write(fd, buf, n) }
                    close(fd)
                })
            }
        })
    }
    return 0
}
```

### Green Thread vs OS Thread

| | OS Thread (`Promise.blocking`) | Green Task (`Task.spawn` / `Promise`) |
|---|---|---|
| Stack size | ~8MB | 64KB |
| Context switch | Kernel (microseconds) | Userspace (nanoseconds) |
| Max concurrent | ~hundreds | 10K+ |
| Best for | CPU-bound parallelism | I/O-bound concurrency |
| Preemptive | Yes | No (cooperative) |

### Green Thread API

| Function | Description |
|----------|-------------|
| `Task.spawn(move () => {...})` | Spawn a green thread |
| `schedulerYield()` | Yield to other green threads |
| `schedulerWaitRead(fd)` | Yield until fd is readable |
| `schedulerWaitWrite(fd)` | Yield until fd is writable |
| `schedulerCurrent()` | Get current task pointer (null if not in green thread) |
| `setNonblocking(fd)` | Set fd to non-blocking mode |

---

## Testing

### Assertions (std/testing)

```milo
from "std/testing" import { assert, assertEqual, assertStrEqual }

fn testArithmetic(): void {
    assertEqual(2 + 2, 4)
    assertEqual(10 * 3, 30)
    assert(true)
    assertMsg(1 > 0, "math is broken")
}

fn testStrings(): void {
    let s = "hello"
    assertStrEqual(s, "hello")
    assertEqual64(s.len, 5)
}
```

| Function | Description |
|----------|-------------|
| `assert(cond)` | Fail if false |
| `assertMsg(cond, msg)` | Fail with message |
| `assertEqual(got, expected)` | Compare i32 values |
| `assertEqual64(got, expected)` | Compare i64 values |
| `assertStrEqual(got, expected)` | Compare strings |
| `assertBool(got, expected)` | Compare bools |

### Test Runner

Test files use the `*_test.milo` naming convention. Test functions start with `test`.

```bash
# Run all *_test.milo files in current directory
milo test

# Run every *_test.milo file under a directory, recursively
milo test tests

# Run specific test file
milo test math_test.milo
```

Output:
```
math_test.milo
  testArithmetic ... ok
  testSubtraction ... ok
  testMultiplication ... ok

results: 3 passed, 0 failed, 3 total
```

---

## SQLite Database

```milo
from "std/sqlite" import { dbOpen, dbExec, dbQuery, dbStep, dbColumnInt, dbColumnText, dbFinalize, dbClose, dbLastInsertId }

let db = dbOpen("app.db")!

dbExec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")!
dbExec(db, "INSERT INTO users (name, age) VALUES ('Alice', 30)")!
dbExec(db, "INSERT INTO users (name, age) VALUES ('Bob', 25)")!

let stmt = dbQuery(db, "SELECT id, name, age FROM users ORDER BY id")!
while dbStep(stmt) {
    let name = dbColumnText(stmt, 1)
    let age = dbColumnInt(stmt, 2)
    print($"{name}, age {age}")
}
dbFinalize(stmt)
dbClose(db)
```

### Prepared Statements with Bindings

```milo
from "std/sqlite" import { dbOpen, dbQuery, dbBindInt, dbStep, dbColumnText, dbFinalize }

let db = dbOpen("app.db")!
let stmt = dbQuery(db, "SELECT * FROM users WHERE age > ?")!
dbBindInt(stmt, 1, 25)!
while dbStep(stmt) {
    print(dbColumnText(stmt, 1))
}
dbFinalize(stmt)
```

| Function | Description |
|----------|-------------|
| `dbOpen(path)` | Open/create database |
| `dbClose(db)` | Close database |
| `dbExec(db, sql)` | Execute non-query SQL |
| `dbQuery(db, sql)` | Prepare query |
| `dbStep(stmt)` | Next row (true if available) |
| `dbColumnInt(stmt, col)` | Get i32 column |
| `dbColumnInt64(stmt, col)` | Get i64 column |
| `dbColumnFloat(stmt, col)` | Get f64 column |
| `dbColumnText(stmt, col)` | Get string column |
| `dbColumnIsNull(stmt, col)` | Check if NULL |
| `dbBindInt(stmt, idx, val)` | Bind i32 parameter |
| `dbBindText(stmt, idx, val)` | Bind string parameter |
| `dbFinalize(stmt)` | Free statement |
| `dbLastInsertId(db)` | Last inserted rowid |
| `dbReset(stmt)` | Reset for re-execution |

---

## Standard Library Extras

### Terminal Colors (std/color)

```milo
from "std/color" import { Color }

print(Color.red("error: something failed"))
print(Color.green("success!"))
print(Color.bold(Color.blue("important")))
print(Color.yellow("warning: "), Color.dim("details"))
```

Available (all on `Color.`): `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, `bold`, `dim`, `italic`, `underline`, `strikethrough`, `bgRed`, `bgGreen`, `bgYellow`, `bgBlue`.

### UUIDs (std/uuid)

`Uuid` is a 16-byte value type (Copy, no heap). `toString()` is the only
allocating operation.

```milo
from "std/uuid" import { Uuid }

let id = Uuid.v7()          // time-ordered (RFC 9562); the better default for keys
let random = Uuid.v4()      // 122 random bits
print(id.toString())        // "019fcb1a-78ff-709f-8475-54c6d59b0057"

if let Some(u) = Uuid.parse("550e8400-e29b-41d4-a716-446655440000") {
    print(u.version())      // 4
    print(u == Uuid.nil())  // false
}
```

---

## Argument Parsing

The `std/argparse` module provides a declarative CLI argument parser with auto-generated help.

```milo
from "std/argparse" import { ArgParser }

fn main(): i32 {
    var parser = ArgParser.new("mytool", "a helpful description")
    parser.addPositional("file", "input file to process")
    parser.addOptionalPositional("output", "output path")
    parser.addString("format", "f", "output format", "json")
    parser.addBool("verbose", "v", "enable verbose output")
    parser.addI64("count", "n", "number of items", 10)
    parser.addRequired("token", "t", "API token")
    let args = parser.parse()

    let file = args.getString("file") ?? ""
    let fmt = args.getString("format") ?? "json"
    let verbose = args.getBool("verbose")
    let count = args.getI64("count")
    if let Option.Some(out) = args.getString("output") {
        print(out)
    }
    return 0
}
```

**Builder methods** (on `&mut ArgParser`):
- `addString(long, short, help, default)` — optional string flag
- `addRequired(long, short, help)` — required string flag (exits if missing)
- `addBool(long, short, help)` — boolean flag (present = true)
- `addI64(long, short, help, default)` — integer flag with validation
- `addPositional(name, help)` — required positional argument
- `addOptionalPositional(name, help)` — optional positional
- `enableTrailingArgs()` — collect remaining args after first positional

**Parsing**:
- `parse()` — parse from process arguments (auto `--help`, exits on error)
- `parseFrom(argv: Vec<string>)` — parse from a provided arg list (argv[0] = program name, skipped)

**Query methods** (on `&ParsedArgs`):
- `getString(name)` — `Option<string>`. `None` when the name was never declared, or
  was declared with no default and not supplied; `--flag ""` is `Some("")`. A declared
  default is a value, so it comes back as `Some`. Use `?? "fallback"` to collapse.
- `getI64(name)`, `getU16(name)`, `getBool(name)` — get typed values
- `has(name)` — check if flag/positional was provided
- `.positional` — `Vec<string>` of remaining positional args

The parser auto-handles `--help`/`-h` and validates required args, integer formats, and unknown flags.

---

## Quick Reference

| Concept | Syntax |
|---------|--------|
| Immutable binding | `let x = 42` |
| Mutable binding | `var x = 42` |
| Type annotation | `let x: i32 = 42` |
| Function | `fn name(a: i32): i32 { ... }` |
| Generic function | `fn name<T>(x: T): T { ... }` |
| Struct | `struct Name { field: Type }` |
| Enum | `enum Name { Variant(Type), Empty }` |
| Match | `match val { Variant(x) => { ... } }` |
| If let | `if let Variant(x) = val { ... }` |
| Let else | `let Enum.Variant(x) = val else { return }` (bind-forward; else must diverge) |
| Option shorthand | `T?` for `Option<T>` |
| Unwrap | `expr!` |
| Propagate | `expr?` |
| Default | `expr ?? default` |
| Array | `[1, 2, 3]` or `[0; 100]` |
| Vec | `var v: Vec<i32> = Vec.new()` |
| HashMap | `var m: HashMap<K, V> = HashMap.new()` |
| Heap | `Heap(value)`, deref with `*heaped` |
| Reference param | `fn f(x: &T)` or `fn f(x: &mut T)` |
| Closure | `(x: i32) => x * 2` |
| Import | `import "file.milo"` |
| Named import | `from "path" import { A, B }` |
| FFI | `extern fn name(args): ret` |
| Opaque foreign type | `extern type Name` |
| Extern struct | `extern struct Name { field: Type }` |
| Struct by value across FFI | `extern fn f(v: ExternStruct): ExternStruct` |
| C header for a library | `milo build-lib lib.milo -o lib.a` writes `lib.h` |
| String to C ptr | `s.cstr()` returns `*u8` |
| Trait | `trait Name { fn method(self: &Self): T }` |
| Impl trait | `impl Trait for Type { ... }` |
| Impl methods | `impl Type { ... }` |
| Derive | `@derive(Eq)` |
| Generic bound | `<T: Eq + Hash>` |
| Cast | `expr as Type` |
| Embed file | `@embedFile("path")` |
| Target OS (compile-time) | `@targetOs()` → `"darwin"`/`"linux"`/`"windows"` |
| JSON serialize | `jsonStringify(struct_val)` (flat, scalars only) |
| JSON struct codec | `@derive(Json)` → `v.toJson()`, `T.fromJson(text)` |
| String slice | `s[start..end]` |
| Vec / array slice | `v[start..end]` (non-owning `&[T]` view; works on `Vec` and fixed arrays) |
| Number to string | `n.toString()` |
| Bitwise | `& \| ^ << >> ~` |
| Hex / binary literal | `0xFF`, `0b1010` |
