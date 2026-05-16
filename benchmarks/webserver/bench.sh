#!/bin/bash
set -e

PORT=8080
N=5000
C=1
BINARY=./webserver

if [ ! -f "$BINARY" ]; then
    echo "building webserver..."
    bun run src/main.ts build examples/webserver.milo -o webserver
fi

echo "starting server on :$PORT..."
$BINARY 2>/dev/null &
SERVER_PID=$!
sleep 0.3

# verify server is up
if ! curl -s http://localhost:$PORT/hello > /dev/null 2>&1; then
    echo "server failed to start"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

echo "=== milo webserver benchmark ==="
echo "requests: $N  concurrency: $C"
echo ""

run_bench() {
    local label="$1"
    local path="$2"
    echo "── $label ($path) ──"
    ab -n $N -c $C -q "http://localhost:$PORT$path" 2>/dev/null | grep -E "Requests per second|Time per request|Transfer rate|Failed requests|Complete requests"
    echo ""
}

run_bench "plain text"     "/hello"
run_bench "json"           "/json"
run_bench "fib(10)"        "/fib/10"
run_bench "fib(30)"        "/fib/30"
run_bench "prime(97)"      "/prime/97"
run_bench "prime(999983)"  "/prime/999983"
run_bench "collatz(27)"    "/collatz/27"
run_bench "fizzbuzz(100)"  "/fizzbuzz/100"
run_bench "html (index)"   "/"

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
echo "done."
