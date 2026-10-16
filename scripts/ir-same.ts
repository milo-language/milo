// Byte-identical IR gate: proves a codegen refactor changed no emitted LLVM IR, by emitting
// IR for every fixture and example in both a base commit and the working tree and comparing
// the bytes.
//
//   bun scripts/ir-same.ts                       # working tree vs main
//   bun scripts/ir-same.ts --base HEAD~1         # vs any git ref
//   bun scripts/ir-same.ts --filter hashmap      # only paths containing the substring
//   bun scripts/ir-same.ts --jobs 2              # concurrency (default 4)
//   bun scripts/ir-same.ts --flags "-g --target x86_64-pc-windows-msvc"   # extra emit-ir args
//
// emit-ir's defaults never reach the codegen behind -g, --sanitize, --contract-checks,
// --no-overflow-checks or a non-host target, so a full gate is one default pass plus the
// variant passes listed in docs/plans/codegen-ir-2026-10.md.
//
// Why a separate script from ir-diff.ts: that one compares milo-self against the TS compiler,
// where differences are expected. Here the two sides are the same compiler at two commits, so
// ANY difference is a behavior change, and "N/N byte-identical" is the whole verdict.
//
// The base side is a detached worktree of the resolved commit under os.tmpdir(), and its
// outputs are cached by commit sha (a commit's output never changes), so a rerun in the edit
// loop only re-emits the working tree. A file that fails emit-ir must fail on both sides; a
// file that compiles on one side only is a difference. Zero files compared is a failure: a
// gate that checks nothing must not pass.
//
// Every emit runs under guardedRun (scripts/guard.ts), at most `jobs` at a time, with the
// per-emit cap sized so jobs x cap stays within half of RAM (the guard.ts budget).
//
// Exit: 0 all identical, 1 a difference (or nothing compared), 2 aborted with no verdict
// (one file kept getting guard-killed; MILO_IR_SAME_TIMEOUT_MS=1 forces that path).
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir, totalmem } from "os";
import { dirname, join, relative } from "path";
import { spawnSync } from "child_process";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
// Address space only (RLIMIT_AS, enforced on Linux): bun reserves a large sparse heap at
// startup and dies under a tight one. RSS and footprint stay capped at MEM_MB.
const SPARSE_VM_MB = 64 * 1024 * 1024;
// Overridable so the guard-kill path can be exercised (a 1 ms timeout kills every emit).
const TIMEOUT_MS = Number(process.env.MILO_IR_SAME_TIMEOUT_MS || 0) || 180_000;
// A guard kill is about the machine (memory pressure from other jobs), not the compiler, so
// the file is re-emitted; only a file killed this many times in a row aborts the pass.
const GUARD_TRIES = 3;
const MAX_DETAILED = 20;
const DIFF_LINES = 10;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const baseRef = arg("--base") ?? "main";
const filter = arg("--filter");
const flags = (arg("--flags") ?? "").split(/\s+/).filter(Boolean);
const jobs = Math.max(1, Number(arg("--jobs") ?? 4) || 4);
// The largest example (examples/games/flight) peaks near 700MB alone and was footprint-killed
// at 1536MB under parallel load, so the cap takes the whole per-job share of the budget.
const MEM_MB = Math.min(3072, Math.floor(totalmem() / (1024 * 1024) / 2 / jobs));

function git(args: string[], cwd = ROOT): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() + (r.status === 0 ? "" : (r.stderr ?? "")) };
}

const rev = git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
if (!rev.ok) {
  console.error(`ir-same: cannot resolve base ref '${baseRef}': ${rev.out}`);
  process.exit(1);
}
const sha = rev.out;
const short = sha.slice(0, 12);
const baseTree = join(tmpdir(), `milo-ir-same-${short}`);
// Keyed by flags too: the same commit emits different IR under -g or another target.
// The ledger env vars change the IR the same way (emit-ir inherits this env).
const keyParts = [...flags, ...["MILO_OWN_LEDGER", "MILO_OWN_LEDGER_KEEP"].filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`)];
const flagKey = keyParts.length ? "-" + Bun.hash(keyParts.join(" ")).toString(16) : "";
const cacheDir = join(tmpdir(), `milo-ir-same-cache-${sha}${flagKey}`);

// A base costs ~1.8GB of cache per flag set, and main moves several times a day: unpruned,
// tmp reached 35GB in one day and a pass died with ENOSPC. Keep the current base plus the
// most recently used others, so another session gating against an older base keeps its cache.
const KEEP_OTHER_BASES = 2;

function pruneOldBases(): void {
  const dir = tmpdir();
  const entries = readdirSync(dir).flatMap(name => {
    const m = /^milo-ir-same-(?:cache-)?([0-9a-f]{12})/.exec(name);
    return m ? [{ name, short: m[1], mtime: statSync(join(dir, name)).mtimeMs }] : [];
  });
  const lastUsed = new Map<string, number>();
  for (const e of entries) lastUsed.set(e.short, Math.max(lastUsed.get(e.short) ?? 0, e.mtime));
  lastUsed.delete(short);
  const keep = new Set([short, ...[...lastUsed].sort((a, b) => b[1] - a[1]).slice(0, KEEP_OTHER_BASES).map(([s]) => s)]);
  for (const e of entries) {
    if (keep.has(e.short)) continue;
    const p = join(dir, e.name);
    // Base trees are worktrees of this repo: remove through git so its metadata goes too.
    if (!e.name.includes("-cache-") && git(["worktree", "remove", "--force", p]).ok) continue;
    rmSync(p, { recursive: true, force: true });
  }
  git(["worktree", "prune"]);
}

function ensureBaseTree(): void {
  if (existsSync(baseTree) && git(["rev-parse", "HEAD"], baseTree).out === sha) return;
  // A worktree whose directory the OS tmp cleaner removed is still registered; prune it
  // or `worktree add` refuses the path.
  git(["worktree", "prune"]);
  if (existsSync(baseTree)) git(["worktree", "remove", "--force", baseTree]);
  const add = git(["worktree", "add", "--detach", baseTree, sha]);
  if (!add.ok) {
    console.error(`ir-same: git worktree add failed: ${add.out}`);
    process.exit(1);
  }
}

function listMilo(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...listMilo(p, true));
    else if (e.isFile() && e.name.endsWith(".milo")) out.push(p);
  }
  return out;
}

function corpus(tree: string): Set<string> {
  const files = [...listMilo(join(tree, "tests", "fixtures"), false), ...listMilo(join(tree, "examples"), true)];
  return new Set(files.map(f => relative(tree, f)).filter(f => !filter || f.includes(filter)));
}

type Emit = { ok: true; ir: string } | { ok: false; err: string };

async function emit(tree: string, rel: string): Promise<Emit> {
  // Each tree must resolve std from itself, so an inherited MILO_ROOT is dropped.
  const env = { ...process.env };
  delete env.MILO_ROOT;
  let r;
  for (let attempt = 1; ; attempt++) {
    r = await guardedRun("bun", ["run", "src/main.ts", "emit-ir", ...flags, rel], { cwd: tree, env, memMb: MEM_MB, virtualMemMb: SPARSE_VM_MB, timeoutMs: TIMEOUT_MS });
    if (!r.guardKill) break;
    // A guard kill says nothing about the compiler, so it must not read as "fails on this
    // side" (which could match the other side's genuine failure and pass the gate).
    console.error(`ir-same: guard killed emit-ir ${rel} in ${tree} (${r.guardKill}), attempt ${attempt}/${GUARD_TRIES}`);
    if (attempt === GUARD_TRIES) {
      // Exit here, not throw: an uncaught throw out of the pool printed only a stack and
      // Bun's banner, with no summary line saying the pass did not finish.
      console.log(`ir-same: ABORTED, ${rel} guard-killed ${GUARD_TRIES} times (${r.guardKill}); no verdict, rerun when the machine is idle`);
      process.exit(2);
    }
  }
  return r.code === 0 ? { ok: true, ir: r.stdout } : { ok: false, err: r.stderr.split("\n").find(l => l.trim()) ?? `exit ${r.code}` };
}

// -g writes each tree's absolute path into DIFile records, so the two sides can only agree
// once their roots are spelled the same. Realpath too: tmpdir() is /var/... and resolves
// to /private/var/... in what the compiler prints.
function normalizeRoot(ir: string, tree: string): string {
  for (const p of new Set([realpathSync(tree), tree])) ir = ir.split(p).join("<ROOT>");
  return ir;
}

async function emitBase(rel: string): Promise<Emit> {
  const ll = join(cacheDir, rel + ".ll");
  const fail = join(cacheDir, rel + ".fail");
  if (existsSync(ll)) return { ok: true, ir: readFileSync(ll, "utf-8") };
  if (existsSync(fail)) return { ok: false, err: readFileSync(fail, "utf-8") };
  const e = await emit(baseTree, rel);
  mkdirSync(dirname(ll), { recursive: true });
  // Write then rename: two passes on the same base sha share this cache, and a reader must
  // never see a half-written .ll (it would read as a spurious diff).
  const [dest, text] = e.ok ? [ll, e.ir] : [fail, e.err];
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, dest);
  return e;
}

async function pool<T>(items: T[], n: number, work: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

function firstDiff(a: string, b: string): string {
  const al = a.split("\n"), bl = b.split("\n");
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  const out = [`    first difference at line ${i + 1} (base ${al.length} lines, work ${bl.length} lines)`];
  for (const l of al.slice(i, i + DIFF_LINES)) out.push(`    - ${l}`);
  for (const l of bl.slice(i, i + DIFF_LINES)) out.push(`    + ${l}`);
  return out.join("\n");
}

pruneOldBases();
ensureBaseTree();
const work = corpus(ROOT);
const base = corpus(baseTree);
const both = [...work].filter(f => base.has(f)).sort();
const onlyWork = [...work].filter(f => !base.has(f));
const onlyBase = [...base].filter(f => !work.has(f));

let identical = 0, bothFail = 0;
const diffs: { rel: string; detail: string }[] = [];
const t0 = Date.now();
await pool(both, jobs, async rel => {
  // Sequential within a slot, so `jobs` really bounds the number of live compilers.
  const b = await emitBase(rel);
  const w = await emit(ROOT, rel);
  if (b.ok && w.ok) {
    const bi = normalizeRoot(b.ir, baseTree), wi = normalizeRoot(w.ir, ROOT);
    if (bi === wi) identical++;
    else diffs.push({ rel, detail: firstDiff(bi, wi) });
  } else if (!b.ok && !w.ok) {
    bothFail++;
  } else {
    diffs.push({ rel, detail: b.ok ? `    base emits IR, work fails: ${(w as any).err}` : `    base fails (${(b as any).err}), work emits IR` });
  }
});

diffs.sort((x, y) => x.rel.localeCompare(y.rel));
for (const [i, d] of diffs.entries()) {
  if (i < MAX_DETAILED) console.log(`DIFF ${d.rel}\n${d.detail}`);
  else console.log(`DIFF ${d.rel}`);
}
const compared = identical + diffs.length;
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`base ${short} (${baseRef})${flags.length ? `, flags '${flags.join(" ")}'` : ""}, ${both.length} files in both trees, ${bothFail} fail emit-ir in both, ${secs}s`);
if (onlyWork.length || onlyBase.length) console.log(`not compared: ${onlyWork.length} only in working tree, ${onlyBase.length} only in base`);
console.log(`${identical}/${compared} byte-identical`);
if (compared === 0) {
  console.error("ir-same: 0 files compared; a gate that checks nothing fails");
  process.exit(1);
}
process.exit(diffs.length ? 1 : 0);
