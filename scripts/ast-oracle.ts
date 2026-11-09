// Sweeps fixtures with a src/ast-oracle.ts oracle armed and prints every site it noted, most hit first.
// The static census (scripts/ast-writes.ts) cannot see a write through `as any` or a local alias; this can.
//   bun scripts/ast-oracle.ts writes --filter option     sites that write a node after the resolver
//   bun scripts/ast-oracle.ts stale --filter option      sites that read a node the checker replaced
//   --errors    sweep tests/errors with `check` instead of tests/fixtures with `emit-mlir --all`
//   --check     exit 1 when any site was noted
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "fs";
import { tmpdir, cpus } from "os";
import { join } from "path";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const mode = process.argv[2];
if (mode !== "writes" && mode !== "stale") { console.error("usage: bun scripts/ast-oracle.ts writes|stale [--filter substring] [--errors] [--check]"); process.exit(2); }
const fi = process.argv.indexOf("--filter");
const filter = fi >= 0 ? process.argv[fi + 1] : "";
const errors = process.argv.includes("--errors");
const dir = errors ? "tests/errors" : "tests/fixtures";
const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".milo") && f.includes(filter)).map((f) => join(dir, f)).sort();
const logDir = mkdtempSync(join(tmpdir(), "milo-ast-oracle-"));
const log = join(logDir, "sites.log");
const env: Record<string, string | undefined> = { ...process.env, MILO_AST_ORACLE: mode, MILO_AST_ORACLE_LOG: log };
delete env.MILO_ROOT;

let next = 0;
let crashed = 0;
await Promise.all(Array.from({ length: Math.max(1, cpus().length - 2) }, async () => {
  while (next < files.length) {
    const rel = files[next++];
    const r = await guardedRun("bun", ["run", "src/main.ts", ...(errors ? ["check"] : ["emit-mlir", "--all"]), rel], { cwd: ROOT, env, timeoutMs: 120_000 });
    // A rejected program is expected under --errors; a crash never is.
    if (/TypeError|RangeError|panic|internal compiler error/i.test(r.stderr) || (!errors && r.code !== 0)) { crashed++; console.log(`FAIL ${rel}: ${r.stderr.split("\n").find((l) => l.trim()) ?? `exit ${r.code}`}`); }
  }
}));

const totals = new Map<string, number>();
if (existsSync(log)) {
  for (const line of readFileSync(log, "utf-8").split("\n")) {
    const m = /^(.*) x(\d+)$/.exec(line);
    if (m) totals.set(m[1], (totals.get(m[1]) ?? 0) + Number(m[2]));
  }
}
rmSync(logDir, { recursive: true, force: true });
for (const [site, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(8)}  ${site}`);
console.log(`ast-oracle ${mode}: ${files.length} programs, ${totals.size} sites, ${crashed} failed`);
if (process.argv.includes("--check") && (totals.size > 0 || crashed > 0)) process.exit(1);
