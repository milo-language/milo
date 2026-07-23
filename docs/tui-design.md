<!-- doc-meta
system: stdlib-design
purpose: design + scope for std/tui — a reactive terminal-UI framework (Ink-style DX on a ratatui-style engine)
key-files: std/tui.milo (planned), std/unicode.milo, std/ansi.milo, std/event.darwin.milo, src/lexer.ts, src/parser.ts
update-when: a phase lands, a design decision changes, or a fence is revised
last-verified: 2026-07-22
status: phase 0 SHIPPED (stdlib substrate, standalone value). Phases 1-6 SHELVED —
  not in docs/backlog.md; framework is speculative vs Tier 2 work. Resume only on
  a concrete need (or as a showcase demo, decided on those grounds).
-->

# std/tui — reactive terminal UI

React/Ink developer experience — JSX, function components, `useState` hooks,
unidirectional data flow — on a ratatui-style engine: immediate-mode rebuild each
frame, flexbox layout, **cell-level** double-buffer diff, minimal ANSI writes.

The bet: give the declarative ergonomics people want, without a retained mutable
widget tree. Milo has no GC and move semantics; a persistent reconciler (Ink) or a
signal graph (Solid) both fight the checker. Rebuilding the tree from owned data
every frame sidesteps reconciliation *and* the "can't clone a `Vec<interface>`"
limits — the tree is never retained, only its state is.

The declarative surface is a **builder API** (`Box.column().child(...)`), not JSX.
Milo has no macro system, so JSX would be permanent lexer/parser/formatter/LSP
weight in the compiler — unlike Rust, where JSX-like DSLs (`html!`/`view!`/`rsx!`)
are opt-in proc-macro *crates* with zero language cost. Builder-first keeps the
engine identical and leaves typed JSX as a purely additive sugar layer that
desugars to these same builder calls — added later only if it earns its weight,
removable if it doesn't.

## Prior art surveyed

| System | Model | Lesson taken |
|---|---|---|
| ratatui (Rust) | immediate-mode API over a double-buffered **cell** diff; events out of scope | the engine — `Cell`/`Buffer` grid + `diff_iter` + dumb `draw(diff)` backend |
| codex (ratatui) | central `App` + one `AppEvent` enum + `tokio::select`; `FrameRequester` coalesces invalidations → one repaint | **explicit invalidation, not redraw-every-tick** — the load-bearing trick |
| Ink (React/JS) | react-reconciler → own DOM → Yoga flexbox → cell grid → erase-lines/redraw; hooks | the **DX**: `<Box>/<Text>`, `useInput/useFocus`, the tiny node model |
| opencode (Solid/OpenTUI) | fine-grained signals → retained scene graph, no diff | least code, most perf — but hardest teardown w/o GC. **v2, not v1.** |

## Architecture

```
component fn tree ──rebuild each frame──► Element tree ──flex solve──► Rect per node
     ▲                                                                      │
     │ hooks read/write                                              paint into
   hook slot table (arena, keyed by tree path)                       Cell grid (back buffer)
     ▲                                                                      │
   setState → mark dirty → FrameRequester (coalesced)          diff(front,back) → minimal ANSI → tty
```

- **Immediate-mode**: on each frame every component fn re-runs and returns a fresh
  `Element` built from owned data. No node is retained across frames.
- **Hooks persist, tree doesn't**: state lives in a slot table backed by `Arena<T>`,
  keyed by the component's path in the tree (React rules-of-hooks: call order stable).
  `useState` returns `(value, setState)`; `setState` marks dirty and schedules a frame.
- **Cell diff** (better than Ink's line-diff): keep two `Buffer`s, diff changed cells,
  emit the minimal cursor-move + SGR + text run. Port of ratatui `buffer/diff.rs`.
- **Invalidation, not polling**: a `FrameRequester` coalesces many `setState`s +
  input + SIGWINCH into one repaint, FPS-capped. Idle = zero redraws.
- **Events integrated** (unlike ratatui): stdin fd + SIGWINCH self-pipe + timers all
  registered on the existing `std/event` kqueue/epoll loop; decoded keys dispatched to
  `useInput` handlers before the next frame.

### Core types (sketch)

```
struct Cell   { ch: string, fg: Color, bg: Color, mod: Modifier, width: u8 }  // width 1|2 for CJK/emoji
struct Buffer { area: Rect, cells: Vec<Cell> }                                 // row-major, len = w*h
enum Element  { Box(BoxProps, Vec<Element>), Text(TextProps, string), Fragment(Vec<Element>) }
struct Rect   { x: u16, y: u16, w: u16, h: u16 }
```

`Element` is a closed enum (not an interface) — exhaustive `match` in the layout +
paint walk, no dynamic-dispatch clone limits. User components are plain functions
`fn Counter(props: P) -> Element`, not trait impls.

### Hook identity & lifecycle — the crux

This is the one design detail that sinks naive React-on-immediate-mode ports. React
keys hooks by `(fiber, call-index)`; there is no fiber here — the tree is rebuilt every
frame. Identity must come from **position**.

- As the runtime executes component fns top-down it maintains a **render cursor**: the
  path of child-indices from root to the current component, plus a per-component hook
  counter reset on entry. A hook's slot key = `parent_path ++ [key_or_index] ++ hook_i`.
- Structure is stable frame-to-frame (same components, same positions) → path is stable
  → state persists. When children are conditional or reordered, the caller supplies a
  **`key`** (React's escape hatch); the slot key uses it instead of the positional index
  so identity survives reorder.
- Slots live in `Arena<Slot>`; a `HashMap<Path, Handle>` maps keys → arena handles. Each
  frame marks visited paths; after commit, **unvisited slots are freed** (arena drop) and
  their `useEffect` cleanups run — that is unmount. This is the GC the no-GC language
  needs: bounded, deterministic, frame-scoped, no cycles.
- `useEffect(fn, deps)`: after commit, compare `deps` to the slot's previous deps; run
  cleanup-then-fn on change or first mount; run cleanup alone on unmount.
- **Rules of hooks apply** (stable call order, no hooks in conditionals) for the same
  reason as React — the hook counter must line up frame to frame. The checker can't
  enforce this in v1; document it, lint it later.

## Milo readiness (from audit)

**Already there:** `interface` dynamic dispatch, enums-with-methods, `move`-closures
storable in structs (event handlers/hooks), `Arena<T>` + generational `Handle<T>`
(hook slot store, UAF-detecting), kqueue/epoll event loop, non-blocking raw-mode
stdin (VMIN=0), SIGWINCH self-pipe, truecolor ANSI + alloc-free push primitives.

**Gaps that block correctness — must build:**

| Gap | Impact | Where |
|---|---|---|
| No `wcwidth` / display-width + grapheme segmentation | CJK/emoji/combining lay out in wrong columns | `std/unicode` — width table + grapheme rules |
| No keyboard decoder | `readKey()` = 7 keys total; `useInput` needs full key+modifier events | new; Ink `parse-keypress.ts` is the reference |

**Trivial stdlib adds:** alt-screen + cursor save/restore + relative cursor moves
(`std/ansi`), `terminalSize()` via `ioctl(0, TIOCGWINSZ)` (pattern already in
`std/pty`), mouse SGR-1006 (deferred).

## Builder API (the declarative surface) — and JSX later

The stable, always-usable surface is a fluent builder:

```
Box.column().pad(1).child(
  Text("count: " + n.str()).bold().fg(Color.Cyan))
```

Zero compiler change, precedent in the stdlib JSON builder (chained `MethodCall`).
This is what components return and what everything below consumes.

**JSX is deferred, and additive.** How the ecosystems compare:

| | JSX weight lives in | Language cost |
|---|---|---|
| JS/TS | Babel/tsc/swc transform (build tool) | none — pure transpile |
| Rust (yew/leptos/dioxus/topcoat) | opt-in proc-macro **crate** (`html!`/`view!`/`rsx!`) | none — grammar untouched |
| Milo | would be a **lexer/parser extension** (no macro system exists) | **permanent** — parser+formatter+LSP forever |

So JSX in Milo can't be a library the way it is in Rust; it's language weight or
nothing. Decision: **builder-first.** If typed JSX is added later it is a syntax
extension that desugars `<Box p={1}><Text bold>hi</Text></Box>` → the builder calls
above — inherently type-checked against prop types (TSX semantics by construction,
no `.jsx`/`.tsx` split). Added only if it earns the weight against principle #3
("the language stays small, no metaprogramming"); removable if not.

## Public API sketch

The surface a v1 app touches. Names provisional; shapes are the contract the phases build to.

```
// --- app entry -------------------------------------------------------------
fn render(root: fn() -> Element) -> Result<(), TuiError>   // takes over tty, runs the loop, restores on exit
fn useApp() -> App                                          // App.exit(), App.stdout
fn useSize() -> Size                                        // current terminal cols/rows, re-renders on SIGWINCH

// --- state hooks -----------------------------------------------------------
fn useState<T>(initial: T) -> (T, fn(T) -> void)           // setter marks dirty → coalesced frame
fn useEffect(effect: fn() -> (fn() -> void), deps: Vec<Dep>) // effect returns its cleanup
fn useMemo<T>(compute: fn() -> T, deps: Vec<Dep>) -> T
fn useRef<T>(initial: T) -> Ref<T>                          // mutable, stable across frames, no re-render

// --- input & focus ---------------------------------------------------------
fn useInput(handler: fn(Key) -> void)                      // called for each decoded key while mounted
fn useFocus(opts: FocusOpts) -> Focus                      // { isFocused }, joins Tab ring
fn useFocusManager() -> FocusManager                       // focusNext/Prev/focus(id)

struct Key { name: string, ch: string, ctrl: bool, alt: bool, shift: bool }  // name: "up","enter","tab","a",…

// --- builder (what components return) --------------------------------------
Box.row() | Box.column()          // → Box builder
  .grow(n) .shrink(n) .basis(n) .width(w) .height(h)   // w/h: Fixed(u16) | Pct(u8) | Auto
  .pad(n) .padX(n) .padY(n) .margin(n) .gap(n)
  .align(Align) .justify(Justify) .wrap(bool)
  .border(Border) .bg(Color)
  .child(Element) .children(Vec<Element>)

Text(s: string)
  .fg(Color) .bg(Color) .bold() .dim() .italic() .underline() .strike() .wrap(Wrap)

Spacer()  Newline(n)  Fragment(Vec<Element>)
Static(items: Vec<T>, render: fn(T) -> Element)   // written once above the live region, never re-erased
```

### Worked example (target ergonomics)

```
fn Counter() -> Element {
  let (n, setN) = useState(0)
  let app = useApp()
  useInput(|k| {
    if k.name == "up"   { setN(n + 1) }
    if k.name == "down" { setN(n - 1) }
    if k.name == "q"    { app.exit() }
  })
  return Box.column().pad(1).border(Border.Round).child(
    Text("count: " + n.str()).bold().fg(Color.Cyan)
  )
}

fn main() -> void { render(Counter) }
```

## Layout

Not Yoga, not cassowary. A **compact flexbox subset** (~few hundred lines): direction
(row/column), grow/shrink/basis, fixed + percent sizes, padding/margin/gap, wrap,
align/justify → one `Rect` per node. Isolated behind `solve(Element, Rect) -> layout`
so it can be swapped for a fuller engine later (ratatui proves this boundary is clean).

## Phases

Each phase is independently testable; `TestBackend` (in-memory, no TTY) makes the
whole pipeline headless-assertable — build it first in phase 1 so 2–4 are TDD'd against
`tests/fixtures` with zero TTY. Effort is rough, one focused engineer.

| # | Phase | Deliverable | Test gate | Effort |
|---|---|---|---|---|
| 0 | **Substrate — DONE** | ✅ `charWidth`/`displayWidth`/`truncateToWidth` in `std/unicode` (grapheme-aware: ZWJ, flags, skin tones, VS15/16); ✅ `std/keys` decoder → `Key`/`KeyCode` (CSI/SS3, modifiers, F-keys, bracketed paste, incremental `Partial`); ✅ alt-screen/save-restore/relative-move/paste in `std/ansi`; ✅ `terminalSize()` in `std/term.{darwin,linux}`; ✅ SIGWINCH→resize **already existed** (`installSignalPipe`, used by tmuxClone/splitPty) | ✅ `unicodeDisplayWidth.milo` (17 assertions), `keysDecode.milo` (29 golden sequences), `termSize.milo` | done |
| 1 | Engine | `Cell`/`Buffer` grid; cell-diff (port `buffer/diff.rs`, incl. wide-char trailing-cell clears); minimal-ANSI writer; `TestBackend` | assert diff emits minimal ops; wide-glyph shrink clears trailing cell; full frame round-trips through `TestBackend` | 4–6 d |
| 2 | Layout | compact flexbox solver → `Rect` per node | fixture layouts vs expected `Rect`s (row/column, grow/shrink, pct, pad/margin/gap, wrap, align/justify) | 4–6 d |
| 3 | Runtime | `Element` enum; component fns; arena hook table + path-keyed identity; `useState/useEffect/useMemo/useRef`; `FrameRequester` coalescing loop; `useInput/useFocus/useApp/useSize` | hook state persists across frames; reorder w/ `key` preserves state; unvisited slot frees + runs cleanup; effect deps gate re-run; setState coalesces to one repaint | 5–8 d |
| 4 | Builder + widgets | fluent builder surface; Box, Text, Newline, Spacer, Static, Fragment + List, Table, Gauge, Border, Scrollbar | each widget renders to expected `Buffer` via `TestBackend`; `Static` region grows without re-erasing committed rows | 5–8 d |
| 5 | Examples | the three apps below, in `examples/apps/` | run as integration smoke tests; snapshot final `Buffer`; scripted-input drives + asserts | 4–6 d |
| 6 | JSX *(deferred, optional)* | lexer/parser extension desugaring to phase-4 builder + **formatter + LSP + grammar.ebnf + language-reference** (definition-of-done) | round-trip fmt; desugar equivalence vs builder; LSP hover/complete on elements | only if builder DX asks for it |

Total v1 (phases 0–5): **~4–6 wks**. Phase 6 is separate and gated on wanting the sugar.

**Examples (phase 5):**
- **counter / todo** — hooks + input + minimal layout (the smoke test for the whole loop)
- **process monitor / file browser** — scrollable lists, flex, keyboard nav, live refresh + resize
- **streaming chat (codex-like)** — async subprocess output, `Static` scrollback, spinner, input composer

## Migrating existing apps (validation, not rewrite)

The repo already has ~10 terminal apps that hand-roll raw-mode + 7-key `readKey` +
manual `cursorTo` with **no diff** (tetris redraws the whole screen each frame). They
split by which tier they need — this is the layered design's proof:

| App(s) | Tier to adopt | Why |
|---|---|---|
| tetris, aquarium, plasma, donut, cloth, physics, chihuahua | **engine only** (`Buffer` + cell-diff + key decoder) — draw cells directly, no components | game loop plots cells per-tick; hooks/flex are the wrong tool. Wins: flicker-free diff + real keyboard |
| sysmon, menu | **full framework** (hooks + widgets) | panels/gauges/tables/list-select on a timer = exactly `useState`+`<Gauge>/<Table>/<List>`+`useFocus` |

Fold these in as the real integration tests: **tetris → phase 1 engine gate**
(flicker-free, byte-diff correct under a moving piece), **sysmon → phase 4 widget gate**.
They replace/augment the greenfield phase-5 examples with battle-tested workloads.

## Resolved decisions

- **Name.** Module stays `std/tui`. Working name **Loom** (weaves a grid of cells;
  unidirectional threads) — or `vellum` / `glyph` as alternates. Non-blocking; user's
  call, can be renamed anytime before phase 5.
- **Focus/Tab.** Ship Ink's `useFocus`/`useFocusManager` ring (Tab/Shift-Tab cycles
  registered focusables; explicit `focus(id)`). Simple enough; no reason to invent a
  different scheme.
- **`Static` scrollback.** The diff renderer treats the static region as committed rows
  *above* the live region: written once, never re-diffed, live region redraws below it.
  On growth, append new static rows and shift the live-region origin down — a full
  `clearTerminal` only when the terminal scrolls the static region off (Ink's
  `shouldClearTerminalForFrame`). Tested in phase 4.

## Open

- **v2 (post-ship):** fine-grained signals as an opt-in perf path once immediate-mode is
  proven; mouse (SGR-1006); a hooks-rules linter in the checker.
