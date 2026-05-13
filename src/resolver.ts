// resolves import declarations by recursively parsing imported files
// and merging all declarations into a single program

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import type { Program } from "./ast";
import type { TargetInfo } from "./target";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

// repo root: walk up from src/ to find the directory containing std/
const STDLIB_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");

export function resolveImports(program: Program, sourceDir: string, target: TargetInfo): Program {
  const visited = new Set<string>();
  const structs = [...program.structs];
  const enums = [...program.enums];
  const functions = [...program.functions];
  const traits = [...program.traits];
  const impls = [...program.impls];

  function resolvePath(dir: string, importPath: string): string {
    const withExt = importPath.endsWith(".milo") ? importPath : importPath + ".milo";
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
  return { structs, enums, functions, imports: [], traits, impls };
}
