// Differential falsifier for `milo prove`. Hunts for FALSE PROOFS — the only verdict that
// can be wrong in a dangerous direction.
//
// The asymmetry is the whole point. `unknown` costs you a proof you wanted. `failed` on a
// true contract costs you a spurious alarm. Both are recoverable. A `proven` on a contract
// the program actually violates is unrecoverable: it is the prover telling you a guarantee
// holds when it does not, and everything downstream trusts it.
//
// The oracle is the language itself: `--debug` compiles every contract into a runtime
// assert (language-reference.md:276), so the same clause the solver reasoned about is
// checked against real execution. The contradiction this hunts for is exactly:
//
//     milo prove  =>  proven
//     milo run --debug  =>  "runtime error: ensures clause violated"
//
// Generation is biased toward the constructs where the symbolic walker has to model
// something it cannot see directly — mutation through `&mut`, method receivers, struct
// fields, loop havoc, and calls whose result is only described by an `ensures`. Those are
// where the model can drift from the machine, and where the one confirmed false proof in
// this prover's history (a `&mut` parameter mutating a caller's local without an
// assignment anywhere in the caller) actually lived.
//
// The second family (`generateContainer`) hunts the opposite direction as well. Builtin
// Vec methods carry contracts the prover takes on faith (BUILTIN_CONTRACTS in verify.ts),
// and every op's effect on `len` is known exactly, so the harness knows whether the
// generated `ensures` HOLDS. That makes two more verdicts checkable: a true contract must
// never come back `failed` (the false refutation `v.len == old(v.len) + 1` used to get after
// `v.push(x)`), and a deliberately wrong one over modelled ops must come back `failed` with
// a counterexample. A program whose mutation nothing models (a contract-less callee, a loop
// with no invariant) must not `fail` either: `unknown` is the only honest verdict there.
//
// Usage: bun scripts/prove-soundness-fuzz.ts [--cases N] [--seed N] [--keep] [--solver=native]
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const CASES = argOf("--cases", 60);
const SEED = argOf("--seed", 1);
const KEEP = process.argv.includes("--keep");
// Which engine is under test. Both must be sound — `std/smt` is written in Milo and has
// had a false proof of its own before (an i64 overflow inside Fourier-Motzkin elimination
// that reported UNSAT for a satisfiable system), so it gets the same treatment as z3.
const SOLVER = process.argv.includes("--solver=native") ? "" : " --solver=z3";

// Seeded PRNG so a failure is reproducible from the seed printed in the report.
let state = SEED >>> 0 || 1;
function rnd(): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

// One generated program: a `probe` function whose body exercises a construct, plus the
// inputs main will drive it with. `evalProbe` is the same computation in TypeScript — it
// predicts the result so the generated `ensures` can be made deliberately borderline.
interface Shape {
  name: string;
  helpers: string;
  body: (a: number, b: number) => { code: string; value: (a: number, b: number) => number };
}

const SHAPES: Shape[] = [
  {
    // The confirmed false proof: mutation with no assignment in the caller.
    name: "mut-ref-param",
    helpers: "fn addTo(n: &mut i64, k: i64): void {\n    n = n + k\n}\n",
    body: (_a, _b) => {
      const k = int(1, 20);
      return {
        code: `    var x: i64 = a\n    addTo(x, ${k})\n    return x\n`,
        value: (a) => a + k,
      };
    },
  },
  {
    // Same hazard through a struct field written by a callee.
    name: "mut-ref-struct",
    helpers: "struct Box {\n    v: i64,\n}\n\nfn setBox(b: &mut Box, k: i64): void {\n    b.v = k\n}\n",
    body: () => {
      const k = int(1, 20);
      return {
        code: `    var box = Box { v: a }\n    setBox(box, ${k})\n    return box.v\n`,
        value: () => k,
      };
    },
  },
  {
    // Loop havoc: the walker must not carry pre-loop values past the loop.
    name: "loop-accumulate",
    body: (_a, _b) => {
      const n = int(1, 5);
      return {
        code: `    var acc: i64 = a\n    var i: i64 = 0\n    while i < ${n} {\n        acc = acc + b\n        i = i + 1\n    }\n    return acc\n`,
        value: (a, b) => a + n * b,
      };
    },
    helpers: "",
  },
  {
    // A callee whose result is described only by an `ensures` — the modular call model.
    name: "modeled-call",
    helpers: "fn clampLow(n: i64): i64\nensures result >= 0\n{\n    if n < 0 {\n        return 0\n    }\n    return n\n}\n",
    body: () => ({
      code: `    let c = clampLow(a)\n    return c + b\n`,
      value: (a, b) => Math.max(a, 0) + b,
    }),
  },
  {
    // Division and remainder over NEGATIVE operands, where SMT-LIB's Euclidean `div`/`mod`
    // disagree with Milo's truncation. This shape exists because the original 5 shapes
    // could not express it, and a false proof lived here the whole time they were passing.
    name: "trunc-div",
    helpers: "",
    body: () => {
      const d = int(2, 9);
      const op = pick(["/", "%"]);
      // The offset drags the dividend negative for small `a`, which is the only region
      // where Euclidean and truncating semantics differ. It has to appear in BOTH the
      // emitted code and the model — a model that disagrees with the program fits clauses
      // to the wrong values and turns the whole harness into noise.
      const off = int(200, 400);
      return {
        code: `    let n = a - ${off}\n    return n ${op} ${d}\n`,
        // JS `/` with Math.trunc and JS `%` both truncate toward zero, matching Milo.
        value: (a) => (op === "/" ? Math.trunc((a - off) / d) : (a - off) % d),
      };
    },
  },
  {
    // Branching, where each path condition has to reach the postcondition intact.
    name: "branch",
    helpers: "",
    body: () => {
      const t = int(-5, 5);
      return {
        code: `    if a > ${t} {\n        return a - b\n    }\n    return a + b\n`,
        value: (a, b) => (a > t ? a - b : a + b),
      };
    },
  },
];

interface Case { src: string; clause: string; shape: string; control: boolean }

// The clause is fitted to a NARROW sample and then executed against a WIDE one. That gap
// is the entire experiment: a clause true only on the sample is false in general, so a
// prover that reports `proven` for it is provably wrong, and the wide run is what exhibits
// the counterexample. Fitting and running on the same inputs would make every generated
// contract vacuously true at runtime — a harness that cannot fail, which is worse than no
// harness because it reports reassuring numbers.
function generate(): Case {
  const shape = pick(SHAPES);
  const built = shape.body(0, 0);

  const sample: [number, number][] = [];
  for (let i = 0; i < 2; i++) sample.push([int(-8, 8), int(-8, 8)]);
  const wide: [number, number][] = [...sample];
  for (let i = 0; i < 24; i++) wide.push([int(-500, 500), int(-500, 500)]);

  const sampled = sample.map(([a, b]) => built.value(a, b));
  const lo = Math.min(...sampled), hi = Math.max(...sampled);
  const clause = pick([
    `result >= ${lo}`,
    `result <= ${hi}`,
    `result == ${sampled[0]}`,
    `result >= ${lo} && result <= ${hi}`,
  ]);

  const calls = wide.map(([a, b]) => `    print(probe(${a}, ${b}))`).join("\n");
  const src =
    `${shape.helpers}\nfn probe(a: i64, b: i64): i64\nensures ${clause}\n{\n${built.code}}\n\nfn main() {\n${calls}\n}\n`;
  return { src, clause, shape: shape.name, control: false };
}

// A contract that is universally true and within the solver's reach. If these stop coming
// back `proven`, the harness has gone vacuous — it is no longer testing the dangerous
// verdict at all, and a run of "no false proofs" would mean nothing.
function generateControl(): Case {
  const k = int(1, 50);
  const src =
    `fn probe(a: i64, b: i64): i64\nensures result >= 0\n{\n    if a < 0 {\n        return ${k}\n    }\n    return a + ${k}\n}\n\nfn main() {\n    print(probe(-3, 1))\n    print(probe(7, 2))\n}\n`;
  return { src, clause: "result >= 0", shape: "control", control: true };
}

// ---- Container family ----

// Length as a function of the entry length L: `L + d` while every op so far is affine in it,
// or a known constant once something (clear, truncate) pins it. `need` is the smallest L
// the sequence is well-defined for; it becomes the probe's `requires` and main's setup.
type Len = { kind: "affine"; d: number } | { kind: "const"; c: number };
interface VecOp { code: string; modelled: boolean }

function stepLen(len: Len, need: { n: number }, op: string, k: number): Len {
  const atLeast = (m: number) => { if (len.kind === "affine") need.n = Math.max(need.n, m - len.d); };
  switch (op) {
    case "push": case "insert":
      return len.kind === "affine" ? { kind: "affine", d: len.d + 1 } : { kind: "const", c: len.c + 1 };
    case "pop":
      // Total: pop on an empty Vec is a no-op. Made affine by requiring one element.
      if (len.kind === "const") return { kind: "const", c: Math.max(len.c - 1, 0) };
      atLeast(1); return { kind: "affine", d: len.d - 1 };
    case "remove": case "set":
      if (len.kind === "const") return { kind: "const", c: op === "set" ? len.c : len.c - 1 };
      atLeast(1); return op === "set" ? len : { kind: "affine", d: len.d - 1 };
    case "clear": return { kind: "const", c: 0 };
    case "truncate":
      if (len.kind === "const") return { kind: "const", c: Math.min(len.c, k) };
      atLeast(k); return { kind: "const", c: k };
    default: return len;   // frob, loop: length tracked by the oracle, not by the prover
  }
}

interface ContainerCase extends Case { holds: boolean; modelled: boolean }

function generateContainer(): ContainerCase {
  const ops: VecOp[] = [];
  let len: Len = { kind: "affine", d: 0 };
  const need = { n: 0 };
  // One in four sequences carries a mutation the table cannot describe, to pin the
  // `unknown`-not-`failed` half of the rule.
  const unmodelledAt = rnd() < 0.25 ? int(0, 3) : -1;
  let modelled = true;
  const n = int(1, 4);
  for (let i = 0; i < n; i++) {
    if (i === unmodelledAt) {
      modelled = false;
      const loopK = int(1, 3);
      const which = pick(["frob", "loop"]);
      ops.push({ code: which === "frob" ? "    frob(v)\n" : `    for i in 0..${loopK} {\n        v.push(i)\n    }\n`, modelled: false });
      // The oracle still knows the length: frob is a no-op, the loop pushes loopK.
      len = which === "frob" ? len : (len.kind === "affine" ? { kind: "affine", d: len.d + loopK } : { kind: "const", c: len.c + loopK });
      continue;
    }
    const op = pick(["push", "push", "pop", "clear", "set", "insert", "remove", "truncate"]);
    // `set`/`remove` on a constant empty Vec would trap; pick something else.
    if (len.kind === "const" && len.c === 0 && (op === "set" || op === "remove")) { i--; continue; }
    const k = int(0, 2);
    len = stepLen(len, need, op, k);
    const code = {
      push: "    v.push(a)\n", pop: `    let _p${i} = v.pop()\n`, clear: "    v.clear()\n",
      set: "    v[0] = b\n", insert: "    v.insert(0, a)\n", remove: "    v.remove(0)\n",
      truncate: `    v.truncate(${k})\n`,
    }[op]!;
    ops.push({ code, modelled: true });
  }
  const holds = rnd() < 0.5;
  // The true clause is the oracle's own statement; the false one is off by one, which is
  // false for EVERY entry length, so the runtime check below can confirm it.
  const off = holds ? 0 : pick([1, -1]);
  const clause = len.kind === "affine"
    ? `v.len == old(v.len) + ${len.d + off}`
    : `v.len == ${len.c + off}`;
  const setup = Array.from({ length: need.n + int(0, 2) }, (_, i) => `    v.push(${i})`).join("\n");
  const src =
    `fn frob(_v: &mut Vec<i64>): void {\n}\n\n` +
    `fn probe(v: &mut Vec<i64>, a: i64, b: i64): void\n` +
    (need.n > 0 ? `requires v.len >= ${need.n}\n` : "") +
    `ensures ${clause}\n{\n${ops.map(o => o.code).join("")}}\n\n` +
    `fn main() {\n    var v: Vec<i64> = Vec.new()\n${setup}\n    probe(v, 3, 4)\n    print(v.len)\n}\n`;
  return { src, clause, shape: `vec-${ops.length}${modelled ? "" : "-unmodelled"}`, control: false, holds, modelled };
}

const dir = mkdtempSync(join(tmpdir(), "milo-soundfuzz-"));
let proven = 0, refuted = 0, unknown = 0, skipped = 0;
const falseProofs: { file: string; shape: string; clause: string; runtime: string }[] = [];

// Container tallies, split by what the oracle says and whether the table covers every op.
// `falseFailed` and `falseProofs` gate; the rest is the visible number.
const vec = {
  holdsProven: 0, holdsUnknown: 0, falseFailed: [] as string[],
  wrongFailed: 0, wrongUnknown: 0, wrongProven: [] as string[],
  unmodelledUnknown: 0, unmodelledProven: 0, unmodelledFailed: [] as string[],
  oracleDisagreed: [] as string[],
};

function runDebug(file: string): string {
  try {
    return execSync(`bun ${join(ROOT, "src", "main.ts")} run ${file} --debug`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000,
    });
  } catch (e: any) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

let controlsProven = 0, controlsTotal = 0;
for (let i = 0; i < CASES; i++) {
  const c = i % 5 === 0 ? generateControl() : i % 3 === 1 ? generateContainer() : generate();
  if (c.control) controlsTotal++;
  const file = join(dir, `case${i}.milo`);
  writeFileSync(file, c.src);

  let proveOut = "";
  try {
    proveOut = execSync(`bun ${join(ROOT, "src", "main.ts")} prove ${file}${SOLVER}`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000,
    });
  } catch (e: any) {
    proveOut = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const clean = proveOut.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/proven:\s*(\d+)\s+failed:\s*(\d+)\s+unknown:\s*(\d+)\s+errors:\s*(\d+)/);
  if (!m) { skipped++; continue; }

  if ("holds" in c) {
    const vc = c as ContainerCase;
    // The probe's own postcondition is the verdict under test; main's call-site obligation
    // rides along and must not be refuted either (the setup satisfies `requires` exactly).
    const line = clean.split("\n").find(l => /\[postcondition\]\s*probe/.test(l)) ?? "";
    const status = /: proven/.test(line) ? "proven" : /: failed/.test(line) ? "failed" : "unknown";
    const mainRefuted = /\[precondition\]\s*main: failed/.test(clean);
    const keep = () => { const k = join(ROOT, `false-verdict-${i}.milo`); writeFileSync(k, c.src); return `[${c.shape}] ensures ${c.clause} -> ${line.trim()}  repro: ${k}`; };
    // The oracle itself is checked against the machine: a true clause must survive
    // `--debug`, a false one must trip it. A harness whose oracle can be wrong reports
    // reassuring numbers about nothing.
    const violated = /clause violated/.test(runDebug(file));
    if (violated === vc.holds) vec.oracleDisagreed.push(keep());
    if (!vc.modelled) {
      // A refutation is only wrong if the clause is TRUE; a wrong clause may still be
      // refuted for real when a later `clear` pins the length regardless of the gap.
      if (status === "proven" && !vc.holds) vec.wrongProven.push(keep());
      else if ((status === "failed" && vc.holds) || mainRefuted) vec.unmodelledFailed.push(keep());
      else if (status === "proven") vec.unmodelledProven++;
      else if (status === "failed") vec.wrongFailed++;
      else vec.unmodelledUnknown++;
    } else if (vc.holds) {
      if (status === "failed" || mainRefuted) vec.falseFailed.push(keep());
      else if (status === "proven") vec.holdsProven++;
      else vec.holdsUnknown++;
    } else {
      if (status === "proven") vec.wrongProven.push(keep());
      else if (status === "failed") { vec.wrongFailed++; if (!/counterexample/.test(line)) vec.wrongProven.push(keep()); }
      else vec.wrongUnknown++;
      if (mainRefuted) vec.falseFailed.push(keep());
    }
    continue;
  }
  const [, p, f, u] = m.map(Number) as [number, number, number, number];
  if (f > 0) { refuted++; continue; }
  if (p === 0) { unknown += u > 0 ? 1 : 0; skipped += u > 0 ? 0 : 1; continue; }
  proven++;
  if (c.control) controlsProven++;

  // Proven. Now make the machine try to break it.
  let runOut = "";
  try {
    runOut = execSync(`bun ${join(ROOT, "src", "main.ts")} run ${file} --debug`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000,
    });
  } catch (e: any) {
    runOut = (e.stdout ?? "") + (e.stderr ?? "");
  }
  if (/clause violated/.test(runOut)) {
    const kept = join(ROOT, `false-proof-${i}.milo`);
    writeFileSync(kept, c.src);
    falseProofs.push({
      file: kept, shape: c.shape, clause: c.clause,
      runtime: runOut.split("\n").find(l => /clause violated/.test(l))!.trim(),
    });
  }
}

console.log(`seed ${SEED}, ${CASES} cases; scalar family: ${proven} proven, ${refuted} refuted, ${unknown} unknown, ${skipped} skipped`);
console.log(`controls proven: ${controlsProven}/${controlsTotal}`);
console.log(`containers, oracle says holds:    ${vec.holdsProven} proven, ${vec.holdsUnknown} unknown, ${vec.falseFailed.length} FALSE FAILED`);
console.log(`containers, oracle says violated: ${vec.wrongFailed} failed with counterexample, ${vec.wrongUnknown} unknown, ${vec.wrongProven.length} FALSE PROOF`);
console.log(`containers, unmodelled mutation:  ${vec.unmodelledUnknown} unknown, ${vec.unmodelledProven} proven, ${vec.unmodelledFailed.length} FALSE FAILED`);
console.log(`containers, oracle vs runtime disagreements: ${vec.oracleDisagreed.length}`);
// A deliberately wrong contract that z3 cannot refute means the table is not being applied
// at all; with the native engine `unknown` is its atom budget, and only counted.
const wrongUndecided = SOLVER ? vec.wrongUnknown : 0;
const vecBad = [...vec.falseFailed, ...vec.wrongProven, ...vec.unmodelledFailed, ...vec.oracleDisagreed];
if (vecBad.length || wrongUndecided) {
  console.log(`\nCONTAINER GATE FAILED (${vecBad.length} wrong verdicts${wrongUndecided ? `, ${wrongUndecided} wrong contracts left undecided` : ""}):`);
  for (const b of vecBad) console.log(`  ${b}`);
}
if (controlsProven === 0) {
  console.log("VACUOUS RUN: no control contract was proven, so nothing exercised the `proven` path.");
  process.exit(2);
}
if (falseProofs.length === 0) {
  console.log("no false proofs: every `proven` contract survived execution");
} else {
  console.log(`\nFALSE PROOFS (${falseProofs.length}) — prover said proven, the program violated it:`);
  for (const fp of falseProofs) {
    console.log(`  [${fp.shape}] ensures ${fp.clause}`);
    console.log(`    ${fp.runtime}`);
    console.log(`    repro: ${fp.file}`);
  }
}
if (!KEEP) rmSync(dir, { recursive: true, force: true });
process.exit(falseProofs.length === 0 && vecBad.length === 0 && wrongUndecided === 0 ? 0 : 1);
