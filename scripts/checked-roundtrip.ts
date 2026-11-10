// Round-trip gate for the checked-program dump (src/checked-dump.ts): both copies lower to identical MLIR.
//
// For each program, lower the checker's own Program + CheckResult and lower the copy that went through
// encode + decode, and compare the two MLIR modules byte for byte. In one process, no subprocess per program.
//   bun scripts/checked-roundtrip.ts [--filter <substr>] [--limit N] [--diffs N] [--plant]
// --plant empties one checker table (staticCalls) in the decoded copy: the run must then fail,
// which is how tests/checkedDump.test.ts knows the comparison can.
// Programs: tests/fixtures/*.milo and examples/*.milo. One that does not type-check is skipped
// (counted): there is nothing to lower.
import { readdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { backendProgram } from "../src/backend-program";
import { MlirPlan } from "../src/mlir-backend";
import { getHostTarget } from "../src/target";
import { decodeChecked, encodeChecked } from "../src/checked-dump";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const filter = opt("--filter");
const limit = Number(opt("--limit") ?? 0);
const showDiffs = Number(opt("--diffs") ?? 5);
const target = getHostTarget();

const list = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".milo")).sort().map((f) => join(dir, f));
let programs = [...list("tests/fixtures"), ...list("examples")];
if (filter) programs = programs.filter((p) => p.includes(filter));
if (limit) programs = programs.slice(0, limit);

// A checker result as fresh objects, so the two lowerings never share a node.
const check = (path: string) => {
  const source = readFileSync(path, "utf-8");
  let program = new Parser(new Lexer(source).tokenize(), source, path).parse();
  program = resolveImports(program, dirname(resolve(path)), target, path);
  const result = new TypeChecker().check(program);
  return result.diagnostics.some((d) => d.severity === "error") ? null : { program, result };
};
const lower = (c: { program: any; result: any }, path: string) =>
  new MlirPlan(backendProgram(c.program, c.result, dirname(resolve(path)), target.os, target.arch), target, { filePath: path, trapOnOverflow: false, emitDebug: false, contractChecks: "none", stripPanicLocations: false, sanitize: false }).moduleText();

let same = 0, rejected = 0, bytes = 0;
const failures: string[] = [];
for (const rel of programs) {
  const path = join(ROOT, rel);
  let direct: string, dump: string;
  try {
    const c = check(path);
    if (!c) { rejected++; continue; }
    // Encoded before the direct lowering runs, so the dump is the checker's output and nothing later.
    dump = encodeChecked(c);
    direct = lower(c, path);
  } catch { rejected++; continue; }
  bytes += dump.length;
  try {
    const copy = decodeChecked(dump) as { program: any; result: any };
    if (argv.includes("--plant")) copy.result.staticCalls.clear();
    const via = lower(copy, path);
    if (via === direct) { same++; continue; }
    const a = direct.split("\n"), b = via.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    failures.push(`${rel}: line ${i + 1}\n    direct: ${(a[i] ?? "(end)").slice(0, 140)}\n    dump:   ${(b[i] ?? "(end)").slice(0, 140)}`);
  } catch (e: any) {
    failures.push(`${rel}: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`);
  }
}
console.log(`same ${same} / ${programs.length - rejected}   (${rejected} not lowered: rejected by the frontend; ${failures.length} differ; dumps ${(bytes / 1e6).toFixed(0)} MB)`);
for (const f of failures.slice(0, showDiffs)) console.log("  " + f);
process.exit(failures.length || same === 0 ? 1 : 0);
