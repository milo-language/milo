// Browser entry for the docs playground: lex, parse, resolve, check, then the reference
// interpreter (src/interp.ts), all in-page. scripts/build-playground.ts bundles this.
import { PLAY_DIR, PLAY_FILE, vfs } from "./playground-host";
import STD from "playground-std";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { resolveImports } from "./resolver";
import { TypeChecker } from "./checker";
import { Interp } from "./interp";
import { InterpStuck, InterpUnsupported } from "./interp-values";
import { ParseError, type Diagnostic } from "./diagnostics";
import { resolveTarget } from "./target";

for (const [p, t] of Object.entries(STD)) vfs.set(p, t);

export interface PlaygroundDiagnostic { severity: string; message: string; line?: number; col?: number; hint?: string; file?: string }
export interface PlaygroundResult { stdout: string; stderr: string; exitCode: number; diagnostics: PlaygroundDiagnostic[] }

const flat = (d: Diagnostic): PlaygroundDiagnostic => ({
  severity: d.severity, message: d.message, hint: d.hint, line: d.span?.line, col: d.span?.col,
  file: d.span?.file && d.span.file !== PLAY_FILE ? d.span.file : undefined,
});

// exitCode: the program's own, 1 for a rejected program, 3 for `unsupported:`, 4 for an
// interpreter stall (the codes `milo interp` uses).
export function run(source: string): PlaygroundResult {
  const diagnostics: PlaygroundDiagnostic[] = [];
  const fail = (exitCode: number, stderr = ""): PlaygroundResult => ({ stdout: "", stderr, exitCode, diagnostics });
  vfs.set(PLAY_FILE, source);
  let program, result;
  try {
    program = new Parser(new Lexer(source).tokenize(), source, PLAY_FILE).parse();
    program = resolveImports(program, PLAY_DIR, resolveTarget("linux-x64")!, PLAY_FILE);
    result = new TypeChecker().check(program);
  } catch (e: any) {
    if (e instanceof ParseError) { diagnostics.push(flat(e.diagnostic)); return fail(1); }
    return fail(1, String(e?.message ?? e));
  }
  for (const d of result.diagnostics) diagnostics.push(flat(d));
  if (result.diagnostics.some(d => d.severity === "error")) return fail(1);
  const it = new Interp(program, result);
  const dec = new TextDecoder();
  try {
    const r = it.run();
    return { stdout: dec.decode(r.stdout), stderr: r.stderr, exitCode: r.code, diagnostics };
  } catch (e) {
    const stdout = dec.decode(Uint8Array.from(it.out));
    if (e instanceof InterpUnsupported || e instanceof InterpStuck) {
      return { stdout, stderr: e.message, exitCode: e instanceof InterpUnsupported ? 3 : 4, diagnostics };
    }
    return { stdout, stderr: String((e as Error)?.stack ?? e), exitCode: 70, diagnostics };
  }
}
