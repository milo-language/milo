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
    var names: Vec<string> = Vec.new()
    names.push("alice")
    names.push("bob")

    let loud = names.map((n: &string) => n.toUpper())
    for name in loud {
        print(name)
    }

    return 0
}   // names and loud freed here — no GC, no manual free
```

### Concurrent I/O — just normal code

```milo
from "std/runtime" import { greenSpawn, schedulerWaitRead }
from "std/event" import { setNonblocking }

// Each client gets its own green thread (64KB stack, not 8MB)
greenSpawn(move (): void => {
    setNonblocking(serverFd)
    while true {
        let clientFd = accept(serverFd, ...)
        if clientFd < 0 && getErrno() == eagain() {
            schedulerWaitRead(serverFd)   // yield, not block
            continue
        }
        greenSpawn(move (): void => {
            handleClient(clientFd)        // runs concurrently
        })
    }
})
```

No `async`, no `await`, no `Future<T>`. Write blocking code — it yields automatically in a green thread.

### Real programs

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn main(): i32 {
    var r: Router = Router.new()
    r.use((ctx: &mut Context, next: (&mut Context) => Response) => {
        print(ctx.req.method + " " + ctx.req.path)
        return next(ctx)
    })
    r.get("/", (ctx: &mut Context) => ctx.html("<h1>Hello!</h1>"))
    r.get("/users/:id", (ctx: &mut Context) => {
        return ctx.json($"\{\"id\": \"{ctx.param(\"id\")}\"}")
    })
    serveRouter(8080, r)
    return 0
}
```

Router, middleware, path params, string interpolation — a full web server in 15 lines.

### Where Milo fits

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native | No async/await |
|---|---|---|---|---|---|
| Go | yes | no | no | yes | no |
| Rust | no | yes | yes | yes | no |
| Zig | no | no | no | yes | no |
| **Milo** | **no** | **no** | **yes** | **yes** | **yes** |

</div>
