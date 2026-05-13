import { Token, TokenKind, KEYWORDS, Trivia } from "./tokens";

export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(private source: string) {}

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
    throw new Error(`error[lex]: ${line}:${col}: ${msg}`);
  }

  private lexString(line: number, col: number): Token {
    this.advance(); // opening "
    let value = "";
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "0": "\0" };
    while (this.peek() !== '"') {
      if (this.pos >= this.source.length) this.error("unterminated string", line, col);
      const ch = this.advance();
      if (ch === "\\") {
        const esc = this.advance();
        value += escapes[esc] ?? esc;
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
      value = escapes[esc] ?? esc.charCodeAt(0);
    } else {
      value = this.advance().charCodeAt(0);
    }
    if (this.peek() !== "'") this.error("unterminated char literal", line, col);
    this.advance(); // closing '
    return this.token(TokenKind.Char, String(value), line, col);
  }

  private lexNumber(line: number, col: number): Token {
    let value = "";
    while (this.pos < this.source.length && this.peek() >= "0" && this.peek() <= "9") {
      value += this.advance();
    }
    if (this.peek() === "." && this.source[this.pos + 1] >= "0" && this.source[this.pos + 1] <= "9") {
      value += this.advance(); // the dot
      while (this.pos < this.source.length && this.peek() >= "0" && this.peek() <= "9") {
        value += this.advance();
      }
      return this.token(TokenKind.Float, value, line, col);
    }
    return this.token(TokenKind.Int, value, line, col);
  }

  private lexIdent(line: number, col: number): Token {
    let value = "";
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.peek())) {
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

    if (ch === '"') return this.lexString(line, col);
    if (ch === "'") return this.lexChar(line, col);
    if (ch >= "0" && ch <= "9") return this.lexNumber(line, col);
    if (/[a-zA-Z_]/.test(ch)) return this.lexIdent(line, col);

    // three-char operators
    const next = this.source[this.pos + 1];
    const next2 = this.source[this.pos + 2];
    if (ch === "." && next === "." && next2 === ".") { this.advance(); this.advance(); this.advance(); return this.token(TokenKind.DotDotDot, "...", line, col); }

    // two-char operators
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
