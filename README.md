# Milo

A memory-safe systems language that compiles to native code via LLVM. Ownership without lifetimes.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        print("GET ", req.path)
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

```bash
$ milo run server.milo
listening on :8080
```

|  | GC | Lifetimes | Ownership | Native |
|---|---|---|---|---|
| Go | yes | no | no | yes |
| Rust | no | yes | yes | yes |
| **Milo** | **no** | **no** | **yes** | **yes** |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cs01/milo/main/install.sh | sh
```

Or set a custom install directory:

```bash
MILO_INSTALL_DIR=~/.local/bin curl -fsSL https://raw.githubusercontent.com/cs01/milo/main/install.sh | sh
```

Requires LLVM/Clang on your system for linking.

## Quick start

```bash
milo run server.milo            # compile and run
milo build server.milo -o server  # build a binary
```

### Development (from source)

Requires: [Bun](https://bun.sh), LLVM/Clang.

```bash
bun run src/main.ts run examples/hello.milo        # compile and run
bun run src/main.ts build examples/hello.milo -o hello  # build a binary
bun test                                            # run tests
```

**VS Code** — install the extension for syntax highlighting, diagnostics, hover, go-to-definition, and autocomplete:

```bash
cd editors/vscode && bun install && bun run build
ln -s "$(pwd)" ~/.vscode/extensions/milo.milo-lang-0.2.0
```

## Documentation

**[Language Guide →](docs/language-guide.md)** — full walkthrough: types, ownership, error handling, closures, threads, FFI, and stdlib.

**[Roadmap →](docs/roadmap.md)** — what's done, what's next.
