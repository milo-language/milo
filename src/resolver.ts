// resolves import declarations by recursively parsing imported files
// and merging all declarations into a single program

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, sep } from "path";
import { cacheRoot } from "./pkg";
import type { Program, Span, DeclOrigins, DeclOrigin, ImportDecl } from "./ast";
import { ParseError } from "./diagnostics";
import { closest, importHint, stdModuleNames } from "./suggest";
import type { TargetInfo } from "./target";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { collectModulePrivateDecls, collectPkgDecls, emptyPkgDecls, manglePackage, type DisplayNames, type PkgDeclNames } from "./mangle";

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

// A symbol-safe, readable id for one module. The file's basename, because a mangled name
// reaches diagnostics and DWARF: `gfx$tone` still tells a reader where `tone` lives, where
// a hash would not. Two files can share a basename in different directories, so a
// collision gets a numeric suffix — the id only has to be unique within one build.
function uniqueModuleId(file: string, used: Set<string>): string {
  // Split on BOTH separators: a Windows path would otherwise yield the whole drive path
  // as the "basename", which still mangles uniquely but reads as noise in a diagnostic.
  const base = file.split(/[\\/]/).pop()!.replace(/\.milo$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  let id = base === "" ? "mod" : base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

function toStdlibKey(absPath: string): string | null {
  return absPath.startsWith(STDLIB_DIR + "/") ? absPath.slice(STDLIB_DIR.length + 1) : null;
}

function bundleExists(absPath: string): boolean {
  if (!STDLIB_BUNDLE) return false;
  const key = toStdlibKey(absPath);
  return key !== null && STDLIB_BUNDLE.has(key);
}

// Best-effort source text for a diagnostic's caret. A file we cannot read still gets a
// message and a location — only the snippet is dropped.
function readSourceSafe(p?: string): string | undefined {
  try { return p ? readSource(p) : undefined; } catch { return undefined; }
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

// find milo.json by walking up from a directory
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

// A name declared twice at the top level of ONE file. The flat namespace would
// silently keep one of them (dedup below is last-wins), so the two copies can
// drift and every call site runs whichever the merge happened to pick — the
// classic bad-merge / duplicated-tail-block bug. There is no overloading in
// Milo, so a same-file redefinition has no legitimate reading.
//
// Cross-file collisions are a separate, deliberately laxer story (last-wins
// override of a prelude fn is documented; see duplicate-fn below) — this check
// is strictly within a single file, where nothing legitimate is being layered.
function checkDuplicateDecls(prog: Program, file: string, source: string | undefined) {
  // Values and types live in separate namespaces: `struct Point` next to
  // `fn Point` is odd but not a redefinition, and the merge keeps both.
  const seen = new Map<string, { line?: number }>();
  // `label` is what the message shows ("fn Bar.hello"); `name` is the token the
  // caret underlines, which for a method is just the method name.
  const check = (ns: string, label: string, name: string, span?: Span) => {
    const key = `${ns}:${name}`;
    const prev = seen.get(key);
    if (prev) {
      throw new ParseError({
        severity: "error",
        code: "duplicate-decl",
        span,
        len: name.length,
        message: `'${label}' is defined twice in this file`,
        hint: `${prev.line !== undefined ? `the first definition is on line ${prev.line}. ` : ""}Milo has no overloading, so only one definition survives and every use runs it — a redefinition is almost always a bad merge or a duplicated block. Delete one, or rename it.`,
      }, source, file);
    }
    seen.set(key, { line: span?.line });
  };

  for (const f of prog.functions) check("value", `${f.isExtern ? "extern fn" : "fn"} ${f.name}`, f.name, f.span);
  for (const g of prog.globals) check("value", `${g.mutable ? "var" : "let"} ${g.name}`, g.name, g.span);
  for (const s of prog.structs) check("type", `struct ${s.name}`, s.name, s.span);
  for (const e of prog.enums) check("type", `enum ${e.name}`, e.name, e.span);
  for (const t of prog.traits) check("type", `trait ${t.name}`, t.name, t.span);
  for (const i of prog.interfaces) check("type", `interface ${i.name}`, i.name, i.span);
  for (const a of prog.typeAliases) check("type", `type ${a.name}`, a.name, a.span);
  // Methods collide per (type, trait) — an inherent `Bar.hello` and a
  // `Greet for Bar` `hello` are distinct symbols and both are reachable, but two
  // inherent `hello`s (in one impl block or two) collapse. Without this the only
  // signal is LLVM's "invalid redefinition of function 'Bar$hello'".
  for (const impl of prog.impls)
    for (const m of impl.methods)
      check(`impl:${impl.typeName}:${impl.traitName ?? ""}`, `fn ${impl.typeName}.${m.name}`, m.name, m.span);
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
  const deriveTemplates: typeof program.deriveTemplates = [];

  const deps = findManifest(sourceDir);
  // A package import means whatever the manifest NEAREST THE IMPORTING FILE says, not
  // whatever the entry point's manifest says. Resolving once from `sourceDir` made an
  // import's meaning depend on where compilation happened to start: `cloud.milo` sits
  // beside a milo.json that declares `gl`, and `from "gl" import …` in it resolved when
  // the entry was the example next door and failed with `cannot open 'gl'` when the entry
  // was a test fixture two directories away — same file, same import, different answer.
  //
  // The entry map stays as a fallback so nothing that resolves today stops: walking up
  // from the importing file reaches the project root anyway in the ordinary case, and this
  // only adds an answer where there was none. Memoized per directory because the walk hits
  // the filesystem and a large tree imports from the same handful of directories.
  const depsByDir = new Map<string, Record<string, string> | null>();
  const depsFor = (dir: string): Record<string, string> | null => {
    let d = depsByDir.get(dir);
    if (d === undefined) {
      d = findManifest(dir);
      depsByDir.set(dir, d);
    }
    return d ?? deps;
  };

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
  // One `targets` check per package, not per import — a package's manifest can't change
  // mid-build, and re-reading it for each of a dozen imports would show up in compile time.
  const pkgTargetsChecked = new Set<string>();

  // `pkg` is the importing file's package id. A file resolved out of a manifest
  // `deps` entry belongs to that dep; anything the dep then resolves against its
  // own directory (`./x`, `../y`, or a bare sibling module) stays inside it; std
  // and the prelude are always "" and are never mangled.
  function resolvePath(dir: string, importPath: string, pkg: string): { path: string; pkg: string } {
    const withExt = importPath.endsWith(".milo") ? importPath : importPath + ".milo";

    // A package's `targets` says which platforms it can be built for at all — a binding to
    // a system library that only exists on some of them has no honest implementation
    // elsewhere. Without this the failure surfaces as whichever
    // file happened to be missing a platform arm, which reads as a broken package rather
    // than one that was never claimed to support this target. Stdlib modules have no
    // manifest and so no way to say this at all, which is one reason such a binding
    // belongs in a package.
    function checkPkgTarget(pkgName: string, cacheBase: string): void {
      if (pkgTargetsChecked.has(pkgName)) return;
      pkgTargetsChecked.add(pkgName);
      const manifestPath = resolve(cacheBase, "milo.json");
      if (!existsSync(manifestPath)) return;
      let targets: unknown;
      try { targets = JSON.parse(readFileSync(manifestPath, "utf-8")).targets; } catch { return; }
      if (!Array.isArray(targets) || targets.length === 0) return;
      if (targets.includes(target.os)) return;
      throw new Error(
        `package '${pkgName}' does not support ${target.os} — its milo.json declares targets [${targets.join(", ")}]`,
      );
    }

    // check if import starts with a known package name from milo.json
    const deps = depsFor(dir);
    if (deps) {
      const firstSlash = importPath.indexOf("/");
      const pkgName = firstSlash !== -1 ? importPath.slice(0, firstSlash) : importPath;
      const pkgUrl = deps[pkgName];
      if (pkgUrl) {
        const parsed = parsePkgUrl(pkgUrl);
        if (parsed) {
          const cacheBase = resolve(cacheDir(), parsed.host, parsed.path, parsed.version);
          checkPkgTarget(pkgName, cacheBase);
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
      const base = withExt.replace(/\.milo$/, "");
      // The filename suffix is the whole platform mechanism, so it has to work wherever
      // source lives — not only in std. A package binding a system library needs it most:
      // one that ships as a darwin framework and an archive elsewhere has to split its
      // `@link` arm, and without this a package could only split files its CONSUMER
      // imported by package path, never ones it imported from itself.
      const localPlatform = resolve(dir, `${base}.${target.os}.milo`);
      if (existsSync(localPlatform)) return { path: localPlatform, pkg };
      // for stdlib paths, try platform-specific file first (e.g. platform.darwin.milo)
      const platformPath = resolve(STDLIB_DIR, `${base}.${target.os}.milo`);
      if (bundleExists(platformPath) || existsSync(platformPath)) return { path: platformPath, pkg: "" };
      const stdPath = resolve(STDLIB_DIR, withExt);
      if (bundleExists(stdPath) || existsSync(stdPath)) return { path: stdPath, pkg: "" };
    }
    return { path: absPath, pkg };
  }

  // Does this written type mention a HashMap anywhere in it? `Vec<HashMap<string, i64>>`
  // needs the sort import just as much as a bare map field does.
  function mentionsHashMap(t: import("./ast").MiloType | null): boolean {
    if (!t) return false;
    if (t.name === "HashMap") return true;
    return (t.typeArgs ?? []).some(mentionsHashMap)
      || (t.fnParams ?? []).some(mentionsHashMap)
      || mentionsHashMap(t.fnRet ?? null);
  }

  function processImports(prog: Program, dir: string, pkg: string, unit: Unit) {
    // `@derive(Json)` synthesizes method bodies that call std/json (the cursor
    // API, JsonError, jsonQuote…). Pulling the module in here keeps the attribute
    // self-contained: a derive that silently required an unrelated import line
    // would report "unknown type 'Json'" pointing at code the user never wrote.
    // Not appended to prog.imports — the unused-import lint reads that list and
    // would flag an import nobody typed.
    const jsonDerivers = prog.structs.filter(s =>
      s.attributes?.some(a => a.name === "derive" && a.args.includes("Json")));
    const derivesJson = jsonDerivers.length > 0;
    const synthetic: ImportDecl[] = derivesJson && !prog.imports.some(i => i.path === "std/json")
      ? [{ kind: "ImportDecl", path: "std/json", names: ["Json"] }]
      : [];
    // A `HashMap<string, V>` field encodes as a JSON object, and the generated encoder
    // sorts its keys before emitting (Milo's HashMap iterates in a different order on
    // every run, so unsorted output would not even be reproducible across runs of one
    // binary). That needs std/sort. Pulled in only when a deriving struct actually has a
    // map field — syntactically, since plans are not computed until the checker runs —
    // so the common derive keeps its current dependencies.
    const derivesMap = jsonDerivers.some(s => s.fields.some(f => mentionsHashMap(f.type)));
    if (derivesMap && !prog.imports.some(i => i.path === "std/sort")) {
      synthetic.push({ kind: "ImportDecl", path: "std/sort", names: ["sortStrings"] });
    }
    for (const imp of [...prog.imports, ...synthetic]) {
      const resolved = resolvePath(dir, imp.path, pkg);
      const absPath = resolved.path;
      if (resolved.pkg !== "" && imp.names) {
        unit.targets.push({ names: imp.names, aliases: imp.aliases, pkg: resolved.pkg });
      } else if (resolved.pkg === "" && imp.aliases?.some((a, i) => a !== undefined && a !== imp.names[i])) {
        // A flat-namespace import (std/user code, never mangled) carrying an `as`
        // alias still needs a binding: the local alias names nothing on its own.
        unit.targets.push({ names: imp.names, aliases: imp.aliases, pkg: "" });
      }
      if (visited.has(absPath)) continue;
      visited.add(absPath);

      let source: string;
      try {
        source = readSource(absPath);
      } catch {
        // A misspelled std module is the common case and the compiler knows the whole
        // list, so spell the fix out rather than making the user go read std/.
        const near = imp.path.startsWith("std/") ? closest(imp.path, stdModuleNames()) : null;
        throw new ParseError({
          severity: "error",
          code: "import",
          span: imp.span,
          len: imp.path.length + 7, // `from "` + path + `"`
          message: `cannot open module '${imp.path}'`,
          hint: near
            ? `did you mean '${near}'?`
            : imp.path.startsWith("std/")
              ? `no std module is named '${imp.path}' — run 'milo api <name>' to find the one that has what you want`
              : `resolved to '${absPath}', which does not exist. Import paths without a leading 'std/' are relative to the importing file.`,
        }, readSourceSafe(unit.file), unit.file);
      }

      const tokens = new Lexer(source).tokenize();
      const imported = new Parser(tokens, source, absPath).parse();
      checkDuplicateDecls(imported, absPath, source);

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
            // Two distinct fixes hide behind one message: a typo (the module has a
            // near-miss) and an import from the wrong module (some OTHER std module
            // exports this exact name). Only the second is worth a full import line.
            const near = closest(name, available);
            throw new ParseError({
              severity: "error",
              code: "import",
              span: imp.span,
              len: imp.path.length + 7, // `from "` + path + `"`
              message: `'${name}' is not exported by '${imp.path}'`,
              hint: near ? `did you mean '${near}'?` : importHint(name),
            }, readSourceSafe(unit.file), unit.file);
          }
        }
      }
      // merge everything — named imports validate but don't restrict (flat compilation)
      for (const f of imported.functions) f.sourceFile = absPath;
      // Impl methods carry origin too, so the verifier can attribute a method's VCs to its
      // file (e.g. std/math.milo) exactly as it does for free functions.
      for (const im of imported.impls) for (const m of im.methods) m.sourceFile = absPath;
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
    checkDuplicateDecls(prelude, preludePath, src);
    for (const f of prelude.functions) f.sourceFile = preludePath;
    for (const im of prelude.impls) for (const m of im.methods) m.sourceFile = preludePath;
    const preludeUnit: Unit = { prog: prelude, file: preludePath, pkg: "", targets: [] };
    units.push(preludeUnit);
    processImports(prelude, dirname(preludePath), "", preludeUnit);
  }
  // everything visited so far came in through the prelude (it's processed first);
  // user redefinition of these names is the documented last-wins override path
  const preludeFiles = new Set(visited);
  preludeFiles.add(preludePath);

  // user code comes after prelude
  {
    // The entry was parsed by the caller, so re-read its text just for the
    // diagnostic's source context; a program compiled from a string has none.
    let entrySrc: string | undefined;
    try { if (entryFile) entrySrc = readSource(entryFile); } catch {}
    checkDuplicateDecls(program, entryFile ?? "(entry module)", entrySrc);
  }
  for (const f of program.functions) f.sourceFile = entryFile ?? "(entry module)";
  for (const im of program.impls) for (const m of im.methods) m.sourceFile = entryFile ?? "(entry module)";
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
  // (an `extern`/`@externalLinkage` fn keeps its written name).
  const pkgDecls = new Map<string, PkgDeclNames>();
  for (const u of units) {
    if (u.pkg === "") continue;
    let d = pkgDecls.get(u.pkg);
    if (!d) { d = emptyPkgDecls(); pkgDecls.set(u.pkg, d); }
    collectPkgDecls(u.prog, d);
  }
  const packageNames = new Set(pkgDecls.keys());

  for (const u of units) {
    const bindings = new Map<string, string>();
    for (const t of u.targets) {
      if (t.pkg === "") {
        // Flat-namespace alias: `from "std/math" import { Math as M }` binds the
        // local `M` to the real, unmangled declared name so `M.clampI64(..)`
        // resolves. Works for values and types alike (manglePackage's binding map
        // is consulted by both resolveValue and resolveType).
        for (let i = 0; i < t.names.length; i++) {
          const a = t.aliases?.[i];
          if (a !== undefined && a !== t.names[i]) bindings.set(a, t.names[i]);
        }
        continue;
      }
      const d = pkgDecls.get(t.pkg);
      if (!d) continue;
      for (let i = 0; i < t.names.length; i++) {
        const n = t.names[i];
        if (!d.values.has(n) && !d.types.has(n)) continue;
        bindings.set(t.aliases?.[i] ?? n, `${t.pkg}$${n}`);
      }
    }
    // pkg="" with no bindings is a strict no-op inside manglePackage; skip the call.
    if (bindings.size > 0 || u.pkg !== "") {
      manglePackage(u.prog, u.pkg, pkgDecls.get(u.pkg) ?? emptyPkgDecls(), bindings);
    }
  }

  // ── stage 1 of per-module namespaces (docs/plans/module-namespaces.md) ──
  // Two user modules that each define a private `fn tone` used to collide, in code
  // neither of them can see: name RESOLUTION is already per-module (a name from another
  // file is invisible without an import), and only the final flat merge failed. Renaming
  // each file's private names removes the collision without touching a single working
  // program's meaning — a private name has no importers to rewrite by construction.
  //
  // Packages are skipped: they already carry a `<pkg>$` namespace from the pass above,
  // and stacking a second prefix would rename the same decl twice. std is skipped too
  // (stage 4) — `milo api` discovery and docs/breaking-changes.md both index std by its
  // flat names, so renaming there is a much larger decision than the user-module fix.
  //
  // Renames only names that ACTUALLY collide, which is what keeps the pass invisible.
  // Mangling every private name works — the collision disappears and both bodies run —
  // but a mangled name is not only a symbol: `print` of a struct emitted
  // `printContainers$User`, and 14 error fixtures stopped matching their `@error:` text
  // because the diagnostic named a mangled type. Renaming a name nothing else declares
  // buys nothing and pays that cost on every program, so the pass first asks which
  // private names are contested and touches only those. A program with no collision is
  // byte-for-byte what it was.
  // `sep`, not a hardcoded "/": `resolve` returns platform-native separators, so on
  // Windows this prefix never matched and every std file was treated as a user module —
  // which changed the std-shadowing diagnostics and failed only on the Windows runner.
  const stdModuleRoot = resolve(STDLIB_DIR, "std") + sep;
  const userUnits = units.filter(u => u.pkg === "" && !u.file.startsWith(stdModuleRoot));

  // Every top-level name each user unit declares, private or not: a private helper can
  // just as easily collide with another module's `pub` name, and renaming the private
  // side is safe there for the same reason (it has no importers).
  const declCount = new Map<string, number>();
  for (const u of userUnits) {
    const all = emptyPkgDecls();
    collectPkgDecls(u.prog, all);
    for (const g of u.prog.globals) all.values.add(g.name);
    for (const n of new Set([...all.values, ...all.types])) declCount.set(n, (declCount.get(n) ?? 0) + 1);
  }

  // Test-only widening: rename EVERY private name in every user module, not only the
  // contested ones. A program compiled this way must behave and report identically to
  // one compiled without it; the fixture suite run under this switch is the gate that
  // proves no mangled name reaches a human-facing surface (docs/plans/module-namespaces.md).
  const mangleAll = process.env.MILO_MANGLE_ALL === "1";
  // A private name that also names a std/prelude declaration stays flat even under the
  // widening: user-vs-std shadowing keeps today's behaviour (the `shadows-stdlib` and
  // `duplicate-global` diagnostics fire on the flat name), and renaming it would turn
  // those diagnostics off without anyone deciding to.
  const stdNames = new Set<string>();
  if (mangleAll) {
    for (const u of units) {
      if (u.pkg !== "" || !(preludeFiles.has(u.file) || u.file.startsWith(stdModuleRoot))) continue;
      const all = emptyPkgDecls();
      collectPkgDecls(u.prog, all);
      for (const n of all.values) stdNames.add(n);
      for (const n of all.types) stdNames.add(n);
    }
  }

  const displayNames: DisplayNames = new Map();
  const usedModuleIds = new Set<string>();
  for (const u of userUnits) {
    const priv = emptyPkgDecls();
    collectModulePrivateDecls(u.prog, priv);
    if (!mangleAll) {
      for (const n of [...priv.values]) if ((declCount.get(n) ?? 0) < 2) priv.values.delete(n);
      for (const n of [...priv.types]) if ((declCount.get(n) ?? 0) < 2) priv.types.delete(n);
    } else {
      for (const n of [...priv.values]) if (stdNames.has(n)) priv.values.delete(n);
      for (const n of [...priv.types]) if (stdNames.has(n)) priv.types.delete(n);
    }
    if (priv.values.size === 0 && priv.types.size === 0) continue;
    const id = uniqueModuleId(u.file, usedModuleIds);
    // Record what each rename hides BEFORE it happens: the mangled name is a symbol, and
    // every surface a human reads renders it back through `display()` (src/mangle.ts).
    // `sourceName` carries the same fact on the decl itself, for the paths that hold one.
    for (const n of priv.values) displayNames.set(`${id}$${n}`, n);
    for (const n of priv.types) displayNames.set(`${id}$${n}`, n);
    for (const f of u.prog.functions) if (priv.values.has(f.name)) f.sourceName ??= f.name;
    manglePackage(u.prog, id, priv, new Map(), true);
  }

  // Every type/global declaration paired with the file that declared it. Unlike
  // fns, these decls carry no `sourceFile`, and after the merge below the arrays
  // are flat — so the origin has to be captured here, while each unit's file is
  // still in hand. Structs, enums, traits, interfaces and type aliases go into
  // ONE list because they share one namespace: `struct Response` in one module and
  // `enum Response` in another really do collide.
  const typeDecls: { name: string; kind: string; decl: unknown; file: string; span?: Span }[] = [];
  const globalDecls: { name: string; decl: unknown; file: string; span?: Span }[] = [];

  // merge, in the traversal order the units were collected in
  for (const u of units) {
    recordDecls(u.prog, u.file);
    for (const s of u.prog.structs) typeDecls.push({ name: s.name, kind: "struct", decl: s, file: u.file, span: s.span });
    for (const e of u.prog.enums) typeDecls.push({ name: e.name, kind: "enum", decl: e, file: u.file, span: e.span });
    for (const t of u.prog.traits) typeDecls.push({ name: t.name, kind: "trait", decl: t, file: u.file, span: t.span });
    for (const i of u.prog.interfaces) typeDecls.push({ name: i.name, kind: "interface", decl: i, file: u.file, span: i.span });
    for (const a of u.prog.typeAliases) typeDecls.push({ name: a.name, kind: "type alias", decl: a, file: u.file, span: a.span });
    for (const g of u.prog.globals) globalDecls.push({ name: g.name, decl: g, file: u.file, span: g.span });
    structs.push(...u.prog.structs);
    enums.push(...u.prog.enums);
    functions.push(...u.prog.functions);
    traits.push(...u.prog.traits);
    impls.push(...u.prog.impls);
    typeAliases.push(...u.prog.typeAliases);
    interfaces.push(...u.prog.interfaces);
    globals.push(...u.prog.globals);
    deriveTemplates.push(...u.prog.deriveTemplates);
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
  // `isPub` is stripped too: visibility is not part of a body. Two files can hold
  // the identical helper with only one of them exported, and that still merges —
  // enforcement reads per-file pub-ness from declOrigins, not from the merged decl.
  const stripForCompare = (k: string, v: unknown) =>
    k === "span" || k === "sourceFile" || k === "isPub" ? undefined : typeof v === "bigint" ? `${v}n` : v;
  // Signature identity ignores param *names* — only arity, param types, and the
  // return type decide whether one fn can stand in for another.
  const sigKey = (f: typeof functions[number]) =>
    f.params.map(p => JSON.stringify(p.type, stripSpan)).join(",") + "=>" + JSON.stringify(f.retType, stripSpan);

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

  // A stdlib file reads as 'std/http.milo' rather than the absolute path it was
  // resolved to; the point of naming both files is that the user can go open them.
  // Separator-agnostic: on Windows both sides arrive with backslashes, so comparing
  // against `STDLIB_DIR + "/"` never matched and the diagnostic printed the full
  // 'D:\a\milo\milo\std\string.milo' instead of 'std/string.milo'. Compare
  // normalised, and return the normalised relative path so the message reads the
  // same on every host.
  const toPosix = (p: string) => p.replace(/\\/g, "/");
  const stdRoot = toPosix(STDLIB_DIR);
  const displayFile = (p: string) => {
    const norm = toPosix(p);
    return norm.startsWith(stdRoot + "/") ? norm.slice(stdRoot.length + 1) : norm;
  };
  // "an enum", "an interface", "a struct" — the kind is interpolated, so the
  // article has to be picked rather than written.
  const a = (kind: string) => (/^[aeiou]/.test(kind) ? "an" : "a") + " " + kind;

  // Types collapse in the flat namespace exactly like fns, and until now nothing
  // checked them: `pub struct Response` in std/fetch and `pub enum Response` in
  // std/http merged to whichever unit came last, and the losing module then
  // type-checked against a type it never declared — "expected Response, got
  // Response", pointing at correct code, with nothing naming the collision.
  //
  // Same tolerance as duplicate-fn: two files holding a byte-identical definition
  // still merge (that is how a shared type gets vendored into two modules), and
  // only a *different* definition in a *different* file is an error.
  //
  // Unlike fns there is no signature/body split to be lax about — a type's body IS
  // its signature, so every difference is the hard-error case, including against
  // the prelude. That matches the fn rule at the same granularity: a prelude fn
  // redefined with a different signature is `shadows-stdlib`, an error, because
  // the library's own uses break; a prelude type redefined with different fields
  // breaks the library's own uses the same way.
  const typeDefs = new Map<string, { file: string; kind: string; body: string }>();
  for (const t of typeDecls) {
    const body = JSON.stringify(t.decl, stripForCompare);
    const prev = typeDefs.get(t.name);
    if (prev && prev.file !== t.file && (prev.kind !== t.kind || prev.body !== body)) {
      const sameKind = prev.kind === t.kind;
      throw new ParseError({
        severity: "error",
        code: "duplicate-type",
        span: t.span,
        len: t.name.length,
        message: `'${t.name}' is defined as ${a(prev.kind)} in '${displayFile(prev.file)}' and as ${a(t.kind)} in '${displayFile(t.file)}'`,
        hint: `Milo merges every module into one flat namespace, so a type name has exactly one meaning program-wide${sameKind ? " and these two definitions differ" : ""} — only one of them survives and every use of '${t.name}' resolves to it, including the other module's own uses. Rename one${sameKind ? ", or move the shared definition into a single module both import" : ""}.`,
      }, readSourceSafe(t.file), t.file);
    }
    if (!prev) typeDefs.set(t.name, { file: t.file, kind: t.kind, body });
  }

  // Globals live in the *value* namespace, alongside fns — `@name` is one LLVM
  // symbol either way, so a global and a fn of the same name from two files is a
  // raw "redefinition of function '@asciiIsDigit'" out of clang with no Milo
  // diagnostic at all. checkDuplicateDecls already treats them as one namespace
  // within a file; this is the same rule across files.
  const fnFileByName = new Map<string, string>();
  for (const f of functions) if (!fnFileByName.has(f.name)) fnFileByName.set(f.name, f.sourceFile ?? "(unknown)");
  const globalDefs = new Map<string, { file: string; body: string }>();
  for (const g of globalDecls) {
    const body = JSON.stringify(g.decl, stripForCompare);
    const prev = globalDefs.get(g.name);
    const fnFile = fnFileByName.get(g.name);
    const clash = prev && prev.file !== g.file && prev.body !== body
      ? { file: prev.file, kind: "global" }
      : fnFile !== undefined && fnFile !== g.file
        ? { file: fnFile, kind: "function" }
        : null;
    if (clash) {
      throw new ParseError({
        severity: "error",
        code: "duplicate-global",
        span: g.span,
        len: g.name.length,
        message: `'${g.name}' is defined as ${a(clash.kind)} in '${displayFile(clash.file)}' and as a global in '${displayFile(g.file)}'`,
        hint: `Milo merges every module into one flat namespace, and globals share it with functions — only one '${g.name}' survives and every use resolves to it. Rename one of them.`,
      }, readSourceSafe(g.file), g.file);
    }
    if (!prev) globalDefs.set(g.name, { file: g.file, body });
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
  return { structs: dedup(structs), enums: dedup(enums), functions: dedup(functions), imports: [], traits: dedup(traits), impls, typeAliases: dedup(typeAliases), interfaces: dedup(interfaces), globals: dedup(globals), deriveTemplates: dedup(deriveTemplates), declOrigins, packageNames, displayNames, userFnNames, userImplKeys, entryFile: entryFile ?? undefined, unusedImports, shadowedStdlib };
}
