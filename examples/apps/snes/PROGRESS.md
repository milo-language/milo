# Milo SNES emulator — progress

Goal: SNES emulator in Milo, SDL2 native display. Same methodology as the NES
build (examples/apps/nes/): CPU-first bring-up against golden per-opcode
traces, hard validation gate before any pixels. Reuses the NES SDL frontend
pipeline (window/texture/audio-queue/input) and the per-scanline renderer
architecture.

Key asymmetry vs NES: audio is NOT optional-until-later. Games upload their
sound driver to the SPC700 through a handshake port at boot and spin waiting
for replies — no SPC700 core, no boot. S-DSP (actual sound output) CAN wait.

## Reference material (oracle order: docs → tests → emulators)

- **fullsnes** (nocash) — single-page hardware bible: https://problemkaputt.de/fullsnes.htm
- **snes.nesdev.org** wiki — tutorial-grade coverage, same community as nesdev.
- **TomHarte/ProcessorTests** — JSON single-step tests, thousands of cases per
  opcode with full before/after state: `65816/` and `spc700/` dirs. This is
  nestest but better (per-opcode, exhaustive). Clone shallow into `roms/` area
  (gitignored) like nes-test-roms.
- **Test ROMs**: PeterLemon/SNES (krom) on GitHub — small focused ROMs per
  PPU feature (BGs, Mode7, HDMA, color math), each with a known-good screenshot.
- **Reference emulators** (behavior questions only, don't port): Mesen2
  (best debugger — trace logger + event viewer), bsnes (accuracy reference).

## Update (2026-07): SMW plays into levels — HBLANK-wait + HDMA landed

SMW now goes title -> file select -> **into a level rendering in full color** (Yoshi's
Island 1: HUD, level, intro cutscene). Two fixes:
- **$4212 HBLANK flag (bit6).** SMW's level-init hard-waits `BIT $4212 / BVC $8440`
  for HBLANK before fading the screen in. We returned only bit7 (vblank), so bit6
  never set and the CPU spun forever at $008440 with brightness stuck at 0 (screen
  black, but the level was fully loaded behind it). We don't model dot timing, so
  bit6 is pulsed off a free-running per-instruction counter (`m.hcounter`, `(x&7)<2`)
  — any spin-wait resolves in a few instrs. Found via the dbg `--probe` (2 distinct
  PCs) + `--forcebright` (revealed intact level graphics behind the black).
- **HDMA engine (`hdmaWalkFrame`).** Walks each armed channel's table for all 224
  lines once per frame (tables stable at end-of-active-display), records per-line
  overrides the renderer consumes. Currently wired: INIDISP brightness (fades) +
  COLDATA (gradient sky); pointers advance correctly for all patterns/indirect, but
  scroll/Mode7/window targets aren't consumed by the renderer yet. Non-HDMA games
  are byte-identical (hdmaOn=false path).

Debug tooling added to `dbg.milo`: `--forcebright` (reveal graphics behind a black
fade), `--probe` (hot-PC histogram → spot wait-loops), HDMA-channel decode in the
reg dump. See `.claude/skills/emu-debug/SKILL.md`.

DKC: boots -> Rareware logo -> animated intro -> file select -> STARTS A LEVEL, but
the level-load derails ($7003 BRK loop). 2026-07-14 fixes (6 commits): (1) black-screen
crash - DKC's vblank NMI handler ($80A97A) saves A/X/Y but NOT DBR, so NMI is only safe
from the main wait-loop (DBR=$80); a heavy frame overran the budget, NMI landed
mid-routine (DBR=$BB), the dispatcher read its handler table through the wrong bank ->
JMP to unmapped RAM. First fixed by raising the CPU budget 7600->20000, then made robust
by firing NMI at WAI ($CB) instead of a fixed count (NMI always fires from the idle
wait). (2) Rareware logo - it's on the sub-screen, added to main via CGADSUB color-math;
added additive blend compositing. (3) manual $4016/$4017 serial joypad (Start/Enter now
work). (4) anti-piracy "unauthorized device" screen - size SRAM from the header (DKC=2KB,
mask $7FF) not a fixed 32KB so the mirror check passes. (5) 16x16 BG tiles (BGMODE bits
4-7) - DKC level BGs use them.
NEXT: level-load derail. Reproduce via a PRE-CRASH world-map save-state replayed forward
(scripted enter-level press) + a PC/DBR ring-buffer derail tracer; a post-crash state
can't be traced. Likely another lag/vector-corruption path in the level decompressor.

Still black/next: SMW intro message auto-advance into playfield scroll; remaining
HDMA render targets (scroll parallax, Mode7 perspective, window).

## Status (M1/M2/M3 done; M4 first pixels + frame loop; M5 DMA done)

Latest: the emulator RUNS A ROM end-to-end. A synthesized ROM's 65816 code DMAs
a palette+tile into the PPU, configures BG1, and loops; `stepFrame` runs it
through the frame loop (vblank + NMI), and `renderFrame` produces a real tiled
image (romGfxDemo.milo -> /tmp/snes_rom.ppm). Full path proven:
CPU exec -> DMA -> PPU VRAM/CGRAM -> BG1 render -> pixels.

Done: M1 CPU (256 ops, 254 Harte-green), M2 bus/cartridge/MMIO, M3 SPC700 (256
ops green) + IPL boot handshake, M4-partial (BG1 Mode-1 renderer: 4bpp tiles,
tilemap, cgram palette, brightness, scroll, per-tile palette/flip), M5 general
DMA (8 channels), frame loop + vblank NMI (nmiFrameDemo: 5 frames = 5 NMIs).
Smokes all green: systemSmoke, mmioSmoke, systemBoot, dmaSmoke, ppuRenderSmoke,
ppuDemo, nmiFrameDemo, romGfxDemo.

Next (toward a real game): BG2/BG3 layers + priority; sprites (OBJ); remaining
BG modes + Mode 7; per-scanline rendering (HDMA/mid-frame effects); SDL window
frontend (reuse NES pipeline) + input; H/V IRQ; then load a real .sfc. No game
ROM on disk yet — the cartridge loader is ready for one dropped in ~/Downloads.
Milo runtime gotcha found: growing a string while a large Vec is live corrupts
the heap — pre-size with String.withCapacity (see feedback/).

## (was) Status (M1 done; M2 bus+cartridge underway)

M1 CPU: all 256 opcodes; 254 Harte-exact green (e+n). MVN/MVP atomic (excluded
from gate — cycle-bounded partial state). BRK/COP/RTI/WAI/STP/WDM green.

M2 (in progress): `Mem` is now the real SNES bus with a `testMode` flag that
preserves the Harte flat-RAM path. Real path: 128 KiB WRAM ($7E-$7F + $00-$3F/
$80-$BF low mirror), LoROM/HiROM cartridge fetch (romOffset), MMIO $2000-$5FFF
stubbed to a scratch store for readback. `busNew(rom, map)` + `newCpuReset(m)`
(vectors through $00:FFFC, boots in emulation mode). `cartridge.milo` loads
.sfc/.smc, strips 512-byte SMC header, scores $7FC0/$FFC0 to pick LoROM/HiROM.
systemSmoke.milo: synthesizes a LoROM, boots from reset, runs LDA/STA/LDX/INX —
green (ROM fetch + WRAM store verified). Harte still green (testMode intact).
CPU-side MMIO now modeled (mmioRead/mmioWrite): $4200 NMITIMEN, $4202-$4206
multiply/divide -> $4214/$4215 quotient + $4216/$4217 product/remainder (games
poll these constantly), $4210/$4212 NMI/vblank status (vblankToggle driven by
the future frame loop, not on-read — accurate RDNMI-clear waits for M4 timing),
$4218/$4219 auto-joypad. mmioSmoke.milo verifies mul (12*10) + div (100/7) green.
Reads are pure (no cascade to &mut memRead). PPU regs $2100-$213F still scratch.
M3 (SPC700 + boot handshake — DONE for boot; S-DSP audio deferred to M7):
  - `spc.milo`: full SPC700 core, ALL 256 opcodes Harte-exact green (0 failures,
    full-suite verified). Includes DIV's quirky overflow path, DAA/DAS decimal
    adjust, BBS/BBC bit-branches, TCALL table, BRK/RETI, (X),(Y) ALU.
  - Real-mode SpcMem: 64 KiB RAM + 64-byte IPL boot ROM at $FFC0 + $F4-$F7
    CPU<->SPC port latches + $F1 control (testMode keeps the Harte path).
  - Bus bridge: main $2140-$2143 <-> apuReadPort/apuWritePort; Mem owns the
    Spc + SpcMem; runApu() co-runs the SPC from the system step loop.
  - spcHandshake.milo: SPC boots IPL, posts $AA/$BB. systemBoot.milo: the main
    65816 polls $2140, sees the SPC's $AA through the bridge, and proceeds — the
    exact spin-loop every commercial ROM blocks on. Both green.
  S-DSP (actual sound synthesis) stubbed silent; belongs to M7.
Still open on M2: PPU-register write path + system frame loop (scanline counter
driving vblank/NMI). Next big piece: M4 PPU (first pixels) + SDL frontend.

## (earlier) Status notes

CPU core scaffolded (`cpu.milo`) + Harte harness live. Registers held as i64
masked to width; m8()/x8() decide operand size live. Harness path proven:
`harteConv.ts` flattens each opcode JSON → whitespace int stream (std/json
clones the 3.8 MB source per accessor and OOMs — see genesis/), `runHarte.milo`
tokenizes it, `harte.sh` runs one process per opcode (both e/n modes).

Green so far (510/510 files = 5.10M cases, both emulation + native):
  NOP; flags CLC/SEC/CLI/SEI/CLV/CLD/SED; XCE; REP/SEP; all transfers
  (TAX/TAY/TXA/TYA/TSX/TXS/TXY/TYX/TCS/TSC/TCD/TDC); XBA; INX/INY/DEX/DEY;
  stack PHA/PLA/PHP/PLP/PHX/PLX/PHY/PLY/PHB/PLB/PHK/PHD/PLD/PEA;
  LDA/STA/ORA/AND/EOR/CMP/ADC/SBC across ALL 14 addressing modes (imm/dp/dp,X/
  abs/abs,X/abs,Y/long/long,X/(dp,X)/(dp),Y/[dp]/[dp],Y/sr,S/(sr,S),Y);
  CPX/CPY (imm/dp/abs); LDX/LDY/STX/STY (+ STZ) across their modes;
  RMW ASL/LSR/ROL/ROR + INC/DEC (accumulator + dp/dp,X/abs/abs,X); TSB/TRB
  (dp/abs); BIT (imm sets only Z; dp/dp,X/abs/abs,X set N/V/Z);
  branches (BPL/BMI/BVC/BVS/BCC/BCS/BNE/BEQ/BRA/BRL); jumps JMP abs/long/(abs)/
  (abs,X)/[abs]; JSR/RTS, JSL/RTL; PEI/PER.
Op dispatch factored: readMval/readXval/immM/immX + setA/setXreg/setYreg +
  compareVals + doADC/doSBC + per-op *From helpers → each family is ~14 arms.
ADC/SBC gotchas (Harte-driven): decimal BCD must be per-nibble with carry
  capped at 1 (invalid input like 0xA+0xF can't carry 2) and lower nibbles
  preserved; on 65C816 N/Z come from the final BCD result, V from the
  pre-high-adjust top nibble, and SBC keeps binary C/V.
Addressing infra now proven (aDp/aDpX/aAbs/aAbsX/aAbsY/aLong/aLongX/aDpIndX/
  aDpIndY/aDpLong/aDpLongY/aSr/aSrY + read16w/write16w) — reusable for the rest
  of the load/store/ALU/RMW families.
Key gotchas found:
  - Emulation forces stack high byte to 01 — mask S on load.
  - Stack page-1 wrap is per-instruction: classic ops (PHA/PLA/PHP/PLP/PHX/PLX/
    PHY/PLY) wrap each byte within page 1; "new" ops (PEA/PHD/PLD/PHB/PLB/PHK)
    use a full 16-bit S (can leave page 1) and only clamp SH=01 at the end.
  - Direct-page indexed: emulation + DL==0 wraps the index within the zero page
    (D&0xFF00)|((dp+idx)&0xFF), not across bank 0 (dpIndexed()).
  - 16-bit mem access +1 wraps in bank 0 for dp/sr modes, linear 24-bit else
    (read16w/write16w bank0wrap flag). Never differs by M-width in emulation
    (emulation is always 8-bit), only matters native.
Next: control flow — branches (Bcc/BRA/BRL), JMP/JSR/RTS/RTL/JML/JSL and their
  indirect forms; then PEI/PER, MVN/MVP block moves, BRK/COP/RTI, WAI/STP/WDM.
  ~239/256 opcodes done. Remaining: BRK/COP/RTI, MVN/MVP block moves, WAI/STP/WDM.
Harte full-suite is ~336 interpreter launches (~5-6 min); for iteration, run
  subsets: harte.sh <op ...>. Consider pointing harte.sh at the prebuilt binary
  instead of `bun run ... run` to ~10x the sweep later.

Run: `examples/apps/snes/harte.sh` (or `harte.sh ea a9 …` for a subset).

## Milestones

- [x] **M1 — 65C816 CPU core** (`cpu.milo`): start from the NES 6502 core
      (nestest-validated 8991/8991). Additions over 6502:
  - E-flag emulation mode vs native; M/X flags switch A and X/Y between
    8/16-bit — instruction *lengths* depend on runtime flags (biggest
    structural change: operand fetch is mode-dependent).
  - 24-bit addressing: PBR/DBR bank registers, new modes (absolute long,
    [dp], [dp],Y, sr,S, (sr,S),Y, block moves MVN/MVP).
  - New opcodes: PHB/PLB/PHD/PLD/PHK, TCD/TDC/TCS/TSC, XBA, XCE, REP/SEP,
    BRL, PER/PEA/PEI, JML/JSL/RTL, COP, WDM, STP/WAI.
  - Decimal mode is REAL on 65816 (NES 2A03 lacked it) — ADC/SBC BCD paths.
  - **Gate: Harte 65816 SingleStepTests, per-opcode diff harness**
    (`runHarte.milo` + a TS diff script, same pattern as nestestDiff.ts).
    Every opcode green in both emulation + native mode before proceeding.
- [x] **M2 — bus + cartridge**: LoROM first (HiROM after; detect via header
      checksum at $7FC0/$FFC0). WRAM 128K, open bus, MDR. NO enhancement
      chips (SuperFX/SA-1/DSP-1) — huge library without them.
- [x] **M3 — SPC700 core + handshake** (`spc.milo`): full second CPU, own
      64KB RAM, IPL boot ROM (64 bytes, embed as data). CPU↔APU ports
      $2140-$2143. **Gate: Harte spc700 SingleStepTests**, then: commercial
      ROM gets past its audio-driver upload spin-loop (log port traffic).
      S-DSP stubbed to silence.
- [ ] **M4 — PPU part 1, first pixels** (`ppu.milo`): per-scanline renderer
      (same architecture as NES e327ebb — latch scroll/bank state per line).
      Mode 1 only (BG1/BG2 4bpp + BG3 2bpp — covers most of the library),
      sprites (OBJ, 4bpp, size table), CGRAM 15-bit color, VRAM ports +
      increment modes, NMI/VBlank, auto-joypad read. forced blank, brightness.
      **Gate: krom BG/OBJ test ROMs match reference screenshots; a real game
      shows its title screen.**
- [~] **M5 — DMA + HDMA**: 8 channels, all transfer patterns; HDMA per-line
      table walker (indirect + direct). Nearly every game gates on this for
      status bars / gradients. **Gate: krom HDMA tests + game HUDs render.**
- [ ] **M6 — input + timers**: joypad ports (manual $4016 + auto-read $4218+),
      H/V IRQ ($4207-$420A) — games use IRQ for raster effects. Multiply/
      divide registers $4202-$4206 (cheap, do early — games poll them).
- [ ] **M7 — S-DSP audio**: BRR sample decode, 8 voices, ADSR/GAIN envelopes,
      pitch modulation, echo buffer (uses APU RAM), noise. Feed the existing
      SDL_QueueAudio path at 32kHz native rate. **Gate: recognizable music in
      a commercial game.**
- [ ] **M8 — PPU part 2**: remaining BG modes (0,2-6), Mode 7 (affine, 8x8
      signed matrix math per line — HDMA-driven), color math + fixed color,
      windows, mosaic, offset-per-tile (modes 2/4/6). 8x16 handled via OBJ
      size table already in M4.
- [ ] **M9 — compat pass**: HiROM, SRAM saves (.srm), interlace/hires
      (512-wide, Mode 5/6 + pseudo-hires) only if a target game needs it.
- [ ] later: enhancement chips (SuperFX for Star Fox, SA-1 for Mario RPG),
      Pi/TV/kiosk lane (reuse NES M7-M9 infra wholesale).

Order rationale: M1→M3 before pixels because boot literally blocks on SPC
handshake; Mode 1 + DMA/HDMA + input = "most games playable, silent"; sound
(M7) before exotic PPU modes (M8) — playable-with-music beats Mode 7 demos.

## Expected Milo pain points (from NES experience)

- Match-arm blowup at -O2: 65816 dispatch is ~256 arms × mode variants —
  keep the -O0 iteration workflow, prebuilt binaries for gates.
- Mode-dependent operand size wants helper fns returning (value, bytes,
  cycles) tuples — struct returns, avoid codegen surprises.
- 16-bit wrapping arithmetic: wrappingAdd/Sub exist on u16 — verify shift
  semantics at width like the u8 work in 24a8335.
- SPC700 + 65816 + DSP all mutate shared state — same &mut Bus threading
  pattern as NES cpu/ppu/apu; watch borrow granularity.

## Build / run (target shape)

```
milo build examples/apps/snes/runHarte.milo -o /tmp/runHarte --debug
milo build examples/apps/snes/snes.milo -o /tmp/snes --debug -- -L/opt/homebrew/lib -lSDL2
/tmp/snes roms/games/somegame.sfc
```
