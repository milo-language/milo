// Static contract gate: run `milo prove` over every contract-bearing .milo in
// std/ and examples/ and FAIL if any contract is *refuted* (the solver found a
// counterexample proving it false). This is a pure compile-time check — no code
// runs, the prover discharges requires/ensures/invariant against the SMT theory.
//
// `unknown` and translator `errors` are reported but do NOT fail the gate: they are
// solver/translator limitations, not contract violations. `unknown` covers two distinct
// causes — nonlinear/bitwise terms the native QF_LIA solver can't decide, and constructs
// the SMT translator has no rule for at all (the per-VC detail says which). Only a `failed` verdict — a proven-false
// contract — breaks the build. That is the guarantee the prover can give today,
// and it can never regress silently: break a provable contract and this goes red.
//
// Run standalone:  bun scripts/verify-contracts.ts   (compiles its own miloc)
// Reused by:       tests/verify-contracts.test.ts     (runs under `bun test` + CI)
import { readdirSync, statSync, readFileSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { guardedRun } from "./guard";
import { BASELINE } from "./verify-contracts.baseline";
import { EXPECTED } from "./verify-contracts.expected";

const ROOT = join(import.meta.dir, "..");
const CONTRACT_RE = /^[ \t]*(requires|ensures|invariant)\b/m;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".milo")) out.push(p);
  }
  return out;
}

// Skip the stdlib platform variant that isn't ours — its imports won't resolve
// on this host, which would surface as spurious translator errors.
function hostSkip(p: string): boolean {
  const other = process.platform === "darwin" ? ".linux." : ".darwin.";
  return p.includes(other);
}

// A `requires` is discharged at the CALL SITE, not in the body that declares it — so a
// file is only as covered as the set of files proved alongside it. The default filter
// (does this file itself contain a contract?) therefore misses every CALLER: pass a
// 16-byte key to `aesGcmEncrypt` from an example with no contracts of its own and nothing
// checks it. MILO_VERIFY_ALL=1 proves every .milo instead, which is what makes call-site
// coverage real; it costs a full prove run over ~140 files, so CI uses the filter and this
// is the periodic audit.
export function contractFiles(): string[] {
  const files: string[] = [];
  for (const r of ["std", "examples"]) walk(join(ROOT, r), files);
  const all = process.env.MILO_VERIFY_ALL === "1";
  return files
    .filter(p => !hostSkip(p))
    .filter(p => all || CONTRACT_RE.test(readFileSync(p, "utf-8")))
    .sort();
}

interface Refutation {
  fn: string;       // the refuted function
  key: string;      // "<file>::<fn>" — baseline lookup key
  line: string;     // the raw ✗ counterexample line, for reporting
}

export interface FileResult {
  file: string;
  proven: number;
  failed: number;
  unknown: number;
  errors: number;
  refutations: Refutation[];
  conditional: number; // proofs that assumed a callee postcondition nothing established
  noReport: boolean;   // prove printed no tally (compile failure etc.)
}

// Solver for the gate. z3 discharges nonlinear/bitwise contracts the native
// QF_LIA prover can only mark `unknown`; the native prover needs no external
// dependency. Default to z3 when it's on PATH (CI installs it), else native.
function gateSolver(): "z3" | "native" {
  if (process.env.MILO_VERIFY_SOLVER === "native") return "native";
  if (process.env.MILO_VERIFY_SOLVER === "z3") return "z3";
  const which = Bun.spawnSync(["which", "z3"]);
  return which.exitCode === 0 ? "z3" : "native";
}

export async function proveFile(miloc: string, file: string, solver = gateSolver()): Promise<FileResult> {
  const args = solver === "z3" ? ["prove", file, "--solver=z3"] : ["prove", file];
  // MILO_ROOT is not optional here: the gate runs a miloc compiled into a tmpdir, so the
  // binary has no repo to resolve `std/` against and every file that imports another std
  // module dies at `cannot open 'std/os'`. That surfaced as noReport — the file was simply
  // not checked — which is how a REFUTED contract in std/mem.milo sat unnoticed behind a
  // gate whose whole job is to catch exactly that. A gate that silently skips its inputs
  // is worse than no gate, because it reports success.
  const r = await guardedRun(miloc, args, { timeoutMs: 120000, env: { ...process.env, MILO_ROOT: ROOT } });
  const out = (r.stdout + "\n" + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const m = out.match(/proven:\s*(\d+)\s+failed:\s*(\d+)\s+unknown:\s*(\d+)\s+errors:\s*(\d+)/);
  const rel = file.replace(ROOT + "/", "");
  const refutations: Refutation[] = out.split("\n")
    .filter(l => /✗.*failed/.test(l))
    .map(l => {
      // Include '.' so method contracts like `Arena.remaining` capture in full;
      // without it the regex fails outright on the dot and the key degrades to '?'.
      const fnM = l.match(/✗\s*\[[^\]]+\]\s*([A-Za-z0-9_.]+)\s*:/);
      const fn = fnM ? fnM[1] : "?";
      return { fn, key: `${rel}::${fn}`, line: l.trim() };
    });
  const cond = out.match(/(\d+) of \d+ proofs are conditional/);
  if (!m) return { file: rel, proven: 0, failed: 0, unknown: 0, errors: 0, refutations, conditional: 0, noReport: true };
  return {
    file: rel,
    proven: +m[1], failed: +m[2], unknown: +m[3], errors: +m[4],
    refutations, conditional: cond ? +cond[1] : 0, noReport: false,
  };
}

async function verifyAll(miloc: string): Promise<FileResult[]> {
  // Serial: prove is CPU-bound and guardedRun already caps memory; parallel runs
  // would fight over the same budget on CI's small runners.
  const solver = gateSolver();
  const results: FileResult[] = [];
  for (const f of contractFiles()) results.push(await proveFile(miloc, f, solver));
  return results;
}

export interface Gate {
  proven: number;
  refuted: number;
  unexpected: Refutation[]; // refutations NOT in the baseline — these fail the gate
  stale: string[];          // baseline keys no longer refuted — should be removed
  regressions: string[];    // files that lost a proof or gained an unknown/error — these fail the gate
  gains: string[];          // movement the good way — update EXPECTED to lock it in
  untracked: string[];      // proved but absent from EXPECTED
  ok: boolean;
}

// Compare one file's verdicts against its ratchet.
//
// `proven` is a floor and `errors` a ceiling; both gate. `unknown` is REPORTED ONLY, and
// that is a deliberate correction: a rising unknown count has two causes that look
// identical in the tally — a contract that stopped being discharged (bad) and obligations
// that only just became visible (good, and exactly what fixing the translator does). The
// first already trips the `proven` floor, because a contract that degrades from proven to
// unknown takes the proven count down with it. Gating on unknown therefore adds no
// detection, only false alarms every time coverage improves.
function ratchet(r: FileResult, out: { regressions: string[]; gains: string[]; untracked: string[] }): void {
  // No tally at all means prove never got as far as a verdict (compile failure, guard
  // kill). Every count reads 0, which would sail through a 0-floor — the one case where
  // silence has to be loud.
  if (r.noReport) {
    out.regressions.push(`${r.file}: prove produced no report (compile failure or guard kill)`);
    return;
  }
  const e = EXPECTED[r.file];
  if (!e) {
    out.untracked.push(r.file);
    return;
  }
  if (r.proven < e.proven) out.regressions.push(`${r.file}: proven ${r.proven} < ${e.proven} — a contract stopped being provable`);
  if (r.errors > e.errors) out.regressions.push(`${r.file}: errors ${r.errors} > ${e.errors} — new translator/solver error`);
  if (r.proven !== e.proven || r.unknown !== e.unknown || r.errors !== e.errors) {
    out.gains.push(`${r.file}: ${e.proven}/${e.unknown}/${e.errors} -> ${r.proven}/${r.unknown}/${r.errors} (proven/unknown/errors)`);
  }
}

export function report(results: FileResult[]): Gate {
  const pad = (s: string, n: number) => s.padEnd(n);
  let tP = 0, tF = 0, tU = 0, tE = 0, tC = 0;
  const allRefs: Refutation[] = [];
  const ratch = { regressions: [] as string[], gains: [] as string[], untracked: [] as string[] };
  console.log(`contract gate — solver: ${gateSolver()}\n`);
  console.log(pad("FILE", 44) + "proven  failed  unknown  errors");
  for (const r of results) {
    tP += r.proven; tF += r.failed; tU += r.unknown; tE += r.errors; tC += r.conditional;
    allRefs.push(...r.refutations);
    ratchet(r, ratch);
    const flag = r.failed > 0 ? " ✗" : r.noReport ? " (no report)" : "";
    console.log(
      pad(r.file, 44) +
      `${pad(String(r.proven), 8)}${pad(String(r.failed), 8)}${pad(String(r.unknown), 9)}${String(r.errors)}${flag}`
    );
    for (const ref of r.refutations) {
      const tag = BASELINE[ref.key] ? " [baselined]" : " [NEW]";
      console.log("      " + ref.line + tag);
    }
  }
  console.log("-".repeat(72));
  console.log(pad("TOTAL", 44) + `${pad(String(tP), 8)}${pad(String(tF), 8)}${pad(String(tU), 9)}${String(tE)}`);

  const unexpected = allRefs.filter(ref => !BASELINE[ref.key]);
  const seen = new Set(allRefs.map(ref => ref.key));
  const stale = Object.keys(BASELINE).filter(k => !seen.has(k));

  console.log(
    `\n${tP} proven, ${tF} refuted (${allRefs.length - unexpected.length} baselined, ` +
    `${unexpected.length} new), ${tU} unknown (solver limit or untranslatable), ${tE} translator errors.`
  );
  // Modular verification lets a proof assume its callees' postconditions. When one of those
  // was never established, the proof is real only if the assumption is — so the headline
  // "proven" number overstates what is actually settled, and by how much belongs in the
  // report rather than in a footnote nobody reads.
  if (tC > 0) {
    console.log(
      `${tC} of those ${tP} proofs are CONDITIONAL: they assume a callee's \`ensures\` that ` +
      `this run could not establish (usually a postcondition sitting behind an untranslatable body).`
    );
  }
  if (unexpected.length) {
    console.log("\nNEW refuted contracts (gate FAIL) — the prover found a counterexample:");
    for (const ref of unexpected) console.log("  " + ref.line);
  }
  if (stale.length) {
    console.log("\nStale baseline entries (now provable — remove from verify-contracts.baseline.ts):");
    for (const k of stale) console.log("  " + k);
  }
  if (ratch.regressions.length) {
    console.log("\nPROOF REGRESSIONS (gate FAIL) — the contract text is unchanged, what backs it is not:");
    for (const s of ratch.regressions) console.log("  " + s);
  }
  if (ratch.gains.length) {
    console.log("\nVerdict drift (run with --update to lock these in):");
    for (const s of ratch.gains) console.log("  " + s);
  }
  if (ratch.untracked.length) {
    console.log("\nNot in the ratchet (add to verify-contracts.expected.ts):");
    for (const s of ratch.untracked) console.log("  " + s);
  }
  // Stale entries don't fail the gate (a fix shouldn't go red), but new
  // refutations do. Stale is surfaced loudly so the baseline gets pruned.
  return {
    proven: tP, refuted: tF, unexpected, stale,
    regressions: ratch.regressions, gains: ratch.gains, untracked: ratch.untracked,
    ok: unexpected.length === 0 && ratch.regressions.length === 0,
  };
}

// Rewrite the ratchet from a run. Comments in the hand-written file are lost, so this
// prints the block for review rather than clobbering the file.
function renderExpected(results: FileResult[]): string {
  const rows = results
    .filter(r => !r.noReport)
    .map(r => `  "${r.file}": { proven: ${r.proven}, unknown: ${r.unknown}, errors: ${r.errors} },`);
  return `export const EXPECTED: Record<string, Expected> = {\n${rows.join("\n")}\n};`;
}

// Standalone CLI entry.
if (import.meta.main) {
  const toolDir = mkdtempSync(join(tmpdir(), "milo-verifyc-"));
  const miloc = join(toolDir, "miloc");
  console.log("compiling miloc…");
  execSync(`bun build --compile ${join(ROOT, "src", "main.ts")} --outfile ${miloc}`, { stdio: "inherit" });
  const results = await verifyAll(miloc);
  const gate = report(results);
  if (process.argv.includes("--update")) {
    console.log("\n--- verify-contracts.expected.ts ---\n" + renderExpected(results));
    process.exit(0);
  }
  process.exit(gate.ok ? 0 : 1);
}
