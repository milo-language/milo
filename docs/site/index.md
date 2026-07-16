---
layout: home
hero:
  name: Milo
  text: "A memory-safe systems language."
  tagline: "Easy to use right, hard to use wrong. Simple syntax, simple mental model."
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

Milo is a systems language built on **second-class references** — the design [Rust's creator wanted and didn't get](https://github.com/cs01/milo/blob/main/docs/design.md#alignment-with-graydon-hoares-the-rust-i-wanted). A reference may appear only as a function parameter: never stored in a struct, never returned. That one restriction removes lifetimes, lifetime annotations, and the borrow-checker puzzles that come with them.

What's left is a **simpler Rust with contracts** — `requires` / `ensures` are part of the language, and an SMT prover discharges them across the codebase rather than trusting them. That combination is deliberately AI-friendly: a machine writing Milo gets loud compiler errors and machine-checked contracts instead of conventions it has to infer.

<CodeCarousel
  :titles="['Ownership', 'Concurrency', 'Contracts']"
  :subtitles="['One owner per value', 'Green tasks, no mutex', 'Proved before it runs']"
  :captions="[
    'Hand a value to someone else and you no longer have it. That one rule is where memory safety comes from — no lifetime annotations, no borrow-checker puzzles. The compiler catches the mistake at compile time, not at 3am.',
    'Two HTTP+TLS requests overlap instead of queueing. Promise.run starts a green task, not an OS thread, so thousands are cheap. There is no mutex because there is nothing to guard: each task owns its URL, and the same move rules that stop use-after-free stop data races. HTTP, TLS and the scheduler are all stdlib.',
    'requires and ensures are part of the language, and the SMT solver that discharges them is written in Milo. It proves clamp keeps its promise for every input that meets the precondition — not tested on a few. Pass constants that violate requires and the compiler rejects the call outright.',
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
    <h2>See what's shipping with Milo</h2>
    <p>Game-console emulators, CLI tools, high-performance servers — all written in Milo. The emulators below run right here in your browser: the same source compiles to a native binary <em>and</em> to this JavaScript, with identical output. No wasm, no rewrite.</p>
  </div>
  <div class="showcase-grid">
    <a class="app-card" href="/milo/nes/">
      <div class="app-emoji">🎮</div>
      <h3>NES</h3>
      <p>6502 CPU · PPU · APU — a complete Nintendo Entertainment System. Commercial and homebrew ROMs at 60&nbsp;fps with sound.</p>
      <span class="app-play">▶ Play in your browser</span>
    </a>
    <a class="app-card" href="/milo/genesis/">
      <div class="app-emoji">🕹️</div>
      <h3>Genesis</h3>
      <p>68000 + Z80 + VDP + YM2612 — a complete Sega Genesis / Mega&nbsp;Drive. Sonic, Golden Axe, and homebrew, with stereo sound.</p>
      <span class="app-play">▶ Play in your browser</span>
    </a>
  </div>
  <div class="showcase-cta">
    <a class="showcase-cta-btn" href="/milo/demos">Explore the full showcase →</a>
    <p class="showcase-cta-sub">SNES emulator · web + AI debugger · HTTP/TLS servers · terminal apps · the compiler itself</p>
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
