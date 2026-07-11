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

## Self-hosting

Milo compiles itself. `milo0` — the compiler written in Milo ([`src-milo/`](src-milo/), ~8.2K lines) — compiles its own source to a **byte-identical fixed point at `-O2`**: `stage1 == stage2 == stage3`, 161K-line IR identical, manifest-wide 212/339 fixtures emitting identical IR across stages with zero divergences.

```bash
sh scripts/selfhost.sh            # oracle builds stage1 (stage1 binary is gitignored)
bun test tests/selfhost.test.ts   # smoke + manifest convergence gate
```

See **[docs/self-hosting.md](docs/self-hosting.md)** for the milestone log and the eight compiler miscompiles the self-compile exposed and fixed.
