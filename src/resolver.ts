// resolves import declarations by recursively parsing imported files
// and merging all declarations into a single program

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { cacheRoot } from "./pkg";
import type { Program, Span, DeclOrigins, DeclOrigin } from "./ast";
import { ParseError } from "./diagnostics";
import type { TargetInfo } from "./target";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { collectPkgDecls, emptyPkgDecls, manglePackage, type PkgDeclNames } from "./mangle";

// repo root: walk up from src/ to find the directory containing std/.
// MILO_ROOT overrides for contexts where import.meta.url doesn't map to the repo
// (e.g. a `bun build --compile` binary, whose module URLs point into the bundle).
const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(new URL(import.meta.url).pathname), "..");
// Read path for installed packages. Shares cacheRoot() with the installer in
// src/pkg.ts — it used to hardcode ~/.milo/cache, which silently diverged from the
// writer whenever XDG_CACHE_HOME was set, leaving installed packages unresolvable.
// Read per call, not once at module load, so a test can point it elsewhere.
function cacheDir(): string {
  return cacheRoot();
}

// embedded stdlib for compiled binaries (populated by scripts/bundle-stdlib.ts).
// Loaded ONLY when std/ isn't on disk (a shipped `bun build --compile` binary).
// In a dev checkout the on-disk std/ is authoritative and the bundle is ignored
// entirely — otherwise the gitignored, build-time stdlib-bundle.ts would linger
// and silently resurrect deleted/renamed std files against a stale copy.
let STDLIB_BUNDLE: Map<string, string> | null = null;
try {
  if (!existsSync(resolve(STDLIB_DIR, "std"))) STDLIB_BUNDLE = require("./stdlib-bundle").STDLIB;
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

export function resolveImports(program: Program, sourceDir: string, target: TargetInfo, entryFile?: string | null): Program {
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

  // Visibility index, filled as each file is parsed — i.e. before the dedup and
  // last-wins override below discard same-named decls. See DeclOrigins in ast.ts.
  const declOrigins: DeclOrigins = { values: new Map(), types: new Map() };
  function note(m: Map<string, DeclOrigin>, name: string, isPub: boolean | undefined, file: string) {
    let e = m.get(name);
    if (!e) { e = { files: new Set(), anyPub: false }; m.set(name, e); }
    e.files.add(file);
    if (isPub) e.anyPub = true;
  }
  function recordDecls(p: Program, file: string) {
    for (const f of p.functions) note(declOrigins.values, f.name, f.isPub, file);
    for (const g of p.globals) note(declOrigins.values, g.name, g.isPub, file);
    for (const s of p.structs) note(declOrigins.types, s.name, s.isPub, file);
    for (const e of p.enums) note(declOrigins.types, e.name, e.isPub, file);
    for (const t of p.traits) note(declOrigins.types, t.name, t.isPub, file);
    for (const i of p.interfaces) note(declOrigins.types, i.name, i.isPub, file);
    for (const a of p.typeAliases) note(declOrigins.types, a.name, a.isPub, file);
  }

  // A parsed file plus the package it belongs to. Files are collected here and
  // merged only after the whole graph is known, because per-package mangling
  // needs every file of a package in hand before it can rewrite any of them: an
  // intra-package reference may name a decl that lives in a sibling file.
  interface Unit {
    prog: Program;
    file: string;
    pkg: string;
    // Imports of a mangled package, recorded even when the target file was
    // already visited — the binding belongs to the importing file, not the
    // import graph.
    targets: { names: string[]; aliases?: (string | undefined)[]; pkg: string }[];
  }
  const units: Unit[] = [];

  // `pkg` is the importing file's package id. A file resolved out of a manifest
  // `deps` entry belongs to that dep; anything the dep then resolves against its
  // own directory (`./x`, `../y`, or a bare sibling module) stays inside it; std
  // and the prelude are always "" and are never mangled.
  function resolvePath(dir: string, importPath: string, pkg: string): { path: string; pkg: string } {
    const withExt = importPath.endsWith(".milo") ? importPath : importPath + ".milo";

    // check if import starts with a known package name from milo.json
    if (deps) {
      const firstSlash = importPath.indexOf("/");
      const pkgName = firstSlash !== -1 ? importPath.slice(0, firstSlash) : importPath;
      const pkgUrl = deps[pkgName];
      if (pkgUrl) {
        const parsed = parsePkgUrl(pkgUrl);
        if (parsed) {
          const cacheBase = resolve(cacheDir(), parsed.host, parsed.path, parsed.version);
          // import "pkg/module" → ~/.milo/cache/host/org/repo/version/module.milo
          const subPath = firstSlash !== -1 ? importPath.slice(firstSlash + 1) : "";
          if (subPath) {
            const pkgPath = resolve(cacheBase, subPath + ".milo");
            if (existsSync(pkgPath)) return { path: pkgPath, pkg: pkgName };
            const platformPath = resolve(cacheBase, `${subPath}.${target.os}.milo`);
            if (existsSync(platformPath)) return { path: platformPath, pkg: pkgName };
          } else {
            // import "pkg" → look for pkg/lib.milo or pkg/pkg.milo
            const libPath = resolve(cacheBase, "lib.milo");
            if (existsSync(libPath)) return { path: libPath, pkg: pkgName };
            const namedPath = resolve(cacheBase, `${pkgName}.milo`);
            if (existsSync(namedPath)) return { path: namedPath, pkg: pkgName };
          }
        }
      }
    }

    const absPath = resolve(dir, withExt);
    if (!existsSync(absPath)) {
      // for stdlib paths, try platform-specific file first (e.g. platform.darwin.milo)
      const base = withExt.replace(/\.milo$/, "");
      const platformPath = resolve(STDLIB_DIR, `${base}.${target.os}.milo`);
      if (bundleExists(platformPath) || existsSync(platformPath)) return { path: platformPath, pkg: "" };
      const stdPath = resolve(STDLIB_DIR, withExt);
      if (bundleExists(stdPath) || existsSync(stdPath)) return { path: stdPath, pkg: "" };
    }
    return { path: absPath, pkg };
  }

  function processImports(prog: Program, dir: string, pkg: string, unit: Unit) {
    for (const imp of prog.imports) {
      const resolved = resolvePath(dir, imp.path, pkg);
      const absPath = resolved.path;
      if (resolved.pkg !== "" && imp.names) {
        unit.targets.push({ names: imp.names, aliases: imp.aliases, pkg: resolved.pkg });
      }
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
      const child: Unit = { prog: imported, file: absPath, pkg: resolved.pkg, targets: [] };
      units.push(child);
      processImports(imported, dirname(absPath), resolved.pkg, child);
    }
  }

  // inject prelude before user code so user definitions override via last-wins
  const preludePath = resolve(STDLIB_DIR, "std/prelude.milo");
  if (!visited.has(preludePath) && (bundleExists(preludePath) || existsSync(preludePath))) {
    visited.add(preludePath);
    const src = readSource(preludePath);
    const prelude = new Parser(new Lexer(src).tokenize(), src, preludePath).parse();
    for (const f of prelude.functions) f.sourceFile = preludePath;
    const preludeUnit: Unit = { prog: prelude, file: preludePath, pkg: "", targets: [] };
    units.push(preludeUnit);
    processImports(prelude, dirname(preludePath), "", preludeUnit);
  }
  // everything visited so far came in through the prelude (it's processed first);
  // user redefinition of these names is the documented last-wins override path
  const preludeFiles = new Set(visited);
  preludeFiles.add(preludePath);

  // user code comes after prelude
  for (const f of program.functions) f.sourceFile = entryFile ?? "(entry module)";
  const entryUnit: Unit = { prog: program, file: entryFile ?? "(entry module)", pkg: "", targets: [] };
  units.push(entryUnit);

  processImports(program, sourceDir, "", entryUnit);

  // Imported names the entry file never mentions. Computed here because this is the last
  // point the entry's own AST exists apart from the merged one — and, since mangling
  // rewrites references in place, the last point its names are still as written.
  //
  // Deliberately over-broad about what counts as a use: it collects every string anywhere
  // in the entry AST, so a name that only appears in a type annotation, an enum variant,
  // or even a string literal reads as used. That direction is the safe one — this lint can
  // miss a genuinely unused import, but it will not tell you to delete one you need.
  const usedStrings = new Set<string>();
  const collectStrings = (node: any, seen = new Set<any>()) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === "kind") continue;
      if (typeof v === "string") usedStrings.add(v);
      else if (Array.isArray(v)) v.forEach(x => collectStrings(x, seen));
      else if (v && typeof v === "object") collectStrings(v, seen);
    }
  };
  for (const key of ["structs", "enums", "functions", "traits", "impls", "typeAliases", "interfaces", "globals"]) {
    for (const decl of (program as any)[key] ?? []) collectStrings(decl);
  }
  const unusedImports: { name: string; path: string; span?: Span }[] = [];
  for (const imp of program.imports) {
    for (let i = 0; i < imp.names.length; i++) {
      // `import { a as b }` binds `b`; the entry file never writes `a`.
      const local = imp.aliases?.[i] ?? imp.names[i];
      if (!usedStrings.has(local)) unusedImports.push({ name: imp.names[i], path: imp.path, span: imp.span });
    }
  }

  // ── per-package mangling (docs/plans/package-manager.md §P0) ──
  // Index every package's top-level names first: an intra-package reference is
  // rewritten only when the name is declared *somewhere* in that package, and a
  // cross-package import binds only names the target package actually mangled
  // (an `extern`/`@export` fn keeps its written name).
  const pkgDecls = new Map<string, PkgDeclNames>();
  for (const u of units) {
    if (u.pkg === "") continue;
    let d = pkgDecls.get(u.pkg);
    if (!d) { d = emptyPkgDecls(); pkgDecls.set(u.pkg, d); }
    collectPkgDecls(u.prog, d);
  }
  const packageNames = new Set(pkgDecls.keys());

  if (packageNames.size > 0) {
    for (const u of units) {
      const bindings = new Map<string, string>();
      for (const t of u.targets) {
        const d = pkgDecls.get(t.pkg);
        if (!d) continue;
        for (let i = 0; i < t.names.length; i++) {
          const n = t.names[i];
          if (!d.values.has(n) && !d.types.has(n)) continue;
          bindings.set(t.aliases?.[i] ?? n, `${t.pkg}$${n}`);
        }
      }
      manglePackage(u.prog, u.pkg, pkgDecls.get(u.pkg) ?? emptyPkgDecls(), bindings);
    }
  }

  // merge, in the traversal order the units were collected in
  for (const u of units) {
    recordDecls(u.prog, u.file);
    structs.push(...u.prog.structs);
    enums.push(...u.prog.enums);
    functions.push(...u.prog.functions);
    traits.push(...u.prog.traits);
    impls.push(...u.prog.impls);
    typeAliases.push(...u.prog.typeAliases);
    interfaces.push(...u.prog.interfaces);
    globals.push(...u.prog.globals);
  }

  // Same-name top-level fns collapse in the flat namespace: dedup (below) keeps
  // the last body, and every call site — including the *other* module's own
  // internal calls — then runs it. Two failure modes are flagged here:
  //   1. A user fn shadows a stdlib/prelude fn of the same name with a DIFFERENT
  //      signature. The library's own calls to that name rebind to the user's fn
  //      and break (wrong arity/types) — this is the "expects 3, got 2" trap. A
  //      signature-compatible override is the documented path and stays allowed.
  //   2. Two non-prelude modules define the same fn with different bodies.
  // Externs are exempt (redeclarations all bind the same C symbol).
  const stripSpan = (k: string, v: unknown) =>
    k === "span" ? undefined : typeof v === "bigint" ? `${v}n` : v;
  const stripForCompare = (k: string, v: unknown) =>
    k === "span" || k === "sourceFile" ? undefined : typeof v === "bigint" ? `${v}n` : v;
  // Signature identity ignores param *names* — only arity, param types, and the
  // return type decide whether one fn can stand in for another.
  const sigKey = (f: typeof functions[number]) =>
    f.params.map(p => JSON.stringify(p.type, stripSpan)).join(",") + "=>" + JSON.stringify(f.retType, stripSpan);
  const readSourceSafe = (p?: string) => { try { return p ? readSource(p) : undefined; } catch { return undefined; } };

  // Stdlib/prelude signatures, to detect user shadows. First occurrence wins.
  const stdlibSigs = new Map<string, { file: string; sig: string; body: string }>();
  for (const f of functions) {
    if (f.isExtern) continue;
    if (f.sourceFile && preludeFiles.has(f.sourceFile) && !stdlibSigs.has(f.name)) {
      stdlibSigs.set(f.name, { file: f.sourceFile, sig: sigKey(f), body: JSON.stringify(f, stripForCompare) });
    }
  }

  const shadowedStdlib: { name: string; stdlibFile: string; span?: Span }[] = [];
  const fnDefs = new Map<string, { file: string; body: string }>();
  for (const f of functions) {
    if (f.isExtern || (f.sourceFile && preludeFiles.has(f.sourceFile))) continue;

    const shadowed = stdlibSigs.get(f.name);
    // Same signature, different body: this is the "documented last-wins override"
    // path — not an error, because the library's own calls still type-check. But it
    // silently rebinds those calls to the user's body, which is a footgun (a user's
    // `strIndexOf`/`charAt` can break std from the inside). Surface it as a warning
    // the user can `--allow` when the override is deliberate.
    if (shadowed && shadowed.sig === sigKey(f) && shadowed.body !== JSON.stringify(f, stripForCompare)) {
      shadowedStdlib.push({ name: f.name, stdlibFile: shadowed.file, span: f.span });
    }
    if (shadowed && shadowed.sig !== sigKey(f)) {
      throw new ParseError({
        severity: "error",
        code: "shadows-stdlib",
        span: f.span,
        len: f.name.length,
        message: `'fn ${f.name}' shadows a standard-library function of the same name, with a different signature`,
        hint: `the standard library defines '${f.name}' in '${shadowed.file}'. Milo merges every module into one namespace, so the library's own calls to '${f.name}' would bind to this definition and break. Rename this function, or match the library's signature exactly to override it deliberately.`,
      }, readSourceSafe(f.sourceFile), f.sourceFile);
    }

    const body = JSON.stringify(f, stripForCompare);
    const prev = fnDefs.get(f.name);
    if (prev && prev.body !== body && prev.file !== f.sourceFile) {
      throw new ParseError({
        severity: "error",
        code: "duplicate-fn",
        span: f.span,
        len: f.name.length,
        message: `'fn ${f.name}' is defined in two modules with different bodies`,
        hint: `also defined in '${prev.file}'. Milo compiles all modules into one namespace, so only one body survives and every call site runs it. Rename one, or move the shared implementation into a single module both import.`,
      }, readSourceSafe(f.sourceFile), f.sourceFile);
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
  return { structs: dedup(structs), enums: dedup(enums), functions: dedup(functions), imports: [], traits: dedup(traits), impls, typeAliases: dedup(typeAliases), interfaces: dedup(interfaces), globals: dedup(globals), declOrigins, packageNames, userFnNames, userImplKeys, entryFile: entryFile ?? undefined, unusedImports, shadowedStdlib };
}
