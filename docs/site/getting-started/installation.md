# Installation

Milo requires two dependencies:

- **[Bun](https://bun.sh)** — runs the compiler (TypeScript)
- **LLVM/Clang** — backend code generation and linking

## Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install LLVM

**macOS:**
```bash
brew install llvm
```

**Ubuntu/Debian:**
```bash
sudo apt install llvm clang
```

## Get Milo

```bash
git clone https://github.com/cs01/milo.git
cd milo
```

## Verify it works

```bash
bun run src/main.ts run examples/hello.milo
```

You should see:

```
hello, world!
```

Next: [Quickstart →](./quickstart)
