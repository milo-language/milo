# Milo vs Goose, C++, Rust on the Goose suite (macOS)

Machine: Apple M4. Toolchains: Homebrew clang version 22.1.8; rustc 1.94.0 (4a4ef493e 2026-03-02); Milo `milo build --release` (-O3, overflow checks on, its default).

Wall time in ms: best of 3 whole-process runs after 2 warm-ups. Peak MB: max RSS from `/usr/bin/time -l` at the largest size. A row whose stdout differs from the first C++ row is marked (mismatch).

## records

| row | small (N=500,000) | medium (N=4,000,000) | large (N=16,000,000) | peak MB (large) |
|---|---:|---:|---:|---:|
| goose variable enum | 13.4 | 87.1 | 340.4 | 142.5 |
| goose fixed enum | 13.6 | 91.0 | 355.8 | 321.8 |
| cpp virtual + unique_ptr | 26.9 | 203.0 | 814.3 | 619.4 |
| cpp variant + string | 23.6 | 174.2 | 693.4 | 1,251.9 |
| cpp variant + buffer | 17.4 | 121.5 | 479.8 | 751.7 |
| rust enum + String | 18.8 | 128.7 | 505.8 | 553.2 |
| milo enum + string | 16.8 | 115.5 | 456.5 | 553.1 |

## interp

| row | small (depth=16) | medium (depth=20) | large (depth=24) | peak MB (large) |
|---|---:|---:|---:|---:|
| goose case functions + relative refs | 5.2 | 9.4 | 47.0 | 21.5 |
| cpp virtual + unique_ptr | 6.3 | 11.7 | 92.3 | 70.5 |
| cpp variant + arena | 5.6 | 10.4 | 62.3 | 85.0 |
| cpp tagged union + arena | 5.6 | 10.5 | 62.0 | 85.0 |
| rust enum + Box | 5.8 | 13.2 | 110.7 | 96.6 |
| rust enum + arena indices | 6.0 | 10.3 | 59.2 | 38.6 |
| milo enum + Vec pool, NodeId | 4.7 | 9.7 | 51.2 | 38.8 |

## graph

| row | small (V=100,000) | medium (V=500,000) | large (V=2,000,000) | peak MB (large) |
|---|---:|---:|---:|---:|
| goose one-pass, typed relative refs | 25.0 | 458.4 | 3,204.7 | 154.0 |
| goose CSR two-pass | 14.2 | 68.6 | 585.5 | 215.1 |
| cpp vector<vector> | 29.0 | 191.4 | 1,502.2 | 172.7 |
| cpp CSR two-pass | 14.3 | 67.6 | 500.7 | 215.2 |
| cpp arena + indices | 24.4 | 458.3 | 3,379.4 | 154.0 |
| rust Vec<Vec> | 22.3 | 167.5 | 1,142.7 | 172.9 |
| rust CSR two-pass | 14.9 | 70.5 | 580.4 | 215.3 |
| rust arena + indices | 26.8 | 534.6 | 3,745.5 | 154.2 |
| milo edge pool, Option<EdgeId> | 25.8 | 479.8 | 3,644.8 | 146.4 |
| milo Vec<Vec> | 17.0 | 138.6 | 980.7 | 171.8 |
| milo CSR two-pass | 14.1 | 70.1 | 593.7 | 215.1 |

## blur

| row | small (W=1,024) | medium (W=2,048) | large (W=8,192) | peak MB (large) |
|---|---:|---:|---:|---:|
| goose flat indexing | 8.3 | 15.2 | 219.4 | 129.4 |
| goose row slices | 9.0 | 15.4 | 217.5 | 129.4 |
| cpp flat indexing | 25.9 | 94.8 | 1,468.1 | 256.3 |
| cpp row pointers | 8.6 | 16.7 | 239.2 | 129.4 |
| rust flat indexing | 9.3 | 20.1 | 280.8 | 201.2 |
| rust row slices | 8.9 | 16.3 | 231.8 | 201.2 |
| milo flat indexing | 9.1 | 17.4 | 248.2 | 201.0 |

## respond

| row | small (N=100,000) | medium (N=400,000) | large (N=1,600,000) | peak MB (large) |
|---|---:|---:|---:|---:|
| goose inline DTO | 34.9 | 130.1 | 510.7 | 1.4 |
| goose streaming | 30.3 | 112.8 | 442.5 | 1.4 |
| cpp DTO + string | 71.6 | 274.9 | 1,102.2 | 1.6 |
| cpp streaming | 45.5 | 168.8 | 670.8 | 1.3 |
| rust DTO + String | 77.1 | 292.6 | 1,159.3 | 1.7 |
| rust streaming | 40.8 | 152.3 | 604.1 | 1.5 |
| milo DTO + string | 71.4 | 272.8 | 1,093.8 | 2.2 |
| milo DTO + pushDec (no toString) | 60.4 | 229.8 | 910.0 | 1.9 |
| milo streaming | 33.0 | 124.1 | 487.0 | 1.3 |

## Summary: Milo time (and memory) as a ratio, below 1.00 means Milo is faster (smaller)

Best Milo row against the best Goose row and the best Rust row at each size; memory is the smallest peak of each language's rows at the large size.

| bench | vs goose small | medium | large | mem vs goose | vs rust small | medium | large | mem vs rust |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| records | 1.26 | 1.33 | 1.34 | 3.88 | 0.90 | 0.90 | 0.90 | 1.00 |
| interp | 0.89 | 1.04 | 1.09 | 1.80 | 0.80 | 0.94 | 0.87 | 1.01 |
| graph | 0.99 | 1.02 | 1.01 | 0.95 | 0.95 | 0.99 | 1.02 | 0.95 |
| blur | 1.09 | 1.15 | 1.14 | 1.55 | 1.03 | 1.07 | 1.07 | 1.00 |
| respond | 1.09 | 1.10 | 1.10 | 0.94 | 0.81 | 0.81 | 0.81 | 0.88 |
