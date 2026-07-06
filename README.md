# Milo

**Memory safe. Formally verifiable. Native. [Vibe-codeable](docs/design.md#ai-assisted-development-vibe-coding).**

A memory-safe systems language with built-in contracts, safety profiles, and simple syntax. Compiles to native code via LLVM.

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
