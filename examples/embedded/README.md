# Milo for safety-critical embedded — proven, reproducible

Milo's pitch is memory safety *without* a GC or runtime — which is exactly what
hard-real-time, safety-critical embedded needs. This directory proves the whole
chain on a real control kernel, on a bare-metal ARM target, in an emulator you
can run right now.

## Run it

```bash
examples/embedded/prove.sh
```

One command. Six stages. Each prints `✓ PASS` or aborts. Needs `bun`, `clang`+`lld`
(the Milo toolchain), `qemu-system-arm` (`brew install qemu`), and `llvm-objdump`.
No OTAWA, no Docker, no real hardware.

## What it proves

The kernel is [`pidStep.milo`](pidStep.milo) — an integer Q16.16 fixed-point PID
controller, the exact computation a brake module / motor ESC / flight controller
runs every timer tick. Integer-only (no FP), no recursion, no dynamic allocation,
every loop statically bounded.

| # | Stage | Command | Claim checked |
|---|-------|---------|---------------|
| 1 | **Safety profile** | `milo safety … --safety=iso26262-d` | Passes **ISO 26262 ASIL-D** — automotive's highest level (braking, steering, autonomy): no recursion, bounded loops, no dynamic alloc, contracts required, full match coverage, no FFI, complexity ≤20. |
| 2 | **WCET flow facts** | `milo wcet …` | Loop bound emitted as `COUNT 200` (exact) — the input format a WCET analyzer (OTAWA / AbsInt aiT) consumes. |
| 3 | **Cycle bound** | `milo wcet … --cycles` | Conservative Cortex-M3 timing model → **10000 cycles = 0.417 ms @ 24 MHz**. |
| 4 | **Bare-metal build** | `milo build … --target=cortex-m3` | Static ARM ELF: thumb codegen, vector table, linker script, `-nostdlib`, `lld`. No OS, no libc. |
| 5 | **Run on emulator** | `milo run … --target=cortex-m3` | Executes on QEMU (`mps2-an385`, semihosting) and returns the correct actuator command (`exit=34`). |
| 6 | **Independent WCET check** | `llvm-objdump -d` | The model's **140 instructions/pass** claim is verified *exactly* against the real compiled machine code — not just asserted by the model. |

Stage 6 is the point. A WCET bound is only as trustworthy as its instruction
count; the script disassembles the actual ELF, isolates the loop body between its
top and its backward branch, counts the real thumb instructions, and confirms it
matches the model. The backedge `subs r0, #0x4` also confirms the ×4 unroll the
timing model assumed.

## The full chain, one line

```
memory-safe source → ASIL-D checked → contract checked → bounded loops
  → thumb ELF → runs on Cortex-M3 emulator → WCET count verified vs real code
```

## Boundaries (deliberate)

- **Emulator is functional, not cycle-accurate.** Stage 5 proves *correctness*.
  The WCET number is a static conservative bound (stage 3), independently
  sanity-checked at the instruction-count level (stage 6) — the right method for
  worst-case timing, since measurement can never prove a *worst* case.
- **Not run: OTAWA / aiT.** A certifiable third-party bound needs AbsInt **aiT**
  (the tool automotive/avionics actually license) or OTAWA (open, academic,
  Linux-only). Neither is required for the thesis; the flow-fact output (stage 2)
  is already in their input format.
- **No OS-backed stdlib.** `std/io`, `std/net`, … need syscalls, so a full app
  importing them won't link bare-metal. Pure-compute code — including anything
  that only needs the heap (`Vec`, `String`, `HashMap`) — links and runs fine
  (see *Memory* below). WCET kernels are the proven path and, under `--safety`,
  allocate nothing at all.

## Memory on bare metal

There is no OS to hand out RAM, so the linker script (`embedded/cortex-m/mps2.ld`)
declares the whole map and `startup.c` acts as the C runtime. Four regions, no GC:

- **Registers / stack** — locals and call frames. The stack starts at the top of
  RAM and grows down; a reserved gap (`_stack_size`, default 16 KB) keeps it clear
  of the heap.
- **Static** (`.data`/`.bss`) — globals and `static` arrays, fixed at link time.
- **Heap** — everything between the end of `.bss` and the stack gap
  (`[_sheap, _eheap)`). A bump allocator in `startup.c` serves `malloc`/`free`, so
  `Vec`/`String`/`HashMap` work unchanged. The size is **not** baked into C — it
  adapts to whatever RAM the board's `MEMORY` block declares.

```bash
milo run  pidStep.milo --target=cortex-m3                 # heap = all free RAM
milo build app.milo    --target=cortex-m3 --heap-size=64k # cap the heap (bytes, or k/m)
```

Two deliberate limits: `free` is a no-op (bump only — alloc at init, don't churn),
and exhaustion is unrecoverable — but **observable**: an out-of-memory allocation
prints `milo: out of memory` and exits `12` (ENOMEM) instead of faulting silently.
For WCET/ASIL builds none of this matters — `--safety` bans dynamic allocation, so
the heap is never touched.

## Available upgrades

- **Cortex-R target** (e.g. TI TC3xx / Arm R5F) — the lockstep safety cores in
  real ASIL-D SoCs. Needs a new triple + startup; the M-profile path is the model.
- **aiT evaluation license** → a certifiable WCET bound from the industry tool,
  fed the flow facts from stage 2.
- **More kernels** — Kalman filter, CRC, PWM ramp — as a WCET-analyzable suite.
- **Reclaiming allocator** — the bump heap never frees; a free-list (or TLSF, for
  O(1) real-time behavior) would allow steady-state alloc/free churn instead of
  init-time-only allocation.
