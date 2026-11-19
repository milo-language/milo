#!/usr/bin/env bun
// Mutation gate for src/move-flow.ts: does the test corpus pin every rule of the move analysis?
// Each mutant below breaks one rule. It is applied to a copy of src/ in a temporary root (the tree
// is never touched), the corpus is checked with it (scripts/checker-diag-snapshot.ts --facts), and
// the mutant is KILLED when some test would fail:
//   - an error test (tests/errors) no longer reports its `// @error:` text, or
//   - a fixture that was accepted now has an error, or
//   - a fixture whose move facts changed computes a different result in the interpreter (the
//     executable semantics; a move the analysis got wrong shows up there as E-STUCK), or
//   - failing that, a compiled changed fixture disagrees with the interpreter (mlir-same, up to
//     BINARY_SAMPLE of them): the interpreter reads a string moved through a reference as a share,
//     so a move out of a borrow shows only in the binary, as a double free or a wrong count.
// A mutant that SURVIVES is a rule no test exercises: add the fixture that kills it. The gate fails
// on any survivor. A mutant that no longer applies (its anchor is gone) fails too, so the table
// cannot rot silently.
//   bun scripts/move-mutants.ts [--only <id>] [--jobs N]
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

interface Mutant { id: string; rule: string; anchor: string; replace: string }

const MUTANTS: Mutant[] = [
  { id: "lend-off", rule: "a borrowed argument stays live until the call returns",
    anchor: "  private lend(args: Expr[], cur: number): number {\n", replace: "  private lend(args: Expr[], cur: number): number {\n    return cur;\n" },
  { id: "string-always-move", rule: "a string moves only when nothing reads it later",
    anchor: `out.stringDecisions.set(n.expr, shareAfter(n) ? "share" : "move");`, replace: `out.stringDecisions.set(n.expr, "move");` },
  { id: "capture-always-move", rule: "a string captured by a move closure moves only when nothing reads it later",
    anchor: `byName.set(n.captureString, shareAfter(n) ? "share" : "move");`, replace: `byName.set(n.captureString, "move");` },
  { id: "overlap-exact", rule: "a later read of a field or of the whole keeps the place live",
    anchor: "for (const p of liveIn[s]!) if (overlaps(p, used)) return true;", replace: "for (const p of liveIn[s]!) if (p === used) return true;" },
  { id: "ref-param-owned", rule: "a &T / &mut T parameter is borrowed",
    anchor: "if (p.type && (p.type.isRef || p.type.isRefMut)) this.borrowed.add(id);", replace: "" },
  { id: "view-let-owned", rule: "a view or reference let binding is borrowed",
    anchor: "if (this.cr.viewLets.has(s) || this.cr.refLets.has(s)) this.borrowed.add(id);", replace: "" },
  { id: "pattern-view-owned", rule: "a pattern binding of a borrowed subject is borrowed",
    anchor: "      if (views) this.borrowed.add(id);\n      cur = this.node({ def: id }, cur);", replace: "      cur = this.node({ def: id }, cur);" },
  { id: "closure-param-owned", rule: "a closure parameter is borrowed",
    anchor: "c.params.map(p => ({ ...p, type: { ...(p.type ?? NO_TYPE), isRef: true } }))", replace: "c.params" },
  { id: "assign-no-revive", rule: "assigning a place makes it whole again",
    anchor: "    if (n.def !== undefined) for (const p of [...cur.keys()]) if (p === n.def || p.startsWith(n.def + \".\")) cur.delete(p);\n", replace: "" },
  { id: "never-call-falls-through", rule: "a call of type never ends the path",
    anchor: "        if (callee !== null) cur = this.readCaptures(callee, e, this.node({ use: callee, expr: e, capture: true, callee: e.func, hardMove: this.callsOnce.has(callee) }, cur));\n        return this.cr.exprTypes.get(e)?.tag === \"never\" ? -1 : cur;",
    replace: "        if (callee !== null) cur = this.readCaptures(callee, e, this.node({ use: callee, expr: e, capture: true, callee: e.func, hardMove: this.callsOnce.has(callee) }, cur));\n        return cur;" },
  { id: "forget-soft", rule: "forget(x) moves x whatever its type",
    anchor: "return this.node({ use: forgotten, expr: e.args[0]!, hardMove: true }, cur);", replace: "return this.node({ use: forgotten, expr: e.args[0]!, hardMove: false }, cur);" },
  { id: "heap-deref-soft", rule: "*h by value moves the box's payload",
    anchor: "return this.node({ use: inner, expr: e.operand, hardMove: true }, cur);", replace: "return this.node({ use: inner, expr: e.operand, hardMove: false }, cur);" },
  { id: "call-once-reusable", rule: "calling a closure that moves a capture out consumes it",
    anchor: "callee: e.func, hardMove: this.callsOnce.has(callee) }", replace: "callee: e.func, hardMove: false }" },
  { id: "closure-reads-nothing", rule: "using a by-reference closure binding reads its captures",
    anchor: "    const c = this.closureCaps.get(place);\n    if (c === undefined) return cur;", replace: "    const c = this.closureCaps.get(place);\n    if (c === undefined || c !== undefined) return cur;" },
  { id: "move-closure-borrows", rule: "a move closure takes its non-Copy captures",
    anchor: `captureMove: e.isMove === true && !this.host.isCopyType(c.type) && c.type.tag !== "string",`, replace: "captureMove: false," },
  { id: "subject-moves", rule: "a match subject is taken by the binding arm, not when it is evaluated",
    anchor: "    if (n.subject) return false;", replace: "    if (n.subject) return n.expr !== undefined && cr.movePositions.has(n.expr);" },
  { id: "no-loop-carry", rule: "a move reaching a use around a back edge is a move out of a loop",
    anchor: "const carried = back && m.loop === null ? { ...m, loop: sIdx } : m;", replace: "const carried = m;" },
  { id: "continue-no-back-edge", rule: "continue jumps back to the loop head",
    anchor: "if (l && cur >= 0) this.backTo(cur, l.head); return -1;", replace: "return -1;" },
];

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const only = opt("--only");
const jobs = opt("--jobs");
const SCRATCH = mkdtempSync(join(tmpdir(), "move-mutants-"));

type Facts = Record<string, { diagnostics?: { severity: string; message: string; hint?: string }[]; moved?: string[]; shared?: string[]; sharedCaptures?: string[]; thrown?: unknown }>;

const BINARY_SAMPLE = 12;
const INTERP_SAMPLE = 60;
const POOL = 8;

// A root that shares everything with the checkout except src/ and scripts/, which are private copies
// (the binary judge compiles with the src/ next to its script).
function makeRoot(name: string): string {
  const root = join(SCRATCH, name);
  for (const d of ["src", "scripts"]) cpSync(join(ROOT, d), join(root, d), { recursive: true });
  for (const e of readdirSync(ROOT)) if (e !== "src" && e !== "scripts" && e !== ".git") symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

async function snapshot(root: string, out: string): Promise<Facts> {
  const p = Bun.spawn(["bun", join(ROOT, "scripts/checker-diag-snapshot.ts"), root, out, "--facts", ...(jobs ? ["--jobs", jobs] : [])], { stdout: "ignore", stderr: "inherit" });
  if (await p.exited !== 0) throw new Error(`snapshot failed for ${root}`);
  return JSON.parse(readFileSync(out, "utf-8")) as Facts;
}

// stdout + exit of the reference interpreter, run from `root`'s src.
async function interp(root: string, file: string): Promise<string> {
  const p = Bun.spawn(["bun", join(ROOT, "scripts/guard.ts"), "--mem-mb", "2000", "--timeout-s", "60", "--", "bun", join(root, "src/main.ts"), "interp", join(ROOT, file)], { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  // The stuck report is the verdict; the rest of stderr (timings, paths) is not compared.
  const stuck = (e.match(/E-STUCK[^\n]*/) ?? [""])[0];
  return `${o}\n#exit ${code} ${stuck}`;
}

const errorsOf = (f: Facts[string] | undefined) => (f?.diagnostics ?? []).filter(d => d.severity === "error");
const factsKey = (f: Facts[string] | undefined) => JSON.stringify([f?.moved, f?.shared, f?.sharedCaptures]);

const base = await snapshot(makeRoot("base"), join(SCRATCH, "base.json"));
const interpBase = new Map<string, string>();
const results: { id: string; rule: string; verdict: string; why: string }[] = [];
for (const m of MUTANTS) {
  if (only && m.id !== only) continue;
  const root = makeRoot(m.id);
  const file = join(root, "src/move-flow.ts");
  const src = readFileSync(file, "utf-8");
  if (src.split(m.anchor).length !== 2) { results.push({ id: m.id, rule: m.rule, verdict: "STALE", why: "anchor does not occur exactly once" }); continue; }
  rmSync(file);
  writeFileSync(file, src.replace(m.anchor, m.replace));
  const got = await snapshot(root, join(SCRATCH, `${m.id}.json`));
  let why = "";
  for (const f of Object.keys(base)) {
    const b = base[f], g = got[f];
    if (f.startsWith("tests/errors/")) {
      const want = (readFileSync(join(ROOT, f), "utf-8").match(/\/\/ @error: (.*)/) ?? [])[1]?.trim();
      if (want === undefined) continue;
      const before = errorsOf(b).some(d => `${d.message} ${d.hint ?? ""}`.includes(want));
      const after = errorsOf(g).some(d => `${d.message} ${d.hint ?? ""}`.includes(want));
      if (before && !after) { why = `${f} no longer reports '${want.slice(0, 60)}'`; break; }
      continue;
    }
    if (errorsOf(b).length === 0 && (errorsOf(g).length > 0 || g?.thrown !== undefined)) { why = `${f} is now rejected: ${errorsOf(g)[0]?.message.slice(0, 80) ?? "crash"}`; break; }
  }
  if (!why) {
    const changed = Object.keys(base).filter(f => f.startsWith("tests/fixtures/") && errorsOf(base[f]).length === 0 && factsKey(base[f]) !== factsKey(got[f]));
    // An even sample when a rule changes many fixtures: one broken rule shows up in any of them.
    const step = Math.max(1, Math.ceil(changed.length / INTERP_SAMPLE));
    const sample = changed.filter((_, i) => i % step === 0);
    for (let i = 0; i < sample.length && !why; i += POOL) {
      const batch = sample.slice(i, i + POOL);
      const runs = await Promise.all(batch.map(async f => {
        if (!interpBase.has(f)) interpBase.set(f, await interp(join(SCRATCH, "base"), f));
        return { f, now: await interp(root, f) };
      }));
      const hit = runs.find(r => r.now !== interpBase.get(r.f));
      if (hit) why = `${hit.f} runs differently: ${hit.now.split("\n").filter(Boolean).pop()?.slice(0, 90)}`;
    }
    if (!why && changed.length > 0) {
      const names = sample.slice(0, BINARY_SAMPLE).map(f => f.slice("tests/fixtures/".length, -".milo".length));
      const p = Bun.spawn(["bun", join(root, "scripts/mlir-same.ts"), "--filter", "^(" + names.join("|") + ")$"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      if (await p.exited !== 0) why = `binary differs from the interpreter: ${(out.match(/DIFF [^\n]*/) ?? ["mlir-same failed"])[0].slice(0, 90)}`;
    }
    if (!why) why = `${changed.length} fixtures changed move facts, all run the same (binary checked on ${Math.min(changed.length, BINARY_SAMPLE)})`;
    else { results.push({ id: m.id, rule: m.rule, verdict: "killed", why }); continue; }
    results.push({ id: m.id, rule: m.rule, verdict: "SURVIVED", why });
    continue;
  }
  results.push({ id: m.id, rule: m.rule, verdict: "killed", why });
}
for (const r of results) console.log(`${r.verdict.padEnd(8)} ${r.id.padEnd(26)} ${r.why}`);
const bad = results.filter(r => r.verdict !== "killed");
console.log(`move-mutants: ${results.length - bad.length}/${results.length} killed${bad.length ? `; not pinned: ${bad.map(r => `${r.id} (${r.rule})`).join(", ")}` : ""}`);
if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
process.exit(bad.length > 0 || results.length === 0 ? 1 : 0);
