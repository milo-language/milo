#!/bin/sh
# Run the sibling Milo packages' OWN test suites against this checkout's compiler.
#
# Why this exists, separately from tests/: this repo's fixtures are written by whoever
# writes the compiler, so they cover the shapes that author thought of. A package's suite
# was written by someone solving a different problem, and it exercises std through APIs no
# fixture here calls. The milojs session made the same argument from the other side and
# built tools/check-apps.sh; this is the Milo-package half.
#
#   sh scripts/check-packages.sh          # every package present
#   sh scripts/check-packages.sh toml     # one by name
#
# Packages live outside this repo, so a missing checkout SKIPS rather than fails — the
# script is safe to run anywhere, including CI where none of them exist.
# MILO_PACKAGES_ROOT moves the set.
set -u

ROOT="${MILO_PACKAGES_ROOT:-$HOME/git/milo-language}"
MILO="$(cd "$(dirname "$0")/.." && pwd)/milo"
FILTER="${1:-}"

# Suites that need a live service, skipped by default: they fail with a connection error,
# which is not a compiler signal. Listed per SUITE, not per package — aws/sigv4_test.milo
# is pure signing maths and runs anywhere, while aws/s3_test.milo wants an S3 endpoint on
# 127.0.0.1, so skipping the whole package would silently drop 14 real tests.
#
# Explicit rather than "treat a connection error as a skip": that heuristic would also
# swallow a genuine failure in a suite that happens to touch the network, which is exactly
# the kind of silent pass this gate exists to avoid.
# MILO_PACKAGES_WITH_SERVICES=1 runs them anyway.
NEEDS_SERVICE="redis/protocol_test.milo redis/redis_test.milo postgres/postgres_test.milo postgres/tls_test.milo aws/s3_test.milo"

fail=0; ran=0; skipped=0
for dir in "$ROOT"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    [ -z "$FILTER" ] || [ "$FILTER" = "$name" ] || continue
    [ -d "$dir/tests" ] || continue

    # A suite whose imports go through the package manager needs its deps on disk
    # first. Without this the suite fails to RESOLVE, and the gate reported that as
    # a package failure — three red suites in milo-json-rpc that were really just an
    # un-run `milo pkg install`. A setup problem must not read as a test result, so the
    # install is reported on its own line and the suites still run either way.
    if [ -f "$dir/tests/milo.json" ]; then
        if ! (cd "$dir/tests" && "$MILO" pkg install >/dev/null 2>&1); then
            echo "WARN $name — 'milo pkg install' in tests/ failed; suites below may fail to resolve"
        fi
    fi

    for t in "$dir"tests/*_test.milo; do
        [ -f "$t" ] || continue
        base=$(basename "$t")
        case " $NEEDS_SERVICE " in
            *" $name/$base "*)
                if [ "${MILO_PACKAGES_WITH_SERVICES:-0}" != "1" ]; then
                    echo "SKIP $name/$base (needs a live service; MILO_PACKAGES_WITH_SERVICES=1 to run)"
                    skipped=$((skipped + 1))
                    continue
                fi
                ;;
        esac
        out=$(cd "$dir" && timeout 600 "$MILO" test "tests/$base" 2>&1)
        rc=$?
        line=$(printf '%s\n' "$out" | tail -1)
        # Exit status AND a non-zero pass count: a suite that fails to compile prints
        # "0 pass, 0 fail" and exits 1, which a match on " 0 fail" alone read as ok.
        if [ "$rc" -eq 0 ] && printf '%s' "$line" | grep -q " 0 fail" && ! printf '%s' "$line" | grep -q "^0 pass"; then
            echo "ok   $name/$base — $line"
        else
            echo "FAIL $name/$base — $line"
            printf '%s\n' "$out" | tail -12 | sed 's/^/       /'
            fail=$((fail + 1))
        fi
        ran=$((ran + 1))
    done
done

echo
echo "$ran suite(s) run, $fail failed, $skipped suite(s) skipped"
[ "$fail" -eq 0 ] || exit 1
