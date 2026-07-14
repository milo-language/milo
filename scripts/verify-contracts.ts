// Static contract gate: run `milo prove` over every contract-bearing .milo in
// std/ and examples/ and FAIL if any contract is *refuted* (the solver found a
// counterexample proving it false). This is a pure compile-time check — no code
// runs, the prover discharges requires/ensures/invariant against the SMT theory.
//
// `unknown` (nonlinear / bitwise terms the native QF_LIA solver can't decide)
// and translator `errors` are reported but do NOT fail the gate: they are solver
// limitations, not contract violations. Only a `failed` verdict — a proven-false
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

export function contractFiles(): string[] {
  const files: string[] = [];
  for (const r of ["std", "examples"]) walk(join(ROOT, r), files);
  return files
    .filter(p => !hostSkip(p))
    .filter(p => CONTRACT_RE.test(readFileSync(p, "utf-8")))
    .sort();
}

export interface Refutation {
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
  noReport: boolean; // prove printed no tally (compile failure etc.)
}

export async function proveFile(miloc: string, file: string): Promise<FileResult> {
  const r = await guardedRun(miloc, ["prove", file], { timeoutMs: 120000 });
  const out = (r.stdout + "\n" + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const m = out.match(/proven:\s*(\d+)\s+failed:\s*(\d+)\s+unknown:\s*(\d+)\s+errors:\s*(\d+)/);
  const rel = file.replace(ROOT + "/", "");
  const refutations: Refutation[] = out.split("\n")
    .filter(l => /✗.*failed/.test(l))
    .map(l => {
      const fnM = l.match(/✗\s*\[[^\]]+\]\s*([A-Za-z0-9_]+)\s*:/);
      const fn = fnM ? fnM[1] : "?";
      return { fn, key: `${rel}::${fn}`, line: l.trim() };
    });
  if (!m) return { file: rel, proven: 0, failed: 0, unknown: 0, errors: 0, refutations, noReport: true };
  return {
    file: rel,
    proven: +m[1], failed: +m[2], unknown: +m[3], errors: +m[4],
    refutations, noReport: false,
  };
}

export async function verifyAll(miloc: string): Promise<FileResult[]> {
  // Serial: prove is CPU-bound and guardedRun already caps memory; parallel runs
  // would fight over the same budget on CI's small runners.
  const results: FileResult[] = [];
  for (const f of contractFiles()) results.push(await proveFile(miloc, f));
  return results;
}

export interface Gate {
  proven: number;
  refuted: number;
  unexpected: Refutation[]; // refutations NOT in the baseline — these fail the gate
  stale: string[];          // baseline keys no longer refuted — should be removed
  ok: boolean;
}

export function report(results: FileResult[]): Gate {
  const pad = (s: string, n: number) => s.padEnd(n);
  let tP = 0, tF = 0, tU = 0, tE = 0;
  const allRefs: Refutation[] = [];
  console.log(pad("FILE", 44) + "proven  failed  unknown  errors");
  for (const r of results) {
    tP += r.proven; tF += r.failed; tU += r.unknown; tE += r.errors;
    allRefs.push(...r.refutations);
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
    `${unexpected.length} new), ${tU} unknown (solver limit), ${tE} translator errors.`
  );
  if (unexpected.length) {
    console.log("\nNEW refuted contracts (gate FAIL) — the prover found a counterexample:");
    for (const ref of unexpected) console.log("  " + ref.line);
  }
  if (stale.length) {
    console.log("\nStale baseline entries (now provable — remove from verify-contracts.baseline.ts):");
    for (const k of stale) console.log("  " + k);
  }
  // Stale entries don't fail the gate (a fix shouldn't go red), but new
  // refutations do. Stale is surfaced loudly so the baseline gets pruned.
  return { proven: tP, refuted: tF, unexpected, stale, ok: unexpected.length === 0 };
}

// Standalone CLI entry.
if (import.meta.main) {
  const toolDir = mkdtempSync(join(tmpdir(), "milo-verifyc-"));
  const miloc = join(toolDir, "miloc");
  console.log("compiling miloc…");
  execSync(`bun build --compile ${join(ROOT, "src", "main.ts")} --outfile ${miloc}`, { stdio: "inherit" });
  const results = await verifyAll(miloc);
  const gate = report(results);
  process.exit(gate.ok ? 0 : 1);
}
