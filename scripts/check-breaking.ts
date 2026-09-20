// Detects source-level breaks in the public std surface since the last release tag,
// and requires each one to be written up in docs/breaking-changes.md.
//
// Run:  bun run scripts/check-breaking.ts           # report breaks
//       bun run scripts/check-breaking.ts --check   # fail if any is undocumented (CI/test)
//       bun run scripts/check-breaking.ts --since <ref>
//
// std is one flat namespace, so a compat shim for a moved name is impossible and
// docs/breaking-changes.md is the only migration users get (AGENTS.md). Writing that
// entry was a habit nothing enforced: the doc is prose and cannot be generated, but a
// name disappearing or changing shape IS derivable, and this compares the two.
//
// A "break" is a public name that existed at the reference point and no longer does, or
// whose signature changed. The tool asks only that the name appear somewhere in
// docs/breaking-changes.md — it cannot judge whether the migration text is any good.
import { execFileSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// Same shape the parity gate reads.
const EXPORT = /^pub (extern )?(?:fn|struct|enum|type|interface|trait|let|var) ([A-Za-z_][A-Za-z0-9_]*)[^\n]*/gm;

// What a CALLER can observe. Milo has no named arguments, so renaming a parameter — or
// prefixing it `_` to silence an unused warning — cannot break any source, and treating
// it as a break buries the real ones: the first run reported 41 undocumented breaks, of
// which 30 were `forWrite` becoming `_forWrite` and `pub fn` becoming `pub extern fn`.
// Parameter TYPES and the return type are kept, because those do break callers.
function normalizeSignature(sig: string): string {
  return sig
    .replace(/^pub extern /, "pub ")
    .replace(/\(([^)]*)\)/, (_m, params: string) =>
      "(" + params.split(",").map(p => p.includes(":") ? p.slice(p.indexOf(":") + 1).trim() : p.trim()).join(", ") + ")")
    .replace(/\s+/g, " ")
    .trim();
}

interface SurfaceEntry { sig: string; isExtern: boolean }
export interface Surface { [qualifiedName: string]: SurfaceEntry }

function surfaceFrom(files: Map<string, string>): Surface {
  const out: Surface = {};
  for (const [file, src] of files) {
    // A platform arm is one module behind one import path; its names are keyed by the
    // module a user writes, so moving a name between arms is not a break.
    const mod = file.replace(/^std\//, "").replace(/\.(darwin|linux|windows|wasm)\.milo$/, "").replace(/\.milo$/, "");
    for (const m of src.matchAll(new RegExp(EXPORT.source, "gm"))) {
      out[`std/${mod}.${m[2]!}`] = {
        sig: normalizeSignature(m[0]!.replace(/\s*\{\s*$/, "")),
        isExtern: m[1] !== undefined,
      };
    }
  }
  return out;
}

export function surfaceAt(ref: string): Surface {
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "std/"], { cwd: ROOT, encoding: "utf-8" });
  const files = new Map<string, string>();
  for (const f of listing.split("\n").filter(l => l.endsWith(".milo"))) {
    files.set(f, execFileSync("git", ["show", `${ref}:${f}`], { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
  }
  return surfaceFrom(files);
}

function surfaceNow(): Surface {
  const files = new Map<string, string>();
  for (const f of readdirSync(join(ROOT, "std"))) {
    if (f.endsWith(".milo")) files.set(`std/${f}`, readFileSync(join(ROOT, "std", f), "utf-8"));
  }
  return surfaceFrom(files);
}

export interface Break { name: string; kind: "removed" | "changed"; before: string; after?: string }

export function breaksSince(ref: string): Break[] {
  const before = surfaceAt(ref);
  const after = surfaceNow();
  const out: Break[] = [];
  for (const [name, e] of Object.entries(before)) {
    // A `pub extern` name is a binding to a C symbol, not part of the API std promises.
    // Retyping `CreatePipe`'s handle args from *u8 to *i64 corrects the binding to what
    // the OS always required; it is not a migration anyone can be asked to perform.
    if (e.isExtern || after[name]?.isExtern) continue;
    const now = after[name];
    if (now === undefined) out.push({ name, kind: "removed", before: e.sig });
    else if (now.sig !== e.sig) out.push({ name, kind: "changed", before: e.sig, after: now.sig });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function lastReleaseTag(): string {
  return execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n").map(l => l.trim()).filter(Boolean)[0] ?? "";
}

// The bare symbol, as a migration note would spell it.
function shortName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf(".") + 1);
}

export function undocumented(breaks: Break[]): Break[] {
  const doc = readFileSync(join(ROOT, "docs", "breaking-changes.md"), "utf-8");
  return breaks.filter(b => !doc.includes(shortName(b.name)));
}

if (import.meta.main) {
  const i = process.argv.indexOf("--since");
  const ref = i >= 0 ? process.argv[i + 1]! : lastReleaseTag();
  if (!ref) { console.error("no release tag found and no --since given"); process.exit(1); }

  const breaks = breaksSince(ref);
  const missing = undocumented(breaks);
  console.log(`${breaks.length} public std break(s) since ${ref}; ${missing.length} undocumented`);
  for (const b of missing) {
    console.log(`  ${b.kind.toUpperCase()} ${b.name}`);
    console.log(`    was: ${b.before}`);
    if (b.after) console.log(`    now: ${b.after}`);
  }
  if (process.argv.includes("--check") && missing.length > 0) {
    console.error(`\nwrite each of these up in docs/breaking-changes.md (AGENTS.md: it is the only migration path users get)`);
    process.exit(1);
  }
}
