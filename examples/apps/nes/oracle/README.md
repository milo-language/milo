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
3. `bun examples/apps/nes/oracle/oracle.mjs`

## Finding (2026-07)
jsnes plays BOMBERMAN launched from the 1200-in-1 menu — Start advances past the
title (pc -> $C602, framebuffer changes). OUR emulator stays on the title
(vblank-wait loop $C288). Same mapper-227 logic in both, so the bug is in our
CPU/PPU/input core, not the mapper. Controller $4016 read looks standard; likely a
subtle opcode/PPU/timing issue on BOMBERMAN's title->play path. Next: aligned
instruction trace-diff (extract BOMBERMAN standalone with a patched reset vector so
both emulators run deterministically from reset, then diff pc/regs to first divergence).
