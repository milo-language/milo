# Milo

Milo takes our favorite features from Rust, TypeScript, Python and more to make a fast, memory-safe language that's easy for both people and AI to read and write. It compiles to native code via LLVM, manages memory automatically through ownership tracking, and doesn't need a garbage collector, reference counting, or lifetime annotations.

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
