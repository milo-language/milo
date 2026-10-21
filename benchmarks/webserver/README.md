# webserver benchmark

Throughput and head-of-line (HOL) latency for `std/http`. One command:

```
bun benchmarks/webserver/bench.ts [--scale 1] [--json out.json]
```

It builds `server.milo` with `--release`, starts it (`PORT` default 8090, `DB_PATH` temp file), and drives it with [`oha`](https://github.com/hatoo/oha) (`brew install oha`). The server is killed on exit and ctrl-c.

## Scenarios

| name | measures |
|---|---|
| `hello c=1`, `c=64` | fixed per-request overhead (accept, parse, route, respond); c=64 adds scheduler/fd-wakeup cost |
| `fib27 c=1`, `c=64` | pure CPU handler (~0.5 ms); does throughput scale with concurrency |
| `db c=1`, `c=64` | one SQLite aggregate over 50k rows per request (~1.5 ms) |
| `hol-baseline` | `/hello` c=4 alone |
| `hol` | same `/hello` c=4 while a background `/fib/32` c=16 (~6 ms per request) runs. **Key number**: `hol p99 = X ms (Yx baseline)`, how long a cheap request waits behind CPU work |

HOL uses fib(32) rather than fib(27): at 0.5 ms a fib(27) is too short to show queueing behind one task (fib27 as background gave 0.7x, i.e. noise).

## macOS port caveat

The server answers `Connection: close`, so every request is a fresh TCP connection. macOS has about 16k ephemeral ports, each held about 30 s in TIME_WAIT, so long or back-to-back runs exhaust them and the numbers become garbage. Hence fixed request counts (`-n`, scaled by `--scale`) and a wait before each scenario until fewer than 3000 sockets are in TIME_WAIT (prints `draining ports...` once). Do not raise `--scale` much without expecting long drains.

## Baseline

2026-10-21, git 5eb67905 (before the std/http perf work), Apple Silicon macOS, `uname -sm` = Darwin arm64, 10 cpus, release build, 0 errors, 0 non-2xx:

```
scenario                          rps    p50 ms    p99 ms    max ms  non2xx  errors
hello c=1                        8331     0.12     0.20     0.88       0       0
hello c=64                      13679     5.12     7.80    10.84       0       0
fib27 c=1                        1536     0.61     1.20     1.50       0       0
fib27 c=64                       2003    31.88    34.69    36.50       0       0
db c=1                            654     1.51     1.65     5.96       0       0
db c=64                           673    94.98    97.42    99.58       0       0
hol-baseline hello c=4          13077     0.26     0.64     0.76       0       0
hol hello c=4 (+fib32 c=16)       288     0.28    80.29    81.93       0       0

hol p99 = 80.29 ms (125.7x baseline)
```
