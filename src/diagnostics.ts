// Elm-style error formatting: source context, carets and severity, shared by the CLI
// and the LSP so a message reads the same in a terminal and an editor.
import type { Span } from "./ast";
import { WARNING_NAMES } from "./warnings";

type Severity = "error" | "warning" | "hint";

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
  // `--expect=<name>`: suppress the warning AND report if it stops occurring. An `allow`
  // that outlives its cause is silent forever and nothing ever deletes it; an `expect`
  // deletes itself the moment the code it excused is fixed.
  expected?: Set<string>;
  // Byte threshold for the `large-stack-array` lint (`--max-stack-array`).
  // Undefined → the checker's built-in default (512 KiB).
  maxStackArrayBytes?: number;
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
const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
export const DIM = "\x1b[2m";

const SEV_COLOR: Record<Severity, string> = { error: RED, warning: YELLOW, hint: CYAN };

// `resolveSource` maps a span's owning file to its source text. Diagnostics from
// imported modules carry span.file; without this the caret/line would be pulled
// from the entry file and point at an unrelated line (wrong-file misattribution).
export function formatDiagnostic(
  d: Diagnostic,
  source: string,
  filePath?: string,
  resolveSource?: (file: string) => string | undefined,
): string {
  const lines: string[] = [];
  const color = SEV_COLOR[d.severity];
  // A silenceable finding prints its name: `warning[index-clone]: ...`. Without it the
  // message was the only thing a user had, so there was no way to know which `--allow=`
  // or `--deny=` reaches this finding, and no name to look up — `milo explain <name>`
  // has the doc, the example and the fix, all of it unreachable from here. Only warning
  // names get the bracket, so the bracket MEANS "you can allow this one away"; an error
  // that carries an internal code stays a bare `error:`.
  const label = d.code && WARNING_NAMES.includes(d.code) ? `${d.severity}[${d.code}]` : d.severity;

  // A span may belong to a different file than the entry (imported code). Render
  // the header and snippet against that file, falling back to the entry source.
  const spanFile = d.span?.file;
  const file = spanFile ?? filePath ?? "<input>";
  const effSource =
    spanFile && spanFile !== filePath ? resolveSource?.(spanFile) : source;

  if (d.span) {
    const loc = `${file}:${d.span.line}:${d.span.col}`;
    lines.push(`${BOLD}${color}${label}${RESET}${BOLD}: ${d.message}${RESET}`);
    lines.push(`  ${DIM}──>${RESET} ${loc}`);

    const srcLines = (effSource ?? "").split("\n");
    const lineIdx = d.span.line - 1;
    if (lineIdx >= 0 && lineIdx < srcLines.length) {
      const lineNum = String(d.span.line);
      const pad = " ".repeat(lineNum.length);
      lines.push(`${DIM}${pad} │${RESET}`);
      lines.push(`${DIM}${lineNum} │${RESET} ${srcLines[lineIdx]}`);
      lines.push(`${DIM}${pad} │${RESET} ${" ".repeat(d.span.col - 1)}${color}${"^".repeat(Math.max(1, d.len ?? 1))}${RESET}`);
    }
  } else {
    lines.push(`${BOLD}${color}${label}${RESET}${BOLD}: ${d.message}${RESET}`);
  }

  if (d.hint) {
    lines.push(`  ${BOLD}${CYAN}hint${RESET}: ${d.hint}`);
  }

  return lines.join("\n");
}
