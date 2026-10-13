// IR string-site ratchet: counts the places in src/ that still emit LLVM IR as text instead
// of through the typed builder (src/ir.ts), and fails if any file's count grows.
//
// This is the progress number for the builder migration (docs/plans/codegen-ir-2026-10.md):
// done when every file outside ir.ts reads 0. A site is any of
//   - `.push(` whose first argument is a string or template literal (lines.push, entryAllocas.push, ...)
//   - `.raw(`, the builder's unchecked escape hatch (moving text into raw() is not migration)
//   - `nextTemp()`, a temp named outside the builder
//   - a string or template literal that reads as an LLVM instruction, whatever function it is
//     passed to (so wrapping text in a new helper does not hide it)
// A line counts once however many of these it matches; `//` comment lines count zero.
//
//   bun scripts/ir-sites.ts                  # report, exit 1 on growth
//   bun scripts/ir-sites.ts --update         # rebaseline; refuses if the total grew
//   bun scripts/ir-sites.ts --update --allow-growth   # a deliberate, explained increase
//
// Gated by tests/irSites.test.ts.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export const ROOT = join(import.meta.dir, "..");
export const BASELINE = join(ROOT, "tests", "ir-sites-baseline.json");
// Only codegen files emit IR. Other src files push strings for unrelated reasons (help text,
// LSP), and counting them would fail unrelated work. A cluster split out of codegen must keep
// the codegen- prefix (as codegen-map.ts did) to stay counted.
const IN_SCOPE = /^codegen.*\.ts$/;

const PATTERNS = [
  /\.push\(\s*[`"']/,
  /\.raw\(/,
  /\bnextTemp\(\)/,
  /[`"'] {2}(\$\{[^}]+\}|%[\w.$-]+) = |[`"'] {2}(store|br|call|ret|switch|unreachable|resume) /,
];

export function countSites(text: string): number {
  let n = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*\/\/.*$/, "");
    if (PATTERNS.some(p => p.test(line))) n++;
  }
  return n;
}

export function measure(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(join(ROOT, "src")).filter(f => IN_SCOPE.test(f)).sort()) {
    const file = `src/${name}`;
    const n = countSites(readFileSync(join(ROOT, "src", name), "utf-8"));
    if (n > 0) out[file] = n;
  }
  return out;
}

export function total(m: Record<string, number>): number {
  return Object.values(m).reduce((a, b) => a + b, 0);
}

export function readBaseline(): Record<string, number> {
  return existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf-8")) : {};
}

export function violations(baseline: Record<string, number>, current: Record<string, number>): string[] {
  const errs: string[] = [];
  for (const [file, n] of Object.entries(current)) {
    const base = baseline[file] ?? 0;
    if (n > base) errs.push(`${file}: IR string sites grew ${base} -> ${n}; emit through src/ir.ts instead`);
  }
  // A shrink must be locked in, or the freed sites can be silently refilled.
  for (const [file, base] of Object.entries(baseline)) {
    const n = current[file] ?? 0;
    if (n < base) errs.push(`${file}: shrank ${base} -> ${n}; lock it in: bun scripts/ir-sites.ts --update`);
  }
  return errs;
}

if (import.meta.main) {
  const current = measure();
  const baseline = readBaseline();
  if (process.argv.includes("--update")) {
    if (total(current) > total(baseline) && existsSync(BASELINE) && !process.argv.includes("--allow-growth")) {
      console.error(`ir-sites: total grew ${total(baseline)} -> ${total(current)}; refusing to rebaseline (--allow-growth if deliberate)`);
      process.exit(1);
    }
    writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
    console.log(`ir-sites: baseline ${total(baseline)} -> ${total(current)}`);
    process.exit(0);
  }
  const errs = violations(baseline, current);
  for (const e of errs) console.log(e);
  console.log(`ir-sites: ${total(current)} string sites (baseline ${total(baseline)})`);
  process.exit(errs.length ? 1 : 0);
}
