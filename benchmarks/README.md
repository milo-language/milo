# Milo Benchmarks

Compare Milo against C and Go on simple workloads. Uses [hyperfine](https://github.com/sharkdp/hyperfine) for wall-clock timing.

## Run

```bash
./benchmarks/run.sh
```

Env vars: `RUNS=10` `WARMUP=2` `CC=clang` `CFLAGS="-O2 -march=native"`.

## Results (Apple M-series, macOS, -O2)

| Benchmark        | C      | Milo   | Go     | Milo vs C |
|------------------|--------|--------|--------|-----------|
| fib(42)          | 464 ms | 539 ms | 604 ms | 1.16x     |
| sieve to 10M     | 11 ms  | 16 ms  | 19 ms  | 1.48x     |
| quicksort 2M f64 | 140 ms | 146 ms | 144 ms | 1.04x     |
| grep -c 5MB      | 7 ms   | 14 ms  | 5 ms   | 1.91x     |

Milo beats Go on 3/4. Within 16% of C on fib, basically tied with C on quicksort. Sieve is 1.48x C — gap is the bounds checks on every `flags[i]` access; could shrink if we add `unsafe` indexing or LICM-friendly bounds elision.

The grep gap is mostly the I/O model — Milo slurps the file into a heap String + allocates a `substr` per line. C/Go scan the buffer in place with `strstr`/`bytes.Contains`. Closing this needs streaming reads or a zero-copy line view.

### Source
- `fib/` — recursive fib(42)
- `grep/` — `grep -c <pattern> <file>`
- `sieve/` — sieve of Eratosthenes up to 10M
- `sort/` — quicksort 2M f64
