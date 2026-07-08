// Shared read-through access to the stdlib: disk first, embedded bundle as a
// fallback. Lets the LSP and `milo api` resolve/read std/*.milo even when the
// files aren't on disk (a shipped `bun build --compile` binary). The resolver
// keeps its own copy of this logic on the hot compile path; this module serves
// the tooling side (hover, goto-def, api search).
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

let BUNDLE: Map<string, string> | null = null;
try { BUNDLE = require("./stdlib-bundle").STDLIB; } catch {}

function bundleKey(absPath: string): string | null {
  return absPath.startsWith(STDLIB_DIR + "/") ? absPath.slice(STDLIB_DIR.length + 1) : null;
}

// True if the file is on disk or in the embedded bundle.
export function stdExists(absPath: string): boolean {
  if (existsSync(absPath)) return true;
  const k = bundleKey(absPath);
  return !!(BUNDLE && k && BUNDLE.has(k));
}

// Read a .milo source from disk, falling back to the bundle. null if neither.
export function readStd(absPath: string): string | null {
  if (existsSync(absPath)) return readFileSync(absPath, "utf-8");
  const k = bundleKey(absPath);
  if (BUNDLE && k) { const c = BUNDLE.get(k); if (c !== undefined) return c; }
  return null;
}

// Absolute paths of every bundled stdlib file (for enumeration when std/ isn't
// on disk). Empty when no bundle is present.
export function bundledStdPaths(): string[] {
  if (!BUNDLE) return [];
  return [...BUNDLE.keys()].map(k => resolve(STDLIB_DIR, k));
}
