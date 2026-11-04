// std/http worker scaling: throughput and head-of-line p99 for ServeOptions.workers 1, 4 and 0 (one
// per core), against server_workers.milo. Usage: bun benchmarks/webserver/workers.ts [--scale 0.5]
// [--workers 1,4,0] [--json out.json]. Needs oha on PATH. Numbers are one run on this machine: they
// say how the worker count scales here, not what any other machine will do.
import { spawn, spawnSync, type Subprocess } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const scale = Number(opt("--scale") ?? 1);
const workerList = (opt("--workers") ?? "1,4,0").split(",").map(Number);
const jsonPath = opt("--json");
const port = Number(process.env.PORT ?? 8110);
const oha = Bun.which("oha");
if (!oha) {
  console.error("oha not found on PATH. Install it (brew install oha) and retry.");
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), "milo-workers-bench-"));
let server: Subprocess | undefined;
let bg: Subprocess | undefined;
process.on("exit", () => {
  try { bg?.kill(9); } catch {}
  try { server?.kill(9); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const cnt = (n: number) => Math.max(1, Math.round(n * scale));
const HOL_FIB = 32;

function ohaArgs(path: string, c: number, n: number, keepalive: boolean) {
  const ka = keepalive ? [] : ["--disable-keepalive"];
  return [oha!, "--no-tui", "--output-format", "json", ...ka, "-n", String(n), "-c", String(c), `http://127.0.0.1:${port}${path}`];
}

async function drain() {
  for (;;) {
    const r = spawnSync(["sh", "-c", "netstat -an -p tcp | grep -c TIME_WAIT"]);
    if ((Number(r.stdout.toString().trim()) || 0) < 3000) return;
    await Bun.sleep(1000);
  }
}

async function run(path: string, c: number, n: number, keepalive: boolean) {
  await drain();
  const p = spawn(ohaArgs(path, c, n, keepalive), { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const j = JSON.parse(out);
  const sc = j.statusCodeDistribution ?? {};
  let bad = 0;
  for (const [code, k] of Object.entries(sc)) if (!code.startsWith("2")) bad += k as number;
  const errs = Object.values(j.errorDistribution ?? {}).reduce((a: number, b) => a + (b as number), 0);
  return { rps: j.summary.requestsPerSec as number, p50: j.latencyPercentiles.p50 * 1000, p99: j.latencyPercentiles.p99 * 1000, bad: bad + errs };
}

console.log("building server_workers.milo...");
const bin = join(tmp, "bench-workers");
const b = spawnSync([join(root, "milo"), "build", join(root, "benchmarks/webserver/server_workers.milo"), "-o", bin, "--release"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (b.exitCode !== 0) throw new Error("build failed");

const results: any[] = [];
for (const w of workerList) {
  console.log(`\n== workers ${w}${w === 0 ? ` (${cpus().length} cores)` : ""} ==`);
  server = spawn([bin], { env: { ...process.env, PORT: String(port), WORKERS: String(w) }, stdout: "ignore", stderr: "inherit" });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/hello`)).ok; } catch { await Bun.sleep(200); }
  }
  if (!up) throw new Error("server did not answer");
  await run("/hello", 16, 500, true);
  const row: any = { workers: w };
  row.helloKeep64 = await run("/hello", 64, cnt(40000), true);
  row.helloNew64 = await run("/hello", 64, cnt(12000), false);
  row.fib27c64 = await run("/fib/27", 64, cnt(3000), true);
  row.holBase = await run("/hello", 4, cnt(3000), true);
  await drain();
  bg = spawn(ohaArgs(`/fib/${HOL_FIB}`, 16, cnt(3000), true), { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  row.hol = await run("/hello", 4, cnt(3000), true);
  bg.kill(9);
  bg = undefined;
  results.push(row);
  const f = (r: any) => `${r.rps.toFixed(0)} rps p99 ${r.p99.toFixed(2)} ms${r.bad ? ` (${r.bad} bad)` : ""}`;
  console.log(`  hello keepalive c=64: ${f(row.helloKeep64)}`);
  console.log(`  hello new-conn c=64:  ${f(row.helloNew64)}`);
  console.log(`  fib27 c=64:           ${f(row.fib27c64)}`);
  console.log(`  hol baseline c=4:     ${f(row.holBase)}`);
  console.log(`  hol (+fib${HOL_FIB} c=16):    ${f(row.hol)}`);
  server.kill(9);
  await server.exited;
  server = undefined;
}
if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ cores: cpus().length, results }, null, 2));
