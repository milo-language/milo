---
name: emu-debug
description: Diagnose emulator bugs (black screen, garbled graphics, freezes, derails) in examples/emulators/{nes,snes,genesis}. Use whenever a game renders wrong, hangs, goes black, or crashes in a Milo emulator — BEFORE reading emulator source or guessing.
---

# Emulator debugging

Battle-tested triage for the Milo NES / SNES / Genesis emulators. The #1 failure
mode of agents debugging these: staring at pixels or source code before reading
the machine state. Registers first, pixels second, source third.

## Rule 0.0 — never leave an emulator running (CPU-orphan trap)

Every emulator is an infinite 60fps loop that **never exits on its own**. Launch
one detached and it becomes an orphan (reparented to init, PPID 1) pegging a full
core forever — invisible to your shell, survives the session. Multiple debug
sessions stacked ~300% CPU of dead `/tmp/*_ctrl` / `/tmp/menu` orphans once.

- **Never `run_in_background`, `nohup`, `&`, or `disown` an emulator or its SDL
  window.** Not the headless harness, not the interactive binary — nothing that
  loops.
- **Headless runs must be bounded:** always pass `--frames N` (dbg/shot/bootRun
  all take it) so the process self-terminates. A headless run with no frame cap
  is the same infinite loop.
- **Build debug binaries under a known prefix** (`/tmp/snes/`, `/tmp/nes/`, …) so
  leftovers are greppable.
- **When done, sweep for survivors** (do this at the end of any emu session):
  ```bash
  pkill -9 -f '/tmp/(snes|nes|gen|menu)' ; pkill -9 -f 'examples/emulators/retro/bin/'
  ps -Ao pid,ppid,%cpu,command -r | grep -Ei '_ctrl|retro/bin|/tmp/menu' | grep -v grep
  ```
  Orphans show `PPID 1` — kill by PID if the pattern misses.

## Rule 0 — reproduce headless, never through the SDL window

Each system has a headless harness that runs N frames and dumps an image you can
Read directly (convert PPM → PNG first):

```bash
ffmpeg -y -loglevel error -i out.ppm out.png   # then Read the .png
```

| System | Harness | Notes |
|---|---|---|
| SNES | `examples/emulators/snes/dbg.milo` | **the full diagnoser** — see below |
| NES | `examples/emulators/nes/shot.milo` → `/tmp/shot <rom> <frames> <out.rgb>` | raw RGB24: `ffmpeg -f rawvideo -pixel_format rgb24 -video_size 256x240 -i out.rgb -y out.png`. No input injection — copy dbg.milo's `--press` pattern in if you need menus |
| Genesis | `examples/emulators/genesis/bootRun.milo` | traces 68k boot + dumps VDP state + PPM |

Build (SNES example): `bun run src/main.ts build examples/emulators/snes/dbg.milo -o /tmp/snes/dbg --debug`
ROMs: `/tmp/snes/roms/{smw,dkc}.smc` (originals in `~/Downloads/nesgames/`; NES: `examples/emulators/nes/roms/`).

### SNES `dbg` flags

```
/tmp/snes/dbg <rom.sfc> [--frames N] [--state f.state] [--press btn@a-b]
              [--shot f] [--layers] [--out prefix]
```

- `--shot f` (repeatable): composite PPM + **decoded register dump** (incl. armed
  HDMA channel targets) at frame f.
- `--press start@450-455` (repeatable): hold a button over a frame range —
  navigates title/menus without SDL. Hold ~5 frames; game polls once per frame.
- `--layers`: re-render each enabled layer in isolation (`_bg1..4.ppm`, `_obj.ppm`).
- `--forcebright`: override INIDISP to full brightness before render — reveals
  whether graphics are actually loaded when the game holds the screen black
  (fade/handshake stall vs genuinely-empty VRAM). The single fastest way to tell
  "black because stuck" from "black because nothing rendered."
- `--probe`: after the run, single-step and print a hot-PC histogram. A tiny hot
  set (2-3 PCs) = the CPU is spinning in a wait loop (unmet MMIO poll); disassemble
  those ROM bytes to see what register it's waiting on. This is how the SMW
  level-black was pinned to a `BIT $4212 / BVC` HBLANK wait.
- `--state <rom>.state`: resume from a save-state (F5 in the SDL emu writes it).

## Triage ladder — run in this order

**1. Read the register dump before looking at any pixels.**
The SNES dump decodes INIDISP/BGMODE/TM/TS/CGADSUB/COLDATA/backdrop/BG bases/
HDMAEN and prints explicit `<<<` callouts for the two classic traps:

- `brightness=0` or `FORCE-BLANK` → the screen is black **on purpose** (the
  game set it). The render pipeline is fine. Question becomes: why does the
  game never turn brightness back up? (Usually: it's mid-fade via a mechanism
  we don't emulate, or the CPU derailed — see step 4.)
- `HDMAEN != 0` → game armed HDMA, which is **not implemented** on SNES.
  Expect black fade-ins, missing gradient skies, static Mode 7.

**2. Bisect frames.** Multiple `--shot` points; find the exact frame the image
goes wrong. Register diffs between shots tell you what the game changed.

**3. Isolate layers** (`--layers`). Garbled BG layer → tilemap/char-fetch/scroll
path. Garbled OBJ only → OAM/sprite path (NES precedent: MMC2 sprite-fetch
latch order). One layer black but enabled → its map/char base or palette.

**3b. Frozen image but game logic maybe running → check WRAM vars.** The SNES
dbg reg dump prints a `wram:` line ($13/$14 frame counters, $94 player X, $1A/$1B
scroll). If the frame counter advances but player/scroll don't, the main loop is
running but the game is in a wait *substate* — often a cutscene/message that
needs a button (SMW's story intro won't advance without a `--press b`), or an
APU-synced sequence we can't complete. Bump input before assuming a bug. If
*nothing* in WRAM advances across frames, it's a true stall → step 4.

**4. Freeze/black with sane PPU regs → suspect CPU derail or wait-loop, not PPU.** Classic
signature: derail → lands in zeroed RAM → BRK/crash-trap loop (SNES DKC frame
761, SMW pre-fix `(dp)` opcodes). Checks: do regs still change between shots?
Does NMITIMEN stay sane? Add a temporary PC ring-buffer print in the CPU step
if needed. Root causes so far have been *unimplemented opcodes falling through
to default* (desyncs PC) — grep the opcode dispatch for the bytes around the
derail before assuming anything subtler.

**5. Check the known-gaps list before "finding" a bug.** If the symptom matches
a gap, it's not a mystery — it's a feature to implement:

- **SNES:** HDMA is **partial** — the engine (`hdmaWalkFrame`) walks tables and
  drives INIDISP brightness (fades) + COLDATA (gradient sky) per-line; scroll
  parallax, Mode 7 perspective, and window HDMA targets advance pointers but
  aren't rendered yet. Still missing: color-math add/half blends (backdrop-add
  only); windows; mosaic; hires/interlace; S-DSP audio synthesis. TM/TS
  compositing is approximate (TS as base layer, no real blend).
- **SNES timing stubs:** `$4212` bit7 (vblank) and bit6 (HBLANK) are pulsed off
  counters, not real dot timing. A game that hard-waits on a status bit we don't
  model will spin forever (black/frozen) — `--probe` finds the wait PC, then
  disassemble to see the polled register. Precedent: SMW HBLANK wait.
- **Genesis:** per-scanline CRAM (raster water-line effects); VDP data-port
  reads; sprite masking/per-line limits; interlace; PAL.
- **NES:** essentially complete for supported mappers (no MMC1).

**6. Oracle it.** When steps 1-5 leave a genuine core-behavior question:

- **CPU single-instruction:** Harte SingleStepTests, already wired —
  `examples/emulators/snes/harte.sh <opcode-hex …>` (65816), `harteSpc.sh` (SPC700),
  Genesis `runHarte.milo`. Run the suspect opcodes, not the full suite.
- **NES whole-game:** jsnes harness at `examples/emulators/nes/oracle/` (see its
  README). Diff register-write profiles or per-scanline tile/bank state
  frame-by-frame; find the first divergence.
- **SNES whole-game:** no oracle wired yet. Set up Mesen2's Trace Logger and
  diff PC/A/X/Y/P around the divergent frame (this is the documented plan for
  the DKC frame-761 derail).
- **Reference emus can be wrong too** (jsnes had the identical MMC2 bug).
  Ultimate ground truth: render straight from dumped VRAM/nametable + ROM CHR
  with a throwaway script and compare against real-hardware screenshots/videos.
- **Feature-level:** krom (PeterLemon/SNES) test ROMs — one tiny ROM per PPU
  feature with a known-good screenshot.

## Unreachable game states → save-states (SNES)

Scripted input can't reach everything (SMW's intro can't be skipped). Ask the
user to play in the SDL emu and press **F5** at the broken moment → writes
`<rom>.state`. Then debug it headless, deterministically:

```bash
/tmp/snes/dbg roms/smw.smc --state roms/smw.smc.state --frames 1 --shot 0 --layers
```

`--frames N` replays N frames on top of the state (replay is deterministic).

## Institutional memory — read before deep-diving

- `examples/emulators/snes/PROGRESS.md` — SNES status, milestones, reference links
  (fullsnes, snes.nesdev.org, Harte, krom).
- `git log --oneline -- examples/emulators/<sys>/` — commit messages carry full
  root-cause writeups of every bug fixed so far; search them for your symptom
  (`git log --grep=latch -- examples/emulators/nes/`).
- Hard-won gotchas live in the user's memory notes (NES: IRQ level-OR not
  latch, MMC2 fetch-order latches; Genesis: DMA-fill on arm, IO regs power-on
  0, Z80 busreq/HALT; SNES: SPC handshake interleave, stack-wrap quirks).

## When you fix it

Follow `/workflow`. Additionally: put the root cause in the commit message
(next agent greps for it); if the fix is language/compiler-level, add a fixture
in `tests/`; regenerate `web/*-core.js` if a Genesis/NES `.milo` core changed
(deploys from the checked-in file); update PROGRESS.md status.
