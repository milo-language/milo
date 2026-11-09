#!/usr/bin/env bun
// Abstraction scanner: finds indirection that is not paying for itself — helpers with
// exactly one caller, and forwarders whose whole body is a call to something else.
//
// Neither pattern is automatically wrong (a name can be the point), so this reports
// rather than gates. It exists because the abstraction-police / dead-code routines
// otherwise run on vibes, and a helper nothing calls is simply dead.
//
//   bun scripts/abstraction-scan.ts              # both reports
//   bun scripts/abstraction-scan.ts --dead       # zero-caller only
//   bun scripts/abstraction-scan.ts --lang milo
import { readFileSync } from "fs";
import { execSync } from "child_process";

const argv = process.argv.slice(2);
const lang = argv.includes("--lang") ? argv[argv.indexOf("--lang") + 1]! : "both";
const deadOnly = argv.includes("--dead");

// git pathspec `**` is not portable here — list the trees and filter by extension.
const trees = lang === "milo" ? ["std"] : lang === "ts" ? ["src"] : ["src", "std"];
const wantMilo = lang !== "ts";
const wantTs = lang !== "milo";
const files = execSync(`git ls-files -- ${trees.join(" ")}`, { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => (wantTs && f.endsWith(".ts")) || (wantMilo && f.endsWith(".milo")))
  .filter((f) => !f.includes("stdlib-bundle"));

type Def = { name: string; file: string; line: number; body: string[]; kind: string; vis: Vis };
const defs: Def[] = [];
const srcs = new Map<string, string[]>();

// Callers are counted over the WHOLE corpus including tests and examples, or a helper
// used only by a fixture would look dead and get deleted out from under it.
const corpus = execSync(`git ls-files -- src std tests examples scripts benchmarks`, {
  encoding: "utf8",
  maxBuffer: 1 << 28,
}).split("\n").filter(Boolean).filter((f) => /\.(ts|milo|js)$/.test(f));

let corpusText = "";
for (const f of corpus) {
  try { corpusText += readFileSync(f, "utf8") + "\n"; } catch { /* binary or gone */ }
}

const TS_DEF = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s{2}(?:private|public|protected)?\s*(?:async\s+)?(\w+)\s*[(<]/;
const MILO_DEF = /^(\s*)(pub\s+)?fn\s+(\w+)/;

// In a stdlib, "no caller in this repo" is the NORMAL state of the public surface — the
// callers are downstream programs. Lumping `pub fn readLines` in with a genuinely
// unreachable helper turns the dead-code report into 66 lines of noise nobody acts on.
// Only a top-level non-pub function can be called dead from inside the repo; an indented
// `fn` is an impl method and belongs to whatever its type's visibility is.
type Vis = "api" | "internal" | "ts";

for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  srcs.set(f, lines);
  const isMilo = f.endsWith(".milo");
  for (let i = 0; i < lines.length; i++) {
    const m = isMilo ? MILO_DEF.exec(lines[i]!) : TS_DEF.exec(lines[i]!);
    if (!m) continue;
    const vis: Vis = !isMilo ? "ts" : m[2] || m[1]!.length > 0 ? "api" : "internal";
    const name = isMilo ? m[3] : m[1] || m[2];
    if (!name || name.length < 4) continue;
    if (["constructor", "if", "for", "while", "switch", "catch", "return"].includes(name)) continue;
    // Collect the body by brace balance from the definition line.
    let depth = 0, started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length && j < i + 400; j++) {
      for (const ch of lines[j]!) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
      body.push(lines[j]!);
      if (started && depth <= 0) break;
    }
    defs.push({ name, file: f, line: i + 1, body, kind: isMilo ? "milo" : "ts", vis });
  }
}

function uses(name: string): number {
  const re = new RegExp(`\\b${name}\\b`, "g");
  return (corpusText.match(re) || []).length;
}

const dead: Def[] = [];
const apiUnused: Def[] = [];
const single: Def[] = [];
const forwarders: Def[] = [];
const byName = new Map<string, number>();
for (const d of defs) byName.set(d.name, (byName.get(d.name) ?? 0) + 1);

for (const d of defs) {
  if ((byName.get(d.name) ?? 0) > 1) continue; // overloaded/duplicated name — can't attribute uses
  const n = uses(d.name);
  if (n <= 1) (d.vis === "api" ? apiUnused : dead).push(d);
  else if (n === 2) single.push(d);
  const inner = d.body.slice(1, -1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  if (inner.length === 1 && /^(return\s+)?\w+[.\w]*\(/.test(inner[0]!) && n > 1) forwarders.push(d);
}

const show = (title: string, list: Def[]) => {
  console.log(`\n=== ${title} (${list.length}) ===`);
  for (const d of list.slice(0, 60)) console.log(`  ${d.file}:${d.line}  ${d.name}  (${d.body.length} lines)`);
  if (list.length > 60) console.log(`  ... ${list.length - 60} more`);
};

console.log(`${files.length} files, ${defs.length} uniquely-named definitions scanned`);
show("NO CALLER, not public — dead or an entry point", dead);
show("NO CALLER, public — API surface, callers are downstream (informational)", apiUnused);
if (!deadOnly) {
  show("ONE CALLER — inline candidate", single);
  show("FORWARDER — body is a single call", forwarders);
}
