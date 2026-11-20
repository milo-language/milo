// Gate for proofs/: the Lean files carry no escape hatch, every theorem the README advertises is
// under the axiom audit, and (where Lean is installed) the proofs build.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const PROOFS = join(import.meta.dir, "..", "proofs");
const LEAN_DIR = join(PROOFS, "MiniMilo");
const read = (f: string) => readFileSync(join(LEAN_DIR, f), "utf-8");
const HEADLINE = ["frame", "sound", "proven_fn", "level_irrelevant", "checked_call"];
const MOVES_HEADLINE = ["sound", "strings_never_rejected"];
const BORROWS_HEADLINE = ["sound"];
// Lean has exactly these three; a fourth name in the audit means someone added an axiom.
const LEAN_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

// Comments and doc strings may say "sorry"; code may not.
function stripComments(text: string): string {
  return text.replace(/\/-[^]*?-\//g, "").replace(/--.*$/gm, "");
}
function escapeHatches(text: string): string[] {
  return stripComments(text).match(/\b(sorry|admit|axiom|native_decide|unsafe|implemented_by|opaque)\b/g) ?? [];
}

test("no Lean file uses sorry, a declared axiom or an unchecked evaluator", () => {
  // The check has to be able to fail.
  expect(escapeHatches("theorem bad : False := by sorry")).toEqual(["sorry"]);
  expect(escapeHatches("axiom cheat : False")).toEqual(["axiom"]);
  expect(escapeHatches("/- a sorry in prose -/ theorem ok : True := trivial -- no axiom")).toEqual([]);
  const files = readdirSync(LEAN_DIR).filter(f => f.endsWith(".lean"));
  expect(files.sort()).toEqual(["Audit.lean", "Borrows.lean", "BorrowsExample.lean", "Contracts.lean", "Example.lean", "Moves.lean", "MovesExample.lean"]);
  for (const f of files) expect({ f, found: escapeHatches(read(f)) }).toEqual({ f, found: [] });
});

test("every theorem is under the axiom audit, and the audit names only Lean's own axioms", () => {
  const audit = read("Audit.lean");
  // Each expectation is a doc comment directly above `#guard_msgs in` / `#print axioms`; a bare
  // `#print axioms` only prints and can never fail the build.
  const guarded = [...audit.matchAll(/\/-- info: '([\w.]+)' depends on axioms: \[([^\]]*)\] -\/\n#guard_msgs in\n#print axioms ([\w.]+)\n/g)];
  expect(guarded.length).toBeGreaterThanOrEqual(HEADLINE.length);
  expect(guarded.length).toBe((stripComments(audit).match(/#print axioms/g) ?? []).length);
  for (const [, expected, axioms, printed] of guarded) {
    expect(printed).toBe(expected!);
    for (const a of axioms!.split(",").map(x => x.trim()).filter(Boolean)) expect(LEAN_AXIOMS.has(a)).toBe(true);
  }
  const audited = new Set(guarded.map(g => g[1]!));
  for (const t of HEADLINE) expect(audited.has(`MiniMilo.${t}`)).toBe(true);
  // A theorem added to Example.lean without an audit line would be the one with the sorry.
  for (const [, name] of read("Example.lean").matchAll(/^theorem (\w+)/gm)) {
    if (name === "i64_some" || name === "countTo_verified") continue; // lemmas under prog_verified
    expect({ name, audited: audited.has(`MiniMilo.Example.${name}`) }).toEqual({ name: name!, audited: true });
  }
  for (const [, name] of read("MovesExample.lean").matchAll(/^theorem (\w+)/gm))
    expect({ name, audited: audited.has(`MiniMilo.Moves.Example.${name}`) }).toEqual({ name: name!, audited: true });
  for (const [, name] of read("BorrowsExample.lean").matchAll(/^theorem (\w+)/gm))
    expect({ name, audited: audited.has(`MiniMilo.Borrows.Example.${name}`) }).toEqual({ name: name!, audited: true });
  for (const t of BORROWS_HEADLINE) {
    expect(audited.has(`MiniMilo.Borrows.${t}`)).toBe(true);
    expect(read("Borrows.lean")).toMatch(new RegExp(`^theorem ${t}\\b`, "m"));
  }
  for (const t of MOVES_HEADLINE) {
    expect(audited.has(`MiniMilo.Moves.${t}`)).toBe(true);
    expect(read("Moves.lean")).toMatch(new RegExp(`^theorem ${t}\\b`, "m"));
  }
  const contracts = read("Contracts.lean");
  for (const t of HEADLINE) expect(contracts).toMatch(new RegExp(`^theorem ${t}\\b`, "m"));
});

test("the README names the theorems that exist", () => {
  const readme = readFileSync(join(PROOFS, "README.md"), "utf-8");
  for (const t of HEADLINE) expect(readme).toContain("`" + t + "`");
  const example = read("Example.lean");
  const cited = [...readme.matchAll(/`(lies_\w+|countTo\w*)`/g)].map(m => m[1]!);
  expect(cited.length).toBeGreaterThan(0);
  for (const t of cited) expect(example).toContain(t);
});

// Every move-flow rule pinned by a mutant has a row in the README trace: modelled, outside the model's
// graph, or not modelled. A new mutant (a new rule) cannot land without saying which.
test("every move-flow mutant has a row in the proofs README rule trace", () => {
  const mutants = [...readFileSync(join(import.meta.dir, "..", "scripts", "move-mutants.ts"), "utf-8").matchAll(/\bid: "([\w-]+)"/g)].map(m => m[1]!);
  expect(mutants.length).toBeGreaterThanOrEqual(18);
  const readme = readFileSync(join(PROOFS, "README.md"), "utf-8");
  const trace = readme.slice(readme.indexOf("### Rule trace"), readme.indexOf("### What the move model leaves out"));
  const rows = new Set([...trace.matchAll(/^\| `([\w-]+)` \|/gm)].map(m => m[1]!));
  expect(mutants.filter(m => !rows.has(m))).toEqual([]);
  expect([...rows].filter(r => !mutants.includes(r))).toEqual([]);
});

// Same for the borrow flow: each mutant in scripts/borrow-mutants.ts has a row in the borrow rule trace.
test("every borrow-flow mutant has a row in the proofs README borrow rule trace", () => {
  const mutants = [...readFileSync(join(import.meta.dir, "..", "scripts", "borrow-mutants.ts"), "utf-8").matchAll(/\bm\("([\w-]+)"/g)].map(m => m[1]!);
  expect(mutants.length).toBeGreaterThanOrEqual(40);
  const readme = readFileSync(join(PROOFS, "README.md"), "utf-8");
  const trace = readme.slice(readme.indexOf("### Borrow rule trace"), readme.indexOf("### What the borrow model leaves out"));
  const rows = new Set([...trace.matchAll(/^\| `([\w-]+)` \|/gm)].map(m => m[1]!));
  expect(mutants.filter(m => !rows.has(m))).toEqual([]);
  expect([...rows].filter(r => !mutants.includes(r))).toEqual([]);
});

const lake = spawnSync("lake", ["--version"], { encoding: "utf-8" });
test.skipIf(lake.status !== 0)("lake build checks every proof", () => {
  const r = spawnSync("lake", ["build"], { cwd: PROOFS, encoding: "utf-8", timeout: 240_000 });
  expect({ code: r.status, out: (r.stdout + r.stderr).split("\n").filter(l => /error|sorry|warning/.test(l)) }).toEqual({ code: 0, out: [] });
}, 250_000);
