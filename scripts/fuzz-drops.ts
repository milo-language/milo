// Destructor accounting as a falsifiable invariant: every value constructed must be
// destroyed exactly once, on every path, through generated compositions of ownership forms.
//
// No per-shape expected output and no model of what the program means. A generated
// program builds heap-owning `Res` values (a counted constructor, a counted Clone, a
// counting Drop, and a string field so a double free or a stale read is a heap event),
// moves them through nested forms with early exits, and asks itself whether the books
// balance. Four oracles, every one of which has caught a bug the others missed:
//
//   balance   the program prints `made` then `gone`; they must agree. The only oracle
//             that sees a destructor which never runs on a value owning no stray heap
//             (ASan and `leaks` are both silent), or a spurious drop of a zeroed slot.
//   ASan      the build is `--sanitize`; any AddressSanitizer report is a finding
//             (double free, use after free). Leak detection is off: macOS has no LSan.
//   ledger    the same build runs with MILO_OWN_LEDGER=1 (docs/testing.md): any
//             `own-ledger:` finding is a failure, as is a ledger-mode compiler throw
//             (an owned copy with no declared intent). This is the only oracle for a
//             leaked clone or a leaked temporary string, which no Drop count can see:
//             `[v; N]`'s original, `match v[i]`'s clone, an extern `*u8` temp.
//   integrity every read goes through `chk`, which prints CORRUPT when a Res's name
//             does not match its id: a box emptied by a read (`print(*h)`) or a slot
//             read after its bytes were reused.
//
// The generator is recursive. A program is `fn body(k)` run for k = 0..3 (so the
// k-dependent conditions take every arm across the four runs), holding a few forms;
// a container form (a for-in of any iterable kind, `if`, `while`, a match arm) nests
// more forms, up to MAX_DEPTH. Inside a loop a form may `break` or `continue`, and
// anywhere it may `return` or `?`, so every value live at an exit has to be dropped by
// the exit. The forms are the shapes that produced real memory bugs (October 2026):
// for-in over a user `next()` iterator, a Channel, a generic `I: Iterator`, a fork
// (`if c { v } else { w }`), a temporary Vec or array literal; struct update
// `S { a: x, ..base }`; an array literal passed to `[T; n]` and to `&[T]`;
// `getOrDefault(k, named)`; a match on string literals; `*h` reads and moves out of a
// Heap; Option/Result combinators; `[v; N]`; `match v[i]`; an extern `*u8` temp. The
// older flat fragments (closures, tasks, containers) are leaf forms beside them.
//
// Named bindings are modelled: a form may move a live `Res` binding (into a call, an
// array literal, a Vec, a struct update) and the model marks it dead, so later forms
// never name it and the checker should accept the program. A rejection is counted and
// bucketed, not investigated (the accept direction is what this hunts), but a run whose
// programs mostly fail to build is vacuous and exits 2.
//
//   bun scripts/fuzz-drops.ts --cases 200 --seed 1
//   bun scripts/fuzz-drops.ts --cases 40 --filter heap     # only forms whose name has "heap"
//   bun scripts/fuzz-drops.ts --cases 2000 --jobs 6 --reduce-probes 80
//   bun scripts/fuzz-drops.ts --forms                      # list form names
//
// Reds are reduced (greedy statement deletion, same failure signature) and written to
// .fuzz-findings/drops/. Exit 1 on any finding, 2 when the run was vacuous.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir, cpus } from "os";
import { guardedRun } from "./guard";

const args = process.argv.slice(2);
const num = (flag: string, dflt: number) => {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq) return parseInt(eq.slice(flag.length + 1), 10);
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1]!, 10) : dflt;
};
const str = (flag: string): string | null => {
  const eq = args.find(a => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};
const CASES = num("--cases", 200);
const SEED = num("--seed", 1);
const JOBS = num("--jobs", Math.max(1, Math.min(6, Math.floor(cpus().length / 2))));
const REDUCE_PROBES = num("--reduce-probes", 60);
const FILTER = str("--filter");
const KEEP = args.includes("--keep");
// Also generate the spellings of OPEN bugs, which every run would otherwise report.
// Each is listed where it is gated. Remove a gate in the change that fixes it.
const KNOWN = args.includes("--known");
// The open bugs, minimal (each also behind KNOWN where it is generated):
//   (none open)
void KNOWN;
// Judge only this case index (the generator still runs every earlier case, so the
// program is the one the full run saw).
const ONLY = num("--only", -1);
const VERBOSE = args.includes("--verbose");
const ROOT = join(import.meta.dir, "..");
const MILO = join(ROOT, "src", "main.ts");
const OUT = join(ROOT, ".fuzz-findings", "drops");

// deterministic PRNG so a failing case is reproducible from its seed alone
let state = SEED >>> 0 || 1;
function rnd(): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (p: number) => rnd() < p;
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

// The counters are atomics because a Res moved into Promise.blocking drops on a worker
// thread; plain globals there are a data race the checker rejects. `newRes` and
// `Res.clone` are the only ways a Res comes into being, and both count.
const PRELUDE = `from "std/runtime" import { Task, Promise }
from "std/sync" import { AtomicI64, Channel }

var sink2: i64 = 0
let made: AtomicI64 = AtomicI64.new(0)
let gone: AtomicI64 = AtomicI64.new(0)

extern fn strlen(s: *u8): u64

struct Res {
    id: i64,
    name: string,
}

impl Drop for Res {
    fn drop(self: &mut Self): void {
        gone.add(1)
    }
}

impl Clone for Res {
    fn clone(self: &Self): Self {
        made.add(1)
        return Res { id: self.id, name: self.name.clone() }
    }
}

impl Res {
    fn get(self: &Self): i64 {
        return chk(self)
    }
}

struct Wrap {
    inner: Res,
}

// A Drop type that owns no heap. Drop glue cannot probe it for "already moved out", so
// a zeroed leftover runs its Drop: that is what made 5aba5dc5's emptied Heap print a
// spurious drop, invisible with Res (whose null name makes the glue skip it). Ids start
// at 1000, so a drop of a zeroed Tok is visible as well as counted.
struct Tok {
    id: i64,
}

impl Drop for Tok {
    fn drop(self: &mut Self): void {
        gone.add(1)
        if self.id < 1000 {
            print("CORRUPT drop of a zeroed Tok")
        }
    }
}

fn newTok(n: i64): Tok {
    made.add(1)
    return Tok { id: n + 1000 }
}

fn useTok(t: Tok): i64 {
    return t.id
}

struct Pair {
    a: Res,
    b: Res,
    n: i64,
}

struct Gen {
    i: i64,
    lim: i64,
    tag: Res,
}

impl Gen {
    fn next(self: &mut Self): Option<Res> {
        if self.i >= self.lim {
            return Option.None
        }
        self.i = self.i + 1
        return Option.Some(newRes(self.i))
    }
}

impl Iterator for Gen {
}

fn newRes(n: i64): Res {
    made.add(1)
    return Res { id: n, name: "res-heap-name-" + n.toString() }
}

// Integrity: a Res whose name no longer spells its id was read after its bytes were
// emptied, zeroed or reused.
fn chk(r: &Res): i64 {
    if r.name != "res-heap-name-" + r.id.toString() {
        print("CORRUPT id=" + r.id.toString() + " name=" + r.name)
    }
    return r.id
}

fn useRes(r: Res): i64 {
    return chk(r)
}

fn mkPair(n: i64): Pair {
    return Pair { a: newRes(n), b: newRes(n + 1), n: n }
}

fn gen(k: i64): Gen {
    return Gen { i: 0, lim: k % 3 + 1, tag: newRes(k + 50) }
}

fn vecOf(k: i64): Vec<Res> {
    var v: Vec<Res> = Vec.new()
    v.push(newRes(k))
    v.push(newRes(k + 1))
    return v
}

fn chanOf(k: i64): Channel<Res> {
    let c = Channel<Res>.new(4)!
    c.send(newRes(k))!
    c.send(newRes(k + 1))!
    c.close()
    return c
}

fn sumIter<I: Iterator>(it: I): i64 {
    var s = 0
    var iter = it
    for x in iter {
        s = s + chk(x)
    }
    return s
}

fn firstOf<I: Iterator>(it: I): i64 {
    var iter = it
    for x in iter {
        return chk(x)
    }
    return -1
}

fn sum2(a: [Res; 2]): i64 {
    return chk(a[0]) + chk(a[1])
}

fn sumSlice(a: &[Res]): i64 {
    var t = 0
    for x in a {
        t = t + chk(x)
    }
    return t
}

fn nameOf(k: i64): string {
    return "nm" + (k % 3).toString()
}

fn maybe(k: i64): Option<Res> {
    if k % 2 == 0 {
        return Option.Some(newRes(k))
    }
    return Option.None
}

fn errOr(k: i64): Result<Res, Res> {
    if k % 2 == 0 {
        return Result.Ok(newRes(k))
    }
    return Result.Err(newRes(k + 100))
}

fn b2i(b: bool): i64 {
    if b {
        return 1
    }
    return 0
}

fn callIt(f: move () => i64): i64 {
    return f()
}

fn makeClosure(n: i64): move () => i64 {
    let r = newRes(n)
    return move () => chk(r)
}

fn earlyOut(n: i64): i64 {
    let r = newRes(n)
    if r.id >= 0 {
        return 1
    }
    return 0
}
`;

// ── the model ─────────────────────────────────────────────────────────────────
//
// `owned` bindings hold a Res by value and may be moved, but only from the loop depth
// they were declared at: a move out of an outer binding inside a loop is a use after
// move on the second iteration, and the checker is right to reject it. `ref` bindings
// (a for-in over a named Vec, a match payload of a cloned subject) are only read.
interface Binding { name: string; owned: boolean; live: boolean; loop: number }

class Gen {
  lines: string[] = [];
  forms: string[] = [];
  private n = 0;
  indent = 1;
  depth = 0;
  loop = 0;           // enclosing loops inside `body`
  scope: Binding[] = [];

  fresh(p: string) { return `${p}${this.n++}`; }
  emit(l: string) { for (const part of l.split("\n")) this.lines.push("    ".repeat(this.indent) + part); }
  open(l: string) { this.emit(l); this.indent++; }
  close(l = "}") { this.indent--; this.emit(l); }

  // A nested block: bindings declared inside vanish at its end; a move inside it
  // kills the outer binding for good (the checker sees a maybe-moved value), and
  // nothing inside can bring one back.
  nest(header: string, loop: boolean, bind: Binding | null, footer = "}") {
    const mark = this.scope.length;
    this.open(header);
    this.depth++;
    if (loop) this.loop++;
    if (bind) this.scope.push({ ...bind, loop: this.loop });
    fill(this, between(1, 3));
    if (loop) this.loop--;
    this.depth--;
    this.scope.length = mark;
    this.close(footer);
  }

  live() { return this.scope.filter(b => b.live); }
  movable() { return this.scope.filter(b => b.live && b.owned && b.loop === this.loop); }
  bind(name: string, owned = true) { this.scope.push({ name, owned, live: true, loop: this.loop }); }

  // A k-dependent condition, so the four runs of `body` take different arms.
  cond(): string {
    const live = this.live();
    if (live.length > 0 && chance(0.3)) return `${pick(live).name}.id % 2 == ${between(0, 1)}`;
    return pick(["k % 2 == 0", "k > 1", "k == 3", "k < 2", "k != 1"]);
  }
  k(): string { return pick(["k", "k + 1", "0", "k * 2", "3"]); }

  // A Res rvalue. Moves a live binding some of the time, which is how the forms below
  // compose with each other: a value made by one form is consumed inside another.
  // Read in place (`(v).get()`, `(v).name`), an if/match value owns itself and is
  // dropped after the read.
  res(depth = 0): string {
    const mv = this.movable();
    if (mv.length > 0 && chance(0.35)) {
      const b = pick(mv);
      b.live = false;
      return b.name;
    }
    if (depth < 1) {
      switch (between(0, 7)) {
        case 0: return `*Heap(newRes(${this.k()}))`;
        case 1: return `if ${this.cond()} { ${this.res(depth + 1)} } else { ${this.res(depth + 1)} }`;
        case 2: return `match maybe(${this.k()}) {\n    Option.Some(q) => q,\n    Option.None => newRes(${this.k()}),\n}`;
        case 3: return `match errOr(${this.k()}) {\n    Result.Ok(q) => q,\n    Result.Err(e) => e,\n}`;
        case 4: return `mkPair(${this.k()}).${pick(["a", "b"])}`;
      }
    }
    return `newRes(${this.k()})`;
  }

  // A read of something live, or a fresh temporary's field.
  read(): string {
    const live = this.live();
    if (live.length > 0 && chance(0.6)) return `chk(${pick(live).name})`;
    // a read through a box nobody owns frees the box and drops the payload after it
    if (chance(0.2)) return `chk(*Heap(${this.res()}))`;
    return `(${this.res()}).get()`;
  }

  // An i64 that consumes or inspects Res values. Each alternative is one bug's shape.
  int(which = between(0, 16)): string {
    switch (which) {
      case 0: return this.read();
      case 1: return `useRes(${this.res()})`;
      case 2: { const a = this.res(); const b = this.res(); return `sum2([${a}, ${b}])`; }
      case 3: { const a = this.res(); const b = this.res(); return `sumSlice([${a}, ${b}])`; }
      case 4: return `sumIter(gen(${this.k()}))`;
      case 5: return `firstOf(gen(${this.k()}))`;
      case 6: return `maybe(${this.k()}).map((r) => chk(r)).unwrapOr(0)`;
      case 7: return `errOr(${this.k()}).map((r) => chk(r)).unwrapOr(0)`;
      case 8: return `b2i(errOr(${this.k()}).mapErr((e) => chk(e)).isOk())`;
      case 9: return `b2i(maybe(${this.k()}).orElse(() => maybe(${this.k()})).isSome())`;
      case 10: return `b2i(errOr(${this.k()}).andThen((r) => errOr(r.id)).isErr())`;
      case 11: return `maybe(${this.k()}).map((r) => r.name.len()).unwrapOr(0)`;
      case 12: return `maybe(${this.k()}).andThen((r) => maybe(r.id)).map((r) => chk(r)).unwrapOr(0)`;
      case 13: return `b2i(errOr(${this.k()}).orElse((e) => errOr(e.id)).isOk())`;
      case 14: return `match nameOf(${this.k()}) {\n    "nm0" => 1,\n    "nm1" => 2,\n    _ => 0,\n}`;
      case 15: return `useRes(*Heap(${this.res()}))`;
      default: return `earlyOut(${this.k()})`;
    }
  }

  sink(e: string) { this.emit(`sink = sink + ${e}`); }
}

// ── the forms ─────────────────────────────────────────────────────────────────
//
// `container` forms nest more forms and stop at MAX_DEPTH. Each form names the bug
// class it encodes in a comment only where the shape alone does not say it.
type Form = { name: string; container?: boolean; apply: (g: Gen) => boolean };

const forIn = (g: Gen, iterable: string, owned: boolean, pre: string[] = []) => {
  for (const l of pre) g.emit(l);
  const r = g.fresh("r");
  g.nest(`for ${r} in ${iterable} {`, true, { name: r, owned, live: true, loop: 0 });
};

const FORMS: Form[] = [
  { name: "let", apply(g) { const x = g.fresh("x"); g.emit(`let ${x} = ${g.res()}`); g.bind(x); return true; } },
  { name: "sink", apply(g) { g.sink(g.int()); return true; } },
  { name: "sink", apply(g) { g.sink(g.int()); return true; } },
  {
    name: "move-binding",
    apply(g) {
      const mv = g.movable();
      if (mv.length === 0) return false;
      const b = pick(mv);
      b.live = false;
      switch (between(0, 3)) {
        case 0: g.sink(`useRes(${b.name})`); break;
        case 1: g.emit(`kept.push(${b.name})`); break;
        case 2: g.sink(`sum2([${b.name}, newRes(${g.k()})])`); break;
        default: { const w = g.fresh("w"); g.emit(`let ${w} = Wrap { inner: ${b.name} }`); g.sink(`chk(${w}.inner)`); }
      }
      return true;
    },
  },
  {
    name: "reassign",
    apply(g) {
      const y = g.fresh("y");
      g.emit(`var ${y} = ${g.res()}`);
      g.emit(`${y} = ${g.res()}`);
      g.sink(`chk(${y})`);
      g.bind(y);
      return true;
    },
  },
  // ── exits ──
  {
    name: "exit-loop",
    apply(g) {
      if (g.loop === 0) return false;
      g.emit(`if ${g.cond()} {\n    ${pick(["break", "continue"])}\n}`);
      return true;
    },
  },
  {
    name: "exit-return",
    apply(g) { g.emit(`if ${g.cond()} {\n    return Option.Some(sink)\n}`); return true; },
  },
  {
    name: "exit-try",
    apply(g) {
      if (chance(0.5)) { const x = g.fresh("x"); g.emit(`let ${x} = maybe(${g.k()})?`); g.bind(x); }
      else g.sink(`maybe(${g.k()})?.get()`);
      return true;
    },
  },
  // ── for-in, one form per iterable kind ──
  { name: "for-next", container: true, apply(g) { forIn(g, `gen(${g.k()})`, true); return true; } },
  {
    name: "for-next-named",
    container: true,
    apply(g) { const it = g.fresh("it"); forIn(g, it, true, [`var ${it} = gen(${g.k()})`]); return true; },
  },
  { name: "for-channel", container: true, apply(g) { forIn(g, `chanOf(${g.k()})`, true); return true; } },
  { name: "for-generic-iter", apply(g) { g.sink(pick([`sumIter(gen(${g.k()}))`, `firstOf(gen(${g.k()}))`])); return true; } },
  {
    name: "for-fork",
    container: true,
    apply(g) {
      const v = g.fresh("v"), w = g.fresh("w");
      const pre = [`let ${v} = vecOf(${g.k()})`, `let ${w} = vecOf(${g.k()})`];
      if (chance(0.5)) forIn(g, `if ${g.cond()} { ${v} } else { ${w} }`, true, pre);
      else {
        for (const l of pre) g.emit(l);
        const r = g.fresh("r");
        g.nest(`for ${r} in match k % 3 {\n    0 => ${v},\n    _ => ${w},\n}\n{`, true, { name: r, owned: true, live: true, loop: 0 });
      }
      return true;
    },
  },
  { name: "for-temp-vec", container: true, apply(g) { forIn(g, `vecOf(${g.k()})`, true); return true; } },
  {
    name: "for-temp-array",
    container: true,
    apply(g) { const a = g.res(), b = g.res(); forIn(g, `[${a}, ${b}]`, true); return true; },
  },
  {
    name: "for-borrow",
    container: true,
    apply(g) { const v = g.fresh("v"); forIn(g, v, false, [`let ${v} = vecOf(${g.k()})`]); return true; },
  },
  // ── control ──
  {
    name: "if",
    container: true,
    apply(g) {
      const mark = g.scope.length;
      g.open(`if ${g.cond()} {`);
      g.depth++; fill(g, between(1, 2)); g.depth--;
      g.scope.length = mark;
      g.close("} else {");
      g.indent++;
      g.depth++; fill(g, between(1, 2)); g.depth--;
      g.scope.length = mark;
      g.close();
      return true;
    },
  },
  {
    name: "while",
    container: true,
    apply(g) {
      // The counter steps first so a `continue` in the body cannot spin forever.
      const i = g.fresh("i");
      g.emit(`var ${i}: i64 = 0`);
      const mark = g.scope.length;
      g.open(`while ${i} < ${between(1, 3)} {`);
      g.emit(`${i} = ${i} + 1`);
      g.depth++; g.loop++;
      fill(g, between(1, 3));
      g.loop--; g.depth--;
      g.scope.length = mark;
      g.close();
      return true;
    },
  },
  // ── the October bug shapes ──
  {
    name: "struct-update",
    apply(g) {
      const p = g.fresh("p");
      let base = `mkPair(${g.k()})`;
      if (chance(0.5)) { const b = g.fresh("b"); g.emit(`let ${b} = ${base}`); base = b; }
      const fields = pick([["a"], ["b"], ["a", "b"], ["n"], []]);
      const inits = fields.map(f => f === "n" ? "n: 7" : `${f}: ${g.res()}`);
      g.emit(`let ${p} = Pair { ${[...inits, `..${base}`].join(", ")} }`);
      g.sink(`chk(${p}.a) + chk(${p}.b) + ${p}.n`);
      if (chance(0.3)) { const x = g.fresh("x"); g.emit(`let ${x} = ${p}.${pick(["a", "b"])}`); g.bind(x); }
      return true;
    },
  },
  { name: "array-arg", apply(g) { const a = g.res(), b = g.res(); g.sink(`sum2([${a}, ${b}])`); return true; } },
  { name: "array-slice-arg", apply(g) { const a = g.res(), b = g.res(); g.sink(`sumSlice([${a}, ${b}])`); return true; } },
  {
    name: "get-or-default",
    apply(g) {
      const m = g.fresh("m"), d = g.fresh("d");
      g.emit(`var ${m}: HashMap<i64, string> = HashMap.new()`);
      g.emit(`${m}.insert(1, "map-value-on-the-heap-" + nameOf(${g.k()}))`);
      if (chance(0.7)) {
        g.emit(`let ${d}: string = "default-on-the-heap-" + nameOf(${g.k()})`);
        g.sink(`${m}.getOrDefault(k % 2, ${d}).len()`);
      } else g.sink(`${m}.getOrDefault(k % 2, nameOf(${g.k()})).len()`);
      return true;
    },
  },
  {
    name: "match-literal",
    container: true,
    apply(g) {
      let subj = `nameOf(${g.k()})`;
      const named = chance(0.4);
      if (named) { const s = g.fresh("s"); g.emit(`let ${s} = ${subj}`); subj = s; }
      const mark = g.scope.length;
      g.open(`match ${subj} {`);
      g.open(`"${pick(["nm0", "nm1", "nm2"])}" => {`);
      g.depth++; fill(g, between(1, 2)); g.depth--;
      g.scope.length = mark;
      g.close();
      g.emit(`_ => {}`);
      g.close();
      if (named) g.sink(`${subj}.len()`);
      return true;
    },
  },
  {
    name: "heap",
    apply(g) {
      const h = g.fresh("h");
      const reassign = chance(0.3);
      g.emit(`${reassign ? "var" : "let"} ${h} = Heap(${g.res()})`);
      // reads are views: the box keeps its payload
      for (let i = between(1, 2); i > 0; i--) g.sink(pick([`chk(*${h})`, `(*${h}).id`, `(*${h}).name.len()`]));
      if (chance(0.3)) { const hs = g.fresh("hs"); g.emit(`let ${hs} = Heap(nameOf(${g.k()}) + "-boxed")`); g.emit(`print(*${hs})`); g.sink(`(*${hs}).len()`); }
      switch (between(0, 3)) {
        case 0: { const x = g.fresh("x"); g.emit(`let ${x} = *${h}`); g.bind(x); if (reassign) g.emit(`${h} = Heap(${g.res()})`); break; }
        case 1: g.sink(`useRes(*${h})`); if (reassign) g.emit(`${h} = Heap(${g.res()})`); break;
        default: break;
      }
      return true;
    },
  },
  {
    // The heap form over a heapless Drop payload (see Tok). Channels are not used with
    // Tok: send zeroes the moved-from local and drops it, an open bug for this shape.
    name: "heap-tok",
    apply(g) {
      const h = g.fresh("ht");
      const reassign = chance(0.4);
      g.emit(`${reassign ? "var" : "let"} ${h} = Heap(newTok(${g.k()}))`);
      g.sink(`(*${h}).id`);
      switch (between(0, 3)) {
        case 0: { const x = g.fresh("tx"); g.emit(`let ${x} = *${h}`); g.sink(`${x}.id`); break; }
        case 1: g.sink(`useTok(*${h})`); break;
        case 2: g.sink(`useTok(*Heap(newTok(${g.k()})))`); break;
        default: break;
      }
      if (reassign) g.emit(`${h} = Heap(newTok(${g.k()}))`);
      return true;
    },
  },
  { name: "combinator", apply(g) { g.sink(g.int(between(6, 13))); return true; } },
  {
    // `[v; N]` moves v into the last slot and fills the other N-1 through Res's Clone,
    // so the balance oracle sees every copy. The string spellings have no Drop count;
    // the ledger and ASan are their oracles (d2c64764 was the temp's original leaking).
    name: "array-repeat",
    apply(g) {
      const a = g.fresh("a"), n = between(1, 3);
      switch (between(0, 3)) {
        case 0: {
          g.emit(`let ${a} = [${g.res()}; ${n}]`);
          g.sink(`chk(${a}[${n - 1}])`);
          break;
        }
        case 1: g.emit(`let ${a} = [nameOf(${g.k()}) + "-rep"; ${n}]`); g.sink(`${a}[${n - 1}].len()`); break;
        case 2: g.emit(`let ${a} = [vecOf(${g.k()}).len().toString(); ${n}]`); g.sink(`${a}.len`); break;
        default: {
          const t = g.fresh("t");
          g.emit(`let ${t}: string = nameOf(${g.k()}) + "-place"`);
          g.emit(`let ${a} = [${t}; ${n}]`);
          g.sink(`${a}[${n - 1}].len()`);
        }
      }
      return true;
    },
  },
  {
    name: "match-index",
    container: true,
    apply(g) {
      const ov = g.fresh("ov");
      g.emit(`var ${ov}: Vec<Option<Res>> = Vec.new()`);
      g.emit(`${ov}.push(maybe(${g.k()}))`);
      g.emit(`${ov}.push(Option.Some(${g.res()}))`);
      const i = between(0, 1);
      if (chance(0.4)) {
        g.sink(`match ${ov}[${i}] {\n    Option.Some(q) => chk(q),\n    Option.None => 0,\n}`);
        return true;
      }
      const r = g.fresh("r"), mark = g.scope.length;
      g.open(`match ${ov}[${i}] {`);
      g.scope.push({ name: r, owned: false, live: true, loop: g.loop });
      g.open(`Option.Some(${r}) => {`);
      g.depth++; fill(g, between(1, 2)); g.depth--;
      g.scope.length = mark;
      g.close();
      g.emit(`Option.None => {}`);
      g.close();
      return true;
    },
  },
  {
    name: "extern-cstr",
    apply(g) {
      const arg = pick([`nameOf(${g.k()})`, `"x" + nameOf(${g.k()})`, `(${g.res()}).name`]);
      g.emit(`unsafe {\n    sink = sink + strlen(${arg}) as i64\n}`);
      return true;
    },
  },
  // ── the older flat fragments, as leaves ──
  { name: "closure-temp", apply(g) { const f = g.fresh("f"); g.emit(`let ${f} = move () => (${g.res()}).get()`); g.sink(`${f}()`); return true; } },
  {
    name: "closure-capture",
    apply(g) {
      const mv = g.movable();
      const r = mv.length > 0 && chance(0.5) ? pick(mv) : null;
      let name: string;
      if (r) { r.live = false; name = r.name; } else { name = g.fresh("c"); g.emit(`let ${name} = newRes(${g.k()})`); }
      const f = g.fresh("f");
      g.emit(`let ${f} = move () => chk(${name})`);
      if (chance(0.7)) g.sink(pick([`${f}()`, `callIt(${f})`]));
      return true;
    },
  },
  { name: "closure-made", apply(g) { const f = g.fresh("f"); g.emit(`let ${f} = makeClosure(${g.k()})`); g.sink(`${f}()`); return true; } },
  {
    name: "closure-nested",
    apply(g) {
      const c = g.fresh("c"), o = g.fresh("o");
      g.emit(`let ${c} = newRes(${g.k()})`);
      g.emit(`let ${o} = move () => {\n    let i = move () => chk(${c})\n    return i()\n}`);
      g.sink(`${o}()`);
      return true;
    },
  },
  {
    name: "containers",
    apply(g) {
      const v = g.fresh("cv");
      switch (between(0, 3)) {
        case 0: g.emit(`var ${v}: Vec<Res> = Vec.new()\n${v}.push(${g.res()})\n${v}.push(${g.res()})\n${v}[0] = ${g.res()}`); g.sink(`${v}.len()`); break;
        case 1: g.emit(`var ${v}: HashMap<i64, Res> = HashMap.new()\n${v}.insert(1, ${g.res()})\n${v}.insert(1, ${g.res()})`); g.sink(`${v}.len()`); break;
        case 2: g.emit(`var ${v}: Option<Res> = Option.Some(${g.res()})\nmatch ${v} {\n    Option.Some(q) => {\n        sink = sink + chk(q)\n    }\n    Option.None => {}\n}`); break;
        default: g.emit(`var ${v}: Vec<Wrap> = Vec.new()\n${v}.push(Wrap { inner: ${g.res()} })`); g.sink(`${v}.len()`);
      }
      return true;
    },
  },
  {
    name: "task-spawn",
    apply(g) {
      const c = g.fresh("c");
      g.emit(`let ${c} = newRes(${g.k()})\nTask.spawn(move () => {\n    sink2 = sink2 + chk(${c})\n}).join()`);
      return true;
    },
  },
  {
    name: "promise-blocking",
    apply(g) {
      // One statement, so the reducer cannot strip the await and leave a worker still
      // holding the capture when main exits (a racy count, not a bug).
      const c = g.fresh("c");
      g.emit(`let ${c} = newRes(${g.k()})`);
      g.sink(`Promise.blocking(move () => chk(${c})).await()!`);
      return true;
    },
  },
];

if (args.includes("--forms")) {
  console.log([...new Set(FORMS.map(f => f.name))].join("\n"));
  process.exit(0);
}

// Three levels of nesting: a for-in inside an if inside a while is the deepest any of
// the October bugs needed, plus one.
const MAX_DEPTH = 3;
const SELECTED = FILTER ? FORMS.filter(f => f.name.includes(FILTER)) : FORMS;
if (SELECTED.length === 0) { console.error(`--filter ${FILTER} matches no form (see --forms)`); process.exit(2); }

// A filtered run still needs the plumbing forms (bindings, exits, nesting) so the
// selected shape is exercised in composition rather than alone.
const PLUMBING = new Set(["let", "move-binding", "exit-loop", "exit-return", "exit-try", "if", "while", "for-next"]);

function fill(g: Gen, count: number) {
  const pool = FORMS.filter(f => (!f.container || g.depth < MAX_DEPTH)
    && (!FILTER || f.name.includes(FILTER) || PLUMBING.has(f.name)));
  const focus = SELECTED.filter(f => !f.container || g.depth < MAX_DEPTH);
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const f = FILTER && focus.length > 0 && chance(0.6) ? pick(focus) : pick(pool);
      if (f.apply(g)) { g.forms.push(f.name); break; }
    }
  }
}

function program(): { src: string; forms: string[] } {
  const g = new Gen();
  g.emit(`var sink: i64 = 0`);
  g.emit(`var kept: Vec<Res> = Vec.new()`);
  fill(g, between(3, 6));
  g.emit(`sink = sink + kept.len()`);
  g.emit(`return Option.Some(sink)`);
  const src = `${PRELUDE}
fn body(k: i64): Option<i64> {
${g.lines.join("\n")}
}

fn main(): void {
    var k: i64 = 0
    while k < 4 {
        match body(k) {
            Option.Some(s) => {
                sink2 = sink2 + s
            }
            Option.None => {
                sink2 = sink2 + 1
            }
        }
        k = k + 1
    }
    print(made.load())
    print(gone.load())
}
`;
  return { src, forms: [...new Set(g.forms)] };
}

// ── the oracles ───────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
const ASAN = /ERROR: AddressSanitizer: ([a-zA-Z-]+)/;
const LEDGER = /^own-ledger: (.+?): \d+ (\S+) \(made at IR line \d+ by (\S+?)(?:, milo line (\d+))?;/;
const INTERNAL = /TypeError|ReferenceError|RangeError|Cannot read propert|is not a function|undefined is not/;

interface Verdict {
  kind: "clean" | "rejected" | "ledger" | "ledger-crash" | "compiler-crash" | "asan" | "unbalanced" | "corrupt" | "aborted";
  sig: string;      // what the reducer must preserve
  detail: string;
}

// The guard's RLIMIT_AS defaults to the RSS cap, which Linux enforces: ASan reserves
// terabytes of shadow address space at startup ("failed to allocate 0x200001000 bytes")
// and bun's own heap reservation crashes the build. Only address space is lifted; the
// RSS and footprint watchdogs still cap what either process can actually use.
const SPARSE_VM_MB = 64 * 1024 * 1024;

async function judge(file: string, bin: string): Promise<Verdict> {
  const build = await guardedRun("bun", [MILO, "build", "--sanitize", file, "-o", bin], {
    memMb: 2048, virtualMemMb: SPARSE_VM_MB, timeoutMs: 120_000, cwd: ROOT, env: { ...process.env, MILO_OWN_LEDGER: "1" },
  });
  const out = (build.stdout + "\n" + build.stderr).replace(ANSI, "");
  const ledger = out.split("\n").map(l => LEDGER.exec(l)).filter(Boolean) as RegExpExecArray[];
  if (build.code !== 0) {
    const throwLine = out.split("\n").find(l => l.includes("own-ledger:") && !LEDGER.test(l));
    if (throwLine) return { kind: "ledger-crash", sig: "ledger-crash", detail: throwLine.trim() };
    const err = out.split("\n").map(l => l.trim()).find(l => /^error(\[[^\]]*\])?: /.test(l));
    if (err && !INTERNAL.test(out)) {
      const msg = err.replace(/^error(\[[^\]]*\])?: /, "");
      return { kind: "rejected", sig: msg.replace(/'[^']*'/g, "'_'").replace(/\b\d+\b/g, "N"), detail: msg };
    }
    const first = out.split("\n").find(l => INTERNAL.test(l)) ?? out.split("\n").find(l => l.trim()) ?? "build failed";
    return { kind: "compiler-crash", sig: first.trim().slice(0, 80), detail: first.trim() };
  }
  if (ledger.length > 0) {
    const kinds = [...new Set(ledger.map(m => `${m[2]} by ${m[3]}`))].sort();
    return { kind: "ledger", sig: kinds.join(","), detail: ledger.map(m => m[0]).join("\n") };
  }
  const run = await guardedRun(bin, [], {
    memMb: 1024, virtualMemMb: SPARSE_VM_MB, timeoutMs: 30_000, cwd: ROOT, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
  });
  const a = ASAN.exec(run.stderr);
  if (a) return { kind: "asan", sig: a[1]!, detail: `AddressSanitizer: ${a[1]}` };
  if (run.code !== 0 || run.guardKill) {
    const why = run.guardKill ? `guard kill: ${run.guardKill}` : (run.stderr.split("\n").find(l => l.trim()) ?? `exit ${run.code}`).trim();
    return { kind: "aborted", sig: why.replace(/\b\d+\b/g, "N"), detail: why };
  }
  const lines = run.stdout.trim().split("\n");
  const corrupt = lines.find(l => l.startsWith("CORRUPT"));
  if (corrupt) return { kind: "corrupt", sig: "corrupt", detail: corrupt };
  const made = lines[lines.length - 2] ?? "?", gone = lines[lines.length - 1] ?? "?";
  if (made !== gone || !/^\d+$/.test(made)) {
    const dir = Number(made) > Number(gone) ? "leak" : "extra-drop";
    return { kind: "unbalanced", sig: dir, detail: `made ${made}, gone ${gone}` };
  }
  return { kind: "clean", sig: "", detail: "" };
}

// Greedy statement deletion inside `body`: drop one line, or one line plus the block
// it opens, and keep the deletion if the failure signature survives. Good enough to
// turn a 60-line case into the handful of lines a human reads.
async function reduce(src: string, v: Verdict, dir: string, tag: string): Promise<string> {
  if (REDUCE_PROBES <= 0) return src;
  let lines = src.split("\n");
  const start = lines.indexOf("fn body(k: i64): Option<i64> {");
  let probes = 0, changed = true;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  while (changed && probes < REDUCE_PROBES) {
    changed = false;
    for (let i = start + 1; i < lines.length && probes < REDUCE_PROBES; i++) {
      const l = lines[i]!;
      if (l === "}") break;
      if (!l.trim() || /^\s*[})]/.test(l) || l.includes("return Option.Some(sink)") && indentOf(l) === 4) continue;
      let end = i;
      if (/[{(\[]$/.test(l.trimEnd())) {
        const ind = indentOf(l);
        end = i + 1;
        while (end < lines.length && !(indentOf(lines[end]!) === ind && /^\s*[})\]]/.test(lines[end]!))) end++;
        // `} else {` continues the same statement
        while (end + 1 < lines.length && /^\s*\} else \{$/.test(lines[end]!)) {
          end++;
          while (end < lines.length && !(indentOf(lines[end]!) === ind && /^\s*\}$/.test(lines[end]!))) end++;
        }
      }
      const cand = [...lines.slice(0, i), ...lines.slice(end + 1)];
      probes++;
      const f = join(dir, `${tag}_r${probes}.milo`);
      writeFileSync(f, cand.join("\n"));
      const r = await judge(f, join(dir, `${tag}_r${probes}`));
      if (r.kind === v.kind && r.sig === v.sig) { lines = cand; changed = true; i--; }
    }
  }
  return lines.join("\n");
}

// ── the run ───────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "milo-fuzz-drops-"));
const cases = Array.from({ length: CASES }, (_, c) => ({ c, ...program() })).filter(cs => ONLY < 0 || cs.c === ONLY);
const results: { c: number; v: Verdict; src: string; forms: string[] }[] = [];
const t0 = Date.now();
let next = 0;
async function worker() {
  while (next < cases.length) {
    const cs = cases[next++]!;
    const file = join(dir, `case${cs.c}.milo`);
    writeFileSync(file, cs.src);
    const v = await judge(file, join(dir, `case${cs.c}`));
    results.push({ c: cs.c, v, src: cs.src, forms: cs.forms });
    if (VERBOSE || (v.kind !== "clean" && v.kind !== "rejected")) console.log(`case ${cs.c}: ${v.kind}${v.sig ? ` (${v.sig})` : ""}`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));

const ran = results.filter(r => r.v.kind !== "rejected");
const rejected = results.filter(r => r.v.kind === "rejected");
const red = results.filter(r => !["clean", "rejected"].includes(r.v.kind)).sort((a, b) => a.c - b.c);
const formCount = new Map<string, number>();
for (const r of ran) for (const f of r.forms) formCount.set(f, (formCount.get(f) ?? 0) + 1);

console.log(`seed ${SEED}, ${CASES} cases in ${((Date.now() - t0) / 1000).toFixed(0)}s (${JOBS} jobs): ${ran.length} built, ${rejected.length} rejected, ${red.length} red`);
// How many cases the run needed before an oracle fired (ids are 0-based): the teeth number.
if (red.length > 0) console.log(`first red: case ${red[0]!.c} (${red[0]!.v.kind}: ${red[0]!.v.sig})`);
const unseen = [...new Set(SELECTED.map(f => f.name))].filter(n => !formCount.has(n));
if (VERBOSE) console.log(`forms exercised: ${[...formCount].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", ")}`);
if (unseen.length > 0 && CASES >= 100) console.log(`forms never in a built program: ${unseen.join(", ")}`);
if (rejected.length > 0) {
  const buckets = new Map<string, { n: number; ex: string; c: number }>();
  for (const r of rejected) { const b = buckets.get(r.v.sig) ?? { n: 0, ex: r.v.detail, c: r.c }; b.n++; buckets.set(r.v.sig, b); }
  for (const [, b] of [...buckets].sort((a, b) => b[1].n - a[1].n).slice(0, 5)) console.log(`  rejected ${b.n}x (case ${b.c}): ${b.ex}`);
}

if (red.length > 0) {
  mkdirSync(OUT, { recursive: true });
  // One reduced representative per (kind, signature); the rest are listed.
  const seen = new Set<string>();
  for (const r of red) {
    const key = `${r.v.kind}:${r.v.sig}`;
    const path = join(OUT, `seed${SEED}_case${r.c}.milo`);
    if (seen.has(key)) { writeFileSync(path, r.src); console.error(`case ${r.c}: ${r.v.kind} ${r.v.sig} (same signature as above) -> ${path}`); continue; }
    seen.add(key);
    const small = await reduce(r.src, r.v, dir, `case${r.c}`);
    if (small !== r.src) writeFileSync(path.replace(/\.milo$/, ".orig.milo"), r.src);
    writeFileSync(path, `// ${r.v.kind}: ${r.v.detail.split("\n").join("\n// ")}\n// forms: ${r.forms.join(" ")}\n${small}`);
    console.error(`case ${r.c}: ${r.v.kind}: ${r.v.detail.split("\n")[0]} -> ${path}`);
  }
}
if (!KEEP) rmSync(dir, { recursive: true, force: true });
else console.log(`kept ${dir}`);

// A generator whose programs mostly fail to build reports a clean sweep of nothing.
if (ran.length < cases.length / 2) {
  console.error(`only ${ran.length}/${cases.length} programs built: the generator is producing invalid Milo, not evidence`);
  process.exit(2);
}
if (red.length > 0) { console.error(`${red.length}/${ran.length} built programs failed an oracle`); process.exit(1); }
console.log(`every value constructed was destroyed exactly once, ledger clean, ASan clean, across ${ran.length} programs`);
