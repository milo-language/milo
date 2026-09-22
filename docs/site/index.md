---
layout: home
hero:
  name: Milo
  text: "A memory-safe systems language with second-class references."
  tagline: "The function you are reading is the whole story of the values it touches. No lifetimes, no GC, one owner per value."
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
last-verified: 2026-09-22 (trimmed: one statement of the rule, 10 showcase tiles, the rest on /demos)
-->

<div class="install-line">

```sh
curl -fsSL https://milo-language.github.io/milo/install.sh | sh
```

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

## The rule

`&T` and `&mut T` exist only as function parameters. You can't return one, store one in a struct, or keep one past the call. Every value has one owner, and nothing else holds a pointer into it.

That buys **local reasoning**: `&mut x` at a call site is the full blast radius of a mutation, and the checker settles every ownership question inside one function, never by a signature three modules away.

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

**What you get:** no lifetime annotations, no GC or RC, concurrency without `Send`/`Sync`, `requires`/`ensures` contracts checked by `milo prove`.

**What you give up:** returning or storing a view. Use an index, a `Span`, an owned copy, or an [arena handle](/stdlib/arena). The tie between a stored offset and its buffer becomes a named runtime check where Rust's lifetime is a compile error ([why that trade](/language/why-no-lifetimes)).

### In C, in Rust, in Milo

| What you want | C | Rust | Milo |
|---|---|---|---|
| Return a pointer into a buffer you still hold | `char *`, you promise it stays valid | `fn longest(...) -> &'a str` | Not expressible. Return an index, a `Span`, or an owned string. |
| A parser that keeps the input | `struct Parser { char *src; }` | `struct Parser<'a> { src: &'a str }` | Own the input; store a cursor (`pos: i64`). |
| Iterator over a collection | pointer into the array | `Iterator<Item = &T>` | A cursor; each step takes the store: `scanNext(&store, &mut cursor)`. |
| Graph, parent pointer, DOM | `Node *next` | `Rc<RefCell<Node>>` or an arena crate | [`std/arena`](/stdlib/arena): `Arena<T>` plus `Handle<T>`, checked at runtime. |
| Temporary read / mutation in a call | pointer argument | `&T` / `&mut T` | `&T` auto-borrowed; `&mut T` written at the call: `f(&mut x)`. |
| Two owners of one buffer | two pointers, good luck | lifetimes, or `clone` / `Arc` | `.clone()`, or `seal` it and share a read-only copy. |

Same memory-safety guarantees as Rust wherever both languages can express the program. 250k+ lines of Milo so far; nearly every `unsafe` block is the C boundary, and none exist because the ownership model said no ([the full matrix](/language/vs-rust)).

</div>

<div class="showcase">
  <div class="showcase-head">
    <h2>Built with Milo</h2>
    <p>Milo is young, still a puppy 🐶, but we dogfood it hard: every program below is real, and building them is how we find what needs fixing. It's ready for you to try today.</p>
  </div>
  <div class="cat cat-emu">
    <h3 class="cat-head">Emulators</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/milo-emulators/tree/main/nes" target="_blank" rel="noopener">
        <img class="tile-img" src="/showcase/nes.png" alt="Super Mario Bros. 3 running on the Milo NES emulator" loading="lazy">
        <h3>NES Emulator</h3>
        <p>A complete Nintendo: native SDL build, drop in a ROM and play.</p>
        <div class="tile-tags"><span>6502 core</span><span>bitwise</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.nes>" title="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.nes>">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo-emulators/tree/main/genesis" target="_blank" rel="noopener">
        <img class="tile-img" src="/showcase/genesis.png" alt="Sonic the Hedgehog running on the Milo Genesis emulator" loading="lazy">
        <h3>Genesis Emulator</h3>
        <p>A complete Sega Genesis. Sonic runs.</p>
        <div class="tile-tags"><span>68000 + Z80</span><span>DMA</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.md>" title="git clone https://github.com/milo-language/milo-emulators && milo-emulators/arcade.sh <rom.md>">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo-emulators/tree/main/snes" target="_blank" rel="noopener">
        <img class="tile-img" src="/showcase/snes.png" alt="Super Mario World running on the Milo SNES emulator" loading="lazy">
        <h3>SNES Emulator</h3>
        <p>A Super Nintendo. Mario World, Donkey Kong Country, Star Fox.</p>
        <div class="tile-tags"><span>Super FX GSU</span><span>bitwise</span><span>SDL</span></div>
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
  <a class="cta-secondary" href="/milo/getting-started/installation">Get Started</a>
  <a class="cta-secondary" href="/milo/blog/">Blog</a>
  <a class="cta-secondary" href="https://github.com/milo-language/milo">GitHub</a>
</div>

<Subscribe blurb="New posts, releases, and things people have built with Milo. No more than once a month. Unsubscribe in one click." />

</div>
