// Shared read-through access to the stdlib: disk first, embedded bundle as a
// fallback. Lets the LSP and `milo api` resolve/read std/*.milo even when the
// files aren't on disk (a shipped `bun build --compile` binary). The resolver
// keeps its own copy of this logic on the hot compile path; this module serves
// the tooling side (hover, goto-def, api search).
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

export const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Loaded only when std/ isn't on disk (shipped binary). A dev checkout uses the
// on-disk std/ exclusively, so a stale build-time bundle can't resurrect deleted
// files. Mirrors the resolver's gate.
let BUNDLE: Map<string, string> | null = null;
try {
  if (!existsSync(resolve(STDLIB_DIR, "std"))) BUNDLE = require("./stdlib-bundle").STDLIB;
} catch {}

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

// Return a real on-disk path for a std file the editor can open. If it's only in
// the bundle (shipped binary, no std/ on disk), write it to a cache dir and
// return that — so goto-definition into the stdlib works offline.
export function materializeStd(absPath: string): string {
  if (existsSync(absPath)) return absPath;
  const k = bundleKey(absPath);
  if (BUNDLE && k) {
    const content = BUNDLE.get(k);
    if (content !== undefined) {
      const out = resolve(homedir(), ".milo", "std-cache", k);
      try {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, content);
        return out;
      } catch {}
    }
  }
  return absPath;
}
