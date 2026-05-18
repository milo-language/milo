# Benchmarks

Milo compiles via LLVM with `-O2` — the same backend as C and Rust. On most workloads it lands within noise of C.

## Results

| Benchmark | C | Milo | Go | Milo vs C |
|-----------|---|------|----|-----------|
| matmul 512×512 | 12.8ms | 12.0ms | 13.2ms | **0.94x** |
| binarytrees depth 18 | 3.9ms | 3.0ms | 10.5ms | **0.77x** |
| quicksort 2M f64 | 35.7ms | 34.7ms | 34.7ms | **0.97x** |
| startup empty main | 1.2ms | 1.2ms | 1.5ms | **1.00x** |
| stringops 100k concat | 3.1ms | 3.2ms | 6.5ms | 1.03x |
| fib(42) | 18.4ms | 20.8ms | 21.6ms | 1.13x |
| sieve to 10M | 2.1ms | 2.5ms | 3.4ms | 1.19x |
| maplookup 100k | 3.3ms | 4.4ms | 5.0ms | 1.32x |
| grep -c 5MB | 2.1ms | 5.5ms | 4.0ms | 2.56x |

Apple M-series, macOS.

## Notes

- Values < 1.0x mean Milo is faster than C (usually within measurement noise)
- 4 benchmarks match or beat C; 3 more within 20%
- Slower entries (grep, maplookup) have known hot spots — not fundamental limits
- Go's GC overhead shows clearly in allocation-heavy benchmarks (binarytrees 3.5x slower)
- JSON benchmark omitted — stdlib parser uses naive re-scan and needs a rewrite

## Reproduce

```bash
./benchmarks/run.sh
```
