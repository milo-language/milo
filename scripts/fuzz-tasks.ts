// Differential falsifier for SHARED STATE ACROSS TASKS: hunts for programs with zero
// `unsafe` that the checker accepts and AddressSanitizer then rejects. The three
// hazards: a mutable global read while another task pushes, a Shards window that
// outlives its owner, and a raw pointer from `ptr()`/`cstr()` that outlives a realloc.
//
// Would have caught H2, H3 and H4 of docs/plans/soundness-sweep-2026-09.md. Each of
// those was a program the checker accepted that then read or wrote a freed buffer, and
// none of them needed `unsafe`: the hazard was spelled as a for-in binding held across
// a `schedulerYield`, a `Shard` window still on a worker thread when its `Shards` owner
// went out of scope, or a `*u8` from `v.ptr()` read by `strlen` after a `push`. The
// three fixtures that pin them seed the corpus here (see SEEDS) so a regression in any
// closed hole shows up in the first second of every run.
//
// Same accept-direction asymmetry as scripts/fuzz-ownership.ts. A program the checker
// rejects is counted, bucketed by its first error message, and not investigated: a
// false reject is loud and recoverable. A program the checker accepts is built with
// `--sanitize` and run under the memory guard, and ANY AddressSanitizer report is a
// finding. There is no stdout oracle: nothing here predicts what a data race prints,
// and ASan sees the freed-buffer read at the instruction that performs it, which a
// stdout comparison only notices when the bytes happen to have been reused.
//
// Generation is by SHAPE. Each shape is a self-contained fragment (globals, helper
// functions, statements in main, spawned tasks) drawn from one of four families:
//
//     h3   an element view of a mutable global (for-in binding, slice, `&[T]` arg,
//          `&string` arg, `ptr()` result) held across a call that can park, with a
//          second task pushing to the same global in the gap
//     h4   `let p = v.ptr()` then a push/`&mut`/move/index-assign on `v`, then a
//          scalar-returning extern read (`strlen`) of `p`, in the spellings WP8 rules
//          on and the ones it might not (alias through `let`, inline arg beside `&mut`,
//          a `Vec<*u8>` that keeps the pointer, a global mutated by a callee)
//     h2   `shatter`/`windows`/`weld`/`parallelMap` with a window dropped, escaped past
//          its owner's scope, still on a `Promise.blocking` worker when the owner dies,
//          or read out of a `Shard<string>` (H1's copy-of-a-Drop-type)
//     bg   safe noise: index loops across yields, channel ping-pong, blocking workers,
//          writer tasks, so the hazardous shapes run next to real contention
//
// A program is one to three shapes over a shared pool of globals, so a writer from one
// shape can realloc the buffer another shape is viewing. Every red is ddmin-reduced
// (line granularity, same ASan report kind) to a minimal program before it is written
// out; by default one representative per (shape set, ASan kind) signature is reduced,
// `--reduce-all` reduces every red.
//
// Usage: bun scripts/fuzz-tasks.ts [--n=200] [--seed=1] [--filter=<shape substring>]
//        [--jobs=4] [--keep] [--reduce-all] [--reduce-probes=80] [--no-seeds] [--verbose]
//
// `--filter` restricts generation to shapes whose name contains the substring (the
// family prefixes h2/h3/h4/bg work) and drops the seed programs. Reduced reds land in
// .fuzz-findings/tasks/. Exit 1 when any accepted program is ASan red, 2 when the run
// was vacuous (nothing accepted reached execution), 0 otherwise.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from "fs";
import { execFile } from "child_process";
import { tmpdir, cpus } from "os";
import { join } from "path";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const MILO = join(ROOT, "src", "main.ts");

// ── args ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf-8").split("\n")
    .filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
  process.exit(0);
}
const opt = (name: string, dflt: string): string => {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : dflt;
};
const num = (name: string, dflt: number) => parseInt(opt(name, String(dflt)), 10);
const flag = (name: string) => argv.includes(`--${name}`);

const N = num("n", 200);
const SEED = num("seed", 1);
const FILTER = opt("filter", "");
// Memory-guard math (CLAUDE.md): JOBS × RUN_MEM_MB must stay under half of RAM. The
// generated programs allocate a few MB; 1 GB per child is headroom for a runaway, and
// four of them are 4 GB, under half of a 16 GB machine. Builds run beside them (bun +
// clang, a few hundred MB each) so the default job count is capped below the core count.
const JOBS = Math.max(1, num("jobs", Math.min(4, Math.max(1, cpus().length - 2))));
const RUN_MEM_MB = 1024;
const RUN_TIMEOUT_MS = 20_000;
// A ddmin candidate that lost its loop increment spins until the guard kills it, and
// at 20 s each those dominate a reduction. A red that took longer than this to fire
// is still found by the main pass; it just reduces less far.
const REDUCE_TIMEOUT_MS = 3_000;
const BUILD_TIMEOUT_MS = 120_000;
const KEEP = flag("keep");
const VERBOSE = flag("verbose");
const REDUCE_ALL = flag("reduce-all");
const REDUCE_PROBES = num("reduce-probes", 80);
const NO_SEEDS = flag("no-seeds");

// ── PRNG ──────────────────────────────────────────────────────────────────────

let state = SEED >>> 0 || 1;
function rnd(): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (p: number) => rnd() < p;
const WORDS = ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

// ── the program model ─────────────────────────────────────────────────────────

type Elem = "i64" | "string" | "u8";
interface Global { name: string; elem: Elem }

// A park is any call that can suspend the current green task. `peer` is a task the
// program must also spawn for the park to actually happen at runtime: a `recv` on an
// empty channel parks only if someone later sends. The checker's verdict does not
// depend on the peer (the rule is static), but the ASan verdict does: a park that never
// parks never lets the writer task run in the gap.
interface Park { stmt: string; imports: [string, string][]; peer?: string[] }

class Program {
  imports = new Map<string, Set<string>>();
  globals: Global[] = [];
  channels: string[] = [];   // global Channel<i64> declarations, so a park can sit in any helper
  decls: string[] = [];      // struct/fn declarations, in order
  prelude: string[] = [];    // first statements in main: fill globals
  body: string[] = [];       // main statements, indent 1
  tasks = 0;                 // Task.spawn count: main must drive the scheduler if > 0
  shapes: string[] = [];
  private n = 0;

  fresh(prefix: string) { return `${prefix}${this.n++}`; }
  use(mod: string, ...names: string[]) {
    const set = this.imports.get(mod) ?? new Set<string>();
    for (const nm of names) set.add(nm);
    this.imports.set(mod, set);
  }
  // A global of the wanted element type, shared with an earlier shape half the time so
  // one shape's writer can realloc the buffer another shape is viewing.
  global(elem: Elem): Global {
    const have = this.globals.filter(g => g.elem === elem);
    if (have.length > 0 && chance(0.5)) return pick(have);
    const g = { name: this.fresh("g"), elem };
    this.globals.push(g);
    const init = elem === "i64" ? (i: number) => `${i + 1}` : elem === "u8" ? () => "65" : (i: number) => `"${WORDS[i]}"`;
    for (let i = 0; i < 3; i++) this.prelude.push(`${g.name}.push(${init(i)})`);
    if (elem === "u8") this.prelude.push(`${g.name}.push(0)`); // NUL so strlen terminates
    return g;
  }
  fn(text: string) { this.decls.push(text); }
  spawn(lines: string[]) {
    this.tasks++;
    this.body.push("Task.spawn(move() => {", ...lines.map(l => "    " + l), "})");
    this.use("std/runtime", "Task", "schedulerRunToCompletion");
  }
  // A writer task pushing enough to realloc the global's buffer at least once.
  writer(g: Global, count = pick([1000, 100000])): string {
    const name = this.fresh("writer");
    const val = g.elem === "i64" ? "777" : g.elem === "u8" ? "66" : `"${pick(WORDS)}"`;
    this.fn(`fn ${name}(): void {
    var i: i64 = 0
    while i < ${count} {
        ${g.name}.push(${val})
        i = i + 1
    }
    print("${name} done")
}`);
    return name;
  }
  // Pushes that realloc, inline at the current indent.
  grow(target: string, elem: Elem, indent: string, count = pick([1000, 100000])): string[] {
    const val = elem === "i64" ? "777" : elem === "u8" ? "66" : `"${pick(WORDS)}"`;
    const i = this.fresh("i");
    return [`var ${i}: i64 = 0`, `while ${i} < ${count} {`, `    ${target}.push(${val})`, `    ${i} = ${i} + 1`, `}`]
      .map(l => indent + l);
  }
  park(): Park {
    switch (pick(["yield", "yield", "sleep", "recv", "await"])) {
      case "sleep":
        return { stmt: "sleepMs(1)", imports: [["std/time", "sleepMs"]] };
      case "recv": {
        // A global channel, so the park can sit inside any helper. The reader parks on
        // the empty channel; the peer is spawned LAST so the writer task gets its turn
        // before the send that wakes the reader.
        const ch = this.fresh("ch");
        this.channels.push(`var ${ch}: Channel<i64> = Channel<i64>.new(1)!`);
        return {
          stmt: `${ch}.recv()!`, imports: [["std/sync", "Channel"]],
          peer: [`var k: i64 = 0`, `while k < 4 {`, `    ${ch}.send(k)!`, `    k = k + 1`, `}`],
        };
      }
      case "await":
        return {
          stmt: `Promise<i64>.blocking(move(): i64 => { return 1 }).await()!`,
          imports: [["std/runtime", "Promise"]],
        };
      default:
        return { stmt: "schedulerYield()", imports: [["std/runtime", "schedulerYield"]] };
    }
  }
  // Wrap a park in a helper so the may-park summary has to be transitive.
  parkCall(park: Park): string {
    if (chance(0.6)) return park.stmt;
    const name = this.fresh("pause");
    this.fn(`fn ${name}(): void {\n    ${park.stmt}\n}`);
    return `${name}()`;
  }
  usePark(park: Park) { for (const [m, nm] of park.imports) this.use(m, nm); }

  source(): string {
    const out: string[] = [];
    for (const [mod, names] of [...this.imports.entries()].sort()) {
      out.push(`from "${mod}" import {`, `    ${[...names].sort().join(", ")}`, `}`);
    }
    for (const g of this.globals) out.push(`var ${g.name}: Vec<${g.elem}> = []`);
    out.push(...this.channels, "");
    for (const d of this.decls) out.push(d, "");
    out.push("pub fn main(): i32 {");
    for (const l of [...this.prelude, ...this.body]) out.push("    " + l);
    if (this.tasks > 0) out.push("    schedulerRunToCompletion()");
    out.push("    return 0", "}", "");
    return out.join("\n");
  }
}

// ── the shapes ────────────────────────────────────────────────────────────────

const sinkOf = (x: string, elem: Elem) =>
  elem === "string" ? `print("saw " + ${x}.len().toString())` : `print("saw " + ${x}.toString())`;

type Shape = { name: string; apply: (p: Program) => void };

const SHAPES: Shape[] = [
  // ── h3: element view of a mutable global across a park ──
  {
    name: "h3-forin-park",
    apply(p) {
      const g = p.global(pick<Elem>(["i64", "string"]));
      const park = p.park(); p.usePark(park);
      const call = p.parkCall(park);
      const w = p.writer(g);
      const reader = p.fresh("reader");
      p.fn(`fn ${reader}(): void {
    var n: i64 = 0
    for x in ${g.name} {
        if n < 3 {
            ${sinkOf("x", g.elem)}
            ${call}
        }
        n = n + 1
    }
    print("${reader} saw " + n.toString())
}`);
      p.spawn([`${reader}()`]);
      p.spawn([`${w}()`]);
      if (park.peer) p.spawn(park.peer);
    },
  },
  {
    name: "h3-slice-park",
    apply(p) {
      const g = p.global("i64");
      const park = p.park(); p.usePark(park);
      const call = p.parkCall(park);
      const w = p.writer(g);
      const s = p.fresh("s");
      p.spawn([`let ${s} = ${g.name}[0..2]`, call, `print("slice " + ${s}[0].toString())`]);
      p.spawn([`${w}()`]);
      if (park.peer) p.spawn(park.peer);
    },
  },
  {
    name: "h3-slicearg-park",
    apply(p) {
      const g = p.global("i64");
      const park = p.park(); p.usePark(park);
      const call = p.parkCall(park);
      const w = p.writer(g);
      const total = p.fresh("total");
      p.fn(`fn ${total}(xs: &[i64]): i64 {
    ${call}
    var t: i64 = 0
    for x in xs {
        t = t + x
    }
    return t
}`);
      p.spawn([`print("total " + ${total}(${g.name}).toString())`]);
      p.spawn([`${w}()`]);
      if (park.peer) p.spawn(park.peer);
    },
  },
  {
    name: "h3-elemarg-park",
    apply(p) {
      const g = p.global("string");
      const park = p.park(); p.usePark(park);
      const call = p.parkCall(park);
      const w = p.writer(g);
      const show = p.fresh("show");
      p.fn(`fn ${show}(s: &string): void {
    ${call}
    print("elem " + s.len().toString())
}`);
      p.spawn([`${show}(${g.name}[0])`]);
      p.spawn([`${w}()`]);
      if (park.peer) p.spawn(park.peer);
    },
  },
  {
    // The pointer spelling of H3: not a for-in binding, not a slice, but the same
    // buffer address held across the same park.
    name: "h3-ptr-park",
    apply(p) {
      const g = p.global("u8");
      const park = p.park(); p.usePark(park);
      const call = p.parkCall(park);
      const w = p.writer(g);
      p.use("std/os", "strlen");
      const pp = p.fresh("p");
      p.spawn([`let ${pp} = ${g.name}.ptr()`, call, `print("len " + strlen(${pp}).toString())`]);
      p.spawn([`${w}()`]);
      if (park.peer) p.spawn(park.peer);
    },
  },
  {
    // The index-loop rewrite the H3 error message recommends. Must stay accepted and
    // clean; a red here is a bug in the fix, a rejection is a false positive.
    name: "h3-index-park",
    apply(p) {
      const g = p.global(pick<Elem>(["i64", "string"]));
      const park = p.park(); p.usePark(park);
      const call = p.parkCall(park);
      const w = p.writer(g);
      const reader = p.fresh("reader");
      p.fn(`fn ${reader}(): void {
    var i: i64 = 0
    while i < ${g.name}.len {
        let x = ${g.name}[i]
        if i < 3 {
            ${sinkOf("x", g.elem)}
            ${call}
        }
        i = i + 1
    }
    print("${reader} saw " + i.toString())
}`);
      p.spawn([`${reader}()`]);
      p.spawn([`${w}()`]);
      if (park.peer) p.spawn(park.peer);
    },
  },

  // ── h4: ptr() then mutate then extern read ──
  {
    name: "h4-local-push",
    apply(p) {
      p.use("std/os", "strlen");
      const v = p.fresh("v"), pp = p.fresh("p");
      p.body.push(`var ${v}: Vec<u8> = []`, `${v}.push(65)`, `${v}.push(0)`, `let ${pp} = ${v}.ptr()`);
      p.body.push(...p.grow(v, "u8", ""));
      p.body.push(`print("len " + strlen(${pp}).toString())`);
    },
  },
  {
    name: "h4-mutref-fn",
    apply(p) {
      p.use("std/os", "strlen");
      const v = p.fresh("v"), pp = p.fresh("p"), grow = p.fresh("grow");
      p.fn(`fn ${grow}(v: &mut Vec<u8>): void {\n${p.grow("v", "u8", "    ").join("\n")}\n}`);
      p.body.push(`var ${v}: Vec<u8> = []`, `${v}.push(65)`, `${v}.push(0)`, `let ${pp} = ${v}.ptr()`,
        `${grow}(${v})`, `print("len " + strlen(${pp}).toString())`);
    },
  },
  {
    // No binding: the pointer is an inline argument, which WP8 leaves legal, but the
    // same call also takes `&mut v` and pushes through it before reading the pointer.
    name: "h4-inline-alias",
    apply(p) {
      p.use("std/os", "strlen");
      const v = p.fresh("v"), grow = p.fresh("growRead");
      p.fn(`fn ${grow}(p: *u8, v: &mut Vec<u8>): u64 {\n${p.grow("v", "u8", "    ").join("\n")}\n    return strlen(p)\n}`);
      p.body.push(`var ${v}: Vec<u8> = []`, `${v}.push(65)`, `${v}.push(0)`,
        `print("len " + ${grow}(${v}.ptr(), ${v}).toString())`);
    },
  },
  {
    name: "h4-global-callee-push",
    apply(p) {
      p.use("std/os", "strlen");
      const g = p.global("u8"), pp = p.fresh("p");
      const w = p.writer(g);
      p.body.push(`let ${pp} = ${g.name}.ptr()`, `${w}()`, `print("len " + strlen(${pp}).toString())`);
    },
  },
  {
    name: "h4-in-task",
    apply(p) {
      p.use("std/os", "strlen");
      const g = p.global("u8"), pp = p.fresh("p");
      p.spawn([`let ${pp} = ${g.name}.ptr()`, ...p.grow(g.name, "u8", ""), `print("len " + strlen(${pp}).toString())`]);
    },
  },
  {
    name: "h4-alias-let",
    apply(p) {
      p.use("std/os", "strlen");
      const v = p.fresh("v"), pp = p.fresh("p"), q = p.fresh("q");
      const viaInt = chance(0.5);
      p.body.push(`var ${v}: Vec<u8> = []`, `${v}.push(65)`, `${v}.push(0)`, `let ${pp} = ${v}.ptr()`,
        viaInt ? `let ${q} = ${pp} as i64` : `let ${q} = ${pp}`);
      p.body.push(...p.grow(v, "u8", ""));
      p.body.push(`print("len " + strlen(${viaInt ? `${q} as *u8` : q}).toString())`);
    },
  },
  {
    // The pointer escapes into a container through an inline argument, then the
    // source is pushed. No binding of `*u8` ever exists in the program text.
    name: "h4-ptr-in-vec",
    apply(p) {
      p.use("std/os", "strlen");
      const v = p.fresh("v"), ps = p.fresh("ps");
      p.body.push(`var ${v}: Vec<u8> = []`, `${v}.push(65)`, `${v}.push(0)`,
        `var ${ps}: Vec<*u8> = []`, `${ps}.push(${v}.ptr())`);
      p.body.push(...p.grow(v, "u8", ""));
      p.body.push(`print("len " + strlen(${ps}[0]).toString())`);
    },
  },
  {
    name: "h4-cstr-elem-reassign",
    apply(p) {
      p.use("std/os", "strlen");
      const g = p.global("string"), pp = p.fresh("p");
      p.body.push(`let ${pp} = ${g.name}[0].cstr()`);
      if (chance(0.5)) p.body.push(...p.grow(g.name, "string", ""));
      p.body.push(`${g.name}[0] = "${pick(WORDS)}-${pick(WORDS)}-${pick(WORDS)}"`, `print("len " + strlen(${pp}).toString())`);
    },
  },
  {
    name: "h4-ptr-then-move",
    apply(p) {
      p.use("std/os", "strlen");
      const v = p.fresh("v"), pp = p.fresh("p"), w = p.fresh("w"), take = p.fresh("take");
      p.fn(`fn ${take}(v: Vec<u8>): i64 {\n    return v.len\n}`);
      p.body.push(`var ${v}: Vec<u8> = []`, `${v}.push(65)`, `${v}.push(0)`, `let ${pp} = ${v}.ptr()`);
      p.body.push(chance(0.5) ? `let ${w} = ${v}` : `print(${take}(${v}))`);
      p.body.push(`print("len " + strlen(${pp}).toString())`);
    },
  },

  // ── h2: shards ──
  {
    // H2 as pinned by the seed fixture: the owner dies at the end of a function while a
    // blocking worker still writes through its window.
    name: "h2-owner-dropped-under-worker",
    apply(p) {
      p.use("std/shard", "Shard", "Shards", "shatter");
      p.use("std/runtime", "Promise");
      p.use("std/time", "sleepMs");
      const leak = p.fresh("leak"), junk = p.fresh("junk"), n = pick([1000, 100000]);
      p.fn(`fn ${leak}(): Promise<Shard<i64>> {
    var data: Vec<i64> = Vec.filled(${n}, 1)
    var owner = shatter(data, ${pick([1, 2, 4])})
    var ws = owner.windows()
    let w = ws.pop()!
    let pr = Promise<Shard<i64>>.blocking(move(): Shard<i64> => {
        var s = w
        sleepMs(${pick([10, 50])})
        var j: i64 = 0
        while j < s.len() {
            s.set(j, 2)
            j = j + 1
        }
        return s
    })
    return pr
}`);
      p.body.push(`let ${junk}Pr = ${leak}()`, `var ${junk}: Vec<i64> = Vec.filled(${n}, 9)`,
        `let ${junk}S = ${junk}Pr.await()!`, `print(${junk}S.get(0))`, `print(${junk}[0])`);
    },
  },
  {
    // No threads: a window is moved out to a container that outlives the owner.
    name: "h2-window-escapes-owner",
    apply(p) {
      p.use("std/shard", "Shard", "Shards", "shatter");
      const out = p.fresh("out"), junk = p.fresh("junk"), n = pick([1000, 100000]);
      if (chance(0.5)) {
        const mk = p.fresh("mk");
        p.fn(`fn ${mk}(out: &mut Vec<Shard<i64>>): void {
    var data: Vec<i64> = Vec.filled(${n}, 3)
    var owner = shatter(data, 2)
    var ws = owner.windows()
    out.push(ws.pop()!)
}`);
        p.body.push(`var ${out}: Vec<Shard<i64>> = []`, `${mk}(${out})`);
      } else {
        p.body.push(`var ${out}: Vec<Shard<i64>> = []`, `if true {`,
          `    var data: Vec<i64> = Vec.filled(${n}, 3)`, `    var owner = shatter(data, 2)`,
          `    var ws = owner.windows()`, `    ${out}.push(ws.pop()!)`, `}`);
      }
      p.body.push(`var ${junk}: Vec<i64> = Vec.filled(${n}, 9)`, `print(${out}[0].get(0))`, `print(${junk}[0])`);
    },
  },
  {
    name: "h2-window-dropped-weld",
    apply(p) {
      p.use("std/shard", "Shard", "Shards", "shatter");
      const o = p.fresh("owner"), ws = p.fresh("ws"), d = p.fresh("data");
      p.body.push(`var ${d}: Vec<i64> = Vec.filled(8, 1)`, `var ${o} = shatter(${d}, 4)`, `var ${ws} = ${o}.windows()`,
        `let _dropped${ws} = ${ws}.pop()!`,
        `match ${o}.weld(${ws}) {`,
        `    Result.Ok(v) => { print("WRONG welded " + v.len.toString()) }`,
        `    Result.Err(e) => { print("short: " + e.message()) }`,
        `}`);
    },
  },
  {
    name: "h2-reclaim-outstanding",
    apply(p) {
      p.use("std/shard", "Shard", "Shards", "shatter");
      const o = p.fresh("owner"), ws = p.fresh("ws"), d = p.fresh("data");
      p.body.push(`var ${d}: Vec<i64> = Vec.filled(8, 1)`, `var ${o} = shatter(${d}, 4)`, `var ${ws} = ${o}.windows()`,
        `match ${o}.reclaim() {`,
        `    Result.Ok(v) => { print("WRONG reclaimed " + v.len.toString()) }`,
        `    Result.Err(_back) => { print("reclaim refused") }`,
        `}`);
    },
  },
  {
    name: "h2-weld-ok",
    apply(p) {
      p.use("std/shard", "Shard", "Shards", "shatter");
      p.use("std/runtime", "Promise");
      const o = p.fresh("owner"), ws = p.fresh("ws"), d = p.fresh("data"), ps = p.fresh("ps"), dbl = p.fresh("double");
      p.fn(`fn ${dbl}(w: Shard<i64>): Shard<i64> {
    var s = w
    var j: i64 = 0
    while j < s.len() {
        s.set(j, s.get(j) * 2)
        j = j + 1
    }
    return s
}`);
      p.body.push(`var ${d}: Vec<i64> = Vec.filled(16, 1)`, `var ${o} = shatter(${d}, 4)`, `var ${ws} = ${o}.windows()`,
        `var ${ps}: Vec<Promise<Shard<i64>>> = []`,
        `while ${ws}.len > 0 {`,
        `    let w = ${ws}.pop()!`,
        `    ${ps}.push(Promise<Shard<i64>>.blocking(move(): Shard<i64> => { return ${dbl}(w) }))`,
        `}`,
        `let back${ps} = Promise.all(${ps}).await()!`,
        `match ${o}.weld(back${ps}) {`,
        `    Result.Ok(v) => { print("welded " + v[0].toString()) }`,
        `    Result.Err(e) => { print("WRONG " + e.message()) }`,
        `}`);
    },
  },
  {
    name: "h2-parallelMap",
    apply(p) {
      p.use("std/shard", "Shard", "parallelMap");
      const d = p.fresh("data"), dbl = p.fresh("double"), out = p.fresh("out");
      p.fn(`fn ${dbl}(w: Shard<i64>): Shard<i64> {
    var s = w
    var j: i64 = 0
    while j < s.len() {
        s.set(j, s.get(j) * 2)
        j = j + 1
    }
    return s
}`);
      p.body.push(`var ${d}: Vec<i64> = Vec.filled(${pick([10, 16])}, 1)`,
        `let ${out} = parallelMap(${d}, ${pick([1, 3, 4])}, ${dbl})!`, `print("mapped " + ${out}[0].toString())`);
    },
  },
  {
    // H1: Shard.get on a Drop element type hands out a bitwise copy of the string.
    name: "h1-shard-string-get",
    apply(p) {
      p.use("std/shard", "Shard", "Shards", "shatter");
      const o = p.fresh("owner"), ws = p.fresh("ws"), d = p.fresh("data");
      p.body.push(`var ${d}: Vec<string> = []`, `${d}.push("${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}")`, `${d}.push("${pick(WORDS)}")`,
        `var ${o} = shatter(${d}, 1)`, `var ${ws} = ${o}.windows()`,
        `let s${ws} = ${ws}[0].get(0)`, `print(s${ws})`);
    },
  },

  // ── bg: safe contention ──
  {
    name: "bg-writer",
    apply(p) {
      const g = p.global(pick<Elem>(["i64", "string", "u8"]));
      p.spawn([`${p.writer(g)}()`]);
    },
  },
  {
    name: "bg-channel-pingpong",
    apply(p) {
      p.use("std/sync", "Channel");
      const ch = p.fresh("ch"), prod = p.fresh("chProd");
      p.body.push(`let ${ch} = Channel<i64>.new(1)!`, `let ${prod} = ${ch}.clone()`);
      p.spawn([`var i: i64 = 0`, `while i < 4 {`, `    let v = ${ch}.recv()!`, `    print("got " + v.toString())`, `    i = i + 1`, `}`]);
      p.spawn([`var i: i64 = 0`, `while i < 4 {`, `    ${prod}.send(i)!`, `    i = i + 1`, `}`]);
    },
  },
  {
    name: "bg-blocking-sum",
    apply(p) {
      p.use("std/runtime", "Promise");
      const v = p.fresh("v"), pr = p.fresh("pr");
      p.body.push(`var ${v}: Vec<i64> = Vec.filled(${pick([100, 5000])}, 2)`,
        `let ${pr} = Promise<i64>.blocking(move(): i64 => {`,
        `    var t: i64 = 0`, `    for x in ${v} {`, `        t = t + x`, `    }`, `    return t`, `})`,
        `print("sum " + ${pr}.await()!.toString())`);
    },
  },
];

// ── generation ────────────────────────────────────────────────────────────────

interface Case { name: string; src: string; shapes: string[] }

function generate(i: number): Case {
  const p = new Program();
  const usable = SHAPES.filter(s => s.name.includes(FILTER));
  if (usable.length === 0) { console.error(`--filter=${FILTER} matches no shape`); process.exit(2); }
  const count = chance(0.5) ? 1 : chance(0.6) ? 2 : 3;
  for (let k = 0; k < count; k++) {
    const s = pick(usable);
    p.shapes.push(s.name);
    s.apply(p);
  }
  return { name: `case${SEED}_${i}`, src: p.source(), shapes: p.shapes };
}

const SEEDS = [
  "tests/fixtures/hole2-shards-owner-dropped-under-worker.milo",
  "tests/errors/globalForInAcrossYield.milo",
  "tests/holes-2026-09/hole4-vec-ptr-outlives-realloc.milo",
];

// ── the oracles ───────────────────────────────────────────────────────────────

interface Verdict {
  kind: "rejected" | "build-failed" | "clean" | "asan" | "aborted";
  bucket: string;    // rejected: normalized first error; asan: report kind; aborted: first stderr line
  detail: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const ASAN_REPORT = /ERROR: AddressSanitizer: ([a-zA-Z-]+)/;

function exec(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + "\n" + stderr).replace(ANSI, "") }));
  });
}

// Error messages name the program's own identifiers and line numbers, so the bucket
// key strips both; the first message seen keeps its names as the bucket's example.
const normalize = (msg: string) => msg.replace(/'[^']*'/g, "'_'").replace(/\b\d+\b/g, "N");

async function judge(file: string, bin: string, runTimeoutMs = RUN_TIMEOUT_MS): Promise<Verdict> {
  const build = await exec("bun", [MILO, "build", "--sanitize", file, "-o", bin], BUILD_TIMEOUT_MS);
  if (!build.ok) {
    const err = build.out.split("\n").map(l => l.trim()).find(l => /^error(\[[^\]]*\])?: /.test(l));
    if (err) {
      const msg = err.replace(/^error(\[[^\]]*\])?: /, "");
      return { kind: "rejected", bucket: normalize(msg), detail: msg };
    }
    const first = build.out.split("\n").find(l => l.trim()) ?? "build failed";
    return { kind: "build-failed", bucket: normalize(first.trim()), detail: first.trim() };
  }
  const run = await guardedRun(bin, [], {
    memMb: RUN_MEM_MB, timeoutMs: runTimeoutMs, cwd: ROOT,
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
  });
  const m = ASAN_REPORT.exec(run.stderr);
  if (m) return { kind: "asan", bucket: m[1]!, detail: `AddressSanitizer: ${m[1]}` };
  if (run.code !== 0 || run.guardKill) {
    const first = run.guardKill ? `guard kill: ${run.guardKill}` : (run.stderr.split("\n").find(l => l.trim()) ?? `exit ${run.code}`).trim();
    return { kind: "aborted", bucket: normalize(first), detail: first };
  }
  return { kind: "clean", bucket: "", detail: "" };
}

// A sanitizer that links but does not instrument reports every program clean, which is
// the one outcome this harness must never mistake for a pass. The probe is a `strlen`
// over a buffer with no NUL: an inline `ptr()` with no mutation, so it stays legal under
// WP8 (which now rejects the use-after-free probe fuzz-ownership.ts uses, `unsafe` or not).
async function assertAsanWorks(dir: string): Promise<void> {
  const probe = join(dir, "__asan_selfcheck.milo");
  writeFileSync(probe, `from "std/os" import { strlen }
fn main() {
    var v: Vec<u8> = Vec.filled(8, 65)
    print(strlen(v.ptr()))
}
`);
  const v = await judge(probe, join(dir, "__asan_selfcheck"));
  if (v.kind !== "asan" || v.bucket !== "heap-buffer-overflow") {
    console.error(`ASan self-check FAILED: a deliberate use-after-free read was reported as ${v.kind} ${v.detail}`);
    console.error("Refusing to run: results would read as clean for the class ASan is here to catch.");
    process.exit(2);
  }
}

// ── ddmin ─────────────────────────────────────────────────────────────────────

// Every build+run in the process goes through this gate, so ddmin probing in parallel
// never multiplies the guard math: at most JOBS guarded children exist at any moment.
let inflight = 0;
const waiters: (() => void)[] = [];
async function gated<T>(f: () => Promise<T>): Promise<T> {
  if (inflight >= JOBS) await new Promise<void>(r => waiters.push(r));
  inflight++;
  try { return await f(); } finally { inflight--; waiters.shift()?.(); }
}

const balanced = (lines: string[]) => {
  let d = 0;
  for (const l of lines) for (const ch of l) {
    if (ch === "{") d++;
    else if (ch === "}" && --d < 0) return false;
  }
  return d === 0;
};

// Line-granularity ddmin, then a pass that unwraps `header {` … `}` pairs the line
// pass cannot remove one at a time. Interesting means "still builds and still the same
// ASan report kind": a candidate the checker rejects, or that trips a different
// report, is not smaller evidence of the same bug. Brace-unbalanced candidates are
// skipped before paying for a build. Candidates in one round are probed JOBS at a
// time; the first interesting one in order wins, so a seed reduces the same way twice.
async function reduce(src: string, kind: string, dir: string, tag: string): Promise<{ src: string; probes: number }> {
  let probes = 0;
  const seen = new Set<string>();
  const test = async (lines: string[]): Promise<boolean> => {
    const key = lines.join("\n");
    if (seen.has(key) || !balanced(lines) || probes >= REDUCE_PROBES) return false;
    seen.add(key);
    const id = `${tag}_r${probes++}`;
    const file = join(dir, `${id}.milo`);
    writeFileSync(file, key + "\n");
    const v = await gated(() => judge(file, join(dir, id), REDUCE_TIMEOUT_MS));
    return v.kind === "asan" && v.bucket === kind;
  };
  const firstInteresting = async (cands: string[][]): Promise<string[] | null> => {
    for (let b = 0; b < cands.length; b += JOBS) {
      const rs = await Promise.all(cands.slice(b, b + JOBS).map(test));
      const k = rs.indexOf(true);
      if (k >= 0) return cands[b + k]!;
    }
    return null;
  };

  let lines = src.split("\n").filter(l => l.trim() !== "" && !l.trim().startsWith("//"));
  let n = 2;
  while (lines.length >= 2 && probes < REDUCE_PROBES) {
    const chunk = Math.ceil(lines.length / n);
    const cands: string[][] = [];
    for (let i = 0; i < lines.length; i += chunk) {
      const cand = [...lines.slice(0, i), ...lines.slice(i + chunk)];
      if (cand.length > 0) cands.push(cand);
    }
    const hit = await firstInteresting(cands);
    if (hit) { lines = hit; n = Math.max(n - 1, 2); continue; }
    if (n >= lines.length) break;
    n = Math.min(n * 2, lines.length);
  }

  // Unwrap: for each `… {` line find its `}` and try dropping just the two, keeping
  // (and dedenting) what was inside. Repeats until nothing more comes off.
  let changed = true;
  while (changed && probes < REDUCE_PROBES) {
    changed = false;
    for (let i = 0; i < lines.length && !changed; i++) {
      if (!lines[i]!.trimEnd().endsWith("{")) continue;
      let d = 0, j = i;
      for (; j < lines.length; j++) {
        for (const ch of lines[j]!) { if (ch === "{") d++; else if (ch === "}") d--; }
        if (d === 0) break;
      }
      if (j >= lines.length || j === i) continue;
      const inner = lines.slice(i + 1, j).map(l => l.startsWith("    ") ? l.slice(4) : l);
      const cand = [...lines.slice(0, i), ...inner, ...lines.slice(j + 1)];
      if (await test(cand)) { lines = cand; changed = true; }
    }
  }
  return { src: lines.join("\n") + "\n", probes };
}

// ── driver ────────────────────────────────────────────────────────────────────

async function pool<T, R>(items: T[], jobs: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]!, i); }
  }));
  return out;
}

interface Result { c: Case; v: Verdict; file: string }

async function main() {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "milo-taskfuzz-"));
  await assertAsanWorks(dir);

  const cases: Case[] = [];
  if (!NO_SEEDS && FILTER === "") {
    for (const s of SEEDS) {
      const abs = join(ROOT, s);
      if (!existsSync(abs)) { console.log(`seed missing: ${s}`); continue; }
      cases.push({ name: `seed_${s.split("/").pop()!.replace(/\.milo$/, "")}`, src: readFileSync(abs, "utf-8"), shapes: [`seed:${s}`] });
    }
  }
  for (let i = 0; i < N; i++) cases.push(generate(i));

  const results = await pool(cases, JOBS, async (c, i): Promise<Result> => {
    const file = join(dir, `${c.name}.milo`);
    writeFileSync(file, c.src);
    const v = await gated(() => judge(file, join(dir, c.name)));
    if (VERBOSE) console.log(`${String(i).padStart(4)} ${v.kind.padEnd(12)} ${c.shapes.join("+")}${v.detail ? "  " + v.detail : ""}`);
    return { c, v, file };
  });
  const genMs = Date.now() - t0;

  // ── reduce ──
  const reds = results.filter(r => r.v.kind === "asan");
  // A red program with three shapes is almost always red because of one of them. Any
  // shape that went red ALONE in this run is a known culprit, so a multi-shape red is
  // filed under its culprit shapes and only one representative per file is reduced;
  // a red with no known culprit keeps its full shape set and is always reduced.
  const culprits = new Set(reds.filter(r => new Set(r.c.shapes).size === 1).map(r => r.c.shapes[0]!));
  const knownOf = (r: Result) => [...new Set(r.c.shapes)].filter(s => culprits.has(s));
  const sigOf = (r: Result) => {
    const known = knownOf(r);
    return `${(known.length > 0 ? known : [...new Set(r.c.shapes)]).sort().join("+")} :: ${r.v.bucket}`;
  };
  const bySig = new Map<string, Result[]>();
  for (const r of reds) bySig.set(sigOf(r), [...(bySig.get(sigOf(r)) ?? []), r]);
  // Two known culprits in one program is not a new bug; its solo signatures are reduced
  // instead, and the line in the report says so.
  const worthReducing = (rs: Result[]) => knownOf(rs[0]!).length <= 1;
  // The representative is the smallest program in the file: fewest shapes, then
  // shortest source, so ddmin starts close to the answer instead of at three shapes.
  const smallest = (rs: Result[]) => [...rs].sort((a, b) =>
    new Set(a.c.shapes).size - new Set(b.c.shapes).size || a.c.src.length - b.c.src.length)[0]!;
  const toReduce = REDUCE_ALL ? reds : [...bySig.values()].filter(worthReducing).map(smallest);
  const outDir = join(ROOT, ".fuzz-findings", "tasks");
  if (reds.length > 0) mkdirSync(outDir, { recursive: true });
  const reduced = await pool(toReduce, JOBS, async r => {
    const { src, probes } = await reduce(r.c.src, r.v.bucket, dir, r.c.name);
    const kept = join(outDir, `${r.c.name}.milo`);
    writeFileSync(kept, `// ${r.v.detail}; shapes: ${r.c.shapes.join("+")}; seed ${SEED}\n${src}`);
    return { r, src, probes, kept };
  });

  // ── report ──
  const count = (k: Verdict["kind"]) => results.filter(r => r.v.kind === k).length;
  console.log(`seed ${SEED}, ${cases.length} programs (${cases.length - N} seeds + ${N} generated), jobs ${JOBS}, ${SHAPES.filter(s => s.name.includes(FILTER)).length} shapes${FILTER ? ` (filter '${FILTER}')` : ""}`);
  console.log(`generated:            ${cases.length}`);
  console.log(`rejected by checker:  ${count("rejected")}`);
  // Per bucket, the shapes listed are those that drew the message in a ONE-shape
  // program; a bystander shape in a three-shape program is not what the checker saw.
  const buckets = new Map<string, { n: number; example: string; solo: Set<string>; all: Set<string> }>();
  for (const r of results.filter(r => r.v.kind === "rejected")) {
    const b = buckets.get(r.v.bucket) ?? { n: 0, example: r.v.detail, solo: new Set<string>(), all: new Set<string>() };
    b.n++;
    for (const s of r.c.shapes) { b.all.add(s); if (new Set(r.c.shapes).size === 1) b.solo.add(s); }
    buckets.set(r.v.bucket, b);
  }
  for (const [, b] of [...buckets.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${String(b.n).padStart(4)}  ${b.example}`);
    console.log(`          shapes: ${[...(b.solo.size > 0 ? b.solo : b.all)].sort().join(", ")}`);
  }
  if (count("build-failed") > 0) {
    console.log(`build failed (not a diagnostic): ${count("build-failed")}`);
    for (const r of results.filter(r => r.v.kind === "build-failed")) console.log(`    ${r.c.name}: ${r.v.detail}`);
  }
  if (count("aborted") > 0) {
    console.log(`aborted without an ASan report: ${count("aborted")}`);
    for (const r of results.filter(r => r.v.kind === "aborted")) console.log(`    ${r.c.name} [${r.c.shapes.join("+")}]: ${r.v.detail}`);
  }
  console.log(`ran clean:            ${count("clean")}`);
  console.log(`ASan red:             ${reds.length}`);
  for (const [sig, rs] of [...bySig.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${String(rs.length).padStart(4)}  ${sig}${!REDUCE_ALL && !worthReducing(rs) ? "  (two known culprits; not reduced)" : ""}`);
  }
  if (reduced.length > 0) {
    console.log(`\nREDUCED (${reduced.length} of ${reds.length} reds, one per new signature${REDUCE_ALL ? "" : "; --reduce-all for every one"}):`);
    for (const { r, src, probes, kept } of reduced) {
      console.log(`\n── ${r.v.detail} [${r.c.shapes.join("+")}] after ${probes} probes → ${kept}`);
      console.log(src.split("\n").filter(l => l !== "").map(l => "    " + l).join("\n"));
    }
  }
  console.log(`\nwall time: ${((Date.now() - t0) / 1000).toFixed(1)}s (generate+judge ${(genMs / 1000).toFixed(1)}s, reduce ${((Date.now() - t0 - genMs) / 1000).toFixed(1)}s)`);
  if (KEEP) console.log(`kept: ${dir}`); else rmSync(dir, { recursive: true, force: true });

  // A run where nothing accepted reached execution proves nothing about a checker
  // that accepts too much.
  if (count("clean") + reds.length === 0) { console.log("VACUOUS RUN: no accepted program reached execution."); process.exit(2); }
  process.exit(reds.length > 0 ? 1 : 0);
}

main();
