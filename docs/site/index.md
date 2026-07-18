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

<div class="intro">

Milo is a memory-safe systems language that guides you to simple, correct, readable programs. Contracts are built in, enabling formal verification that guarantees correctness across your codebase, no matter how large. People and AI ship with confidence that their code is correct. <a href="/milo/language/">Learn more</a>

</div>

<CodeCarousel
  :titles="['Hello World', 'Contracts', 'Structs', 'Ownership', 'Promises']"
  :captions="[
    'No boilerplate, no ceremony. One command compiles it to a native binary and runs it.',
    'requires and ensures are part of the language. The prover checks that clamp keeps its promise for every input, not just the ones you tested.',
    'Plain data with methods. No inheritance, no header files, no surprises.',
    'Hand a value to someone else and you no longer have it. The compiler catches the mistake at compile time, not at 3am.',
    'Two requests in flight at once. Green tasks, not OS threads, so thousands are cheap. Each task owns its data, so there is no mutex and no data race to get wrong.',
  ]"
>

```milo
fn main() {
    let name = "world"
    print($"hello, {name}")
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

```milo
from "std/math" import { sqrt }

struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn dist(self: &Self): f64 {
        return sqrt(self.x * self.x + self.y * self.y)
    }
}

fn main() {
    let p = Point { x: 3.0, y: 4.0 }
    print($"{p.dist()}")   // 5
}
```

```milo
fn main() {
    let name = "milo"
    let greeting = name   // `name` moves here. It is no longer yours

    print(greeting)       // "milo"
    print(name)           // error: use of moved variable 'name'
}
```

```milo
from "std/net" import { fetch }
from "std/runtime" import { Promise }

fn main() {
    let a = Promise<i32>.run(() => fetch("https://example.com")!.status)
    let b = Promise<i32>.run(() => fetch("https://httpbin.org/get")!.status)

    print($"{a.await()!} {b.await()!}")   // 200 200
}
```

</CodeCarousel>

<div class="showcase">
  <div class="showcase-head">
    <h2>Built in Milo</h2>
    <p>We build the language by building things with it. We've found that faster than theory and analysis, and it yields a better language. The emulators run right here in your browser: the same Milo source compiles to a native binary <em>and</em> to JavaScript.</p>
  </div>
  <div class="tile-grid">
    <a class="tile" href="/milo/nes/">
      <span class="tile-play">▶ PLAY</span>
      <div class="tile-emoji">🎮</div>
      <h3>NES Emulator</h3>
      <p>A complete Nintendo, playable right here in your browser.</p>
    </a>
    <a class="tile" href="/milo/genesis/">
      <span class="tile-play">▶ PLAY</span>
      <div class="tile-emoji">🕹️</div>
      <h3>Genesis Emulator</h3>
      <p>A complete Sega Genesis. Sonic runs.</p>
    </a>
    <a class="tile" href="/milo/snes/">
      <span class="tile-play">▶ PLAY</span>
      <div class="tile-emoji">👾</div>
      <h3>SNES Emulator</h3>
      <p>A Super Nintendo. Mario World, Donkey Kong Country, Star Fox.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/src-milo">
      <div class="tile-emoji">🪞</div>
      <h3>The Compiler</h3>
      <p>The Milo compiler is written in Milo. It compiles itself.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/milojs">
      <div class="tile-emoji">⚡</div>
      <h3>JS Engine</h3>
      <p>A JavaScript engine that runs real Node apps like express.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/hades">
      <div class="tile-emoji">🐛</div>
      <h3>Debugger</h3>
      <p>hades: debug any program from the browser, with an AI in the loop.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/weather">
      <div class="tile-emoji">🌦️</div>
      <h3>Weather App</h3>
      <p>A weather website served from a single static binary.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/termpair">
      <div class="tile-emoji">🖥️</div>
      <h3>termpair</h3>
      <p>Share your terminal in the browser, end-to-end encrypted.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/tetris.milo">
      <div class="tile-emoji">🧱</div>
      <h3>Tetris</h3>
      <p>The classic, in your terminal.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/java-dap">
      <div class="tile-emoji">☕</div>
      <h3>Java Debugger</h3>
      <p>A JVM debug adapter, so hades debugs Java too.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/sysmon.milo">
      <div class="tile-emoji">📊</div>
      <h3>System Monitor</h3>
      <p>A live htop-style view of your machine.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/cli-tools/pkg.milo">
      <div class="tile-emoji">📦</div>
      <h3>Package Manager</h3>
      <p>Milo's own package manager. Install and publish packages over git.</p>
    </a>
    <a class="tile" href="https://github.com/cs01/milo/blob/main/tools/smtSolve.milo">
      <div class="tile-emoji">🧮</div>
      <h3>The Prover</h3>
      <p>The SMT prover that verifies Milo contracts, written in Milo.</p>
    </a>
  </div>
  <div class="showcase-cta">
    <a class="showcase-cta-btn" href="/milo/demos">Explore the full showcase</a>
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
