# Milo NES emulator — progress

Goal: NES emulator in Milo, SDL2 native display. CPU-first bring-up, validated
against `nestest.log` before any pixels.

## Milestones

- [x] **M0 — SDL2 display**: `sdlSmoke.milo`. Window + streaming RGBA framebuffer
      at 60fps, verified visually. FFI/link path proven.
- [x] **M1a — iNES loader**: `cartridge.milo` + `testCartridge.milo`. Parses
      nestest.nes (mapper 0, 16K PRG, 8K CHR). Tested.
- [x] **M1b — 6502 CPU core**: `cpu.milo`. Registers, flags, bus (2K RAM +
      mirroring, mapper-0 PRG map), all addressing modes, full **official**
      opcode set with cycle-accurate timing.
- [x] **M1c — nestest harness**: `runNestest.milo` + `nestestDiff.ts`. Runs
      headless from $C000, diffs PC/A/X/Y/P/SP/CYC vs the golden log.
      **5004/8991 instructions match exactly** (registers AND cycles). Divergence
      at 5005 is the first *unofficial* opcode (`04 A9 *NOP`) — official set done.
- [ ] **M1d — unofficial opcodes**: NOP variants (04/44/64/0C/14../80/82..),
      LAX/SAX/DCP/ISB/SLO/RLA/SRE/RRA, unofficial SBC (EB). Target: full 8991-line
      match. Then blargg `instr_test-v5` for deeper coverage.
- [ ] **M2 — PPU**: background tiles, then sprites, then scrolling. Feeds the
      same RGBA framebuffer M0 already renders.
- [ ] **M3 — controller input**: SDL key events → $4016 shift register.
- [ ] **M4 — playable**: wire SDL frontend + PPU + input; boot Super Mario Bros.
- [ ] later: APU audio · terminal backend (diff-based truecolor blit, same fb) ·
      more mappers (MMC1/UxROM/MMC3) · blargg suites (instr_test, ppu_vbl_nmi).

## Test ROMs

`roms/` (gitignored, shallow clone of nes-test-roms):
- `roms/nes-test-roms/other/nestest.nes` + `.log` — CPU golden trace.
- blargg suites: `instr_test-v5`, `cpu_timing_test6`, `ppu_vbl_nmi`,
  `sprite_hit_tests` — for later milestones.

## Build / run

```
milo build examples/apps/nes/sdlSmoke.milo -o /tmp/sdlSmoke -- -L/opt/homebrew/lib -lSDL2
milo run   examples/apps/nes/testCartridge.milo
```

## Milo gotchas learned (this build)

- Pass `&string`/`&T` args **by value** at call sites — `f(x)`, not `f(&x)`
  (`&x` yields `*string`, a raw pointer, and mismatches `&string`).
- `unsafe {}` is a statement block, not an expression: bindings live inside it
  (`unsafe { let p = ffi(); ... }`), can't write `let p = unsafe { ffi() }`.
- Extern calls returning a pointer, plus address-of + pointer casts, need `unsafe`.
- Strings hold arbitrary bytes fine (binary ROM reads OK); index with `s[i]: u8`.
- `match` arms need the qualified variant: `Result.Ok(x) =>`, not `Ok(x) =>`.
- SDL pixel-format enums are computed macros — verify hex via a tiny C program,
  don't hand-compute. ABGR8888 = 0x16762004 (memory byte order R,G,B,A).
- `print` appends a newline per call — the nestest harness needs a
  no-newline writer (`writeStdout`) for exact line formatting.
