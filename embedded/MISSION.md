# Milo Embedded / WCET Mission — Working State

**Goal:** bare-metal Cortex-M support so Milo safety profiles + contracts can be
proven with real WCET analysis.

**Workspace:** git worktree `embedded-cortexm` at
`/Users/csmith/git/milo/.claude/worktrees/embedded-cortexm` (branch
`embedded-cortexm`, off `main`). Per memory `feedback_main_branch`: main or
worktree only. Per `feedback_iteration_speed`: targeted tests, never full
`bun test` in the loop. Loop = CronCreate job `796e7664` (~20 min).

## Stages
- (A) cross-compile to Cortex-M — triples in src/target.ts + clang -mcpu/-mfloat-abi.  **DONE**
- (B) freestanding runtime — startup vector table + linker script + semihosting + **libc shim**.  **IN PROGRESS**
- (C) functional verify on QEMU `mps2-an385 -semihosting`.  **BLOCKED: no qemu, no arm-none-eabi installed**
- (D) WCET — emit loop-bound flow facts from safety pass for OTAWA.  not started

## Commits so far (newest first)
- `df9c82f` embedded freestanding runtime — **BROKEN, must fix** (see below)
- `eff5dfc` --target flag; emit-obj → thumb objects (good, 13 tests pass)
- `2c23f2b` cortex-m triples + resolveTarget (good)
- `757922d` safety gap-#4 (on MAIN, good)

## CURRENT PROBLEM (fix next)
1. `df9c82f` committed in a broken state:
   - `linkBareMetal()` helper was added to src/main.ts (good)
   - BUT the edit to call it from `compileToBinary()` FAILED (string drift) — the
     old guard `if (target.bareMetal) { error "not yet supported"; exit(1) }` is
     STILL there at ~line 201-209. So `build --target` still errors.
   - tests/embedded.test.ts has a test expecting `build` to SUCCEED → it FAILS.
   - => committed a failing test. Must fix to leave tree green.
2. Root blocker for Stage B: Milo IR references libc symbols `printf exit malloc
   free memcpy` (+ likely memset) even for trivial programs, because std runtime
   funcs (strContains, strToLower, strIndexOf, strToUpper…) are always emitted as
   external `define`s and reference them. `-nostdlib` link → undefined symbols.

## FIX PLAN (this iteration)
1. Add a freestanding libc shim to embedded/cortex-m/startup.c:
   - `memcpy`, `memset` (trivial loops)
   - `malloc` = bump allocator over a static .bss buffer (e.g. 64KB); `free` = no-op
   - `exit(int)` = semihosting SYS_EXIT (already have sys_exit — rename/expose)
   - `printf` = minimal: stub returning 0, OR semihosting SYS_WRITE0 of a fixed
     string. Stub is fine for first link (compute-only programs don't print).
   Note in comments: malloc/printf are for LINK COMPLETENESS; WCET-grade programs
   pass `--safety` (noDynamicAllocation) so they never call malloc at runtime.
2. Re-read exact current text of compileToBinary guard (lines ~201-217), replace
   the guard + the linkIR call with: if (target.bareMetal) linkBareMetal(...) else linkIR(...).
   (linkBareMetal already exists in the file — verify with: grep -n linkBareMetal src/main.ts)
3. Verify manually:
   `bun run src/main.ts build /tmp/blink.milo --target=cortex-m3 -o /tmp/x.elf`
   then `file /tmp/x.elf` must say `ELF 32-bit ... ARM ... executable`.
   blink.milo = `fn add(a:i32,b:i32):i32{return a+b}` + `fn main():i32{return add(2,3)}`
4. Run targeted: `bun test tests/embedded.test.ts tests/safety.test.ts` — must be all-pass.
5. Commit (new commit, lowercase one-line, no claude attribution). Tree clean.

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
