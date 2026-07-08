// resolves import declarations by recursively parsing imported files
// and merging all declarations into a single program

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { Program } from "./ast";
import type { TargetInfo } from "./target";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

// repo root: walk up from src/ to find the directory containing std/.
// MILO_ROOT overrides for contexts where import.meta.url doesn't map to the repo
// (e.g. a `bun build --compile` binary, whose module URLs point into the bundle).
const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(new URL(import.meta.url).pathname), "..");
const CACHE_DIR = resolve(homedir(), ".milo", "cache");

// embedded stdlib for compiled binaries (populated by scripts/bundle-stdlib.ts).
// Always loaded when present, but used only as a FALLBACK — disk always wins (see
// readSource / resolveImportPath), so a dev checkout with std/ on disk never
// serves stale bundled code, while a shipped `bun build --compile` binary (no
// std/ on disk) resolves the stdlib from here with no env flag needed.
let STDLIB_BUNDLE: Map<string, string> | null = null;
try {
  STDLIB_BUNDLE = require("./stdlib-bundle").STDLIB;
} catch {}

function toStdlibKey(absPath: string): string | null {
  return absPath.startsWith(STDLIB_DIR + "/") ? absPath.slice(STDLIB_DIR.length + 1) : null;
}

function bundleExists(absPath: string): boolean {
  if (!STDLIB_BUNDLE) return false;
  const key = toStdlibKey(absPath);
  return key !== null && STDLIB_BUNDLE.has(key);
}

function readSource(absPath: string): string {
  // Disk wins; bundle is the fallback for when the file isn't on disk.
  if (existsSync(absPath)) return readFileSync(absPath, "utf-8");
  if (STDLIB_BUNDLE) {
    const key = toStdlibKey(absPath);
    if (key) {
      const content = STDLIB_BUNDLE.get(key);
      if (content !== undefined) return content;
    }
  }
  return readFileSync(absPath, "utf-8");
}

// find milo.json by walking up from sourceDir
function findManifest(startDir: string): Record<string, string> | null {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const manifestPath = resolve(dir, "milo.json");
    if (existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        return raw.deps ?? {};
      } catch { return null; }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// parse "github.com/user/repo@v1.0" or local path → { host, path, version }
function parsePkgUrl(url: string): { host: string; path: string; version: string } | null {
  const atIdx = url.indexOf("@");
  let version = "main";
  let fullPath = url;
  if (atIdx !== -1) {
    version = url.slice(atIdx + 1);
    fullPath = url.slice(0, atIdx);
  }
  // local paths
  if (fullPath.startsWith("/") || fullPath.startsWith(".")) {
    const safe = fullPath.replace(/\//g, "_");
    return { host: "local", path: safe, version };
  }
  const slashIdx = fullPath.indexOf("/");
  if (slashIdx === -1) return null;
  return { host: fullPath.slice(0, slashIdx), path: fullPath.slice(slashIdx + 1), version };
}

export function resolveImports(program: Program, sourceDir: string, target: TargetInfo, entryFile?: string): Program {
  const visited = new Set<string>();
  const structs: typeof program.structs = [];
  const enums: typeof program.enums = [];
  const functions: typeof program.functions = [];
  const traits: typeof program.traits = [];
  const impls: typeof program.impls = [];
  const typeAliases: typeof program.typeAliases = [];
  const interfaces: typeof program.interfaces = [];
  const globals: typeof program.globals = [];

  const deps = findManifest(sourceDir);

  function resolvePath(dir: string, importPath: string): string {
    const withExt = importPath.endsWith(".milo") ? importPath : importPath + ".milo";

    // check if import starts with a known package name from milo.json
    if (deps) {
      const firstSlash = importPath.indexOf("/");
      const pkgName = firstSlash !== -1 ? importPath.slice(0, firstSlash) : importPath;
      const pkgUrl = deps[pkgName];
      if (pkgUrl) {
        const parsed = parsePkgUrl(pkgUrl);
        if (parsed) {
          const cacheBase = resolve(CACHE_DIR, parsed.host, parsed.path, parsed.version);
          // import "pkg/module" → ~/.milo/cache/host/org/repo/version/module.milo
          const subPath = firstSlash !== -1 ? importPath.slice(firstSlash + 1) : "";
          if (subPath) {
            const pkgPath = resolve(cacheBase, subPath + ".milo");
            if (existsSync(pkgPath)) return pkgPath;
            const platformPath = resolve(cacheBase, `${subPath}.${target.os}.milo`);
            if (existsSync(platformPath)) return platformPath;
          } else {
            // import "pkg" → look for pkg/lib.milo or pkg/pkg.milo
            const libPath = resolve(cacheBase, "lib.milo");
            if (existsSync(libPath)) return libPath;
            const namedPath = resolve(cacheBase, `${pkgName}.milo`);
            if (existsSync(namedPath)) return namedPath;
          }
        }
      }
    }

    let absPath = resolve(dir, withExt);
    if (!existsSync(absPath)) {
      // for stdlib paths, try platform-specific file first (e.g. platform.darwin.milo)
      const base = withExt.replace(/\.milo$/, "");
      const platformPath = resolve(STDLIB_DIR, `${base}.${target.os}.milo`);
      if (bundleExists(platformPath) || existsSync(platformPath)) return platformPath;
      const stdPath = resolve(STDLIB_DIR, withExt);
      if (bundleExists(stdPath) || existsSync(stdPath)) absPath = stdPath;
    }
    return absPath;
  }

  function processImports(prog: Program, dir: string) {
    for (const imp of prog.imports) {
      const absPath = resolvePath(dir, imp.path);
      if (visited.has(absPath)) continue;
      visited.add(absPath);

      let source: string;
      try {
        source = readSource(absPath);
      } catch {
        throw new Error(`error[import]: ${imp.span?.line}:${imp.span?.col}: cannot open '${imp.path}'`);
      }

      const tokens = new Lexer(source).tokenize();
      const imported = new Parser(tokens, source, absPath).parse();

      if (imp.names) {
        // validate that all named symbols exist in the imported module
        const available = new Set<string>();
        for (const s of imported.structs) available.add(s.name);
        for (const e of imported.enums) available.add(e.name);
        for (const f of imported.functions) available.add(f.name);
        for (const t of imported.traits) available.add(t.name);
        for (const i of imported.interfaces) available.add(i.name);
        for (const g of imported.globals) available.add(g.name);
        for (const name of imp.names) {
          if (!available.has(name)) {
            throw new Error(`error[import]: ${imp.span?.line}:${imp.span?.col}: '${name}' not found in '${imp.path}'`);
          }
        }
      }
      // merge everything — named imports validate but don't restrict (flat compilation)
      for (const f of imported.functions) f.sourceFile = absPath;
      structs.push(...imported.structs);
      enums.push(...imported.enums);
      functions.push(...imported.functions);
      traits.push(...imported.traits);
      impls.push(...imported.impls);
      typeAliases.push(...imported.typeAliases);
      interfaces.push(...imported.interfaces);
      globals.push(...imported.globals);
      processImports(imported, dirname(absPath));
    }
  }

  // inject prelude before user code so user definitions override via last-wins
  const preludePath = resolve(STDLIB_DIR, "std/prelude.milo");
  if (!visited.has(preludePath) && (bundleExists(preludePath) || existsSync(preludePath))) {
    visited.add(preludePath);
    const src = readSource(preludePath);
    const prelude = new Parser(new Lexer(src).tokenize()).parse();
    for (const f of prelude.functions) f.sourceFile = preludePath;
    structs.push(...prelude.structs);
    enums.push(...prelude.enums);
    functions.push(...prelude.functions);
    traits.push(...prelude.traits);
    impls.push(...prelude.impls);
    typeAliases.push(...prelude.typeAliases);
    interfaces.push(...prelude.interfaces);
    globals.push(...prelude.globals);
    processImports(prelude, dirname(preludePath));
  }
  // everything visited so far came in through the prelude (it's processed first);
  // user redefinition of these names is the documented last-wins override path
  const preludeFiles = new Set(visited);
  preludeFiles.add(preludePath);

  // user code comes after prelude
  for (const f of program.functions) f.sourceFile = entryFile ?? "(entry module)";
  structs.push(...program.structs);
  enums.push(...program.enums);
  functions.push(...program.functions);
  traits.push(...program.traits);
  impls.push(...program.impls);
  typeAliases.push(...program.typeAliases);
  interfaces.push(...program.interfaces);
  globals.push(...program.globals);

  processImports(program, sourceDir);

  // Same-name top-level fns from different modules would silently merge below
  // (dedup keeps one body and every call site runs it — issue #5). Identical
  // bodies merge harmlessly, so only reject when the bodies actually differ.
  // Exemptions: prelude + its transitive imports (user redefinition is the
  // documented override path) and externs (redeclarations all bind the same C symbol).
  const stripForCompare = (k: string, v: unknown) =>
    k === "span" || k === "sourceFile" ? undefined : typeof v === "bigint" ? `${v}n` : v;
  const fnDefs = new Map<string, { file: string; body: string }>();
  for (const f of functions) {
    if (f.isExtern || (f.sourceFile && preludeFiles.has(f.sourceFile))) continue;
    const body = JSON.stringify(f, stripForCompare);
    const prev = fnDefs.get(f.name);
    if (prev && prev.body !== body && prev.file !== f.sourceFile) {
      throw new Error(
        `error[duplicate-fn]: 'fn ${f.name}' is defined with different bodies in '${prev.file}' and '${f.sourceFile}'.\n` +
        `  milo compiles all modules into one namespace, so only one body would survive and both call sites would run it.\n` +
        `  rename one of them, or move the shared implementation into a single module both files import.`
      );
    }
    if (!prev) fnDefs.set(f.name, { file: f.sourceFile ?? "(unknown)", body });
  }

  // dedup: keep last occurrence of each name (user wins over prelude)
  function dedup<T extends { name: string }>(arr: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!seen.has(arr[i].name)) {
        seen.add(arr[i].name);
        result.unshift(arr[i]);
      }
    }
    return result;
  }

  const userFnNames = new Set(program.functions.map(f => f.name));
  // `program` here is still the user's pre-merge AST (imports were pushed into
  // the separate arrays above), so its impls are the user's own.
  const userImplKeys = new Set<string>();
  for (const impl of program.impls) for (const m of impl.methods) userImplKeys.add(`${impl.typeName}.${m.name}`);
  return { structs: dedup(structs), enums: dedup(enums), functions: dedup(functions), imports: [], traits: dedup(traits), impls, typeAliases: dedup(typeAliases), interfaces: dedup(interfaces), globals: dedup(globals), userFnNames, userImplKeys };
}
