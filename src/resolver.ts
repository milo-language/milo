// resolves import declarations by recursively parsing imported files
// and merging all declarations into a single program

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { Program } from "./ast";
import type { TargetInfo } from "./target";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

// repo root: walk up from src/ to find the directory containing std/
const STDLIB_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CACHE_DIR = resolve(homedir(), ".milo", "cache");

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

export function resolveImports(program: Program, sourceDir: string, target: TargetInfo): Program {
  const visited = new Set<string>();
  const structs = [...program.structs];
  const enums = [...program.enums];
  const functions = [...program.functions];
  const traits = [...program.traits];
  const impls = [...program.impls];

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
      if (existsSync(platformPath)) return platformPath;
      const stdPath = resolve(STDLIB_DIR, withExt);
      if (existsSync(stdPath)) absPath = stdPath;
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
        source = readFileSync(absPath, "utf-8");
      } catch {
        throw new Error(`error[import]: ${imp.span?.line}:${imp.span?.col}: cannot open '${imp.path}'`);
      }

      const tokens = new Lexer(source).tokenize();
      const imported = new Parser(tokens).parse();

      if (imp.names) {
        // validate that all named symbols exist in the imported module
        const available = new Set<string>();
        for (const s of imported.structs) available.add(s.name);
        for (const e of imported.enums) available.add(e.name);
        for (const f of imported.functions) available.add(f.name);
        for (const t of imported.traits) available.add(t.name);
        for (const name of imp.names) {
          if (!available.has(name)) {
            throw new Error(`error[import]: ${imp.span?.line}:${imp.span?.col}: '${name}' not found in '${imp.path}'`);
          }
        }
      }
      // merge everything — named imports validate but don't restrict (flat compilation)
      structs.push(...imported.structs);
      enums.push(...imported.enums);
      functions.push(...imported.functions);
      traits.push(...imported.traits);
      impls.push(...imported.impls);
      processImports(imported, dirname(absPath));
    }
  }

  processImports(program, sourceDir);

  // auto-include std/string runtime (string methods depend on these functions)
  const stringStdlib = resolve(STDLIB_DIR, "std/string.milo");
  if (!visited.has(stringStdlib) && existsSync(stringStdlib)) {
    visited.add(stringStdlib);
    const source = readFileSync(stringStdlib, "utf-8");
    const tokens = new Lexer(source).tokenize();
    const imported = new Parser(tokens).parse();
    structs.push(...imported.structs);
    enums.push(...imported.enums);
    functions.push(...imported.functions);
    traits.push(...imported.traits);
    impls.push(...imported.impls);
    processImports(imported, dirname(stringStdlib));
  }

  return { structs, enums, functions, imports: [], traits, impls };
}
