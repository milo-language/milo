// Shared by the checker-mutability probe (scripts/ts2milo-mut-diff.ts): the corpus, and a
// program run through the real front end up to the point where the mutability pass runs.
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { Lexer } from "../../src/lexer";
import { Parser } from "../../src/parser";
import { resolveImports } from "../../src/resolver";
import { TypeChecker } from "../../src/checker";
import { getHostTarget } from "../../src/target";
import type { Program } from "../../src/ast";
import type { ProgramPassHost, ProgramView } from "../../src/checker-program-passes";

export const ROOT = resolve(import.meta.dir, "../..");

function milosUnder(dir: string, recurse: boolean, out: string[]): void {
  for (const f of readdirSync(join(ROOT, dir)).sort()) {
    const rel = `${dir}/${f}`;
    if (recurse && statSync(join(ROOT, rel)).isDirectory()) milosUnder(rel, true, out);
    else if (f.endsWith(".milo")) out.push(rel);
  }
}

export function corpus(): string[] {
  const out: string[] = [];
  for (const d of ["tests/fixtures", "tests/errors", "std", "tests/ts2milo-mut"]) milosUnder(d, false, out);
  milosUnder("examples", true, out);
  return out;
}

export interface Checked { program: Program; host: ProgramPassHost; view: ProgramView }
export type CheckOutcome = { ok: Checked } | { skip: string };

// `lintArenaNeverFrees` is called immediately after checkMutability, so seeing it run is the
// proof that the pass was reached (a fatal diagnostic earlier skips both).
let reached = false;
const proto = TypeChecker.prototype as unknown as { lintArenaNeverFrees: (p: Program) => void };
const origLint = proto.lintArenaNeverFrees;
proto.lintArenaNeverFrees = function (this: unknown, p: Program) { reached = true; return origLint.call(this, p); };

export function checkProgramFile(rel: string): CheckOutcome {
  const path = join(ROOT, rel);
  const source = readFileSync(path, "utf8");
  let program: Program;
  try {
    program = new Parser(new Lexer(source).tokenize(), source, rel).parse();
    program = resolveImports(program, dirname(path), getHostTarget(), rel);
  } catch (e) {
    return { skip: `does not parse or resolve: ${(e as Error).message.split("\n")[0]!.slice(0, 60)}` };
  }
  reached = false;
  const tc = new TypeChecker(undefined);
  try { tc.check(program); } catch (e) { return { skip: `checker threw: ${(e as Error).message.split("\n")[0]!.slice(0, 60)}` }; }
  if (!reached) return { skip: "checker stopped before the whole-program passes" };
  const { host, view } = tc.analysisFacts(program);
  return { ok: { program, host, view } };
}
