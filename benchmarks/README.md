# Milo Benchmarks

Milo vs C vs Go on small workloads. Uses [hyperfine](https://github.com/sharkdp/hyperfine).

## Run

```bash
./benchmarks/run.sh
```

Env vars: `RUNS=5` `WARMUP=1` `CC=clang` `CFLAGS="-O2 -march=native"`.

## Results (Apple M-series, macOS, Milo at -O2)

| Benchmark              | C       | Milo    | Go      | Milo vs C |
|------------------------|---------|---------|---------|-----------|
| **matmul** 256x256     | 12.4 ms | 11.8 ms | 13.3 ms | **0.95x** (Milo wins) |
| **binarytrees** d=15   | 2.5 ms  | 1.9 ms  | 9.7 ms  | **0.76x** (Milo wins) |
| **sieve** to 1M        | 2.1 ms  | 2.2 ms  | 3.6 ms  | 1.04x (tied)      |
| **sort** 500k f64      | 33.5 ms | 34.5 ms | 35.4 ms | 1.03x (tied)      |
| **startup** empty main | 1.4 ms  | 1.1 ms  | 1.8 ms  | **0.77x** (Milo wins) |
| **fib(35)**            | 17.7 ms | 20.8 ms | 22.5 ms | 1.17x             |
| **maplookup** 50k      | 2.1 ms  | 2.7 ms  | 2.6 ms  | 1.28x             |
| **grep -c** 1MB        | 2.1 ms  | 4.7 ms  | 3.0 ms  | 2.18x             |
| **stringops** 3k concat| 1.2 ms  | 16.1 ms | 1.7 ms  | 13.5x             |

### Where Milo wins or ties

matmul, binarytrees, sieve, sort, startup, fib. LLVM does the heavy lifting; our IR doesn't get in its way. Milo's Box-allocated binary trees actually beat C in this size class — Box is a thin malloc wrapper and the allocations group well.

### Where Milo loses

- **stringops 13x**: `buf = buf + chunk` allocates a fresh String each iteration → O(n²). Fix: assign-back optimization, or a `push_str` builtin that reuses the LHS buffer.
- **grep 2x**: we slurp the whole file into a heap String then `substr` per line. C/Go scan the buffer in place.
- **json**: omitted from the table — our std/json is a view-based re-scanning parser, so each `.get()` is O(n). On 10k items that's O(n²). yyjson and Go encoding/json finish in ~1 ms; we don't. Plan to address with an index-cached parse.

### Source
- `fib/` — naive recursive fib
- `matmul/` — dense f64 matmul, row-major
- `binarytrees/` — recursive build + walk
- `sieve/` — Eratosthenes
- `sort/` — quicksort 500k f64
- `maplookup/` — 50k int→int insert+lookup (`HashMap<i64,i64>`)
- `startup/` — empty main
- `grep/` — `grep -c <pat> <file>`
- `stringops/` — `buf += chunk` × N
- `json/` — parse + walk 1MB JSON (uses [yyjson](https://github.com/ibireme/yyjson) for C)
