#!/usr/bin/env bun
// Differential fuzzer over random well-typed Milo programs (scripts/gen-programs-grammar.ts).
// Each runs in the reference interpreter, as a -O0 binary (live heap blocks counted with
// scripts/livecount.c, darwin) and as a -O2 binary under ASan. Any difference in stdout, exit code or live blocks,
// or any ASan report, is a compiler bug, a checker bug or an interpreter bug. A divergent
// program is reduced (statements and blocks dropped while the same divergence persists) and
// saved to tests/fixtures/gen/ (--save) or printed.
//
//   bun scripts/gen-programs.ts --n 200 --seed 1 [--jobs 2] [--save] [--keep DIR] [--time-s N]
//   bun scripts/gen-programs.ts --print 7        # the program for seed 7, nothing else
//   bun scripts/gen-programs.ts --check-only --n 300   # accept rate only (checker, no runs)
//   bun scripts/gen-programs.ts --reduce FILE [--key stdout:o0]   # reduce one saved program
// Needs mlir/build/milo-opt (or MILO_OPT=<path>). On a loaded machine the guard may kill a child on
// memory pressure; one retry covers it, and a divergence that does not reproduce standalone is that.
//
// Programs the checker rejects are dropped before any run; the accept rate is reported. Every
// child runs under scripts/guard.ts (memory and wall-clock caps); --jobs is capped at 4.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { guardedRun } from "./guard";
import { generate } from "./gen-programs-grammar";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const MEM_MB = 1024;

/** Type-check `src` (written at `path` so imports resolve); null when accepted, else the first error. */
export function checkSource(src: string, path: string): string | null {
  writeFileSync(path, src);
  try {
    const parsed = new Parser(new Lexer(src).tokenize(), src, path).parse();
    const program = resolveImports(parsed, dirname(path), getHostTarget(), path);
    const errors = new TypeChecker().check(program).diagnostics.filter(d => d.severity === "error");
    return errors.length ? errors[0]!.message : null;
  } catch (e) {
    return String((e as Error).message ?? e).split("\n")[0]!;
  }
}

export interface Obs { stdout: string; code: number | null; live: string | null; note: string | null }
export interface Outcome { interp: Obs; o0: Obs; asan: Obs }
export type Which = "interp" | "o0" | "asan";

const norm = (code: number, signal: string | null) => (signal === "SIGABRT" ? 134 : signal ? 128 + (signal === "SIGSEGV" ? 11 : signal === "SIGBUS" ? 10 : 9) : code);

let LIVECOUNT: string | null = null;
function livecount(scratch: string): string | null {
  if (process.platform !== "darwin") return null;
  if (LIVECOUNT) return LIVECOUNT;
  const out = join(scratch, "livecount.dylib");
  if (!existsSync(out)) {
    const cc = Bun.spawnSync(["/usr/bin/clang", "-dynamiclib", "-O1", "-o", out, join(ROOT, "scripts", "livecount.c")]);
    if (cc.exitCode !== 0) throw new Error(`cannot build scripts/livecount.c:\n${cc.stderr}`);
  }
  return (LIVECOUNT = out);
}

async function runInterp(path: string, cwd: string): Promise<Obs> {
  // bun reserves sparse address space: on linux arm64 a 1 GB ulimit -v kills it before main runs.
  const r = await guardedRun("bun", ["run", MAIN, "interp", path, "--live"], { timeoutMs: 120_000, cwd, memMb: MEM_MB, virtualMemMb: 8192 });
  const m = /^interp: (unsupported|stuck at)[^\n]*/m.exec(r.stderr);
  const crash = /^(\w*Error: [^\n]*)/m.exec(r.stderr);
  const live = /interp: live blocks (\S+)/.exec(r.stderr)?.[1] ?? null;
  const note = m ? (m[1] === "unsupported" ? `unsupported: ${m[0]}` : `stuck: ${m[0]}`) : crash ? `crash: ${crash[1]}` : r.guardKill ? `killed: ${r.guardKill}` : null;
  return { stdout: r.stdout, code: norm(r.code, r.signal), live, note };
}

async function runBinary(path: string, flags: string[], scratch: string, count: boolean): Promise<Obs> {
  const bin = path.replace(/\.milo$/, flags[0] === "--fast" ? ".o0" : ".asan");
  const b = await guardedRun("bun", ["run", MAIN, "build", path, ...flags, "-o", bin], { timeoutMs: 180_000, cwd: scratch, memMb: MEM_MB });
  if (b.guardKill) return { stdout: "", code: null, live: null, note: `killed: build ${b.guardKill}` };
  if (b.code !== 0) return { stdout: "", code: null, live: null, note: `build failed: ${b.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(0, 3).join(" | ").slice(0, 300)}` };
  const env = { ...process.env, ASAN_OPTIONS: `detect_leaks=${process.platform === "linux" ? 1 : 0}:symbolize=0` };
  const r = await guardedRun(bin, [], { timeoutMs: 60_000, cwd: scratch, memMb: MEM_MB, env });
  const report = /ERROR: (AddressSanitizer|LeakSanitizer)[^\n]*/.exec(r.stderr);
  let live: string | null = null;
  const lc = count && !r.guardKill ? livecount(scratch) : null;
  if (lc) {
    // Not through guard.ts: it execs via /bin/sh and macOS strips DYLD_* from there. The binary has just
    // finished under the guard with the same input, so a direct spawn with a hard timeout is what is left to risk.
    const out = `${bin}.live`;
    rmSync(out, { force: true });
    const p = Bun.spawn([bin], { cwd: scratch, stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { ...process.env, DYLD_INSERT_LIBRARIES: lc, MILO_LIVECOUNT_OUT: out } });
    const timer = setTimeout(() => p.kill(9), 30_000);
    await p.exited;
    clearTimeout(timer);
    live = existsSync(out) ? readFileSync(out, "utf-8").trim() : null;
  }
  return { stdout: r.stdout, code: norm(r.code, r.signal), live, note: report ? report[0] : r.guardKill ? `killed: ${r.guardKill}` : null };
}

// The guard kills a tree on system memory pressure, which says nothing about the program: run it again once.
async function retried(f: () => Promise<Obs>): Promise<Obs> {
  const o = await f();
  if (!o.note?.startsWith("killed")) return o;
  await new Promise(r => setTimeout(r, 3000));
  return f();
}

/** Run `path` through the pipelines named in `which` (all by default); the others come back empty. */
export async function runAll(path: string, scratch: string, which: Which[] = ["interp", "o0", "asan"]): Promise<Outcome> {
  const empty: Obs = { stdout: "", code: null, live: null, note: "not run" };
  const [interp, o0, asan] = await Promise.all([
    which.includes("interp") ? retried(() => runInterp(path, scratch)) : empty,
    which.includes("o0") ? retried(() => runBinary(path, ["--fast"], scratch, true)) : empty,
    which.includes("asan") ? retried(() => runBinary(path, ["--sanitize"], scratch, false)) : empty,
  ]);
  return { interp, o0, asan };
}

/** The ways the three runs disagree, as stable keys ("stdout:o0", "asan-report", ...). Empty: all agree. "skip" is an unmodelled program. */
export function divergences(o: Outcome, which: Which[] = ["interp", "o0", "asan"]): string[] {
  const out: string[] = [];
  const { interp, o0, asan } = o;
  if (which.includes("interp") && interp.note?.startsWith("unsupported")) return ["skip"];
  if (which.includes("interp") && interp.note) out.push(interp.note.startsWith("stuck") ? "interp-stuck" : interp.note.startsWith("crash") ? "interp-crash" : "interp-killed");
  for (const [k, b] of [["o0", o0], ["asan", asan]] as const) {
    if (!which.includes(k)) continue;
    if (b.note?.startsWith("build failed")) out.push(`build-failed:${k}`);
    else if (b.note?.startsWith("ERROR")) out.push(`asan-report:${k}`);
    else if (b.note) out.push(`${k}-killed`);
  }
  const ref = which.includes("interp") && !interp.note ? interp : null;
  if (ref) {
    for (const [k, b] of [["o0", o0], ["asan", asan]] as const) {
      if (!which.includes(k) || b.note) continue;
      if (b.stdout !== ref.stdout) out.push(`stdout:${k}`);
      else if (b.code !== ref.code) out.push(`exit:${k}`);
    }
    if (which.includes("o0") && !o0.note && ref.live !== null && o0.live !== null && ref.live !== o0.live) out.push("live:o0");
  } else if (which.includes("o0") && which.includes("asan") && !o0.note && !asan.note) {
    if (o0.stdout !== asan.stdout) out.push("stdout:o0-vs-asan");
    else if (o0.code !== asan.code) out.push("exit:o0-vs-asan");
  }
  return out;
}

// ---- reduction: drop single lines and balanced blocks while the same divergence key persists
function units(lines: string[]): [number, number][] {
  const u: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    u.push([i, i + 1]);
    if (/\{\s*$/.test(lines[i]!)) {
      const ind = /^\s*/.exec(lines[i]!)![0].length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\}/.test(lines[j]!) && /^\s*/.exec(lines[j]!)![0].length === ind) {
          // `} else {` continues the construct: the unit ends at the last closing brace of the chain
          if (/\{\s*$/.test(lines[j]!)) continue;
          u.push([i, j + 1]);
          break;
        }
      }
    }
  }
  return u.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
}

export async function reduce(src: string, key: string, scratch: string, budget = 80): Promise<string> {
  const kind = key.split(":")[0]!;
  // Only the pipelines that can show this divergence: a build failure or ASan report needs no interpreter.
  const which: Which[] = kind.startsWith("interp") ? ["interp"]
    : kind === "build-failed" || kind === "asan-report" || kind.endsWith("-killed") ? [key.endsWith("o0") ? "o0" : "asan"]
    : key.endsWith(":o0") || kind === "live" ? ["interp", "o0"] : key.endsWith(":asan") ? ["interp", "asan"] : ["interp", "o0", "asan"];
  if (which.length === 1) budget *= 4; // a single pipeline is cheap
  const probe = join(scratch, "reduce.milo");
  let lines = src.split("\n");
  let calls = 0;
  for (let progress = true; progress && calls < budget;) {
    progress = false;
    for (const [a, b] of units(lines)) {
      if (calls >= budget) break;
      const cand = [...lines.slice(0, a), ...lines.slice(b)];
      if (!cand.some(l => l.startsWith("fn main"))) continue;
      const text = cand.join("\n");
      if (checkSource(text, probe)) continue;
      calls++;
      if (divergences(await runAll(probe, scratch, which), which).includes(key)) { lines = cand; progress = true; break; }
    }
  }
  return lines.join("\n");
}

// ---- driver
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (opt("--print")) { process.stdout.write(generate(Number(opt("--print"))).src); process.exit(0); }
  if (opt("--reduce")) { // re-run and reduce one saved program
    const dir = mkdtempSync(join(tmpdir(), "milo-gen-"));
    const p = join(dir, "r.milo");
    const src = readFileSync(opt("--reduce")!, "utf-8");
    writeFileSync(p, src);
    const ds = divergences(await runAll(p, dir));
    if (!ds.length || ds[0] === "skip") { console.error(`no divergence (${ds})`); process.exit(1); }
    console.error(`reducing on ${opt("--key") ?? ds[0]} (all: ${ds.join(", ")})`);
    console.log(await reduce(src, opt("--key") ?? ds[0]!, dir));
    process.exit(0);
  }
  const n = Number(opt("--n") ?? 50);
  const seed0 = Number(opt("--seed") ?? 1);
  const jobs = Math.min(4, Number(opt("--jobs") ?? 2));
  const deadline = opt("--time-s") ? Date.now() + Number(opt("--time-s")) * 1000 : Infinity;
  const save = argv.includes("--save");
  const checkOnly = argv.includes("--check-only"); // accept rate only: no interpreter, no builds
  const scratch = opt("--keep") ?? mkdtempSync(join(tmpdir(), "milo-gen-"));
  mkdirSync(scratch, { recursive: true });
  let generated = 0, accepted = 0, ran = 0, skipped = 0, next = 0;
  const tally = new Map<string, number>();
  const found: { seed: number; key: string; src: string; min: string }[] = [];
  const rejects = new Map<string, number>();
  await Promise.all(Array.from({ length: jobs }, async (_, w) => {
    const dir = join(scratch, `w${w}`);
    mkdirSync(dir, { recursive: true });
    while (next < n && Date.now() < deadline) {
      const seed = seed0 + next++;
      const { src } = generate(seed);
      const path = join(dir, `g${seed}.milo`);
      generated++;
      const err = checkSource(src, path);
      if (err) { rejects.set(err.slice(0, 70), (rejects.get(err.slice(0, 70)) ?? 0) + 1); continue; }
      accepted++;
      if (checkOnly) continue;
      const out = await runAll(path, dir);
      const ds = divergences(out);
      if (ds[0] === "skip") { skipped++; console.error(`seed ${seed}: skipped (${out.interp.note})`); continue; }
      ran++;
      if (!ds.length) continue;
      for (const d of ds) tally.set(d, (tally.get(d) ?? 0) + 1);
      console.error(`seed ${seed}: DIVERGES ${ds.join(", ")}`);
      const min = await reduce(src, ds[0]!, dir);
      found.push({ seed, key: ds[0]!, src, min });
      if (save) {
        const d = join(ROOT, "tests", "fixtures", "gen");
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `seed${seed}.milo`), `// differential finding: ${ds.join(", ")} (seed ${seed})\n${min}`);
      } else console.log(`---- seed ${seed} ${ds.join(", ")}\n${min}`);
    }
  }));
  if (!opt("--keep")) rmSync(scratch, { recursive: true, force: true });
  console.log(`generated ${generated}, accepted ${accepted} (${((100 * accepted) / Math.max(1, generated)).toFixed(1)}%), compared ${ran}, skipped ${skipped}, divergent ${found.length}`);
  for (const [k, c] of tally) console.log(`  ${k}: ${c}`);
  if (generated - accepted > 0) console.log("top rejects:", [...rejects].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${c}x ${k}`).join("; "));
  if (ran === 0 && !checkOnly) { console.error("gen-programs: nothing compared"); process.exit(1); }
  process.exit(found.length ? 2 : 0);
}
