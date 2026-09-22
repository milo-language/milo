<!-- doc-meta
system: install
purpose: how end users get a working milo (source build first, since main moves faster than releases; prebuilt binary second)
key-files: install.sh, .github/workflows/release.yml, milo, README.md
update-when: the install script, release asset naming, or the source-build path changes
last-verified: 2026-09-22
-->

# Installation

Milo changes quickly, so build from source and `git pull` to stay current.

You need **[Bun](https://bun.sh)** (the compiler is TypeScript) and **clang** (Milo emits LLVM IR and links with clang).

```sh
curl -fsSL https://bun.sh/install | bash   # bun
xcode-select --install                     # macOS: clang
sudo apt install clang                     # Debian/Ubuntu: clang
```

```sh
git clone https://github.com/milo-language/milo.git
cd milo
./milo run examples/hello.milo
```

```
Hello, Milo!
```

`./milo` runs `bun run src/main.ts`. To use `milo` from any directory, symlink it onto your PATH (the wrapper follows the link back to the repo):

```sh
sudo ln -s "$PWD/milo" /usr/local/bin/milo
```

## Prebuilt binary

Releases are single self-contained binaries (macOS and Linux, arm64 and x64) with the standard library built in. They lag `main`.

```sh
curl -fsSL https://milo-language.github.io/milo/install.sh | sh
```

This installs to `~/.local/bin` (`MILO_INSTALL_DIR` to change, `MILO_TAG` to pin a release). You still need clang. Tarballs are on the [releases page](https://github.com/milo-language/milo/releases/latest).

::: warning macOS quarantines browser downloads
A binary downloaded through a browser is quarantined and macOS refuses to run it. Use `curl`, or run `xattr -d com.apple.quarantine milo`.
:::
