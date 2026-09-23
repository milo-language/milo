# SWARM

A twin-stick neon arena shooter in the Geometry Wars line: one ship, an arena
bigger than the screen, and enemies that arrive faster than you can shoot them.
Milo drives SDL3's GPU API on Metal through FFI: signed-distance shapes, a
spring-mass warp grid and compute-shader particles are drawn into an HDR target,
bloomed and tonemapped.

Milestone 1 made it playable: three enemy types, waves, bombs, scoring, a HUD, an
autopilot, headless capture and a benchmark. Milestone 2 (this) made it readable and
then made it glow:

- **Readability first.** A strict visual hierarchy (ship, then bullets, enemies,
  telegraphs, particles, grid), a camera zoomed to half the arena's width with a lead
  toward the aim, filled enemy silhouettes in one colour per type, a sparse opening
  that builds to a swarm, and edge arrows for packs closing in from off screen.
- **Light.** HDR scene, a six-level bloom chain, ACES tonemap, vignette, grain, and a
  flash and chromatic-aberration pulse on bombs and deaths.
- **A world that reacts.** A 101x57 spring-mass grid that shockwaves ripple through.
- **GPU particles.** Up to a million, emitted and integrated by compute shaders and
  drawn straight from the storage buffer.

```bash
milo run examples/games/swarm/main.milo --release                    # play
milo run examples/games/swarm/main.milo --release -- --bot           # watch the autopilot
milo run examples/games/swarm/main.milo --release -- --shot a.png --ticks 9000
milo run examples/games/swarm/main.milo --release -- --clip f --from 7040 --to 8120
milo run examples/games/swarm/main.milo --release -- --bench --enemies 10000
milo run examples/games/swarm/main.milo --release -- --bench --enemies 100 --particles 500000
```

**Keyboard and mouse:** WASD or arrows move, the mouse aims, the gun fires by itself,
Space bombs, Esc pauses (and quits from the game-over screen), Q quits.
**Gamepad:** left stick moves, right stick aims and fires, a shoulder button, B or the
right trigger bombs, A or Start restarts after a game over. Whichever of mouse and
right stick moved last does the aiming.

Needs SDL3 (`brew install sdl3`); macOS only until the shaders exist as SPIR-V/DXIL.

## The game

- **Arena** 2400x1350 units, seen 1200x675 at a time (half its width); the camera
  follows the ship with smoothing, leads a little toward where it is aiming, and may
  run 90 units past a wall. Packs of chasers closing in from off screen show as
  arrows on the screen edge.
- **Ship** accelerates and damps rather than snapping to a velocity. Two parallel
  streams, 12 volleys a second. Three lives, three bombs per life. A bomb is a
  shockwave that sweeps out to 900 units killing everything it passes (no points);
  another cannot be set off until it has finished. Dying clears everything within
  650 units; respawning clears 420 more and gives two seconds of blinking
  invulnerability.
- **Enemies**, each a filled silhouette in its own colour:
  - *Wanderer* (violet square with a counter-spinning cut-out): drifts on a lazy
    weave, bounces off walls.
  - *Seeker* (cyan dart, pointed where it is going): accelerates at you with a
    limited turn rate, so a hard strafe gets you past one.
  - *Splitter* (rose triangle, three hits): slow; dies into three fast red-orange
    seekers.
- **Spawning**: every enemy is telegraphed for 0.6 s by a flickering ring, in or near
  the view but never within 280 units of the ship. The rate climbs continuously
  (1.5 a second at the start, 7 at one minute, 17 at two) under a cap on how many are
  alive (25, rising to 300 over three minutes), packs of 4-6 appear at one spot after
  25 s, and from 40 s on, every 17-24 s, a **swarm** rings the ship with 26-60
  seekers, telegraphed for a full second. The autopilot usually lasts about three
  minutes.
- **Scoring**: 25/50/100 points per kill times the multiplier, which rises one step per
  20 kills in a row and starts draining 1.5 s after the last kill (the bar under it).

## Headless modes

All three run the autopilot into an offscreen texture, with no window:

| flag | what |
|------|------|
| `--shot out.png --ticks N` | play N ticks (120 per second), write the last frame |
| `--clip prefix --from A --to B` | write `prefix-00000.png`... for every other tick in [A, B]: 60 fps video |
| `--bench --enemies N` | keep N enemies alive for 1200 ticks, the ship invulnerable; print sim and render times |
| `--bench ... --particles N` | also keep N immortal particles in flight |

Particles live on the GPU and move only when a frame is rendered, so `--shot` and
`--clip` also render (without saving) the 2 s before their first saved frame.

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
| `world.milo` | the simulation: ship, enemies in an `Arena<Enemy>`, spatial hash, bullets, particle bursts, scoring, spawn director |
| `grid.milo` | the warp grid: a linearised spring-mass lattice stepped with the World |
| `bot.milo` | the autopilot: steers for the least crowded nearby spot, tracks one target by handle, bombs when boxed in |
| `input.milo` | keyboard, mouse and gamepad to the World's `Input` |
| `draw.milo` | World to instance lists (the ship in its own, drawn last), threat arrows, and the HUD (5x7 font drawn as filled boxes) |
| `render.milo` | every GPU resource and the passes of a frame: upload, particle compute, HDR scene, bloom, composite |
| `shaders.milo` | MSL: the shape pipeline (filled SDF silhouettes with a hot rim), the grid, the particle kernels and streaks, and the spike's shaders |
| `postfx.milo` | MSL: the bloom chain's filters and the composite (tonemap, vignette, flash, aberration, grain) |
| `gpu.milo` | SDL_GPU bindings (graphics and compute) plus a small safe layer (Device owns every resource; the game holds index handles) |
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
| 10k | 0.79 ms | 0.93 ms | 1.7 ms | 4.4 ms |
| 50k | 6.0 ms | 6.9 ms | 1.1 ms | 14.2 ms |

The simulation budget at 120 Hz is 8.3 ms; 10k enemies use a tenth of it, and the
warp grid's step is 0.02-0.03 ms of every tick. Render time is CPU build + upload +
submit, paced two frames deep, so once the GPU is the bottleneck it shows up here.
The HDR target, particles and bloom chain cost about 1 ms at 1600x900 whatever is on
screen. At 50k enemies and Retina resolution the GPU is filling tens of thousands of
overlapping filled silhouettes: 14.2 ms, against 20.6 ms for milestone 1's outline
quads measured on the same machine at the same time (its glow quads were 12 units
wider on every side, and each enemy was two of them). A real game has at most 300
alive.

Particles (`--bench --enemies 100 --particles N`: immortal, no drag, bouncing around
the arena, so most of them stay in flight and many on screen):

| particles | frame at 1600x900 | frame at 3200x1800 |
|---:|---:|---:|
| 250k | 1.4 ms | |
| 1M (the ring's capacity) | 6.5 ms | 9.1 ms |

A million particles hold 120 fps at 1600x900; the frame is GPU time for the two
compute kernels and a million 4-vertex streaks read straight from the storage buffer.

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
