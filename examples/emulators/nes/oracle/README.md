# jsnes reference-oracle for NES debugging

Independent reference emulator (jsnes) to diff our CPU/PPU/input against when a
game misbehaves and nestest (CPU-only) can't drive it.

## Setup
1. `bun add jsnes`
2. jsnes ships no mapper 227 (1200-in-1 multicart). Add it:
   - copy `jsnes-mapper227.js` -> `node_modules/jsnes/src/mappers/mapper227.js`
   - register in `node_modules/jsnes/src/mappers/index.js`:
     `import Mapper227 from "./mapper227.js";` and `227: Mapper227,` in the export map.
   (jsnes' package `main` is a webpack bundle; import from `src/index.js` so the
   patched mappers are used.)
3. `bun examples/emulators/nes/oracle/oracle.mjs`

## Finding (2026-07) — RESOLVED
jsnes played BOMBERMAN launched from the 1200-in-1 menu — Start advanced past the
title (pc -> $C602). OUR emulator stalled on the title in a vblank-wait loop $C288.
Same mapper-227 logic in both, so the bug was in our core, not the mapper.

Root cause: **NMI was dispatched immediately** after the instruction whose PPU
catch-up set the vblank flag. BOMBERMAN's title->play routine at $C288 is the
classic `LDA $2002 / BPL` "wait for vblank to begin" poll with NMI enabled; the
eager NMI preempted the poll every frame, and the NMI handler's own $2002 read
cleared bit 7 before the mainline could observe it, so the loop spun forever. Real
6502 polls the interrupt lines late in each instruction, giving a one-instruction
NMI recognition latency — the mainline read gets to see the flag first.

Fix: `serviceInterrupts()` in `cpu.milo` arms the NMI on the edge and dispatches it
one instruction later. BOMBERMAN now advances title -> "STAGE 1"; PC tracks jsnes
($C603 vs $C602). Repro/regression harness: `traceRun.milo` (drives the menu +
Start via injected controller input, asserts the framebuffer leaves the title).
Punch-Out (MMC2, NMI-timing sensitive) renders byte-identical before/after.
