# Milo

**An auditable, memory-safe systems language with requirements traceable through source, tests and object code. No lifetimes, no GC.**

[Docs](https://milo-language.github.io/milo/) · [Tour](https://milo-language.github.io/milo/tour) · [Stdlib](https://milo-language.github.io/milo/stdlib/)

Safety-critical software is built with bidirectional traceability: every requirement links to its source, tests and object code, and everything in the binary links back to a requirement. On most projects each part lives in a different tool (a requirements database, requirement IDs in comments, separate test and coverage tools) and scripts hold them together. Milo makes the whole trace part of the language and the compiler. It works the same for code written by a person or by an AI agent. The site lists the [command for each activity](https://milo-language.github.io/milo/#commands-for-each-activity).

- **Requirements traceability.** `milo trace` links each requirement to its source, proofs, tests and object-code address ranges. `milo trace-object` checks that every instruction in the binary maps to a source line or a language rule. [How](#from-requirement-to-object-code)
- **Proven or checked.** `requires` and `ensures` are part of the language. `milo prove` proves a contract for every input or hands back the input that breaks it, and what is not proven asserts at run time in every build. [How](#proven-or-checked)
- **Safe without lifetimes.** References are parameters only, so there is nothing to annotate and nothing to collect, and a proof needs no aliasing annotations. [Why that works](#second-class-references)
- **Fast.** Trades wins with Rust across five benchmarks, with overflow checks left on. [Numbers](#performance)

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r = Router.new()
    r.get("/", (c: &mut Context) => Response.Html("hello from milo"))
    r.get("/users/:id", (c: &mut Context) => Response.Text($"user {c.param("id")!}"))
    serveRouter(8080, r)!
    return 0
}
```

Compiles through LLVM to a static binary.

```sh
curl -fsSL https://milo-language.github.io/milo/install.sh | sh   # prebuilt compiler, needs clang to link
milo run hello.milo
```

The installer fetches a standalone binary for macOS or Linux (arm64 or x64) from the [newest versioned release](https://github.com/milo-language/milo/releases/latest). Breaking changes land in versioned releases, listed in [breaking-changes.md](docs/breaking-changes.md); `MILO_TAG=latest` installs the rolling build of `main` instead. To build from source you also need [bun](https://bun.sh): clone the repo and run `./milo run examples/hello.milo`. [Installation](https://milo-language.github.io/milo/getting-started/installation) has the details.

## Second-class references

A value is *first-class* if you can store it, return it and pass it around, and *second-class* if you can only pass it down into a call. In Milo, references are second-class: `&T` and `&mut T` are parameters only. You cannot return one, store one in a struct, or keep one past the call.

That one restriction is what keeps the rest of the language simple. A reference that can outlive the call that made it is the reason C has dangling pointers, Rust has lifetime annotations, and Java and Go have a garbage collector. A reference that only travels down the call stack cannot outlive what it points to, because the owner is still alive in the caller until the call returns. So safety needs no annotations and no runtime. What you give up is pointing into memory you do not own: you own the buffer and carry an index, a `Span`, or an arena handle, or you `clone()`.

It also buys **local reasoning**: the function you are reading is the whole story of the values it touches. No pointer into its locals can exist anywhere else, so every mutation is visible at the call site.

```milo
fn zeroNegatives(values: &mut Vec<i64>): void {
    for i in 0..values.len {
        if values[i] < 0 {
            values[i] = 0       // in place, no copy, no allocation
        }
    }
}

fn main(): void {
    var v: Vec<i64> = [3, -1, 4, -5, 9]
    zeroNegatives(&mut v)      // the only line that can change v
    print(v)                   // [3, 0, 4, 0, 9]
}
```

The ownership checker settles everything inside one function. It never consults a lifetime on a signature three modules away, and neither do you.

## In C, in Rust, in Milo

| What you want | C | Rust | Milo |
|---|---|---|---|
| Return a pointer into a buffer you still hold | `char *`, you promise it stays valid | `fn longest(...) -> &'a str` | Not expressible. Return an index, a `Span`, or an owned string. |
| A parser that keeps the input | `struct Parser { char *src; }` | `struct Parser<'a> { src: &'a str }` | Own the input; store a cursor (`pos: i64`). |
| Iterator over a collection | pointer into the array | `Iterator<Item = &T>` | A cursor; each step takes the store: `scanNext(&store, &mut cursor)`. |
| Graph, parent pointer, DOM | `Node *next` | `Rc<RefCell<Node>>` or an arena crate | `std/arena`: `Arena<T>` plus `Handle<T>`, checked at runtime. |
| Temporary read / mutation in a call | pointer argument | `&T` / `&mut T` | `&T` auto-borrowed; `&mut T` written at the call: `f(&mut x)`. |
| Two owners of one buffer | two pointers, good luck | lifetimes, or `clone` / `Arc` | `.clone()`, or `seal` it and share a read-only copy. |

Same memory-safety guarantees as Rust wherever both languages can express the program, plus concurrency without `Send` / `Sync` (a value that cannot hold a borrow moves to another task as is).

## Proven or checked

Contracts are part of the language, and every one is either proven or checked. `milo prove` settles a contract for every input, not the ones you thought to test:

```milo
fn clamp(x: i64, lo: i64, hi: i64): i64
    requires lo <= hi
    ensures result >= lo && result <= hi
{
    if x < lo { return lo }
    if x >= hi { return x }    // bug: should return hi
    return x
}
```

```
$ milo prove clamp.milo
  ✗ [postcondition] clamp: failed — counterexample: x = 0, lo = -1, hi = -1, result = 0
```

Fix the line and the same command reports `✓ [postcondition] clamp: proven`. The vocabulary is close to SPARK's: `requires`, `ensures`, loop and struct `invariant`, `decreases` for termination, `old(e)`. It's discharged by z3 (a runtime requirement of `milo prove`: `brew install z3` / `apt install z3`). A contract you have not proven is still checked: `requires` and `ensures` assert at runtime in every build, release included (`--no-contract-checks` opts out).

What "proven" means is itself machine-checked. [proofs/](proofs/README.md) models the contract rules in Lean and proves three things: a proven program never fails a contract clause, dropping the runtime checks from a proven program changes nothing, and in any program the default build only returns from a call whose `requires` and `ensures` held. The proof is about the rules, not the compiler's code or z3, and it does not yet cover memory safety.

Proof is practical here because of the reference rule above. Proving a function correct is hard in C and C++ because any pointer might alias any other. In Milo nothing outside a function can point into its values, so a call can change only what its `&mut` arguments name. The verifier needs no separation logic and no aliasing annotations. This is the same reason SPARK proofs scale, and it comes from the memory model rather than a verification dialect bolted on top.

It also fits agent-written code. Write the contract, and let the agent loop on `milo prove --json` until every condition is proven. You review a few lines of spec instead of the whole implementation, and a counterexample is a concrete input it can fix against.

Not there yet, said plainly: overflow, out-of-bounds indexing and division by zero are trapped at runtime, and `milo prove --rte` proves them absent site by site, but today that covers about a third of the sites in the standard library and embedded examples, so it is opt-in. There are no quantifiers, so "this Vec is sorted" can't be stated yet. Both are next on the [verification roadmap](docs/verification-roadmap.md).

## From requirement to object code

Requirements trace all the way to object code. Tag a function `@req(LLR-1)` and `milo trace` reports, per requirement, the function, whether its contract is proven, the tests that cover it, and the address ranges it became in the binary:

```
$ milo trace pid.milo --strict --object pid
LLR-1  Every command is clamped to [outLo, outHi] on its way out of the PID step.
  implemented   pid.milo:27 clampI32
  implemented   pid.milo:44 pidStep
  object        0x100000680-0x1000006b0 (48 B) clampI32  lines 28-32
  object        0x1000006c0-0x100000848 (392 B) pidStep  lines 32-68
  object        0x1000008b4-0x1000008d8 (36 B) nextIntegral  lines 32-32
  object        0x100000900-0x100000918 (24 B) clampInput  lines 32-32
  object        0x10000097c-0x100000998 (28 B) controlTick  lines 32-32
  formalized    PROVEN   pid.milo:30 ensures result >= lo && result <= hi  [clampI32]
  formalized    PROVEN   pid.milo:57 ensures result >= outLo && result <= outHi  [pidStep]
  verified      PROOF     2 formalizing clauses PROVEN
  verified      PASS      pid_test.milo:7 testClampKeepsValueInRange
  verified      PASS      pid_test.milo:15 testStepOutputWithinRange
```

`milo trace-object --strict` goes the other way and fails on any instruction that maps to no source line and no language rule (bounds check, overflow trap, contract check, drop). The [PID controller demo](examples/assured/pid/README.md) is the worked example. Not built yet: MC/DC measured on the object code, and translation validation of the compiler itself.

For certification work, `milo safety --safety=do178c-a` (also ISO 26262, IEC 61508/62304, NASA profiles) checks the source against a profile, and `milo wcet` emits loop-bound flow facts for OTAWA timing analysis. The tools produce evidence; none of them is a qualified tool under DO-330.

## What you give up

- **Returning or storing a view.** Use an index, `Span`, owned copy, or arena handle.
- **Some zero-copy.** Where Rust hands out a borrow, Milo sometimes asks for a `clone()`.
- **One check moves to runtime.** "This offset still belongs to that buffer" is a named runtime failure, not a compile error and not a segfault.

Good fit: CLIs, services, compilers, emulators, anything you would write in careful C as a buffer plus integer ids. Awkward fit: code that wants to keep an object graph as is (widget trees with parent pointers, intrusive lists, parsers that store slices of their input). Those become arenas and handles, and won't look like the original ([what that looks like](https://milo-language.github.io/milo/language/patterns#build-a-tree-or-graph-whose-nodes-refer-to-each-other)).

## Performance

Five benchmarks against Rust, with every row printing the same checksum. Time at the largest size, best implementation per language, Apple M-series, `--release`. Below 1.00 means Milo is faster.

| Benchmark | Milo vs Rust |
|---|---|
| respond (JSON rendering, streaming) | **0.81** |
| interp (tree-walking interpreter) | **0.87** |
| records (variant records) | **0.90** |
| graph (CSR build and walk) | 1.02 |
| blur (image kernel) | 1.07 |

Peak memory is within 12% of Rust on all five. Milo keeps its overflow checks on; the Rust rows have none. Full tables, including C++, are in [benchmarks/vs-goose/results.md](benchmarks/vs-goose/results.md); [benchmarks](benchmarks) has Milo against C and Go.

## Status

Young, but dogfooded: 250k+ lines of Milo across a port of the compiler, a JS engine, three emulator cores, a debugger, and a dozen packages. Nearly every `unsafe` block is the C boundary; none exist because the ownership model rejected the program.

More: [why there are no lifetimes](https://milo-language.github.io/milo/language/why-no-lifetimes) · [memory safety vs Rust](https://milo-language.github.io/milo/language/vs-rust) · [`std/arena`](https://milo-language.github.io/milo/stdlib/arena)
