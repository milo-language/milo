#!/usr/bin/env bash
# Differential test: our Milo port of ripgrep (examples/cli-tools/rg.milo) vs real `rg`.
# Usage: rgdiff.sh [path-to-milo-rg-binary] [corpus-dir]
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/rgdiff.XXXXXX")

MILO_RG="${1:-}"
CORPUS="${2:-$HOME/git/llvm-project/clang/lib}"

if [[ -z "$MILO_RG" ]]; then
    MILO_RG="$SCRATCH/miloRg"
    echo "Building milo rg -> $MILO_RG"
    (cd "$ROOT" && ./milo build examples/cli-tools/rg.milo -o "$MILO_RG" --release)
    build_status=$?
    if [[ $build_status -ne 0 ]]; then
        echo "FATAL: build of milo rg failed (exit $build_status)"
        exit 1
    fi
fi

if [[ ! -d "$CORPUS" ]]; then
    echo "FATAL: corpus dir not found: $CORPUS"
    exit 1
fi

# macOS has no timeout(1) by default; use gtimeout (coreutils) if present, else run unwrapped.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout 30"
fi

# Resolve paths that may not exist in every corpus checkout, with a fallback.
SMALL_SUBDIR="$CORPUS/Basic/Targets"
if [[ ! -d "$SMALL_SUBDIR" ]]; then
    SMALL_SUBDIR=$(find "$CORPUS" -mindepth 1 -maxdepth 2 -type d | head -1)
    echo "note: Basic/Targets not found, using fallback small subdir: $SMALL_SUBDIR"
fi

SINGLE_FILE="$CORPUS/Basic/Targets.cpp"
if [[ ! -f "$SINGLE_FILE" ]]; then
    SINGLE_FILE=$(find "$CORPUS" -name '*.cpp' | head -1)
    echo "note: Basic/Targets.cpp not found, using fallback file: $SINGLE_FILE"
fi

pass_count=0
total_count=0
declare -a fail_names

# run_case <name> <arg...>
# Runs both binaries with the same args, stdout redirected to files (not a tty -- this
# makes both tools default to no-color/no-heading/no-line-numbers so their line formats
# match: "path:text" per line). Compares exit codes and sorted output.
run_case() {
    local name="$1"; shift
    total_count=$((total_count + 1))

    local milo_out="$SCRATCH/${name}.milo.out"
    local real_out="$SCRATCH/${name}.real.out"

    set +e
    $TIMEOUT_BIN "$MILO_RG" "$@" >"$milo_out" 2>/dev/null
    local milo_status=$?
    $TIMEOUT_BIN rg "$@" >"$real_out" 2>/dev/null
    local real_status=$?
    set -u

    local milo_sorted="$SCRATCH/${name}.milo.sorted"
    local real_sorted="$SCRATCH/${name}.real.sorted"
    LC_ALL=C sort "$milo_out" >"$milo_sorted"
    LC_ALL=C sort "$real_out" >"$real_sorted"

    if [[ "$milo_status" == "$real_status" ]] && diff -q "$milo_sorted" "$real_sorted" >/dev/null 2>&1; then
        echo "PASS $name"
        pass_count=$((pass_count + 1))
    else
        echo "FAIL $name"
        fail_names+=("$name")
        echo "    exit codes: milo=$milo_status real=$real_status"
        if ! diff -q "$milo_sorted" "$real_sorted" >/dev/null 2>&1; then
            echo "    diff (sorted, first 5 lines):"
            diff "$milo_sorted" "$real_sorted" 2>&1 | head -5 | sed 's/^/    /'
        fi
    fi
}

run_case "literal"            clang "$CORPUS"
run_case "literal-common"     return "$CORPUS"
run_case "literal-rare"       TargetInfo "$CORPUS"
run_case "nomatch"            zqzqzqzqzq "$CORPUS"
run_case "icase"              -i CLANG "$CORPUS"
run_case "count"               -c clang "$CORPUS"
run_case "files"                -l clang "$CORPUS"
run_case "word"                -w clang "$CORPUS"
run_case "invert-small"       -v clang "$SMALL_SUBDIR"
run_case "maxcount"           -m 3 clang "$CORPUS"
run_case "after"                -A 2 TargetInfo "$CORPUS"
run_case "before"               -B 2 TargetInfo "$CORPUS"
run_case "context"              -C 2 TargetInfo "$CORPUS"
run_case "regex-charclass"    '[A-Za-z_]+_ready' "$CORPUS"
run_case "regex-anchored"     '^static void' "$CORPUS"
run_case "regex-alt"          'getTarget|setTarget' "$CORPUS"
run_case "regex-plus"         'Diag[a-z]+' "$CORPUS"
run_case "regex-icase-count"  -i -c targetinfo "$CORPUS"
run_case "regex-word"         -w '[A-Z][a-z]+Info' "$CORPUS"
run_case "single-file"        include "$SINGLE_FILE"
run_case "badpath"            clang /nonexistent/path/xyz

echo ""
echo "$pass_count/$total_count cases passed"
if [[ $pass_count -ne $total_count ]]; then
    echo "failed cases: ${fail_names[*]}"
    exit 1
fi
exit 0
