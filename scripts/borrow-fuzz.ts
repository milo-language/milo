// Differential fuzzer for the borrow dataflow (src/borrow-flow.ts, F) against the reference interpreter (I).
// I is the oracle: it gets stuck on E-BORROW when a view is read after its Vec changed length or capacity,
// and on R-MEM-UAF when a raw pointer is.
//   bun scripts/borrow-fuzz.ts --seed N --count N --jobs N [--keep N]
// Program i of seed s is generated from PRNG(s, i) alone, so any finding reproduces from (seed, index).
// Classes:
//   FLOW-UNSOUND      F empty, I stuck: the flow accepts a stale read. Exit 1.
//   FLOW-CONSERVATIVE F non-empty, I runs clean: the flow rejects a program the interpreter finds safe.
//   AGREE             F non-empty and I stuck, or F empty and I not stuck.
// Workers run programs in-process and stream one JSON line per program; the parent kills a worker that
// goes silent (a hang in the checker or interpreter) and counts that program as timeout.
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { cpus, tmpdir } from "os";
import { templateOf } from "./borrow-templates";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const seed = Number(opt("--seed") ?? 1);
const count = Number(opt("--count") ?? 500);
const jobs = Number(opt("--jobs") ?? Math.max(1, cpus().length - 2));
const keep = Number(opt("--keep") ?? 5);
const STALL_MS = 15000;

// ── generator ──
// A program is a tree of statements; the minimizer deletes nodes and unwraps blocks.
interface S { head: string; pre?: string; body?: S[]; els?: S[]; close?: string }
const leaf = (head: string): S => ({ head });

function rng(a: number, b: number): () => number {
  let s = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Vec { name: string; ty: "i64" | "string"; dead: boolean }
interface Loan { kind: "slice" | "ptr" | "get"; name: string; src: Vec }
interface Ctx { r: () => number; vecs: Vec[]; loans: Loan[]; closures: { name: string; src: Vec }[]; iter: Vec[]; n: number; inLoop: boolean }

const chance = (c: Ctx, p: number) => c.r() < p;
const pick = <T>(c: Ctx, xs: T[]): T => xs[Math.floor(c.r() * xs.length)]!;
const fresh = (c: Ctx, p: string) => `${p}${c.n++}`;
const lit = (c: Ctx, ty: Vec["ty"]) => ty === "i64" ? String(1 + Math.floor(c.r() * 9)) : `"${pick(c, ["a", "bb", "ccc"])}"`;
const vecLit = (c: Ctx, ty: Vec["ty"]) => `[${Array.from({ length: 2 + Math.floor(c.r() * 3) }, () => lit(c, ty)).join(", ")}]`;
const live = (c: Ctx) => c.vecs.filter(v => !v.dead);

// Prefer a source that has a loan or is being iterated: a fuzzer that never builds a conflict proves nothing.
function source(c: Ctx): Vec | undefined {
  const vs = live(c);
  if (vs.length === 0) return undefined;
  const hot = vs.filter(v => c.loans.some(l => l.src === v) || c.iter.includes(v) || c.closures.some(k => k.src === v));
  return hot.length > 0 && chance(c, 0.75) ? pick(c, hot) : pick(c, vs);
}

function write(c: Ctx, v: Vec): S {
  const k = pick(c, ["push", "pop", "insert", "clear", "elem", "reassign", "helper", "push", "helper"]);
  switch (k) {
    case "push": return leaf(`${v.name}.push(${lit(c, v.ty)})`);
    case "pop": return leaf(`${v.name}.pop()`);
    case "insert": return leaf(`${v.name}.insert(0, ${lit(c, v.ty)})`);
    case "clear": return leaf(`${v.name}.clear()`);
    case "elem": return leaf(`${v.name}[0] = ${lit(c, v.ty)}`);
    case "reassign": return leaf(`${v.name} = ${vecLit(c, v.ty)}`);
    default: return leaf(`${v.ty === "i64" ? "bumpI" : "bumpS"}(&mut ${v.name})`);
  }
}

function readLoan(c: Ctx, l: Loan): S {
  if (l.kind === "ptr") return leaf(`unsafe { print(*${l.name}) }`);
  if (l.kind === "get") return leaf(`print(${l.name})`);
  return leaf(pick(c, [`print(${l.name}[0])`, `print(${l.name}.len())`]));
}

function block(c: Ctx, n: number, depth: number): S[] {
  const mark = [c.vecs.length, c.loans.length, c.closures.length, c.iter.length];
  const out: S[] = [];
  for (let i = 0; i < n; i++) out.push(...stmt(c, depth));
  c.vecs.length = mark[0]!; c.loans.length = mark[1]!; c.closures.length = mark[2]!; c.iter.length = mark[3]!;
  return out;
}

function stmt(c: Ctx, depth: number): S[] {
  type K = [string, number];
  const ks: K[] = [["slice", 10], ["ptr", 7], ["for", 8], ["iflet", 6], ["clodef", 6], ["each", 5], ["write", 18], ["move", 3], ["read", 26]];
  if (c.closures.length > 0) ks.push(["clocall", 8]);
  if (depth < 2) ks.push(["if", 6], ["while", 4]);
  if (c.inLoop) ks.push(["break", 2]);
  let t = c.r() * ks.reduce((a, [, w]) => a + w, 0), kind = "read";
  for (const [k, w] of ks) { if ((t -= w) < 0) { kind = k; break; } }
  const v = source(c);
  if (kind === "if") {
    const cond = pick(c, ["flag", "!flag", "true", "flag"]);
    const s: S = { head: `if ${cond}`, body: block(c, 1 + Math.floor(c.r() * 3), depth + 1) };
    if (chance(c, 0.6)) s.els = block(c, 1 + Math.floor(c.r() * 2), depth + 1);
    return [s];
  }
  if (kind === "while") {
    const i = fresh(c, "i"), was = c.inLoop;
    c.inLoop = true;
    const body = block(c, 1 + Math.floor(c.r() * 3), depth + 1);
    c.inLoop = was;
    return [{ pre: `var ${i} = 0`, head: `while ${i} < 3`, body: [leaf(`${i} += 1`), ...body] }];
  }
  if (kind === "break") return [leaf("break")];
  if (kind === "clocall") { const k = pick(c, c.closures); return [leaf(`${k.name}()`)]; }
  if (!v) return [];
  switch (kind) {
    case "slice": {
      const name = fresh(c, "s"), a = Math.floor(c.r() * 2);
      c.loans.push({ kind: "slice", name, src: v });
      return [leaf(`let ${name} = ${v.name}[${a}..${a + 1 + Math.floor(c.r() * 2)}]`)];
    }
    case "ptr": {
      if (v.ty !== "i64") return [];
      const name = fresh(c, "p");
      c.loans.push({ kind: "ptr", name, src: v });
      return [leaf(`let ${name} = ${v.name}.ptr()`)];
    }
    case "for": {
      const x = fresh(c, "x"), was = c.inLoop;
      c.iter.push(v); c.inLoop = true;
      const body: S[] = [leaf(`print(${x})`)];
      if (chance(c, 0.6)) body.push(write(c, v));
      if (chance(c, 0.4)) body.push(...block(c, 1 + Math.floor(c.r() * 2), depth + 1));
      c.iter.pop(); c.inLoop = was;
      return [{ head: `for ${x} in ${v.name}`, body }];
    }
    case "iflet": {
      const r = fresh(c, "r");
      const body: S[] = [];
      if (chance(c, 0.7)) body.push(write(c, v));
      body.push(leaf(`print(${r})`));
      return [{ head: `if let Some(${r}) = ${v.name}.get(${Math.floor(c.r() * 2)})`, body }];
    }
    case "clodef": {
      const name = fresh(c, "c");
      c.closures.push({ name, src: v });
      return [{ head: `let ${name} = (): void =>`, body: [write(c, v)] }];
    }
    case "each": {
      const x = fresh(c, "x");
      const body: S[] = [leaf(`print(${x})`)];
      if (chance(c, 0.6)) body.push(write(c, v));
      return [{ head: `${v.name}.each((${x}) =>`, body, close: "})" }];
    }
    case "write": return [write(c, v)];
    case "move": {
      // A global or an element cannot be moved out of by a `var`.
      if (v.name === "G0" || v.name.includes("[")) return [];
      const name = fresh(c, "w");
      v.dead = true;
      c.vecs.push({ name, ty: v.ty, dead: false });
      return [leaf(`var ${name} = ${v.name}`), leaf(`${name}.push(${lit(c, v.ty)})`)];
    }
    default: {
      const ls = c.loans;
      if (ls.length > 0 && chance(c, 0.8)) return [readLoan(c, pick(c, ls))];
      return [leaf(`print(${v.name}.len())`)];
    }
  }
}

function render(ss: S[], ind: string, out: string[]) {
  for (const s of ss) {
    if (s.pre) out.push(ind + s.pre);
    if (!s.body) { out.push(ind + s.head); continue; }
    out.push(`${ind}${s.head} {`);
    render(s.body, ind + "    ", out);
    if (s.els) { out.push(`${ind}} else {`); render(s.els, ind + "    ", out); }
    out.push(`${ind}${s.close ?? "}"}`);
  }
}

const PRELUDE = `struct H { items: Vec<i64> }
fn bumpI(v: &mut Vec<i64>): void { v.push(1) }
fn bumpS(v: &mut Vec<string>): void { v.push("z") }
`;

function gen(seedN: number, idx: number): S[] {
  const r = rng(seedN, idx);
  const c: Ctx = { r, vecs: [], loans: [], closures: [], iter: [], n: 0, inLoop: false };
  const head: S[] = [leaf("let flag = true")];
  const nv = 1 + Math.floor(r() * 3);
  for (let i = 0; i < nv; i++) {
    const ty = r() < 0.2 ? "string" : "i64";
    const name = `v${i}`;
    c.vecs.push({ name, ty, dead: false });
    head.push(leaf(`var ${name}: Vec<${ty}> = ${vecLit(c, ty)}`));
    // A `var` that is never mutated is a type error, so every Vec is written once before any loan exists.
    head.push(leaf(`${name}.push(${lit(c, ty)})`));
  }
  if (r() < 0.4) { head.push(leaf(`var h = H { items: ${vecLit(c, "i64")} }`)); c.vecs.push({ name: "h.items", ty: "i64", dead: false }); head.push(leaf("h.items.push(1)")); }
  // A module-level Vec and an element of a Vec<Vec<i64>> (`for x in vs[0]`): places a local-only loan table never sees.
  // Their own PRNG keeps the programs of the local shapes stable for a given (seed, index).
  const r2 = rng(seedN ^ 0x5bd1e995, idx);
  if (r2() < 0.35) {
    head.unshift(leaf(`@global var G0: Vec<i64> = ${vecLit(c, "i64")}`));
    head.push(leaf("G0.push(1)"));
    c.vecs.push({ name: "G0", ty: "i64", dead: false });
  }
  if (r2() < 0.35) {
    head.push(leaf(`var vs: Vec<Vec<i64>> = [${vecLit(c, "i64")}, ${vecLit(c, "i64")}]`), leaf("vs[0].push(1)"));
    c.vecs.push({ name: "vs[0]", ty: "i64", dead: false });
  }
  const body = block(c, 5 + Math.floor(r() * 21), 0);
  // The tail reads every loan and Vec so a stale view is read, not just taken.
  return [...head, ...body];
}

const sourceOf = (ss: S[]): string => {
  const out: string[] = [];
  const globals = ss.filter(s => s.head.startsWith("@global ")).map(s => s.head.slice(8));
  render(ss.filter(s => !s.head.startsWith("@global ")), "    ", out);
  return `${PRELUDE}${globals.join("\n")}${globals.length > 0 ? "\n" : ""}fn main(): void {\n${out.join("\n")}\n}\n`;
};

// ── evaluation ──
type Outcome = "clean" | "panic" | "timeout" | "unsupported" | `stuck:${string}`;
interface Eval { status: "ok" | "parse" | "typeerr" | "crash"; F: string[]; I: Outcome; detail?: string }

const at = (s: { line?: number; col?: number } | undefined) => `${s?.line}:${s?.col}`;
let mods: any;
async function modules() {
  if (mods) return mods;
  mods = {
    Lexer: (await import(join(ROOT, "src/lexer.ts"))).Lexer,
    Parser: (await import(join(ROOT, "src/parser.ts"))).Parser,
    resolveImports: (await import(join(ROOT, "src/resolver.ts"))).resolveImports,
    TypeChecker: (await import(join(ROOT, "src/checker.ts"))).TypeChecker,
    getHostTarget: (await import(join(ROOT, "src/target.ts"))).getHostTarget,
    Interp: (await import(join(ROOT, "src/interp.ts"))).Interp,
    InterpStuck: (await import(join(ROOT, "src/interp-values.ts"))).InterpStuck,
  };
  return mods;
}

async function evaluate(src: string): Promise<Eval> {
  const m = await modules();
  const path = join(ROOT, "borrow-fuzz-virtual.milo");
  let program, cr, tc;
  try {
    program = m.resolveImports(new m.Parser(new m.Lexer(src).tokenize(), src, path).parse(), dirname(path), m.getHostTarget(), path);
    tc = new m.TypeChecker();
    cr = tc.check(program);
  } catch (e) { return { status: "parse", F: [], I: "clean", detail: (e as Error).message?.slice(0, 80) }; }
  // The checker's own errors are the flow's (it reports them) plus the walk's local rules; a program with a local-rule
  // error (same-call exclusivity, structural, capture) is skipped: the interpreter would run it past a rule it does not model.
  const errs = cr.diagnostics.filter((d: any) => d.severity === "error");
  const other = errs.find((d: any) => templateOf(d.message) === null);
  if (other) return { status: "typeerr", F: [], I: "clean", detail: other.message };
  const F = errs.map((d: any) => `${d.message} @${at(d.span)}`).sort();
  let I: Outcome = "clean";
  try {
    const r = new m.Interp(program, cr).run();
    if (r.code === 134) I = "panic";
    else if (r.code !== 0) I = "panic";
  } catch (e) { I = e instanceof m.InterpStuck ? `stuck:${(e as { rule: string }).rule}` : "unsupported"; }
  return { status: "ok", F: [...new Set<string>(F)], I };
}

function classify(e: Eval): string[] {
  // A raw pointer read after its Vec changed is R-MEM-UAF in the interpreter, a view read is E-BORROW:
  // both are the stale-view read this fuzzer exists to catch.
  const stuck = e.I === "stuck:E-BORROW" || e.I === "stuck:R-MEM-UAF";
  if (stuck && e.F.length === 0) return ["FLOW-UNSOUND"];
  if (!stuck && e.F.length > 0 && e.I === "clean") return ["FLOW-CONSERVATIVE"];
  return ["AGREE"];
}

// The templates of the flow's errors: a CONSERVATIVE example is minimized to keep one of them, so it isolates one rule
// instead of whatever else the program also trips.
const msgOf = (m: string) => m.replace(/ @.*$/, "");
function sigs(e: Eval): string[] {
  return [...new Set(e.F.map(m => `flow ${templateOf(msgOf(m))}`))].sort();
}

// ── minimizer: statement deletion and block unwrapping while the class holds ──
const clone = (ss: S[]): S[] => structuredClone(ss);
// Every statement list in the tree, addressed by a path of (index, "body"|"els") steps.
function lists(root: S[]): S[][] {
  const out: S[][] = [root];
  const walk = (ss: S[]) => { for (const s of ss) { if (s.body) { out.push(s.body); walk(s.body); } if (s.els) { out.push(s.els); walk(s.els); } } };
  walk(root);
  return out;
}

async function minimize(ss: S[], tag: string, sig: string): Promise<S[]> {
  const holds = async (t: S[]) => { const e = await evaluate(sourceOf(t)); return e.status === "ok" && classify(e).includes(tag) && (sig === "" || sigs(e).includes(sig)); };
  let cur = ss;
  for (let changed = true; changed;) {
    changed = false;
    const total = lists(cur).reduce((a, l) => a + l.length, 0);
    for (let k = 0; k < total && !changed; k++) {
      // k-th statement in list order: try deleting it, then (for blocks) replacing it by its body.
      for (const mode of ["delete", "unwrap", "purge"] as const) {
        const t = clone(cur);
        let seen = 0, done = false;
        for (const l of lists(t)) {
          if (seen + l.length <= k) { seen += l.length; continue; }
          const i = k - seen, s = l[i]!;
          if (mode === "delete") l.splice(i, 1);
          else if (mode === "purge") {
            // Drop a declaration together with every statement that mentions it (a lone one is a type error).
            const name = /^(?:var|let) (\w+)/.exec(s.head)?.[1];
            if (!name) break;
            const re = new RegExp(`\\b${name}\\b`);
            const mentions = (n: S): boolean => re.test(n.head) || re.test(n.pre ?? "") || (n.body ?? []).some(mentions) || (n.els ?? []).some(mentions);
            for (const x of lists(t)) for (let j = x.length - 1; j >= 0; j--) if (mentions(x[j]!)) x.splice(j, 1);
          } else if (s.body) l.splice(i, 1, ...(s.pre ? [leaf(s.pre)] : []), ...s.body);
          else break;
          done = true;
          break;
        }
        if (done && await holds(t)) { cur = t; changed = true; break; }
      }
    }
  }
  return cur;
}

// ── worker: run the given indices, one JSON line each ──
if (opt("--worker") !== undefined) {
  const idxs = opt("--worker")!.split(",").filter(Boolean).map(Number);
  for (const i of idxs) {
    const e = await evaluate(sourceOf(gen(seed, i)));
    console.log(JSON.stringify({ i, ...e, tags: e.status === "ok" ? classify(e) : [] }));
  }
  process.exit(0);
}

if (opt("--show") !== undefined) {
  const e = await evaluate(await Bun.file(opt("--show")!).text());
  for (const m of e.F) console.log(`F ${m}`);
  console.log(`I ${e.I} ${e.status} ${classify(e).join(",")}`);
  process.exit(0);
}

if (opt("--minimize") !== undefined) {
  const [tag, idx, sig] = opt("--minimize")!.split("|") as [string, string, string];
  const min = await minimize(gen(seed, Number(idx)), tag, sig ?? "");
  console.log(`@@min ${JSON.stringify(sourceOf(min))}`);
  process.exit(0);
}

// ── parent ──
interface Row extends Eval { i: number; tags: string[] }
const rows = new Map<number, Row>();
const timeouts: number[] = [];

async function runWorker(idxs: number[]) {
  let todo = idxs;
  while (todo.length > 0) {
    const p = Bun.spawn(["bun", import.meta.path, "--seed", String(seed), "--worker", todo.join(",")], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
    let last = Date.now();
    const timer = setInterval(() => { if (Date.now() - last > STALL_MS) p.kill(); }, 1000);
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith("{")) { const r = JSON.parse(line) as Row; rows.set(r.i, r); last = Date.now(); }
      }
    }
    await p.exited;
    clearInterval(timer);
    todo = todo.filter(i => !rows.has(i) && !timeouts.includes(i));
    if (todo.length > 0) { timeouts.push(todo[0]!); todo = todo.slice(1); }
  }
}

const shards: number[][] = Array.from({ length: jobs }, () => []);
for (let i = 0; i < count; i++) shards[i % jobs]!.push(i);
await Promise.all(shards.map(runWorker));

const all = [...rows.values()];
const ok = all.filter(r => r.status === "ok");
const byTag = new Map<string, Row[]>();
for (const r of ok) for (const t of r.tags) (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(r);
const frac = (n: number, d: number) => `${n}/${d} (${d ? (100 * n / d).toFixed(1) : "0.0"}%)`;
const conflict = ok.filter(r => r.F.length > 0).length;
const stuckN = ok.filter(r => r.I === "stuck:E-BORROW").length;
console.log(`borrow-fuzz seed=${seed} count=${count}: ${ok.length} judged, ${all.filter(r => r.status === "parse").length} parse failures, ${all.filter(r => r.status === "typeerr").length} non-borrow type errors, ${all.filter(r => r.status === "crash").length} flow crashes, ${timeouts.length} timeouts`);
console.log(`conflict (F non-empty):         ${frac(conflict, ok.length)}`);
console.log(`stuck at E-BORROW:           ${frac(stuckN, ok.length)}`);
const outcomes = new Map<string, number>();
for (const r of ok) outcomes.set(r.I, (outcomes.get(r.I) ?? 0) + 1);
console.log(`interpreter outcomes: ${[...outcomes].map(([k, v]) => `${k}=${v}`).join(" ")}`);
for (const t of ["FLOW-UNSOUND", "FLOW-CONSERVATIVE", "AGREE"]) console.log(`${t.padEnd(18)} ${byTag.get(t)?.length ?? 0}`);
{ const h = new Map<string, number>(); for (const r of all.filter(r => r.status === "typeerr")) { const k = (r.detail ?? "").replace(/'[^']*'/g, "_"); h.set(k, (h.get(k) ?? 0) + 1); } for (const [k, v] of [...h].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  skipped x${v}: ${k}`); }
for (const r of all.filter(r => r.status === "crash")) console.log(`crash #${r.i}: ${r.detail}`);

// Which rules the conservative rejections come from, by template.
const sideCounts = new Map<string, number>();
for (const r of byTag.get("FLOW-CONSERVATIVE") ?? []) for (const k of sigs(r)) sideCounts.set(k, (sideCounts.get(k) ?? 0) + 1);
for (const [k, v] of [...sideCounts].sort()) console.log(`  conservative ${k}: ${v}`);

const seenSig = new Set<string>();
const outDir = join(process.env.TMPDIR ?? tmpdir(), "borrow-fuzz");
mkdirSync(outDir, { recursive: true });
for (const tag of ["FLOW-UNSOUND", "FLOW-CONSERVATIVE"]) {
  const rs = byTag.get(tag) ?? [];
  const seen = new Set<string>();
  let written = 0;
  for (const r of rs) {
    if (written >= keep) break;
    // CONSERVATIVE rows are picked so each example shows a rule not yet shown.
    const isDis = tag === "FLOW-CONSERVATIVE";
    const sig = isDis ? sigs(r).find(s => !seenSig.has(`${tag} ${s}`)) : "";
    if (sig === undefined) continue;
    seenSig.add(`${tag} ${sig}`);
    const p = Bun.spawn(["bun", import.meta.path, "--seed", String(seed), "--minimize", `${tag}|${r.i}|${sig}`], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 120000);
    const text = await new Response(p.stdout).text();
    clearTimeout(timer);
    const m = /@@min (.*)$/m.exec(text);
    const src = m ? JSON.parse(m[1]!) as string : sourceOf(gen(seed, r.i));
    // Distinct minimized shapes only: the same two-line conflict found twice is one example.
    const shape = src.replace(/\d+/g, "N");
    if (seen.has(shape)) continue;
    seen.add(shape);
    const f = join(outDir, `${tag}-${seed}-${written++}.milo`);
    writeFileSync(f, src);
    console.log(`${tag}: ${f}${m ? "" : " (not minimized)"}${sig ? ` [${sig}]` : ""}`);
  }
}
process.exit((byTag.get("FLOW-UNSOUND")?.length ?? 0) > 0 ? 1 : 0);
