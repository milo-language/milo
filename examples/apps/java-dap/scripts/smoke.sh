#!/bin/bash
# M1 smoke: build java-dap, launch a suspended JVM with the JDWP agent, attach,
# and verify VM version + thread list come back. Skips (exit 0) if no JDK.
# Both child processes run under scripts/guard.ts per repo memory-guard rules.
set -euo pipefail

cd "$(dirname "$0")/../../../.."   # repo root
APP=examples/apps/java-dap
PORT="${JAVA_DAP_SMOKE_PORT:-15005}"
OUT="$(mktemp -d)/java-dap"

# Locate a real JDK: Apple ships PATH stubs that fail without one installed.
JDK=""
for cand in "${JAVA_HOME:-}/bin" /opt/homebrew/opt/openjdk/bin /usr/local/opt/openjdk/bin; do
    if [ -x "$cand/javac" ] && "$cand/javac" -version >/dev/null 2>&1; then
        JDK="$cand"
        break
    fi
done
if [ -z "$JDK" ] && javac -version >/dev/null 2>&1; then
    JDK="$(dirname "$(command -v javac)")"
fi
if [ -z "$JDK" ]; then
    echo "java-dap smoke: no JDK found, skipping"
    exit 0
fi

./milo build "$APP/src/main.milo" -o "$OUT"
"$JDK/javac" -d "$APP/tests/fixtures" "$APP/tests/fixtures/HelloLoop.java"

bun scripts/guard.ts --mem-mb 1024 --timeout-s 60 -- \
    "$JDK/java" "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=$PORT" \
    -cp "$APP/tests/fixtures" HelloLoop &
JVM_PID=$!
trap 'kill $JVM_PID 2>/dev/null || true; wait $JVM_PID 2>/dev/null || true' EXIT

# Wait for the agent to listen (suspend=y: JVM parks before main). lsof, not a
# TCP probe: a connect+close makes the agent log a spurious handshake failure.
for _ in $(seq 1 50); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 0.1
done

RESULT=$(bun scripts/guard.ts --mem-mb 512 --timeout-s 30 -- \
    "$OUT" --attach "localhost:$PORT" --smoke)
echo "$RESULT"

echo "$RESULT" | grep -q "smoke ok" || { echo "java-dap smoke: FAILED"; exit 1; }
echo "$RESULT" | grep -q "\bmain\b" || { echo "java-dap smoke: no main thread listed"; exit 1; }
echo "java-dap smoke: PASS"
