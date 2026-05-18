# Milo Benchmarks

Milo vs C vs Go on small workloads. Uses [hyperfine](https://github.com/sharkdp/hyperfine).

```bash
./benchmarks/run.sh
```

Env vars: `RUNS=5` `WARMUP=1` `CC=clang` `CFLAGS="-O2 -march=native"`.

## Results (Apple M-series, macOS, Milo at -O2)

| Benchmark              | C       | Milo    | Go      | Milo vs C |
|------------------------|---------|---------|---------|-----------|
| matmul 512×512         | 12.8 ms | 12.0 ms | 13.2 ms | **0.94x** |
| binarytrees depth 18   | 3.9 ms  | 3.0 ms  | 10.5 ms | **0.77x** |
| quicksort 2M f64       | 35.7 ms | 34.7 ms | 34.7 ms | **0.97x** |
| startup empty main     | 1.2 ms  | 1.2 ms  | 1.5 ms  | **1.00x** |
| stringops 100k concat  | 3.1 ms  | 3.2 ms  | 6.5 ms  | 1.03x     |
| fib(42)                | 18.4 ms | 20.8 ms | 21.6 ms | 1.13x     |
| sieve to 10M           | 2.1 ms  | 2.5 ms  | 3.4 ms  | 1.19x     |
| maplookup 100k         | 3.3 ms  | 4.4 ms  | 5.0 ms  | 1.32x     |
| grep -c 5MB            | 2.1 ms  | 5.5 ms  | 4.0 ms  | 2.56x     |

JSON benchmark omitted — stdlib parser uses naive re-scan (12.6s vs Go stdlib 12.5ms, yyjson 3.3ms). Parser rewrite tracked.

Hot spots: grep slurps whole file then scans; hashmap needs probe optimization.
