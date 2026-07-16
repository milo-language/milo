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

Milo is a small systems language built on one idea: **memory safety you can hold in your head.** It keeps ownership — single owner, move semantics, borrowed references — and drops the machinery that makes ownership hard: no lifetime annotations, no borrow-checker puzzles, no `unsafe` in everyday code. The rules are few and the errors are loud.

> When you hand a value to someone else, you don't have it anymore. That's it. The compiler enforces this rule, and from it you get memory safety, no dangling pointers, and no data races — all at zero runtime cost.

Because ownership is explicit, code that compiles already has a predictable structure: one owner per value, data flowing one direction, no hidden shared state. Compiler errors usually point at a real design problem, and fixing one tends to make the code more readable.

The mission: prove that safe systems programming doesn't require a complex language. **The proof is shipped software, not theory.** Every feature earns its place by being used in real programs:

- **Three game-console emulators** (NES, Genesis, SNES) — the same Milo source runs native with SDL and [in your browser](/demos) as compiled JavaScript.
- **A self-hosting compiler** — Milo is written in Milo and [reproduces itself byte-for-byte](https://github.com/cs01/milo/blob/main/docs/self-hosting.md).
- **A standard library** with HTTP, TLS, JSON, SQLite, PTYs, and green-thread concurrency — used by dozens of [terminal apps and CLI tools](/demos), and a [package manager](https://github.com/cs01/milo/blob/main/examples/cli-tools/pkg.milo) written in Milo.
- **A contract prover, used for real** — `requires` / `ensures` / `invariant` are language features, and the SMT solver that discharges them is itself written in Milo. It proves contracts across Milo's own standard library on every test run.

## What it looks like

Parse the numbers out of a string and add them up:

```milo
from "std/string" import { strReplace, strSplitWhitespace }
from "std/strconv" import { parseInt }

fn main() {
    let input = "123 67 89,99"

    // Split on spaces or commas, parse each token, keep the good ones.
    var nums: Vec<i64> = []
    for tok in strSplitWhitespace(strReplace(input, ",", " ")) {
        let Option.Some(n) = parseInt(tok.clone()) else { continue }
        nums.push(n)
    }

    var total = 0
    for n in nums {
        total = total + n
    }
    print("sum: " + total.toString())   // sum: 378
}
```

No allocator to thread through, no manual free — `nums` is owned and freed when it falls out of scope. `parseInt` returns an `Option`, and `let Option.Some(n) = … else { continue }` binds it or skips the token in one line. [Try it in the playground →](/playground)

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
  <p class="showcase-more">More is already shipping in Milo: a <strong>SNES</strong> emulator, a <strong>web + AI debugger</strong>, HTTP/TLS servers, terminal apps, and the compiler itself. <a href="/milo/demos">Check them out →</a></p>
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
