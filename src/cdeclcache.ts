// Cache of passing @cLayout/@cSig/@cValue verifications, so an unchanged program does not
// re-run `cc -fsyntax-only` over the guard TU on every build (~90ms on an SDL+GL game,
// paid even when nothing changed).
//
// Only a clean pass is cached: clang exited 0 and printed no `milo-guard-skip`. A failure
// must keep failing, and a skip must keep warning; a skipped header is also one the
// depfile cannot name, so installing it later could not invalidate the entry.
//
// The guard exists to catch ABI drift when a C library is upgraded, so the entry records
// every header the TU actually read (from clang's `-MD` depfile) with a SHA-256 of its
// content, and a hit requires each one to still exist with the same content. Never mtime:
// a package manager can install a different header with an old timestamp.
//
// The key covers the guard text, the compiler (path + version line), the include flags,
// and the environment variables that steer clang's header search. Known blind spot, shared
// with every depfile-based build system: a header newly created earlier on the search path
// (or one an `__has_include` probe found absent) is not in the recorded list.
//
// Storage is `<cache root>/cdecl/<key>.json`, beside the object cache. `MILO_OBJ_CACHE=0`
// turns this off too (one switch for build caches); MILO_VERBOSE=1 reports hits. Any
// error reading or checking an entry is a miss.

import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { cacheRoot } from "./pkg";
import { objCacheEnabled } from "./objcache";

export function cdeclCacheEnabled(): boolean {
  return objCacheEnabled();
}

// SDKROOT/DEVELOPER_DIR pick a different SDK whose headers live at different paths; the old
// SDK's headers would still be present and unchanged, so the recorded list alone would hit.
const SEARCH_ENV = ["CPATH", "C_INCLUDE_PATH", "SDKROOT", "DEVELOPER_DIR", "MACOSX_DEPLOYMENT_TARGET"];

export function cdeclCacheKey(guards: string, compilerId: string, flags: string): string {
  const h = createHash("sha256");
  h.update(compilerId); h.update("\0");
  h.update(flags); h.update("\0");
  for (const v of SEARCH_ENV) { h.update(`${v}=${process.env[v] ?? ""}`); h.update("\0"); }
  h.update(guards);
  return h.digest("hex");
}

type Entry = { headers: [string, string][] };

function entryPath(key: string): string {
  return join(cacheRoot(), "cdecl", `${key}.json`);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function cdeclCacheHit(key: string): boolean {
  try {
    const entry = JSON.parse(readFileSync(entryPath(key), "utf8")) as Entry;
    if (!Array.isArray(entry.headers) || entry.headers.length === 0) return false;
    for (const [path, hash] of entry.headers) {
      if (typeof path !== "string" || typeof hash !== "string") return false;
      if (hashFile(path) !== hash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Make-format depfile: `target: dep dep \` with backslash-newline continuations and
// `\ ` for a space inside a path.
export function parseDepfile(text: string): string[] {
  const body = text.replace(/\\\r?\n/g, " ");
  const colon = body.search(/:(\s|$)/);
  if (colon < 0) return [];
  const deps: string[] = [];
  let cur = "";
  const rest = body.slice(colon + 1);
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "\\" && rest[i + 1] === " ") { cur += " "; i++; continue; }
    if (/\s/.test(c)) { if (cur) deps.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur) deps.push(cur);
  return deps;
}

// Records a pass. `tu` is the temporary guard file, excluded because its name is random and
// its content is already in the key. Writes nothing if the depfile is missing or names no
// header (a compiler that ignored -MD): an entry with no headers could never be invalidated.
export function cdeclCacheStore(key: string, depfile: string, tu: string): void {
  try {
    const tuAbs = resolve(tu);
    const deps = parseDepfile(readFileSync(depfile, "utf8")).filter(d => resolve(d) !== tuAbs);
    if (deps.length === 0) return;
    const entry: Entry = { headers: deps.map(d => [resolve(d), hashFile(d)]) };
    const final = entryPath(key);
    mkdirSync(join(cacheRoot(), "cdecl"), { recursive: true });
    const tmp = `${final}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, final);
  } catch {}
}
