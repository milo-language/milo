# Milo Benchmarks

Milo vs C vs Go on small workloads. Uses [hyperfine](https://github.com/sharkdp/hyperfine).

```bash
./benchmarks/run.sh
```

Env vars: `RUNS=5` `WARMUP=1` `CC=clang` `CFLAGS="-O2 -march=native"`.

## Results (Apple M-series, macOS, Milo at -O2)

| Benchmark              | C       | Milo    | Go      | Milo vs C |
|------------------------|---------|---------|---------|-----------|
| matmul 256x256         | 12.4 ms | 11.8 ms | 13.3 ms | **0.95x** |
| binarytrees depth 15   | 2.5 ms  | 1.9 ms  | 9.7 ms  | **0.76x** |
| startup empty main     | 1.4 ms  | 1.1 ms  | 1.8 ms  | **0.77x** |
| sieve to 1M            | 2.1 ms  | 2.2 ms  | 3.6 ms  | 1.04x     |
| quicksort 500k f64     | 33.5 ms | 34.5 ms | 35.4 ms | 1.03x     |
| fib(35)                | 17.7 ms | 20.8 ms | 22.5 ms | 1.17x     |
| maplookup 50k          | 2.1 ms  | 2.7 ms  | 2.6 ms  | 1.28x     |
| grep -c 1MB            | 2.1 ms  | 4.7 ms  | 3.0 ms  | 2.18x     |
| stringops 100k concat  | 4.9 ms  | 4.8 ms  | 11.7 ms | **0.97x** |

Hot spots: grep slurps whole file; json (omitted) parser re-scans on every access.
