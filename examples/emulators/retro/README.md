# Milo Retro Console

A controller-driven front-end that turns the Milo NES / Genesis / SNES emulators
into a single couch console: boot → on-screen menu → pick a game with the gamepad
→ play → Start+Select back to the menu. Designed to run on a Raspberry Pi wired to
a TV, but it runs windowed on a dev machine too.

## Pieces

| File | Role |
|------|------|
| `build.sh` | Build `menu` + the three emulators into `bin/` (SDL2 auto-detected). |
| `launch.sh` | Main loop: run the menu, launch the picked emulator, return to the menu on exit. |
| `bin/menu` | Fullscreen SDL menu (see `examples/emulators/menu.milo`); prints `<system>\t<rompath>`. |
| `retro-console.service` | systemd unit to boot the Pi straight into the console (no desktop). |
| `pair-controller.sh` | One-time Bluetooth pairing helper (`pair` + `trust` so it auto-reconnects). |

The menu, font, and SDL glue live in `examples/emulators/menu.milo` and
`examples/emulators/shared/{menucore,font,sdl}.milo`. Emulators stay independent
binaries; the shell loop gives crash isolation — an emulator segfault drops back
to the menu instead of killing the console.

## ROM layout

Drop ROMs under `roms/` next to where you run `launch.sh`:

```
roms/nes/*.nes
roms/genesis/*.md .bin .gen .smd
roms/snes/*.sfc .smc
```

The menu lists them grouped by system, sorted, with the extension stripped and the
name upper-cased for readability. Missing/empty folders just show "(no ROMs)".

## Try it on a dev machine (macOS)

```sh
examples/emulators/retro/build.sh          # builds bin/ (emulators at --release)
examples/emulators/retro/launch.sh         # windowed
```

`RETRO_OPT=--debug build.sh` for a faster (slower-running) build.

## Controls

| | Keyboard | Controller |
|--|----------|------------|
| Menu move | ↑ / ↓ | D-pad |
| Menu select | Enter / Z / X | A |
| Menu quit | Esc | B / Back |
| In-game | per-emulator (see each app) | mapped to that system's pad |
| **Quit game → menu** | Enter+RShift (NES/SNES), Esc (Genesis) | **Start + Select held ~1s** |

Controller support uses SDL2's built-in GameController mapping DB, so most
Bluetooth pads (Xbox / PlayStation / 8BitDo) work with no config.

## Raspberry Pi (boot-to-console)

Tested target: Pi 4 / Pi 5, 64-bit Raspberry Pi OS. NES runs full speed on any
Pi; Genesis/SNES want a Pi 4/5.

1. **Deps + Bun (arm64):**
   ```sh
   sudo apt update && sudo apt install -y clang libsdl2-dev git
   curl -fsSL https://bun.sh/install | bash    # installs the arm64 Bun
   ```
2. **Get the code + build:**
   ```sh
   git clone <this-repo> ~/milo && cd ~/milo
   examples/emulators/retro/build.sh                 # bin/ built natively on the Pi
   ```
3. **Lay out the console dir** (`launch.sh` defaults `RETRO_HOME` to the repo
   root, so you can also just run from `~/milo`). For a clean `~/retro`:
   ```sh
   mkdir -p ~/retro && cp -r examples/emulators/retro/bin ~/retro/
   cp examples/emulators/retro/launch.sh ~/retro/
   mkdir -p ~/retro/roms/{nes,genesis,snes}     # copy your ROMs in
   ```
   Then set `WorkingDirectory=/home/pi/retro` in the service (already the default).
4. **Pair a controller:**
   ```sh
   examples/emulators/retro/pair-controller.sh
   ```
5. **Boot into it:** `sudo raspi-config` → System Options → Boot/Auto Login →
   **Console Autologin**. Then install the service:
   ```sh
   sudo cp examples/emulators/retro/retro-console.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now retro-console
   ```
   Reboot → the TV comes up straight in the menu. No desktop, no terminal.

## Tuning

- **Face-button mapping** (esp. Genesis A/B/C, SNES A/B/X/Y) is a sensible default
  in each emulator's input block — edit the `SDL_GameControllerGetButton` lines to
  taste.
- **Menu look** — colors, layout, and the 5×7 font live in
  `examples/emulators/shared/{menucore,font}.milo`.
- **Odd pad not recognized** — set `SDL_GAMECONTROLLERCONFIG` or drop a
  `gamecontrollerdb.txt` beside the binaries.
