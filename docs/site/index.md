---
layout: home
title: The Milo Programming Language
titleTemplate: false
hero:
  name: Milo
  text: "A memory-safe systems language with second-class references."
  tagline: "No lifetimes, no garbage collector, and every mutation visible at the call site."
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
git clone https://github.com/milo-language/milo && cd milo && ./milo run examples/hello.milo
```

</div>

<CodeCarousel
  :titles="['Hello World', 'Ownership', 'Borrowing', 'No escape', 'Promises', 'Contracts']"
  :captions="[
    '',
    'Hand a value to someone else and you no longer have it. The compiler catches the mistake at compile time, not at 3am.',
    'A borrow lasts one call. Reads are implicit; a mutation is spelled &mut at the call site, so the line that can change v is the one that says so.',
    'A reference cannot be stored or returned. Nothing outside a function can hold a pointer into its values, which is why the function you are reading is the whole story.',
    'Two requests in flight on green tasks. Each task owns its data, so there is no mutex and no Send/Sync to write.',
    'requires and ensures are part of the language. milo prove checks clamp for every input, not just the ones you tested.',
  ]"
>

```milo
fn main() {
    let name = "world"
    print($"hello, {name}")
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
fn total(xs: &Vec<i64>): i64 {
    var sum = 0
    for x in xs { sum += x }
    return sum
}

fn double(xs: &mut Vec<i64>): void {
    for i in 0..xs.len { xs[i] *= 2 }
}

fn main() {
    var v: Vec<i64> = [1, 2, 3]
    print(total(v))    // 6: borrowed for this call, no &v needed
    double(&mut v)     // the only kind of line that can change v
    print(v)           // [2, 4, 6]
}
```

```milo error
struct Parser {
    src: &string,   // error: references cannot be stored in structs
}

fn longest(a: &string, b: &string): &string {   // error: cannot return a reference
    if a.len > b.len { return a }
    return b
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

<div class="whatis">

## Second-class references

A borrow ends when the call returns: `&T` and `&mut T` exist only as function parameters. You can't return one, store one in a struct, or keep one past the call. Every value has one owner, and nothing else holds a pointer into it.

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
        <video class="tile-img" src="/showcase/nes.mp4" poster="/showcase/nes-poster.png" autoplay muted loop playsinline preload="auto" aria-label="The Super Mario Bros. 3 intro running on the Milo NES emulator: the curtain up, raccoon Mario flying across the title screen"></video>
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
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/graphics/render.milo">
        <img class="tile-img" src="/showcase/render.jpg" alt="Glass, gold and coloured spheres on a plain at golden hour, long soft shadows and reflections, rendered by the Milo path tracer" loading="lazy">
        <h3>Path Tracer</h3>
        <p>Glass, metal and a low sun at 1920×1080, 512 samples a pixel on every core. About two minutes, and pure Milo from ray to PNG.</p>
        <div class="tile-tags"><span>Monte Carlo</span><span>depth of field</span><span>std/shard</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/graphics/render.milo --release" title="milo run examples/graphics/render.milo --release">⧉ copy run command</span>
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
  <div class="cat cat-dev">
    <h3 class="cat-head">Developer tools</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/dapweb">
        <video class="tile-img" src="/showcase/dapweb.mp4" poster="/showcase/dapweb.png" autoplay muted loop playsinline preload="auto" aria-label="An agent drives dapweb from the CLI while the browser follows: breakpoint hit, locals expanded, the agent evaluates and continues, a person types an lldb command in the same session, and the program exits"></video>
        <h3>Debugger</h3>
        <p>Debug Milo programs in the browser: source breakpoints, Milo structs in the locals, and an agent driving the same session from the CLI.</p>
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
  <a class="cta-primary" href="/milo/tour">Learn the basics · 13 lessons</a>
  <a class="cta-secondary" href="/milo/language/variables">Learn Milo</a>
  <a class="cta-secondary" href="/milo/stdlib/">Standard library</a>
  <a class="cta-secondary" href="/milo/getting-started/installation">Get Started</a>
  <a class="cta-secondary" href="https://github.com/milo-language/milo">GitHub</a>
</div>

<Subscribe blurb="New posts, releases, and things people have built with Milo. No more than once a month. Unsubscribe in one click." />

</div>
