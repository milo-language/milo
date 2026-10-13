// File-size ratchet for src/*.ts: no file may grow past its recorded line count.
//
// codegen.ts and checker.ts reached ~15k lines each because nothing pushed back. This
// makes growth a visible decision: a file that must grow is rebaselined in the same commit,
// with the reason in the message. A file that shrank by RATCHET_SLACK or more is also red,
// so the baseline follows a split down instead of leaving headroom someone silently refills.
//
//   bun scripts/file-size-ratchet.ts            # report violations, exit 1 if any
//   bun scripts/file-size-ratchet.ts --update   # rewrite tests/file-size-baseline.json
//
// Gated by tests/fileSizeRatchet.test.ts.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export const ROOT = join(import.meta.dir, "..");
export const BASELINE = join(ROOT, "tests", "file-size-baseline.json");
// A file absent from the baseline may be this long before it needs an entry.
export const NEW_FILE_LIMIT = 1500;
// Shrinking this much without rebaselining is red: the freed lines must not be refillable.
export const RATCHET_SLACK = 200;

export function measure(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(join(ROOT, "src")).filter(f => f.endsWith(".ts")).sort()) {
    const text = readFileSync(join(ROOT, "src", name), "utf-8");
    // Same count as `wc -l`, so the numbers in a failure match what a person checks by hand.
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    out[`src/${name}`] = n;
  }
  return out;
}

export function readBaseline(): Record<string, number> {
  return existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf-8")) : {};
}

export function violations(baseline: Record<string, number>, current: Record<string, number>): string[] {
  const errs: string[] = [];
  const fix = "rebaseline: bun scripts/file-size-ratchet.ts --update";
  for (const [file, lines] of Object.entries(current)) {
    const base = baseline[file];
    if (base === undefined) {
      if (lines > NEW_FILE_LIMIT) errs.push(`${file}: ${lines} lines, not in baseline and over ${NEW_FILE_LIMIT} (split it, or ${fix})`);
    } else if (lines > base) {
      errs.push(`${file}: grew ${base} -> ${lines} (+${lines - base}); split it, or ${fix} and say why in the commit`);
    } else if (base - lines >= RATCHET_SLACK) {
      errs.push(`${file}: shrank ${base} -> ${lines} (-${base - lines}); lock the win in: ${fix}`);
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in current)) errs.push(`${file}: in baseline but no longer exists; ${fix}`);
  }
  return errs;
}

if (import.meta.main) {
  const current = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
    console.log(`wrote ${Object.keys(current).length} files to ${BASELINE}`);
  } else {
    const errs = violations(readBaseline(), current);
    console.log(`${Object.keys(current).length} files checked, ${errs.length} violation(s)`);
    for (const e of errs) console.log(`  ${e}`);
    process.exit(errs.length ? 1 : 0);
  }
}
