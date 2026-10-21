// HTTP server benchmark: throughput and head-of-line latency for std/http. See README.md.
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
const jsonPath = opt("--json");
const port = Number(process.env.PORT ?? 8090);
const base = `http://127.0.0.1:${port}`;

const oha = Bun.which("oha");
if (!oha) {
  console.error("oha not found on PATH. Install it (brew install oha) and retry.");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "milo-http-bench-"));
let server: Subprocess | undefined;
let bg: Subprocess | undefined;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { bg?.kill(9); } catch {}
  try { server?.kill(9); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

interface Row {
  name: string;
  rps: number;
  p50: number;
  p99: number;
  max: number;
  non2xx: number;
  errors: number;
}

let drainedNoted = false;
async function drainPorts() {
  const timeWait = () => {
    const r = spawnSync(["sh", "-c", "netstat -an -p tcp | grep -c TIME_WAIT"]);
    return Number(r.stdout.toString().trim()) || 0;
  };
  while (timeWait() >= 3000) {
    if (!drainedNoted) { console.log("draining ports..."); drainedNoted = true; }
    await Bun.sleep(1000);
  }
}

function ohaArgs(path: string, c: number, n: number) {
  return [oha!, "--no-tui", "--output-format", "json", "-n", String(n), "-c", String(c), base + path];
}

function toRow(name: string, out: string): Row {
  const j = JSON.parse(out);
  const sc = j.statusCodeDistribution ?? {};
  let non2xx = 0;
  for (const [code, cnt] of Object.entries(sc)) if (!code.startsWith("2")) non2xx += cnt as number;
  const errors = Object.values(j.errorDistribution ?? {}).reduce((a: number, b) => a + (b as number), 0);
  const ms = (s: number) => s * 1000;
  return {
    name,
    rps: j.summary.requestsPerSec,
    p50: ms(j.latencyPercentiles.p50),
    p99: ms(j.latencyPercentiles.p99),
    max: ms(j.summary.slowest),
    non2xx,
    errors,
  };
}

async function runOha(name: string, path: string, c: number, n: number): Promise<Row> {
  await drainPorts();
  const p = spawn(ohaArgs(path, c, n), { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return toRow(name, out);
}

// fib(27) is only ~0.5 ms here, too short to show head-of-line blocking; fib(32) is ~6 ms.
const HOL_FIB = 32;
const cnt = (n: number) => Math.max(1, Math.round(n * scale));

async function main() {
  const bin = join(tmp, "bench-server");
  console.log("building server...");
  const b = spawnSync([join(root, "milo"), "build", join(root, "benchmarks/webserver/server.milo"), "-o", bin, "--release"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (b.exitCode !== 0) throw new Error("server build failed");

  server = spawn([bin], {
    env: { ...process.env, PORT: String(port), DB_PATH: join(tmp, "bench.db") },
    stdout: "ignore",
    stderr: "inherit",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(base + "/hello")).ok; } catch { await Bun.sleep(200); }
  }
  if (!up) throw new Error("server did not answer /hello");

  const rows: Row[] = [];
  const add = (r: Row) => { rows.push(r); console.log(`  ${r.name}: ${r.rps.toFixed(0)} rps, p99 ${r.p99.toFixed(2)} ms`); };

  // warm up code paths and the db page cache before measuring
  await runOha("warmup", "/hello", 4, 200);
  await runOha("warmup", "/db", 4, 50);

  add(await runOha("hello c=1", "/hello", 1, cnt(3000)));
  add(await runOha("hello c=64", "/hello", 64, cnt(8000)));
  add(await runOha("fib27 c=1", "/fib/27", 1, cnt(300)));
  add(await runOha("fib27 c=64", "/fib/27", 64, cnt(1500)));
  add(await runOha("db c=1", "/db", 1, cnt(1000)));
  add(await runOha("db c=64", "/db", 64, cnt(3000)));

  add(await runOha("hol-baseline hello c=4", "/hello", 4, cnt(2000)));

  // Background CPU load; the foreground is the cheap route's wait behind it.
  await drainPorts();
  bg = spawn(ohaArgs(`/fib/${HOL_FIB}`, 16, cnt(1500)), { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  const hol = await runOha(`hol hello c=4 (+fib${HOL_FIB} c=16)`, "/hello", 4, cnt(2000));
  bg.kill(9);
  bg = undefined;
  add(hol);

  const base99 = rows.find((r) => r.name.startsWith("hol-baseline"))!.p99;
  const factor = hol.p99 / base99;

  const w = Math.max(...rows.map((r) => r.name.length));
  const f = (x: number) => x.toFixed(2).padStart(9);
  console.log("\n" + "scenario".padEnd(w) + "       rps    p50 ms    p99 ms    max ms  non2xx  errors");
  for (const r of rows) {
    console.log(r.name.padEnd(w) + r.rps.toFixed(0).padStart(10) + f(r.p50) + f(r.p99) + f(r.max) + String(r.non2xx).padStart(8) + String(r.errors).padStart(8));
  }
  console.log(`\nhol p99 = ${hol.p99.toFixed(2)} ms (${factor.toFixed(1)}x baseline)`);

  if (jsonPath) {
    const sh = (cmd: string[]) => spawnSync(cmd, { cwd: root }).stdout.toString().trim();
    writeFileSync(jsonPath, JSON.stringify({
      meta: { sha: sh(["git", "rev-parse", "--short", "HEAD"]), uname: sh(["uname", "-sm"]), cpus: cpus().length, date: new Date().toISOString(), scale },
      rows,
      hol: { p99Ms: hol.p99, baselineP99Ms: base99, factor },
    }, null, 2));
    console.log(`wrote ${jsonPath}`);
  }
  if (rows.some((r) => r.errors > 0 || r.non2xx > 0)) {
    console.error("WARNING: errors or non-2xx responses seen");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(String(e)); process.exitCode = 1; }).finally(cleanup);
