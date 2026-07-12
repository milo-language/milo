---
layout: home
hero:
  name: Milo
  text: "Memory Safe. Formally Verifiable. Native."
  tagline: "A memory-safe systems language with built-in contracts, safety profiles, and simple syntax. Compiles to native code via LLVM."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn More
      link: /language/
---

<div class="pillars-colored">
  <div class="color-item">
    <h2 class="ch-blue">100% memory-safe. Proven at compile time.</h2>
    <p>No null pointers. No dangling references. No data races. No buffer overflows. All caught before your code ever runs.</p>
  </div>
  <div class="color-item">
    <h2 class="ch-purple">Native speed. Tiny binaries.</h2>
    <p>Compiles to native code via LLVM. Sub-millisecond startup. Binaries under 300KB.</p>
  </div>
  <div class="color-item">
    <h2 class="ch-orange">Formally verifiable. Built for AI.</h2>
    <p>Built-in contracts and safety profiles let you prove code correct with theorem provers. Simple rules + loud errors = <a href="/milo/ai-coding">LLMs catch mistakes at compile time, not in production</a>.</p>
  </div>
</div>

<div class="section-break"></div>

<TourStepper />

<div class="section-break"></div>

### Simple, familiar syntax

```milo
fn main(): i32 {
    let names: Vec<string> = ["alice", "bob"]
    let loud = names.map((n: &string) => n.toUpper())
    print(loud.join(", "))
    return 0
}
```

No garbage collector. No manual memory management. The compiler tracks ownership and frees everything automatically.

### Simple syntax, guaranteed memory safety

`&string` is a borrow — temporary, read-only access. It can't outlive the data it points to. The compiler enforces this without annotations.

```milo
fn printExtension(filename: &string): void {
    let dot = filename.lastIndexOf(".")
    if dot >= 0 {
        print(filename[dot + 1..filename.len])   // zero-copy slice
    }
}
```

### Lightweight concurrency, native performance

Promises run on green threads — no async/await coloring, no event loop. Write blocking code that runs concurrently.

```milo
from "std/net" import { fetch }
from "std/runtime" import { Promise }

fn main(): i32 {
    let page = Promise(() => fetch("https://example.com")!)
    print(page.await()!.body)
    return 0
}
```

### Batteries included

A web server with routing, path params, and closures — all from the standard library.

```milo
from "std/http" import { Context, Router, serveRouter }

fn main(): i32 {
    var r: Router = Router.new()
    r.get("/", (ctx: &mut Context) => ctx.html("<h1>Hello!</h1>"))
    r.get("/users/:id", (ctx: &mut Context) => {
        let id = ctx.param("id")
        return ctx.text(id)
    })
    match serveRouter(8080, r) {
        Result.Ok(_) => { return 0 }
        Result.Err(e) => {
            print("error: ", e)
            return 1
        }
    }
}
```

### Built for AI coding — formally verifiable

AI-generated code needs more than type checks. Milo has built-in contracts — `requires`, `ensures`, `invariant` — that the compiler type-checks and `milo verify` exports as SMT-LIB2 for theorem provers like Z3. AI writes the code, the prover proves it correct.

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

No lifetime annotations to trip up LLMs. No undefined behavior to hide bugs. Wrong code fails with a clear compile error — or gets formally disproved. `milo safety --safety=do178c-a` checks against avionics, automotive, and medical device coding standards with no third-party tools. Code that passes a safety profile is structurally ready for WCET analysis — no recursion, bounded loops, no dynamic allocation.

Milo also ships `milo skill` — a machine-readable language guide that gives any LLM full knowledge of the language, standard library, and idioms in a single command.

<a href="/milo/ai-coding">See the full comparison vs. C++ and Rust →</a> · <a href="/milo/language/safety">Contracts and safety profiles →</a>

<div class="section-break"></div>

<div class="cta-section">

### Ready to try Milo?

<div class="cta-buttons">
  <a class="cta-primary" href="/milo/getting-started/installation">Get Started</a>
  <a class="cta-secondary" href="/milo/language/">Learn More</a>
  <a class="cta-secondary" href="/milo/roadmap">Roadmap</a>
  <a class="cta-secondary" href="https://github.com/cs01/milo">GitHub</a>
</div>

</div>

