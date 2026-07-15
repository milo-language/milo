#!/bin/sh
# One-command build: hades binary + web UI bundle.
#   scripts/build.sh            # dev: binary at -O0 (~1s) + UI bundle
#   scripts/build.sh bin        # dev binary only
#   scripts/build.sh ui         # UI bundle only
#   scripts/build.sh release    # -O2 binary (couple minutes: milo emits one
#                               # big LLVM module and clang -O2 chews on it) + UI
#
# The binary lands at the repo root (./hades) on purpose: the e2e tests spawn
# "./hades", and the server's --webroot default (src/web/ui/dist) resolves
# against the cwd — running from the root makes both Just Work. It's
# gitignored, so the root stays clean in git terms.
set -e
cd "$(dirname "$0")/.."

# milo compiler checkout; override with MILO=/path/to/milo/src/main.ts
MILO="${MILO:-../milo/src/main.ts}"

# echo each command with wall-clock timing
run() {
    echo "+ $*"
    start=$(date +%s)
    "$@"
    echo "  (took $(($(date +%s) - start))s)"
}

what="${1:-all}"
case "$what" in
    all|bin)  run bun run "$MILO" build src/main.milo --debug -o hades ;;
    release)  run bun run "$MILO" build src/main.milo -o hades ;;
esac
case "$what" in
    all|release|ui)  run src/web/ui/build.sh ;;
esac
