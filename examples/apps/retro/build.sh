#!/usr/bin/env bash
# Build the retro-console binaries (menu + the three emulators) into ./bin.
# Works on macOS (homebrew SDL2) and Linux/Raspberry Pi (pkg-config SDL2).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bin="$here/bin"
mkdir -p "$bin"

# SDL2 link flags: prefer pkg-config (Linux/Pi), fall back to homebrew (macOS).
if command -v pkg-config >/dev/null && pkg-config --exists sdl2; then
    sdl_flags="$(pkg-config --libs sdl2)"
elif [ -d /opt/homebrew/lib ]; then
    sdl_flags="-L/opt/homebrew/lib -lSDL2"
else
    sdl_flags="-lSDL2"
fi

# --release for the emulators (need the speed); menu is trivial, build it fast.
opt="${RETRO_OPT:---release}"

build() {
    local src="$1" out="$2" o="$3"
    echo ">> building $out"
    ( cd "$repo" && bun run src/main.ts build "$src" -o "$bin/$out" $o -- $sdl_flags )
}

build examples/apps/menu.milo            menu    --debug
build examples/apps/nes/nes.milo         nes     "$opt"
build examples/apps/genesis/genesis.milo genesis "$opt"
build examples/apps/snes/snes.milo       snes    "$opt"

echo "done -> $bin"
