// Shared harness of the move and borrow mutation gates: a private tree copy per mutant, its snapshot, the judge.
//
// Used by scripts/move-mutants.ts and scripts/borrow-mutants.ts. Each mutant gets its own copy of src/ and scripts/
// (the tree itself is never touched), the corpus is snapshotted from that copy, and the diagnostics judge kills it.
import { cpSync, readdirSync, readFileSync, symlinkSync } from "fs";
import { join } from "path";

export type Facts = Record<string, { diagnostics?: { severity: string; message: string; hint?: string }[]; moved?: string[]; shared?: string[]; sharedCaptures?: string[]; thrown?: unknown }>;

export const ROOT = join(import.meta.dir, "..");

// A root that shares everything with the checkout except src/ and scripts/, which are private copies
// (the binary judge compiles with the src/ next to its script).
export function makeRoot(scratch: string, name: string): string {
  const root = join(scratch, name);
  for (const d of ["src", "scripts"]) cpSync(join(ROOT, d), join(root, d), { recursive: true });
  for (const e of readdirSync(ROOT)) if (e !== "src" && e !== "scripts" && e !== ".git") symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

export async function snapshot(root: string, out: string, jobs: string | undefined, withFacts: boolean): Promise<Facts> {
  const p = Bun.spawn(["bun", join(ROOT, "scripts/checker-diag-snapshot.ts"), root, out, ...(withFacts ? ["--facts"] : []), ...(jobs ? ["--jobs", jobs] : [])], { stdout: "ignore", stderr: "inherit" });
  if (await p.exited !== 0) throw new Error(`snapshot failed for ${root}`);
  const raw = JSON.parse(readFileSync(out, "utf-8")) as Record<string, unknown>;
  // Without --facts a program's entry is its bare diagnostics array.
  for (const f of Object.keys(raw)) if (Array.isArray(raw[f])) raw[f] = { diagnostics: raw[f] };
  return raw as Facts;
}

export const errorsOf = (f: Facts[string] | undefined) => (f?.diagnostics ?? []).filter(d => d.severity === "error");

// The diagnostics verdict: why the mutant is killed, or "" when no error test lost its text and no accepted program gained an error.
export function diagKill(base: Facts, got: Facts): string {
  for (const f of Object.keys(base)) {
    const b = base[f], g = got[f];
    if (f.startsWith("tests/errors/")) {
      const want = (readFileSync(join(ROOT, f), "utf-8").match(/\/\/ @error: (.*)/) ?? [])[1]?.trim();
      if (want === undefined) continue;
      const before = errorsOf(b).some(d => `${d.message} ${d.hint ?? ""}`.includes(want));
      const after = errorsOf(g).some(d => `${d.message} ${d.hint ?? ""}`.includes(want));
      if (before && !after) return `${f} no longer reports '${want.slice(0, 60)}'`;
      continue;
    }
    if (errorsOf(b).length === 0 && (errorsOf(g).length > 0 || g?.thrown !== undefined)) return `${f} is now rejected: ${errorsOf(g)[0]?.message.slice(0, 80) ?? "crash"}`;
  }
  return "";
}
