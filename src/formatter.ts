// Token-based source formatter for Milo
import { Token, TokenKind, Trivia } from "./tokens";
import { Lexer } from "./lexer";

const INDENT = "    ";

const SPACED_OPS = new Set([
  TokenKind.Plus, TokenKind.Minus, TokenKind.Star, TokenKind.Slash, TokenKind.Percent,
  TokenKind.Eq, TokenKind.EqEq, TokenKind.Neq, TokenKind.Lt, TokenKind.Gt,
  TokenKind.LtEq, TokenKind.GtEq, TokenKind.AmpAmp, TokenKind.PipePipe,
  TokenKind.FatArrow, TokenKind.Arrow, TokenKind.Pipe,
  TokenKind.Caret, TokenKind.QuestionQuestion,
]);

function isKeyword(kind: TokenKind): boolean {
  return [
    TokenKind.Fn, TokenKind.Extern, TokenKind.Let, TokenKind.Var,
    TokenKind.Return, TokenKind.If, TokenKind.Else, TokenKind.While,
    TokenKind.Struct, TokenKind.Enum, TokenKind.Match, TokenKind.Mut,
    TokenKind.Import, TokenKind.From, TokenKind.Break, TokenKind.Continue,
    TokenKind.As, TokenKind.Trait, TokenKind.Impl, TokenKind.For, TokenKind.In,
    TokenKind.Unsafe, TokenKind.Parallel, TokenKind.Null, TokenKind.True, TokenKind.False,
    TokenKind.Is, TokenKind.Interface,
  ].includes(kind);
}

function isUnary(ctx: Token[], pos: number, tok: Token): boolean {
  if (tok.kind !== TokenKind.Minus && tok.kind !== TokenKind.Star &&
      tok.kind !== TokenKind.Amp && tok.kind !== TokenKind.Bang &&
      tok.kind !== TokenKind.Tilde) return false;
  if (pos === 0) return true;
  const p = ctx[pos - 1];
  return p.kind === TokenKind.LParen || p.kind === TokenKind.LBracket ||
    p.kind === TokenKind.Comma || p.kind === TokenKind.Eq ||
    p.kind === TokenKind.Return || p.kind === TokenKind.FatArrow ||
    p.kind === TokenKind.LBrace || p.kind === TokenKind.Colon ||
    SPACED_OPS.has(p.kind);
}

function spaceBefore(tokens: Token[], pos: number): boolean {
  if (pos === 0) return false;
  const tok = tokens[pos];
  const p = tokens[pos - 1];

  // Never space after ( [ . ::
  if (p.kind === TokenKind.LParen || p.kind === TokenKind.LBracket ||
      p.kind === TokenKind.Dot || p.kind === TokenKind.ColonColon) return false;
  // Never space before ) ] , . :: ? :
  if (tok.kind === TokenKind.RParen || tok.kind === TokenKind.RBracket ||
      tok.kind === TokenKind.Comma || tok.kind === TokenKind.Dot ||
      tok.kind === TokenKind.ColonColon ||
      tok.kind === TokenKind.Question || tok.kind === TokenKind.Colon) return false;
  // ! — no space when postfix (after ) or ident), but space after keywords
  if (tok.kind === TokenKind.Bang) {
    return isKeyword(p.kind);
  }

  // No space around ..
  if (tok.kind === TokenKind.DotDot || p.kind === TokenKind.DotDot) return false;

  // Generics: no space around < > when used as type brackets
  if (tok.kind === TokenKind.Lt && isGenericOpen(tokens, pos)) return false;
  if (p.kind === TokenKind.Lt && isGenericOpen(tokens, pos - 1)) return false;
  if (tok.kind === TokenKind.Gt && isInsideGeneric(tokens, pos)) return false;
  if (p.kind === TokenKind.Gt) {
    // After closing > of generic: no space before , ) > or other tight punct
    if (tok.kind === TokenKind.Comma || tok.kind === TokenKind.RParen ||
        tok.kind === TokenKind.Gt) return false;
  }

  // Space around binary ops (not unary)
  if (SPACED_OPS.has(tok.kind) && !isUnary(tokens, pos, tok)) return true;
  if (SPACED_OPS.has(p.kind)) return true;

  // Space after :
  if (p.kind === TokenKind.Colon) return true;
  // Space after ,
  if (p.kind === TokenKind.Comma) return true;

  // Space after keywords (but not before ( for fn calls — fn name( is fine, but `if (` needs space)
  if (isKeyword(p.kind) && tok.kind !== TokenKind.Dot && tok.kind !== TokenKind.Colon) return true;

  // Space before {
  if (tok.kind === TokenKind.LBrace) return true;

  // Space after ) unless followed by tight punctuation
  if (p.kind === TokenKind.RParen && tok.kind !== TokenKind.Comma &&
      tok.kind !== TokenKind.RParen && tok.kind !== TokenKind.Dot &&
      tok.kind !== TokenKind.Bang && tok.kind !== TokenKind.Question) return true;

  // Space after } unless tight punctuation
  if (p.kind === TokenKind.RBrace && tok.kind !== TokenKind.Comma &&
      tok.kind !== TokenKind.RParen && tok.kind !== TokenKind.Dot) return true;

  // Space between ident/lit and ident/lit/keyword
  const isValue = (k: TokenKind) => k === TokenKind.Ident || k === TokenKind.Int ||
    k === TokenKind.Float || k === TokenKind.String || k === TokenKind.Char ||
    k === TokenKind.True || k === TokenKind.False || k === TokenKind.Null;
  if (isValue(p.kind) && (isValue(tok.kind) || isKeyword(tok.kind) || tok.kind === TokenKind.LBrace)) return true;

  // No space between & and type name (references)
  if (p.kind === TokenKind.Amp) return false;

  return false;
}

// Known generic type names — could be expanded but covers stdlib + common patterns
const GENERIC_TYPES = new Set([
  "Vec", "HashMap", "Heap", "Option", "Result", "Arena", "Weak",
]);

// Is the < at `pos` a generic open bracket?
// Heuristic: preceded by a known generic type name, or we can see a matching >
// with only type-like tokens between them.
function isGenericOpen(tokens: Token[], pos: number): boolean {
  if (pos <= 0) return false;
  const prev = tokens[pos - 1];
  if (prev.kind !== TokenKind.Ident) return false;
  // Known generic types — definitely generic
  if (GENERIC_TYPES.has(prev.value)) return true;
  // Scan forward for matching > with type-like content
  let depth = 1;
  for (let i = pos + 1; i < tokens.length && depth > 0; i++) {
    const t = tokens[i];
    if (t.kind === TokenKind.Lt) depth++;
    else if (t.kind === TokenKind.Gt) {
      depth--;
      if (depth === 0) return true;
    }
    // Type-like tokens: Ident, comma, &, known keywords like mut
    else if (t.kind === TokenKind.Ident || t.kind === TokenKind.Comma ||
             t.kind === TokenKind.Amp || t.kind === TokenKind.Mut) continue;
    // Anything else (operators, literals, etc) means it's a comparison
    else return false;
  }
  return false;
}

// Is `pos` (a >) inside a generic context? Walk backward to find a matching <.
function isInsideGeneric(tokens: Token[], pos: number): boolean {
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    if (tokens[i].kind === TokenKind.Gt) depth++;
    else if (tokens[i].kind === TokenKind.Lt) {
      depth--;
      if (depth === 0) return isGenericOpen(tokens, i);
    }
    // If we hit a statement-level token, we're not in generics
    if (tokens[i].kind === TokenKind.LBrace || tokens[i].kind === TokenKind.RBrace ||
        tokens[i].kind === TokenKind.Eq || tokens[i].kind === TokenKind.EqEq ||
        tokens[i].kind === TokenKind.Neq || tokens[i].kind === TokenKind.LtEq ||
        tokens[i].kind === TokenKind.GtEq) return false;
  }
  return false;
}

function isTopLevel(kind: TokenKind): boolean {
  return kind === TokenKind.Fn || kind === TokenKind.Struct ||
    kind === TokenKind.Enum || kind === TokenKind.Impl ||
    kind === TokenKind.Trait || kind === TokenKind.Extern ||
    kind === TokenKind.Interface;
}

export function format(source: string): string {
  const tokens = new Lexer(source).tokenize();
  if (tokens.length <= 1) return tokens.length === 1 ? "" : "";

  let out = "";
  let depth = 0;
  let lastLine = 1;
  let atLineStart = true;

  function indent() { for (let i = 0; i < depth; i++) out += INDENT; }

  function newline() {
    if (!out.endsWith("\n")) out += "\n";
    atLineStart = true;
  }

  function blankLine() {
    if (!out.endsWith("\n\n") && out.length > 0) {
      if (!out.endsWith("\n")) out += "\n";
      out += "\n";
    }
    atLineStart = true;
  }

  function writeTrivia(trivia: Trivia[], leading: boolean) {
    for (const t of trivia) {
      if (t.kind === "blank") {
        blankLine();
      } else if (t.kind === "comment") {
        if (leading) {
          if (!atLineStart) newline();
          indent();
          out += t.text;
          newline();
        } else {
          out += " " + t.text;
        }
      }
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === TokenKind.Eof) {
      if (tok.leadingTrivia) writeTrivia(tok.leadingTrivia, true);
      break;
    }

    // Leading trivia
    if (tok.leadingTrivia) writeTrivia(tok.leadingTrivia, true);

    // Determine if we need a line break based on source line numbers
    // Token is on a new line in the source → emit newline in output
    const onNewLine = tok.line > lastLine && !atLineStart;

    // } decreases depth before we emit it
    if (tok.kind === TokenKind.RBrace) {
      depth = Math.max(0, depth - 1);
      if (!atLineStart) newline();
    }

    // Blank line before top-level items at depth 0 (unless trivia already added one)
    if (depth === 0 && isTopLevel(tok.kind) && out.length > 0 &&
        !out.endsWith("\n\n") && !tok.leadingTrivia?.some(t => t.kind === "blank")) {
      blankLine();
    }

    // Emit line break if token was on a new source line
    if (onNewLine && tok.kind !== TokenKind.RBrace) {
      newline();
    }

    // Indent at start of line
    if (atLineStart) {
      indent();
      atLineStart = false;
    } else if (spaceBefore(tokens, i)) {
      out += " ";
    }

    // Emit token
    if (tok.kind === TokenKind.String) {
      out += `"${escapeString(tok.value)}"`;
    } else if (tok.kind === TokenKind.Char) {
      out += `'${escapeChar(parseInt(tok.value))}'`;
    } else {
      out += tok.value;
    }

    lastLine = tok.line;

    // Trailing trivia
    if (tok.trailingTrivia) writeTrivia(tok.trailingTrivia, false);

    // { increases depth and forces newline
    if (tok.kind === TokenKind.LBrace) {
      depth++;
      newline();
    }
    // } forces newline unless followed by else
    else if (tok.kind === TokenKind.RBrace) {
      const next = i + 1 < tokens.length ? tokens[i + 1] : null;
      if (!next || next.kind !== TokenKind.Else) {
        newline();
      }
    }
  }

  // Ensure trailing newline, collapse excessive blank lines
  if (!out.endsWith("\n")) out += "\n";
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\0/g, "\\0");
}

function escapeChar(code: number): string {
  const specials: Record<number, string> = { 10: "\\n", 9: "\\t", 13: "\\r", 92: "\\\\", 39: "\\'", 0: "\\0" };
  if (code in specials) return specials[code];
  return String.fromCharCode(code);
}

export function formatFile(filePath: string, write: boolean): string | null {
  const { readFileSync, writeFileSync } = require("fs");
  const source = readFileSync(filePath, "utf-8");
  const formatted = format(source);
  if (write) {
    if (formatted !== source) {
      writeFileSync(filePath, formatted);
      return filePath;
    }
    return null;
  }
  return formatted;
}
