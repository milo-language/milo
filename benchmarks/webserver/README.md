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

## Rust comparison

`rust/` is an axum 0.8 server (`bench-server-rust`) with the same three routes, so Milo's distance from an idiomatic fast Rust server is a number. `--server milo|rust1|rustmt|all` picks what runs (default `all`, one server at a time, each on its own port: `PORT`, `PORT+1`, `PORT+2`). The Rust build is `cargo build --release` (no-op when up to date).

- `rust1`: `RUST_THREADS=1`, tokio `current_thread` runtime. Single-threaded like Milo today, so this is the like-for-like row.
- `rustmt`: `RUST_THREADS=0`, tokio `multi_thread` with the default worker count (one per core). What a Rust author gets by default.
- `/db` uses one `rusqlite` connection per runtime thread (`thread_local!`, WAL, `prepare_cached`) rather than a shared `Mutex<Connection>`: a mutex would serialize the multi-thread runtime on the db and understate Rust. Queries and fib run inline in the handler (no `spawn_blocking`), as in Milo. Milo prints floats differently (bytes differ), both return 200 with 15 lines.

Keep-alive policy: `std/http` always answers `Connection: close`, so by default every server is driven with `oha --disable-keepalive` (a new TCP connection per request) to keep the comparison apples to apples. `--keepalive` lets oha reuse connections; Rust gains from that, Milo cannot yet. The mode is printed at the start of each run.

2026-10-21, git 94302311 (plus this change), `Darwin arm64`, 10 cpus, keep-alive off, 0 errors, 0 non-2xx for all servers:

```
scenario                       milo rps   rust1 rps  rustmt rps    milo p99   rust1 p99  rustmt p99
hello c=1                          8646       12377       12132        0.18        0.18        0.22
hello c=64                        14174       45693       41631        7.78        5.19        3.88
fib27 c=1                          1513        1971        1913        1.00        0.79        0.92
fib27 c=64                         2076        3180       17546       34.19       22.97        7.25
db c=1                              657         723         721        1.63        1.46        1.46
db c=64                             670         754        3636       97.99       90.12       32.68
hol-baseline hello c=4            11692       29681       30243        0.74        0.44        0.25
hol hello c=4 (+fib32 c=16)         293         536        3979       78.70       54.51        5.95

hol p99 [milo]   = 78.70 ms (107.0x baseline)
hol p99 [rust1]  = 54.51 ms (124.9x baseline)
hol p99 [rustmt] =  5.95 ms (24.1x baseline)
```

Reading it: single-threaded Rust is ~1.3x Milo on fib (the pure-CPU gap, no folding: `n` comes from the request), ~1.1x on db (SQLite dominates), and 3x on hello c=64 (per-request overhead). rust1 HOL is still 54 ms, so a single-threaded design cannot fix head-of-line blocking; only `rustmt` does.

With keep-alive (Rust only), `--keepalive --server rustmt`:

```
hello c=1                       30066     0.03     0.08     0.30       0       0
hello c=64                     201451     0.30     0.52     0.95       0       0
hol-baseline hello c=4          67956     0.06     0.10     0.30       0       0
hol hello c=4 (+fib32 c=16)      4217     0.06     6.34     8.08       0       0
(columns: rps, p50 ms, p99 ms, max ms, non2xx, errors)
```
