import type { Span } from "./ast";

export type Severity = "error" | "warning" | "hint";

export interface Diagnostic {
  severity: Severity;
  span?: Span;
  // Width of the underlined span in columns (caret count / LSP range end).
  // Defaults to 1 when absent — Span is only a start point.
  len?: number;
  message: string;
  hint?: string;
  code?: string;
}

export interface WarningConfig {
  denied: Set<string>;
  allowed: Set<string>;
}

// Thrown by the lexer/parser. Carries a structured Diagnostic so callers can render
// the Elm-style source line + caret + hint (same path as type errors), while
// `.message` keeps the terse one-line form for callers that only log e.message.
// `source`/`filePath` identify the file that failed — errors from imported files
// must render against the imported file's text, not the top-level entry file.
export class ParseError extends Error {
  constructor(public diagnostic: Diagnostic, public source?: string, public filePath?: string) {
    const loc = diagnostic.span ? `${diagnostic.span.line}:${diagnostic.span.col}: ` : "";
    super(`error[${diagnostic.code ?? "parse"}]: ${loc}${diagnostic.message}`);
    this.name = "ParseError";
  }
}

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const DIM = "\x1b[2m";

const SEV_COLOR: Record<Severity, string> = { error: RED, warning: YELLOW, hint: CYAN };

export function formatDiagnostic(d: Diagnostic, source: string, filePath?: string): string {
  const lines: string[] = [];
  const color = SEV_COLOR[d.severity];
  const file = filePath ?? "<input>";

  if (d.span) {
    const loc = `${file}:${d.span.line}:${d.span.col}`;
    lines.push(`${BOLD}${color}${d.severity}${RESET}${BOLD}: ${d.message}${RESET}`);
    lines.push(`  ${DIM}──>${RESET} ${loc}`);

    const srcLines = source.split("\n");
    const lineIdx = d.span.line - 1;
    if (lineIdx >= 0 && lineIdx < srcLines.length) {
      const lineNum = String(d.span.line);
      const pad = " ".repeat(lineNum.length);
      lines.push(`${DIM}${pad} │${RESET}`);
      lines.push(`${DIM}${lineNum} │${RESET} ${srcLines[lineIdx]}`);
      lines.push(`${DIM}${pad} │${RESET} ${" ".repeat(d.span.col - 1)}${color}${"^".repeat(Math.max(1, d.len ?? 1))}${RESET}`);
    }
  } else {
    lines.push(`${BOLD}${color}${d.severity}${RESET}${BOLD}: ${d.message}${RESET}`);
  }

  if (d.hint) {
    lines.push(`  ${BOLD}${CYAN}hint${RESET}: ${d.hint}`);
  }

  return lines.join("\n");
}

export function formatDiagnosticPlain(d: Diagnostic, filePath?: string): string {
  const file = filePath ?? "<input>";
  if (d.span) {
    return `${d.severity}[${file}:${d.span.line}:${d.span.col}]: ${d.message}`;
  }
  return `${d.severity}: ${d.message}`;
}
