// API sweep before deploy: build a web app with an old and a new compiler, run both on copies of the same data, request every GET route and byte-diff status + body.
//
//   bun scripts/api-sweep.ts --app app.milo --old-compiler ~/git/milo-deployed --new-compiler ~/git/milo \
//       [--data-dir DIR --data-env VAR] [--db FILE] [--env K=V ...] [--port-env PORT] \
//       [--new-app B.milo, builds the new side from a different source]
//       [--routes FILE] [--ignore REGEX ...] [--flags "--release"] [--target T]
//
// Routes come from scanning the app source for `r.get("/x", ...)`, `r.stream(...)` and
// `addRoute("GET", "/x", ...)`. A route with `:param` or `*` is compared only when a
// concrete path in --routes (one per line, `#` comments; query strings allowed) matches
// it; otherwise it is listed as skipped. Each instance gets its own copy of the data
// (--data-dir copied whole, VAR pointing at the copy; --db copied beside the cwd) so the
// two never share writes. --ignore masks regex matches in bodies before diffing
// (timestamps, random ids). Instances are run bare with a hard wall-clock kill, not via
// scripts/guard.ts, because a server must stay up and guard owns the process group.
// Exit 0 only when no route differs and the sweep compared at least one route.
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";

export type Routes = { paths: string[]; patterns: string[] };

// GET routes the source registers, split into concrete paths and parameterised patterns.
export function scanRoutes(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\.(?:get|stream)\(\s*"(\/[^"]*)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/addRoute\(\s*"GET"\s*,\s*"([^"]+)"/g)) out.add(m[1]);
  return [...out].sort();
}

const isPattern = (p: string) => p.includes(":") || p.includes("*");

function patternRegex(pattern: string): RegExp {
  const esc = pattern.split("/").map(seg => seg.startsWith(":") ? "[^/?]+" : seg === "*" ? ".*" : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp("^" + esc.replace(/\/\.\*$/, "/.*") + "(?:\\?.*)?$");
}

// Requests to make: every concrete route, plus each --routes path (its pattern matched
// or not); patterns with no sample are skipped.
export function plan(scanned: string[], samples: string[]): { requests: string[]; skipped: string[] } {
  const requests = new Set<string>(scanned.filter(p => !isPattern(p)));
  const skipped: string[] = [];
  for (const p of scanned.filter(isPattern)) {
    const re = patternRegex(p);
    const hits = samples.filter(s => re.test(s));
    if (hits.length === 0) skipped.push(p);
    for (const h of hits) requests.add(h);
  }
  return { requests: [...requests].sort(), skipped };
}

export function mask(body: Buffer, ignore: RegExp[]): string {
  let s = body.toString("latin1");
  for (const re of ignore) s = s.replace(re, "<masked>");
  return s;
}

export function firstDiff(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const show = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return `at byte ${i} (old ${a.length} bytes, new ${b.length}): old ${show(a)} new ${show(b)}`;
}

function die(msg: string): never {
  console.error("api-sweep: " + msg);
  process.exit(2);
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

function build(compiler: string, entry: string, out: string, flags: string[], target: string | null): void {
  const main = join(resolve(compiler), "src", "main.ts");
  if (!existsSync(main)) die(`${compiler} is not a milo checkout (no src/main.ts)`);
  const args = ["run", main, "build", resolve(entry), "-o", out, ...flags];
  if (target) args.push("--target=" + target);
  try {
    execFileSync("bun", args, { cwd: resolve(compiler), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch (e) {
    die(`build with ${compiler} failed\n${String((e as { stderr?: Buffer }).stderr ?? e)}`);
  }
}

type Instance = { proc: ChildProcess; port: number; stderr: string[] };

async function start(bin: string, work: string, opt: Opts, port: number): Promise<Instance> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const kv of opt.env) {
    const i = kv.indexOf("=");
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  env[opt.portEnv] = String(port);
  const cwd = join(work, "cwd");
  mkdirSync(cwd, { recursive: true });
  if (opt.dataDir) {
    const copy = join(work, "data");
    cpSync(opt.dataDir, copy, { recursive: true });
    if (opt.dataEnv) env[opt.dataEnv] = copy;
  }
  if (opt.db) {
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(opt.db + suffix)) cpSync(opt.db + suffix, join(cwd, basename(opt.db) + suffix));
    if (opt.dbEnv) env[opt.dbEnv] = join(cwd, basename(opt.db));
  }
  const proc = spawn(bin, [], { cwd, env, stdio: ["ignore", "ignore", "pipe"], timeout: opt.timeoutS * 1000, killSignal: "SIGKILL" });
  const stderr: string[] = [];
  proc.stderr!.on("data", d => stderr.push(String(d)));
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) die(`${bin} exited ${proc.exitCode} before listening:\n${stderr.join("")}`);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (Date.now() - t0 > 20000) die(`${bin} did not listen on ${port} within 20s:\n${stderr.join("")}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return { proc, port, stderr };
}

async function get(port: number, path: string): Promise<{ status: number; body: Buffer }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  } catch (e) {
    return { status: -1, body: Buffer.from("request failed: " + String(e)) };
  }
}

type Opts = { env: string[]; portEnv: string; dataDir: string | null; dataEnv: string | null; db: string | null; dbEnv: string | null; timeoutS: number };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = { env: [], ignore: [] };
  const known = ["app", "new-app", "old-compiler", "new-compiler", "data-dir", "data-env", "db", "db-env", "port-env", "routes", "flags", "target", "timeout-s", "env", "ignore"];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !known.includes(k) || i + 1 >= argv.length) die("usage: api-sweep.ts --app A.milo --old-compiler DIR --new-compiler DIR [--data-dir D --data-env VAR] [--db F] [--env K=V] [--routes F] [--ignore RE] [--flags \"..\"] [--target T]");
    if (k in multi) multi[k].push(argv[++i]);
    else single[k] = argv[++i];
  }
  if (!single.app || !single["old-compiler"] || !single["new-compiler"]) die("--app, --old-compiler and --new-compiler are required");
  const ignore = multi.ignore.map(r => new RegExp(r, "g"));
  const scanned = scanRoutes(readFileSync(single.app, "utf8"));
  const samples = single.routes ? readFileSync(single.routes, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")) : [];
  const { requests, skipped } = plan(scanned, samples);
  if (requests.length === 0) die("no GET routes to compare (found " + scanned.length + " registered)");

  const work = mkdtempSync(join(tmpdir(), "api-sweep-"));
  const flags = (single.flags ?? "").split(/\s+/).filter(Boolean);
  const bins = [join(work, "app-old"), join(work, "app-new")];
  build(single["old-compiler"], single.app, bins[0], flags, single.target ?? null);
  build(single["new-compiler"], single["new-app"] ?? single.app, bins[1], flags, single.target ?? null);

  const opt: Opts = {
    env: multi.env, portEnv: single["port-env"] ?? "PORT", dataDir: single["data-dir"] ? resolve(single["data-dir"]) : null,
    dataEnv: single["data-env"] ?? null, db: single.db ? resolve(single.db) : null, dbEnv: single["db-env"] ?? null,
    timeoutS: Number(single["timeout-s"] ?? 600),
  };
  const insts: Instance[] = [];
  const differing: string[] = [];
  let identical = 0;
  try {
    for (let i = 0; i < 2; i++) {
      const w = join(work, i === 0 ? "old" : "new");
      mkdirSync(w, { recursive: true });
      insts.push(await start(bins[i], w, opt, await freePort()));
    }
    for (const path of requests) {
      const [a, b] = [await get(insts[0].port, path), await get(insts[1].port, path)];
      const d = a.status !== b.status
        ? `status ${a.status} vs ${b.status}`
        : firstDiff(mask(a.body, ignore), mask(b.body, ignore));
      if (d) differing.push(`  ${path}: ${d}`);
      else identical++;
    }
  } finally {
    for (const i of insts) i.proc.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`routes compared: ${requests.length}, identical: ${identical}, differing: ${differing.length}, skipped: ${skipped.length}`);
  if (differing.length) console.log("differing:\n" + differing.join("\n"));
  if (skipped.length) console.log("skipped (parameterised, no sample in --routes):\n" + skipped.map(s => "  " + s).join("\n"));
  process.exit(differing.length ? 1 : 0);
}

if (import.meta.main) await main();
