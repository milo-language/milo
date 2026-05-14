# Milo Benchmarks

Compare Milo against C and Go on simple workloads. Uses [hyperfine](https://github.com/sharkdp/hyperfine) for wall-clock timing.

## Run

```bash
./benchmarks/run.sh
```

Env vars: `RUNS=10` `WARMUP=2` `CC=clang` `CFLAGS="-O2 -march=native"`.

## Results (Apple M-series, macOS)

### fib(42) — naive recursive

| Language | Time     | vs C  |
|----------|----------|-------|
| C (-O2)  | 451 ms   | 1.00x |
| **Milo** | 520 ms   | 1.15x |
| Go       | 580 ms   | 1.29x |

### grep -c 'fox' on 5MB file (100k lines, all match)

| Language | Time   | vs C  |
|----------|--------|-------|
| C        | 4.5 ms | 1.00x |
| Go       | 4.6 ms | 1.02x |
| sys grep | 10 ms  | 2.30x |
| **Milo** | 13 ms  | 2.86x |

Milo grep gap is mostly whole-file read + per-line `substr` allocation. C/Go just memchr through the buffer.
