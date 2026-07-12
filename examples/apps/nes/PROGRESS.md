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
- [x] **M1d — unofficial opcodes**: NOP variants, LAX/SAX/DCP/ISB/SLO/RLA/SRE/RRA,
      unofficial SBC (EB). **Full 8991/8991 nestest match** — the entire 6502
      (official + illegal) is byte-exact vs the golden log, registers AND cycles.
      6502 CPU is DONE and reference-validated.
- [~] **M2 — PPU** (`ppu.milo`):
  - [x] **M2a** — state + VRAM/OAM/palette memory (nametable + palette mirroring),
        CPU register interface ($2000-$2007 + $4014 OAMDMA), dot/scanline timing,
        vblank + NMI flag. Wired into the bus (`busRead`/`busWrite` now `&mut`).
        **nestest still 8991/8991** — no CPU regression. NES 64-color palette +
        background + basic sprite renderer written (not yet visually driven).
  - [ ] **M2d** — SDL frontend: step CPU+PPU (3 dots/cycle), service NMI, blit
        `ppu.fb` each frame. First pixels from a real ROM.
  - [ ] refine: fine-scroll from v/t, sprite-0 hit, 8x16 sprites, mid-frame splits.
- [ ] **M3 — controller input**: SDL key events → $4016 shift register first,
      then `SDL_GameController` for real pads.
- [ ] **M4 — playable**: wire SDL frontend + PPU + input; boot Super Mario Bros
      (mapper 0). Validate with blargg `ppu_vbl_nmi` + `sprite_hit_tests`.
- [ ] **M5 — APU audio**: 2× pulse, triangle, noise, DMC; frame counter IRQ.
      Output via `SDL_QueueAudio` (~48kHz, downsampled from ~1.79MHz APU ticks).
      A/V sync: NES is 60.0988Hz vs TV 59.94/60 — sync to audio, video follows
      (avoids crackle).
- [ ] **M6 — mappers**: UxROM (2: Contra/Mega Man, trivial) → MMC1 (1:
      Zelda/Metroid) → battery saves (PRG-RAM → `.sav`, Zelda needs it) →
      MMC3 (4: SMB3/Kirby, needs scanline IRQ). Mappers 0+1+2+4 ≈ 70% of
      licensed library.
- [ ] **M7 — Pi build**: aarch64-linux (already a milo target), build on-device.
      Watch the `-O2` match-blowup — Pi is slower; fix or build overnight.
      Perf checkpoint first: if 60fps holds at `-O0` on Mac, Pi 5 at `-O2` fine.
- [ ] **M8 — TV fullscreen**: SDL2 KMS/DRM backend (no X11, straight to
      framebuffer), vsync + M5 audio sync. 8BitDo NES-style pad via
      SDL_GameController.
- [ ] **M9 — kiosk boot**: systemd unit, auto-launch, ROM-picker menu rendered
      in the emulator's own framebuffer.
- [ ] **M10 — shell mod (trophy)**: dead NES case, Pi inside, original
      controller ports → GPIO (same latch/clock/serial protocol as $4016 —
      bit-bang it), power LED, HDMI out the RF hole.
- [ ] later: terminal backend (diff-based truecolor blit, same fb) · blargg
      instr_test / cpu_timing suites · save states.

Order: M2d→M4 → M5 → UxROM → M7-M9 → rest of M6 → M10. Sound before mappers —
one playable game with audio on the TV beats ten silent ones.

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
- **Compile time**: `-O2` on the ~250-arm `step()` match takes >3min (LLVM opt
  blowup). `--debug` (`-O0`) builds in ~6s — use it for iteration. `milo run`
  defaults to `-O2`, so run the nestest gate off a prebuilt `-O0` binary
  (`milo build ... --debug -o /tmp/runNestest` then diff), not `milo run`.
  Test whether the SDL demo needs `-O2` for 60fps before eating that compile cost.
- **Wrapping arithmetic**: 8-bit wraps use `x.wrappingAdd/wrappingSub(y)` and
  native `u8 << 1` / `u8 >> 1` (both truncate to the width, no `-O0` overflow
  trap) — not the old `((x as i64 ± 1) & 0xFF) as u8` mask dance. Genuine
  mixed-width (u8→u16 address forming, the i64 ADC sum kept for its flag math,
  cycle counters) still casts explicitly, same as a Rust port would.
- **If-as-value coercion**: `let h: i64 = if c { 16 } else { 8 }` — const-int
  arms now adopt the annotated/inferred width, no `16 as i64` on each arm
  (checker fix 89812bf).
