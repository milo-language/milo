#!/usr/bin/env bun
// Second-oracle gate: run every fixture through the reference interpreter (src/interp.ts,
// `milo interp`) and compare stdout, exit code and live heap blocks at exit with the
// recorded golden (tests/golden, as scripts/mlir-same.ts reads it) or, for a fixture with no
// golden, its `// @expect:` lines. A "differ" is an interpreter bug, a compiler bug or a
// wrong rule in docs/semantics/mini-milo.md, and a stuck program is reported as a differ.
// "unsupported" is a program the interpreter does not model (FFI, tasks, ...): skipped,
// never counted as a pass. The "same" count is the progress number.
//
//   bun scripts/interp-vs-golden.ts                 # fixtures + mlir/test/programs
//   bun scripts/interp-vs-golden.ts --filter arith  # names matching a regex
//   bun scripts/interp-vs-golden.ts --programs      # only mlir/test/programs
//   bun scripts/interp-vs-golden.ts --why           # tally of why programs are unsupported
//   bun scripts/interp-vs-golden.ts --list          # each unsupported program with its cause
//   bun scripts/interp-vs-golden.ts --jobs 4         # --timeout MS or MILO_INTERP_TIMEOUT_MS: per-program limit (default 600000)
//
// It cannot pass vacuously: zero programs compared exits 1.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const GOLDEN = join(ROOT, "tests", "golden");
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const filter = opt("--filter");
const jobs = Number(opt("--jobs") ?? 4);
// sha256, pbkdf2 and inflate programs take minutes in a tree-walking interpreter: a long default, MILO_INTERP_TIMEOUT_MS or --timeout to change it
const TIMEOUT_MS = Number(opt("--timeout") ?? process.env.MILO_INTERP_TIMEOUT_MS ?? 600_000);

type Verdict = "same" | "differ" | "unsupported" | "no-oracle";
export interface Result { name: string; verdict: Verdict; detail: string }

const list = (dir: string, kind: "fixtures" | "programs") => readdirSync(dir).filter(f => f.endsWith(".milo"))
  .map(f => ({ path: join(dir, f), name: f.slice(0, -5), kind }))
  .filter(p => !filter || new RegExp(filter).test(p.name)).sort((a, b) => (a.name < b.name ? -1 : 1));

export async function compareOne(p: { path: string; name: string; kind: "fixtures" | "programs" }, cwd: string): Promise<Result> {
  const src = readFileSync(p.path, "utf-8");
  const flags = /^\/\/ @mlir-same-flags:(.*)$/m.exec(src)?.[1]?.trim().split(/\s+/) ?? [];
  if (existsSync(p.path.replace(/\.milo$/, ".c"))) return { name: p.name, verdict: "unsupported", detail: "companion C file" };
  const gpath = join(GOLDEN, p.kind, `${p.name}.json`);
  let want: { code: number | null; signal: string | null; stdout: string; live: string | null };
  if (existsSync(gpath)) {
    const g = JSON.parse(readFileSync(gpath, "utf-8"));
    want = { code: g.code, signal: g.signal ?? null, stdout: g.stdout, live: g.live?.o0 ?? null };
  } else {
    const lines = [...src.matchAll(/^\/\/ @expect: ?(.*)$/gm)].map(m => m[1]!);
    if (!lines.length) return { name: p.name, verdict: "no-oracle", detail: "no golden and no @expect lines" };
    want = { code: 0, signal: null, stdout: lines.join("\n") + "\n", live: null };
  }
  const r = await guardedRun("bun", ["run", MAIN, "interp", p.path, "--live", ...flags], { timeoutMs: TIMEOUT_MS, cwd });
  const m = /^interp: (unsupported|stuck at)[^\n]*/m.exec(r.stderr);
  if (m?.[1] === "unsupported") return { name: p.name, verdict: "unsupported", detail: m[0].replace(/^interp: unsupported: /, "") };
  if (m) return { name: p.name, verdict: "differ", detail: m[0] };
  const crash = /^(\w*Error: [^\n]*)/m.exec(r.stderr); // a JS exception: an interpreter bug, never a pass
  if (crash) return { name: p.name, verdict: "differ", detail: `interpreter crash: ${crash[1]}` };
  if (r.guardKill || r.signal === "SIGKILL" || r.signal === "SIGTERM") return { name: p.name, verdict: "unsupported", detail: `too slow or too big: killed after ${TIMEOUT_MS / 1000}s or by the memory guard` };
  if (r.code === 1 && !r.stdout && /error/.test(r.stderr) && !/live blocks/.test(r.stderr)) return { name: p.name, verdict: "unsupported", detail: `frontend: ${r.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n")[0]}` };
  const live = /interp: live blocks (\S+)/.exec(r.stderr)?.[1] ?? null;
  const aborted = want.signal === "SIGABRT";
  const code = aborted ? 134 : want.code;
  if (r.stdout !== want.stdout) return { name: p.name, verdict: "differ", detail: `stdout:\n  golden ${JSON.stringify(want.stdout.slice(0, 300))}\n  interp ${JSON.stringify(r.stdout.slice(0, 300))}` };
  if (r.code !== code) return { name: p.name, verdict: "differ", detail: `exit golden ${code}, interp ${r.code}` };
  if (!aborted && want.live !== null && live !== want.live) return { name: p.name, verdict: "differ", detail: `live blocks: golden ${want.live}, interp ${live}` };
  return { name: p.name, verdict: "same", detail: "" };
}

if (import.meta.main) {
  const programs = list(join(ROOT, "mlir", "test", "programs"), "programs");
  const all = argv.includes("--programs") ? programs : [...programs, ...list(join(ROOT, "tests", "fixtures"), "fixtures")];
  const tmp = mkdtempSync(join(tmpdir(), "milo-interp-"));
  const results: Result[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < all.length) results.push(await compareOne(all[next++]!, tmp));
  }));
  rmSync(tmp, { recursive: true, force: true });
  const n = (v: Verdict) => results.filter(r => r.verdict === v).length;
  for (const r of results.filter(r => r.verdict === "differ").sort((a, b) => (a.name < b.name ? -1 : 1))) console.log(`DIFFER ${r.name}: ${r.detail}`);
  if (argv.includes("--list")) for (const r of results.filter(r => r.verdict === "unsupported").sort((a, b) => (a.name < b.name ? -1 : 1))) console.log(`UNSUPPORTED ${r.name}: ${r.detail}`);
  if (argv.includes("--why")) {
    const why = new Map<string, number>();
    for (const r of results) if (r.verdict === "unsupported") why.set(r.detail, (why.get(r.detail) ?? 0) + 1);
    for (const [d, c] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${d}`);
  }
  const compared = n("same") + n("differ");
  console.log(`interp-vs-golden: ${n("same")} same, ${n("differ")} differ, ${n("unsupported")} unsupported, ${n("no-oracle")} no oracle (of ${all.length})`);
  if (compared === 0) { console.error("interp-vs-golden: nothing compared"); process.exit(1); }
  process.exit(n("differ") > 0 ? 1 : 0);
}
