---
layout: home
title: The Milo Programming Language
titleTemplate: false
hero:
  name: Milo
  text: "A memory-safe systems language."
  tagline: "Fast native binaries with no lifetimes and no garbage collector. Contracts a solver can prove, and requirements traced from source to object code."
  image:
    src: /logo.svg
    alt: Milo
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Take the Tour
      link: /tour
    - theme: alt
      text: GitHub
      link: https://github.com/milo-language/milo
---
<!-- doc-meta
system: site-landing
purpose: the milo-language.github.io home page: what the language is like (attribute cards linking out), a taste of code, then short intros to second-class references, contracts and requirements traceability, then the showcase
key-files: docs/site/.vitepress/config.mts, docs/site/.vitepress/theme, docs/site/language/traceability.md
update-when: the pitch changes, a showcase project is added or retired, or the carousel snippets change
last-verified: 2026-11-11 (attributes first, gradual intros; full traceability walkthrough moved to /language/traceability)
-->

<div class="install-line">

```sh
git clone https://github.com/milo-language/milo && cd milo && ./milo run examples/hello.milo
```

</div>

<div class="attr-grid">
  <a class="attr" href="/milo/language/why-no-lifetimes">
    <h3>Memory-safe, no lifetimes</h3>
    <p>References are function parameters only, so they can't dangle. No lifetime annotations and no garbage collector.</p>
  </a>
  <a class="attr" href="/milo/benchmarks">
    <h3>Fast</h3>
    <p>On par with C and Rust. Beats Rust on 3 of 5 benchmarks and is within 7% on the other two, with overflow checks left on.</p>
  </a>
  <a class="attr" href="/milo/language/safety">
    <h3>Proven or checked</h3>
    <p><code>requires</code> and <code>ensures</code> are part of the language. <code>milo prove</code> proves them for every input or prints a counterexample.</p>
  </a>
  <a class="attr" href="/milo/features/concurrency">
    <h3>Simple concurrency</h3>
    <p>No value has two owners, so tasks never share mutable data. Spread work across tasks and cores with no locks, no data races and no <code>async</code> to thread through your code.</p>
  </a>
  <a class="attr" href="/milo/stdlib/">
    <h3>Standard library</h3>
    <p>HTTP server and client, TLS, JSON, SQLite, regex, arenas and more. C libraries are one <code>extern</code> away.</p>
  </a>
  <a class="attr" href="/milo/language/traceability">
    <h3>Requirements traceability</h3>
    <p>Tag a function with the requirement it implements. <code>milo trace</code> links each requirement to its source, tests, proofs and object code.</p>
  </a>
</div>

<CodeCarousel
  :titles="['Hello World', 'Ownership', 'Borrowing', 'No escape', 'Promises']"
  :captions="[
    '',
    'Hand a value to someone else and you no longer have it. The compiler catches the mistake at compile time, not at 3am.',
    'A borrow lasts one call. Reads are implicit; a mutation is spelled &mut at the call site, so the line that can change v is the one that says so.',
    'A reference cannot be stored or returned. Nothing outside a function can hold a pointer into its values, which is why the function you are reading is the whole story.',
    'Two requests in flight on green tasks. Each task owns its data, so there is no mutex and no Send/Sync to write.',
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
    let names: Vec<string> = ["milo"]
    let team = names      // `names` moves here. It is no longer yours

    print(team)           // ["milo"]
    print(names)          // error: use of moved variable 'names'
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

</CodeCarousel>

<div class="section-break"></div>

<div class="whatis">

## Second-class references

References in Milo are *second-class*: `&T` and `&mut T` can only be function parameters. A reference can't be returned, stored in a struct, or kept after the call.

A reference therefore can't outlive the value it points to, so Milo needs no lifetime annotations and no garbage collector. A function can only modify what is passed to it as `&mut`, and that is visible at the call site: `f(&mut x)`. This makes proofs simpler, because the prover needs no aliasing annotations, and it makes review simpler, because a function can be read without the rest of the program.

**The cost:** a function can't return or store a view into someone else's data. Use an index, a `Span`, an owned copy, or an [arena handle](/stdlib/arena) instead. Some mistakes that Rust rejects at compile time, such as using a stale offset into a buffer, are run-time checks in Milo ([details](/language/why-no-lifetimes)).

Memory safety matches Rust for programs both languages can express ([comparison](/language/vs-rust)). There are 250k+ lines of Milo so far, and almost all `unsafe` blocks in them are calls into C.

## Proven or checked

`milo prove` checks a contract with an SMT solver. It either proves the contract for all inputs or prints a counterexample:

```milo
fn clamp(x: i64, lo: i64, hi: i64): i64
    requires lo <= hi
    ensures result >= lo && result <= hi
{
    if x < lo { return lo }
    if x >= hi { return x }    // bug: should return hi
    return x
}
```

<div class="wrap-output">

```
$ milo prove clamp.milo
  ✗ [postcondition] clamp: failed — counterexample: x = 0, lo = -1, hi = -1, result = 0
```

</div>

Contracts that are not proven are checked at run time: `requires` and `ensures` assert in every build, including release. The proof rules have a [Lean proof](https://github.com/milo-language/milo/tree/main/proofs) of soundness: a proven program never fails a contract check, so the checks can be removed from it.

## Requirements traceability

Safety-critical software, such as avionics built to DO-178C, links every requirement to the code and tests that satisfy it, and everything in the binary back to a requirement. Usually each link lives in a different tool, held together by scripts. In Milo it is part of the language and the compiler.

Tag a function with the requirement it implements:

```milo
@req(LLR-1)
pub fn clampI32(v: i32, lo: i32, hi: i32): i32
requires lo <= hi
@req(LLR-1)
ensures result >= lo && result <= hi
{
    if v < lo { return lo }
    if v > hi { return hi }
    return v
}
```

`milo trace` reports, for each requirement, the functions that implement it, whether their contracts are proven, the tests that cover it, and the address ranges it became in the binary. `milo trace-object --strict` checks the other direction: every instruction must map to a source line or a language rule. [The full walkthrough](/language/traceability) covers requirements files, the trace output and a command for each certification activity.

</div>

<div class="section-break"></div>

<div class="showcase">
  <div class="showcase-head">
    <h2>Built with Milo</h2>
    <p>Milo is young, still a puppy 🐶. These programs are how we test it.</p>
  </div>
  <div class="tile-grid">
      <a class="tile" href="https://github.com/milo-language/milo/tree/main/examples/games/plink">
        <video class="tile-img" src="/showcase/plink.mp4" poster="/showcase/plink-poster.jpg" autoplay muted loop playsinline preload="auto" aria-label="PLINK: neon targets popping up and shattering in a midway shooting gallery"></video>
        <h3>PLINK</h3>
        <p>A neon shooting gallery on a midway: targets spring up across five decks, and you hit them with a tethered blaster.</p>
        <div class="tile-tags"><span>OpenGL 3.3</span><span>7,100 lines</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/games/plink/main.milo --release" title="milo run examples/games/plink/main.milo --release">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/tree/main/examples/games/redline">
        <video class="tile-img" src="/showcase/redline.mp4" poster="/showcase/redline-poster.jpg" autoplay muted loop playsinline preload="auto" aria-label="REDLINE: a red car racing through rainy neon streets at night"></video>
        <h3>REDLINE</h3>
        <p>A street race through a city at night, in the rain: a 2.8 km circuit between walls of lit buildings.</p>
        <div class="tile-tags"><span>OpenGL 3.3</span><span>8,100 lines</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/games/redline/main.milo --release" title="milo run examples/games/redline/main.milo --release">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/tree/main/examples/games/volt">
        <video class="tile-img" src="/showcase/volt.mp4" poster="/showcase/volt-poster.jpg" autoplay muted loop playsinline preload="auto" aria-label="VOLT: a dog running and jumping up grassy steps in a sunny platformer"></video>
        <h3>VOLT</h3>
        <p>A 2D momentum platformer. You are Milo, a chihuahua: three levels, hydrants for checkpoints, instant respawn.</p>
        <div class="tile-tags"><span>platformer</span><span>5,300 lines</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo build examples/games/volt/main.milo -o /tmp/volt --release &amp;&amp; /tmp/volt" title="milo build examples/games/volt/main.milo -o /tmp/volt --release &amp;&amp; /tmp/volt">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/graphics/render.milo">
        <img class="tile-img" src="/showcase/render.jpg" alt="Glass, gold and coloured spheres on a plain at golden hour, long soft shadows and reflections, rendered by the Milo path tracer" loading="lazy">
        <h3>Path Tracer</h3>
        <p>Glass, metal and a low sun at 1920×1080, 512 samples a pixel on every core. Pure Milo from ray to PNG.</p>
        <div class="tile-tags"><span>Monte Carlo</span><span>depth of field</span><span>std/shard</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/graphics/render.milo --release" title="milo run examples/graphics/render.milo --release">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milo/blob/main/examples/simulation/phasespace.milo">
        <video class="tile-img" src="/showcase/phasespace.mp4" poster="/showcase/phasespace.png" autoplay muted loop playsinline preload="auto" aria-label="Two cat's-eye vortices winding up in the Vlasov phase-space distribution"></video>
        <h3>Plasma Physics</h3>
        <p>A collisionless Vlasov solver in (x, v) phase space, winding a Maxwellian into trapped-particle vortices.</p>
        <div class="tile-tags"><span>Vlasov</span><span>MUSCL / minmod</span><span>Strang splitting</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/simulation/phasespace.milo" title="milo run examples/simulation/phasespace.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/milojs">
        <img class="tile-img" style="object-fit: contain; background: #15191e" src="/showcase/js-engine.png" alt="milojs REPL evaluating console.log('Woof!')" loading="lazy">
        <h3>JS Engine</h3>
        <p>A JavaScript engine and Node-compatible runtime. Runs real npm apps: express, tRPC, zod.</p>
        <div class="tile-tags"><span>mark-sweep GC</span><span>event loop</span><span>TLS fetch</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/milojs && milo run milojs/milojs.milo milojs/bench/realistic.js" title="git clone https://github.com/milo-language/milojs && milo run milojs/milojs.milo milojs/bench/realistic.js">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/milo-language/dapweb">
        <video class="tile-img" src="/showcase/dapweb.mp4" poster="/showcase/dapweb.png" autoplay muted loop playsinline preload="auto" aria-label="An agent drives dapweb from the CLI while the browser follows: breakpoint hit, locals expanded, the agent evaluates and continues, a person types an lldb command in the same session, and the program exits"></video>
        <h3>Debugger</h3>
        <p>Debug Milo programs in the browser: source breakpoints, Milo structs in the locals, and an agent driving the same session from the CLI.</p>
        <div class="tile-tags"><span>WebSockets</span><span>JSON-RPC (DAP)</span><span>PTY</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="git clone https://github.com/milo-language/dapweb && cd dapweb && src/web/ui/build.sh && milo build src/main.milo -o dapweb && ./dapweb web" title="git clone https://github.com/milo-language/dapweb && cd dapweb && src/web/ui/build.sh && milo build src/main.milo -o dapweb && ./dapweb web">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://chadsmith.dev/weather/">
        <img class="tile-img" style="object-position: center top" src="/showcase/weather.png" alt="The Milo weather app showing current conditions, an hourly strip and a 7-day forecast for Bend, Oregon" loading="lazy">
        <h3>Weather App</h3>
        <p>Forecast, UV index and air quality for any US city, served from one static binary. Live at chadsmith.dev/weather.</p>
        <div class="tile-tags"><span>HTTP server</span><span>TLS fetch</span><span>JSON</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/net/weather/app.milo" title="milo run examples/net/weather/app.milo">⧉ copy run command</span>
      </a>
  </div>
  <p class="showcase-more">Also in Milo: <a href="https://github.com/milo-language/milo-emulators">NES, SNES and Genesis emulators</a>, a <a href="https://github.com/milo-language/milo/tree/main/examples/tools/java-dap">debugger for the JVM</a>, and <a href="/milo/demos">more demos</a>.</p>
</div>

<div class="section-break"></div>

<div class="cta-section">

### Take Milo for a walk

<div class="cta-buttons">
  <a class="cta-primary" href="/milo/tour">Learn the basics · 14 lessons</a>
  <a class="cta-secondary" href="/milo/language/assurance">How Milo is checked</a>
  <a class="cta-secondary" href="/milo/language/variables">Learn Milo</a>
  <a class="cta-secondary" href="/milo/stdlib/">Standard library</a>
</div>

</div>
