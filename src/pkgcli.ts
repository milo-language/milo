// milo package-manager CLI verbs: init/new/add/remove/install/update/tree/why/
// vendor/publish and the `tool` namespace (install/uninstall/list/run).
// The data layer (manifest, lock, sources, hashing, fetch) is src/pkg.ts; this file
// is policy + wiring. See docs/plans/package-manager.md §P1.
//
// Two rules from the plan drive most of the shape here:
//   1. `lib` and `bin` are different products. `deps` resolution only ever looks at
//      `lib`, because resolvePath merges every decl of whatever it resolves — a
//      dependency's `fn main` merged into a consumer is a duplicate-fn error or a
//      silent rebind. Every wrong path names the right command instead of guessing.
//   2. The section embedded in an installed binary is authoritative; installed.json
//      is a rebuildable cache that never wins a disagreement.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync,
  statSync, chmodSync, copyFileSync, unlinkSync,
} from "fs";
import { join, resolve, dirname, basename, delimiter } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import {
  parseManifest, stringifyManifest, isPublishable, parseSource, parseLock, stringifyLock,
  sha256Tree, cacheDirForSpec, specUrl, specVersion, fetchLocal, fetchRemote,
  binRoot, dataRoot, listRemoteTags,
  type Manifest, type Lockfile, type LockPackage,
} from "./pkg";

// What the CLI needs from the compiler. Passed in rather than imported so this
// module never pulls in main.ts (which would re-run its top-level main()).
export interface PkgHost {
  // Compile sourcePath to outPath. extraLinkFlags reach the linker verbatim — that
  // is how the metadata object file gets into an installed binary.
  build(sourcePath: string, outPath: string, extraLinkFlags: string[]): string;
  // Front-end check only, for `milo publish`'s smoke test. A library has no main,
  // so it can be checked but not linked.
  check(sourcePath: string): void;
  os: string;
}

class PkgError extends Error {}
function fail(msg: string): never {
  throw new PkgError(msg);
}

// ── Project / manifest / lock IO ─────────────────────────────────────────────

interface Project {
  dir: string;
  manifestPath: string;
  manifest: Manifest;
}

export function findProject(startDir: string): Project | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 20; i++) {
    const p = join(dir, "milo.json");
    if (existsSync(p)) {
      return { dir, manifestPath: p, manifest: parseManifest(readFileSync(p, "utf-8")) };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function requireProject(cwd: string): Project {
  const p = findProject(cwd);
  if (!p) fail("no milo.json found in this directory or any parent — run 'milo init' to create one");
  return p;
}

function saveManifest(p: Project): void {
  writeFileSync(p.manifestPath, stringifyManifest(p.manifest));
}

function lockPath(dir: string): string {
  return join(dir, "milo.lock");
}

function readLock(dir: string): Lockfile | null {
  const p = lockPath(dir);
  if (!existsSync(p)) return null;
  return parseLock(readFileSync(p, "utf-8"));
}

function writeLock(dir: string, lock: Lockfile): void {
  writeFileSync(lockPath(dir), stringifyLock(lock));
}

function readManifestAt(dir: string): Manifest | null {
  const p = join(dir, "milo.json");
  if (!existsSync(p)) return null;
  try {
    return parseManifest(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function allDeps(m: Manifest): Record<string, string> {
  return { ...(m.deps ?? {}), ...(m.devDeps ?? {}) };
}

// ── Materializing packages into the cache ────────────────────────────────────

interface Present {
  dir: string;
  // The revision, when this call actually fetched. null on a cache hit, where the
  // lockfile is the only thing that knows what commit the tree came from.
  commit: string | null;
}

async function ensurePresent(spec: string, rootDir: string, force: boolean): Promise<Present> {
  const source = parseSource(spec);
  const dir = cacheDirForSpec(spec);
  if (source.kind === "local") {
    // Always re-copied: a path dependency is expected to change under you, and it is
    // never hash-locked, so there is nothing a stale copy could be validated against.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    fetchLocal(source, dir, rootDir);
    return { dir, commit: "local" };
  }
  if (!force && existsSync(dir) && readdirSync(dir).length > 0) return { dir, commit: null };
  const r = await fetchRemote(source, dir);
  return { dir, commit: r.commit };
}

// The dependency's name: its own manifest is authoritative, since that is the name
// its `pub` surface is namespaced under. Repo basename is the fallback for a package
// that ships no manifest (a plain git repo of .milo files).
function packageNameFor(spec: string, dir: string): string {
  const m = readManifestAt(dir);
  if (m) return m.name;
  const source = parseSource(spec);
  const last = specUrl(spec).split("/").filter((s) => s.length > 0).pop() ?? "pkg";
  const cleaned = last.replace(/\.git$/, "").replace(/\.tar\.gz.*$/, "");
  // "milo-http2" is the conventional repo name for the package "http2".
  return source.kind === "local" ? cleaned : cleaned.replace(/^milo-/, "");
}

// ── Graph resolution ─────────────────────────────────────────────────────────

interface ResolveOpts {
  includeDev: boolean;
  // Names to re-fetch even when cached ("all" for `milo update` with no argument).
  refresh: Set<string> | "all";
}

// Walk the dependency graph, materialize every package, and produce a fresh lock.
// Only `deps` are followed — a dependency's `bin` is never merged into a consumer
// (docs/plans/package-manager.md §Libraries vs binaries).
async function resolveGraph(root: Project, existing: Lockfile | null, opts: ResolveOpts): Promise<Lockfile> {
  const packages: Record<string, LockPackage> = {};
  const seenSpec = new Map<string, string>();
  const queue: { name: string; spec: string }[] = [];

  for (const [name, spec] of Object.entries(root.manifest.deps ?? {})) queue.push({ name, spec });
  if (opts.includeDev) {
    for (const [name, spec] of Object.entries(root.manifest.devDeps ?? {})) queue.push({ name, spec });
  }

  while (queue.length > 0) {
    const { name, spec } = queue.shift()!;
    const prior = seenSpec.get(name);
    if (prior !== undefined) {
      if (prior !== spec) {
        fail(`dependency name collision: '${name}' is required as both '${prior}' and '${spec}'\n` +
             `  the flat namespace admits one package per name — vendor one of them or rename it`);
      }
      continue;
    }
    seenSpec.set(name, spec);

    const force = opts.refresh === "all" || opts.refresh.has(name);
    const { dir, commit } = await ensurePresent(spec, root.dir, force);
    const manifest = readManifestAt(dir);
    if (manifest && manifest.lib === undefined && manifest.bin !== undefined) {
      fail(binOnlyMessage(manifest.name, spec));
    }

    const hash = sha256Tree(dir);
    const prev = existing?.packages[name];
    const url = specUrl(spec);
    const version = specVersion(spec);
    let resolvedCommit = commit;
    if (resolvedCommit === null) {
      // Cache hit: the lock is the only record of what commit this tree is. Without
      // one there is nothing to pin, so re-fetch rather than invent a value.
      if (prev && prev.url === url && prev.version === version) {
        resolvedCommit = prev.commit;
      } else {
        resolvedCommit = (await ensurePresent(spec, root.dir, true)).commit ?? "unknown";
      }
    }
    // A local path is never hash-locked; everything else is verified on every pass,
    // so a moved tag or a poisoned cache entry fails loudly instead of building.
    if (prev && prev.commit === resolvedCommit && prev.hash !== hash && resolvedCommit !== "local") {
      fail(`hash mismatch for '${name}' at ${resolvedCommit}\n` +
           `  locked ${prev.hash}\n  actual ${hash}\n` +
           `  the upstream tag moved or the cache entry was modified`);
    }

    const depNames: string[] = [];
    for (const [dn, dspec] of Object.entries(manifest?.deps ?? {})) {
      depNames.push(dn);
      queue.push({ name: dn, spec: dspec });
    }
    packages[name] = { url, version, commit: resolvedCommit, hash, deps: depNames.sort() };
  }
  return { lockVersion: 1, packages };
}

// Why the lock does not describe the manifest, or null when they agree.
function lockStaleReason(project: Project, lock: Lockfile | null): string | null {
  const deps = allDeps(project.manifest);
  if (lock === null) {
    return Object.keys(deps).length === 0 ? null : "milo.lock is missing";
  }
  for (const [name, spec] of Object.entries(deps)) {
    const e = lock.packages[name];
    if (!e) return `'${name}' is in milo.json but not in milo.lock`;
    if (e.url !== specUrl(spec) || e.version !== specVersion(spec)) {
      return `'${name}' is locked at ${e.url}@${e.version} but milo.json asks for ${spec}`;
    }
  }
  // Orphans: anything in the lock no longer reachable from the manifest.
  const reachable = new Set<string>();
  const stack = Object.keys(deps);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (reachable.has(n)) continue;
    reachable.add(n);
    for (const d of lock.packages[n]?.deps ?? []) stack.push(d);
  }
  for (const name of Object.keys(lock.packages)) {
    if (!reachable.has(name)) return `'${name}' is in milo.lock but is no longer a dependency`;
  }
  return null;
}

// ── lib/bin split messages (the plan's exact guidance) ───────────────────────

function binOnlyMessage(name: string, spec: string): string {
  return `${name} ships no library, so it cannot be a dependency. To install its command: milo tool install ${spec}`;
}

function libOnlyMessage(name: string, spec: string): string {
  return `${name} ships no executables. To use it as a dependency: milo add ${spec}`;
}

// ── Embedded binary identity ─────────────────────────────────────────────────

// Fixed ASCII tag so the payload greps identically on every platform:
//   strings <bin> | grep MILO_PKG
const PKG_TAG = "MILO_PKG";

export interface PkgSection {
  name: string;
  version: string;
  url: string;
  commit: string;
  // The installed command name. A package may ship several bins, so the package
  // name alone cannot identify which file this is — and uninstall must not decide
  // that from the filename.
  bin: string;
}

// Payload is identical everywhere; only the section name is per-platform.
function sectionName(os: string): string {
  if (os === "darwin") return "__MILO,__pkg"; // Mach-O needs segment,section
  if (os === "windows") return ".milopkg"; // COFF: 8 chars, no string-table entry
  return ".milo.pkg"; // ELF
}

// Read the embedded metadata by scanning for the tag rather than shelling out to
// otool/readelf/dumpbin: the bytes are the same on all three formats, and a package
// manager that cannot identify its own binaries without platform tooling installed
// is one bad container image away from deleting the wrong file.
export function readPkgSection(binPath: string): PkgSection | null {
  let buf: Buffer;
  try {
    buf = readFileSync(binPath);
  } catch {
    return null;
  }
  const tag = Buffer.from(PKG_TAG + "\0", "ascii");
  const at = buf.indexOf(tag);
  if (at === -1) return null;
  const start = at + tag.length;
  let end = buf.indexOf(0, start);
  if (end === -1) end = buf.length;
  try {
    const o = JSON.parse(buf.subarray(start, end).toString("utf-8")) as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.bin !== "string") return null;
    return {
      name: o.name,
      version: typeof o.version === "string" ? o.version : "",
      url: typeof o.url === "string" ? o.url : "",
      commit: typeof o.commit === "string" ? o.commit : "",
      bin: o.bin,
    };
  } catch {
    return null;
  }
}

// C string literal escaping. Octal (never \x) because a hex escape in C is greedy —
// "\x00{" would be parsed as one enormous character constant.
function cEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c < 127) out += ch;
    else if (c < 256) out += "\\" + c.toString(8).padStart(3, "0");
    else out += Array.from(Buffer.from(ch, "utf-8")).map((b) => "\\" + b.toString(8).padStart(3, "0")).join("");
  }
  return out;
}

function findCC(): string {
  for (const cc of ["clang", "cc"]) {
    const r = spawnSync(cc, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return cc;
  }
  fail("no C compiler found (clang or cc) — needed to embed package metadata into the binary");
}

// Compile the metadata object that carries the MILO_PKG section, returning its path.
function buildMetaObject(meta: PkgSection, os: string, workDir: string): string {
  const payload = PKG_TAG + "\0" + JSON.stringify(meta);
  const src = join(workDir, "milo_pkg_meta.c");
  const obj = join(workDir, "milo_pkg_meta.o");
  writeFileSync(
    src,
    `/* generated by 'milo tool install' — see docs/plans/package-manager.md */\n` +
      `__attribute__((used, section("${sectionName(os)}")))\n` +
      `static const char milo_pkg_meta[] = "${cEscape(payload)}";\n`,
  );
  const cc = findCC();
  const r = spawnSync(cc, ["-c", src, "-o", obj], { encoding: "utf-8" });
  if (r.status !== 0 || !existsSync(obj)) {
    fail(`could not compile package metadata object:\n${r.stderr ?? ""}`);
  }
  return obj;
}

// ── Receipts (installed.json) — a cache, never the source of truth ───────────

interface Receipts {
  version: 1;
  tools: Record<string, PkgSection & { path: string }>;
}

function receiptsPath(): string {
  return join(dataRoot(), "installed.json");
}

function readReceipts(): Receipts {
  try {
    const raw = JSON.parse(readFileSync(receiptsPath(), "utf-8")) as Receipts;
    if (raw && typeof raw === "object" && raw.tools) return { version: 1, tools: raw.tools };
  } catch {}
  return { version: 1, tools: {} };
}

function writeReceipts(r: Receipts): void {
  mkdirSync(dataRoot(), { recursive: true });
  const tools: Receipts["tools"] = {};
  for (const k of Object.keys(r.tools).sort()) tools[k] = r.tools[k];
  writeFileSync(receiptsPath(), JSON.stringify({ version: 1, tools }, null, 2) + "\n");
}

// Rebuild the receipts cache from the only thing that cannot lie: the binaries.
function repairReceipts(): Receipts {
  const dir = binRoot();
  const tools: Receipts["tools"] = {};
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      const sec = readPkgSection(p);
      if (sec) tools[entry] = { ...sec, path: p };
    }
  }
  const r: Receipts = { version: 1, tools };
  writeReceipts(r);
  return r;
}

function pathAdvice(dir: string): string | null {
  const parts = (process.env.PATH ?? "").split(delimiter).filter((p) => p.length > 0);
  if (parts.includes(dir)) return null;
  const shell = basename(process.env.SHELL ?? "");
  const rc =
    shell === "zsh" ? "~/.zshrc"
    : shell === "bash" ? "~/.bashrc"
    : shell === "fish" ? "~/.config/fish/config.fish"
    : "your shell's startup file";
  const line = shell === "fish" ? `fish_add_path ${dir}` : `export PATH="${dir}:$PATH"`;
  // Deliberately printed, never applied: editing someone's shell config behind
  // their back is not a package manager's job.
  return `note: ${dir} is not on your PATH\n  add this line to ${rc}, then restart your shell:\n    ${line}`;
}

// ── Verbs ────────────────────────────────────────────────────────────────────

function cmdInit(cwd: string, args: string[]): number {
  const p = join(cwd, "milo.json");
  if (existsSync(p)) fail(`milo.json already exists in ${cwd}`);
  const name = args[0] ?? basename(resolve(cwd));
  const m: Manifest = { name, version: "0.1.0", deps: {} };
  writeFileSync(p, stringifyManifest(m));
  console.log(`created ${p}`);
  return 0;
}

function cmdNew(cwd: string, args: string[]): number {
  const name = args[0];
  if (!name) fail("usage: milo new <name>");
  const dir = resolve(cwd, name);
  if (existsSync(dir)) fail(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "milo.json"), stringifyManifest({ name: basename(dir), version: "0.1.0", deps: {} }));
  // print is a prelude builtin — no import needed, and importing it would be wrong.
  writeFileSync(join(dir, "main.milo"), `fn main() {\n    print("hello from ${basename(dir)}")\n}\n`);
  writeFileSync(join(dir, ".gitignore"), ["/vendor/", `/${basename(dir)}`, "*.o", "*.ll", "*.dSYM/", ""].join("\n"));
  console.log(`created ${dir}`);
  console.log(`  cd ${name} && milo run main.milo`);
  return 0;
}

async function cmdAdd(cwd: string, args: string[]): Promise<number> {
  const dev = args.includes("--dev");
  const specs = args.filter((a) => !a.startsWith("--"));
  if (specs.length === 0) fail("usage: milo add [--dev] <pkg>[@ver]");
  const project = requireProject(cwd);

  for (const spec of specs) {
    parseSource(spec); // validates the scheme before anything touches the network
    const { dir } = await ensurePresent(spec, project.dir, true);
    const manifest = readManifestAt(dir);
    const name = packageNameFor(spec, dir);
    if (manifest && manifest.lib === undefined && manifest.bin !== undefined) {
      fail(binOnlyMessage(name, spec));
    }
    checkCompilerConstraint(manifest);
    const table = dev ? "devDeps" : "deps";
    const existingTable = project.manifest[table] ?? {};
    existingTable[name] = spec;
    project.manifest[table] = existingTable;
    // A package moving between deps and devDeps must not end up in both.
    const other = dev ? project.manifest.deps : project.manifest.devDeps;
    if (other && other[name] !== undefined) delete other[name];
    console.log(`added ${name} ${spec}${dev ? " (dev)" : ""}`);
  }

  saveManifest(project);
  const lock = await resolveGraph(project, readLock(project.dir), { includeDev: true, refresh: new Set() });
  writeLock(project.dir, lock);
  console.log(`wrote ${lockPath(project.dir)} (${Object.keys(lock.packages).length} package(s))`);
  return 0;
}

async function cmdRemove(cwd: string, args: string[]): Promise<number> {
  const names = args.filter((a) => !a.startsWith("--"));
  if (names.length === 0) fail("usage: milo remove <pkg>");
  const project = requireProject(cwd);
  let removed = 0;
  for (const name of names) {
    let hit = false;
    for (const table of ["deps", "devDeps"] as const) {
      const t = project.manifest[table];
      if (t && t[name] !== undefined) {
        delete t[name];
        hit = true;
      }
    }
    if (!hit) fail(`'${name}' is not a dependency of ${project.manifest.name}`);
    removed++;
    console.log(`removed ${name}`);
  }
  if (removed > 0) {
    saveManifest(project);
    // Re-resolving from scratch prunes orphaned transitive entries for free.
    const lock = await resolveGraph(project, readLock(project.dir), { includeDev: true, refresh: new Set() });
    writeLock(project.dir, lock);
  }
  return 0;
}

async function cmdInstall(cwd: string, args: string[]): Promise<number> {
  const frozen = args.includes("--frozen");
  const stray = args.filter((a) => !a.startsWith("--"));
  if (stray.length > 0) {
    // Pure npm muscle memory. Both readings are plausible and both would be wrong
    // half the time, so refuse rather than guess.
    fail(`milo install syncs the current project and takes no package. ` +
         `Did you mean 'milo add ${stray[0]}' or 'milo tool install ${stray[0]}'?`);
  }
  const project = requireProject(cwd);
  const lock = readLock(project.dir);

  if (frozen) {
    const reason = lockStaleReason(project, lock);
    if (reason) fail(`milo.lock is out of date: ${reason}\n  run 'milo install' (without --frozen) to update it`);
    if (lock === null) {
      console.log("nothing to install");
      return 0;
    }
    await installFromLock(project, lock);
    console.log(`installed ${Object.keys(lock.packages).length} package(s) from milo.lock`);
    return 0;
  }

  const fresh = await resolveGraph(project, lock, { includeDev: true, refresh: new Set() });
  writeLock(project.dir, fresh);
  console.log(`installed ${Object.keys(fresh.packages).length} package(s)`);
  return 0;
}

// Sync the cache from the lock without re-resolving: every tree must land on the
// locked commit and hash to the locked digest.
async function installFromLock(project: Project, lock: Lockfile): Promise<void> {
  const specs = specsFromLock(project, lock);
  for (const [name, entry] of Object.entries(lock.packages)) {
    const spec = specs.get(name);
    if (spec === undefined) {
      fail(`'${name}' is in milo.lock but no milo.json declares it — run 'milo install' to re-resolve`);
    }
    const { dir, commit } = await ensurePresent(spec, project.dir, false);
    if (commit !== null && commit !== entry.commit && entry.commit !== "local") {
      fail(`'${name}' resolved to ${commit} but milo.lock pins ${entry.commit}`);
    }
    if (entry.commit !== "local") {
      const hash = sha256Tree(dir);
      if (hash !== entry.hash) {
        fail(`hash mismatch for '${name}'\n  locked ${entry.hash}\n  actual ${hash}`);
      }
    }
  }
}

// Spec strings live in manifests, not the lock (the cache key is the literal spec —
// see cacheDirForSpec), so gather them from the root plus each installed package.
function specsFromLock(project: Project, lock: Lockfile): Map<string, string> {
  const out = new Map<string, string>();
  for (const [n, s] of Object.entries(allDeps(project.manifest))) out.set(n, s);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, spec] of [...out]) {
      if (!lock.packages[name]) continue;
      const m = readManifestAt(cacheDirForSpec(spec));
      for (const [dn, ds] of Object.entries(m?.deps ?? {})) {
        if (!out.has(dn)) {
          out.set(dn, ds);
          grew = true;
        }
      }
    }
  }
  return out;
}

async function cmdUpdate(cwd: string, args: string[]): Promise<number> {
  const names = args.filter((a) => !a.startsWith("--"));
  const project = requireProject(cwd);
  const deps = allDeps(project.manifest);
  for (const n of names) {
    if (deps[n] === undefined) fail(`'${n}' is not a dependency of ${project.manifest.name}`);
  }

  // With git-as-registry there is no index to query: re-resolving a floating dep
  // means listing the remote's tags and taking the highest. A dep pinned to an
  // explicit ref stays pinned — updating it is a manifest edit, not an update.
  for (const [name, spec] of Object.entries(deps)) {
    if (names.length > 0 && !names.includes(name)) continue;
    const source = parseSource(spec);
    if ((source.kind === "git" || source.kind === "giturl") && source.ref === undefined) {
      const tags = listRemoteTags(source);
      if (tags.length > 0) {
        const newSpec = `${spec}@${tags[0]}`;
        const table = project.manifest.deps?.[name] !== undefined ? "deps" : "devDeps";
        project.manifest[table]![name] = newSpec;
        console.log(`${name}: ${spec} -> ${newSpec}`);
      }
    }
  }
  saveManifest(project);

  const refresh: Set<string> | "all" = names.length === 0 ? "all" : new Set(names);
  const lock = await resolveGraph(project, readLock(project.dir), { includeDev: true, refresh });
  writeLock(project.dir, lock);
  console.log(`updated ${Object.keys(lock.packages).length} package(s)`);
  return 0;
}

function cmdTree(cwd: string): number {
  const project = requireProject(cwd);
  const lock = readLock(project.dir);
  console.log(`${project.manifest.name} ${project.manifest.version}`);
  if (!lock || Object.keys(lock.packages).length === 0) {
    console.log("  (no dependencies)");
    return 0;
  }
  const roots = Object.keys(allDeps(project.manifest)).sort();
  const seen = new Set<string>();
  const walk = (name: string, prefix: string, last: boolean): void => {
    const e = lock.packages[name];
    const label = e ? `${name} ${e.version} (${e.url})` : `${name} (not installed)`;
    const cycle = seen.has(name);
    console.log(`${prefix}${last ? "└── " : "├── "}${label}${cycle ? " *" : ""}`);
    if (cycle || !e) return;
    seen.add(name);
    const kids = e.deps;
    kids.forEach((k, i) => walk(k, prefix + (last ? "    " : "│   "), i === kids.length - 1));
  };
  roots.forEach((r, i) => walk(r, "", i === roots.length - 1));
  return 0;
}

function cmdWhy(cwd: string, args: string[]): number {
  const target = args[0];
  if (!target) fail("usage: milo why <pkg>");
  const project = requireProject(cwd);
  const lock = readLock(project.dir);
  if (!lock || !lock.packages[target]) fail(`'${target}' is not in milo.lock`);

  const paths: string[][] = [];
  const walk = (name: string, trail: string[]): void => {
    if (trail.includes(name)) return;
    const next = [...trail, name];
    if (name === target) {
      paths.push(next);
      return;
    }
    for (const d of lock.packages[name]?.deps ?? []) walk(d, next);
  };
  for (const r of Object.keys(allDeps(project.manifest)).sort()) walk(r, [project.manifest.name]);

  if (paths.length === 0) {
    console.log(`${target} is in milo.lock but nothing depends on it`);
    return 1;
  }
  for (const p of paths) console.log(p.join(" -> "));
  return 0;
}

async function cmdVendor(cwd: string): Promise<number> {
  const project = requireProject(cwd);
  let lock = readLock(project.dir);
  if (lock === null || lockStaleReason(project, lock) !== null) {
    lock = await resolveGraph(project, lock, { includeDev: true, refresh: new Set() });
    writeLock(project.dir, lock);
  }
  const specs = specsFromLock(project, lock);
  const vendorDir = join(project.dir, "vendor");
  mkdirSync(vendorDir, { recursive: true });

  for (const name of Object.keys(lock.packages)) {
    const spec = specs.get(name);
    if (spec === undefined) continue;
    const from = cacheDirForSpec(spec);
    if (!existsSync(from)) fail(`'${name}' is not installed — run 'milo install' first`);
    const to = join(vendorDir, name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    // Rewrite the vendored package's own deps to the same "./vendor/<name>" spelling
    // the root uses. The cache key is the literal spec string, so every package that
    // names "./vendor/x" shares one entry — which is what makes this flat and works
    // regardless of which directory the reference is written in.
    const m = readManifestAt(to);
    if (m && m.deps) {
      for (const dn of Object.keys(m.deps)) m.deps[dn] = `./vendor/${dn}`;
      writeFileSync(join(to, "milo.json"), stringifyManifest(m));
    }
    console.log(`vendored ${name} -> vendor/${name}`);
  }

  for (const table of ["deps", "devDeps"] as const) {
    const t = project.manifest[table];
    if (!t) continue;
    for (const n of Object.keys(t)) t[n] = `./vendor/${n}`;
  }
  saveManifest(project);
  const relocked = await resolveGraph(project, null, { includeDev: true, refresh: "all" });
  writeLock(project.dir, relocked);
  console.log(`rewrote ${project.manifestPath} to local paths`);
  return 0;
}

function cmdPublish(cwd: string, args: string[], host: PkgHost): number {
  const dryRun = args.includes("--dry-run");
  const project = requireProject(cwd);
  const m = project.manifest;

  if (!isPublishable(m)) fail(`${m.name} declares neither 'lib' nor 'bin' — there is nothing to publish`);
  if (!m.license) fail(`${m.name} has no 'license' field`);
  const entries: string[] = [];
  if (m.lib !== undefined) entries.push(m.lib);
  for (const b of Object.values(m.bin ?? {})) entries.push(b);
  for (const e of entries) {
    if (!existsSync(join(project.dir, e))) fail(`'${e}' is declared in milo.json but does not exist`);
  }

  const status = spawnSync("git", ["status", "--porcelain"], { cwd: project.dir, encoding: "utf-8" });
  if (status.status !== 0) fail(`not a git repository: ${project.dir}`);
  if ((status.stdout ?? "").trim().length > 0) fail("working tree is dirty — commit or stash before publishing");

  const tag = `v${m.version}`;
  const existingTag = spawnSync("git", ["tag", "--list", tag], { cwd: project.dir, encoding: "utf-8" });
  if ((existingTag.stdout ?? "").trim().length > 0) fail(`tag ${tag} already exists — bump 'version' in milo.json`);

  // Smoke test: the package must at least type-check standalone, so a broken release
  // fails here rather than in a consumer's build.
  for (const e of entries) host.check(join(project.dir, e));
  console.log(`checked ${entries.length} entry point(s)`);

  if (dryRun) {
    console.log(`dry run: would tag ${tag} and push`);
    return 0;
  }
  const tagged = spawnSync("git", ["tag", tag], { cwd: project.dir, encoding: "utf-8" });
  if (tagged.status !== 0) fail(`git tag failed: ${tagged.stderr ?? ""}`);
  const pushed = spawnSync("git", ["push", "origin", tag], { cwd: project.dir, encoding: "utf-8" });
  if (pushed.status !== 0) fail(`git push failed: ${pushed.stderr ?? ""}`);
  console.log(`published ${m.name} ${tag}`);
  return 0;
}

// ── milo tool ────────────────────────────────────────────────────────────────

async function cmdTool(cwd: string, args: string[], host: PkgHost): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "install":
      return await toolInstall(cwd, rest, host);
    case "uninstall":
      return toolUninstall(rest);
    case "list":
      return toolList(rest);
    case "run":
      return await toolRun(cwd, rest, host);
    default:
      fail("usage: milo tool <install|uninstall|list|run> ...");
  }
}

// Resolve a spec to its cached tree + manifest, requiring installable binaries.
async function toolPackage(spec: string, cwd: string): Promise<{ dir: string; manifest: Manifest; commit: string }> {
  const project = findProject(cwd);
  const { dir, commit } = await ensurePresent(spec, project?.dir ?? cwd, true);
  const manifest = readManifestAt(dir);
  if (!manifest) fail(`${spec} has no milo.json — cannot tell what to install`);
  if (manifest.bin === undefined || Object.keys(manifest.bin).length === 0) {
    fail(libOnlyMessage(manifest.name, spec));
  }
  checkCompilerConstraint(manifest);
  return { dir, manifest, commit: commit ?? "unknown" };
}

async function toolInstall(cwd: string, args: string[], host: PkgHost): Promise<number> {
  const { value: only, rest } = extractFlag(args, "--bin");
  const specs = rest.filter((a) => !a.startsWith("--"));
  const force = rest.includes("--force");
  if (specs.length === 0) fail("usage: milo tool install <pkg>[@ver] [--bin <name>]");

  const dir = binRoot();
  mkdirSync(dir, { recursive: true });
  const receipts = readReceipts();

  for (const spec of specs) {
    const { dir: pkgDir, manifest, commit } = await toolPackage(spec, cwd);
    const bins = Object.entries(manifest.bin!).filter(([n]) => only === null || n === only);
    if (bins.length === 0) fail(`${manifest.name} has no binary named '${only}'`);

    // Deps of the tool are its own business, but they must be on disk before its
    // binaries can compile.
    await installToolDeps(manifest, pkgDir);

    for (const [binName, relSource] of bins) {
      const exe = host.os === "windows" ? `${binName}.exe` : binName;
      const target = join(dir, exe);
      const clash = existingBinaryConflict(target, manifest.name);
      if (clash !== null && !force) fail(clash);

      const meta: PkgSection = {
        name: manifest.name,
        version: manifest.version,
        url: specUrl(spec),
        commit,
        bin: binName,
      };
      const work = join(tmpdir(), `milo-tool-${randomUUID().slice(0, 8)}`);
      mkdirSync(work, { recursive: true });
      try {
        const obj = buildMetaObject(meta, host.os, work);
        const staged = join(work, exe);
        const src = join(pkgDir, relSource);
        if (!existsSync(src)) fail(`${manifest.name}: bin '${binName}' points at missing file '${relSource}'`);
        const built = host.build(src, staged, [obj]);
        if (readPkgSection(built) === null) {
          fail(`internal: built ${binName} without a ${PKG_TAG} section — refusing to install an unidentifiable binary`);
        }
        copyFileSync(built, target);
        chmodSync(target, 0o755);
        receipts.tools[exe] = { ...meta, path: target };
        console.log(`installed ${binName} ${manifest.version} -> ${target}`);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  }

  writeReceipts(receipts);
  const advice = pathAdvice(dir);
  if (advice) console.log(advice);
  return 0;
}

// Why the target path cannot be written, or null when it is safe to.
function existingBinaryConflict(target: string, pkgName: string): string | null {
  if (!existsSync(target)) return null;
  const sec = readPkgSection(target);
  if (sec === null) {
    return `refusing to overwrite ${target}: it carries no ${PKG_TAG} section, so milo did not install it\n` +
           `  remove it yourself, or pass --force`;
  }
  if (sec.name !== pkgName) {
    return `refusing to overwrite ${target}: it is ${sec.name} ${sec.version} (${sec.url}), not ${pkgName}\n` +
           `  uninstall it first: milo tool uninstall ${sec.bin}`;
  }
  return null;
}

// A tool's own library deps must be in the cache before its bins can compile.
// rootDir stays fixed down the whole closure — the same rule resolveGraph follows,
// because the cache key is the literal spec string (see cacheDirForSpec), so a
// relative path has to mean one thing per dependency tree.
async function installToolDeps(manifest: Manifest, rootDir: string, seen = new Set<string>()): Promise<void> {
  for (const [name, spec] of Object.entries(manifest.deps ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    const { dir } = await ensurePresent(spec, rootDir, false);
    const sub = readManifestAt(dir);
    if (sub && sub.lib === undefined && sub.bin !== undefined) fail(binOnlyMessage(name, spec));
    if (sub) await installToolDeps(sub, rootDir, seen);
  }
}

function toolUninstall(args: string[]): number {
  const names = args.filter((a) => !a.startsWith("--"));
  if (names.length === 0) fail("usage: milo tool uninstall <name>");
  const dir = binRoot();
  const receipts = readReceipts();
  let removed = 0;

  for (const name of names) {
    // Candidates: the literal filename, plus anything the cache believes belongs to
    // this package. Every candidate is then re-verified against its own section —
    // the cache only narrows the search, it never authorizes a delete.
    const candidates = new Set<string>();
    for (const ext of ["", ".exe"]) {
      const p = join(dir, name + ext);
      if (existsSync(p)) candidates.add(p);
    }
    for (const [file, t] of Object.entries(receipts.tools)) {
      if (t.name === name || t.bin === name) candidates.add(join(dir, file));
    }
    if (candidates.size === 0) fail(`'${name}' is not installed in ${dir}`);

    for (const p of candidates) {
      if (!existsSync(p)) {
        // A receipt for a file someone deleted by hand: drop the stale row, and say so.
        delete receipts.tools[basename(p)];
        console.log(`${p} was already gone — dropped its receipt`);
        continue;
      }
      const sec = readPkgSection(p);
      if (sec === null) {
        fail(`refusing to remove ${p}: it carries no ${PKG_TAG} section, so milo did not install it`);
      }
      if (sec.name !== name && sec.bin !== name) {
        fail(`refusing to remove ${p}: it is ${sec.name}'s '${sec.bin}' command, not '${name}'`);
      }
      unlinkSync(p);
      delete receipts.tools[basename(p)];
      removed++;
      console.log(`removed ${p} (${sec.name} ${sec.version})`);
    }
  }

  writeReceipts(receipts);
  return removed > 0 ? 0 : 1;
}

function toolList(args: string[]): number {
  const receipts = args.includes("--repair") ? repairReceipts() : readReceipts();
  if (args.includes("--repair")) console.log(`rebuilt ${receiptsPath()} from ${binRoot()}`);
  const dir = binRoot();
  const rows: string[] = [];
  for (const [file, cached] of Object.entries(receipts.tools)) {
    const p = join(dir, file);
    // The section wins on any disagreement; the cache is only an index.
    const sec = readPkgSection(p);
    if (sec === null) {
      rows.push(`${file}  (missing or no ${PKG_TAG} section — run 'milo tool list --repair')`);
      continue;
    }
    const drift = sec.name !== cached.name || sec.version !== cached.version ? "  [cache stale]" : "";
    rows.push(`${file}  ${sec.name} ${sec.version}  ${sec.url}${sec.commit ? "@" + sec.commit.slice(0, 12) : ""}${drift}`);
  }
  if (rows.length === 0) {
    console.log(`no tools installed in ${dir}`);
    return 0;
  }
  for (const r of rows.sort()) console.log(r);
  return 0;
}

async function toolRun(cwd: string, args: string[], host: PkgHost): Promise<number> {
  // Everything after the package spec belongs to the tool, verbatim — so milo's own
  // flags have to come before it. Otherwise `milo tool run grep --bin x` is ambiguous
  // between selecting a binary and passing an argument through.
  let i = 0;
  let only: string | null = null;
  while (i < args.length && args[i].startsWith("--")) {
    if (args[i] === "--bin") only = args[++i] ?? null;
    else if (args[i].startsWith("--bin=")) only = args[i].slice(6);
    i++;
  }
  const spec = args[i];
  if (!spec) fail("usage: milo tool run [--bin <name>] <pkg>[@ver] [args...]");
  const passthrough = args.slice(i + 1);
  const { dir: pkgDir, manifest } = await toolPackage(spec, cwd);
  const bins = Object.entries(manifest.bin!);
  const chosen = only !== null ? bins.find(([n]) => n === only) : bins.length === 1 ? bins[0] : undefined;
  if (!chosen) {
    fail(`${manifest.name} ships ${bins.length} binaries (${bins.map(([n]) => n).join(", ")}) — pick one with --bin <name>`);
  }
  await installToolDeps(manifest, pkgDir);

  const work = join(tmpdir(), `milo-toolrun-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  try {
    const built = host.build(join(pkgDir, chosen[1]), join(work, chosen[0]), []);
    const r = spawnSync(built, passthrough, { stdio: "inherit" });
    return r.status ?? 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── Compiler version constraint ──────────────────────────────────────────────

// The version of this compiler, when it is knowable. A dev checkout has no .version
// file, and inventing one would turn `"milo": ">=0.4.0"` into a false rejection —
// so an unknown version skips the check rather than guessing.
function compilerVersion(): string | null {
  const root = process.env.MILO_ROOT ?? resolve(dirname(new URL(import.meta.url).pathname), "..");
  const p = join(root, ".version");
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf-8").trim();
  return v.length > 0 ? v : null;
}

function checkCompilerConstraint(m: Manifest | null): void {
  if (!m || m.milo === undefined) return;
  const have = compilerVersion();
  if (have === null) return;
  if (!satisfies(have, m.milo)) {
    fail(`${m.name} needs milo ${m.milo}, you have ${have}`);
  }
}

export function satisfies(version: string, constraint: string): boolean {
  const m = /^\s*(>=|<=|>|<|=|\^)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(constraint);
  if (!m) return true; // an unparseable constraint is not a licence to block the user
  const want: [number, number, number] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  const hv = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!hv) return true;
  const have: [number, number, number] = [Number(hv[1]), Number(hv[2] ?? 0), Number(hv[3] ?? 0)];
  const cmp = have[0] - want[0] || have[1] - want[1] || have[2] - want[2];
  switch (m[1] ?? "=") {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "^": return have[0] === want[0] && cmp >= 0;
    default: return cmp === 0;
  }
}

// ── Auto-install on run/build ────────────────────────────────────────────────

// bun/uv behavior: a missing locked dependency is fetched rather than reported.
// Silent no-op when there is no project, no deps, or nothing missing, because this
// runs before every `milo run` and `milo build`.
export async function ensureDepsInstalled(sourcePath: string): Promise<void> {
  let project: Project | null;
  try {
    project = findProject(dirname(resolve(sourcePath)));
  } catch {
    // A milo.json that doesn't parse must not break `milo build` for a file that
    // never needed it — resolver.ts:findManifest tolerates the same thing.
    return;
  }
  if (!project) return;
  const deps = allDeps(project.manifest);
  if (Object.keys(deps).length === 0) return;

  const lock = readLock(project.dir);
  if (lock === null || lockStaleReason(project, lock) !== null) {
    console.error(`installing dependencies for ${project.manifest.name}...`);
    writeLock(project.dir, await resolveGraph(project, lock, { includeDev: true, refresh: new Set() }));
    return;
  }
  const specs = specsFromLock(project, lock);
  const missing = [...specs].filter(([, spec]) => !existsSync(cacheDirForSpec(spec)));
  if (missing.length === 0) return;
  console.error(`installing ${missing.length} missing package(s)...`);
  await installFromLock(project, lock);
}

// ── Entry point ──────────────────────────────────────────────────────────────

// Pull "--flag value" / "--flag=value" out of an argv, returning the rest. Taking
// the value OUT matters: a plain `!a.startsWith("--")` filter would otherwise read
// the value of --bin as a second package spec.
function extractFlag(args: string[], flag: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      value = args[++i];
    } else if (args[i].startsWith(flag + "=")) {
      value = args[i].slice(flag.length + 1);
    } else {
      rest.push(args[i]);
    }
  }
  return { value, rest };
}

export const PKG_COMMANDS = new Set([
  "init", "new", "add", "remove", "install", "update", "tree", "why", "vendor", "publish", "tool",
]);

export async function runPkgCommand(cmd: string, args: string[], host: PkgHost): Promise<number> {
  const cwd = process.cwd();
  try {
    switch (cmd) {
      case "init": return cmdInit(cwd, args);
      case "new": return cmdNew(cwd, args);
      case "add": return await cmdAdd(cwd, args);
      case "remove": return await cmdRemove(cwd, args);
      case "install": return await cmdInstall(cwd, args);
      case "update": return await cmdUpdate(cwd, args);
      case "tree": return cmdTree(cwd);
      case "why": return cmdWhy(cwd, args);
      case "vendor": return await cmdVendor(cwd);
      case "publish": return cmdPublish(cwd, args, host);
      case "tool": return await cmdTool(cwd, args, host);
      default:
        console.error(`error: unknown package command '${cmd}'`);
        return 1;
    }
  } catch (e) {
    if (e instanceof PkgError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
