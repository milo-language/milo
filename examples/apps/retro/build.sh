#!/usr/bin/env bash
# Build the retro-console binaries (menu + the three emulators) into ./bin.
# Works on macOS (homebrew SDL2) and Linux/Raspberry Pi (pkg-config SDL2).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bin="$here/bin"
mkdir -p "$bin"

# SDL2 comes from @link("SDL2") in the sources — no link flags needed here.

# --release for the emulators (need the speed); menu is trivial, build it fast.
opt="${RETRO_OPT:---release}"

build() {
    local src="$1" out="$2" o="$3"
    echo ">> building $out"
    ( cd "$repo" && bun run src/main.ts build "$src" -o "$bin/$out" $o )
}

build examples/apps/menu.milo            menu    --debug
build examples/apps/nes/nes.milo         nes     "$opt"
build examples/apps/genesis/genesis.milo genesis "$opt"
build examples/apps/snes/snes.milo       snes    "$opt"

echo "done -> $bin"
