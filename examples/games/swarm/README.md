# SWARM

A twin-stick neon arena shooter in the Geometry Wars line: one ship, an arena
bigger than the screen, and enemies that arrive faster than you can shoot them.
Milo drives SDL3's GPU API on Metal through FFI; everything on screen is one
instanced draw of signed-distance shapes, additively blended.

Milestone 1 (this): a playable game with three enemy types, waves, bombs, scoring, a
HUD, an autopilot, headless capture and a benchmark. Bloom, HDR, a warping grid and GPU
particles come next.

```bash
milo run examples/games/swarm/main.milo --release                    # play
milo run examples/games/swarm/main.milo --release -- --bot           # watch the autopilot
milo run examples/games/swarm/main.milo --release -- --shot a.png --ticks 9000
milo run examples/games/swarm/main.milo --release -- --clip f --from 9120 --to 10080
milo run examples/games/swarm/main.milo --release -- --bench --enemies 10000
```

**Keyboard and mouse:** WASD or arrows move, the mouse aims, the gun fires by itself,
Space bombs, Esc pauses (and quits from the game-over screen), Q quits.
**Gamepad:** left stick moves, right stick aims and fires, a shoulder button, B or the
right trigger bombs, A or Start restarts after a game over. Whichever of mouse and
right stick moved last does the aiming.

Needs SDL3 (`brew install sdl3`); macOS only until the shaders exist as SPIR-V/DXIL.

## The game

- **Arena** 2400x1350 units, seen through a 1600x900 window; the camera follows the
  ship with smoothing and a little look-ahead, and may run 90 units past a wall.
- **Ship** accelerates and damps rather than snapping to a velocity. Two parallel
  streams, 12 volleys a second. Three lives, three bombs per life. A bomb is a
  shockwave that sweeps out to 900 units killing everything it passes (no points).
  Dying clears everything within 650 units; respawning clears 420 more and gives two
  seconds of blinking invulnerability.
- **Enemies**, each with its own shape and colour:
  - *Wanderer* (violet spinning square): drifts on a lazy weave, bounces off walls.
  - *Seeker* (cyan diamond, pointed where it is going): accelerates at you with a
    limited turn rate, so a hard strafe gets you past one.
  - *Splitter* (pink triangle, three hits): slow; dies into three fast orange seekers.
- **Spawning**: every enemy is telegraphed for 0.6 s by a flickering ring, never
  within 280 units of the ship. The rate climbs continuously (about 3 a second at
  the start, 15 at one minute, 34 at two), packs of 4-6 appear at one spot, and every
  17-26 s a **swarm** rings the ship with 30-80 seekers, telegraphed for a full second.
  It gets hard around two minutes; the autopilot usually lasts about 120 s.
- **Scoring**: 25/50/100 points per kill times the multiplier, which rises one step per
  20 kills in a row and starts draining 1.5 s after the last kill (the bar under it).

## Headless modes

All three run the autopilot into an offscreen texture, with no window:

| flag | what |
|------|------|
| `--shot out.png --ticks N` | play N ticks (120 per second), write the last frame |
| `--clip prefix --from A --to B` | write `prefix-00000.png`... for every other tick in [A, B]: 60 fps video |
| `--bench --enemies N` | keep N enemies alive for 1200 ticks, the ship invulnerable; print sim and render times |

`--seed N` changes the run; the same seed replays bit-identically (the simulation is
fixed-step and its RNG seeded). `--scale S` renders at S times 1600x900. `--seconds S`
quits the window after S seconds.

```bash
ffmpeg -framerate 60 -i f-%05d.png -vf scale=960:-2 -c:v libx264 -pix_fmt yuv420p -crf 22 swarm.mp4
```

## Files

| File | What |
|------|------|
| `main.milo` | flags, the window loop (fixed 120 Hz steps, render the latest state), headless capture and benchmark |
| `world.milo` | the simulation: ship, enemies in an `Arena<Enemy>`, spatial hash, bullets, sparks, scoring, spawn director |
| `bot.milo` | the autopilot: steers for the least crowded nearby spot, tracks one target by handle, bombs when boxed in |
| `input.milo` | keyboard, mouse and gamepad to the World's `Input` |
| `draw.milo` | World to instance list, and the HUD (5x7 font drawn as filled boxes) |
| `shaders.milo` | MSL: the shape pipeline (SDF outlines with a hot core and glow), and the spike's particle shaders |
| `gpu.milo` | SDL_GPU bindings plus a small safe layer (Device owns every resource; the game holds index handles) |
| `sdl3.milo` | SDL3 core: init, window, events, keyboard, mouse, gamepad, timing |
| `font.milo` | the 5x7 bitmap font |
| `spike.milo` | milestone 0's renderer stress test: up to 1M instanced particles |

Every extern carries `@cSig`, every struct `@cLayout`, every constant `@cValue`, so a
binding that disagrees with the SDL headers fails the build.

## Measured

Apple Silicon, 10 cores, SDL 3.4.16, single-threaded simulation, `--bench` (1200 ticks,
the ship invulnerable, enemies topped back up as they die, a render every other tick):

| enemies | sim tick avg | p99 | render at 1600x900 | render at 3200x1800 |
|---:|---:|---:|---:|---:|
| 1k | 0.05 ms | 0.09 ms | 0.17 ms | |
| 10k | 0.86 ms | 1.05 ms | 0.19 ms | 3.8 ms |
| 50k | 4.9 ms | 6.2 ms | 0.75 ms | 18.2 ms |

The simulation budget at 120 Hz is 8.3 ms; 10k enemies use a tenth of it. Render time
is CPU build + upload + submit, paced two frames deep, so once the GPU is the
bottleneck (50k at Retina resolution: tens of thousands of overlapping glow quads) it
shows up here. An actual game peaks at a few hundred enemies.

### The spike (milestone 0)

`spike.milo` is the renderer on its own: a swarm of particles falls through wandering
gravity wells, each particle one instanced, additively blended quad.

```bash
milo run examples/games/swarm/spike.milo --release -- --count 250000
milo run examples/games/swarm/spike.milo --release -- --offscreen --frames 600   # uncapped, no display
milo run examples/games/swarm/spike.milo --release -- --threads 8                # sim on 8 workers
```

Offscreen at 3200x1800, 600 frames each:

| particles | sim threads | frame avg | p99 | fps | CPU sim |
|---:|---:|---:|---:|---:|---:|
| 100k | 1 | 1.29 ms | 1.69 ms | 774 | 0.79 ms |
| 250k | 1 | 3.24 ms | 3.55 ms | 309 | 2.27 ms |
| 500k | 1 | 6.78 ms | 7.42 ms | 148 | 4.81 ms |
| 500k | 8 | 6.81 ms | 7.39 ms | 147 | 1.40 ms |
| 750k | 8 | 10.48 ms | 11.45 ms | 95 | 2.01 ms |
| 1M | 1 | 14.12 ms | 15.29 ms | 71 | 10.70 ms |
| 1M | 8 | 14.07 ms | 15.14 ms | 71 | 3.11 ms |

Past 500k the GPU limits it: 8 sim workers cut CPU time 3.4x and leave the frame time
where it was.
