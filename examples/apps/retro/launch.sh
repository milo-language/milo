#!/usr/bin/env bash
# Retro-console main loop: show the menu, launch the picked emulator, and return
# to the menu when the game exits. Runs the menu in a shell loop (not via an
# in-process exec) so an emulator crash drops back to the menu instead of taking
# the whole console down.
#
#   ./launch.sh              # windowed (dev)
#   ./launch.sh --fullscreen # TV / Pi kiosk
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
bin="${RETRO_BIN:-$here/bin}"

# The menu emits ROM paths relative to the ROM root (e.g. roms/nes/SMB3.nes), so
# both the menu and the emulators must run from the directory that holds roms/.
work="${RETRO_HOME:-$(cd "$here/../../.." && pwd)}"
cd "$work"

if [ ! -x "$bin/menu" ]; then
    echo "menu binary not found in $bin — run build.sh first" >&2
    exit 1
fi

while true; do
    # Menu prints "<system>\t<rompath>" and exits 0 on a pick; exits non-zero on
    # quit/back (B or Esc), which ends the console.
    if ! sel="$("$bin/menu" "$@")"; then
        break
    fi
    [ -z "$sel" ] && break

    sys="${sel%%$'\t'*}"
    rom="${sel#*$'\t'}"
    case "$sys" in
        nes)     "$bin/nes" "$rom" ;;
        genesis) "$bin/genesis" "$rom" ;;
        snes)    "$bin/snes" "$rom" ;;
        *)       echo "unknown system: $sys" >&2 ;;
    esac
done
