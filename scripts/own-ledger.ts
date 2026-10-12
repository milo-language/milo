// Ownership-ledger census: emit IR for every fixture with MILO_OWN_LEDGER=1 and report codegen's drop-bookkeeping findings (src/own-ledger.ts).
//
//   bun scripts/own-ledger.ts                    # every tests/fixtures/*.milo, findings + totals
//   bun scripts/own-ledger.ts --filter forIn     # only fixtures whose name contains "forIn"
//   bun scripts/own-ledger.ts --json             # one JSON document on stdout
//   bun scripts/own-ledger.ts --off              # same sweep with the ledger off (overhead baseline)
//   bun scripts/own-ledger.ts -j 4               # parallelism (default: half the cores)
//
// Compile only: `milo emit-ir`, no clang, no run, so the sweep is cheap and nothing compiled
// executes. Report mode: exits 0 whatever it finds, 1 only when a fixture failed to compile.
// Each finding reads `fn: ID kind (made at IR line N by ORIGIN, milo line M; ...)`; rerun one
// fixture with MILO_OWN_LEDGER=1 MILO_OWN_LEDGER_KEEP=1 `milo emit-ir` to read the IR the line
// numbers point into, markers included.
import { readdirSync } from "fs";
import { join, basename } from "path";
import { cpus } from "os";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: bun scripts/own-ledger.ts [--filter <substr>] [--json] [--off] [-j N]");
  process.exit(0);
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const filter = flag("--filter");
const asJson = args.includes("--json");
const off = args.includes("--off");
const jobs = Number(flag("-j") ?? Math.max(1, Math.floor(cpus().length / 2)));

interface Finding { fn: string; id: number; kind: string; irLine: number; origin: string; srcLine: number; at: number }
interface Result { fixture: string; ok: boolean; findings: Finding[]; error?: string; ms: number }

const LINE_RE = /^own-ledger: (.+?): (\d+) (\S+) \(made at IR line (\d+) by (\S+?)(?:, milo line (\d+))?; seen at IR line (\d+)\)$/;

function parse(stderr: string): Finding[] {
  const out: Finding[] = [];
  for (const l of stderr.split("\n")) {
    const m = LINE_RE.exec(l);
    if (m) out.push({ fn: m[1], id: +m[2], kind: m[3], irLine: +m[4], origin: m[5], srcLine: m[6] ? +m[6] : 0, at: +m[7] });
  }
  return out;
}

async function one(file: string): Promise<Result> {
  const t0 = performance.now();
  const env = { ...process.env };
  if (off) delete env.MILO_OWN_LEDGER; else env.MILO_OWN_LEDGER = "1";
  delete env.MILO_OWN_LEDGER_KEEP;
  const r = await guardedRun("bun", ["run", join(ROOT, "src", "main.ts"), "emit-ir", file, "-o", "/dev/null"], { env, timeoutMs: 120_000, memMb: 2048 });
  const ms = performance.now() - t0;
  if (r.code !== 0) return { fixture: basename(file), ok: false, findings: [], error: r.stderr.split("\n").filter(Boolean).slice(-3).join(" | "), ms };
  return { fixture: basename(file), ok: true, findings: parse(r.stderr), ms };
}

const files = readdirSync(FIXTURES).filter(f => f.endsWith(".milo") && (!filter || f.includes(filter))).sort().map(f => join(FIXTURES, f));
const results: Result[] = new Array(files.length);
const t0 = performance.now();
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
  while (next < files.length) { const i = next++; results[i] = await one(files[i]); }
}));
const wallMs = performance.now() - t0;

const all = results.flatMap(r => r.findings.map(f => ({ fixture: r.fixture, ...f })));
const count = (key: (f: typeof all[number]) => string) => {
  const m = new Map<string, number>();
  for (const f of all) m.set(key(f), (m.get(key(f)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const failed = results.filter(r => !r.ok);

if (asJson) {
  console.log(JSON.stringify({
    fixtures: results.length, failed: failed.map(r => ({ fixture: r.fixture, error: r.error })),
    total: all.length, byKind: Object.fromEntries(count(f => f.kind)), byOrigin: Object.fromEntries(count(f => f.origin.split(":")[0])),
    wallMs: Math.round(wallMs), ledger: !off, results: results.map(r => ({ fixture: r.fixture, ok: r.ok, ms: Math.round(r.ms), findings: r.findings })),
  }, null, 1));
} else {
  for (const r of results) {
    if (!r.ok) { console.log(`${r.fixture}: COMPILE FAILED ${r.error}`); continue; }
    if (r.findings.length === 0) continue;
    console.log(`${r.fixture}: ${r.findings.length}`);
    for (const f of r.findings) console.log(`  ${f.fn}: ${f.id} ${f.kind} (${f.origin}${f.srcLine ? ` L${f.srcLine}` : ""}, IR ${f.irLine})`);
  }
  const clean = results.filter(r => r.ok && r.findings.length === 0).length;
  console.log(`\n${results.length} fixtures, ${clean} clean, ${results.length - clean - failed.length} with findings, ${failed.length} failed; ${all.length} findings; ledger ${off ? "off" : "on"}, ${(wallMs / 1000).toFixed(1)}s wall (-j ${jobs})`);
  console.log(`by kind:   ${count(f => f.kind).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`by origin: ${count(f => f.origin.split(":")[0]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  // The prelude and std functions a fixture imports are compiled into every fixture that
  // uses them, so one codegen site can account for hundreds of findings. Sites are the
  // number to drive down.
  const sites = count(f => `${f.fn} ${f.kind} ${f.origin} L${f.srcLine}`);
  console.log(`unique sites (fn, kind, origin, line): ${sites.length}`);
  if (args.includes("--sites")) for (const [k, n] of sites) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
process.exit(failed.length ? 1 : 0);
