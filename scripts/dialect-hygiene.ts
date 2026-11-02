#!/usr/bin/env bun
// Hygiene gate for the milo MLIR dialect (mlir/Milo.td): docs on every op, type and
// attribute, and no hygiene count below its baseline.
//
// Every op, type, attribute and the dialect itself must have a summary and a description,
// every error an op verifier in mlir/Milo.cpp can emit must be expected by some
// verify-diagnostics case, and the counts of verifiers, declared effects, interfaces,
// folders, canonicalizers and verify-diagnostics cases never drop below
// scripts/dialect-hygiene.baseline.json.
//
//   bun scripts/dialect-hygiene.ts            # counts; exit 1 on a missing doc or a regression
//   bun scripts/dialect-hygiene.ts --ops      # also one row per op
//   bun scripts/dialect-hygiene.ts --update   # write the current counts as the new baseline
//   bun scripts/dialect-hygiene.ts --uncovered  # list verifier errors no test expects
//
// Milo.td is read through `llvm-tblgen --dump-json` (the LLVM install build.sh uses), so
// classes, `let` overrides and trait lists are resolved by TableGen itself rather than by a
// regex over the source: an op that inherits its verifier from a class counts.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const TD = join(ROOT, "mlir", "Milo.td");
const TESTS = join(ROOT, "mlir", "test");
const BASELINE = join(ROOT, "scripts", "dialect-hygiene.baseline.json");

function llvmBin(): string {
  if (process.env.MILO_LLVM_BIN) return process.env.MILO_LLVM_BIN;
  for (const d of ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin", "/home/linuxbrew/.linuxbrew/opt/llvm/bin", "/usr/lib/llvm-23/bin"])
    if (existsSync(join(d, "llvm-tblgen"))) return d;
  throw new Error("no LLVM 23 install with llvm-tblgen found: set MILO_LLVM_BIN");
}

type Rec = Record<string, any>;
const bin = llvmBin();
const dump = Bun.spawnSync([join(bin, "llvm-tblgen"), "--dump-json", "-I", join(bin, "..", "include"), TD]);
if (dump.exitCode !== 0) {
  process.stderr.write(dump.stderr);
  process.exit(1);
}
const J: Record<string, Rec> = JSON.parse(dump.stdout.toString());
const instances = (cls: string): string[] => (J["!instanceof"] as any)[cls] ?? [];
const supers = (name: string): string[] => J[name]?.["!superclasses"] ?? [];
const isMilo = (r: Rec, field: string) => r[field]?.def === "Milo_Dialect";
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Effects an op declares, in any of the ODS spellings: Pure, a MemoryEffects<...> trait,
// RecursiveMemoryEffects, a hand-written getEffects, or MemRead/MemWrite/... on an operand
// or result (Arg<..., [MemRead]>). An op with none has unknown effects (any memory).
function effects(r: Rec): "pure" | "declared" | "unknown" {
  const traits: string[] = (r.traits ?? []).map((t: Rec) => t.def);
  if (traits.includes("Pure")) return "pure";
  for (const t of traits) {
    const s = supers(t);
    if (t === "RecursiveMemoryEffects" || t === "NoMemoryEffect" || s.includes("MemoryEffects")) return "declared";
    if (s.includes("DeclareOpInterfaceMethods") && J[t].cppInterfaceName === "MemoryEffectOpInterface") return "declared";
  }
  for (const dag of [r.arguments, r.results])
    for (const [arg] of dag?.args ?? [])
      if (arg?.def && supers(arg.def).includes("Arg") && (J[arg.def].decorators ?? []).some((d: Rec) => supers(d.def).includes("MemoryEffect")))
        return "declared";
  return "unknown";
}

// Op interfaces attached by trait (OpInterface or DeclareOpInterfaceMethods), by C++ name.
function interfaces(r: Rec): string[] {
  const out: string[] = [];
  for (const t of (r.traits ?? []).map((t: Rec) => t.def)) {
    const s = supers(t);
    if (!(s.includes("OpInterface") || s.includes("OpInterfaceTrait"))) continue;
    // MemoryEffects<...> and a hand-written getEffects are counted as effects, not here.
    if (s.includes("SideEffectsTraitBase") || J[t].cppInterfaceName === "MemoryEffectOpInterface") continue;
    out.push(J[t].cppInterfaceName ?? t);
  }
  return [...new Set(out)];
}

interface OpRow { name: string; summary: boolean; description: boolean; verifier: boolean; effects: string; folder: boolean; canonicalizer: boolean; interfaces: string[] }

const ops: OpRow[] = instances("Op").filter((n) => isMilo(J[n], "opDialect")).map((n) => {
  const r = J[n];
  return {
    name: `milo.${r.opName}`,
    summary: text(r.summary) !== "",
    description: text(r.description) !== "",
    verifier: !!(r.hasVerifier || r.hasRegionVerifier),
    effects: effects(r),
    folder: !!r.hasFolder,
    canonicalizer: !!(r.hasCanonicalizer || r.hasCanonicalizeMethod),
    interfaces: interfaces(r),
  };
});
const types = instances("TypeDef").filter((n) => isMilo(J[n], "dialect"));
const attrs = [...instances("AttrDef").filter((n) => isMilo(J[n], "dialect")),
  ...instances("EnumAttrInfo").filter((n) => n.startsWith("Milo_"))];
const dialect = J["Milo_Dialect"];

// Each `expected-error` in a file the verifier tests run (-verify-diagnostics) is one case.
let diagCases = 0;
let fileCheckFiles = 0;
const expected: string[] = [];
for (const f of readdirSync(TESTS).filter((f) => f.endsWith(".mlir"))) {
  const src = readFileSync(join(TESTS, f), "utf8");
  const runs = src.split("\n").filter((l) => l.startsWith("// RUN:"));
  if (runs.some((l) => l.includes("-verify-diagnostics"))) {
    diagCases += src.match(/expected-error/g)?.length ?? 0;
    for (const m of src.matchAll(/expected-error[^{]*\{\{(.*?)\}\}/g)) expected.push(m[1]);
  }
  if (runs.some((l) => l.includes("FileCheck"))) fileCheckFiles++;
}

// Every error an op verifier in Milo.cpp can emit, by the text of its first string literal,
// must have a verify-diagnostics case that expects it.
// An error is the statement from `emitOpError(` to its `;`; an expected text covers it when
// it contains one of the statement's string literals or lies inside one.
const verifierErrors = [...new Set([...readFileSync(join(ROOT, "mlir", "Milo.cpp"), "utf8")
  .matchAll(/emitOpError\(([^;]*);/g)].map((m) => m[1]))];
const pieces = (stmt: string) => [...stmt.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((p) => p.trim().length >= 4);
const uncovered = verifierErrors.filter((stmt) =>
  !pieces(stmt).some((p) => expected.some((e) => e.includes(p.trim()) || p.includes(e))));

const counts: Record<string, number> = {
  ops: ops.length,
  types: types.length,
  attrs: attrs.length,
  summary: ops.filter((o) => o.summary).length,
  description: ops.filter((o) => o.description).length,
  verifier: ops.filter((o) => o.verifier).length,
  effectsDeclared: ops.filter((o) => o.effects !== "unknown").length,
  pure: ops.filter((o) => o.effects === "pure").length,
  interfaces: ops.reduce((n, o) => n + o.interfaces.length, 0),
  folders: ops.filter((o) => o.folder).length,
  canonicalizers: ops.filter((o) => o.canonicalizer).length,
  verifyDiagnosticsCases: diagCases,
  verifierErrorsCovered: verifierErrors.length - uncovered.length,
  fileCheckFiles,
};

const problems: string[] = [];
if (!text(dialect.summary) || !text(dialect.description)) problems.push("the milo dialect lacks a summary or a description");
for (const o of ops) {
  if (!o.summary) problems.push(`${o.name} has no summary`);
  if (!o.description) problems.push(`${o.name} has no description`);
}
for (const n of [...types, ...attrs]) {
  if (!text(J[n].summary)) problems.push(`${n} has no summary`);
  if (!text(J[n].description)) problems.push(`${n} has no description`);
}
for (const stmt of uncovered)
  problems.push(`no verify-diagnostics case expects the error of emitOpError(${stmt.split("\n")[0].trim()}`);

// The generated reference (mlir/build.sh) must be what Milo.td generates now.
const DOC = join(ROOT, "docs", "dialect", "milo.md");
const MARK = "<!-- Autogenerated by mlir-tblgen";
const gen = Bun.spawnSync([join(bin, "mlir-tblgen"), "-gen-dialect-doc", "-dialect=milo", "-I", join(bin, "..", "include"), TD]);
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
if (gen.exitCode !== 0 || !doc.includes(MARK) || doc.slice(doc.indexOf(MARK)) !== gen.stdout.toString())
  problems.push("docs/dialect/milo.md is stale or missing: run sh mlir/build.sh");

// The site includes the reference (docs/site/mlir-dialect.md), and VitePress parses prose as
// Vue: a bare `Vec<T>` outside backticks is an unclosed tag that fails the whole site build.
{
  let fence = false;
  doc.split("\n").forEach((line, i) => {
    if (line.startsWith("```")) { fence = !fence; return; }
    const prose = fence ? "" : line.replace(/`[^`]*`/g, "");
    if (/<\/?(table|tr|td|th|thead|tbody|br)\b|^\s*<!--/.test(prose)) return;
    if (/<\/?[A-Za-z]|\{\{/.test(prose)) problems.push(`docs/dialect/milo.md:${i + 1}: angle brackets or {{ outside backticks (put the type in backticks in Milo.td): ${line.trim().slice(0, 80)}`);
  });
}

const args = process.argv.slice(2);
if (args.includes("--uncovered")) for (const m of uncovered) console.log(`uncovered verifier error: ${m}`);
if (args.includes("--ops")) {
  const yn = (b: boolean) => (b ? "y" : "-");
  console.log("op".padEnd(26) + "sum desc verif effects  fold canon interfaces");
  for (const o of ops.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`${o.name.padEnd(26)}${yn(o.summary).padEnd(4)}${yn(o.description).padEnd(5)}${yn(o.verifier).padEnd(6)}${o.effects.padEnd(9)}${yn(o.folder).padEnd(5)}${yn(o.canonicalizer).padEnd(6)}${o.interfaces.join(",")}`);
}
console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));

if (args.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
  console.log(`wrote ${BASELINE}`);
} else if (existsSync(BASELINE)) {
  const base: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
  for (const [k, v] of Object.entries(base))
    if ((counts[k] ?? 0) < v) problems.push(`${k} dropped: ${counts[k] ?? 0} < baseline ${v}`);
} else {
  problems.push(`no baseline at ${BASELINE}: run with --update`);
}

for (const p of problems) console.error(`FAIL ${p}`);
if (problems.length) process.exit(1);
console.log("dialect hygiene ok");
