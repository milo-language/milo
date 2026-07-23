#!/usr/bin/env bash
# Milo Arcade — one front door for the NES, Genesis, and SNES emulators.
# Detects the console from the ROM extension, builds the matching core (cached),
# and runs it with SDL video + audio + input.
#
#   examples/apps/arcade.sh <rom>   run a specific ROM
#   examples/apps/arcade.sh          interactive menu of every ROM under roms/
#
# Ext -> core:  .nes = NES ;  .md/.gen/.bin/.smd = Genesis ;  .sfc/.smc = SNES
set -uo pipefail
cd "$(dirname "$0")/../.."

# echo "<dir> <entry>" for a lowercase extension, or nothing if unknown.
core_for() {
  case "$1" in
    nes)                 echo "nes nes" ;;
    md|gen|bin|smd|68k)  echo "genesis genesis" ;;
    sfc|smc)             echo "snes snes" ;;
    *)                   echo "" ;;
  esac
}

run_rom() {
  local rom="$1"
  local ext; ext=$(echo "${rom##*.}" | tr '[:upper:]' '[:lower:]')
  local core; core=$(core_for "$ext")
  if [ -z "$core" ]; then echo "unknown ROM type: .$ext"; return 1; fi
  local dir="${core% *}" entry="${core#* }"
  local src="examples/apps/$dir/$entry.milo" bin="/tmp/milo-$dir"
  # Rebuild if the binary is missing or any .milo in the core dir is newer.
  if [ ! -x "$bin" ] || [ -n "$(find "examples/apps/$dir" -name '*.milo' -newer "$bin" 2>/dev/null)" ]; then
    echo "building $dir core..."
    bun run src/main.ts build "$src" -o "$bin" || return 1
  fi
  echo "running $dir: $rom  (Esc to quit)"
  "$bin" "$rom"
}

if [ $# -ge 1 ]; then run_rom "$1"; exit $?; fi

# Interactive menu of curated games (roms/games + SNES homebrew). Skips the huge
# test-rom trees and README.md (which collides with the .md Mega Drive extension).
roms=()
while IFS= read -r line; do roms+=("$line"); done < <(
  find roms/games roms/krom-snes -maxdepth 3 -type f \
    ! -iname 'README*' \
    \( -iname '*.nes' -o -iname '*.md' -o -iname '*.gen' -o -iname '*.bin' \
       -o -iname '*.smd' -o -iname '*.sfc' -o -iname '*.smc' \) 2>/dev/null | sort)
if [ ${#roms[@]} -eq 0 ]; then echo "no ROMs found under roms/"; exit 1; fi

echo "=== Milo Arcade — NES · Genesis · SNES ==="
i=1
for r in "${roms[@]}"; do
  ext=$(echo "${r##*.}" | tr '[:upper:]' '[:lower:]'); c=$(core_for "$ext")
  printf "%3d) [%-7s] %s\n" "$i" "${c% *}" "${r#roms/}"
  i=$((i+1))
done
printf "pick a game #: "
read -r n
if ! [ "$n" -ge 1 ] 2>/dev/null || [ "$n" -gt ${#roms[@]} ]; then echo "invalid pick"; exit 1; fi
run_rom "${roms[$((n-1))]}"
