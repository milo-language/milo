# Milo

A memory-safe systems language. Ownership without lifetimes, contracts the compiler checks, native binaries via LLVM.

Milo keeps ownership — single owner, moves, borrowed references — and drops the machinery that makes it hard: no lifetime annotations, no borrow-checker puzzles, no `unsafe` in everyday code. Small enough to hold in your head; proven by shipping, not theory — game-console emulators, terminal apps, an HTTP/TLS/JSON standard library, a package manager, and the compiler itself are all written in Milo. Even the contract prover behind `milo prove` is a Milo program, and it discharges the contracts in Milo's own standard library on every test run.

> When you hand a value to someone else, you don't have it anymore. That's it. The compiler enforces this rule, and from it you get memory safety, no dangling pointers, and no data races — all at zero runtime cost.

```milo
from "std/http" import { Request, Response, serve }

fn main(): i32 {
    serve(8080, (req: &Request) => {
        return Response.Html("<h1>hello from milo</h1>")
    })!
    return 0
}
```

**[Docs & Playground](https://cs01.github.io/milo/)** · **[Demos](https://cs01.github.io/milo/demos)** — NES, Genesis, and SNES emulators written in Milo, playable in your browser.

## Install

From source (needs [Bun](https://bun.sh) + LLVM): clone the repo and use the `./milo` wrapper — it's just `bun run src/main.ts <args>`:

```bash
git clone https://github.com/cs01/milo.git && cd milo
./milo run examples/hello.milo
./milo build examples/hello.milo -o hello
```

See **[Installation](https://cs01.github.io/milo/getting-started/installation)** for details.

## Self-hosting

Milo compiles itself. `milo0` — the compiler written in Milo ([`src-milo/`](src-milo/), ~8.2K lines) — compiles its own source to a **byte-identical fixed point at `-O2`**: `stage1 == stage2 == stage3`, 161K-line IR identical, manifest-wide 212/339 fixtures emitting identical IR across stages with zero divergences.

```bash
sh scripts/selfhost.sh            # oracle builds stage1 (stage1 binary is gitignored)
bun test tests/selfhost.test.ts   # smoke + manifest convergence gate
```

See **[docs/self-hosting.md](docs/self-hosting.md)** for the milestone log and the eight compiler miscompiles the self-compile exposed and fixed.
