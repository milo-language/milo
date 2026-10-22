# webserver benchmark

Throughput and head-of-line (HOL) latency for `std/http`. One command:

```
bun benchmarks/webserver/bench.ts [--scale 1] [--json out.json] [--keepalive] [--server milo|rust1|rustmt|all] [--stress]
```

It builds `server.milo` with `--release`, starts it (`PORT` default 8090, `DB_PATH` temp file), and drives it with [`oha`](https://github.com/hatoo/oha) (`brew install oha`). The server is killed on exit and ctrl-c.

## Scenarios

| name | measures |
|---|---|
| `hello c=1`, `c=64` | fixed per-request overhead (accept, parse, route, respond); c=64 adds scheduler/fd-wakeup cost |
| `fib27 c=1`, `c=64` | pure CPU handler (~0.5 ms); does throughput scale with concurrency |
| `fibb27 c=64` | the same work on the blocking pool (`/fibb/:n`: `Promise.blocking` in Milo, `spawn_blocking` in Rust); scales with cores even on a single-threaded scheduler |
| `db c=1`, `c=64` | one SQLite aggregate over 50k rows per request (~1.5 ms) |
| `hol-baseline` | `/hello` c=4 alone |
| `hol` | same `/hello` c=4 while a background `/fib/32` c=16 (~6 ms per request) runs. **Key number**: `hol p99 = X ms (Yx baseline)`, how long a cheap request waits behind CPU work |
| `hol-blocking` | `hol` with the background on `/fibb/32`: the CPU work runs on the blocking pool, so the cheap route should not wait behind it |
| `--stress` | instead of the rows above: `/fibb/45` (seconds per request) at c=10, n=20, per server; rps and p99 |

HOL uses fib(32) rather than fib(27): at 0.5 ms a fib(27) is too short to show queueing behind one task (fib27 as background gave 0.7x, i.e. noise).

## macOS port caveat

By default oha runs with `--disable-keepalive`, so every request is a fresh TCP connection. macOS has about 16k ephemeral ports, each held about 30 s in TIME_WAIT, so long or back-to-back runs exhaust them and the numbers become garbage. Hence fixed request counts (`-n`, scaled by `--scale`) and a wait before each scenario until fewer than 3000 sockets are in TIME_WAIT (prints `draining ports...` once). Do not raise `--scale` much without expecting long drains. `--keepalive` runs reuse connections and do not have this problem.

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

### Keep-alive

std/http serves persistent connections (`ServeOptions.keepAlive`, on by default). 2026-10-21, git 036c7e23 (plus the keep-alive change), Apple M4, `Darwin arm64`, 10 cpus, release build, 0 errors, 0 non-2xx. `bun benchmarks/webserver/bench.ts --server milo` (off) and `... --keepalive` (on):

```
scenario                       off rps   on rps    off p99   on p99
hello c=1                        11910    25175       0.18     0.08
hello c=64                       45415   118519       4.63     0.85
fib27 c=1                         1587     2192       0.90     0.56
fib27 c=64                        2189     2178      31.95    44.42
db c=1                             658      662       1.63     1.64
db c=64                            683      681      95.50   138.76
hol-baseline hello c=4           30770    67229       0.37     0.09
hol hello c=4 (+fib32 c=16)        288      277      80.98   149.04
```

Per-request overhead drops by more than half (hello c=64 2.6x). Under CPU-bound load the tail gets worse: p99 rises on fib27 c=64, db c=64 and hol (about 2x the p50 where it was about 1.1x). Without keep-alive every request queues through the one accept loop; with it each connection's next request is woken from its own fd, and the order the scheduler wakes ready fds in decides who waits. Single-threaded Rust shows the same direction on db c=64 (90 to 112 ms) but not as far on hol (54 to 58 ms), so part of this is the scheduler's wake order, not inherent.

## Rust comparison

`rust/` is an axum 0.8 server (`bench-server-rust`) with the same three routes, so Milo's distance from an idiomatic fast Rust server is a number. `--server milo|rust1|rustmt|all` picks what runs (default `all`, one server at a time, each on its own port: `PORT`, `PORT+1`, `PORT+2`). The Rust build is `cargo build --release` (no-op when up to date).

- `rust1`: `RUST_THREADS=1`, tokio `current_thread` runtime. Single-threaded like Milo today, so this is the like-for-like row.
- `rustmt`: `RUST_THREADS=0`, tokio `multi_thread` with the default worker count (one per core). What a Rust author gets by default.
- `/db` uses one `rusqlite` connection per runtime thread (`thread_local!`, WAL, `prepare_cached`) rather than a shared `Mutex<Connection>`: a mutex would serialize the multi-thread runtime on the db and understate Rust. Queries and `/fib` run inline in the handler, as in Milo; `/fibb` is the one route that uses `spawn_blocking`, matching Milo's `Promise.blocking`. Milo prints floats differently (bytes differ), both return 200 with 15 lines.

Keep-alive policy: by default every server is driven with `oha --disable-keepalive` (a new TCP connection per request). `--keepalive` lets oha reuse connections, which all three servers support. The mode is printed at the start of each run.

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

With keep-alive, `--keepalive --server all`, 2026-10-21, git 036c7e23 (plus the keep-alive change), Apple M4, 10 cpus, 0 errors, 0 non-2xx:

```
scenario                       milo rps   rust1 rps  rustmt rps    milo p99   rust1 p99  rustmt p99
hello c=1                         25187       30020       29950        0.08        0.08        0.08
hello c=64                       121276      208760      197554        0.81        0.38        0.58
fib27 c=1                          2098        2935        2901        0.57        0.39        0.40
fib27 c=64                         2152        3056       19997       45.01       22.07        5.78
db c=1                              649         732         738        1.65        1.46        1.44
db c=64                             678         743        3666      138.80      112.21       33.25
hol-baseline hello c=4            67964       65962       69924        0.10        0.09        0.10
hol hello c=4 (+fib32 c=16)         277         403        4084      152.10       57.51        6.38

hol p99 [milo]   = 152.10 ms (1574.1x baseline)
hol p99 [rust1]  =  57.51 ms (666.5x baseline)
hol p99 [rustmt] =   6.38 ms (66.4x baseline)
```

With connection setup out of the way, rust1 is 1.7x Milo on hello c=64, and rustmt is no faster than rust1 there.

## Blocking pool

`Promise.blocking` runs on a reusable elastic pool of OS threads (std/runtime `blockingPoolSubmit`) instead of a new pthread per call. `--keepalive --server all`, 2026-10-21, git d3ab9f82 plus the pool change, Apple M4, `Darwin arm64`, 10 cpus, 0 errors, 0 non-2xx:

```
scenario                                 milo rps   rust1 rps  rustmt rps    milo p99   rust1 p99  rustmt p99
hello c=1                                   25204       30633       30008        0.08        0.08        0.08
hello c=64                                 124002      201341      203885        0.81        0.38        0.56
fib27 c=1                                    1990        2824        2846        0.59        0.39        0.40
fib27 c=64                                   2076        3012       19342       46.86       22.23        6.22
fibb27 c=64                                 14339       19875       19612        7.71        5.67        7.06
db c=1                                        642         698         717        1.66        1.53        1.45
db c=64                                       681         740        3694      138.20       89.00       32.02
hol-baseline hello c=4                      64080       67831       66556        0.09        0.09        0.09
hol hello c=4 (+fib32 c=16)                   271         390        4203      156.70       59.86        5.99
hol-blocking hello c=4 (+fibb32 c=16)       56312       73594       13005        0.11        0.07        4.07
```

The same Milo rows on d3ab9f82 without the pool (a thread per `Promise.blocking`): `fibb27 c=64` 14026 rps, p99 7.77 ms (CPU-bound either way); `hol-blocking` 2747 rps, p99 6.69 ms. With the pool the cheap route's p99 behind a fib(32) load drops from 157 ms inline (6.7 ms thread per call) to 0.11 ms, level with rust1. `fibb27 c=64` is 7x `fib27 c=64`; its distance from Rust's is the fib itself (`fib27 c=1`: Rust 1.4x).

`--stress --keepalive --server all`, same machine and commit:

```
scenario                   milo rps   rust1 rps  rustmt rps    milo p99   rust1 p99  rustmt p99
stress fibb45 c=10 n=20        2.69        3.57        3.51     3748.37     2827.31     2892.16
```

All ten requests of a round run at once on every server; the 1.3x gap is fib(45)'s own cost.

`benchmarks/runtime/blocking_pool.milo` isolates the hand-off: 200000 trivial jobs submitted from a green task in batches of 64, awaited with `promiseAll`. Same machine, release build, best of three: d3ab9f82 253k jobs/s, with the pool 1.44M jobs/s (5.7x). At batch 1 (one job in flight) 83k vs 122k.
