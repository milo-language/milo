# Worksheet: APSIS — interplanetary orbital mechanics game

- **Slug / tag:** `ws/apsis-game`
- **Started:** 2026-08-01
- **Status:** in-progress
- **Related:** `examples/games/flight` (renderer reused), `examples/games/apsis/README.md`

## Goal

A playable campaign game at `examples/games/apsis/`: plan and fly interplanetary
transfers under real Newtonian gravity, seven missions, arrival = stable capture
orbit. Ships as a binary the user can run. Planets are real NASA/USGS imagery.

Done = `milo build examples/games/apsis/main.milo -o /tmp/apsis --release` produces
a binary that plays all seven missions, and the physics is verified against JPL
Horizons state vectors as test fixtures.

## Plan

**M1 — physics, headless.** `ephem.milo` (Standish approximate elements),
`nbody.milo` (RK4 + adaptive step), `lambert.milo` (universal variable).
Verify: `tests/fixtures/` style `@expect` probes + a Horizons comparison harness.

**M2 — renderer.** Copy flight's `gfx.milo` / `gfx3d.milo` / `raster.milo` /
`font.milo`. Add `sphere.milo` (UV sphere, gouraud-lit, textured) and
camera-relative log-zoom. Verify: screenshot a static solar system.

**M3 — maneuver node + live prediction.** The core loop. Drag prograde/radial/
normal handles, ghost trajectory re-integrates live.

**M4 — porkchop screen.** Lambert over a departure-date × flight-time grid,
rendered as a heat map. Click = commit that transfer to the node.

**M5 — capture detection, missions, campaign flow, HUD.**

**M6 — `tools/fetchbody.milo`**, rings, Earth night lights, sound, README.

## Current state

Research done. Renderer API confirmed reusable. Imagery verified. Starting M1.

## Log

- 2026-08-01 22:15 — surveyed `examples/games/*`; flight's rasteriser
  (`triangleV`: textured, gouraud `light` + per-vertex tint, threaded by band) is
  a direct fit for lit textured spheres. Convention is per-game copies of
  `gfx/sdl/font`, so copy rather than factor out.
- 2026-08-01 22:30 — imagery verified, all PNG, no new decoder needed.

## Decisions

- **Planets on rails, ship on n-body.** Planet positions come from analytic
  Kepler elements; the ship integrates under every body's gravity. Full n-body
  for planets makes a 3-year prediction non-reproducible (chaos), which silently
  rots the player's plan. This is what real mission design does.
- **Prediction IS the integrator.** The drawn trajectory is the same code path
  that gets flown, so there are no patched-conic seams and no "it looked
  different when I got there". Gravity assists and free returns emerge rather
  than being scripted.
- **Ephemeris sampled + Hermite-interpolated**, not solved per step. A 2-year
  prediction at dt≈1000 s is ~63k steps × 4 RK4 stages × ~10 bodies = 2.5M Kepler
  solves otherwise. Sample once per mission on a 6 h grid, interpolate.
- **No `std/jpeg`, no ffmpeg.** USGS `planetarymaps.usgs.gov` WMS serves
  `image/png` and resamples server-side. ffmpeg would also have made the asset
  pipeline unrebuildable in CI, where flight's is pure Milo.
- **Arrival = capture orbit, no landing.** Landing roughly doubles the work
  (descent guidance, surface rendering, touchdown) and teaches nothing the
  transfer didn't.

### Imagery sources (all public domain, verified 2026-08-01)

`STYLES=` must be present but empty — MapServer 8 rejects the request without it.
The Moon lives under `/maps/earth/`, not `/maps/moon/`.

| Body | Endpoint | Layer |
|---|---|---|
| Mercury | `planetarymaps.usgs.gov` `/maps/mercury/mercury_simp_cyl.map` | `MESSENGER_Color` |
| Venus | `/maps/venus/venus_simp_cyl.map` | `MAGELLAN_color` |
| Earth | `gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi` | `BlueMarble_ShadedRelief_Bathymetry` |
| Moon | `/maps/earth/moon_simp_cyl.map` | `LROC_WAC` |
| Mars | `/maps/mars/mars_simp_cyl.map` | `MDIM21_color` |
| Jupiter | `/maps/jupiter/jupiter_simp_cyl.map` | `CASSINI` |
| Saturn | `/maps/saturn/saturn_simp_cyl.map` | `CASSINI` |

Jupiter/Saturn Cassini mosaics wash out past ~±60° latitude — the probes never
imaged the poles at that resolution. Acceptable; the pole cap of a UV sphere is
a few percent of screen area at any useful zoom.

## Blockers / open questions

- None.

## Verification

- [ ] M1 physics vs JPL Horizons state vectors
- [ ] targeted tests:
- [ ] ran the app / fixture:
- [ ] full `bun test`:
- [ ] agent review:
- [ ] docs updated (last-verified bumped):
