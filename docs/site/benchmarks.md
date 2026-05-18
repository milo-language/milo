# Benchmarks

Milo compiles via LLVM with `-O2` — the same backend as C and Rust. On most workloads it lands within noise of C.

## Results

<BenchmarkChart />

<div class="bench-footnote">

Apple M-series, macOS. *C uses yyjson; Go and Milo use their stdlibs.

</div>

## Notes

- Values < 1.0x mean Milo is faster than C (usually within measurement noise)
- 4 benchmarks match or beat C; 3 more within 20%
- Slower entries (grep, maplookup) have known hot spots — not fundamental limits
- Go's GC overhead shows clearly in allocation-heavy benchmarks (binarytrees 3.5x slower)
- JSON: flat pool parser with source-offset strings — ~6 allocations for any document size. Beats Go; remaining gap vs C is stdlib-vs-yyjson

## Reproduce

```bash
./benchmarks/run.sh
```
