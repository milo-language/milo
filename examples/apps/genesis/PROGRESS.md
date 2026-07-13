# Milo Genesis / Mega Drive emulator — progress

Goal: Genesis emulator in Milo, SDL2 native display. Same methodology as NES
(examples/apps/nes/) and SNES (examples/apps/snes/): CPU core validated
against golden per-opcode traces before any pixels; SDL frontend pipeline
reused wholesale.

Why Genesis is the *simpler* second console: one fixed VDP mode (no SNES
mode zoo), and **almost no mappers** — carts are flat ROM up to 4MB mapped at
$000000. The one big lift is the 68000 core (large but very regular ISA).
Z80 sound CPU can be stubbed initially (bus-request handshake must exist;
many games run without a live Z80, some need it).

## Reference material

- **M68000PRM.pdf** (Motorola Programmer's Reference Manual) — official AND
  excellent; the one case where the vendor manual beats community docs.
- **genvdp.txt** (Charles MacDonald) — the classic precise VDP doc.
- **Sega2.doc** — official Sega dev manual (system overview, memory map).
- **plutiedev.com** — modern tutorial-grade coverage (VDP, Z80 bus, YM2612).
- **TomHarte/ProcessorTests** — `680x0/68000/v1/` JSON single-step tests
  (~8000 cases per opcode, full before/after state incl. prefetch) + `z80/`.
  Clone shallow, gitignored, like nes-test-roms.
- **Test ROMs**: 240p Test Suite (Genesis build), BlastEm test ROMs,
  Vladikcomper's debugging tools.
- **Reference emulators** (oracle, don't port): BlastEm (accuracy reference),
  clownmdemu (small readable C), Genesis Plus GX (compat king).

## Milestones

### Status (in progress)

**Compatibility: 3/3 commercial games boot + render** (validates the emulator is
not Sonic-specific): Sonic 1 (Green Hill Zone gameplay), Golden Axe (title kanji
戦斧 + sky), Streets of Rage 3 (STREETS title logo). All run millions of 68k+z80
instructions with zero unimplemented opcodes. ROMs gitignored under roms/games/.
Known: minor mid-screen sprite/plane artifacts on some titles; sound not playing
(68k<->z80 sync TODO). SDL frontend fixed for H32<->H40 width switch (was crashing).


**🎉🎉🎉 GREEN HILL ZONE renders** — demo auto-play shows GHZ Act 1: HUD
(SCORE/TIME/RINGS/lives), palm trees, checkered ground, water, rings, Sonic
sprite, with hscroll/vscroll scrolling. Real Sonic gameplay rendering. Reached
via `/tmp/bootrun roms/games/sonic1.md 40000000` (auto-demo after title).
Renderer now: planes A/B + per-line hscroll + full vscroll + sprites.

**🎉🎉 Sonic renders the full TITLE SCREEN** — "SONIC THE HEDGEHOG" winged-star
logo + background + "©SEGA 1991", sprites composited over planes. ~352 frames in.
Run: `milo build examples/apps/genesis/bootRun.milo -o /tmp/bootrun` then
`/tmp/bootrun roms/games/sonic1.md 12000000`; `sips -s format png /tmp/sonic.ppm --out /tmp/sonic.png`.
Renderer now: planes A/B + sprites (link list, column-major tiles, flip). TODO
polish: sprite masking (top-corner tile garbage), hscroll/vscroll, priority,
window plane. Then SDL live display + input + PSG/YM sound.

**🎉 Sonic also renders the SEGA screen** (blue "SEGA™" on white, pixel-correct).
Full pipeline working: 68000 core → bus → VDP regs → 68k→VDP DMA (palette into
CRAM 64/64, tiles into VRAM) → VBlank interrupts (autovec L6) → background tile
renderer → PPM. Run: `milo run examples/apps/genesis/bootRun.milo roms/games/sonic1.md 5000000`
then `sips -s format png /tmp/sonic.ppm --out /tmp/sonic.png`.
68000 ran 5M instrs of real game code with ZERO unimplemented opcodes.
Renderer M3 v1 = planes A/B only (no scroll/window/sprites/priority yet).
Next: run to title screen + add sprites + hscroll/vscroll → full title w/ Sonic.


**M1 underway.** Files: `cart68k.milo` (flat ROM loader), `m68k.milo`
(functional core), `runHarte.milo` + `harteConv.ts` + `harte.sh` (Harte gate).
Sonic 1 ROM at `roms/games/sonic1.md` (gitignored). Harte tests sparse-cloned to
`roms/ProcessorTests/680x0/68000/v1/` (gitignored).

Harte harness works (flat int-stream, NOT std/json — that clones subtrees and
OOMs on the 6 MB files). Core model: pc = next-opcode addr, prefetch seeded into
RAM, compare final regs/pc/sr/RAM exactly (prefetch pipe + txn order skipped).

Implemented + **fully green (8065/8065)**: NOP, MOVEQ, MOVE.b, LEA, PEA,
EXT.w/.l, Scc, SWAP. Partially green (50-90%, remainder = address-error cases):
MOVE.w/.l, MOVEA, ADD/ADDA, SUB/SUBA, CMP/CMPA, AND, OR, EOR, CLR, NOT, NEG, TST,
Bcc, BSR, DBcc, JMP, JSR, RTS.

**Next (highest leverage):** address-error / bus-error exception (7-word group-0
frame). ~40% of every opcode's cases use odd-address EAs → address error; one
implementation flips them all green at once. Then: shifts/rotates ( E-group),
MULU/MULS/DIVU/DIVS, bit ops (BTST/BCHG/BCLR/BSET), MOVEM, immediates group
(ORI/ANDI/…/CMPI), ABCD/SBCD/ADDX/SUBX, TRAP/CHK/privilege traps, RTE/LINK/UNLK,
MOVE to/from SR/CCR/USP. Then M2 bus + boot Sonic.

Run: `examples/apps/genesis/harte.sh [OPCODE ...]` (no args = default set).

- [ ] **M1 — 68000 core** (`m68k.milo`): the bulk of the project. Regular
      ISA — decode by bit-field, not a 64K match: size field (byte/word/long),
      EA mode+reg fields (8 modes × 8 regs) shared by most instructions.
      Structure as `resolveEa(mode, reg, size) -> EaRef` + per-instruction
      fns; one EA implementation serves ~everything.
  - Registers D0-D7/A0-A7 (A7 = USP/SSP split), SR/CCR, supervisor mode.
  - Full instruction set incl. MOVEM, MULU/MULS/DIVU/DIVS, ABCD/SBCD,
    TAS, MOVEP, Bcc/DBcc, TRAP, exceptions (bus/address error frames can
    start minimal — group 1/2 vectors + auto-vectored interrupts needed).
  - Prefetch: Harte tests model it; emulate the 2-word prefetch queue for
    exact matches (cheap once understood, painful to retrofit).
  - **Gate: Harte 68000 SingleStepTests per-opcode diff harness green**
    (`runHarte.milo` + TS diff script, nestestDiff.ts pattern).
- [ ] **M2 — bus + cart**: ROM at $000000 (flat, ≤4MB), 64K work RAM at
      $FF0000, TMSS handling (write 'SEGA' to $A14000 or skip via version
      reg), Z80 area bus stubs ($A00000-$A0FFFF), bus request/grant regs
      ($A11100/$A11200) — games spin on Z80 busreq ack even with no Z80.
- [ ] **M3 — VDP part 1, first pixels** (`vdp.milo`): per-scanline renderer.
      Planes A/B (8x8 4bpp tiles, per-tile palette line + priority + flip),
      window plane, sprites (sprite table walker, size up to 4x4 tiles,
      per-line limits 20 sprites/320px), 64-entry CRAM (9-bit RGB → RGBA
      LUT), VSRAM (per-2-cell vscroll), hscroll modes (full/cell/line),
      DMA (68k→VRAM, fill, copy), FIFO can start as instant. VBlank int
      (level 6) + HBlank int (level 4, HINT counter). H32/H40 (256/320 wide).
      **Gate: 240p suite screens correct; Sonic 1 title + level render
      (Sonic needs line hscroll + vscroll + priority + HINT).**
- [ ] **M4 — input**: 3-button pad first (TH-select multiplex at $A10003),
      then 6-button timeout protocol. SDL keys → pad, same mapping layer as
      NES frontend.
- [ ] **M5 — Z80 + PSG** (`z80.milo`): full Z80 core — **gate: Harte z80
      SingleStepTests** — running in the $A00000 window with its own 8K RAM,
      banked 68k-bus access via $6000 bank reg. SN76489 PSG (square×3 +
      noise; trivial, ~100 lines). Games that need Z80 alive to boot
      (busreq/reset handshake timing) now work.
- [ ] **M6 — YM2612 FM** (`ym2612.milo`): 6 FM channels × 4 operators,
      envelopes, ch3 special mode, ch6 DAC mode (sampled drums — many games).
      Functional-first: correct register map + envelope shapes gets
      recognizable music; exact FM core (SSG-EG, LFO detail) refine later.
      Mix PSG+FM into the existing SDL_QueueAudio path.
      **Gate: recognizable music + drums in a commercial game.**
- [ ] **M7 — compat pass**: SRAM saves ($200000 window + $A130F1 mapping),
      SSF2-style bank switching ($A130Fx) — the ONE mapper, interlace mode 2
      (Sonic 2 two-player) only if targeted.
- [ ] later: shadow/highlight mode, exact VDP FIFO/slot timing (needed only
      for demoscene tricks), Sega CD/32X never. Pi/TV/kiosk lane reuses NES
      M7-M9 infra.

Order rationale: 68k+VDP+input = Sonic playable silent by M4 (Z80 stubbed).
Sound split in two because PSG+Z80 is days while YM2612 is the long tail —
music arrives incrementally.

## Expected Milo pain points (from NES experience)

- 68k decode: bit-field decode helpers instead of one giant match — should
  dodge the -O2 match-blowup that hit the NES step(); verify compile time
  early with a representative decoder skeleton.
- 32-bit wrapping arithmetic everywhere (u32 wrappingAdd/Sub/Mul for EA and
  ALU) — confirm u32 shift/rotate semantics like the u8 work in 24a8335.
- Big-endian target on little-endian host: 68k is BE — word/long bus reads
  assemble bytes explicitly; keep one `read16be/read32be` chokepoint.
- Three clocked components (68k 7.67MHz, Z80 3.58MHz, VDP) — master-clock
  ratios 7:15 (68k) / 15:1 (Z80); use a master-cycle counter, not per-chip
  drift accumulators.

## Build / run (target shape)

```
milo build examples/apps/genesis/runHarte.milo -o /tmp/runHarte68k --debug
milo build examples/apps/genesis/genesis.milo -o /tmp/genesis --debug -- -L/opt/homebrew/lib -lSDL2
/tmp/genesis roms/games/sonic1.md
```
