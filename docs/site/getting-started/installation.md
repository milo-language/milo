# Installation

Two ways to get Milo. Most people want the prebuilt binary.

## Option A — Prebuilt binary (recommended)

One command installs a standalone `milo` to `/usr/local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/cs01/milo/main/install.sh | sh
```

Then use `milo` from anywhere:

```bash
milo run examples/hello.milo
```

## Option B — From source (for contributors)

Building from source needs two dependencies:

- **[Bun](https://bun.sh)** — runs the compiler (TypeScript)
- **LLVM/Clang** — backend code generation and linking

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

Install LLVM — **macOS:** `brew install llvm` · **Ubuntu/Debian:** `sudo apt install llvm clang`

Clone the repo:

```bash
git clone https://github.com/cs01/milo.git
cd milo
```

The repo ships a `./milo` wrapper script — it's just `bun run src/main.ts <args>`, so `./milo build`, `./milo run`, etc. work the same as the installed binary (only with a `./` prefix, and run from the repo root).

## Verify it works

```bash
milo run examples/hello.milo     # installed binary
./milo run examples/hello.milo   # from a repo clone
```

You should see:

```
Hello, Milo!
```

Next: [Quickstart →](./quickstart)
