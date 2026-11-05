// Counts, per frontend file, the TypeScript constructs outside the portable subset that
// scripts/ts2milo.ts can translate (rule list: scripts/ts2milo/subset.ts, shared with it).
// The table is the visible number for the TS -> Milo port: a refactor lowers it.
//   bun scripts/ts-portable.ts            table; add --list for every violation with file:line
//   bun scripts/ts-portable.ts --check    fail if any file exceeds scripts/ts-portable-baseline.json
//   bun scripts/ts-portable.ts --write    rewrite the baseline from the current counts
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { makeProgram, violationsOf, type Violation } from "./ts2milo/subset";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts/ts-portable-baseline.json");
const FRONTEND = /^(lexer|tokens|ast|ast-walk.*|ast-nodes|mutability-scan|types|parser|resolver|checker.*|emit-mlir|emit-forms|backend-program|scaffold|mlir-.*)\.ts$/;

export function frontendFiles(): string[] {
  return readdirSync(join(ROOT, "src")).filter((f) => FRONTEND.test(f)).sort().map((f) => `src/${f}`);
}

export function countViolations(files: string[]): Map<string, Violation[]> {
  const program = makeProgram(ROOT, files.map((f) => join(ROOT, f)));
  const checker = program.getTypeChecker();
  const res = new Map<string, Violation[]>();
  for (const f of files) {
    const sf = program.getSourceFile(join(ROOT, f))!;
    res.set(f, violationsOf(program, checker, sf).map((v) => ({ ...v, file: f })));
  }
  return res;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = frontendFiles();
  const res = countViolations(files);
  const counts: Record<string, number> = {};
  for (const [f, v] of res) counts[f] = v.length;

  if (args.includes("--write")) {
    writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
    console.log(`wrote ${BASELINE}`);
  }
  if (args.includes("--list")) {
    for (const v of [...res.values()].flat()) console.log(`${v.file}:${v.line}:${v.col}: ${v.construct}`);
  }
  let total = 0;
  for (const [f, n] of Object.entries(counts)) {
    total += n;
    console.log(`${f}: ${n} violations`);
  }
  console.log(`total: ${total} violations in ${files.length} files`);

  if (args.includes("--check")) {
    const base: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8"));
    let failed = false;
    for (const [f, n] of Object.entries(counts)) {
      const allowed = base[f];
      if (allowed === undefined) { console.error(`${f}: not in baseline (run --write)`); failed = true; }
      else if (n > allowed) { console.error(`${f}: ${n} violations, baseline allows ${allowed}`); failed = true; }
    }
    if (failed) process.exit(1);
  }
}
