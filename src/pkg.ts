// milo package-manager data layer: manifest (milo.json), lockfile (milo.lock),
// dependency source specs, cache-path resolution, and content-addressed tree
// hashing. Parse / serialize / hash only — see docs/plans/package-manager.md §P1.
//
// The cache layout here MUST stay byte-for-byte compatible with resolvePath in
// src/resolver.ts, which reads ~/.milo/cache/<host>/<org>/<repo>/<version>/ and
// maps local-path deps to host "local" with '/' rewritten to '_'. Diverging would
// silently break import resolution against an already-populated cache.
//
// Fetching lives here too (git subprocess / tarball download+verify); the CLI verbs
// that drive it are in src/pkgcli.ts.

import { readFileSync, writeFileSync, readdirSync, statSync, cpSync, existsSync, mkdirSync, rmSync, renameSync } from "fs";
import { resolve, join, relative, sep, dirname } from "path";
import { homedir, tmpdir } from "os";
import { createHash, randomUUID } from "crypto";
import { spawnSync } from "child_process";

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
// per docs/plans/package-manager.md §Global CLI install); otherwise ~/.milo/cache.
// resolver.ts imports THIS function rather than recomputing the path: a divergence
// between the writer and the reader would leave installed packages unresolvable.
export function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg && xdg.length > 0 ? join(xdg, "milo") : join(homedir(), ".milo", "cache");
}

// Receipts / derived state: $XDG_DATA_HOME/milo else ~/.milo.
export function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? join(xdg, "milo") : join(homedir(), ".milo");
}

// Where `milo tool install` puts executables: $XDG_BIN_HOME else ~/.local/bin —
// the directory pipx targets, never requiring sudo.
export function binRoot(): string {
  const xdg = process.env.XDG_BIN_HOME;
  return xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "bin");
}

// Content-addressed download cache, shared across versions.
export function blobsRoot(): string {
  return join(cacheRoot(), ".blobs");
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

// The cache directory a dependency spec resolves to. This is the ONE function the
// installer and the resolver have to agree on, so it deliberately reproduces
// resolver.ts:parsePkgUrl's quirks rather than improving on them: the version
// segment defaults to "main" when the spec carries no ref, and a local path keeps
// its literal spelling (with '/' → '_') as the key.
//
// Because the key is the literal spec string, a local path is resolved relative to
// the ROOT project — two packages naming "./vendor/x" share one cache entry, which
// is exactly what `milo vendor` depends on.
export function cacheDirForSpec(spec: string): string {
  const source = parseSource(spec);
  switch (source.kind) {
    case "local": {
      // resolver splits at the FIRST '@' for every scheme; mirror it here.
      const at = spec.indexOf("@");
      const path = at === -1 ? spec : spec.slice(0, at);
      const version = at === -1 ? "main" : spec.slice(at + 1);
      return cachePathFor({ kind: "local", path }, version);
    }
    case "git":
    case "giturl":
      return cachePathFor(source, source.ref ?? "main");
    case "tarball":
      return cachePathFor(source, "main");
  }
}

// The lockfile `version` value for a spec: the ref it names, else "main".
export function specVersion(spec: string): string {
  const source = parseSource(spec);
  switch (source.kind) {
    case "git":
    case "giturl":
      return source.ref ?? "main";
    case "local":
      return "main";
    case "tarball":
      return "main";
  }
}

// The lockfile `url` value for a spec: the source without its ref.
export function specUrl(spec: string): string {
  const source = parseSource(spec);
  switch (source.kind) {
    case "git":
      return `${source.host}/${source.org}/${source.repo}`;
    case "giturl":
      return source.url;
    case "local":
      return source.path;
    case "tarball":
      return `${source.url}#sha256=${source.sha256}`;
  }
}

// ── Fetch ──────────────────────────────────────────────────────────────────────

// Copy a local-path package tree into destDir. baseDir is what a relative path is
// resolved against (the root project dir — see cacheDirForSpec); it defaults to the
// process cwd so the original single-argument callers are unchanged.
export function fetchLocal(source: { kind: "local"; path: string }, destDir: string, baseDir?: string): void {
  const src = baseDir === undefined ? resolve(source.path) : resolve(baseDir, source.path);
  if (!existsSync(src)) throw new Error(`local dependency not found: ${src}`);
  cpSync(src, destDir, { recursive: true });
}

export interface FetchResult {
  // The pin: an exact git commit SHA, or "sha256:<hex>" for a tarball, or "local".
  commit: string;
  // The ref that was asked for ("v1.2.0", a SHA, a branch), or "main".
  version: string;
}

// Fetch a remote package into destDir (replacing whatever is there) and return the
// exact revision it landed on. Networked: git subprocess for git/giturl, HTTP for
// tarballs. The declared #sha256= of a tarball is verified against the bytes that
// actually arrived — a mismatch is fatal, never a warning.
export async function fetchRemote(source: Source, destDir: string): Promise<FetchResult> {
  switch (source.kind) {
    case "git":
      return fetchGit(gitCloneUrl(source), source.ref, destDir);
    case "giturl":
      // "git+ssh://…" / "git+https://…" — strip the scheme prefix git itself doesn't take.
      return fetchGit(source.url.replace(/^git\+/, ""), source.ref, destDir);
    case "tarball":
      return await fetchTarball(source, destDir);
    case "local":
      throw new Error("fetchRemote: local sources are handled by fetchLocal");
  }
}

function gitCloneUrl(source: { host: string; org: string; repo: string }): string {
  // sr.ht serves git from git.sr.ht; the shorthand people write is sr.ht/~user/repo.
  const host = source.host === "sr.ht" ? "git.sr.ht" : source.host;
  return `https://${host}/${source.org}/${source.repo}.git`;
}

function git(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// Shallow-clone at the ref, then resolve the tag/branch to the commit it actually
// points at — the tag is what the user typed, the SHA is what gets locked.
function fetchGit(url: string, ref: string | undefined, destDir: string): FetchResult {
  const staging = join(tmpdir(), `milo-fetch-${randomUUID().slice(0, 8)}`);
  try {
    let cloned = ref === undefined
      ? git(["clone", "--depth", "1", "--quiet", url, staging])
      : git(["clone", "--depth", "1", "--quiet", "--branch", ref, url, staging]);
    if (!cloned.ok && ref !== undefined) {
      // --branch only accepts a tag or branch name; a raw SHA needs fetch+checkout.
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const init = git(["init", "--quiet"], staging);
      if (!init.ok) throw new Error(`git init failed: ${init.err}`);
      git(["remote", "add", "origin", url], staging);
      const fetched = git(["fetch", "--depth", "1", "--quiet", "origin", ref], staging);
      if (!fetched.ok) throw new Error(`cannot fetch ${url} at '${ref}': ${fetched.err || cloned.err}`);
      const co = git(["checkout", "--quiet", "FETCH_HEAD"], staging);
      if (!co.ok) throw new Error(`cannot check out '${ref}' from ${url}: ${co.err}`);
      cloned = { ok: true, out: "", err: "" };
    }
    if (!cloned.ok) throw new Error(`cannot clone ${url}: ${cloned.err}`);

    const head = git(["rev-parse", "HEAD"], staging);
    if (!head.ok || !/^[0-9a-f]{40}$/.test(head.out)) {
      throw new Error(`cannot resolve commit for ${url}: ${head.err}`);
    }
    // The clone metadata is not part of the package and would poison sha256Tree.
    rmSync(join(staging, ".git"), { recursive: true, force: true });
    replaceDir(staging, destDir);
    return { commit: head.out, version: ref ?? "main" };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function fetchTarball(source: { url: string; sha256: string }, destDir: string): Promise<FetchResult> {
  const blob = join(blobsRoot(), `${source.sha256}.tar.gz`);
  if (!existsSync(blob)) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`cannot download ${source.url}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== source.sha256) {
      throw new Error(`hash mismatch for ${source.url}\n  declared sha256:${source.sha256}\n  actual   sha256:${got}`);
    }
    mkdirSync(blobsRoot(), { recursive: true });
    writeFileSync(blob, bytes);
  } else {
    // A cache entry is content-addressed by name only; re-verify so a corrupted or
    // tampered blob can never be trusted just because it is already on disk.
    const got = createHash("sha256").update(readFileSync(blob)).digest("hex");
    if (got !== source.sha256) {
      rmSync(blob, { force: true });
      throw new Error(`cached blob for ${source.url} is corrupt (sha256:${got}); removed — retry`);
    }
  }

  const staging = join(tmpdir(), `milo-untar-${randomUUID().slice(0, 8)}`);
  mkdirSync(staging, { recursive: true });
  try {
    const r = spawnSync("tar", ["-xzf", blob, "-C", staging], { encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`cannot extract ${source.url}: ${r.stderr ?? ""}`);
    // Release tarballs conventionally wrap everything in one directory; unwrap it so
    // the extracted tree looks the same as a git checkout.
    const entries = readdirSync(staging);
    const root = entries.length === 1 && statSync(join(staging, entries[0])).isDirectory()
      ? join(staging, entries[0])
      : staging;
    replaceDir(root, destDir);
    return { commit: `sha256:${source.sha256}`, version: "main" };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Tags on the remote, newest-version first. `milo update` uses this instead of a
// registry index: with git-as-registry, listing tags IS the version list.
export function listRemoteTags(source: Source): string[] {
  const url =
    source.kind === "git" ? gitCloneUrl(source)
    : source.kind === "giturl" ? source.url.replace(/^git\+/, "")
    : null;
  if (url === null) return [];
  const r = git(["ls-remote", "--tags", "--refs", url]);
  if (!r.ok) throw new Error(`cannot list tags for ${url}: ${r.err}`);
  const tags: string[] = [];
  for (const line of r.out.split("\n")) {
    const m = /refs\/tags\/(.+)$/.exec(line.trim());
    if (m) tags.push(m[1]);
  }
  return tags.sort(compareVersionsDesc);
}

// Descending semver-ish order over tags. Non-numeric tags sort last (alphabetically),
// so a `latest`/`nightly` tag can never outrank a real version.
export function compareVersionsDesc(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (pa === null && pb === null) return a < b ? -1 : a > b ? 1 : 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function versionParts(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

// Move `from` onto `to`, replacing it. Falls back to a copy because rename(2) fails
// across filesystems (tmpdir and the cache are often different mounts).
function replaceDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
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
