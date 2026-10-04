// Content-hashed object cache: skip clang for any codegen unit whose IR it has already
// compiled with the same flags.
//
// clang is ~95% of a build (src/cgu.ts) and the AI edit loop is compile latency times
// iterations. After the CGU split, an edit touches the unit holding the edited function
// and leaves the others byte-identical, so their objects can come straight from disk. A
// program run twice unchanged (every fixture on a re-run of the suite) skips clang
// entirely.
//
// The key is the SHA-256 of the unit's IR text plus everything else that shapes the
// object: the compiler's own path and version line, and the exact flags. Anything not in
// the key must not affect the object; the IR carries the target triple and data layout
// itself, so a cross build keys differently by content alone.
//
// Storage is `<cache root>/obj/<hash>.o` under the same root the package cache uses
// (~/.milo/cache, or $XDG_CACHE_HOME/milo). Pruned by count, oldest first, so it cannot
// grow without bound. `MILO_OBJ_CACHE=0` turns it off; MILO_VERBOSE=1 reports hits.

import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { HotState } from "./cgu";
import { cacheRoot } from "./pkg";

// Above this many objects the oldest are removed down to half; a 1k-fixture suite at
// a few units each stays well inside it, and a dev loop touches far fewer.
const MAX_OBJECTS = 6000;

export function objCacheEnabled(): boolean {
  return process.env.MILO_OBJ_CACHE !== "0";
}

function objCacheDir(): string {
  return join(cacheRoot(), "obj");
}

export function objCacheKey(ir: string, compilerId: string, flags: string): string {
  const h = createHash("sha256");
  h.update(compilerId); h.update("\0");
  h.update(flags); h.update("\0");
  h.update(ir);
  return h.digest("hex");
}

// Copies the cached object to `dest` and returns true, or returns false on a miss. A hit
// refreshes the file's mtime so pruning keeps what the loop is actually using.
export function objCacheFetch(key: string, dest: string): boolean {
  const src = join(objCacheDir(), `${key}.o`);
  if (!existsSync(src)) return false;
  try {
    copyFileSync(src, dest);
    const now = new Date();
    try { utimesSync(src, now, now); } catch {}
    return true;
  } catch {
    return false;
  }
}

// Stores a freshly compiled object. Written under a temporary name and renamed so a
// concurrent build never reads a half-written file. Failures are ignored: the cache is
// an optimization, and a full disk must not fail a build that already succeeded.
export function objCacheStore(key: string, obj: string): void {
  const dir = objCacheDir();
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    copyFileSync(obj, tmp);
    // rename over an existing entry is atomic on POSIX and replaces on Windows via unlink.
    const final = join(dir, `${key}.o`);
    try { unlinkSync(final); } catch {}
    renameSync(tmp, final);
    maybePrune(dir);
  } catch {}
}

let storesSincePrune = 0;

function maybePrune(dir: string): void {
  // Listing the directory on every store would cost more than the cache saves; check
  // every 100 stores.
  if (++storesSincePrune < 100) return;
  storesSincePrune = 0;
  let entries: { name: string; mtime: number }[];
  try {
    entries = readdirSync(dir).filter(n => n.endsWith(".o")).map(n => ({ name: n, mtime: statSync(join(dir, n)).mtimeMs }));
  } catch { return; }
  if (entries.length <= MAX_OBJECTS) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries.slice(0, entries.length - MAX_OBJECTS / 2)) {
    try { unlinkSync(join(dir, e.name)); } catch {}
  }
}

// The CGU placement of the previous build of this program (see cgu.ts Placement), keyed
// by the entry file's path and the unit count, so the partition survives between builds
// and an edit invalidates one unit's object rather than all of them.
export function placementLoad(programId: string, units: number): Map<string, number> | null {
  try {
    const raw = readFileSync(statePath("placement", programId, units), "utf8");
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj));
  } catch {
    return null;
  }
}

export function placementStore(programId: string, units: number, placement: Map<string, number>): void {
  writeAtomic(statePath("placement", programId, units), JSON.stringify(Object.fromEntries(placement)));
}

// The hot-unit state (cgu.ts HotState), keyed like the placement. `MILO_HOT_UNIT=0`
// places nothing hot and stores an empty hot set, which is also how a benchmark resets
// it. Any shape this does not recognize loads as null: no hot set, never a guess.
export function hotUnitEnabled(): boolean {
  return process.env.MILO_HOT_UNIT !== "0";
}

export function hotStateLoad(programId: string, units: number): HotState | null {
  try {
    const obj = JSON.parse(readFileSync(statePath("hot", programId, units), "utf8"));
    if (obj?.v !== 1 || typeof obj.hashes !== "object" || obj.hashes === null || !Array.isArray(obj.hot)) return null;
    const hashes = new Map<string, string>();
    for (const [k, v] of Object.entries(obj.hashes)) {
      if (typeof v !== "string") return null;
      hashes.set(k, v);
    }
    if (!obj.hot.every((n: unknown) => typeof n === "string")) return null;
    return { hashes, hot: obj.hot as string[] };
  } catch {
    return null;
  }
}

export function hotStateStore(programId: string, units: number, state: HotState): void {
  writeAtomic(statePath("hot", programId, units), JSON.stringify({ v: 1, hot: state.hot, hashes: Object.fromEntries(state.hashes) }));
}

// Temporary name then rename, so a concurrent build never reads half a file. Failures are
// ignored for the same reason as objCacheStore.
function writeAtomic(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch {}
}

function statePath(kind: "placement" | "hot", programId: string, units: number): string {
  const h = createHash("sha256").update(programId).update("\0").update(String(units)).digest("hex").slice(0, 32);
  return join(objCacheDir(), kind, `${h}.json`);
}
