// milo package-manager data layer: manifest (milo.json), lockfile (milo.lock),
// dependency source specs, cache-path resolution, and content-addressed tree
// hashing. Parse / serialize / hash only — see docs/plans/package-manager.md §P1.
//
// The cache layout here MUST stay byte-for-byte compatible with resolvePath in
// src/resolver.ts, which reads ~/.milo/cache/<host>/<org>/<repo>/<version>/ and
// maps local-path deps to host "local" with '/' rewritten to '_'. Diverging would
// silently break import resolution against an already-populated cache.
//
// Network fetch (git / giturl / tarball) is deliberately out of scope for this
// layer — only the local-path fetch is implemented; see TODO(network).

import { readFileSync, readdirSync, statSync, cpSync } from "fs";
import { resolve, join, relative, sep } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

// ── Manifest ────────────────────────────────────────────────────────────────

export interface Manifest {
  name: string;
  version: string;
  description?: string;
  license?: string;
  repository?: string;
  milo?: string; // compiler version constraint, e.g. ">=0.4.0"
  lib?: string; // importable surface — what `import "<name>"` resolves to
  bin?: Record<string, string>; // installable executables, keyed by installed name
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  targets?: string[];
  exclude?: string[];
  // advisory only — never affects linking; @link is the source of truth.
  nativeHints?: Record<string, Record<string, string>>;
}

export function parseManifest(text: string): Manifest {
  const raw: unknown = JSON.parse(stripJsonc(text));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("milo.json: expected a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const ctx = "milo.json";

  const m: Manifest = {
    name: requireString(o, "name", ctx),
    version: requireString(o, "version", ctx),
  };
  setOpt(m, "description", optString(o, "description", ctx));
  setOpt(m, "license", optString(o, "license", ctx));
  setOpt(m, "repository", optString(o, "repository", ctx));
  setOpt(m, "milo", optString(o, "milo", ctx));
  setOpt(m, "lib", optString(o, "lib", ctx));
  setOpt(m, "bin", optStringRecord(o, "bin", ctx));
  setOpt(m, "deps", optStringRecord(o, "deps", ctx));
  setOpt(m, "devDeps", optStringRecord(o, "devDeps", ctx));
  setOpt(m, "targets", optStringArray(o, "targets", ctx));
  setOpt(m, "exclude", optStringArray(o, "exclude", ctx));
  setOpt(m, "nativeHints", optNestedRecord(o, "nativeHints", ctx));

  // A publishable package must expose a lib and/or bins; a root application
  // manifest legitimately has neither, so this is not enforced at parse time.
  // Use isPublishable(m) to gate `milo publish`.
  return m;
}

// True for a package that exposes an importable library and/or installable
// binaries. A bare app manifest (name+version, no lib/bin) is not publishable.
export function isPublishable(m: Manifest): boolean {
  return m.lib !== undefined || (m.bin !== undefined && Object.keys(m.bin).length > 0);
}

export function stringifyManifest(m: Manifest): string {
  const o: Record<string, unknown> = {};
  o.name = m.name;
  o.version = m.version;
  if (m.description !== undefined) o.description = m.description;
  if (m.license !== undefined) o.license = m.license;
  if (m.repository !== undefined) o.repository = m.repository;
  if (m.milo !== undefined) o.milo = m.milo;
  if (m.lib !== undefined) o.lib = m.lib;
  if (m.bin !== undefined) o.bin = sortedRecord(m.bin);
  if (m.deps !== undefined) o.deps = sortedRecord(m.deps);
  if (m.devDeps !== undefined) o.devDeps = sortedRecord(m.devDeps);
  if (m.targets !== undefined) o.targets = m.targets;
  if (m.exclude !== undefined) o.exclude = m.exclude;
  if (m.nativeHints !== undefined) o.nativeHints = sortedNestedRecord(m.nativeHints);
  return JSON.stringify(o, null, 2) + "\n";
}

// ── Source schemes ────────────────────────────────────────────────────────────

export type Source =
  | { kind: "git"; host: string; org: string; repo: string; ref?: string }
  | { kind: "giturl"; url: string; ref?: string }
  | { kind: "local"; path: string }
  | { kind: "tarball"; url: string; sha256: string };

const KNOWN_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "sr.ht"]);

// Classify a dependency spec (a milo.json `deps` value) into a tagged Source.
export function parseSource(spec: string): Source {
  const s = spec.trim();
  if (s.length === 0) throw new Error("empty dependency spec");

  // local path — never ref-split, never hash-locked.
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
    return { kind: "local", path: s };
  }

  // explicit git URL, e.g. git+ssh://git@internal/bar.git@v1.2.0
  if (s.startsWith("git+")) {
    const { base, ref } = splitRef(s);
    return ref === undefined ? { kind: "giturl", url: base } : { kind: "giturl", url: base, ref };
  }

  // tarball — sha256 mandatory in the URL fragment.
  if (s.startsWith("https://") || s.startsWith("http://")) {
    const hashIdx = s.indexOf("#sha256=");
    if (hashIdx === -1) {
      throw new Error(`tarball source requires a '#sha256=<hex>' fragment: ${spec}`);
    }
    const url = s.slice(0, hashIdx);
    const sha256 = s.slice(hashIdx + "#sha256=".length);
    if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
      throw new Error(`tarball sha256 must be 64 hex chars: ${spec}`);
    }
    return { kind: "tarball", url, sha256: sha256.toLowerCase() };
  }

  // git host shorthand: host/org/repo[@ref]
  const { base, ref } = splitRef(s);
  const parts = base.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) {
    throw new Error(`git shorthand must be host/org/repo[@ref]: ${spec}`);
  }
  const host = parts[0];
  if (!KNOWN_HOSTS.has(host) && !host.includes(".")) {
    throw new Error(`unrecognized host '${host}' (expected a domain like github.com): ${spec}`);
  }
  const org = parts[1];
  const repo = parts.slice(2).join("/"); // tolerate nested repo paths (e.g. sr.ht groups)
  return ref === undefined ? { kind: "git", host, org, repo } : { kind: "git", host, org, repo, ref };
}

// Split a trailing "@ref" only when the '@' sits after the last '/', so the
// user@host '@' inside a git+ssh URL is never mistaken for a ref.
function splitRef(s: string): { base: string; ref?: string } {
  const at = s.lastIndexOf("@");
  const slash = s.lastIndexOf("/");
  if (at > slash && at !== -1) return { base: s.slice(0, at), ref: s.slice(at + 1) };
  return { base: s };
}

// ── Lockfile ──────────────────────────────────────────────────────────────────

export interface LockPackage {
  url: string;
  version: string;
  commit: string; // exact SHA, not the tag
  hash: string; // sha256 of the extracted tree, verified on every install
  deps: string[];
}

export interface Lockfile {
  lockVersion: 1;
  packages: Record<string, LockPackage>;
}

export function parseLock(text: string): Lockfile {
  const raw: unknown = JSON.parse(stripJsonc(text));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("milo.lock: expected a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.lockVersion !== 1) {
    throw new Error(`milo.lock: unsupported lockVersion ${JSON.stringify(o.lockVersion)} (expected 1)`);
  }
  const pkgsRaw = o.packages;
  if (typeof pkgsRaw !== "object" || pkgsRaw === null || Array.isArray(pkgsRaw)) {
    throw new Error("milo.lock: 'packages' must be an object");
  }
  const packages: Record<string, LockPackage> = {};
  for (const [name, entryRaw] of Object.entries(pkgsRaw as Record<string, unknown>)) {
    if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) {
      throw new Error(`milo.lock: package '${name}' must be an object`);
    }
    const e = entryRaw as Record<string, unknown>;
    const ctx = `milo.lock: package '${name}'`;
    packages[name] = {
      url: requireString(e, "url", ctx),
      version: requireString(e, "version", ctx),
      commit: requireString(e, "commit", ctx),
      hash: requireString(e, "hash", ctx),
      deps: requireStringArray(e, "deps", ctx),
    };
  }
  return { lockVersion: 1, packages };
}

export function stringifyLock(lock: Lockfile): string {
  const packages: Record<string, LockPackage> = {};
  // Sort package names for a stable diff; deps order is preserved (it is data).
  for (const name of Object.keys(lock.packages).sort()) {
    const p = lock.packages[name];
    packages[name] = {
      url: p.url,
      version: p.version,
      commit: p.commit,
      hash: p.hash,
      deps: p.deps,
    };
  }
  return JSON.stringify({ lockVersion: 1, packages }, null, 2) + "\n";
}

// ── Tree hashing ──────────────────────────────────────────────────────────────

// Deterministic sha256 over an extracted package tree. Path order is normalized
// (sorted, posix separators) so readdir order can't change the digest; each
// file's path, byte length, and contents all feed the hash, so a changed file —
// content or size — changes the result. Returns "sha256:<hex>".
export function sha256Tree(dir: string): string {
  const files: string[] = [];
  collectFiles(dir, dir, files);
  files.sort();

  const hasher = createHash("sha256");
  for (const rel of files) {
    const content = readFileSync(join(dir, rel));
    hasher.update(rel);
    hasher.update("\0");
    hasher.update(String(content.length));
    hasher.update("\0");
    hasher.update(content);
  }
  return "sha256:" + hasher.digest("hex");
}

function collectFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      collectFiles(root, abs, out);
    } else if (st.isFile()) {
      // posix-normalize so the digest is identical across platforms.
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
}

// ── Cache layout ──────────────────────────────────────────────────────────────

// Root of the extracted-package cache. Honors XDG_CACHE_HOME ($XDG_CACHE_HOME/milo,
// per docs/plans/package-manager.md §Global CLI install); otherwise ~/.milo/cache,
// which is exactly what resolver.ts hard-codes.
function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg && xdg.length > 0 ? join(xdg, "milo") : join(homedir(), ".milo", "cache");
}

// The ~/.milo/cache/<host>/<org>/<repo>/<version>/ directory for a source. The
// git and local layouts match resolver.ts exactly; giturl/tarball have no
// resolver read-path yet, so their layout here is best-effort and internal-only.
export function cachePathFor(source: Source, version: string): string {
  const root = cacheRoot();
  switch (source.kind) {
    case "git":
      return join(root, source.host, source.org, source.repo, version);
    case "local":
      // resolver maps local deps to host "local" with '/' rewritten to '_'.
      return join(root, "local", source.path.replace(/\//g, "_"), version);
    case "giturl":
      return join(root, "giturl", sanitizeSegment(source.url), version);
    case "tarball":
      return join(root, "tarball", source.sha256, version);
  }
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ── Fetch ──────────────────────────────────────────────────────────────────────

// Copy a local-path package tree into destDir. The only fetch scheme implemented
// in the data layer; git/giturl/tarball require the network — see fetchRemote.
export function fetchLocal(source: { kind: "local"; path: string }, destDir: string): void {
  const src = resolve(source.path);
  cpSync(src, destDir, { recursive: true });
}

// TODO(network): git/giturl/tarball fetch (clone/checkout, download+verify+extract)
// is out of scope for the data layer and lives with the CLI wiring in a later phase.
export function fetchRemote(_source: Source, _destDir: string): never {
  throw new Error("not implemented: network fetch (git/giturl/tarball)");
}

// ── JSONC + validation helpers ──────────────────────────────────────────────────

// Strip // and /* */ comments and trailing commas, string- and escape-aware, so
// milo.json/milo.lock can carry comments and trailing commas (jsonParseJsonc's
// TS-side equivalent). JSON.parse handles the rest.
function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      if (i < n) out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip the '*'; loop's i++ skips the '/'
      continue;
    }
    out += c;
  }
  return removeTrailingCommas(out);
}

function removeTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += s[i + 1] ?? "";
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue; // drop the trailing comma
    }
    out += c;
  }
  return out;
}

function requireString(o: Record<string, unknown>, key: string, ctx: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${ctx}: '${key}' must be a non-empty string`);
  }
  return v;
}

function optString(o: Record<string, unknown>, key: string, ctx: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${ctx}: '${key}' must be a string`);
  return v;
}

function optStringArray(o: Record<string, unknown>, key: string, ctx: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  return coerceStringArray(v, key, ctx);
}

function requireStringArray(o: Record<string, unknown>, key: string, ctx: string): string[] {
  const v = o[key];
  if (v === undefined) return [];
  return coerceStringArray(v, key, ctx);
}

function coerceStringArray(v: unknown, key: string, ctx: string): string[] {
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new Error(`${ctx}: '${key}' must be an array of strings`);
  }
  return v;
}

function optStringRecord(o: Record<string, unknown>, key: string, ctx: string): Record<string, string> | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${ctx}: '${key}' must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") throw new Error(`${ctx}: '${key}.${k}' must be a string`);
    out[k] = val;
  }
  return out;
}

function optNestedRecord(
  o: Record<string, unknown>,
  key: string,
  ctx: string,
): Record<string, Record<string, string>> | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${ctx}: '${key}' must be an object`);
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
      throw new Error(`${ctx}: '${key}.${k}' must be an object of string values`);
    }
    const innerOut: Record<string, string> = {};
    for (const [ik, iv] of Object.entries(inner as Record<string, unknown>)) {
      if (typeof iv !== "string") throw new Error(`${ctx}: '${key}.${k}.${ik}' must be a string`);
      innerOut[ik] = iv;
    }
    out[k] = innerOut;
  }
  return out;
}

function sortedRecord(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k];
  return out;
}

function sortedNestedRecord(r: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const k of Object.keys(r).sort()) out[k] = sortedRecord(r[k]);
  return out;
}

// Assign an optional field only when present, so round-tripping never introduces
// an explicit `undefined` that would break deep-equality against the parsed form.
function setOpt<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}
