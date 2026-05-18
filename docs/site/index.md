---
layout: home
hero:
  name: Milo
  text: "Memory-safe. Native. Simple."
  tagline: "A compiled systems language with automatic memory management and no lifetime annotations."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/
---

<div class="pillars-colored">
  <div class="color-item">
    <h2 class="ch-blue">100% memory-safe. Proven at compile time.</h2>
    <p>No null pointers. No dangling references. No data races. No buffer overflows. All caught before your code ever runs.</p>
  </div>
  <div class="color-item">
    <h2 class="ch-green">No lifetime annotations. Ever.</h2>
    <p>One ownership rule: references can't escape the function they're passed to. That's it.</p>
  </div>
  <div class="color-item">
    <h2 class="ch-purple">Native speed. Tiny binaries.</h2>
    <p>Compiles to native code via LLVM. Sub-millisecond startup. Binaries under 300KB.</p>
  </div>
  <div class="color-item">
    <h2 class="ch-orange">Learn it in a weekend.</h2>
    <p>If you've written any typed language, you already know most of Milo. And so does your AI.</p>
  </div>
</div>

<div class="section-break"></div>

### If you know Go or TypeScript, you know Milo

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

```milo
fn printExtension(filename: &string): void {
    let dot = filename.lastIndexOf(".")
    print(filename[dot + 1..filename.len])   // zero-copy slice
}
```

`&string` is a borrow. It can't outlive the data it points to. The compiler enforces this — no annotations needed.

### Real programs

```milo
from "std/http" import { Context, Router, serveRouter }

fn main(): i32 {
    var r: Router = Router.new()
    r.get("/", (ctx: &mut Context) => ctx.html("<h1>Hello!</h1>"))
    r.get("/users/:id", (ctx: &mut Context) => {
        let id = ctx.param("id")
        return ctx.text(id)
    })
    serveRouter(8080, r)
    return 0
}
```

Router, path params, green threads — a web server in 10 lines. No framework, no dependencies. This is the standard library.

