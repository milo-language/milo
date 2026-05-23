---
layout: home
hero:
  name: Milo
  text: "Memory Safe. Simple. Native."
  tagline: "A memory-safe systems language with simple syntax inspired by TypeScript, Python, and Rust. Compiles to native code via LLVM."
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
    <h2 class="ch-orange">Learn it in a weekend. So does your AI.</h2>
    <p>If you've written any typed language, you already know most of Milo. Simple rules + loud errors = <a href="/milo/ai-coding">LLMs catch mistakes at compile time, not in production</a>.</p>
  </div>
</div>

<div class="section-break"></div>

### If you know TypeScript or Python, you know Milo

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

### Built for AI coding

C++ has ~200 categories of undefined behavior. Rust has lifetime annotations that trip up LLMs. Milo has neither — wrong code fails to compile with a clear error, not silently at runtime. Simple rules and loud errors mean LLMs spend less time fighting the compiler and more time shipping features.

<div class="compare-grid">

<div class="compare-col">

**C++ — compiles, crashes**

```cpp
std::string_view getName() {
    std::string s = "hello";
    return s;  // dangling reference, UB
}
```

</div>
<div class="compare-col">

**Milo — compile error**

```milo
fn getName(): &string {  // ERROR: can't return ref
    let s = "hello"
    return s
}
```

</div>
</div>

Milo also ships `milo skill` — a machine-readable language guide that gives any LLM full knowledge of the language, standard library, and idioms in a single command.

<a href="/milo/ai-coding">See the full comparison vs. C++ and Rust →</a>

### Built-in formal verification and safety profiles

Annotate functions with contracts — the compiler proves them correct at compile time, with zero runtime cost.

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

`milo verify` exports SMT-LIB2 for theorem provers like Z3. `milo safety --safety=do178c-a` checks your code against avionics, automotive, spacecraft, industrial, and medical device coding standards. No third-party tools, no proprietary licenses — it's built into the compiler.

<a href="/milo/language/safety">Learn about contracts and safety profiles →</a>

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

