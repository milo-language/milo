// Shared errorsFor: resolves imports because std holds the Vec/HashMap/string methods; without the merge every method call is "no method".
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";

const REPO_ROOT = join(import.meta.dir, "..");

export function errorsFor(src: string, entryPath?: string): string[] {
  let prog;
  try {
    prog = new Parser(new Lexer(src).tokenize(), src, entryPath).parse();
    prog = resolveImports(prog, entryPath ? dirname(entryPath) : REPO_ROOT, getHostTarget(), entryPath);
  } catch (e: any) {
    return [e.diagnostic?.message ?? e.message ?? String(e)];
  }
  return new TypeChecker().check(prog).diagnostics
    .filter(d => d.severity === "error").map(d => d.message);
}
