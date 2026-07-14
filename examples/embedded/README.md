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
- **Compute kernels only.** The hosted stdlib (`std/io`, `std/net`, …) is not
  freestanding — a full app importing them won't link bare-metal. WCET targets
  are compute kernels by nature, and that path is fully proven here.

## Available upgrades

- **Cortex-R target** (e.g. TI TC3xx / Arm R5F) — the lockstep safety cores in
  real ASIL-D SoCs. Needs a new triple + startup; the M-profile path is the model.
- **aiT evaluation license** → a certifiable WCET bound from the industry tool,
  fed the flow facts from stage 2.
- **More kernels** — Kalman filter, CRC, PWM ramp — as a WCET-analyzable suite.
