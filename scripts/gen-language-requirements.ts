// Generates docs/semantics/requirements.json: Milo's language requirements, one per semantics rule
// in docs/semantics/milo.md (grouped under its section) plus the MILO-O ownership rules in
// docs/spec.md. Generated, never hand-edited: the rules' own text is the single source.
//   bun scripts/gen-language-requirements.ts          # write
//   bun scripts/gen-language-requirements.ts --check  # exit 1 if the committed file is stale
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

type Req = { id: string; text: string; parent?: string };
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "docs", "semantics", "requirements.json");
const RULE = /^(?:[EST]|R)-[A-Z][A-Za-z0-9-]*$/;

// Cells of a markdown table row. A `|` inside backticks or escaped as `\|` is text, not a
// column break: rule statements quote operators like `||`.
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cur = "", code = false;
  for (let i = 1; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && line[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  return cells;
}

export function generate(semantics: string, spec: string): Req[] {
  const reqs: Req[] = [];
  const seen = new Set<string>();
  const add = (r: Req) => { if (!seen.has(r.id)) { seen.add(r.id); reqs.push(r); } };
  let section: string | undefined;
  let n = 0;
  for (const line of semantics.split("\n")) {
    const h = /^#{2,3} (.+)$/.exec(line);
    if (h) {
      section = `SEM-${String(++n).padStart(2, "0")}`;
      add({ id: section, text: `Milo semantics: ${h[1]!.replace(/^\d+\.\s*/, "")} (docs/semantics/milo.md)` });
      continue;
    }
    // A rule in a derivation block: `[E-MOVE]   ────   reading an owned value moves it out`.
    const b = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (b && RULE.test(b[1]!)) {
      const desc = b[2]!.split(/\s{3,}/).map(s => s.trim()).filter(s => /[a-z]{3}/.test(s) && !/[─⟨⇓→]/.test(s)).pop();
      add({ id: b[1]!, text: desc ?? `Rule ${b[1]} as defined in docs/semantics/milo.md`, parent: section });
      continue;
    }
    // A rule in a table: `| T-EXCL | in one call, ... | prevents ... |`.
    if (line.startsWith("| ")) {
      const cells = tableCells(line);
      for (const id of (cells[0] ?? "").split(", ").map(s => s.trim())) {
        if (RULE.test(id)) add({ id, text: (cells[1] ?? "").replace(/\\\|/g, "|"), parent: section });
      }
    }
  }
  add({ id: "OWN", text: "Ownership rules pinned to test programs (docs/spec.md, MILO-O)" });
  const lines = spec.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^### (MILO-O-\S+)/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim()) j++;
    add({ id: m[1]!, text: (lines[j] ?? "").trim(), parent: "OWN" });
  }
  return reqs;
}

if (import.meta.main) {
  const reqs = generate(readFileSync(join(ROOT, "docs/semantics/milo.md"), "utf-8"), readFileSync(join(ROOT, "docs/spec.md"), "utf-8"));
  const text = JSON.stringify({ requirements: reqs }, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    let cur = "";
    try { cur = readFileSync(OUT, "utf-8"); } catch {}
    if (cur !== text) { console.error("docs/semantics/requirements.json is stale: run bun scripts/gen-language-requirements.ts"); process.exit(1); }
  } else {
    writeFileSync(OUT, text);
    console.log(`${reqs.length} requirements -> docs/semantics/requirements.json`);
  }
}
