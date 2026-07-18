# Milo

A memory-safe, intentionally simple systems language with formal verification — friendly to humans and AI.

**→ [cs01.github.io/milo](https://cs01.github.io/milo/)** — docs, language tour, playground, and demos you can play in the browser.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

We build the language by building applications with it — game-console emulators, a debugger, servers, a JavaScript engine, and the compiler itself, all written in Milo. Dogfooding real programs is faster than theory and analysis, and it yields a better language.

## Install

From source (needs [Bun](https://bun.sh) + LLVM):

```bash
git clone https://github.com/cs01/milo.git && cd milo
./milo run examples/hello.milo
./milo build examples/hello.milo -o hello
```

See **[Installation](https://cs01.github.io/milo/getting-started/installation)** for details.
