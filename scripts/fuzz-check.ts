// The frontend contract the fuzzer tests, in one place so the Worker and the
// main-thread confirmation stage run byte-identical logic.
//
// The contract: for ANY input, lex → parse → [resolve] → check either produces
// diagnostics or finishes clean. A `ParseError` is the frontend working. A raw
// JS exception, a hang, or a diagnostic whose span points outside the source is
// a bug.
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { resolveImports } from "../src/resolver";
import { getHostTarget } from "../src/target";
import { ParseError } from "../src/diagnostics";
import type { Diagnostic } from "../src/diagnostics";

export const PHASES = ["idle", "lex", "parse", "resolve", "check"] as const;

export interface CaseResult {
  status: "ok" | "bug";
  kind?: string;      // exception class, or "bad-span" / "empty-message"
  message?: string;
  stack?: string;
  phase?: string;
}

interface CaseOpts {
  resolve?: boolean;
  sourceDir?: string;
  // Written before each stage so a caller watching from another thread can tell
  // which stage a hung run died in — a blocked run can't report it any other way.
  phaseOut?: Int32Array;
}

// A diagnostic is the frontend's contract with every downstream consumer (CLI
// renderer, LSP, editors). One that points outside the source it was produced
// from crashes the renderer or highlights an unrelated line, so a malformed span
// is a bug even though nothing threw.
function checkDiagnostics(diags: Diagnostic[], src: string): { kind: string; message: string } | null {
  const lines = src.split("\n");
  for (const d of diags) {
    if (!d.message || d.message.trim() === "") {
      return { kind: "empty-message", message: `diagnostic with empty message (code=${d.code ?? "none"})` };
    }
    const s = d.span;
    if (!s) continue;
    if (!Number.isFinite(s.line) || !Number.isFinite(s.col) || s.line < 1 || s.col < 1) {
      return { kind: "bad-span", message: `span ${s.line}:${s.col} out of range for "${d.message}"` };
    }
    // span.file means the diagnostic came from an imported module; its source
    // isn't this string, so the bounds below don't apply.
    if (s.file) continue;
    if (s.line > lines.length) {
      return { kind: "bad-span", message: `span line ${s.line} > ${lines.length} lines for "${d.message}"` };
    }
    const lineText = lines[s.line - 1] ?? "";
    if (s.col > lineText.length + 1) {
      return { kind: "bad-span", message: `span col ${s.col} > line length ${lineText.length} at line ${s.line} for "${d.message}"` };
    }
    if (d.len !== undefined && (!Number.isFinite(d.len) || d.len < 0)) {
      return { kind: "bad-span", message: `negative/NaN len ${d.len} for "${d.message}"` };
    }
  }
  return null;
}

export function runCase(src: string, opts: CaseOpts = {}): CaseResult {
  const setPhase = (n: number) => { if (opts.phaseOut) Atomics.store(opts.phaseOut, 0, n); };
  let at = "lex";
  try {
    setPhase(1);
    const tokens = new Lexer(src).tokenize();

    at = "parse";
    setPhase(2);
    let program = new Parser(tokens, src, "fuzz.milo").parse();

    if (opts.resolve) {
      at = "resolve";
      setPhase(3);
      program = resolveImports(program, opts.sourceDir ?? process.cwd(), getHostTarget(), "fuzz.milo");
    }

    at = "check";
    setPhase(4);
    const result = new TypeChecker().check(program);

    const bad = checkDiagnostics(result.diagnostics, src);
    if (bad) return { status: "bug", ...bad, phase: at };

    return { status: "ok" };
  } catch (e: any) {
    if (e instanceof ParseError) {
      const bad = checkDiagnostics([e.diagnostic], src);
      if (bad) return { status: "bug", ...bad, phase: at };
      return { status: "ok" };
    }
    return {
      status: "bug",
      kind: e?.name ?? "Throw",
      message: String(e?.message ?? e),
      stack: String(e?.stack ?? ""),
      phase: at,
    };
  } finally {
    setPhase(0);
  }
}
