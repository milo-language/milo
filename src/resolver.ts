// resolves import declarations by recursively parsing imported files
// and merging all declarations into a single program

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { Program } from "./ast";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

export function resolveImports(program: Program, sourceDir: string): Program {
  const visited = new Set<string>();
  const structs = [...program.structs];
  const enums = [...program.enums];
  const functions = [...program.functions];

  function processImports(prog: Program, dir: string) {
    for (const imp of prog.imports) {
      const absPath = resolve(dir, imp.path);
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
      structs.push(...imported.structs);
      enums.push(...imported.enums);
      functions.push(...imported.functions);
      processImports(imported, dirname(absPath));
    }
  }

  processImports(program, sourceDir);
  return { structs, enums, functions, imports: [] };
}
