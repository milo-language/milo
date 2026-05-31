# Milo Embedded / WCET Mission — Working State

**Goal:** bare-metal Cortex-M support so Milo safety profiles + contracts can be
proven with real WCET analysis.

**Workspace:** git worktree `embedded-cortexm` at
`/Users/csmith/git/milo/.claude/worktrees/embedded-cortexm` (branch
`embedded-cortexm`, off `main`). Per memory `feedback_main_branch`: main or
worktree only. Per `feedback_iteration_speed`: targeted tests, never full
`bun test` in the loop. Loop = CronCreate job `796e7664` (~20 min).

## Stages
- (A) cross-compile to Cortex-M — triples in src/target.ts + clang -mcpu/-mfloat-abi.  **DONE** (eff5dfc)
- (B) freestanding runtime — startup vector table + linker script + semihosting + libc shim; `build --target` links runnable ARM ELF.  **DONE** (749f1fa)
- (C) functional verify on QEMU `mps2-an385 -semihosting`.  **NEXT — needs `brew install qemu`**
- (D) WCET — emit loop-bound flow facts from safety pass for OTAWA.  not started

## Commits so far (newest first)
- `749f1fa` embedded freestanding libc shim + wire bare-metal build (15 tests pass, GOOD)
- `eff5dfc` --target flag; emit-obj → thumb objects (good)
- `2c23f2b` cortex-m triples + resolveTarget (good)
- `757922d` safety gap-#4 (on MAIN, good)

## VERIFIED WORKING
- `milo build blink.milo --target=cortex-m3 -o x.elf` → `ELF 32-bit LSB
  executable, ARM, EABI5, statically linked`. Same for `--target=stm32f4`.
- Host build/run unaffected. 15/15 targeted tests pass (embedded + safety).
- libc shim in startup.c provides memcpy/memset/malloc(bump)/free(noop)/exit
  (semihosting)/printf(stub) so `-nostdlib` link resolves the symbols Milo IR
  emits via std string helpers.

## Key facts / gotchas
- Apple `/usr/bin/clang` cross-compiles thumb fine; `ld.lld` at /opt/homebrew/bin (lld 22).
- Milo `@main` signature: `define i32 @main(i32 %_milo_argc, ptr %_milo_argv)` —
  startup.c declares `extern int main(void)`; ABI mismatch is harmless (extra
  args ignored on ARM AAPCS) but could pass argc=garbage; acceptable for now,
  note it. Could declare `int main(int,char**)` and call main(0,0) to be clean.
- Linker script embedded/cortex-m/mps2.ld: FLASH@0x0, RAM@0x20000000, vector
  table first via KEEP(.isr_vector). _estack = top of RAM.
- emit-obj path already wires clangTargetFlags (works, tested). Only build/link
  path is the remaining work.
- To install missing tools later (Stage C): `brew install qemu` (gives
  qemu-system-arm); arm-none-eabi optional (we use clang+lld, don't need it).

## NEXT ITERATIONS
- Finish shim+wiring (above), commit.
- Stage C: once qemu installed, run `qemu-system-arm -M mps2-an385 -nographic
  -semihosting -kernel <elf>`; expect exit code path via semihosting. Wire a
  `milo run --target` that shells to qemu if present.
- Stage D: in src/safety.ts, when requireBoundedLoops, emit per-loop iteration
  bounds (from `invariant`/range) as OTAWA flow-fact (.ff) file alongside the ELF.
