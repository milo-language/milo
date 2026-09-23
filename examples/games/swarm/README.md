# SWARM (milestone 0: rendering spike)

The start of a twin-stick neon swarm shooter. This milestone only proves the
rendering stack: Milo drives SDL3's GPU API on Metal through FFI and draws a
swarm of instanced, additively blended glowing quads, one per particle, with
positions stepped on the CPU and uploaded every frame.

```bash
milo run examples/games/swarm/main.milo --release                          # window, fps once a second
milo run examples/games/swarm/main.milo --release -- --count 250000
milo run examples/games/swarm/main.milo --release -- --frames 600          # benchmark in the window
milo run examples/games/swarm/main.milo --release -- --offscreen --frames 600   # uncapped, no display
milo run examples/games/swarm/main.milo --release -- --shot m0.png         # headless PNG
milo run examples/games/swarm/main.milo --release -- --threads 8           # sim on 8 workers
```

`ESC`, `Q` or closing the window quits. Hold the left mouse button to drag a
gravity well. `--size` and `--gain` set quad size and brightness. Needs SDL3
(`brew install sdl3`); macOS only until the shaders exist as SPIR-V/DXIL.

| File | What |
|------|------|
| `sdl3.milo` | SDL3 core: init, window, events, mouse, timing |
| `gpu.milo` | SDL_GPU bindings plus a small safe layer (Device owns every resource; the game holds index handles) |
| `shaders.milo` | MSL source for the quad vertex and fragment shaders |
| `main.milo` | simulation, frame loop, benchmark and capture modes |

Every extern carries `@cSig`, every struct `@cLayout`, every constant `@cValue`,
so a binding that disagrees with the SDL headers fails the build.

## Measured

Apple Silicon, 10 cores, SDL 3.4.16, 1600x900 window at 2x (3200x1800 px),
600 frames each.

The window is capped at the 120 Hz display refresh even with the IMMEDIATE present
mode (macOS composites windowed apps), so it reads 120.0 fps up to about 250k. `--offscreen`
renders the same frame into a 3200x1800 texture with nothing waiting on the
display:

| particles | sim threads | frame avg | p99 | fps | CPU sim |
|---:|---:|---:|---:|---:|---:|
| 100k | 1 | 1.29 ms | 1.69 ms | 774 | 0.79 ms |
| 250k | 1 | 3.24 ms | 3.55 ms | 309 | 2.27 ms |
| 500k | 1 | 6.78 ms | 7.42 ms | 148 | 4.81 ms |
| 500k | 8 | 6.81 ms | 7.39 ms | 147 | 1.40 ms |
| 750k | 8 | 10.48 ms | 11.45 ms | 95 | 2.01 ms |
| 1M | 1 | 14.12 ms | 15.29 ms | 71 | 10.70 ms |
| 1M | 8 | 14.07 ms | 15.14 ms | 71 | 3.11 ms |

Frame time falls below 120 fps between 500k and 750k, and at that size it is the
GPU that limits it: spreading the simulation over 8 workers cuts CPU sim time
3.4x but leaves the frame time where it was. At 1M, shrinking the quads to almost
nothing (`--size 0.05`) still costs 5.7 ms a frame, so about 5 ms of the 14 ms is
per-vertex work (6 vertices per quad, each fetching its particle and computing a
hue), and the rest is blended fill. Uploading 16 MB a frame (the transfer-buffer
write) costs 0.6 ms at 1M.
