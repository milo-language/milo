// Tokenizer: source text -> the token stream the parser consumes.
import type { Token, Trivia } from "./tokens";
import { TokenKind, KEYWORDS } from "./tokens";
import { ParseError } from "./diagnostics";

// Stand-ins for `\{` / `\}` inside an f-string token value — see lexFString.
// Shared with the parser, which is the only thing allowed to resolve them.
export const FSTRING_LBRACE = "\uF77B";
export const FSTRING_RBRACE = "\uF77D";

export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;

  // `allowMangledIdents` lets an identifier carry `$`. Never set it for user source: `$`
  // is not a Milo identifier character and the mangling schemes (per-package, per-module,
  // `Type$method`) rely on that to stay unforgeable. It exists for the one place the
  // compiler lexes text IT generated: `@derive` codecs, which name the struct they were
  // generated for, and that name may already have been mangled.
  constructor(private source: string, private allowMangledIdents = false) {}

  private peek(): string {
    return this.pos < this.source.length ? this.source[this.pos] : "\0";
  }

  private advance(): string {
    const ch = this.source[this.pos++];
    if (ch === "\n") { this.line++; this.col = 1; } else { this.col++; }
    return ch;
  }

  // Leading trivia: comments and blank lines that appear *before* the next token.
  // A "blank" marker is emitted once per >=2 consecutive newlines so the formatter
  // can preserve logical paragraph breaks without preserving raw whitespace runs.
  private readLeadingTrivia(): Trivia[] {
    const trivia: Trivia[] = [];
    let newlines = 0;
    let emittedBlank = false;
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === "\n") {
        newlines++;
        this.advance();
        if (newlines >= 2 && !emittedBlank) {
          trivia.push({ kind: "blank", text: "", line: this.line });
          emittedBlank = true;
        }
      } else if (ch === " " || ch === "\t" || ch === "\r") {
        this.advance();
      } else if (ch === "/" && this.source[this.pos + 1] === "/") {
        const line = this.line;
        let text = "";
        while (this.pos < this.source.length && this.peek() !== "\n") text += this.advance();
        trivia.push({ kind: "comment", text, line });
        newlines = 0;
        emittedBlank = false;
      } else {
        break;
      }
    }
    return trivia;
  }

  // Trailing trivia: a same-line comment that immediately follows a token,
  // attached to that token rather than the next one. Stops at newline.
  private readTrailingTrivia(): Trivia[] {
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r") this.advance();
      else break;
    }
    if (this.peek() === "/" && this.source[this.pos + 1] === "/") {
      const line = this.line;
      let text = "";
      while (this.pos < this.source.length && this.peek() !== "\n") text += this.advance();
      return [{ kind: "comment", text, line }];
    }
    return [];
  }

  private token(kind: TokenKind, value: string, line: number, col: number): Token {
    return { kind, value, line, col };
  }

  private error(msg: string, line: number, col: number): never {
    throw new ParseError({ severity: "error", span: { line, col }, message: msg, code: "lex" }, this.source);
  }

  private lexFString(line: number, col: number): Token {
    const start = this.pos;
    this.advance(); // $
    this.advance(); // opening "
    let value = "";
    let braceDepth = 0;
    // `\{` and `\}` resolve to sentinels, not to real braces: the token value is
    // re-scanned for interpolation openers by the parser, and a resolved `{` there
    // is indistinguishable from one the author wrote to open an expression. That
    // made `$"\{\"k\": \"{v}\"}"` silently swallow the JSON as an expression and
    // emit garbage. The parser converts them back. PUA range as in lexHexEscape;
    // 0xF77B/0xF77D can't collide there because it only encodes bytes >= 0x80.
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0", "{": FSTRING_LBRACE, "}": FSTRING_RBRACE };
    while (true) {
      if (this.pos >= this.source.length) this.error("unterminated string", line, col);
      const ch = this.advance();
      if (braceDepth === 0) {
        if (ch === "\\") {
          const esc = this.advance();
          if (esc === "x") { value += this.lexHexEscape(); }
          else if (esc === "u") {
            const cp = this.lexUnicodeEscape(line, col);
            // A `\u{7b}` must land on the same sentinel a literal `\{` does, or it
            // reopens the interpolation-swallowing hole the sentinels exist to close.
            value += cp === 0x7b ? FSTRING_LBRACE : cp === 0x7d ? FSTRING_RBRACE : String.fromCodePoint(cp);
          }
          else if (esc in escapes) { value += escapes[esc]; }
          else { this.error(`unknown escape sequence '\\${esc}'`, line, col); }
          continue;
        }
        if (ch === '"') break;
        if (ch === '{') { braceDepth++; value += ch; continue; }
        value += ch;
      } else {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
        value += ch;
      }
    }
    const tok = this.token(TokenKind.FString, value, line, col);
    tok.raw = this.source.slice(start, this.pos);
    return tok;
  }

  // `\u{H..}` — a Unicode scalar, emitted as its UTF-8 bytes (source text outside a
  // literal is already carried as codepoints and encoded the same way downstream).
  // Distinct from `\xNN`, which names one raw byte and bypasses UTF-8 entirely.
  private lexUnicodeEscape(line: number, col: number): number {
    if (this.advance() !== "{") this.error("expected '{' after \\u", line, col);
    let hex = "";
    while (this.pos < this.source.length && this.peek() !== "}") hex += this.advance();
    if (this.pos >= this.source.length) this.error("unterminated \\u{...} escape", line, col);
    this.advance(); // }
    if (hex.length === 0 || hex.length > 6 || !/^[0-9a-fA-F]+$/.test(hex)) {
      this.error(`invalid \\u{${hex}}: expected 1-6 hex digits`, line, col);
    }
    const cp = parseInt(hex, 16);
    // Surrogates are not scalars; UTF-8 has no encoding for them, so accepting one
    // would emit bytes no decoder will accept back.
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      this.error(`invalid \\u{${hex}}: not a Unicode scalar value`, line, col);
    }
    return cp;
  }

  private lexHexEscape(): string {
    const h1 = this.advance();
    const h2 = this.advance();
    const byte = parseInt(h1 + h2, 16);
    if (byte <= 0x7f) return String.fromCharCode(byte);
    // PUA sentinel: codegen emits as raw byte, not UTF-8 codepoint
    return String.fromCharCode(0xF700 + byte);
  }

  private lexString(line: number, col: number): Token {
    this.advance(); // opening "
    let value = "";
    // `\'` is redundant in a string but legal in Rust, and shader source embedded as a
    // Milo string carries it in prose comments.
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0" };
    while (this.peek() !== '"') {
      if (this.pos >= this.source.length) this.error("unterminated string", line, col);
      const ch = this.advance();
      if (ch === "\\") {
        const esc = this.advance();
        if (esc === "x") { value += this.lexHexEscape(); }
        else if (esc === "u") { value += String.fromCodePoint(this.lexUnicodeEscape(line, col)); }
        else if (esc in escapes) { value += escapes[esc]; }
        else { this.error(`unknown escape sequence '\\${esc}'`, line, col); }
      } else {
        value += ch;
      }
    }
    this.advance(); // closing "
    return this.token(TokenKind.String, value, line, col);
  }

  private lexChar(line: number, col: number): Token {
    this.advance(); // opening '
    if (this.pos >= this.source.length) this.error("unterminated char literal", line, col);
    let value: number;
    const escapes: Record<string, number> = { n: 10, t: 9, r: 13, "\\": 92, "'": 39, "0": 0 };
    if (this.peek() === "\\") {
      this.advance();
      const esc = this.advance();
      if (esc === "u") {
        // A char is one byte, so only the Latin-1 range has a single-byte form.
        const cp = this.lexUnicodeEscape(line, col);
        if (cp > 0xff) this.error(`\\u{${cp.toString(16)}} does not fit in a char (one byte); use a string`, line, col);
        value = cp;
      }
      // & 0xff strips the PUA offset lexHexEscape adds for bytes >= 0x80; a char is
      // the byte itself, so it never needs the sentinel a string does.
      else if (esc === "x") { value = this.lexHexEscape().codePointAt(0)! & 0xff; }
      else if (esc in escapes) { value = escapes[esc]; }
      else { this.error(`unknown escape sequence '\\${esc}'`, line, col); }
    } else {
      value = this.advance().charCodeAt(0);
    }
    if (this.peek() !== "'") this.error("unterminated char literal", line, col);
    this.advance(); // closing '
    return this.token(TokenKind.Char, String(value), line, col);
  }

  private lexNumber(line: number, col: number): Token {
    // hex: 0x... / binary: 0b... — emit as decimal-string Int token so downstream parses as plain integer
    if (this.peek() === "0" && (this.source[this.pos + 1] === "x" || this.source[this.pos + 1] === "X")) {
      this.advance(); this.advance();
      let raw = "";
      while (this.pos < this.source.length && /[0-9a-fA-F_]/.test(this.peek())) {
        const c = this.advance();
        if (c !== "_") raw += c;
      }
      if (!raw) this.error("hex literal needs at least one digit", line, col);
      const n = BigInt("0x" + raw);
      return this.token(TokenKind.Int, n.toString(), line, col);
    }
    if (this.peek() === "0" && (this.source[this.pos + 1] === "b" || this.source[this.pos + 1] === "B")) {
      this.advance(); this.advance();
      let raw = "";
      while (this.pos < this.source.length && /[01_]/.test(this.peek())) {
        const c = this.advance();
        if (c !== "_") raw += c;
      }
      if (!raw) this.error("binary literal needs at least one digit", line, col);
      const n = BigInt("0b" + raw);
      return this.token(TokenKind.Int, n.toString(), line, col);
    }
    let value = "";
    let isFloat = false;
    while (this.pos < this.source.length && ((this.peek() >= "0" && this.peek() <= "9") || this.peek() === "_")) {
      const c = this.advance();
      if (c !== "_") value += c;
    }
    if (this.peek() === "." && this.source[this.pos + 1] >= "0" && this.source[this.pos + 1] <= "9") {
      isFloat = true;
      value += this.advance(); // the dot
      while (this.pos < this.source.length && ((this.peek() >= "0" && this.peek() <= "9") || this.peek() === "_")) {
        const c = this.advance();
        if (c !== "_") value += c;
      }
    }
    // Scientific notation: e/E, optional sign, ≥1 digit (e.g. 1e18, 1.5e-3, 2E+9).
    // Only consume `e` when a digit actually follows — otherwise it's an identifier
    // butted against an int (leave `e...` for the ident lexer), not a malformed float.
    if (this.peek() === "e" || this.peek() === "E") {
      let k = this.pos + 1;
      if (this.source[k] === "+" || this.source[k] === "-") k++;
      if (this.source[k] >= "0" && this.source[k] <= "9") {
        isFloat = true;
        value += this.advance(); // e/E
        if (this.peek() === "+" || this.peek() === "-") value += this.advance();
        while (this.pos < this.source.length && ((this.peek() >= "0" && this.peek() <= "9") || this.peek() === "_")) {
          const c = this.advance();
          if (c !== "_") value += c;
        }
      }
    }
    return this.token(isFloat ? TokenKind.Float : TokenKind.Int, value, line, col);
  }

  private lexIdent(line: number, col: number): Token {
    let value = "";
    const cont = this.allowMangledIdents ? /[a-zA-Z0-9_$]/ : /[a-zA-Z0-9_]/;
    while (this.pos < this.source.length && cont.test(this.peek())) {
      value += this.advance();
    }
    const kind = KEYWORDS.has(value) ? (value as TokenKind) : TokenKind.Ident;
    return this.token(kind, value, line, col);
  }

  private nextToken(): Token {
    if (this.pos >= this.source.length) {
      return this.token(TokenKind.Eof, "", this.line, this.col);
    }

    const line = this.line;
    const col = this.col;
    const ch = this.peek();

    if (ch === '$' && this.source[this.pos + 1] === '"') return this.lexFString(line, col);
    if (ch === '"') return this.lexString(line, col);
    if (ch === "'") return this.lexChar(line, col);
    if (ch >= "0" && ch <= "9") return this.lexNumber(line, col);
    if (/[a-zA-Z_]/.test(ch)) return this.lexIdent(line, col);

    // three-char operators
    const next = this.source[this.pos + 1];
    const next2 = this.source[this.pos + 2];
    if (ch === "." && next === "." && next2 === ".") { this.advance(); this.advance(); this.advance(); return this.token(TokenKind.DotDotDot, "...", line, col); }
    if (ch === "." && next === ".") { this.advance(); this.advance(); return this.token(TokenKind.DotDot, "..", line, col); }

    // two-char operators
    if (ch === "+" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.PlusEq, "+=", line, col); }
    if (ch === "-" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.MinusEq, "-=", line, col); }
    if (ch === "*" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.StarEq, "*=", line, col); }
    if (ch === "/" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.SlashEq, "/=", line, col); }
    if (ch === "%" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.PercentEq, "%=", line, col); }
    if (ch === "-" && next === ">") { this.advance(); this.advance(); return this.token(TokenKind.Arrow, "->", line, col); }
    if (ch === "=" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.EqEq, "==", line, col); }
    if (ch === "=" && next === ">") { this.advance(); this.advance(); return this.token(TokenKind.FatArrow, "=>", line, col); }
    if (ch === ":" && next === ":") { this.advance(); this.advance(); return this.token(TokenKind.ColonColon, "::", line, col); }
    if (ch === "!" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.Neq, "!=", line, col); }
    if (ch === "<" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.LtEq, "<=", line, col); }
    if (ch === ">" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.GtEq, ">=", line, col); }
    if (ch === "?" && next === "?") { this.advance(); this.advance(); return this.token(TokenKind.QuestionQuestion, "??", line, col); }
    if (ch === "&" && next === "&") { this.advance(); this.advance(); return this.token(TokenKind.AmpAmp, "&&", line, col); }
    if (ch === "|" && next === "|") { this.advance(); this.advance(); return this.token(TokenKind.PipePipe, "||", line, col); }
    // compound bitwise assignment — must precede the single-char & | ^ below.
    // Shift-assign (<<= >>=) is intentionally absent: << / >> are not lexer tokens (they are
    // synthesized from adjacent < / > so nested generics like Vec<Vec<T>> parse), so <<= can't be lexed here.
    if (ch === "&" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.AmpEq, "&=", line, col); }
    if (ch === "|" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.PipeEq, "|=", line, col); }
    if (ch === "^" && next === "=") { this.advance(); this.advance(); return this.token(TokenKind.CaretEq, "^=", line, col); }

    // single-char
    const singles: Record<string, TokenKind> = {
      "(": TokenKind.LParen, ")": TokenKind.RParen,
      "{": TokenKind.LBrace, "}": TokenKind.RBrace,
      "[": TokenKind.LBracket, "]": TokenKind.RBracket,
      ":": TokenKind.Colon, ";": TokenKind.Semicolon,
      ",": TokenKind.Comma, ".": TokenKind.Dot,
      "*": TokenKind.Star,
      "+": TokenKind.Plus, "-": TokenKind.Minus,
      "/": TokenKind.Slash, "%": TokenKind.Percent,
      "&": TokenKind.Amp, "=": TokenKind.Eq,
      "<": TokenKind.Lt, ">": TokenKind.Gt,
      "!": TokenKind.Bang,
      "?": TokenKind.Question,
      "|": TokenKind.Pipe,
      "^": TokenKind.Caret,
      "~": TokenKind.Tilde,
      "@": TokenKind.At,
    };

    if (ch in singles) {
      this.advance();
      return this.token(singles[ch], ch, line, col);
    }

    this.error(`unexpected character: '${ch}'`, line, col);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    let pendingLeading = this.readLeadingTrivia();
    while (true) {
      const tok = this.nextToken();
      if (pendingLeading.length) tok.leadingTrivia = pendingLeading;
      tokens.push(tok);
      if (tok.kind === TokenKind.Eof) break;
      const trailing = this.readTrailingTrivia();
      if (trailing.length) tok.trailingTrivia = trailing;
      pendingLeading = this.readLeadingTrivia();
    }
    return tokens;
  }
}
