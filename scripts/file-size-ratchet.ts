// File-size ratchet for tracked source (src, scripts, std, mlir, tests/*.ts, proofs): no file over
// LIMIT lines may grow past its recorded line count.
//
// codegen.ts and checker.ts reached ~15k lines each because nothing pushed back. This
// makes growth a visible decision: a file that must grow is rebaselined in the same commit,
// with the reason in the message. A file that shrank by RATCHET_SLACK or more is also red,
// so the baseline follows a split down instead of leaving headroom someone silently refills.
//
// Only files over LIMIT have a baseline entry. Every file used to have one at its exact
// length, so a two-line edit to a 100-line file went red: the baseline was rewritten 143
// times in 27 days, and in that noise checker.ts was raised 34 times (+1006 lines).
//
// So --update only lowers entries (and drops files that fell under LIMIT or were deleted). Growth
// needs --allow-growth naming the file: a raise is a decision someone typed, not a side effect of
// locking in a win elsewhere. The scope covered only src/ until 2026-11-19.
//
//   bun scripts/file-size-ratchet.ts                                   # report violations, exit 1 if any
//   bun scripts/file-size-ratchet.ts --update                          # lower tests/file-size-baseline.json
//   bun scripts/file-size-ratchet.ts --update --allow-growth src/x.ts  # also raise (or add) src/x.ts
//
// Gated by tests/fileSizeRatchet.test.ts.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export const ROOT = join(import.meta.dir, "..");
export const BASELINE = join(ROOT, "tests", "file-size-baseline.json");
// A file absent from the baseline may be this long before it needs an entry.
export const LIMIT = 1500;
// Shrinking this much without rebaselining is red: the freed lines must not be refillable.
const RATCHET_SLACK = 200;
// Tracked files only: gitignored ones are generated (src/stdlib-bundle.ts) and exist only in some
// checkouts. Fixtures and examples are programs, not modules, and are out of scope.
export const SCOPE = ["src/*.ts", "scripts/*.ts", "std/*.milo", "mlir/*.cpp", "mlir/*.h", "mlir/*.td", "tests/*.ts", "proofs/*.lean"];

export function measure(): Record<string, number> {
  const out: Record<string, number> = {};
  const tracked = Bun.spawnSync(["git", "ls-files", "--", ...SCOPE], { cwd: ROOT }).stdout.toString().split("\n").filter(Boolean);
  for (const name of tracked.filter(f => existsSync(join(ROOT, f))).sort()) {
    const text = readFileSync(join(ROOT, name), "utf-8");
    // Same count as `wc -l`, so the numbers in a failure match what a person checks by hand.
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    out[name] = n;
  }
  return out;
}

export function readBaseline(): Record<string, number> {
  return existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf-8")) : {};
}

export function violations(baseline: Record<string, number>, current: Record<string, number>): string[] {
  const errs: string[] = [];
  const fix = "bun scripts/file-size-ratchet.ts --update";
  for (const [file, lines] of Object.entries(current)) {
    const base = baseline[file];
    if (base === undefined) {
      if (lines > LIMIT) errs.push(`${file}: ${lines} lines, not in baseline and over ${LIMIT} (split it, or ${fix} --allow-growth ${file})`);
    } else if (lines > base) {
      errs.push(`${file}: grew ${base} -> ${lines} (+${lines - base}); split it, or ${fix} --allow-growth ${file} and say why in the commit`);
    } else if (base - lines >= RATCHET_SLACK) {
      errs.push(`${file}: shrank ${base} -> ${lines} (-${base - lines}); lock the win in: ${fix}`);
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!(file in current)) errs.push(`${file}: in baseline but no longer exists; ${fix}`);
  }
  return errs;
}

// The baseline --update writes: entries lowered to the current size, files at or under LIMIT
// dropped, and a raise or a new oversized file only for the files in `grow`.
export function updated(baseline: Record<string, number>, current: Record<string, number>, grow: Set<string>): { next: Record<string, number>; refused: string[] } {
  const next: Record<string, number> = {};
  const refused: string[] = [];
  for (const [file, lines] of Object.entries(current)) {
    if (lines <= LIMIT) continue;
    const base = baseline[file];
    if (grow.has(file) || (base !== undefined && lines <= base)) next[file] = lines;
    else {
      refused.push(`${file}: ${base ?? "none"} -> ${lines}`);
      if (base !== undefined) next[file] = base;
    }
  }
  return { next, refused };
}

if (import.meta.main) {
  const current = measure();
  if (process.argv.includes("--update")) {
    const i = process.argv.indexOf("--allow-growth");
    const grow = new Set(i >= 0 ? process.argv.slice(i + 1).filter(a => !a.startsWith("--")) : []);
    const { next, refused } = updated(readBaseline(), current, grow);
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
    console.log(`wrote ${Object.keys(next).length} files over ${LIMIT} lines to ${BASELINE}`);
    for (const r of refused) console.log(`  not raised: ${r} (pass --allow-growth ${r.split(":")[0]})`);
    process.exit(refused.length ? 1 : 0);
  } else {
    const errs = violations(readBaseline(), current);
    console.log(`${Object.keys(current).length} files checked, ${errs.length} violation(s)`);
    for (const e of errs) console.log(`  ${e}`);
    process.exit(errs.length ? 1 : 0);
  }
}
