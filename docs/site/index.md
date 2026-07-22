---
layout: home
hero:
  name: Milo
  text: "works hard to keep your memory safe so you don't have to"
  tagline: "Safe systems programming language with formal verification built-in"
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
      text: ▶ Try it live
      link: /playground
---

<div class="intro">

Milo is a memory-safe systems language that guides you to simple, correct, readable programs. Contracts are built in, enabling formal verification that guarantees correctness across your codebase, no matter how large. People and AI ship with confidence that their code is correct. <a href="/milo/language/">Learn more</a> or see how it <a href="/milo/language/vs-rust">measures up to Rust</a>.

</div>

<CodeCarousel
  :titles="['Hello World', 'Functions', 'Contracts', 'Structs', 'Ownership', 'Promises']"
  :captions="[
    '',
    'The same clamp, written as a plain function — no contracts yet.',
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
    <h2>Built with Milo</h2>
    <p>We build the language by building things with it. We dogfood Milo to get a feedback loop that helps us continuously improve the safety and ergonomics of the language.</p>
  </div>
  <div class="cat cat-emu">
    <h3 class="cat-head">Emulators</h3>
    <div class="tile-grid">
      <a class="tile" href="/milo/nes/">
        <img class="tile-img" src="/showcase/nes.png" alt="Super Mario Bros. 3 running on the Milo NES emulator" loading="lazy">
        <span class="tile-play">▶ PLAY</span>
        <h3>NES Emulator</h3>
        <p>A complete Nintendo, playable right here in your browser.</p>
        <div class="tile-tags"><span>6502 core</span><span>bitwise</span><span>emit-js</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="examples/apps/arcade.sh <rom.nes>" title="examples/apps/arcade.sh <rom.nes>">⧉ copy run command</span>
      </a>
      <a class="tile" href="/milo/genesis/">
        <img class="tile-img" src="/showcase/genesis.png" alt="Sonic the Hedgehog running on the Milo Genesis emulator" loading="lazy">
        <span class="tile-play">▶ PLAY</span>
        <h3>Genesis Emulator</h3>
        <p>A complete Sega Genesis. Sonic runs.</p>
        <div class="tile-tags"><span>68000 + Z80</span><span>DMA</span><span>emit-js</span><span>SDL</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="examples/apps/arcade.sh <rom.md>" title="examples/apps/arcade.sh <rom.md>">⧉ copy run command</span>
      </a>
      <a class="tile" href="/milo/snes/">
        <img class="tile-img" src="/showcase/snes.png" alt="Super Mario World running on the Milo SNES emulator" loading="lazy">
        <span class="tile-play">▶ PLAY</span>
        <h3>SNES Emulator</h3>
        <p>A Super Nintendo. Mario World, Donkey Kong Country, Star Fox.</p>
        <div class="tile-tags"><span>Super FX GSU</span><span>bitwise</span><span>emit-js</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="examples/apps/arcade.sh <rom.sfc>" title="examples/apps/arcade.sh <rom.sfc>">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-lang">
    <h3 class="cat-head">Compilers &amp; interpreters</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/cs01/milo/tree/main/src-milo">
        <h3>The Compiler</h3>
        <p>The Milo compiler is written in Milo. It compiles itself.</p>
        <div class="tile-tags"><span>self-hosting</span><span>LLVM IR</span><span>monomorphization</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="sh scripts/selfhost.sh" title="sh scripts/selfhost.sh">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/milojs">
        <img class="tile-img" src="/showcase/js-engine.png" alt="milojs REPL evaluating console.log('Woof!')" loading="lazy">
        <h3>JS Engine</h3>
        <p>A JavaScript engine and Node-compatible runtime — runs real npm apps (express, tRPC, zod).</p>
        <div class="tile-tags"><span>mark-sweep GC</span><span>closures</span><span>event loop</span><span>TLS fetch</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/apps/milojs/milojs.milo examples/apps/milojs/bench/realistic.js" title="milo run examples/apps/milojs/milojs.milo examples/apps/milojs/bench/realistic.js">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/blob/main/tools/smtSolve.milo">
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
      <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/hades">
        <img class="tile-img" src="/hades/debugging.png" alt="hades web debugger stopped at a breakpoint" loading="lazy">
        <h3>Debugger</h3>
        <p>hades: debug any program from the browser, with an AI in the loop.</p>
        <div class="tile-tags"><span>HTTP server</span><span>WebSockets</span><span>JSON-RPC (DAP)</span><span>PTY</span><span>MCP</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo build examples/apps/hades/src/main.milo -o hades && ./hades web" title="milo build examples/apps/hades/src/main.milo -o hades && ./hades web">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/java-dap">
        <h3>Java Debugger</h3>
        <p>A DAP-compliant debugger for the JVM, so hades debugs Java too.</p>
        <div class="tile-tags"><span>JDWP</span><span>TCP sockets</span><span>binary protocol</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo build examples/apps/java-dap/src/main.milo -o java-dap" title="milo build examples/apps/java-dap/src/main.milo -o java-dap">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-web">
    <h3 class="cat-head">Web &amp; networking</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/weather">
        <h3>Weather App</h3>
        <p>A weather website served from a single static binary.</p>
        <div class="tile-tags"><span>HTTP server</span><span>TLS fetch</span><span>JSON</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/apps/weather/app.milo" title="milo run examples/apps/weather/app.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/tree/main/examples/apps/termpair">
        <h3>termpair</h3>
        <p>Share your terminal in the browser, end-to-end encrypted.</p>
        <div class="tile-tags"><span>WebSockets</span><span>AES-GCM</span><span>PTY</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/apps/termpair/server.milo" title="milo run examples/apps/termpair/server.milo">⧉ copy run command</span>
      </a>
    </div>
  </div>
  <div class="cat cat-term">
    <h3 class="cat-head">Terminal &amp; CLI</h3>
    <div class="tile-grid">
      <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/tetris.milo">
        <img class="tile-img" src="/showcase/tetris.png" alt="Milo Tetris in the terminal" loading="lazy">
        <h3>Tetris</h3>
        <p>The classic, in your terminal.</p>
        <div class="tile-tags"><span>raw TTY</span><span>green tasks</span><span>channels</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/apps/tetris.milo" title="milo run examples/apps/tetris.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/sysmon.milo">
        <h3>System Monitor</h3>
        <p>A live htop-style view of your machine.</p>
        <div class="tile-tags"><span>TUI</span><span>syscalls</span><span>truecolor</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/apps/sysmon.milo" title="milo run examples/apps/sysmon.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/apps/splitPty.milo">
        <h3>splitPty</h3>
        <p>Two commands side by side in real PTYs — a mini tmux.</p>
        <div class="tile-tags"><span>PTY</span><span>multiplexing</span><span>green tasks</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/apps/splitPty.milo" title="milo run examples/apps/splitPty.milo">⧉ copy run command</span>
      </a>
      <a class="tile" href="https://github.com/cs01/milo/blob/main/examples/cli-tools/pkg.milo">
        <h3>Package Manager</h3>
        <p>Milo's own package manager. Install and publish packages over git.</p>
        <div class="tile-tags"><span>git</span><span>HTTP</span><span>TOML</span></div>
        <span class="tile-copy" role="button" tabindex="0" data-cmd="milo run examples/cli-tools/pkg.milo -- --help" title="milo run examples/cli-tools/pkg.milo -- --help">⧉ copy run command</span>
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
  <a class="cta-primary" href="/milo/tour">Learn the basics · 11 lessons</a>
  <a class="cta-secondary" href="/milo/language/">Language overview</a>
  <a class="cta-secondary" href="/milo/stdlib/">Standard library</a>
  <a class="cta-secondary" href="/milo/playground">Playground</a>
  <a class="cta-secondary" href="/milo/getting-started/installation">Get Started</a>
  <a class="cta-secondary" href="https://github.com/cs01/milo">GitHub</a>
</div>

</div>
