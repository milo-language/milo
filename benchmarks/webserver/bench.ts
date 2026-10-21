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
const basePort = Number(process.env.PORT ?? 8090);
const keepalive = argv.includes("--keepalive");
const serverOpt = opt("--server") ?? "all";
type Kind = "milo" | "rust1" | "rustmt";
const ALL: Kind[] = ["milo", "rust1", "rustmt"];
if (serverOpt !== "all" && !ALL.includes(serverOpt as Kind)) {
  console.error("--server must be milo|rust1|rustmt|all");
  process.exit(1);
}
const kinds: Kind[] = serverOpt === "all" ? ALL : [serverOpt as Kind];
// Each server gets its own port so a lingering socket from the previous one cannot interfere.
const portOf = (k: Kind) => basePort + ALL.indexOf(k);
let base = "";

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
  // std/http always answers Connection: close, so by default no server gets connection reuse.
  const ka = keepalive ? [] : ["--disable-keepalive"];
  return [oha!, "--no-tui", "--output-format", "json", ...ka, "-n", String(n), "-c", String(c), base + path];
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

interface Result {
  rows: Row[];
  hol: Row;
  baseP99: number;
}

function buildMilo(): string {
  const bin = join(tmp, "bench-server");
  console.log("building milo server...");
  const b = spawnSync([join(root, "milo"), "build", join(root, "benchmarks/webserver/server.milo"), "-o", bin, "--release"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (b.exitCode !== 0) throw new Error("milo server build failed");
  return bin;
}

function buildRust(): string {
  if (!Bun.which("cargo")) throw new Error("cargo not found on PATH; install Rust (https://rustup.rs) to run the rust servers");
  const manifest = join(root, "benchmarks/webserver/rust/Cargo.toml");
  const b = spawnSync(["cargo", "build", "--release", "--manifest-path", manifest], { cwd: root });
  if (b.exitCode !== 0) throw new Error("rust server build failed:\n" + b.stderr.toString());
  return join(root, "benchmarks/webserver/rust/target/release/bench-server-rust");
}

async function runServer(kind: Kind, bin: string): Promise<Result> {
  const port = portOf(kind);
  base = `http://127.0.0.1:${port}`;
  console.log(`\n== ${kind} (port ${port}) ==`);
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), DB_PATH: join(tmp, `${kind}.db`) };
  if (kind === "rust1") env.RUST_THREADS = "1";
  if (kind === "rustmt") env.RUST_THREADS = "0";
  server = spawn([bin], { env, stdout: "ignore", stderr: "inherit" });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(base + "/hello")).ok; } catch { await Bun.sleep(200); }
  }
  if (!up) throw new Error(`${kind} server did not answer /hello`);

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

  server.kill(9);
  await server.exited;
  server = undefined;
  return { rows, hol, baseP99: rows.find((r) => r.name.startsWith("hol-baseline"))!.p99 };
}

async function main() {
  console.log(`keep-alive: ${keepalive ? "ON (oha reuses connections; milo still closes each one)" : "OFF (oha --disable-keepalive for all servers)"}`);
  const bins: Partial<Record<Kind, string>> = {};
  if (kinds.includes("milo")) bins.milo = buildMilo();
  if (kinds.some((k) => k !== "milo")) {
    const r = buildRust();
    for (const k of kinds) if (k !== "milo") bins[k] = r;
  }

  const results: Partial<Record<Kind, Result>> = {};
  for (const k of kinds) results[k] = await runServer(k, bins[k]!);

  const f = (x: number) => x.toFixed(2).padStart(9);
  for (const k of kinds) {
    const { rows, hol, baseP99 } = results[k]!;
    const w = Math.max(...rows.map((r) => r.name.length));
    console.log(`\n[${k}]\n` + "scenario".padEnd(w) + "       rps    p50 ms    p99 ms    max ms  non2xx  errors");
    for (const r of rows) {
      console.log(r.name.padEnd(w) + r.rps.toFixed(0).padStart(10) + f(r.p50) + f(r.p99) + f(r.max) + String(r.non2xx).padStart(8) + String(r.errors).padStart(8));
    }
    console.log(`hol p99 = ${hol.p99.toFixed(2)} ms (${(hol.p99 / baseP99).toFixed(1)}x baseline)`);
  }

  if (kinds.length > 1) {
    const first = results[kinds[0]]!.rows;
    const w = Math.max(...first.map((r) => r.name.length));
    const cell = (k: Kind, i: number, fn: (r: Row) => string) => (results[k] ? fn(results[k]!.rows[i]) : "-").padStart(12);
    console.log("\ncomparison\n" + "scenario".padEnd(w) + ALL.map((k) => (k + " rps").padStart(12)).join("") + ALL.map((k) => (k + " p99").padStart(12)).join(""));
    first.forEach((r, i) => {
      console.log(r.name.padEnd(w) + ALL.map((k) => cell(k, i, (x) => x.rps.toFixed(0))).join("") + ALL.map((k) => cell(k, i, (x) => x.p99.toFixed(2))).join(""));
    });
    console.log("");
    for (const k of kinds) console.log(`hol p99 [${k}] = ${results[k]!.hol.p99.toFixed(2)} ms (${(results[k]!.hol.p99 / results[k]!.baseP99).toFixed(1)}x baseline)`);
  }

  if (jsonPath) {
    const sh = (cmd: string[]) => spawnSync(cmd, { cwd: root }).stdout.toString().trim();
    const servers: Record<string, unknown> = {};
    for (const k of kinds) {
      const r = results[k]!;
      servers[k] = { rows: r.rows, hol: { p99Ms: r.hol.p99, baselineP99Ms: r.baseP99, factor: r.hol.p99 / r.baseP99 } };
    }
    writeFileSync(jsonPath, JSON.stringify({
      meta: { sha: sh(["git", "rev-parse", "--short", "HEAD"]), uname: sh(["uname", "-sm"]), cpus: cpus().length, date: new Date().toISOString(), scale, keepalive },
      servers,
    }, null, 2));
    console.log(`wrote ${jsonPath}`);
  }
  if (Object.values(results).some((r) => r!.rows.some((x) => x.errors > 0 || x.non2xx > 0))) {
    console.error("WARNING: errors or non-2xx responses seen");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(String(e)); process.exitCode = 1; }).finally(cleanup);
