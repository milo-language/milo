---
layout: home
hero:
  name: Milo
  text: "Rust's safety. Go's simplicity."
  tagline: "A native systems language with ownership, green threads, and zero lifetime annotations. Within 5% of C. Concurrency without async/await."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/

features:
  - title: No Lifetime Annotations. Ever.
    details: "Rust's biggest learning cliff, gone. The compiler tracks ownership and frees memory for you. If you can write Go or TypeScript, you can write Milo."
  - title: Faster Than Go
    details: "Compiles to native code via LLVM. Beats C on some benchmarks, within 5% on the rest. Sub-millisecond startup."
  - title: Concurrency That Just Works
    details: "Write normal blocking code. It automatically runs concurrently in a green thread. No async, no await, no rewiring your entire codebase."
  - title: Safe By Default
    details: "The compiler catches memory bugs, null errors, data races, and integer overflow — all before your code runs. Five safety guarantees, zero runtime cost."
---

### Familiar syntax, serious guarantees

```milo
fn main(): i32 {
    let names: Vec<string> = ["alice", "bob"]

    let loud = names.map((n: &string) => n.toUpper())
    for name in loud {
        print(name)
    }

    return 0
}   // names and loud freed here — no GC, no manual free
```

### The safety you want without the syntax you don't

```milo
fn processLine(line: &string): void {
    let method = line[0..3]       // zero-copy — no allocation
    let path = line[4..line.len]
    print(method, " -> ", path)
}
```

`&string` is a borrow. It can't outlive the data it points to. The compiler enforces this — no annotations needed.

### Real programs

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r: Router = Router.new()
    r.get("/", (ctx: &mut Context) => ctx.html("<h1>Hello!</h1>"))
    r.get("/users/:id", (ctx: &mut Context) => {
        let id = ctx.param("id")
        return ctx.json($"\{\"id\": \"{id}\"}")
    })
    serveRouter(8080, r)
    return 0
}
```

Router, path params, string interpolation — a web server in 10 lines. No framework, no dependencies. This is the standard library.

### Where Milo fits

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native | No async/await |
|---|---|---|---|---|---|
| Go | yes | no | no | yes | no |
| Rust | no | yes | yes | yes | no |
| Zig | no | no | no | yes | no |
| **Milo** | **no** | **no** | **yes** | **yes** | **yes** |

</div>
