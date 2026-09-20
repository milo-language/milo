// Differential falsifier for the OWNERSHIP checker. Hunts for FALSE ACCEPTS — a
// program the checker compiles that then frees the same buffer twice, reads one it
// already freed, or prints something other than what it owns.
//
// The asymmetry is the whole point, and it is the mirror of scripts/prove-soundness-fuzz.ts.
// A false REJECT costs you a program you have to rewrite; you find out immediately and
// the compiler tells you where. A false ACCEPT costs you the guarantee the language is
// built on, and you find out at a customer's site, if at all. So the harness spends its
// budget on the accepting direction and only counts the rejecting one.
//
// The oracle is execution. Every generated program carries its own predicted stdout,
// computed here in TypeScript from the same ownership model that emitted it, so three
// distinct failures are visible without a reference implementation:
//
//     compiled + aborted            =>  double free / corrupt heap
//     compiled + wrong stdout       =>  read of freed or clobbered memory
//     compiled + used-after-move    =>  the checker missed a move it should have seen
//
// Generation is biased toward the shapes where a move is spelled indirectly, because
// that is where every ownership hole in this compiler's history has lived: the value
// tail of an `if`, of a `match`, of `??`, a field moved out of a struct, an argument
// moved by a method call. Eight separate ad-hoc walkers each recognised a different
// subset of those spellings, and the two double-frees fixed on 2026-08-03 were both a
// move the checker could not see because it was written as a fork (see
// docs/worksheets/2026-08-03-fail-closed-places.md). A generator that only emitted
// `let b = a` would have found neither.
//
// Two oracles run together on every executed program.
//
// AddressSanitizer is the primary one, and it is what sees a use-after-free READ at the
// instruction that performs it. That matters more than it sounds: a stdout oracle only
// notices a UAF whose freed bytes happen to have been reused by something else, so a
// read of a block nothing has touched yet prints the correct answer and passes. ASan has
// no such gap -- the block is poisoned the moment it is freed.
//
// MallocScribble=1 stays on underneath. macOS fills freed blocks with 0x55 on release,
// which turns a silent use-after-free into a visible wrong string. Without it a UAF
// usually prints the right answer out of memory that has not been reused yet, and the
// stdout oracle sees nothing (docs: project_uaf_proof_technique).
//
// Usage: bun scripts/fuzz-ownership.ts [--cases N] [--seed N] [--steps N] [--keep] [--verbose]
//        [--no-asan] [--corpus DIR]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const MILO = join(ROOT, "src", "main.ts");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const CASES = argOf("--cases", 40);
const SEED = argOf("--seed", 1);
const STEPS = argOf("--steps", 9);
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");
// ASan is the primary oracle; MallocScribble stays on underneath it (see runProgram).
// `--no-asan` exists for a host with no working sanitizer, not as a speed knob.
const ASAN = !process.argv.includes("--no-asan");
// Write every generated program to a stable directory. scripts/fuzz-coverage.ts reads it
// to ask which surface forms this generator can actually emit — a question the harness
// cannot answer about itself, since a shape it never generates is invisible to its own
// pass/fail line.
const CORPUS = (() => {
  const i = process.argv.indexOf("--corpus");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
})();

// Seeded PRNG so a finding is reproducible from the seed in the report.
let state = SEED >>> 0 || 1;
function rnd(): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (p: number) => rnd() < p;

// Distinct lengths so a slot that gets swapped for another is visible in the
// `borrow` output too, not only in the printed text.
const WORDS = ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa"];

// ── the ownership model ───────────────────────────────────────────────────────
//
// One `Slot` per owned string buffer in the generated program. `ref` is how the
// program names it — `v3` for a binding, `s1.a` for a struct field — so a move out
// of a field and a move out of a binding are the same operation to the generator,
// which is exactly the distinction the checker keeps getting wrong.
// `mut` marks a slot the program can assign INTO, which is a second way for a value to
// arrive somewhere and the only way for a moved-out binding to come back to life.
interface Slot { ref: string; word: string; live: boolean; mut?: boolean }

class Program {
  lines: string[] = [];
  expected: string[] = [];
  slots: Slot[] = [];
  conds: { name: string; value: boolean }[] = [];
  vecs: { name: string; words: string[] }[] = [];
  private n = 0;
  private indent = 1;
  // How deep inside nested blocks generation currently is, and how many enclosing blocks
  // the generator knows will not execute. Both are read by `fill` to decide which shapes
  // may run here; see MAX_DEPTH.
  depth = 0;
  suppressed = 0;

  // The deepest block this program reached, reported by the run so a generator that
  // quietly stops nesting — every container declining, a bad MAX_DEPTH — is visible.
  // Flat programs still pass every assertion this harness makes, which is the failure
  // mode worth an explicit number rather than trust.
  peak = 1;

  fresh(prefix: string) { return `${prefix}${this.n++}`; }
  emit(line: string) {
    this.peak = Math.max(this.peak, this.indent);
    this.lines.push("    ".repeat(this.indent) + line);
  }
  open(line: string) { this.emit(line); this.indent++; }
  close() { this.indent--; this.emit("}"); }

  live() { return this.slots.filter(s => s.live); }
  mutSlots() { return this.slots.filter(s => s.mut); }
  filledVecs() { return this.vecs.filter(v => v.words.length > 0); }
  dead() { return this.slots.filter(s => !s.live); }
  take(s: Slot) { s.live = false; }

  // Predicted stdout, but only from code that actually runs. A shape inside a branch the
  // generator knows is dead still emits its statement (the checker has to accept it) and
  // still marks what it moved as moved (the checker has to assume it might run) — it
  // just prints nothing.
  say(...words: string[]) { if (this.suppressed === 0) this.expected.push(...words); }

  // Suppression and scope unwinding, with no braces of its own. Three things have to be
  // undone on the way out, and every one of them is a scope error rather than an ownership
  // one if it is not: a binding, a cond's `let c`, and a Vec declared inside the block all
  // stop existing at the closing brace, and a later shape that names one would make the
  // harness report its own bookkeeping as a checker bug. A slot the block MOVED stays
  // dead, which is the point — that death outlives the scope.
  scoped(taken: boolean, body: () => void) {
    const slotMark = this.slots.length, condMark = this.conds.length, vecMark = this.vecs.length;
    const wasLive = this.slots.map(s => s.live);
    if (!taken) this.suppressed++;
    this.depth++;
    body();
    this.depth--;
    if (!taken) this.suppressed--;
    this.slots.length = slotMark;
    this.conds.length = condMark;
    this.vecs.length = vecMark;
    // A block may KILL an outer slot but never RESURRECT one, whatever the generator
    // knows about whether it runs. `w = other` inside one arm brings a moved-out binding
    // back to life on that path only; the sibling arm and the code after the join still
    // see it moved, and the checker is right to reject a use there. Without this the
    // harness reports its own bookkeeping as a false reject — which is how it was found.
    for (let i = 0; i < slotMark; i++) this.slots[i]!.live = wasLive[i]! && this.slots[i]!.live;
  }

  block(taken: boolean, header: string, body: () => void) {
    this.scoped(taken, () => { this.open(header); body(); this.close(); });
  }

  // Both arms of one `if`, each its own scope. One method rather than two calls because
  // `} else {` belongs to neither arm — a shape that emitted it would have to know about
  // the indent counter, and getting that wrong turns one `if` into two.
  ifElse(c: { name: string; value: boolean }, thenBody: () => void, elseBody: () => void) {
    this.scoped(c.value, () => { this.open(`if ${c.name} {`); thenBody(); this.indent--; });
    this.emit("} else {");
    this.indent++;
    this.scoped(!c.value, elseBody);
    this.close();
  }

  // A bool the generator knows the value of, so it can predict which arm of a fork
  // actually runs while the checker still has to assume either might.
  cond(): { name: string; value: boolean } {
    if (this.conds.length > 0 && chance(0.5)) return pick(this.conds);
    const c = { name: this.fresh("c"), value: chance(0.5) };
    this.emit(`let ${c.name} = ${c.value}`);
    this.conds.push(c);
    return c;
  }

  source(): string {
    return `struct Pair {
    a: string,
    b: string,
}

// A type whose destructor is observable. Its output is part of the predicted stdout,
// so a drop that does not run, runs twice, or runs at the wrong point is a mismatch.
// Added after a partial move out of a Drop type turned out to skip the destructor
// entirely — a silent resource leak the string-only shapes could not express.
struct Res {
    name: string,
}

impl Drop for Res {
    fn drop(self: &mut Self) {
        print("drop " + self.name)
    }
}

fn consume(s: string): i64 {
    return s.len()
}

fn borrow(s: &string): i64 {
    return s.len()
}

fn main() {
${this.lines.join("\n")}
}
`;
  }
}

// ── the shapes ────────────────────────────────────────────────────────────────
//
// Each takes a program and either applies (returning true) or declines because its
// preconditions are not met. All of them keep the model and the emitted code in
// lockstep: a shape that consumes a slot in the program must mark it dead here, or
// the harness starts reporting its own bookkeeping as compiler bugs.
// `stateful` marks a shape whose model update is a RUNTIME fact rather than a compile-time
// one — a vec's contents, a var's current word, a sort order. Those must not run inside a
// block the generator knows is dead: the code would never execute, but the model would go
// on predicting output from it. `container` marks a shape that nests other shapes inside
// itself, which is what MAX_DEPTH bounds.
type Shape = { name: string; stateful?: boolean; container?: boolean; apply: (p: Program) => boolean };

const SHAPES: Shape[] = [
  {
    name: "declare",
    apply(p) {
      const v = p.fresh("v"), word = pick(WORDS);
      p.emit(`let ${v} = "${word}"`);
      p.slots.push({ ref: v, word, live: true });
      return true;
    },
  },
  {
    name: "read-borrow",
    apply(p) {
      const s = p.live()[0] ? pick(p.live()) : null;
      if (!s) return false;
      p.emit(`print(borrow(${s.ref}))`);
      p.say(String(s.word.length));
      return true;
    },
  },
  {
    name: "print",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live);
      p.emit(`print(${s.ref})`);
      p.say(s.word);
      return true;
    },
  },
  {
    name: "move-to-call",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live);
      p.emit(`print(consume(${s.ref}))`);
      p.say(String(s.word.length));
      p.take(s);
      return true;
    },
  },
  {
    name: "move-to-binding",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), v = p.fresh("v");
      p.emit(`let ${v} = ${s.ref}`);
      p.take(s);
      p.slots.push({ ref: v, word: s.word, live: true });
      return true;
    },
  },
  {
    // The spelling that hid two double-frees: a value moved out of the tail of a
    // fork. Both arms are consumed at compile time — which arm runs is a runtime
    // fact — so a checker that only marks the taken one leaves the other droppable
    // twice.
    name: "move-through-if",
    apply(p) {
      const live = p.live();
      if (live.length < 2) return false;
      const x = pick(live);
      const y = pick(live.filter(s => s !== x));
      const c = p.cond(), v = p.fresh("v");
      p.emit(`let ${v} = if ${c.name} { ${x.ref} } else { ${y.ref} }`);
      p.take(x); p.take(y);
      p.slots.push({ ref: v, word: c.value ? x.word : y.word, live: true });
      return true;
    },
  },
  {
    name: "move-through-match",
    apply(p) {
      const live = p.live();
      if (live.length < 2) return false;
      const x = pick(live);
      const y = pick(live.filter(s => s !== x));
      const c = p.cond(), v = p.fresh("v");
      p.open(`let ${v} = match ${c.name} {`);
      p.emit(`true => ${x.ref},`);
      p.emit(`false => ${y.ref},`);
      p.close();
      p.take(x); p.take(y);
      p.slots.push({ ref: v, word: c.value ? x.word : y.word, live: true });
      return true;
    },
  },
  {
    // Into a struct, then back out field-wise. A field is a place like any other:
    // the same rule that governs `v3` has to govern `s1.a`, and for a long time it
    // did not (docs/memory-safety-vs-rust.md, the field-move-out-of-borrow UAF).
    name: "move-into-struct",
    apply(p) {
      const live = p.live();
      if (live.length < 2) return false;
      const x = pick(live);
      const y = pick(live.filter(s => s !== x));
      const s = p.fresh("s");
      p.emit(`let ${s} = Pair { a: ${x.ref}, b: ${y.ref} }`);
      p.take(x); p.take(y);
      p.slots.push({ ref: `${s}.a`, word: x.word, live: true });
      p.slots.push({ ref: `${s}.b`, word: y.word, live: true });
      return true;
    },
  },
  {
    // A method call that consumes its argument. `push` is the one every program
    // writes, and it moves — a checker that treats method arguments differently from
    // free-function arguments has a hole exactly the width of the standard library.
    name: "move-into-vec",
    stateful: true,
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live);
      let q = p.vecs.length > 0 && chance(0.6) ? pick(p.vecs) : null;
      if (!q) {
        q = { name: p.fresh("q"), words: [] };
        p.emit(`var ${q.name}: Vec<string> = Vec.new()`);
        p.vecs.push(q);
      }
      p.emit(`${q.name}.push(${s.ref})`);
      q.words.push(s.word);
      p.take(s);
      return true;
    },
  },
  {
    // `??` unwraps by consuming: the Option dies and its payload becomes the result.
    // A move through it was one of the slots the use-after-move fix had to cover.
    name: "move-through-option",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), o = p.fresh("o"), v = p.fresh("v");
      const fallback = pick(WORDS);
      p.emit(`let ${o}: Option<string> = Option.Some(${s.ref})`);
      p.take(s);
      p.emit(`let ${v} = ${o} ?? "${fallback}"`);
      // Always Some, so the fallback never runs — the point is the move, not the branch.
      p.slots.push({ ref: v, word: s.word, live: true });
      return true;
    },
  },
  {
    // A move inside a branch that may not run. The value is dead afterwards either
    // way; whether the buffer was actually handed over is a runtime fact, and the
    // drop at scope exit has to agree with it.
    name: "move-inside-branch",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), c = p.cond();
      p.block(c.value, `if ${c.name} {`, () => {
        p.emit(`print(consume(${s.ref}))`);
        p.say(String(s.word.length));
      });
      p.take(s);
      return true;
    },
  },
  {
    // A destructor whose position in the output is knowable. The value lives in a
    // taken branch with nothing else in it, so its drop fires at one unambiguous
    // point — no general drop-ordering model needed, and a missing or duplicated
    // destructor shows up as a stdout mismatch like any other wrong value.
    name: "drop-scope",
    apply(p) {
      const c = p.cond();
      if (!c.value) return false;   // an untaken branch would print nothing to check
      const r = p.fresh("r"), word = pick(WORDS);
      p.block(true, `if ${c.name} {`, () => {
        p.emit(`let ${r} = Res { name: "${word}" }`);
        p.emit(`print(borrow(${r}.name))`);
        p.say(String(word.length));
      });
      p.say(`drop ${word}`);
      return true;
    },
  },
  {
    // `.clone()` is the escape hatch the diagnostics point at, so it has to actually
    // produce an independent buffer. If it aliased, this shape would double-free.
    name: "clone",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), v = p.fresh("v");
      p.emit(`let ${v} = ${s.ref}.clone()`);
      p.slots.push({ ref: v, word: s.word, live: true });
      return true;
    },
  },
  {
    // A mutable binding. On its own it proves nothing; it is what `move-to-assign`
    // needs a destination for, and assignment is the single most common statement in
    // the fixture corpus that this generator could not previously spell.
    name: "declare-var",
    apply(p) {
      const v = p.fresh("w"), word = pick(WORDS);
      p.emit(`var ${v} = "${word}"`);
      p.slots.push({ ref: v, word, live: true, mut: true });
      return true;
    },
  },
  {
    // Assignment as a move destination. Two things are being tested at once and both
    // have bitten before: the destination's OLD buffer has to be released exactly once
    // (assigning over a live binding), and a binding that was moved out of has to come
    // back to life (assigning over a dead one) rather than stay poisoned.
    name: "move-to-assign",
    stateful: true,
    apply(p) {
      const dests = p.mutSlots();
      if (dests.length === 0) return false;
      const d = pick(dests);
      const sources = p.live().filter(x => x !== d);
      if (sources.length === 0) return false;
      const src = pick(sources);
      p.emit(`${d.ref} = ${src.ref}`);
      p.take(src);
      d.word = src.word;
      d.live = true;
      return true;
    },
  },
  {
    // `let x = q[i]` on a Vec<string>. This does NOT move the element out — it copies,
    // and the vec keeps it — so the generated program ends up with two names for what
    // must be two separate buffers. A shallow copy here is a double free at scope exit
    // and identical stdout right up until it aborts, which is why ASan is the oracle
    // that decides it (docs/backlog.md, the index silent-clone entry).
    name: "read-index",
    apply(p) {
      const filled = p.filledVecs();
      if (filled.length === 0) return false;
      const q = pick(filled);
      const i = Math.floor(rnd() * q.words.length);
      const v = p.fresh("ix");
      p.emit(`let ${v} = ${q.name}[${i}]`);
      p.slots.push({ ref: v, word: q.words[i]!, live: true });
      return true;
    },
  },
  {
    // `!` unwraps by consuming, the same as `??` but through a different node. Both
    // spellings reach the same rule and only one of them was ever generated; the
    // use-after-free this family produced was found by hand, not by this harness.
    name: "move-through-unwrap",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), o = p.fresh("u"), v = p.fresh("v");
      p.emit(`let ${o}: Option<string> = Option.Some(${s.ref})`);
      p.take(s);
      p.emit(`let ${v} = ${o}!`);
      p.slots.push({ ref: v, word: s.word, live: true });
      return true;
    },
  },
  {
    // `for w in q` binds each element BY REFERENCE, so the loop reads what the vec owns
    // without taking it. The predicted stdout is every word in insertion order, which
    // also pins iteration itself: a loop that skips, repeats or reorders an element is
    // a mismatch here even though no ownership rule was involved.
    name: "borrow-in-forin",
    apply(p) {
      const filled = p.filledVecs();
      if (filled.length === 0) return false;
      const q = pick(filled);
      p.block(true, `for w in ${q.name} {`, () => p.emit(`print(w)`));
      for (const w of q.words) p.say(w);
      return true;
    },
  },

  {
    // `match` as a STATEMENT, not as the value of a binding. The expression form was
    // already generated; this is the same rule reached through a different node, and
    // match arms are where two separate ownership bugs have lived (a borrow through
    // `match` on a reference, and a move in one arm the other arm did not know about).
    name: "move-through-match-stmt",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), o = p.fresh("mo");
      p.emit(`let ${o}: Option<string> = Option.Some(${s.ref})`);
      p.take(s);
      p.open(`match ${o} {`);
      p.open(`Option.Some(x) => {`);
      p.emit(`print(consume(x))`);
      p.close();
      p.open(`Option.None => {`);
      p.emit(`print("none")`);
      p.close();
      p.close();
      // Always Some, so only the first arm runs — the fork is for the checker, not the
      // program. The other arm still has to type-check against a value already moved.
      p.say(String(s.word.length));
      return true;
    },
  },
  {
    // `if let` binds out of the scrutinee, consuming it. The binding is live only
    // inside the block, which is the part a checker can get wrong in the quiet
    // direction: leaving it live afterwards, or dropping it twice on the way out.
    name: "move-through-if-let",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), o = p.fresh("io");
      p.emit(`let ${o}: Option<string> = Option.Some(${s.ref})`);
      p.take(s);
      p.open(`if let Option.Some(y) = ${o} {`);
      p.emit(`print(y)`);
      p.close();
      p.say(s.word);
      return true;
    },
  },
  {
    // `let ... else` binds into the ENCLOSING scope on the success path and must
    // diverge on the other, so the payload outlives the statement that unwrapped it.
    // That is a different lifetime shape from `if let` and the only one of the two
    // where the bound value is still usable on the next line.
    name: "move-through-let-else",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), o = p.fresh("lo"), v = p.fresh("le");
      p.emit(`let ${o}: Option<string> = Option.Some(${s.ref})`);
      p.take(s);
      p.open(`let Option.Some(${v}) = ${o} else {`);
      p.emit(`return`);
      p.close();
      p.slots.push({ ref: v, word: s.word, live: true });
      return true;
    },
  },
  {
    // A move inside a loop body, of a value the body itself declares. The checker
    // rejects moving a value declared OUTSIDE the loop (it would run twice), so this
    // is the legal half of that rule — and the half that has to keep working. Two
    // iterations, because a drop that runs once for a value created twice is exactly
    // the mistake this catches.
    name: "loop-local-move",
    apply(p) {
      const n = p.fresh("n"), w = p.fresh("lw"), word = pick(WORDS);
      p.emit(`var ${n} = 0`);
      p.open(`while ${n} < 2 {`);
      p.emit(`let ${w} = "${word}"`);
      p.emit(`print(consume(${w}))`);
      p.emit(`${n} = ${n} + 1`);
      p.close();
      p.say(String(word.length), String(word.length));
      return true;
    },
  },
  {
    // A closure capturing by reference and called immediately. Deliberately does not
    // escape: an escaping closure that captures an owned value is a known-open hole
    // (docs/backlog.md, indirect closure escape), and a generator that reproduced it
    // every run would turn this harness into a permanent red light instead of a
    // detector. Capture-and-borrow is the part that is supposed to work.
    name: "borrow-in-closure",
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), f = p.fresh("f");
      p.emit(`let ${f} = () => borrow(${s.ref})`);
      p.emit(`print(${f}())`);
      p.say(String(s.word.length));
      return true;
    },
  },
  {
    // `sortByKey` is the ONE exemption to move-out-of-borrow in the whole checker
    // (checker.ts, the sortByKey extractor depth counter). A hardcoded carve-out with
    // no rule behind it is worth generating against on principle. Declines unless the
    // vec's lengths are all distinct, so the resulting order is predictable without
    // assuming the sort is stable.
    name: "sort-by-key",
    stateful: true,
    apply(p) {
      const filled = p.filledVecs().filter(v => v.words.length > 1);
      const q = filled.find(v => new Set(v.words.map(w => w.length)).size === v.words.length);
      if (!q) return false;
      p.emit(`${q.name}.sortByKey((e: &string) => e.len())`);
      q.words.sort((a, b) => a.length - b.length);
      return true;
    },
  },
  {
    // A block with OTHER shapes inside it. Every shape above emits one statement at one
    // level, and a generator that only does that tests the checker's rules one at a time
    // — but every ownership bug this compiler has had was a COMPOSITION: a move in the
    // tail of a fork inside a match arm, a field taken out of a struct inside a branch.
    // A walker that handles each form correctly on its own and loses track one level down
    // looks identical to a correct one on a flat program, which is all this harness had.
    name: "nest-if",
    container: true,
    apply(p) {
      const c = p.cond();
      p.block(c.value, `if ${c.name} {`, () => fill(p));
      return true;
    },
  },
  {
    // Two arms, each with its own shapes, exactly one of which runs. This is the shape
    // that catches a checker reconciling arms by taking one of them: the moves in the arm
    // that does NOT run still have to count, because which arm runs is a runtime fact.
    name: "nest-if-else",
    container: true,
    apply(p) {
      const c = p.cond();
      p.ifElse(c, () => fill(p), () => fill(p));
      return true;
    },
  },
  {
    // The same composition reached through `match` instead of `if`. Different node, same
    // rule — and match arms are where two of the ownership bugs actually lived.
    name: "nest-match-arms",
    container: true,
    apply(p) {
      const c = p.cond();
      p.open(`match ${c.name} {`);
      p.block(c.value, `true => {`, () => fill(p));
      p.block(!c.value, `false => {`, () => fill(p));
      p.close();
      return true;
    },
  },
  {
    // A fork in the VALUE position with another fork inside it. `move-through-if` reaches
    // the tail of one `if`; nothing reached the tail of a tail. A walker that recurses one
    // level and stops is indistinguishable from a correct one until this program exists.
    name: "move-through-nested-if",
    apply(p) {
      const live = p.live();
      if (live.length < 3) return false;
      const x = pick(live);
      const rest = live.filter(s => s !== x);
      const y = pick(rest);
      const z = pick(rest.filter(s => s !== y));
      const c1 = p.cond(), c2 = p.cond(), v = p.fresh("v");
      p.emit(`let ${v} = if ${c1.name} { if ${c2.name} { ${x.ref} } else { ${y.ref} } } else { ${z.ref} }`);
      p.take(x); p.take(y); p.take(z);
      // c1 and c2 may be the same cond; the model still reads the right arm either way.
      p.slots.push({ ref: v, word: c1.value ? (c2.value ? x.word : y.word) : z.word, live: true });
      return true;
    },
  },
  {
    // The payload of an `if let` is an owned value whose scope is exactly one block, and
    // the shapes inside can move it, clone it, or bury it in a struct. Its death has to be
    // reconciled at the closing brace rather than at the end of the function, which is a
    // different question from the one `move-through-if-let` asks by only printing it.
    name: "nest-if-let-body",
    container: true,
    apply(p) {
      const live = p.live();
      if (live.length === 0) return false;
      const s = pick(live), o = p.fresh("no"), y = p.fresh("y");
      p.emit(`let ${o}: Option<string> = Option.Some(${s.ref})`);
      p.take(s);
      // Always Some, so the block always runs; the fork is for the checker, not the model.
      p.block(true, `if let Option.Some(${y}) = ${o} {`, () => {
        p.slots.push({ ref: y, word: s.word, live: true });
        fill(p);
      });
      return true;
    },
  },
];

// Two levels of nesting, which is one more than every historical ownership bug needed and
// enough that a walker cannot pass by recursing a fixed number of times.
const MAX_DEPTH = 2;

// Fill a block with a few shapes, chosen the way the top level chooses them minus two
// exclusions: containers stop at MAX_DEPTH so nesting terminates, and stateful shapes stay
// out of a block the generator knows will not run (see the `stateful` comment on Shape).
function fill(p: Program): void {
  const usable = SHAPES.filter(s =>
    (!s.container || p.depth < MAX_DEPTH) && !(s.stateful && p.suppressed > 0));
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 6; attempt++) if (pick(usable).apply(p)) break;
  }
}

// ── generation ────────────────────────────────────────────────────────────────

interface Case {
  src: string;
  expected: string[];
  invalid: null | { ref: string; spelling: string };
  depth: number;
}

function generate(invalidate: boolean): Case {
  const p = new Program();
  // Two slots up front: most shapes need a pair, and starting empty wastes cases on
  // a body that is nothing but `declare`.
  SHAPES[0]!.apply(p);
  SHAPES[0]!.apply(p);
  for (let i = 0; i < STEPS; i++) {
    // Try a few shapes before giving up on this step — most decline when the model
    // has run out of live slots, which happens naturally as moves accumulate.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (pick(SHAPES).apply(p)) break;
    }
  }

  let invalid: Case["invalid"] = null;
  if (invalidate) {
    const dead = p.dead();
    if (dead.length > 0) {
      const s = pick(dead);
      // The last spelling is the interesting one: the use is buried in a fork tail,
      // which is precisely the shape the checker used to walk straight past.
      const spelling = pick(["borrow", "print", "consume", "rebind", "fork", "whole", "drop-partial"]);
      const live = p.live();
      switch (spelling) {
        case "borrow": p.emit(`print(borrow(${s.ref}))`); break;
        case "print": p.emit(`print(${s.ref})`); break;
        case "consume": p.emit(`print(consume(${s.ref}))`); break;
        case "rebind": p.emit(`let ${p.fresh("v")} = ${s.ref}`); break;
        case "fork": {
          const other = live.length > 0 ? pick(live).ref : `"${pick(WORDS)}"`;
          p.emit(`let ${p.fresh("v")} = if ${p.cond().name} { ${s.ref} } else { ${other} }`);
          break;
        }
        // Use of the WHOLE value while one of its places is gone. Only meaningful when
        // the dead slot is a struct FIELD — a plain binding cannot be missing a part and
        // still exist — so a non-field slot falls back to an ordinary use-after-move.
        case "whole": {
          if (!s.ref.includes(".")) { p.emit(`print(borrow(${s.ref}))`); break; }
          p.emit(`print(${s.ref.split(".")[0]!})`);
          break;
        }
        // A field taken out of a type with a destructor. Self-contained, because the
        // bug it encodes needs no prior state: the move used to compile and the drop
        // then never ran at all.
        case "drop-partial": {
          const r = p.fresh("r");
          p.emit(`let ${r} = Res { name: "${pick(WORDS)}" }`);
          p.emit(`let ${p.fresh("v")} = ${r}.name`);
          break;
        }
      }
      invalid = { ref: s.ref, spelling };
    }
  }
  return { src: p.source(), expected: p.expected, invalid, depth: p.peak };
}

// ── the oracles ───────────────────────────────────────────────────────────────

interface Run { ok: boolean; stdout: string; stderr: string; status: number }

function sh(cmd: string, env?: Record<string, string>): Run {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
      env: { ...process.env, ...env },
    });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (e: any) {
    return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), status: Number(e.status ?? -1) };
  }
}

const ASAN_REPORT = /ERROR: AddressSanitizer: ([a-z-]+)/;

// Execute a generated program under both oracles. `--sanitize` does not change what the
// program prints, so the stdout comparison the caller does is unaffected by it.
function runProgram(file: string): Run & { asan: string | null } {
  // detect_leaks=0: LeakSanitizer rides along with ASan on Linux (not macOS) and a leak
  // is not what this harness grades. Left on, a leaking generated program exits nonzero
  // on Linux only and lands as a bogus miscompile, so CI would go red for the wrong
  // reason on one platform. Leaks have their own gate (scripts/leak-check.ts).
  const r = sh(`bun ${MILO} run ${ASAN ? "--sanitize " : ""}${file}`,
    { MallocScribble: "1", ASAN_OPTIONS: "detect_leaks=0" });
  const m = ASAN_REPORT.exec(r.stderr);
  return { ...r, asan: m ? m[1]! : null };
}

// A sanitizer that links but does not instrument reports every program clean, and this
// harness would then print "no findings" for the exact class it added ASan to see. That
// is not hypothetical -- `--sanitize` shipped in precisely that state (see
// tests/sanitize.test.ts). Prove the oracle can fail before trusting it to pass.
//
// The probe is the one fuzz-tasks.ts uses: `strlen` over a buffer with no NUL, an inline
// `ptr()` with no mutation, so it stays legal under the pointer-view rule. The old probe
// (`let p = v.ptr()` then a push) is now rejected by the checker, `unsafe` or not, and
// this script exited 2 at startup for as long as it carried it.
function assertAsanWorks(): void {
  const probe = join(dir, "__asan_selfcheck.milo");
  writeFileSync(probe, `from "std/os" import { strlen }
fn main() {
    var v: Vec<u8> = Vec.filled(8, 65)
    print(strlen(v.ptr()))
}
`);
  const r = runProgram(probe);
  if (r.asan !== "heap-buffer-overflow") {
    console.error("ASan self-check FAILED: a deliberate out-of-bounds read was not reported.");
    console.error(`  got: ${r.asan ?? "no AddressSanitizer output"}`);
    console.error("  The sanitizer is linked but not instrumenting, or clang is missing.");
    console.error("  Refusing to run: results would read as clean for the class ASan is here to catch.");
    console.error("  Re-run with --no-asan to fall back to the stdout oracle alone.");
    process.exit(2);
  }
}

// The checker's verdict, without paying for clang. `emit-hir` runs lexer → parser →
// checker → lowering and exits nonzero on any error diagnostic.
function accepts(file: string) {
  const r = sh(`bun ${MILO} emit-hir ${file}`);
  const clean = (r.stderr + r.stdout).replace(/\x1b\[[0-9;]*m/g, "");
  return { accepted: r.ok, output: clean };
}

// An internal exception is not a diagnostic — it is the compiler falling over, and in
// the LSP it means the file shows no errors at all rather than the wrong ones. This is
// the oracle that `fatal()`'s recovery boundaries have to hold up under.
const INTERNAL_CRASH = /TypeError|ReferenceError|Cannot read propert|is not a function|at TypeChecker\.|at Object\.<anonymous>/;

interface Finding {
  kind: "false-accept" | "unsound-accept" | "miscompile" | "compiler-crash" | "false-reject";
  detail: string;
  file: string;
}

const dir = mkdtempSync(join(tmpdir(), "milo-ownfuzz-"));
if (CORPUS) mkdirSync(CORPUS, { recursive: true });
const findings: Finding[] = [];
if (ASAN) assertAsanWorks();
let validAccepted = 0, validTotal = 0, invalidRejected = 0, invalidTotal = 0, noInjection = 0;
const depths: number[] = [];

function keep(i: number, src: string) {
  const kept = join(ROOT, `ownership-finding-${i}.milo`);
  writeFileSync(kept, src);
  return kept;
}

for (let i = 0; i < CASES; i++) {
  // Half the population is written to be correct and half has a use-after-move spliced
  // in. Both directions are needed: the invalid half is what can expose a false accept,
  // and the valid half is what proves the checker has not simply started rejecting
  // everything — a compiler that rejects all programs has no false accepts either.
  const invalidate = i % 2 === 1;
  const c = generate(invalidate);
  const file = join(dir, `case${i}.milo`);
  writeFileSync(file, c.src);
  if (CORPUS) writeFileSync(join(CORPUS, `case${SEED}_${i}.milo`), c.src);
  depths.push(c.depth);
  if (VERBOSE) console.log(`\n── case ${i} (${invalidate ? "invalid" : "valid"})\n${c.src}`);

  const verdict = accepts(file);
  if (INTERNAL_CRASH.test(verdict.output)) {
    findings.push({
      kind: "compiler-crash",
      detail: verdict.output.split("\n").find(l => INTERNAL_CRASH.test(l))?.trim() ?? "internal error",
      file: keep(i, c.src),
    });
    continue;
  }

  if (c.invalid) {
    invalidTotal++;
    if (!verdict.accepted) { invalidRejected++; continue; }
    // Accepted a program that uses a value it already gave away. Run it: an abort or a
    // wrong string turns "the checker has a gap" into "the gap is exploitable", which
    // is the difference between a backlog entry and a stop-everything bug.
    const run = runProgram(file);
    const aborted = run.status !== 0 || /malloc|double free|pointer being freed/i.test(run.stderr);
    const why = run.asan
      ? `AddressSanitizer: ${run.asan}`
      : (run.stderr.split("\n").find(l => l.trim()) ?? `exit ${run.status}`).trim();
    findings.push({
      kind: aborted || run.asan ? "unsound-accept" : "false-accept",
      detail: `use-after-move of '${c.invalid.ref}' spelled '${c.invalid.spelling}' compiled` +
        (aborted || run.asan ? ` and the program touched memory it does not own: ${why}` : " (ran to completion — a gap, not yet a crash)"),
      file: keep(i, c.src),
    });
    continue;
  }

  validTotal++;
  if (!verdict.accepted) {
    // Low severity by design: a rejected valid program is loud and recoverable. Still
    // reported, because a rule that over-rejects is how a language becomes unusable,
    // and because it is usually the generator that is wrong — which is worth knowing.
    findings.push({
      kind: "false-reject",
      detail: (verdict.output.split("\n").find(l => l.includes("error")) ?? "rejected").trim(),
      file: keep(i, c.src),
    });
    continue;
  }
  validAccepted++;

  const run = runProgram(file);
  const got = run.stdout.split("\n").filter(l => l !== "");
  // Ordered before the exit-code branch: an ASan abort is also a nonzero exit, and
  // "memory error" is the finding, not "the program exited 1". A valid program that
  // prints the right bytes off a freed block is the whole reason ASan is here -- the
  // stdout oracle below would call it a pass.
  if (run.asan) {
    findings.push({
      kind: "unsound-accept",
      detail: `accepted program is memory-unsafe: AddressSanitizer: ${run.asan}` +
        (got.join("\n") === c.expected.join("\n") ? " (stdout was correct — invisible without ASan)" : ""),
      file: keep(i, c.src),
    });
  } else if (run.status !== 0) {
    findings.push({
      kind: "miscompile",
      detail: `exit ${run.status}: ${(run.stderr.split("\n").find(l => l.trim()) ?? "").trim()}`,
      file: keep(i, c.src),
    });
  } else if (got.join("\n") !== c.expected.join("\n")) {
    findings.push({
      kind: "miscompile",
      detail: `stdout mismatch\n      expected: ${JSON.stringify(c.expected)}\n      got:      ${JSON.stringify(got)}`,
      file: keep(i, c.src),
    });
  }
}

// ── report ────────────────────────────────────────────────────────────────────

console.log(`seed ${SEED}, ${CASES} cases (${STEPS} steps each), oracle: ${ASAN ? "ASan + stdout" : "stdout only (--no-asan)"}`);
console.log(`valid programs accepted:   ${validAccepted}/${validTotal}`);
console.log(`invalid programs rejected: ${invalidRejected}/${invalidTotal}`);
console.log(`nesting depth: max ${Math.max(...depths)}, mean ` +
  `${(depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1)} (a flat function body is 1)`);
if (noInjection > 0) console.log(`(${noInjection} invalid cases had no moved value to reuse)`);

// A run where nothing compiled and nothing executed proves nothing about a checker that
// accepts too much. Exit distinctly so a green CI line can never mean "tested nothing".
if (validAccepted === 0 || invalidTotal === 0) {
  console.log("VACUOUS RUN: no valid program reached execution, so no acceptance was tested.");
  process.exit(2);
}

if (findings.length === 0) {
  console.log("no findings: every accepted program ran and printed exactly what it owns");
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const order: Finding["kind"][] = ["unsound-accept", "miscompile", "compiler-crash", "false-accept", "false-reject"];
console.log(`\nFINDINGS (${findings.length}):`);
for (const kind of order) {
  for (const f of findings.filter(x => x.kind === kind)) {
    console.log(`  [${f.kind}] ${f.detail}`);
    console.log(`    repro: ${f.file}`);
  }
}
if (!KEEP) rmSync(dir, { recursive: true, force: true });
// A false reject alone is not a failure of the thing this harness exists to test.
const severe = findings.filter(f => f.kind !== "false-reject");
process.exit(severe.length === 0 ? 0 : 1);
