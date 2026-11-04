#!/usr/bin/env bun
// What the reference interpreter (src/interp.ts, `milo interp`) can run, and whether what it prints is
// what the fixture's author wrote down.
//
// The interpreter is the oracle for the compiled binaries (scripts/mlir-same.ts), so this is the check on
// the oracle itself: every fixture carries `// @expect:` lines written by hand, and the interpreter's stdout
// must equal them (as tests/run.test.ts compares a compiled run: lines trimmed). A program without
// `@expect` lines (mlir/test/programs) can only be checked for running to completion. Exit status and live
// heap blocks have no second source here; mlir-same compares them against the compiled run.
//
//   bun scripts/interp-coverage.ts                  # fixtures + mlir/test/programs
//   bun scripts/interp-coverage.ts --filter arith   # names matching a regex
//   bun scripts/interp-coverage.ts --programs       # only mlir/test/programs
//   bun scripts/interp-coverage.ts --why            # tally of why programs are unsupported
//   bun scripts/interp-coverage.ts --list           # each unsupported program with its cause
//   bun scripts/interp-coverage.ts --jobs 4         # --timeout MS or MILO_INTERP_TIMEOUT_MS: per-program limit (default 600000)
//
// Verdicts: same (stdout equals the @expect lines), ran (no @expect lines; ran to the end), differ
// (stdout differs, the run got stuck, or the interpreter crashed: an interpreter bug, a wrong rule in
// docs/semantics/milo.md, or a wrong @expect), unsupported (the interpreter does not model something the
// program uses: reported with the reason, never counted as a pass). It cannot pass vacuously: zero programs
// run exits 1.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const filter = opt("--filter");
const jobs = Number(opt("--jobs") ?? 4);
// sha256, pbkdf2 and inflate programs take minutes in a tree-walking interpreter: a long default, MILO_INTERP_TIMEOUT_MS or --timeout to change it
const TIMEOUT_MS = Number(opt("--timeout") ?? process.env.MILO_INTERP_TIMEOUT_MS ?? 600_000);

type Verdict = "same" | "ran" | "differ" | "unsupported";
export interface Result { name: string; verdict: Verdict; detail: string; where?: string }

const list = (dir: string, kind: "fixtures" | "programs") => readdirSync(dir).filter(f => f.endsWith(".milo"))
  .map(f => ({ path: join(dir, f), name: f.slice(0, -5), kind }))
  .filter(p => !filter || new RegExp(filter).test(p.name)).sort((a, b) => (a.name < b.name ? -1 : 1));

// run.test.ts compares trimmed lines, so a trailing blank line or an indent does not matter
const lines = (s: string) => s.trim().split("\n").map(l => l.trim());

export async function compareOne(p: { path: string; name: string; kind: "fixtures" | "programs" }, cwd: string): Promise<Result> {
  const src = readFileSync(p.path, "utf-8");
  const flags = /^\/\/ @mlir-same-flags:(.*)$/m.exec(src)?.[1]?.trim().split(/\s+/) ?? [];
  const expect = [...src.matchAll(/\/\/\s*@expect:\s?(.*)$/gm)].map(m => m[1]!.trimEnd());
  const r = await guardedRun("bun", ["run", MAIN, "interp", p.path, "--live", ...flags], { timeoutMs: TIMEOUT_MS, cwd });
  const m = /^interp: (unsupported|stuck at)[^\n]*/m.exec(r.stderr);
  if (m?.[1] === "unsupported") return { name: p.name, verdict: "unsupported", detail: m[0].replace(/^interp: unsupported: /, ""), where: /^  in (.*)$/m.exec(r.stderr)?.[1] };
  if (m) return { name: p.name, verdict: "differ", detail: m[0] };
  const crash = /^(\w*Error: [^\n]*)/m.exec(r.stderr); // a JS exception: an interpreter bug, never a pass
  if (crash) return { name: p.name, verdict: "differ", detail: `interpreter crash: ${crash[1]}` };
  if (r.guardKill || r.signal === "SIGKILL" || r.signal === "SIGTERM") return { name: p.name, verdict: "unsupported", detail: `too slow or too big: killed after ${TIMEOUT_MS / 1000}s or by the memory guard` };
  if (r.code === 1 && !r.stdout && /error/.test(r.stderr) && !/live blocks/.test(r.stderr)) return { name: p.name, verdict: "unsupported", detail: `frontend: ${r.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n")[0]}` };
  if (!expect.length) return { name: p.name, verdict: "ran", detail: "" };
  const got = lines(r.stdout), want = lines(expect.join("\n"));
  if (JSON.stringify(got) !== JSON.stringify(want)) return { name: p.name, verdict: "differ", detail: `stdout:\n  expect ${JSON.stringify(want.join("\n").slice(0, 300))}\n  interp ${JSON.stringify(got.join("\n").slice(0, 300))}` };
  return { name: p.name, verdict: "same", detail: "" };
}

if (import.meta.main) {
  const programs = list(join(ROOT, "mlir", "test", "programs"), "programs");
  const gen = join(ROOT, "tests", "fixtures", "gen");
  const all = argv.includes("--programs") ? programs : [...programs, ...list(join(ROOT, "tests", "fixtures"), "fixtures"), ...(existsSync(gen) ? list(gen, "fixtures") : [])];
  const tmp = mkdtempSync(join(tmpdir(), "milo-interp-"));
  const results: Result[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < all.length) results.push(await compareOne(all[next++]!, tmp));
  }));
  rmSync(tmp, { recursive: true, force: true });
  const n = (v: Verdict) => results.filter(r => r.verdict === v).length;
  const byName = (a: Result, b: Result) => (a.name < b.name ? -1 : 1);
  for (const r of results.filter(r => r.verdict === "differ").sort(byName)) console.log(`DIFFER ${r.name}: ${r.detail}`);
  if (argv.includes("--list")) for (const r of results.filter(r => r.verdict === "unsupported").sort(byName)) console.log(`UNSUPPORTED ${r.name}: ${r.detail}${r.where ? `  [in ${r.where}]` : ""}`);
  if (argv.includes("--why")) {
    const why = new Map<string, number>();
    for (const r of results) if (r.verdict === "unsupported") why.set(r.detail, (why.get(r.detail) ?? 0) + 1);
    for (const [d, c] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${d}`);
  }
  console.log(`interp-coverage: ${n("same")} same as @expect, ${n("ran")} ran (no @expect), ${n("differ")} differ, ${n("unsupported")} unsupported (of ${all.length})`);
  if (n("same") + n("ran") + n("differ") === 0) { console.error("interp-coverage: nothing ran"); process.exit(1); }
  process.exit(n("differ") > 0 ? 1 : 0);
}
