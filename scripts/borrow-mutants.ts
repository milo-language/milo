#!/usr/bin/env bun
// Mutation gate for the borrow dataflow (src/borrow-flow.ts, src/borrow-flow-park.ts and the borrow events of
// src/place-cfg.ts): does the test corpus pin every rule of the borrow analysis?
// Same harness as scripts/move-mutants.ts (scripts/mutant-gate.ts): each mutant breaks one rule in a private copy of src/,
// the corpus is checked with it, and the mutant is KILLED when
//   - an error test (tests/errors) no longer reports its `// @error:` text, or
//   - a fixture/accepted program now has an error.
// The borrow flow only adds or removes diagnostics (it never changes what codegen reads), so a mutant cannot change what an
// accepted program computes: the interpreter judge of move-mutants has no case here. A mutant that SURVIVES is a rule no
// test exercises: add the program that kills it. A mutant whose anchor is gone is STALE and fails too. The gate fails on both.
//   bun scripts/borrow-mutants.ts [--only <id>] [--jobs N]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { diagKill, errorsOf, makeRoot, snapshot } from "./mutant-gate";

interface Mutant { id: string; rule: string; file: string; anchor: string; replace: string }

const BF = "src/borrow-flow.ts", PC = "src/place-cfg.ts", PARK = "src/borrow-flow-park.ts";
const m = (id: string, file: string, rule: string, anchor: string, replace: string): Mutant => ({ id, file, rule, anchor, replace });

const OVERLAP_IMPORT = "import { Builder, liveness, overlaps, type InheritedLoan, type Node, type Place, type PlaceCfgHost } from \"./place-cfg\";";
const OVERLAP_IMPORT_REAL = "import { Builder, liveness, overlaps as overlapsReal, type InheritedLoan, type Node, type Place, type PlaceCfgHost } from \"./place-cfg\";\n";

const MUTANTS: Mutant[] = [
  // Where a loan opens.
  m("loan-view-let-off", PC, "a view or reference let borrows the place it points into",
    "const viewOf = this.borrowEvents && (this.cr.viewLets.has(s) || this.cr.refLets.has(s)) ? this.viewRoot(s.value) : null;",
    "const viewOf: { place: Place; deep: boolean } | null = null;"),
  m("loan-for-in-off", PC, "a for-in over a local container borrows it for the whole body",
    "if (iterated !== null) this.nodes[head]!.loan = { kind: \"iteration\", place: iterated, span: s.span };", ""),
  m("loan-if-let-ref-off", PC, "an if-let / let-chain ref payload borrows its subject",
    "if (attribute && !this.borrowed.has(sp.split(\".\")[0]!)) cur", "if (false) cur"),
  m("loan-match-arm-ref-off", PC, "a match-arm ref payload borrows its subject",
    "else if (!attribute) cur", "else if (false) cur"),
  m("loan-lines-off", PC, "a loop over t.lines() / t.splitView() borrows t",
    "iterated === null && s.iterable.kind === \"MethodCall\" && (", "iterated === null && false && ("),
  m("loan-pointer-off", PC, "a binding holding v.ptr() borrows v",
    "cur = this.node({ loan: { kind: \"pointer\", place: src, holder, name, call: pv.call, line: pv.line, span } }, cur);", ""),
  m("loan-callback-off", PC, "a callback body borrows the receiver of v.each(cb)",
    "const cbHead = cbPlace === null ? -1 :", "const cbHead = true ? -1 :"),
  m("loan-global-for-in-off", PC, "a for-in over a mutable global borrows the global",
    `?? this.writeBase(s.iterable, true)?.place ?? null) : null;`,
    `?? ((w) => w === null || w.place.includes("#g") ? null : w.place)(this.writeBase(s.iterable, true)) ?? null) : null;`),
  m("loan-index-for-in-off", PC, "a for-in over vs[i] borrows the container vs",
    `?? this.writeBase(s.iterable, true)?.place ?? null) : null;`,
    `?? ((w) => w === null || w.indexed ? null : w.place)(this.writeBase(s.iterable, true)) ?? null) : null;`),
  m("loan-global-slice-off", PC, "a slice or pointer let of a mutable global borrows the global",
    "if (!this.borrowEvents || cur < 0 || this.mutableGlobals.size === 0) return cur;", "return cur;"),
  // How long a loan lasts.
  m("holder-dead-at-once", BF, "a loan lasts while its holder is live (loan treated as ending at once)",
    "  const holderLiveAfter = (n: Node, holder: Place): boolean => {\n", "  const holderLiveAfter = (n: Node, holder: Place): boolean => {\n    return false;\n"),
  m("holder-never-dead", BF, "a loan ends when its holder is dead (loan treated as never ending)",
    "return end !== undefined ? i < end : holderLiveAfter(n, loan.holder!);", "return true;"),
  m("pointer-by-liveness", BF, "a pointer loan lasts to the end of its holder's block, not its last use",
    "const end = loan.kind === \"pointer\" ? b.scopeEnds.get(", "const end = false ? b.scopeEnds.get("),
  m("holder-redef-keeps-loan", BF, "redefining the holder drops the loans it held",
    "if (h === n.def || h.startsWith(n.def + \".\")) out2.delete(l);", ""),
  // Pointer loans and moves of their source.
  m("move-keeps-pointer-loans", BF, "moving the source of a pointer loan ends the loan",
    "          out2.delete(k);\n          if (n.carryTo", "          if (n.carryTo"),
  m("move-no-carry", BF, "moving a local into a new binding carries its pointer loans to it",
    "if (n.carryTo !== undefined && !n.hardMove) out2.add(", "if (false) out2.add("),
  m("field-move-no-carry", BF, "moving a field into a new binding carries the pointer loans on it",
    "if (n.carryTo !== undefined && !n.hardMove) out2.add(", "if (n.carryTo !== undefined && !n.hardMove && !n.use.includes(\".\")) out2.add("),
  m("move-conflicts-pointer", BF, "a move of a pointer's source is not a conflict (the buffer stays where it is)",
    "unsafe || !pointers)", "unsafe)"),
  m("unsafe-write-conflicts", BF, "a write inside unsafe is the one the checker lets through a pointer",
    "unsafe || !pointers)", "!pointers)"),
  // What counts as a write.
  m("self-call-not-write", PC, "a call of a &mut self method writes its receiver",
    "return self !== undefined && self.tag === \"ref\" && self.mutable;", "return false;"),
  m("collection-call-not-write", PC, "a mutating vec/hashmap/string method writes its receiver",
    "&& MUTATING_COLLECTION_METHODS.has(e.method)) return true;", "&& MUTATING_COLLECTION_METHODS.has(e.method)) return false;"),
  m("assign-not-write", PC, "assigning a local place is a write of it",
    "{ def: target, ...(base !== null && {", "{ def: target, ...(false && {"),
  m("elem-assign-not-write", PC, "assigning through a field or index is a write of the base",
    "cur = this.node({ write: { kind: base.indexed ? \"elem\" as const : \"assign\" as const, place: base.place, text: describe(s.target), span: s.span, unsafe: this.unsafeDepth > 0 } }, cur);", ""),
  m("mut-arg-not-write", PC, "a place handed to a &mut parameter is written",
    ": e.args.filter(a => this.cr.autoBorrowed.get(a)?.mutable === true && this.cr.exprTypes.get(a)?.tag !== \"ref\");", ": [];"),
  m("swap-not-write", PC, "swap(a, b) writes both places",
    "verb === \"swap\" ? e.args.slice(0, 2)", "verb === \"swap\" ? []"),
  m("replace-not-write", PC, "replace(a, v) writes its first place",
    "verb === \"replace\" ? e.args.slice(0, 1)", "verb === \"replace\" ? []"),
  m("closure-call-not-write", PC, "calling or passing a closure writes what its body writes",
    "if (cw !== undefined) for (const p of cw.places)", "if (false) for (const p of cw.places)"),
  // What a write conflicts with.
  m("iteration-elem-write-harmless", BF, "an element write under a loop over the container is still an error",
    "(ln.loan?.kind === \"iteration\" || (ln.loan?.kind === \"callback\" && !elem))", "((ln.loan?.kind === \"iteration\" && !elem) || (ln.loan?.kind === \"callback\" && !elem))"),
  m("callback-elem-write-conflicts", BF, "an element write inside a v.each callback is allowed (it never reallocates)",
    "(ln.loan?.kind === \"iteration\" || (ln.loan?.kind === \"callback\" && !elem))", "(ln.loan?.kind === \"iteration\" || ln.loan?.kind === \"callback\")"),
  m("elem-write-view-conflicts", BF, "an element write is no conflict with a shallow view (it never reallocates)",
    "(kind === \"view\" ? elem && ln.loan!.deep !== true :", "(kind === \"view\" ? false :"),
  m("elem-write-deep-view-harmless", BF, "an element write overwrites the element a deep view points into",
    "(kind === \"view\" ? elem && ln.loan!.deep !== true :", "(kind === \"view\" ? elem :"),
  // Overlap.
  m("overlap-exact", BF, "a loan of v.a conflicts with a write of v (a prefix overlaps)",
    OVERLAP_IMPORT, OVERLAP_IMPORT_REAL + "const overlaps = (a: Place, b: Place) => a === b;"),
  m("overlap-root", BF, "a loan of v.a does not conflict with a write of v.b (field siblings are disjoint)",
    OVERLAP_IMPORT, OVERLAP_IMPORT_REAL + "const overlaps = (a: Place, b: Place) => a.split(\".\")[0] === b.split(\".\")[0];"),
  m("index-place-exact", PC, "a write through v[i] is a write of the container v",
    "if (e.kind === \"IndexAccess\") { indexed = true; fields = []; e = e.object; }", "if (e.kind === \"IndexAccess\") return null;"),
  // Parks and globals.
  m("park-ignored", BF, "a call that parks while a global's buffer is borrowed is an error",
    "if (n.effect?.parks) {", "if (false) {"),
  m("global-write-ignored", BF, "a call that writes a global while its buffer is borrowed is an error",
    "if (n.effect.writes.includes(g)) report(", "if (false) report("),
  m("effect-node-off", PC, "a call's park and global-write summary becomes a node of the graph",
    "return fx === undefined ? cur : this.node({ effect: { ...fx, span: e.span } }, cur);", "return cur;"),
  m("callee-writes-off", PARK, "a callee's writes of real globals are kept in its effect",
    "const w = [...(writes.get(t) ?? [])].filter(g => globals.has(g));", "const w: string[] = [];"),
  // Move versus view.
  m("whole-move-unchecked", BF, "moving a whole variable while it is borrowed is an error",
    "    if (moves(n)) {\n      const e = n.expr!;", "    if (moves(n) && n.use!.includes(\".\")) {\n      const e = n.expr!;"),
  m("field-move-unchecked", BF, "moving a field while it is borrowed is an error",
    "    if (moves(n)) {\n      const e = n.expr!;", "    if (moves(n) && !n.use!.includes(\".\")) {\n      const e = n.expr!;"),
];

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const only = opt("--only");
const jobs = opt("--jobs");
const SCRATCH = mkdtempSync(join(tmpdir(), "borrow-mutants-"));

// --probe <id> <file.milo>...: type-check programs with one mutant applied, for writing the test that kills it.
const probe = opt("--probe");
if (probe !== undefined) {
  const mu = MUTANTS.find(x => x.id === probe);
  if (!mu) { console.error(`no mutant ${probe}`); process.exit(2); }
  const root = makeRoot(SCRATCH, mu.id);
  const file = join(root, mu.file);
  const src = readFileSync(file, "utf-8");
  writeFileSync(file, src.replace(mu.anchor, () => mu.replace));
  for (const f of args.slice(args.indexOf("--probe") + 2)) {
    const p = Bun.spawn(["bun", join(root, "src/main.ts"), "check", f], { stdout: "pipe", stderr: "pipe" });
    console.log(`== ${f}\n${await new Response(p.stdout).text()}${await new Response(p.stderr).text()}`);
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(0);
}

const base = await snapshot(makeRoot(SCRATCH, "base"), join(SCRATCH, "base.json"), jobs, false);
// A judge that reads no diagnostics kills nothing and would report every mutant as a survivor, or none as killed for the wrong
// reason: the baseline must show errors on error tests.
const reporting = Object.keys(base).filter(f => f.startsWith("tests/errors/") && errorsOf(base[f]).length > 0).length;
if (reporting < 100) { console.error(`borrow-mutants: baseline reports errors on only ${reporting} error tests; the snapshot is unreadable`); process.exit(1); }
const results: { id: string; rule: string; verdict: string; why: string }[] = [];
for (const mu of MUTANTS) {
  if (only && mu.id !== only) continue;
  const root = makeRoot(SCRATCH, mu.id);
  const file = join(root, mu.file);
  const src = readFileSync(file, "utf-8");
  if (src.split(mu.anchor).length !== 2) { results.push({ id: mu.id, rule: mu.rule, verdict: "STALE", why: "anchor does not occur exactly once" }); continue; }
  rmSync(file);
  writeFileSync(file, src.replace(mu.anchor, () => mu.replace));
  const got = await snapshot(root, join(SCRATCH, `${mu.id}.json`), jobs, false);
  const why = diagKill(base, got);
  results.push(why ? { id: mu.id, rule: mu.rule, verdict: "killed", why } : { id: mu.id, rule: mu.rule, verdict: "SURVIVED", why: "no error test lost its text, no accepted program gained an error" });
  rmSync(root, { recursive: true, force: true });
}
for (const r of results) console.log(`${r.verdict.padEnd(8)} ${r.id.padEnd(30)} ${r.why}`);
const bad = results.filter(r => r.verdict !== "killed");
console.log(`borrow-mutants: ${results.length - bad.length}/${results.length} killed${bad.length ? `; not pinned: ${bad.map(r => `${r.id} (${r.rule})`).join(", ")}` : ""}`);
if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
process.exit(bad.length > 0 || results.length === 0 ? 1 : 0);
