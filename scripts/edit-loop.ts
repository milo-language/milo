// Edit-loop benchmark: build time for cold, unchanged-rebuild and one-line-edit scenarios
// over a fixed set of real programs, with the MILO_TIMING phase breakdown per build.
// This is the number every fast-iteration step (docs/plans/fast-iteration-2026-10.md)
// must move.
//
//   bun scripts/edit-loop.ts [--runs N] [-t <program substr>] [--json]
//
// Builds only; no produced binary is ever run. Each build goes through scripts/guard.ts
// with the same caps scripts/selfhost.sh uses, since the src-milo build peaks near 2 GB.
import { spawnSync } from "child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const root = resolve(import.meta.dir, "..");

interface Program {
  name: string;
  dir: string;      // copied whole into the tmp workspace, so relative imports keep working
  entry: string;    // relative to dir
  // A string literal (quotes included) inside a user fn of the entry file, appearing
  // exactly once. The edit scenarios append characters inside it.
  needle: string;
}

const PROGRAMS: Program[] = [
  { name: "jq", dir: "examples/cli-tools", entry: "jq.milo", needle: `"jq: expected array for '[]'"` },
  // The project root, not src/: package deps resolve from milo.json beside it.
  { name: "java-dap", dir: "examples/tools/java-dap", entry: "src/main.milo", needle: `"0.1.0"` },
  // flight is larger but embeds city assets that are not in a plain checkout.
  { name: "redline", dir: "examples/games/redline", entry: "main.milo", needle: `"SDL_Init failed"` },
  // std/ changes may leave src-milo behind (CLAUDE.md), and then this row reports FAIL.
  { name: "src-milo", dir: "src-milo", entry: "main.milo", needle: `"commands: build, run, emit-ir, check, lsp"` },
];

const SCENARIOS = ["cold", "warm unchanged", "one-line edit", "one-line edit --fast"] as const;
type Scenario = typeof SCENARIOS[number];

interface Build {
  ok: boolean;
  error?: string;
  totalMs: number;
  phases: Record<string, number>;
  unitsCompiled: number;
  unitsTotal: number;
}

interface Row {
  program: string;
  scenario: Scenario;
  ok: boolean;
  error?: string;
  totalS: number;
  frontendS: number;
  cdeclS: number;
  splitS: number;
  clangS: number;
  linkS: number;
  unitsCompiled: number;
  unitsTotal: number;
  runs: number;
}

const FRONTEND = ["lex+parse", "resolve imports", "check", "lower", "codegen"];

function parseArgs() {
  const a = process.argv.slice(2);
  let runs = 3, filter: string | null = null, json = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--runs") runs = Number(a[++i]);
    else if (a[i] === "-t") filter = a[++i] ?? null;
    else if (a[i] === "--json") json = true;
    else { console.error(`unknown arg: ${a[i]}`); process.exit(2); }
  }
  if (!Number.isInteger(runs) || runs < 1) { console.error("--runs needs a positive integer"); process.exit(2); }
  return { runs, filter, json };
}

// Parses the table src/timing.ts prints. A missing table on a successful build means the
// parser and the printer disagree, which must fail loudly rather than report zeros.
function parseTiming(stderr: string): { totalMs: number; phases: Record<string, number>; compiled: number; total: number } | null {
  const start = stderr.lastIndexOf("milo timing (ms):");
  if (start < 0) return null;
  const phases: Record<string, number> = {};
  let totalMs = -1, compiled = 0, total = 0;
  for (const line of stderr.slice(start).split("\n").slice(1)) {
    const m = line.match(/^  (\s*)(\S.*?)\s+([\d.]+)\s+[\d.]+%(?:\s+(.*))?$/);
    if (!m) break;
    const name = m[2]!, ms = Number(m[3]);
    if (name === "total") { totalMs = ms; break; }
    phases[name] = (phases[name] ?? 0) + ms;
    const u = m[4]?.match(/^(\d+)\/(\d+) units compiled/);
    if (u) { compiled += Number(u[1]); total += Number(u[2]); }
  }
  return totalMs < 0 ? null : { totalMs, phases, compiled, total };
}

function build(entry: string, out: string, opts: { cache: boolean; fast: boolean }): Build {
  const env: Record<string, string> = { ...process.env as Record<string, string>, MILO_TIMING: "1" };
  if (!opts.cache) env.MILO_OBJ_CACHE = "0";
  else delete env.MILO_OBJ_CACHE;
  const args = ["scripts/guard.ts", "--mem-mb", "4096", "--virtual-mem-mb", "8192", "--timeout-s", "600", "--",
    "bun", "run", join(root, "src/main.ts"), "build", entry, "-o", out, ...(opts.fast ? ["--fast"] : [])];
  const r = spawnSync("bun", args, { cwd: root, env, encoding: "utf-8", maxBuffer: 64 << 20 });
  const stderr = r.stderr ?? "";
  if (r.status !== 0) {
    const plain = stderr.replace(/\x1b\[[0-9;]*m/g, "");
    const firstErr = plain.split("\n").find(l => /^error/.test(l)) ?? plain.trim().split("\n").pop() ?? `exit ${r.status}`;
    return { ok: false, error: firstErr.trim(), totalMs: 0, phases: {}, unitsCompiled: 0, unitsTotal: 0 };
  }
  const t = parseTiming(stderr);
  if (!t) throw new Error(`build of ${entry} succeeded but printed no MILO_TIMING table`);
  return { ok: true, totalMs: t.totalMs, phases: t.phases, unitsCompiled: t.compiled, unitsTotal: t.total };
}

function toRow(program: string, scenario: Scenario, builds: Build[]): Row {
  const failed = builds.find(b => !b.ok);
  if (failed) {
    return { program, scenario, ok: false, error: failed.error, totalS: 0, frontendS: 0, cdeclS: 0, splitS: 0,
      clangS: 0, linkS: 0, unitsCompiled: 0, unitsTotal: 0, runs: builds.length };
  }
  // The median run by total, reported whole, so its columns describe one real build.
  const b = [...builds].sort((x, y) => x.totalMs - y.totalMs)[Math.floor((builds.length - 1) / 2)]!;
  const s = (ms: number) => Math.round(ms) / 1000;
  const ph = (n: string) => b.phases[n] ?? 0;
  return {
    program, scenario, ok: true, runs: builds.length,
    totalS: s(b.totalMs),
    frontendS: s(FRONTEND.reduce((acc, n) => acc + ph(n), 0)),
    cdeclS: s(ph("verify c decls")),
    splitS: s(ph("split")),
    clangS: s(ph("clang")),
    linkS: s(ph("link")),
    unitsCompiled: b.unitsCompiled,
    unitsTotal: b.unitsTotal,
  };
}

// The objcache outlives this script, so an edit that repeats one from an earlier
// invocation is served from cache and measures nothing. The nonce makes every edit new.
const editNonce = Math.random().toString(36).slice(2, 8);

function editOnce(file: string, original: string, needle: string, n: number): void {
  const edited = needle.slice(0, -1) + editNonce + n + needle.slice(-1);
  writeFileSync(file, original.replace(needle, edited));
}

function benchProgram(p: Program, runs: number, work: string, log: (s: string) => void): Row[] {
  // Copied even for scenarios that do not edit, so every scenario builds the same path
  // and the objcache's per-program unit placement (keyed by source path) is shared.
  const copy = join(work, p.name);
  rmSync(copy, { recursive: true, force: true });
  cpSync(join(root, p.dir), copy, { recursive: true });
  const entry = join(copy, p.entry);
  const original = readFileSync(entry, "utf-8");
  const hits = original.split(p.needle).length - 1;
  if (hits !== 1) throw new Error(`${p.name}: edit needle ${p.needle} found ${hits} times in ${p.entry}, need exactly 1`);
  const out = join(work, `${p.name}.out`);
  const rows: Row[] = [];
  const time = (scenario: Scenario, n: number, fn: (i: number) => Build) => {
    const bs: Build[] = [];
    for (let i = 0; i < n; i++) {
      const b = fn(i);
      bs.push(b);
      log(`  ${p.name} / ${scenario} #${i + 1}: ${b.ok ? (b.totalMs / 1000).toFixed(2) + "s" : "FAIL " + b.error}`);
      if (!b.ok) break;
    }
    rows.push(toRow(p.name, scenario, bs));
    return bs[bs.length - 1]!.ok;
  };

  if (!time("cold", runs, () => build(entry, out, { cache: false, fast: false }))) {
    // Every later scenario would fail the same way; report them as such without the wait.
    for (const s of SCENARIOS.slice(1)) rows.push({ ...rows[0]!, scenario: s });
    return rows;
  }
  build(entry, out, { cache: true, fast: false }); // prime
  time("warm unchanged", runs, () => build(entry, out, { cache: true, fast: false }));
  let n = 0;
  time("one-line edit", runs, () => { editOnce(entry, original, p.needle, ++n); return build(entry, out, { cache: true, fast: false }); });
  writeFileSync(entry, original);
  build(entry, out, { cache: true, fast: true }); // prime the -O0 objects
  time("one-line edit --fast", runs, () => { editOnce(entry, original, p.needle, ++n); return build(entry, out, { cache: true, fast: true }); });
  writeFileSync(entry, original);
  return rows;
}

function markdown(rows: Row[]): string {
  const head = "| program | scenario | total s | frontend s | cdecl s | split s | clang s | link s | units compiled/total |";
  const sep = "|---|---|--:|--:|--:|--:|--:|--:|--:|";
  const f = (x: number) => x.toFixed(2);
  const body = rows.map(r => r.ok
    ? `| ${r.program} | ${r.scenario} | ${f(r.totalS)} | ${f(r.frontendS)} | ${f(r.cdeclS)} | ${f(r.splitS)} | ${f(r.clangS)} | ${f(r.linkS)} | ${r.unitsCompiled}/${r.unitsTotal} |`
    : `| ${r.program} | ${r.scenario} | FAIL | | | | | | ${r.error?.replace(/\|/g, "\\|").slice(0, 80)} |`);
  return [head, sep, ...body].join("\n");
}

const { runs, filter, json } = parseArgs();
const programs = PROGRAMS.filter(p => !filter || p.name.includes(filter));
if (programs.length === 0) { console.error(`no program matches '${filter}' (have: ${PROGRAMS.map(p => p.name).join(", ")})`); process.exit(2); }
const work = join(tmpdir(), "milo-edit-loop");
mkdirSync(work, { recursive: true });
const rows: Row[] = [];
try {
  for (const p of programs) rows.push(...benchProgram(p, runs, work, s => console.error(s)));
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (json) console.log(JSON.stringify({ schema: 1, runs, rows }, null, 2));
else {
  console.log(`edit loop, median of ${runs} (total = compiler process start to binary written; frontend = lex+parse+resolve+check+lower+codegen)\n`);
  console.log(markdown(rows));
}
