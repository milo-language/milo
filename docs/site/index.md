---
layout: home
hero:
  name: Milo
  text: "A memory-safe systems language."
  tagline: "Intentionally simple, with formal verification built in. Friendly to humans and AI."
  image:
    src: /logo.svg
    alt: Milo
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/
    - theme: alt
      text: ▶ Play a demo
      link: /nes/
---

## What Milo is

Milo keeps ownership and drops the machinery: references exist only as function parameters — [the design Rust's creator wanted](https://github.com/cs01/milo/blob/main/docs/design.md#alignment-with-graydon-hoares-the-rust-i-wanted) — so there are no lifetimes and no borrow-checker puzzles. Contracts (`requires` / `ensures`) are part of the language, discharged by an SMT prover written in Milo itself.

<CodeCarousel
  :titles="['Ownership', 'Concurrency', 'Contracts']"
  :subtitles="['One owner per value', 'Green tasks, no mutex', 'Proved before it runs']"
  :captions="[
    'Hand a value to someone else and you no longer have it. That one rule is where memory safety comes from — no lifetime annotations, no borrow-checker puzzles. The compiler catches the mistake at compile time, not at 3am.',
    'Two HTTP+TLS requests overlap instead of queueing. Promise.run starts a green task, not an OS thread, so thousands are cheap. There is no mutex because there is nothing to guard: each task owns its URL, and the same move rules that stop use-after-free stop data races. HTTP, TLS and the scheduler are all stdlib.',
    'requires and ensures are part of the language, and the SMT solver that discharges them is written in Milo. It proves clamp keeps its promise for every input that meets the precondition — not tested on a few. The precondition is enforced too: constants that violate it are rejected at compile time, and debug builds assert it at every call. Release compiles the checks out.',
  ]"
>

```milo
fn main() {
    let name = "milo"
    let greeting = name   // `name` moves here — it is no longer yours

    print(greeting)       // "milo"
    print(name)           // error: use of moved variable 'name'
}
```

```milo
from "std/net" import { fetch }
from "std/runtime" import { Promise }

fn main() {
    // Two requests in flight at once. Each task owns its URL — nothing is
    // shared, so there is no mutex and no data race to get wrong.
    let a = Promise<i32>.run(() => fetch("https://example.com")!.status)
    let b = Promise<i32>.run(() => fetch("https://httpbin.org/get")!.status)

    print($"{a.await()!} {b.await()!}")   // 200 200
}
```

```milo
fn clamp(x: i64, lo: i64, hi: i64): i64
    requires lo <= hi                       // the caller's obligation
    ensures result >= lo && result <= hi    // proven, for every input that meets it
{
    if x < lo { return lo }
    if x > hi { return hi }
    return x
}
```

</CodeCarousel>

<div class="showcase">
  <div class="showcase-head">
    <h2>Built in Milo</h2>
    <p>We build the language by building things with it — we've found that faster than theory and analysis, and it yields a better language. The emulators run right here in your browser: the same Milo source compiles to a native binary <em>and</em> to JavaScript.</p>
  </div>
  <div class="tile-grid">
    <a class="tile" href="/milo/nes/">
      <span class="tile-play">▶ PLAY</span>
      <div class="tile-emoji">🎮</div>
      <h3>NES</h3>
      <p>Complete console — 6502, PPU, APU. 60 fps with sound.</p>
    </a>
    <a class="tile" href="/milo/genesis/">
      <span class="tile-play">▶ PLAY</span>
      <div class="tile-emoji">🕹️</div>
      <h3>Genesis</h3>
      <p>68000 + Z80 + VDP + FM synth. Sonic runs.</p>
    </a>
    <a class="tile" href="/milo/snes/">
      <span class="tile-play">▶ PLAY</span>
      <div class="tile-emoji">👾</div>
      <h3>SNES</h3>
      <p>65C816 + PPU + Super FX. Mario World, DKC, Star Fox.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/src-milo">
      <div class="tile-emoji">🪞</div>
      <h3>the compiler</h3>
      <p>Self-hosting — rebuilds itself byte-for-byte identical.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/milojs">
      <div class="tile-emoji">⚡</div>
      <h3>milojs</h3>
      <p>A JavaScript engine. Runs express.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/hades">
      <div class="tile-emoji">🐛</div>
      <h3>hades</h3>
      <p>Web + AI debugger for any DAP backend.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/weather">
      <div class="tile-emoji">🌦️</div>
      <h3>weather</h3>
      <p>weather.gov frontend from one static binary.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/termpair">
      <div class="tile-emoji">🖥️</div>
      <h3>termpair</h3>
      <p>Your terminal in a browser, end-to-end encrypted.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/tetris.milo">
      <div class="tile-emoji">🧱</div>
      <h3>tetris</h3>
      <p>Event-driven terminal tetris. One green task, no polling.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/sysmon.milo">
      <div class="tile-emoji">📊</div>
      <h3>sysmon</h3>
      <p>htop-style live system monitor.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/cli-tools/pkg.milo">
      <div class="tile-emoji">📦</div>
      <h3>pkg</h3>
      <p>Package manager — git transport, lockfile.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/tools/smtSolve.milo">
      <div class="tile-emoji">🧮</div>
      <h3>the prover</h3>
      <p>The SMT solver behind <code>milo prove</code>.</p>
    </a>
  </div>
  <div class="showcase-cta">
    <a class="showcase-cta-btn" href="/milo/demos">Explore the full showcase →</a>
  </div>
</div>

<div class="section-break"></div>

<div class="cta-section">

### Take Milo for a walk

<div class="cta-buttons">
  <a class="cta-primary" href="/milo/tour">Learn the basics · 11 lessons</a>
  <a class="cta-secondary" href="/milo/language/">Language overview</a>
  <a class="cta-secondary" href="/milo/stdlib/">Standard library</a>
  <a class="cta-secondary" href="/milo/playground">Playground</a>
  <a class="cta-secondary" href="/milo/getting-started/installation">Get Started</a>
  <a class="cta-secondary" href="https://github.com/cs01/milo">GitHub</a>
</div>

</div>
