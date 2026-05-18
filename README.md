# Milo

Milo is a fast, memory-safe language that compiles to native code via LLVM. It manages memory automatically through ownership tracking — no garbage collector, reference counting, or lifetime annotations needed. Its syntax and semantics draw from the best of Rust, TypeScript, and Python, making it easy for both people and AI to read and write.

Milo also takes a data-driven approach to language design. We survey real code from popular libraries and codebases to find the most common patterns, then make those the default or the easiest path in Milo. The result is a language where the thing you reach for first is usually the right thing.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

**[Docs & Playground](https://cs01.github.io/milo/)**
