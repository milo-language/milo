# Milo

**Memory Safe. Simple. Native.**

A memory-safe systems language with simple syntax inspired by TypeScript, Python, and Rust. Compiles to native code via LLVM.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

**Memory safe. Simple. Native. [Vibe-codeable](docs/design.md#ai-assisted-development-vibe-coding).**

**[Docs & Playground](https://cs01.github.io/milo/)**
