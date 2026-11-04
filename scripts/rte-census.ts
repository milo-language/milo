// Silver-progress number: `milo prove --rte` over examples/embedded and std, tallied per
// runtime-error site and kind (overflow / bounds / division) as proven / failed / unknown(+error).
// Usage: bun scripts/rte-census.ts [--solver=z3|std] [files or dirs...]
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const solver = args.find(a => a.startsWith("--solver="));
const targets = args.filter(a => !a.startsWith("--"));
const useZ3 = solver ? solver === "--solver=z3" : true;

const files: string[] = [];
for (const t of targets.length ? targets : ["examples/embedded", "std"]) {
  const p = join(ROOT, t);
  if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) { if (f.endsWith(".milo")) files.push(join(p, f)); }
  else files.push(p);
}

const KINDS = ["overflow", "bounds", "division"] as const;
const tally: Record<string, { proven: number; failed: number; unknown: number }> =
  Object.fromEntries(KINDS.map(k => [k, { proven: 0, failed: 0, unknown: 0 }]));
let broken = 0;

function prove(file: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn("bun", [join(ROOT, "src/main.ts"), "prove", file, "--rte", "--json", ...(useZ3 ? ["--solver=z3"] : [])], { cwd: ROOT, env: { ...process.env, MILO_ROOT: ROOT } });
    let out = "";
    child.stdout.on("data", d => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++]!;
    try {
      const report = JSON.parse(await prove(file));
      // The walker emits one VC per path through a site, so a site below N branches yields
      // many. Count each source site once, at its worst verdict. An error is not a proof:
      // it counts with unknown.
      const sites = new Map<string, { kind: string; rank: number }>();
      for (const o of report.obligations) {
        if (!tally[o.kind]) continue;
        const rank = o.status === "proven" ? 0 : o.status === "failed" ? 2 : 1;
        const key = `${o.kind}|${o.description}`;
        const prev = sites.get(key);
        if (!prev || rank > prev.rank) sites.set(key, { kind: o.kind, rank });
      }
      for (const { kind, rank } of sites.values()) tally[kind]![["proven", "unknown", "failed"][rank] as "proven"]++;
    } catch {
      broken++;
      console.error(`no report: ${file.replace(ROOT + "/", "")}`);
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

console.log(`rte census (${useZ3 ? "z3" : "std/smt"}), ${files.length} files, ${broken} without a report`);
console.log("kind       proven  failed  unknown");
const total = { proven: 0, failed: 0, unknown: 0 };
for (const k of KINDS) {
  const t = tally[k]!;
  console.log(`${k.padEnd(10)} ${String(t.proven).padStart(6)} ${String(t.failed).padStart(7)} ${String(t.unknown).padStart(8)}`);
  total.proven += t.proven; total.failed += t.failed; total.unknown += t.unknown;
}
console.log(`${"total".padEnd(10)} ${String(total.proven).padStart(6)} ${String(total.failed).padStart(7)} ${String(total.unknown).padStart(8)}`);
