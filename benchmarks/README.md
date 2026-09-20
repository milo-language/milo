# Milo Benchmarks

Milo vs C vs Go on small workloads. Uses [hyperfine](https://github.com/sharkdp/hyperfine).

```bash
./benchmarks/run.sh
```

Env vars: `RUNS=5` `WARMUP=1` `CC=clang` `CFLAGS="-O2 -march=native"`.

## Results (Apple M-series, macOS, Milo at -O2)

<!-- gen:benchmarks -->
| Benchmark              | C       | Milo    | Go      | Milo vs C |
|------------------------|---------|---------|---------|-----------|
| matmul 512×512         | 12.8 ms | 12.0 ms | 13.2 ms | **0.94x** |
| binarytrees depth 18   | 3.9 ms  | 3.0 ms  | 10.5 ms | **0.77x** |
| quicksort 2M f64       | 35.7 ms | 34.7 ms | 34.7 ms | **0.97x** |
| startup empty main     | 1.2 ms  | 1.2 ms  | 1.5 ms  | **1.00x** |
| stringops 100k concat  | 3.1 ms  | 3.2 ms  | 6.5 ms  | 1.03x     |
| fib(42)                | 18.4 ms | 20.8 ms | 21.6 ms | 1.13x     |
| sieve to 10M           | 2.1 ms  | 2.5 ms  | 3.4 ms  | 1.19x     |
| maplookup 100k         | 3.3 ms  | 4.4 ms  | 5.0 ms  | 1.33x     |
| grep -c 5MB            | 2.1 ms  | 5.5 ms  | 4.0 ms  | 2.62x     |
| json parse+walk 1MB    | 1.6 ms* | 7.1 ms  | 9.7 ms  | 4.44x     |
<!-- /gen:benchmarks -->

\* C uses yyjson (best-in-class C library); Go and Milo use their stdlibs.

Hot spots: grep slurps whole file then scans; hashmap needs probe optimization. JSON gap vs C is stdlib-vs-yyjson; Milo now beats Go.

## Milo vs Rust / Zig / Odin / Hylo

```bash
./benchmarks/run-langs.sh        # needs rustc, zig, odin; HC=<path to hylo hc> for the hylo arm
```

Same source shape in every language (same algorithm, same stdlib-level containers —
`Vec`/`Vec`/`ArrayList`/`[dynamic]`), `rustc -O`, `zig -O ReleaseFast`, `odin -o:speed`,
`clang -O2 -march=native`. Apple M-series, macOS.

Numbers below are the best of 3 *independent* hyperfine batches of 20 runs each. Batch-to-batch
drift is 0.3–4% and moves every language together, so a single batch will happily report a
significant 2% win that the next batch reverses. Only gaps that hold across all three batches
with non-overlapping means are reported as real.

| Benchmark             | Milo    | Rust    | Zig     | Odin    | C       | Hylo    |
|-----------------------|---------|---------|---------|---------|---------|---------|
| fib(35)               | 17.3 ms | 16.4 ms | 18.7 ms | 21.5 ms | 16.7 ms | 96.2 ms |
| matmul 256×256 f64    | 11.1 ms | 11.3 ms | 11.7 ms | 11.9 ms | 11.8 ms | —       |
| quicksort 500k f64    | 33.6 ms | 32.6 ms | 33.3 ms | 32.8 ms | 32.4 ms | —       |
| binarytrees depth 15  | 2.5 ms  | 2.3 ms  | 1.7 ms  | 2.8 ms  | 2.1 ms  | —       |

Milo is 2% ahead of Rust on matmul, 3.5% behind C on sort, and 5% behind Rust and C on fib.
Those hold across batches but are small enough to be compiler-version noise, not a language
property.

The one real gap is binarytrees, at 1.42x Zig. Decomposing it by benchmarking C variants that
change one factor at a time:

| variant                             | time   | delta |
|-------------------------------------|--------|-------|
| Zig — 16-byte node, `smp_allocator` | 1.9 ms |       |
| C — 16-byte node, libc malloc       | 2.2 ms | +15% allocator |
| C — 24-byte node, libc malloc       | 2.6 ms | +18% node size |
| Milo — 24-byte node, libc malloc    | 2.7 ms | +4% codegen |

Milo is within 4% of size-matched C, so `Heap<T>` itself is fine. The gap is node size: the enum
tag makes `Tree` 24 bytes where Rust's is 16, because Rust encodes `Leaf` in the null-pointer
niche of a `Box` field. Niche optimization for enums whose payload contains a non-null pointer is
the fix, and it is a type-layout feature, not an allocator problem. The remaining 15% is libc
malloc, recoverable by linking mimalloc/snmalloc if it ever matters.

Hylo runs only fib: its stdlib has no `Movable` conformance for `Float64`, so `Array<Float64>`
does not instantiate, and there is no float `print`. The 5.7× on fib is a debug-build `hc`
(there is no release distribution) emitting unoptimized calls, not a claim about the language.

## shard: parallelism that does not copy

`sh benchmarks/shard/run.sh` is separate from `run.sh` above because it reports peak
memory as well as time, and hyperfine does not measure memory. Memory is the whole
claim there: the move-only route to parallelism used to force a copy per worker, and
`std/shard` exists so that it does not.

| | time | peak memory |
|---|---|---|
| milo sequential, in place | 6 ms | 153.9 MiB |
| milo parallelMap, 4 workers | 3 ms | 163.0 MiB |
| c pthreads over one shared buffer | 3 ms | 154.0 MiB |

20M `f64`, `a[i] = a[i] * 1.0000001 + 0.5`, best of 3, Apple M-series, `--release`.

`sh benchmarks/shard/scale.sh` measures the other claim, speedup, on a compute-bound
kernel where the memory bus is not the limit: 292 ms on 1 worker, 146 on 2 (2.00x),
82 on 4 (3.56x), 60 on 8 (4.87x), 58 on 10 (5.03x).
The loop is memory-bandwidth-bound, so the times sit in a 3-7 ms band run to run and
four workers buy well under 4x. The memory numbers are stable: the 9.1 MiB the
parallel row adds is worker stacks, a fixed cost that does not grow with n.

## freeze: infallible arena lookup

`sh benchmarks/freeze/run.sh` — 1M items, 10M lookups, identical checksums.

| | time |
|---|---|
| `arena.get` (generational, returns `Option<T>`) | 10 ms |
| `frozen.get` (infallible, returns `T`) | 7 ms |

1.43x. Worth stating plainly: an earlier design note predicted 2.2x, and that is not
what this measures. The nanoseconds are also the smaller half of the point — the
frozen path removes the `Option` from every call site, which is the reason it exists.

## seal: retaining views instead of copies

`sh benchmarks/seal/run.sh` — 600k retained literals, same scanner both sides, same
checksum, only what is KEPT differs.

| | time | peak memory |
|---|---|---|
| owned `string` per literal | 8 ms | 59.6 MiB |
| `Span` into a sealed buffer | 4 ms | 36.9 MiB |

38% less memory and roughly 2x faster. The owned side allocates once per retained
literal; the span side keeps two integers each and allocates only when its `Vec`
doubles.

## strscan: parallel search over one large file

`sh benchmarks/strscan/run.sh` — 51.3 MiB corpus, literal search, counting occurrences.
This is the case a grep cannot fall back on file-level parallelism for.

| | time |
|---|---|
| sequential (`indexOfFrom`) | 35 ms |
| read-only windows x1 (naive compare) | 52 ms |
| read-only windows x2 | 26 ms |
| read-only windows x4 | 14 ms |
| read-only windows x8 | 10 ms |

The per-core comparison is deliberately unfavourable to the parallel side: the
sequential program uses the optimised `indexOfFrom` while the windows use a naive
byte compare, which is why one window is slower than sequential. Eight windows still
finish in under a third of the sequential time.

The runner checks every windowing against the sequential count and fails on a
mismatch. That check is not decorative: dropping the `needle.len - 1` overlap makes
the 8-window run report 958590 against 958591, one match lost across a boundary.
