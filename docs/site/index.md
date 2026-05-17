---
layout: home
hero:
  name: Milo
  text: "Memory safety for dummies."
  tagline: "A modern systems language that compiles to native code. No GC, no lifetime annotations, no PhD required."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/

features:
  - title: You Already Know This
    details: "let/var, arrow functions, for-in loops, generics with angle brackets. If you've written any modern language, you can read Milo on day one."
  - title: Memory Safe. No GC.
    details: "The compiler tracks ownership and frees memory for you. Use-after-free? Caught at compile time. No garbage collector pauses, no manual malloc/free."
  - title: No Lifetime Annotations
    details: "Rust's biggest learning cliff, gone. References can't escape the function they're passed to — one simple rule replaces an entire chapter of the Rust book."
  - title: Fast
    details: "Within 3% of C on most benchmarks. Sub-millisecond startup, binaries under 300KB. Compiles to native code via LLVM."
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
}   // names and loud are freed here — no GC, no manual free
```

Modern syntax. Native performance. Memory safe by default.

### The safety you want without the syntax you don't

```milo
fn processLine(line: &string): void {
    let method = line[0..3]       // zero-copy view — no allocation
    let path = line[4..line.len]
    print(method, " -> ", path)
}
```

`&string` is a borrow. It can't outlive the data it points to. The compiler enforces this — no annotations required from you.

### Real programs

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn homeHandler(ctx: &mut Context): Response {
    return ctx.html("<h1>Hello!</h1>")
}

fn userHandler(ctx: &mut Context): Response {
    let id = ctx.param("id")
    return ctx.json($"\{\"id\": \"{id}\"}")
}

fn logMiddleware(ctx: &mut Context, next: (&mut Context) => Response): Response {
    print(ctx.req.method + " " + ctx.req.path)
    return next(ctx)
}

fn main(): i32 {
    var r: Router = Router.new()
    r.use(logMiddleware)
    r.get("/", homeHandler)
    r.get("/users/:id", userHandler)
    serveRouter(8080, r)
    return 0
}
```

Router, middleware, path params, context — a full web server in 20 lines.

### JSON that doesn't fight you

```milo
from "std/json" import { jsonParse }

fn main(): i32 {
    let j = jsonParse("{\"name\": \"milo\", \"version\": 1, \"fast\": true}")!

    let name = j.str("name")!           // "milo"
    let ver = j.i64("version")!         // 1
    let fast = j.bool("fast")!          // true

    // Nested access
    let config = jsonParse("{\"db\": {\"host\": \"localhost\", \"port\": 5432}}")!
    let host = config.get("db")!.str("host")!
    let port = config.get("db")!.i64("port")!

    print($"{name} v{ver} — {host}:{port}")
    return 0
}
```

Zero-copy parsing, typed accessors, explicit error handling with `!` and `?`. No `any`, no runtime type errors, no `undefined is not an object`.

### Where Milo fits

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native | Familiar Syntax |
|---|---|---|---|---|---|
| Go | yes | no | no | yes | yes |
| Rust | no | yes | yes | yes | no |
| TypeScript | yes | no | no | no | yes |
| **Milo** | **no** | **no** | **yes** | **yes** | **yes** |

</div>
