// `milo harden <file|dir> [--write]`: rewrite code into stricter, more canonical Milo.
//
// The analyses (src/harden-rewrites.ts) only propose edits. This file is the gate that
// decides which proposals survive, per file:
//   1. the hardened source type-checks (a failing site is dropped on its own);
//   2. for a file with a `main` the reference interpreter runs, stdout and exit code equal
//      the original's (a differing site is dropped on its own);
//   3. a second harden run proposes nothing that survives 1 and 2.
// A file without a `main` (a library) has nothing for 2 to run, so its @req tests (the ones
// `milo trace` finds) stand in: they must pass before, and the same ones after.
// A file whose edits cannot all pass is never written; the dropped sites are reported
// because each one means an analysis proposed something unsound.
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker } from "./checker";
import { resolveImports } from "./resolver";
import { getHostTarget } from "./target";
import { ParseError } from "./diagnostics";
import { applyEdits } from "./fixes";
import { reqTests, runTestsChild, type TraceDeps } from "./requirements";
import { findSites, REWRITES, type RewriteName, type Site } from "./harden-rewrites";

const MAIN = join(import.meta.dir, "main.ts");
const INTERP_TIMEOUT_MS = 20000;
const MAX_ROUNDS = 4;

export interface Rejected { rewrite: RewriteName; line: number; reason: string; before: string; after: string }
export interface FileResult {
  file: string;
  status: "ok" | "skipped" | "failed";
  note?: string;
  accepted: { rewrite: RewriteName; line: number }[];
  rejected: Rejected[];
  // "verified": interpreter stdout + exit code equal. Otherwise why it was not compared.
  behaviour: "verified" | "none" | string;
  diff: string;
  newSource?: string;
}

// The seams a test uses: a stub runner, and a rewriter that is wrong on purpose.
export interface HardenOpts { runTests?: TraceDeps["runTests"]; rewrite?: (src: string, sites: Site[]) => string }

const NO_TESTS = "unverified: library has no @req tests, only the type-check gated it";

interface Checked { errors: string[]; sites: Site[]; hasMain: boolean }

// Type-check `source` as if it were the file at `path` (so its relative imports resolve),
// and, when asked, find the rewrite candidates in it.
function check(path: string, source: string, analyse: boolean): Checked {
  try {
    let program = new Parser(new Lexer(source).tokenize(), source, path).parse();
    program = resolveImports(program, dirname(resolve(path)), getHostTarget(), path);
    const tc = new TypeChecker(undefined);
    const result = tc.check(program);
    const errors = result.diagnostics.filter(d => d.severity === "error").map(d => d.message);
    const hasMain = program.functions.some(f => f.name === "main" && f.span?.file === path);
    if (errors.length > 0 || !analyse) return { errors, sites: [], hasMain };
    const { host, view } = tc.analysisFacts(program);
    return { errors, sites: findSites(program, host, view, path, source), hasMain };
  } catch (e) {
    if (e instanceof ParseError) return { errors: [e.diagnostic.message], sites: [], hasMain: false };
    return { errors: [`internal: ${e instanceof Error ? e.message : String(e)}`], sites: [], hasMain: false };
  }
}

interface Run { code: number | null; stdout: string }

// Runs `source` in the interpreter from a sibling file (imports and the program's own
// directory resolve as they do for the real one) and removes the copy.
function interp(path: string, source: string): Run {
  const tmp = join(dirname(path), `.harden-${process.pid}-${basename(path)}`);
  writeFileSync(tmp, source);
  try {
    const r = spawnSync("bun", ["run", MAIN, "interp", tmp], { encoding: "utf8", timeout: INTERP_TIMEOUT_MS, input: "", maxBuffer: 64 << 20 });
    return { code: r.signal ? null : r.status, stdout: r.stdout ?? "" };
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

const sameRun = (a: Run, b: Run) => a.code === b.code && a.stdout === b.stdout;
const siteText = (src: string, s: Site) => src.slice(s.edits[0]!.offset, s.edits[0]!.offset + Math.max(s.edits[0]!.len, 1)).split("\n")[0]!;
const applyAll = (src: string, sites: Site[]) => applyEdits(src, sites.flatMap(s => s.edits));

export function hardenFile(path: string, write: boolean, opts: HardenOpts = {}): FileResult {
  const apply = opts.rewrite ?? applyAll;
  const original = readFileSync(path, "utf-8");
  const res: FileResult = { file: path, status: "ok", accepted: [], rejected: [], behaviour: "none", diff: "" };
  const first = check(path, original, true);
  if (first.errors.length > 0) return { ...res, status: "skipped", note: `does not check: ${first.errors[0]}` };

  // Baseline interpreter run, taken lazily: only a file with a surviving edit needs one.
  let baseline: Run | null | undefined;
  const base = (): Run | null => {
    if (baseline !== undefined) return baseline;
    const b = interp(path, original);
    if (b.code === null) { res.behaviour = "unverified: interpreter timed out"; return (baseline = null); }
    if (b.code === 3 || b.code === 4) { res.behaviour = `unverified: interpreter ${b.code === 3 ? "unsupported" : "stuck"}`; return (baseline = null); }
    return (baseline = b);
  };
  let behaviourChecked = false;
  const sameBehaviour = (src: string): boolean => {
    if (!first.hasMain) return true;
    const b = base();
    if (!b) return true;
    behaviourChecked = true;
    return sameRun(b, interp(path, src));
  };

  const seen = new Set<string>();
  const reject = (s: Site, src: string, reason: string, after: string) => {
    const key = `${s.rewrite}|${siteText(src, s)}|${after}`;
    if (seen.has(key)) return;
    seen.add(key);
    res.rejected.push({ rewrite: s.rewrite, line: s.line, reason, before: siteText(src, s), after });
  };

  let current = original;
  let currentCheck = first;
  for (let round = 0; ; round++) {
    let sites = currentCheck.sites;
    if (sites.length === 0) break;
    if (round >= MAX_ROUNDS) { return { ...res, status: "failed", note: "not idempotent: still proposing edits after the last round", accepted: [], diff: "" }; }

    // Gate 1: each site alone must type-check; the survivors together must too.
    const typed: Site[] = [];
    for (const s of sites) {
      const c = check(path, apply(current, [s]), false);
      if (c.errors.length > 0) reject(s, current, `type-check: ${c.errors[0]}`, apply(current, [s]).slice(s.edits[0]!.offset, s.edits[0]!.offset + s.edits[0]!.newText.length));
      else typed.push(s);
    }
    let chosen: Site[] = [];
    for (const s of typed) {
      if (check(path, apply(current, [...chosen, s]), false).errors.length === 0) chosen.push(s);
      else reject(s, current, "type-check: fails together with the other edits", "");
    }

    // Gate 2: behaviour. All together first; on a difference, each site on its own.
    if (chosen.length > 0 && !sameBehaviour(apply(current, chosen))) {
      const good = chosen.filter(s => {
        const ok = sameBehaviour(apply(current, [s]));
        if (!ok) reject(s, current, "behaviour: interpreter output differs", "");
        return ok;
      });
      chosen = good.length > 0 && sameBehaviour(apply(current, good)) ? good : [];
      if (good.length > 0 && chosen.length === 0) for (const s of good) reject(s, current, "behaviour: differs when combined", "");
    }
    if (chosen.length === 0) break;

    for (const s of chosen) res.accepted.push({ rewrite: s.rewrite, line: s.line });
    current = apply(current, chosen);
    currentCheck = check(path, current, true);
    if (currentCheck.errors.length > 0) return { ...res, status: "failed", note: `hardened source does not check: ${currentCheck.errors[0]}`, accepted: [], diff: "" };
  }
  if (behaviourChecked && res.behaviour === "none") res.behaviour = "verified";
  if (res.accepted.length > 0 && first.hasMain && res.behaviour === "none") res.behaviour = "unverified";
  if (current === original) return res;

  if (!first.hasMain) {
    const refusal = libraryTests(path, current, opts.runTests ?? runTestsChild, res);
    if (refusal) return { ...res, status: "failed", note: refusal, accepted: [], diff: "" };
  }

  res.newSource = current;
  res.diff = unifiedDiff(path, original, current);
  if (write) writeFileSync(path, current);
  return res;
}

// Runs the library's @req tests on the file as it is, then with `current` written over it (the
// tests import it from disk). The file is restored byte for byte either way; the caller writes
// `current` only after this returns no refusal.
function libraryTests(path: string, current: string, runTests: NonNullable<HardenOpts["runTests"]>, res: FileResult): string | null {
  const tests = reqTests(path);
  if (tests.length === 0) { res.behaviour = NO_TESTS; return null; }
  const byFile = new Map<string, string[]>();
  for (const t of tests) (byFile.get(t.file) ?? byFile.set(t.file, []).get(t.file)!).push(t.name);
  const runAll = (): Map<string, { pass: boolean }> | string => {
    const out = new Map<string, { pass: boolean }>();
    for (const [file, names] of byFile) {
      const r = runTests(file, names);
      if (!r) return `tests in ${basename(file)} do not compile`;
      for (const n of names) if (r.has(n)) out.set(`${basename(file)}:${n}`, r.get(n)!);
    }
    return out;
  };
  const before = runAll();
  if (typeof before === "string") return `${before} before the rewrite; refusing`;
  const red = [...before].find(([, r]) => !r.pass);
  if (red) return `test ${red[0]} fails before the rewrite; refusing to harden on a red baseline`;
  const original = readFileSync(path);
  let after: ReturnType<typeof runAll>;
  try { writeFileSync(path, current); after = runAll(); } finally { writeFileSync(path, original); }
  if (typeof after === "string") return `${after} after the rewrite; rejected`;
  for (const name of before.keys()) {
    const a = after.get(name);
    if (!a) return `test ${name} disappeared after the rewrite; rejected`;
    if (!a.pass) return `test ${name} fails after the rewrite; rejected`;
  }
  res.behaviour = "verified";
  return null;
}

function unifiedDiff(path: string, before: string, after: string): string {
  const a = join(dirname(path), `.harden-a-${process.pid}-${basename(path)}`);
  const b = join(dirname(path), `.harden-b-${process.pid}-${basename(path)}`);
  writeFileSync(a, before); writeFileSync(b, after);
  try {
    return spawnSync("diff", ["-u", "--label", `a/${path}`, "--label", `b/${path}`, a, b], { encoding: "utf8" }).stdout ?? "";
  } finally {
    for (const f of [a, b]) if (existsSync(f)) unlinkSync(f);
  }
}

function collect(target: string): string[] {
  const st = statSync(target);
  if (!st.isDirectory()) return [target];
  const out: string[] = [];
  for (const e of readdirSync(target, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(target, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith(".milo")) out.push(p);
  }
  return out;
}

// One child per file, a few at a time: each file is an independent check-and-interpret job.
async function runPool(files: string[], write: boolean, jobs: number): Promise<FileResult[]> {
  const results: FileResult[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      results[i] = await new Promise<FileResult>(done => {
        const child = spawn("bun", ["run", MAIN, "harden", files[i]!, "--json", ...(write ? ["--write"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", d => { out += d; });
        child.on("close", () => {
          try { done(JSON.parse(out) as FileResult); }
          catch { done({ file: files[i]!, status: "failed", note: "harden crashed", accepted: [], rejected: [], behaviour: "none", diff: "" }); }
        });
      });
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  return results;
}

export async function runHarden(args: string[]): Promise<number> {
  const write = args.includes("--write");
  const json = args.includes("--json");
  const target = args.find(a => !a.startsWith("--"));
  if (!target || !existsSync(target)) { console.error("usage: milo harden <file|dir> [--write]"); return 1; }
  const files = collect(target);
  const single = files.length === 1 && !statSync(target).isDirectory();
  const results = single ? [hardenFile(files[0]!, write)] : await runPool(files, write, 8);
  if (json) { process.stdout.write(JSON.stringify(results[0])); return 0; }

  for (const r of results) if (r.diff) process.stdout.write(r.diff);
  const counts = new Map<RewriteName, number>(REWRITES.map(r => [r, 0]));
  for (const r of results) for (const a of r.accepted) counts.set(a.rewrite, (counts.get(a.rewrite) ?? 0) + 1);
  const changed = results.filter(r => r.diff);
  console.error(`harden: ${results.length} file(s), ${changed.length} changed${write ? " and written" : ""}, ${results.filter(r => r.status === "skipped").length} skipped (do not check standalone)`);
  for (const [name, n] of counts) console.error(`  ${name}: ${n}`);
  const unverified = changed.filter(r => r.behaviour !== "verified");
  if (unverified.length > 0) {
    const why = new Map<string, number>();
    for (const r of unverified) why.set(r.behaviour === "none" ? "no main" : r.behaviour, (why.get(r.behaviour === "none" ? "no main" : r.behaviour) ?? 0) + 1);
    console.error(`  behaviour not compared (type-check and idempotence only): ${unverified.length} changed file(s): ${[...why].map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }
  for (const r of changed) if (r.behaviour === NO_TESTS) console.error(`  NOTE ${r.file}: ${NO_TESTS.replace("unverified: ", "")}`);
  for (const r of results) {
    if (r.status === "failed") console.error(`  FAILED ${r.file}: ${r.note}`);
    for (const j of r.rejected) console.error(`  REJECTED ${r.file}:${j.line} ${j.rewrite}: ${j.reason}`);
  }
  return results.some(r => r.status === "failed") ? 1 : 0;
}
