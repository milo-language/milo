# Benchmarks

Milo compiles via LLVM with `-O2` — the same backend as C and Rust. On most workloads it lands within noise of C.

## Results

| Benchmark | C | Milo | Go | Milo vs C |
|-----------|---|------|----|-----------|
| matmul 256x256 | 12.4ms | 11.8ms | 13.3ms | **0.95x** |
| binarytrees depth 15 | 2.5ms | 1.9ms | 9.7ms | **0.76x** |
| startup empty main | 1.4ms | 1.1ms | 1.8ms | **0.77x** |
| stringops 100k concat | 4.9ms | 4.8ms | 11.7ms | **0.97x** |
| sieve to 1M | 2.1ms | 2.2ms | 3.6ms | 1.04x |
| quicksort 500k f64 | 33.5ms | 34.5ms | 35.4ms | 1.03x |
| fib(35) | 17.7ms | 20.8ms | 22.5ms | 1.17x |
| maplookup 50k | 2.1ms | 2.7ms | 2.6ms | 1.28x |
| grep -c 1MB | 2.1ms | 4.7ms | 3.0ms | 2.18x |

Apple M-series, macOS.

## Notes

- Values < 1.0x mean Milo is faster than C (usually within measurement noise)
- Slower entries (grep, maplookup) have known hot spots — not fundamental limits
- Go's GC overhead shows clearly in allocation-heavy benchmarks (binarytrees)

## Reproduce

```bash
./benchmarks/run.sh
```
