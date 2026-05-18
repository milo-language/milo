# Milo

Rust's safety. Go's simplicity. C's speed. No lifetime annotations.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

Milo is a memory-safe systems language that compiles to native code via LLVM. One ownership rule — references can't escape the function they're passed to — gives you Rust-level safety without lifetime annotations or borrow checker fights.

**[Learn more at cs01.github.io/milo](https://cs01.github.io/milo/)**
