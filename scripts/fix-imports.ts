#!/usr/bin/env bun
// Adds the import names a program is missing, from the checker's `unimported` diagnostics.
//
// Driven by `milo check --json`: each diagnostic carries the exact `from "m" import { x }`
// to add, computed relative to the file that needs it.
//
// Usage: bun scripts/fix-imports.ts [--target=<os-arch>] <file.milo>...
//
// Each file is checked as its own entry, and every file the check reports is edited,
// imported modules included: a missing import in a library module only shows up from an
// entry that reaches it. The package cache under ~/.milo is never edited (republish
// instead). A name is added to the file's existing block for that module when there is
// one, else a new import line goes after the file's last import (or after the leading
// comment when it has none). Idempotent; loops up to 3 times per file since one fix can
// only remove sites, and a fixed point is cheaper to verify than to argue.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const MAIN = resolve(import.meta.dir, "..", "src", "main.ts");
const files = process.argv.slice(2).filter(a => !a.startsWith("--"));
const passthrough = process.argv.slice(2).filter(a => a.startsWith("--"));
const CACHE = resolve(homedir(), ".milo");
if (files.length === 0) { console.error("usage: bun scripts/fix-imports.ts <file.milo>..."); process.exit(2); }

// file -> module path -> names
type Wanted = Map<string, Map<string, Set<string>>>;

function wantedOf(file: string): { wanted: Wanted; ok: boolean } {
  const r = spawnSync("bun", ["run", MAIN, "check", file, "--json", ...passthrough], { encoding: "utf8", maxBuffer: 1 << 30 });
  let parsed: any;
  try { parsed = JSON.parse(r.stdout ?? ""); } catch {
    console.error(`${file}: check produced no JSON\n${r.stderr ?? ""}`);
    return { wanted: new Map(), ok: false };
  }
  const wanted: Wanted = new Map();
  for (const d of parsed.diagnostics ?? []) {
    if (d.code !== "unimported" || !d.file) continue;
    const m = /from "([^"]+)" import \{ (\S+) \}/.exec(d.hint ?? "");
    if (!m) continue;
    const f = resolve(d.file);
    if (f.startsWith(CACHE + "/")) { console.error(`  skipped ${f}: package cache`); continue; }
    let mods = wanted.get(f);
    if (!mods) { mods = new Map(); wanted.set(f, mods); }
    let names = mods.get(m[1]);
    if (!names) { names = new Set(); mods.set(m[1], names); }
    names.add(m[2]);
  }
  return { wanted, ok: true };
}

// Indented, comma-terminated lines of names, wrapped near the width the std files use.
function wrapNames(names: string[], width = 96): string[] {
  const out: string[] = [];
  let cur = "";
  for (const n of names) {
    if (cur && cur.length + n.length + 2 > width) { out.push(`    ${cur},`); cur = ""; }
    cur = cur ? `${cur}, ${n}` : n;
  }
  if (cur) out.push(`    ${cur},`);
  return out;
}

function apply(src: string, mods: Map<string, Set<string>>): string {
  let lines = src.split("\n");
  for (const [mod, names] of mods) {
    // `from "jdwp"` and `from "./jdwp"` name the same sibling; either spelling is the block.
    const spellings = mod.startsWith("./") ? [mod, mod.slice(2)] : [mod, `./${mod}`];
    const open = lines.findIndex(l => spellings.some(m => l.startsWith(`from "${m}" import {`)));
    if (open >= 0) {
      const line = lines[open];
      const braceClose = line.indexOf("}");
      if (braceClose >= 0) {
        // Single-line block: splice the names in before the closing brace.
        const inner = line.slice(line.indexOf("{") + 1, braceClose).trim();
        const merged = inner ? `${inner.replace(/,\s*$/, "")}, ${[...names].join(", ")}` : [...names].join(", ");
        lines[open] = `${line.slice(0, line.indexOf("{") + 1)} ${merged} ${line.slice(braceClose)}`;
      } else {
        // Multi-line block: new lines right after the opener, trailing comma either way.
        lines.splice(open + 1, 0, ...wrapNames([...names]));
      }
      continue;
    }
    // No block for this module: after the last import, else after the leading comment.
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!/^from "/.test(lines[i])) continue;
      at = i;
      if (!lines[i].includes("}")) while (at < lines.length && !lines[at].startsWith("}")) at++;
    }
    if (at < 0) { at = 0; while (at < lines.length && /^(\/\/|$)/.test(lines[at])) at++; at--; }
    const flat = `from "${mod}" import { ${[...names].join(", ")} }`;
    lines.splice(at + 1, 0, ...(flat.length <= 100 ? [flat] : [`from "${mod}" import {`, ...wrapNames([...names]), "}"]));
  }
  return lines.join("\n");
}

let total = 0;
for (const file of files) {
  let changed = 0;
  for (let round = 0; round < 3; round++) {
    const { wanted, ok } = wantedOf(file);
    if (!ok || wanted.size === 0) break;
    for (const [f, mods] of wanted) {
      writeFileSync(f, apply(readFileSync(f, "utf8"), mods));
      const n = [...mods.values()].reduce((a, s) => a + s.size, 0);
      console.log(`  ${f}: +${n} import name(s)${f === resolve(file) ? "" : ` (via ${file})`}`);
      changed += n;
    }
  }
  console.log(`${file}: ${changed} added`);
  total += changed;
}
console.log(`${total} import name(s) added across ${files.length} entry file(s)`);
