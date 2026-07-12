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

## Status (M1 in progress)

CPU core scaffolded (`cpu.milo`) + Harte harness live. Registers held as i64
masked to width; m8()/x8() decide operand size live. Harness path proven:
`harteConv.ts` flattens each opcode JSON → whitespace int stream (std/json
clones the 3.8 MB source per accessor and OOMs — see genesis/), `runHarte.milo`
tokenizes it, `harte.sh` runs one process per opcode (both e/n modes).

Green so far (306/306 files = 3.06M cases, both emulation + native):
  NOP; flags CLC/SEC/CLI/SEI/CLV/CLD/SED; XCE; REP/SEP; all transfers
  (TAX/TAY/TXA/TYA/TSX/TXS/TXY/TYX/TCS/TSC/TCD/TDC); XBA; INX/INY/DEX/DEY;
  INC/DEC A; stack PHA/PLA/PHP/PLP/PHX/PLX/PHY/PLY/PHB/PLB/PHK/PHD/PLD/PEA;
  LDA/STA/ORA/AND/EOR/CMP across ALL 14 addressing modes (imm/dp/dp,X/abs/
  abs,X/abs,Y/long/long,X/(dp,X)/(dp),Y/[dp]/[dp],Y/sr,S/(sr,S),Y);
  CPX/CPY (imm/dp/abs); LDX/LDY/STX/STY (+ STZ) across their modes.
Op dispatch factored: readMval/readXval/immM/immX + setA/setXreg/setYreg +
  compareVals + per-op *From helpers → each new family is ~14 one-line arms.
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
Next: ADC/SBC (decimal-mode BCD paths + overflow) — the last big ALU family;
  RMW INC/DEC/ASL/LSR/ROL/ROR (mem + accumulator), TSB/TRB, BIT; then branches
  (Bcc/BRA/BRL), JMP/JSR/RTS/RTL/JML/JSL, MVN/MVP, PEI/PER, BRK/COP/RTI.
Harte full-suite is ~336 interpreter launches (~5-6 min); for iteration, run
  subsets: harte.sh <op ...>. Consider pointing harte.sh at the prebuilt binary
  instead of `bun run ... run` to ~10x the sweep later.

Run: `examples/apps/snes/harte.sh` (or `harte.sh ea a9 …` for a subset).

## Milestones

- [ ] **M1 — 65C816 CPU core** (`cpu.milo`): start from the NES 6502 core
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
- [ ] **M2 — bus + cartridge**: LoROM first (HiROM after; detect via header
      checksum at $7FC0/$FFC0). WRAM 128K, open bus, MDR. NO enhancement
      chips (SuperFX/SA-1/DSP-1) — huge library without them.
- [ ] **M3 — SPC700 core + handshake** (`spc.milo`): full second CPU, own
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
- [ ] **M5 — DMA + HDMA**: 8 channels, all transfer patterns; HDMA per-line
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
