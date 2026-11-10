---
layout: home
title: The Milo Programming Language
titleTemplate: false
hero:
  name: Milo
  text: "A systems language for code you can audit, whoever wrote it."
  tagline: "Memory-safe with no lifetimes and no GC. Contracts proven or checked. Requirements traced to object code, and back."
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
purpose: the milo-language.github.io home page: pitch (the assurance process as compiler commands), the language, showcase
key-files: docs/site/.vitepress/config.mts, docs/site/.vitepress/theme
update-when: the pitch changes, a showcase project is added or retired, or the carousel snippets change
last-verified: 2026-11-09 (pitch: audit whoever wrote it, process table; showcase cut to one grid of original work)
-->

<div class="install-line">

```sh
git clone https://github.com/milo-language/milo && cd milo && ./milo run examples/hello.milo
```

</div>

<div class="whatis">

## Who checks the code?

Agents write code faster than anyone can review it, and you can't take their word that it is right. Flight software has never run on trust in the author. DO-178C asks for evidence instead: requirements, code that traces to them, tests written from them, and a binary with nothing in it that traces to neither.

Done by hand, that process is slow and expensive. In Milo each step is a compiler command, so it runs on every change, whoever or whatever wrote it. A requirement is one line of `requirements.json`:

<div class="wrap-output">

```json
{ "id": "LLR-1", "parent": "HLR-1", "text": "Every command is clamped to [outLo, outHi] on its way out of the PID step." }
```

</div>

The code names the requirement it implements, and states it as a contract:

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

`milo trace` follows the requirement down to its code, the bytes that code became, its proof and its tests:

<div class="wide-output">

```
$ milo trace pid.milo --strict --object pid
LLR-1  Every command is clamped to [outLo, outHi] on its way out of the PID step.
  implemented   pid.milo:27 clampI32
  implemented   pid.milo:44 pidStep
  object        0x100000680-0x1000006b0 (48 B) clampI32  lines 28-32
  object        0x1000006c0-0x100000848 (392 B) pidStep  lines 32-68
  object        0x1000008b4-0x1000008d8 (36 B) nextIntegral  lines 32-32
  object        0x100000900-0x100000918 (24 B) clampInput  lines 32-32
  object        0x10000097c-0x100000998 (28 B) controlTick  lines 32-32
  formalized    PROVEN   pid.milo:30 ensures result >= lo && result <= hi  [clampI32]
  formalized    PROVEN   pid.milo:57 ensures result >= outLo && result <= outHi  [pidStep]
  verified      PROOF     2 formalizing clauses PROVEN
  verified      PASS      pid_test.milo:7 testClampKeepsValueInRange
  verified      PASS      pid_test.milo:15 testStepOutputWithinRange
```

</div>

`milo trace-object --strict` goes back up: it fails on any instruction in the binary that maps to no source line and no language rule (bounds check, overflow trap, contract check, drop).

## The process, as commands

| The process asks for | In Milo |
|---|---|
| Requirements under change control | `milo spec --diff` fails when a requirement or a contract is weakened, until a person signs it off. An agent can't pass by editing the spec. |
| Code that traces to a requirement | `@req` on the function. `milo trace --strict` fails on a function that traces to none. |
| Every requirement verified | A contract `milo prove` proves for every input, or a passing test tagged with the requirement. |
| Tests written from the requirement | `milo spec --packet` writes signatures and contracts with no bodies, for a test author who never sees the code. |
| Tests that reach the code | `milo trace --coverage` measures line coverage of the implementing code. |
| Object code that traces to source | `milo trace --object` down, `milo trace-object --strict` back up. |
| What a tool can't check | `milo evidence` records a review or a bench run, and marks it stale when the requirement or its code changes. |

Not built: branch and MC/DC coverage, and translation validation of the compiler. No Milo tool is qualified under DO-330, so this is evidence for a certification effort and not a certificate. [How Milo is checked](/language/assurance) lists every layer, built and planned.

## Proven or checked

`milo prove` hands a contract to an SMT solver, which proves it for every input or returns the input that breaks it:

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

A clause that is not proven is still enforced: `requires` and `ensures` assert at run time in every build, release included. What "proven" means is itself machine-checked: a [Lean proof](https://github.com/milo-language/milo/tree/main/proofs) of the contract rules shows that a proven program never fails a contract clause, and that removing its run-time checks changes nothing.

## Why it takes a new language

References in Milo are *second-class*: `&T` and `&mut T` exist only as function parameters. You can't return one, store one in a struct, or keep one past the call.

A reference that only travels down the call stack can't outlive its owner, so there are no lifetime annotations and no garbage collector. Nothing outside a function can point into its values, so `&mut x` at a call site is the full blast radius of a mutation. That is why the prover needs no aliasing annotations, and why a reviewer needs one function and the signatures it calls, not the rest of the program.

**What you give up:** returning or storing a view. Use an index, a `Span`, an owned copy, or an [arena handle](/stdlib/arena). The tie between a stored offset and its buffer becomes a named runtime check where Rust's lifetime is a compile error ([why that trade](/language/why-no-lifetimes)).

Same memory-safety guarantees as Rust wherever both languages can express the program. 250k+ lines of Milo so far; nearly every `unsafe` block is the C boundary, and none exist because the ownership model said no ([the full matrix](/language/vs-rust)).

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

<div class="showcase">
  <div class="showcase-head">
    <h2>Built with Milo</h2>
    <p>Milo is young, still a puppy 🐶, and every program below is real. Building them is how we find what needs fixing.</p>
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
  <p class="showcase-more">Also in Milo: <a href="https://github.com/milo-language/milo-emulators">NES, SNES and Genesis emulators</a>, a <a href="https://github.com/milo-language/milo/tree/main/examples/tools/java-dap">debugger for the JVM</a>, and <a href="/milo/demos">everything else</a>.</p>
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
