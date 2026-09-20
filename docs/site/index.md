---
layout: home
hero:
  name: Milo
  text: "A memory-safe systems language that guides you to correct, readable programs."
  tagline: "Memory safe with no lifetime annotations to write, and ergonomic enough to reach for every day. Contracts and formal verification are built in, so correctness is proven, not just tested."
  image:
    src: /logo.svg
    alt: Milo
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: GitHub
      link: https://github.com/milo-language/milo
---
<!-- doc-meta
system: site-landing
purpose: the milo-language.github.io home page: pitch, code carousel, what it is and is not, showcase
key-files: docs/site/.vitepress/config.mts, docs/site/.vitepress/theme
update-when: the pitch changes, a showcase project is added or retired, or the carousel snippets change
last-verified: 2026-09-20
-->

<div class="install-line">

```sh
curl -fsSL https://milo-language.github.io/milo/install.sh | sh
```

</div>

<div class="intro">

- [**Run Milo in your browser**](/playground)
- [**Learn the basics**](/tour)
- [**Why there are no lifetimes**](/language/why-no-lifetimes)
- [**Compare to Rust's safety profile**](/language/vs-rust)
- [**Contracts and formal verification**](/language/safety)
- [**Browse the standard library**](/stdlib/)
- [**Read the language reference**](/language/)

</div>

<CodeCarousel
  :titles="['Hello World', 'Functions', 'Contracts', 'Structs', 'Ownership', 'Promises']"
  :captions="[
    '',
    'The same clamp, written as a plain function — no contracts yet.',
    'requires and ensures are part of the language. The prover checks that clamp keeps its promise for every input, not just the ones you tested.',
    'Plain data with methods. No inheritance, no header files, no surprises.',
    'Hand a value to someone else and you no longer have it. The compiler catches the mistake at compile time, not at 3am.',
    'Two requests in flight at once. Green tasks, not OS threads, so thousands are cheap. Each task owns its data, so there is no mutex. Holding a view into a shared global across an await is a compile error, and OS threads start only at the two doors the compiler checks.',
  ]"
>

```milo
fn main() {
    let name = "world"
    print($"hello, {name}")
}
```

```milo
fn clamp(x: i64, lo: i64, hi: i64): i64 {
    if x < lo { return lo }
    if x > hi { return hi }
    return x
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
from "std/math" import { Math }

struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn dist(self: &Self): f64 {
        return Math.sqrt(self.x * self.x + self.y * self.y)
    }
}

fn main() {
    let p = Point { x: 3.0, y: 4.0 }
    print($"{p.dist()}")   // 5
}
```

```milo error
fn main() {
    let name = "milo"
    let greeting = name   // `name` moves here. It is no longer yours

    print(greeting)       // "milo"
    print(name)           // error: use of moved variable 'name'
}
```

```milo
from "std/fetch" import { fetch }
from "std/runtime" import { Promise }

fn main() {
    let a = Promise<i32>.run(() => fetch("https://example.com")!.status)
    let b = Promise<i32>.run(() => fetch("https://httpbin.org/get")!.status)

    print($"{a.await()!} {b.await()!}")   // 200 200
}
```

</CodeCarousel>

<div class="whatis">

## What it is, and is not

**What Milo is.** A systems language built for local reasoning: the function you are reading is the whole story of the values it touches. References are second-class (never stored, so no lifetimes), every value has one owner, mutation happens only through a `&mut` parameter that cannot outlive the call, and every effect is declared where it happens (`@unsafe`, `@thread`, `@parks`, `@mustUse`). It is verbose on purpose: an extra `clone()` or `let _ =` where you are already looking is cheaper than reasoning about state you cannot see ([how](/ai-coding#local-reasoning), [why there are no lifetimes](/language/why-no-lifetimes)).

**What Milo is not.** Not functional: `var`, `for` and in-place mutation are the idiom; it gets functional programming's "nothing else can change this" guarantee by scoping mutation, not by banning it. Not garbage collected and not reference counted. Not Rust: no lifetimes, no stored references, no `Send`/`Sync`; the price is that a view cannot be returned or kept, so you copy, or hold an arena handle. Not a scripting language: it compiles through LLVM to a static binary.

**Measured, not claimed.** We have written over 250k lines of Milo across the compiler (self-hosted), a JS engine, three emulator cores, a debugger and a dozen packages. Nearly every `unsafe` block in them is the C boundary, and not one exists because the ownership model rejected a program ([the numbers](/language/vs-rust)).

### Mutation is scoped, not banned

Functional languages get safety by making everything immutable. Milo takes a different path: you mutate freely, but only through `&mut` parameters, and a `&mut` borrow cannot outlive the call that receives it. That one rule gives you the same "nothing else can change this" guarantee without the allocation and copying that immutability forces on hot loops.

```milo
fn zeroNegatives(values: &mut Vec<i64>): void {
    for i in 0..values.len {
        if values[i] < 0 {
            values[i] = 0       // in-place, no copy, no allocation
        }
    }
}

fn main(): void {
    var v: Vec<i64> = [3, -1, 4, -5, 9]
    zeroNegatives(&mut v)      // v is mutated here and nowhere else
    print(v)                   // [3, 0, 4, 0, 9]
}
```

When you read `main`, you know `v` can only change inside `zeroNegatives` because that is the only call that borrows it mutably. No other pointer to `v` exists. That is local reasoning: the call site tells you the full blast radius of a mutation, and the compiler enforces it.

</div>

<div class="showcase">
  <div class="showcase-head">
    <h2>Built with Milo</h2>
    <p>Milo is young, still a puppy 🐶, but we dogfood it hard: every program below is real, and building them is how we find what needs fixing. It's ready for you to try today.</p>
  </div>
  <div class="cat cat-emu">
    <h3 class="cat-head">Emulators</h3>
    <div class="tile-grid">
      <a class="tile" href="/milo/emulators/nes/" target="_self" data-vp-ignore>
        <img class="tile-img" src="/showcase/nes.png" alt="Super Mario Bros. 3 running on the Milo NES emulator" loading="lazy">
        <span class="tile-play">▶ PLAY</span>
        <h3>NES Emulator</h3>
        <p>A complete Nintendo, playable right here in your browser.</p>
        <div class="tile-tags"><span>6502 core</span><span>bitwise</span><span>emit-js</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.nes>" title="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.nes>">⧉ copy run command</span>
      </a>
      <a class="tile" href="/milo/emulators/genesis/" target="_self" data-vp-ignore>
        <img class="tile-img" src="/showcase/genesis.png" alt="Sonic the Hedgehog running on the Milo Genesis emulator" loading="lazy">
        <span class="tile-play">▶ PLAY</span>
        <h3>Genesis Emulator</h3>
        <p>A complete Sega Genesis. Sonic runs.</p>
        <div class="tile-tags"><span>68000 + Z80</span><span>DMA</span><span>emit-js</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.md>" title="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.md>">⧉ copy run command</span>
      </a>
      <a class="tile" href="/milo/emulators/snes/" target="_self" data-vp-ignore>
        <img class="tile-img" src="/showcase/snes.png" alt="Super Mario World running on the Milo SNES emulator" loading="lazy">
        <span class="tile-play">▶ PLAY</span>
        <h3>SNES Emulator</h3>
        <p>A Super Nintendo. Mario World, Donkey Kong Country, Star Fox.</p>
        <div class="tile-tags"><span>Super FX GSU</span><span>bitwise</span><span>emit-js</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.sfc>" title="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.sfc>">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-sim">
    <h3 class="cat-head">Graphics &amp; simulation</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/milo/tree/main/examples/games/flight">
        <img class="tile-img" src="/showcase/flyby.png" alt="Flying over downtown San Francisco in FLYBY, the Bay Bridge running out across the water behind it" loading="lazy">
        <h3>FLYBY</h3>
        <p>A 3D flying game over five real places — SRTM terrain, OpenStreetMap buildings and bridges, aerial imagery draped on top. One analytic sky model handles the atmosphere, distance haze, and sea reflections, keeping all three consistent; the water is raymarched with sun glitter and foam, and the waterfalls have spray and a rainbow at the angle refraction puts one.</p>
        <div class="tile-tags"><span>OpenGL 3.3</span><span>GLSL</span><span>z-buffer</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo build examples/games/flight/main.milo -o /tmp/flyby --release &amp;&amp; /tmp/flyby" title="milo build examples/games/flight/main.milo -o /tmp/flyby --release &amp;&amp; /tmp/flyby">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/graphics/raytrace3d.milo">
        <img class="tile-img" src="/showcase/raytracer.png" alt="Chrome and coloured spheres reflecting each other on a checkerboard floor" loading="lazy">
        <h3>Real-time Ray Tracer</h3>
        <p>Chrome spheres bouncing in a mirrored box — reflections, hard shadows and rigid-body physics, traced per pixel every frame at 60fps. Pure CPU, no GPU.</p>
        <div class="tile-tags"><span>Whitted tracing</span><span>Blinn-Phong</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/graphics/raytrace3d.milo" title="milo run examples/graphics/raytrace3d.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/graphics/raytracer.milo">
        <img class="tile-img" src="/showcase/pathtracer.png" alt="Diffuse and metal spheres lit by indirect bounce light in the Milo path tracer" loading="lazy">
        <h3>Path Tracer</h3>
        <p>Unbiased Monte-Carlo global illumination on the CPU. Soft shadows and colour bleed fall out of the bounce integral — nothing is faked.</p>
        <div class="tile-tags"><span>progressive</span><span>importance sampling</span><span>f64 math</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/graphics/raytracer.milo" title="milo run examples/graphics/raytracer.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/simulation/cloth.milo">
        <video class="tile-img" src="/showcase/cloth.mp4" poster="/showcase/cloth.png" autoplay muted loop playsinline preload="auto" aria-label="A cloth mesh being dragged and folding under position-based dynamics"></video>
        <h3>Cloth</h3>
        <p>Position-Based Dynamics — Verlet point masses woven by distance constraints, the method real cloth engines use. Grab a node and fling it.</p>
        <div class="tile-tags"><span>PBD</span><span>Verlet</span><span>constraint solver</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/simulation/cloth.milo" title="milo run examples/simulation/cloth.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/simulation/phasespace.milo">
        <video class="tile-img" src="/showcase/phasespace.mp4" poster="/showcase/phasespace.png" autoplay muted loop playsinline preload="auto" aria-label="Two cat's-eye vortices winding up in the Vlasov phase-space distribution"></video>
        <h3>Plasma Physics</h3>
        <p>A collisionless Vlasov solver in (x, v) phase space — finite-volume MUSCL with Strang splitting, winding a Maxwellian into trapped-particle vortices.</p>
        <div class="tile-tags"><span>Vlasov</span><span>MUSCL / minmod</span><span>Strang splitting</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/simulation/phasespace.milo" title="milo run examples/simulation/phasespace.milo">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-lang">
    <h3 class="cat-head">Compilers &amp; interpreters</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/milojs">
        <img class="tile-img" src="/showcase/js-engine.png" alt="milojs REPL evaluating console.log('Woof!')" loading="lazy">
        <h3>JS Engine</h3>
        <p>A JavaScript engine and Node-compatible runtime — runs real npm apps (express, tRPC, zod).</p>
        <div class="tile-tags"><span>mark-sweep GC</span><span>closures</span><span>event loop</span><span>TLS fetch</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milojs && milo run milojs/milojs.milo milojs/bench/realistic.js" title="git clone https://github.com/milo-language/milojs && milo run milojs/milojs.milo milojs/bench/realistic.js">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/tools/smtSolve.milo">
        <h3>The Prover</h3>
        <p>The SMT prover that verifies Milo contracts, written in Milo.</p>
        <div class="tile-tags"><span>SMT solver</span><span>bitvectors</span><span>recursion</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo prove yourfile.milo" title="milo prove yourfile.milo">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-crypto">
    <h3 class="cat-head">Cryptography &amp; compression</h3>
    <div class="tile-grid">
      <a class="tile" href="/milo/stdlib/#cryptography">
        <h3>Cryptography</h3>
        <p>Pure-Milo SHA-256, SHA-1, HMAC, JWT, TOTP and Base32 — hashing, MACs and 2FA with no C crypto dependency, matched bit-for-bit to the RFC vectors.</p>
        <div class="tile-tags"><span>SHA-256</span><span>HMAC / JWT</span><span>constant-time</span><span>WCET-proven</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd='from "std/sha256" import { sha256 }' title='from "std/sha256" import { sha256 }'>⧉ copy import</span>
      </a>
      <a class="tile" href="/milo/stdlib/#compression">
        <h3>Compression</h3>
        <p>Pure-Milo DEFLATE, gzip, zlib and zip — the codec that gzip HTTP bodies, PNG and git objects need, no C dependency.</p>
        <div class="tile-tags"><span>DEFLATE</span><span>gzip / zlib</span><span>zip</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd='from "std/deflate" import { gzipCompress }' title='from "std/deflate" import { gzipCompress }'>⧉ copy import</span>
      </a>
    </div>
  </div>
  <div class="cat cat-dev">
    <h3 class="cat-head">Developer tools</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/dapweb">
        <img class="tile-img" src="/dapweb/debugging.png" alt="dapweb debugger stopped at a breakpoint" loading="lazy">
        <h3>Debugger</h3>
        <p>dapweb: debug any program from the browser, with an AI in the loop.</p>
        <div class="tile-tags"><span>HTTP server</span><span>WebSockets</span><span>JSON-RPC (DAP)</span><span>PTY</span><span>CLI API</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/dapweb && cd dapweb && src/web/ui/build.sh && milo build src/main.milo -o dapweb && ./dapweb web" title="git clone https://github.com/milo-language/dapweb && cd dapweb && src/web/ui/build.sh && milo build src/main.milo -o dapweb && ./dapweb web">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/tree/main/examples/tools/java-dap">
        <h3>Java Debugger</h3>
        <p>A DAP-compliant debugger for the JVM, so dapweb debugs Java too.</p>
        <div class="tile-tags"><span>JDWP</span><span>TCP sockets</span><span>binary protocol</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo build examples/tools/java-dap/src/main.milo -o java-dap" title="milo build examples/tools/java-dap/src/main.milo -o java-dap">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-web">
    <h3 class="cat-head">Web &amp; networking</h3>
    <div class="tile-grid">
      <a class="tile" href="https://chadsmith.dev/weather/">
        <img class="tile-img" src="/showcase/weather.png" alt="The Milo weather app showing current conditions, an hourly strip and a 7-day forecast for Bend, Oregon" loading="lazy">
        <span class="tile-play">▶ VISIT</span>
        <h3>Weather App</h3>
        <p>Forecast, UV index and air quality for any US city, served from a single static binary — live at chadsmith.dev/weather.</p>
        <div class="tile-tags"><span>HTTP server</span><span>TLS fetch</span><span>JSON</span><span>17k-place index</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/net/weather/app.milo" title="milo run examples/net/weather/app.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/tree/main/examples/net/termpair">
        <h3>termpair</h3>
        <p>Share your terminal in the browser, end-to-end encrypted.</p>
        <div class="tile-tags"><span>WebSockets</span><span>AES-GCM</span><span>PTY</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/net/termpair/server.milo" title="milo run examples/net/termpair/server.milo">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-term">
    <h3 class="cat-head">Terminal &amp; CLI</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/terminal/tetris.milo">
        <img class="tile-img" src="/showcase/tetris.png" alt="Milo Tetris in the terminal" loading="lazy">
        <h3>Tetris</h3>
        <p>The classic, in your terminal.</p>
        <div class="tile-tags"><span>raw TTY</span><span>green tasks</span><span>channels</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/terminal/tetris.milo" title="milo run examples/terminal/tetris.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/terminal/sysmon.milo">
        <h3>System Monitor</h3>
        <p>A live htop-style view of your machine.</p>
        <div class="tile-tags"><span>TUI</span><span>syscalls</span><span>truecolor</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/terminal/sysmon.milo" title="milo run examples/terminal/sysmon.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/terminal/splitPty.milo">
        <h3>splitPty</h3>
        <p>Two commands side by side in real PTYs — a mini tmux.</p>
        <div class="tile-tags"><span>PTY</span><span>multiplexing</span><span>green tasks</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/terminal/splitPty.milo" title="milo run examples/terminal/splitPty.milo">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="showcase-cta">
    <a class="showcase-cta-btn" href="/milo/demos">See more</a>
  </div>
</div>

<div class="section-break"></div>

<div class="cta-section">

### Take Milo for a walk

<div class="cta-buttons">
  <a class="cta-primary" href="/milo/tour">Learn the basics · 12 lessons</a>
  <a class="cta-secondary" href="/milo/language/">Language overview</a>
  <a class="cta-secondary" href="/milo/stdlib/">Standard library</a>
  <a class="cta-secondary" href="/milo/playground">Playground</a>
  <a class="cta-secondary" href="/milo/getting-started/installation">Get Started</a>
  <a class="cta-secondary" href="/milo/blog/">Blog</a>
  <a class="cta-secondary" href="https://github.com/milo-language/milo">GitHub</a>
</div>

<Subscribe blurb="New posts, releases, and things people have built with Milo. No more than once a month. Unsubscribe in one click." />

</div>
