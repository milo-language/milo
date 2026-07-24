// Migration script: convert `from "X" import *` to explicit imports
// Usage: bun run scripts/migrate-imports.ts

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";

const STDLIB_DIR = resolve(import.meta.dirname!, "..", "std");

function getExports(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, "utf-8");
  const names: string[] = [];
  for (const line of src.split("\n")) {
    let m;
    if ((m = line.match(/^(?:pub )?fn\s+(\w+)\s*[(<]/))) names.push(m[1]);
    else if ((m = line.match(/^(?:pub )?extern\s+fn\s+(\w+)/))) names.push(m[1]);
    else if ((m = line.match(/^(?:pub )?struct\s+(\w+)/))) names.push(m[1]);
    else if ((m = line.match(/^(?:pub )?enum\s+(\w+)/))) names.push(m[1]);
    else if ((m = line.match(/^(?:pub )?trait\s+(\w+)/))) names.push(m[1]);
    else if ((m = line.match(/^let\s+(\w+)\s*:/))) names.push(m[1]);
  }
  return names;
}

function resolveImportPath(importPath: string, fromDir: string): string {
  if (importPath.startsWith("std/")) {
    return resolve(STDLIB_DIR, importPath.replace("std/", "") + ".milo");
  }
  return resolve(fromDir, importPath.endsWith(".milo") ? importPath : importPath + ".milo");
}

function findUsedSymbols(src: string, exports: string[], importLine: string): string[] {
  const srcWithoutImports = src.split("\n")
    .filter(l => !l.startsWith("from ") && !l.startsWith("import ") && !l.startsWith("//"))
    .join("\n");

  return exports.filter(name => {
    if (name.startsWith("_")) return false; // skip private helpers
    const re = new RegExp(`\\b${name}\\b`);
    return re.test(srcWithoutImports);
  }).sort();
}

function processFile(filePath: string) {
  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^from\s+"([^"]+)"\s+import\s+\*/);
    if (!m) continue;

    const importPath = m[1];
    const absPath = resolveImportPath(importPath, dirname(filePath));
    const exports = getExports(absPath);

    if (exports.length === 0) continue;

    const used = findUsedSymbols(src, exports, lines[i]);

    if (used.length === 0) {
      // no symbols used — remove the import entirely
      lines[i] = `// removed: from "${importPath}" import *`;
      changed = true;
    } else {
      lines[i] = `from "${importPath}" import { ${used.join(", ")} }`;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(filePath, lines.join("\n"));
    console.log(`  updated: ${filePath}`);
  }
}

// find all .milo files
function findMiloFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".milo")) {
      results.push(resolve(entry.parentPath ?? dir, entry.name));
    }
  }
  return results;
}

console.log("Migrating import * to explicit imports...\n");

const dirs = ["std", "tests", "examples", "benchmarks"].map(d => resolve(import.meta.dirname!, "..", d));
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  const files = findMiloFiles(dir);
  for (const f of files) processFile(f);
}

console.log("\nDone. Run `bun test` to verify.");
