// src/tokens.ts
var KEYWORDS = new Set([
  "fn",
  "extern",
  "let",
  "var",
  "return",
  "if",
  "else",
  "while",
  "true",
  "false",
  "struct",
  "enum",
  "match",
  "mut",
  "import",
  "from",
  "break",
  "continue",
  "as",
  "trait",
  "impl",
  "for",
  "in",
  "unsafe",
  "move",
  "null",
  "is"
]);

// src/lexer.ts
class Lexer {
  source;
  pos = 0;
  line = 1;
  col = 1;
  constructor(source) {
    this.source = source;
  }
  peek() {
    return this.pos < this.source.length ? this.source[this.pos] : "\x00";
  }
  advance() {
    const ch = this.source[this.pos++];
    if (ch === `
`) {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }
  readLeadingTrivia() {
    const trivia = [];
    let newlines = 0;
    let emittedBlank = false;
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === `
`) {
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
        while (this.pos < this.source.length && this.peek() !== `
`)
          text += this.advance();
        trivia.push({ kind: "comment", text, line });
        newlines = 0;
        emittedBlank = false;
      } else {
        break;
      }
    }
    return trivia;
  }
  readTrailingTrivia() {
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r")
        this.advance();
      else
        break;
    }
    if (this.peek() === "/" && this.source[this.pos + 1] === "/") {
      const line = this.line;
      let text = "";
      while (this.pos < this.source.length && this.peek() !== `
`)
        text += this.advance();
      return [{ kind: "comment", text, line }];
    }
    return [];
  }
  token(kind, value, line, col) {
    return { kind, value, line, col };
  }
  error(msg, line, col) {
    throw new Error(`error[lex]: ${line}:${col}: ${msg}`);
  }
  lexFString(line, col) {
    this.advance();
    this.advance();
    let value = "";
    let braceDepth = 0;
    const escapes = { n: `
`, t: "\t", r: "\r", "\\": "\\", '"': '"', "0": "\x00", "{": "{", "}": "}" };
    while (true) {
      if (this.pos >= this.source.length)
        this.error("unterminated string", line, col);
      const ch = this.advance();
      if (braceDepth === 0) {
        if (ch === "\\") {
          const esc = this.advance();
          if (esc === "x") {
            value += this.lexHexEscape();
          } else {
            value += escapes[esc] ?? esc;
          }
          continue;
        }
        if (ch === '"')
          break;
        if (ch === "{") {
          braceDepth++;
          value += ch;
          continue;
        }
        value += ch;
      } else {
        if (ch === "{")
          braceDepth++;
        if (ch === "}")
          braceDepth--;
        value += ch;
      }
    }
    return this.token("FSTRING" /* FString */, value, line, col);
  }
  lexHexEscape() {
    const h1 = this.advance();
    const h2 = this.advance();
    return String.fromCharCode(parseInt(h1 + h2, 16));
  }
  lexString(line, col) {
    this.advance();
    let value = "";
    const escapes = { n: `
`, t: "\t", r: "\r", "\\": "\\", '"': '"', "0": "\x00" };
    while (this.peek() !== '"') {
      if (this.pos >= this.source.length)
        this.error("unterminated string", line, col);
      const ch = this.advance();
      if (ch === "\\") {
        const esc = this.advance();
        if (esc === "x") {
          value += this.lexHexEscape();
        } else {
          value += escapes[esc] ?? esc;
        }
      } else {
        value += ch;
      }
    }
    this.advance();
    return this.token("STRING" /* String */, value, line, col);
  }
  lexChar(line, col) {
    this.advance();
    if (this.pos >= this.source.length)
      this.error("unterminated char literal", line, col);
    let value;
    const escapes = { n: 10, t: 9, r: 13, "\\": 92, "'": 39, "0": 0 };
    if (this.peek() === "\\") {
      this.advance();
      const esc = this.advance();
      value = escapes[esc] ?? esc.charCodeAt(0);
    } else {
      value = this.advance().charCodeAt(0);
    }
    if (this.peek() !== "'")
      this.error("unterminated char literal", line, col);
    this.advance();
    return this.token("CHAR" /* Char */, String(value), line, col);
  }
  lexNumber(line, col) {
    if (this.peek() === "0" && (this.source[this.pos + 1] === "x" || this.source[this.pos + 1] === "X")) {
      this.advance();
      this.advance();
      let raw = "";
      while (this.pos < this.source.length && /[0-9a-fA-F_]/.test(this.peek())) {
        const c = this.advance();
        if (c !== "_")
          raw += c;
      }
      if (!raw)
        this.error("hex literal needs at least one digit", line, col);
      const n = BigInt("0x" + raw);
      return this.token("INT" /* Int */, n.toString(), line, col);
    }
    if (this.peek() === "0" && (this.source[this.pos + 1] === "b" || this.source[this.pos + 1] === "B")) {
      this.advance();
      this.advance();
      let raw = "";
      while (this.pos < this.source.length && /[01_]/.test(this.peek())) {
        const c = this.advance();
        if (c !== "_")
          raw += c;
      }
      if (!raw)
        this.error("binary literal needs at least one digit", line, col);
      const n = BigInt("0b" + raw);
      return this.token("INT" /* Int */, n.toString(), line, col);
    }
    let value = "";
    while (this.pos < this.source.length && (this.peek() >= "0" && this.peek() <= "9" || this.peek() === "_")) {
      const c = this.advance();
      if (c !== "_")
        value += c;
    }
    if (this.peek() === "." && this.source[this.pos + 1] >= "0" && this.source[this.pos + 1] <= "9") {
      value += this.advance();
      while (this.pos < this.source.length && (this.peek() >= "0" && this.peek() <= "9" || this.peek() === "_")) {
        const c = this.advance();
        if (c !== "_")
          value += c;
      }
      return this.token("FLOAT" /* Float */, value, line, col);
    }
    return this.token("INT" /* Int */, value, line, col);
  }
  lexIdent(line, col) {
    let value = "";
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.peek())) {
      value += this.advance();
    }
    const kind = KEYWORDS.has(value) ? value : "IDENT" /* Ident */;
    return this.token(kind, value, line, col);
  }
  nextToken() {
    if (this.pos >= this.source.length) {
      return this.token("EOF" /* Eof */, "", this.line, this.col);
    }
    const line = this.line;
    const col = this.col;
    const ch = this.peek();
    if (ch === "$" && this.source[this.pos + 1] === '"')
      return this.lexFString(line, col);
    if (ch === '"')
      return this.lexString(line, col);
    if (ch === "'")
      return this.lexChar(line, col);
    if (ch >= "0" && ch <= "9")
      return this.lexNumber(line, col);
    if (/[a-zA-Z_]/.test(ch))
      return this.lexIdent(line, col);
    const next = this.source[this.pos + 1];
    const next2 = this.source[this.pos + 2];
    if (ch === "." && next === "." && next2 === ".") {
      this.advance();
      this.advance();
      this.advance();
      return this.token("..." /* DotDotDot */, "...", line, col);
    }
    if (ch === "." && next === ".") {
      this.advance();
      this.advance();
      return this.token(".." /* DotDot */, "..", line, col);
    }
    if (ch === "-" && next === ">") {
      this.advance();
      this.advance();
      return this.token("->" /* Arrow */, "->", line, col);
    }
    if (ch === "=" && next === "=") {
      this.advance();
      this.advance();
      return this.token("==" /* EqEq */, "==", line, col);
    }
    if (ch === "=" && next === ">") {
      this.advance();
      this.advance();
      return this.token("=>" /* FatArrow */, "=>", line, col);
    }
    if (ch === ":" && next === ":") {
      this.advance();
      this.advance();
      return this.token("::" /* ColonColon */, "::", line, col);
    }
    if (ch === "!" && next === "=") {
      this.advance();
      this.advance();
      return this.token("!=" /* Neq */, "!=", line, col);
    }
    if (ch === "<" && next === "=") {
      this.advance();
      this.advance();
      return this.token("<=" /* LtEq */, "<=", line, col);
    }
    if (ch === ">" && next === "=") {
      this.advance();
      this.advance();
      return this.token(">=" /* GtEq */, ">=", line, col);
    }
    if (ch === "?" && next === "?") {
      this.advance();
      this.advance();
      return this.token("??" /* QuestionQuestion */, "??", line, col);
    }
    if (ch === "&" && next === "&") {
      this.advance();
      this.advance();
      return this.token("&&" /* AmpAmp */, "&&", line, col);
    }
    if (ch === "|" && next === "|") {
      this.advance();
      this.advance();
      return this.token("||" /* PipePipe */, "||", line, col);
    }
    const singles = {
      "(": "(" /* LParen */,
      ")": ")" /* RParen */,
      "{": "{" /* LBrace */,
      "}": "}" /* RBrace */,
      "[": "[" /* LBracket */,
      "]": "]" /* RBracket */,
      ":": ":" /* Colon */,
      ";": ";" /* Semicolon */,
      ",": "," /* Comma */,
      ".": "." /* Dot */,
      "*": "*" /* Star */,
      "+": "+" /* Plus */,
      "-": "-" /* Minus */,
      "/": "/" /* Slash */,
      "%": "%" /* Percent */,
      "&": "&" /* Amp */,
      "=": "=" /* Eq */,
      "<": "<" /* Lt */,
      ">": ">" /* Gt */,
      "!": "!" /* Bang */,
      "?": "?" /* Question */,
      "|": "|" /* Pipe */,
      "^": "^" /* Caret */,
      "~": "~" /* Tilde */,
      "@": "@" /* At */
    };
    if (ch in singles) {
      this.advance();
      return this.token(singles[ch], ch, line, col);
    }
    this.error(`unexpected character: '${ch}'`, line, col);
  }
  tokenize() {
    const tokens = [];
    let pendingLeading = this.readLeadingTrivia();
    while (true) {
      const tok = this.nextToken();
      if (pendingLeading.length)
        tok.leadingTrivia = pendingLeading;
      tokens.push(tok);
      if (tok.kind === "EOF" /* Eof */)
        break;
      const trailing = this.readTrailingTrivia();
      if (trailing.length)
        tok.trailingTrivia = trailing;
      pendingLeading = this.readLeadingTrivia();
    }
    return tokens;
  }
}

// src/parser.ts
class Parser {
  tokens;
  pos = 0;
  constructor(tokens) {
    this.tokens = tokens;
  }
  peek() {
    return this.tokens[this.pos];
  }
  peekN(n) {
    return this.tokens[this.pos + n];
  }
  atAdjacent(k) {
    const a = this.peek();
    const b = this.peekN(1);
    return a && b && a.kind === k && b.kind === k && a.line === b.line && b.col === a.col + 1;
  }
  advance() {
    return this.tokens[this.pos++];
  }
  span(tok) {
    return { line: tok.line, col: tok.col };
  }
  at(kind) {
    return this.peek().kind === kind;
  }
  match(kind) {
    if (this.at(kind))
      return this.advance();
    return null;
  }
  expect(kind) {
    const tok = this.advance();
    if (tok.kind !== kind)
      this.error(`expected '${kind}', got '${tok.kind}' ('${tok.value}')`, tok);
    return tok;
  }
  error(msg, tok) {
    throw new Error(`error[parse]: ${tok.line}:${tok.col}: ${msg}`);
  }
  parse() {
    const structs = [];
    const enums = [];
    const functions = [];
    const imports = [];
    const traits = [];
    const impls = [];
    while (!this.at("EOF" /* Eof */)) {
      let attrs;
      while (this.at("@" /* At */)) {
        if (!attrs)
          attrs = [];
        attrs.push(this.parseAttribute());
      }
      if (this.at("import" /* Import */) || this.at("from" /* From */)) {
        imports.push(this.parseImport());
      } else if (this.at("struct" /* Struct */)) {
        const s = this.parseStruct();
        if (attrs)
          s.attributes = attrs;
        structs.push(s);
      } else if (this.at("enum" /* Enum */)) {
        const e = this.parseEnum();
        if (attrs)
          e.attributes = attrs;
        enums.push(e);
      } else if (this.at("extern" /* Extern */)) {
        functions.push(this.parseExternFn());
      } else if (this.at("fn" /* Fn */)) {
        functions.push(this.parseFn());
      } else if (this.at("trait" /* Trait */)) {
        traits.push(this.parseTraitDecl());
      } else if (this.at("impl" /* Impl */)) {
        impls.push(this.parseImplDecl());
      } else {
        this.error(`expected declaration, got '${this.peek().kind}'`, this.peek());
      }
    }
    return { structs, enums, functions, imports, traits, impls };
  }
  parseImport() {
    if (this.at("from" /* From */)) {
      const tok = this.advance();
      const pathTok = this.expect("STRING" /* String */);
      this.expect("import" /* Import */);
      this.expect("{" /* LBrace */);
      const names = [];
      while (!this.at("}" /* RBrace */)) {
        names.push(this.expect("IDENT" /* Ident */).value);
        this.match("," /* Comma */);
      }
      this.expect("}" /* RBrace */);
      return { kind: "ImportDecl", path: pathTok.value, names, span: { line: tok.line, col: tok.col } };
    }
    if (this.at("import" /* Import */)) {
      const tok = this.advance();
      const pathTok = this.expect("STRING" /* String */);
      this.error(`use 'from "${pathTok.value}" import { ... }' or 'from "${pathTok.value}" import *'`, tok);
    }
    this.error("expected 'from' import declaration", this.peek());
  }
  parseType() {
    if (this.match("&" /* Amp */)) {
      const isMut = !!this.match("mut" /* Mut */);
      const inner = this.parseType();
      return { ...inner, isRef: !isMut, isRefMut: isMut };
    }
    if (this.match("*" /* Star */)) {
      const inner = this.parseType();
      return { ...inner, isPtr: true };
    }
    if (this.match("[" /* LBracket */)) {
      const inner = this.parseType();
      let arraySize = null;
      if (this.match(";" /* Semicolon */)) {
        arraySize = parseInt(this.expect("INT" /* Int */).value);
      }
      this.expect("]" /* RBracket */);
      return { name: inner.name, isPtr: false, isRef: false, isRefMut: false, isArray: true, arraySize };
    }
    if (this.at("(" /* LParen */) && this.isFnType()) {
      this.advance();
      const fnParams = [];
      while (!this.at(")" /* RParen */)) {
        fnParams.push(this.parseType());
        if (!this.at(")" /* RParen */))
          this.expect("," /* Comma */);
      }
      this.expect(")" /* RParen */);
      this.expect("=>" /* FatArrow */);
      const fnRet = this.parseType();
      return { name: "fn", isFn: true, fnParams, fnRet, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    const tok = this.advance();
    let typeArgs;
    if (this.at("<" /* Lt */)) {
      this.advance();
      typeArgs = [this.parseType()];
      while (this.match("," /* Comma */)) {
        typeArgs.push(this.parseType());
      }
      this.expect(">" /* Gt */);
    }
    let result = { name: tok.value, typeArgs, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    if (this.match("?" /* Question */)) {
      result = { name: "Option", typeArgs: [result], isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    return result;
  }
  parseStruct() {
    this.expect("struct" /* Struct */);
    const name = this.expect("IDENT" /* Ident */).value;
    const typeParams = this.parseTypeParams();
    this.expect("{" /* LBrace */);
    const fields = [];
    while (!this.at("}" /* RBrace */)) {
      const fieldName = this.expect("IDENT" /* Ident */).value;
      this.expect(":" /* Colon */);
      const fieldType = this.parseType();
      fields.push({ name: fieldName, type: fieldType });
      this.match("," /* Comma */);
    }
    this.expect("}" /* RBrace */);
    return { kind: "StructDecl", name, typeParams, fields };
  }
  parseEnum() {
    this.expect("enum" /* Enum */);
    const name = this.expect("IDENT" /* Ident */).value;
    const typeParams = this.parseTypeParams();
    this.expect("{" /* LBrace */);
    const variants = [];
    while (!this.at("}" /* RBrace */)) {
      const variantName = this.expect("IDENT" /* Ident */).value;
      const fields = [];
      if (this.match("(" /* LParen */)) {
        while (!this.at(")" /* RParen */)) {
          fields.push(this.parseType());
          this.match("," /* Comma */);
        }
        this.expect(")" /* RParen */);
      }
      variants.push({ name: variantName, fields });
      this.match("," /* Comma */);
    }
    this.expect("}" /* RBrace */);
    return { kind: "EnumDecl", name, typeParams, variants };
  }
  parseParam() {
    const name = this.expect("IDENT" /* Ident */).value;
    this.expect(":" /* Colon */);
    const type = this.parseType();
    return { name, type };
  }
  parseParamList() {
    this.expect("(" /* LParen */);
    const params = [];
    let variadic = false;
    while (!this.at(")" /* RParen */)) {
      if (this.at("..." /* DotDotDot */)) {
        this.advance();
        variadic = true;
        break;
      }
      params.push(this.parseParam());
      this.match("," /* Comma */);
    }
    this.expect(")" /* RParen */);
    return { params, variadic };
  }
  parseReturnType() {
    if (this.match(":" /* Colon */))
      return this.parseType();
    return { name: "void", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
  }
  parseExternFn() {
    this.expect("extern" /* Extern */);
    this.expect("fn" /* Fn */);
    const name = this.expect("IDENT" /* Ident */).value;
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    return { kind: "Function", name, typeParams: [], params, retType, body: [], isExtern: true, isVariadic: variadic };
  }
  parseFn() {
    this.expect("fn" /* Fn */);
    const name = this.expect("IDENT" /* Ident */).value;
    const typeParams = this.parseTypeParams();
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    this.expect("{" /* LBrace */);
    const body = this.parseStmts();
    this.expect("}" /* RBrace */);
    return { kind: "Function", name, typeParams, params, retType, body, isExtern: false, isVariadic: variadic };
  }
  parseTypeParams() {
    const typeParams = [];
    if (this.match("<" /* Lt */)) {
      typeParams.push(this.parseOneTypeParam());
      while (this.match("," /* Comma */)) {
        typeParams.push(this.parseOneTypeParam());
      }
      this.expect(">" /* Gt */);
    }
    return typeParams;
  }
  parseOneTypeParam() {
    const name = this.expect("IDENT" /* Ident */).value;
    const bounds = [];
    if (this.match(":" /* Colon */)) {
      bounds.push(this.expect("IDENT" /* Ident */).value);
      while (this.match("+" /* Plus */)) {
        bounds.push(this.expect("IDENT" /* Ident */).value);
      }
    }
    return { name, bounds };
  }
  parseAttribute() {
    this.expect("@" /* At */);
    const name = this.expect("IDENT" /* Ident */).value;
    const args = [];
    if (this.match("(" /* LParen */)) {
      args.push(this.expect("IDENT" /* Ident */).value);
      while (this.match("," /* Comma */)) {
        args.push(this.expect("IDENT" /* Ident */).value);
      }
      this.expect(")" /* RParen */);
    }
    return { name, args };
  }
  parseTraitDecl() {
    const tok = this.expect("trait" /* Trait */);
    const name = this.expect("IDENT" /* Ident */).value;
    const typeParams = this.parseTypeParams();
    const supertraits = [];
    if (this.match(":" /* Colon */)) {
      supertraits.push(this.expect("IDENT" /* Ident */).value);
      while (this.match("+" /* Plus */)) {
        supertraits.push(this.expect("IDENT" /* Ident */).value);
      }
    }
    this.expect("{" /* LBrace */);
    const methods = [];
    while (!this.at("}" /* RBrace */) && !this.at("EOF" /* Eof */)) {
      methods.push(this.parseTraitMethod());
    }
    this.expect("}" /* RBrace */);
    return { kind: "TraitDecl", name, typeParams, supertraits, methods, span: this.span(tok) };
  }
  parseTraitMethod() {
    const tok = this.expect("fn" /* Fn */);
    const name = this.expect("IDENT" /* Ident */).value;
    const { params } = this.parseParamList();
    const retType = this.parseReturnType();
    let body = null;
    if (this.at("{" /* LBrace */)) {
      this.advance();
      body = this.parseStmts();
      this.expect("}" /* RBrace */);
    }
    return { name, params, retType, body, span: this.span(tok) };
  }
  parseImplDecl() {
    const tok = this.expect("impl" /* Impl */);
    const firstName = this.expect("IDENT" /* Ident */).value;
    let traitName = null;
    let typeName;
    const typeParams = this.parseTypeParams();
    if (this.match("for" /* For */)) {
      traitName = firstName;
      typeName = this.expect("IDENT" /* Ident */).value;
    } else {
      typeName = firstName;
    }
    this.expect("{" /* LBrace */);
    const methods = [];
    while (!this.at("}" /* RBrace */) && !this.at("EOF" /* Eof */)) {
      methods.push(this.parseFn());
    }
    this.expect("}" /* RBrace */);
    return { kind: "ImplDecl", traitName, typeName, typeParams, methods, span: this.span(tok) };
  }
  parseStmts() {
    const stmts = [];
    while (!this.at("}" /* RBrace */) && !this.at("EOF" /* Eof */)) {
      stmts.push(this.parseStmt());
    }
    return stmts;
  }
  parseStmt() {
    if (this.at("let" /* Let */))
      return this.parseLet();
    if (this.at("var" /* Var */))
      return this.parseVar();
    if (this.at("return" /* Return */))
      return this.parseReturn();
    if (this.at("if" /* If */))
      return this.parseIf();
    if (this.at("while" /* While */))
      return this.parseWhile();
    if (this.at("for" /* For */))
      return this.parseFor();
    if (this.at("match" /* Match */))
      return this.parseMatch();
    if (this.at("break" /* Break */)) {
      const s = this.span(this.advance());
      return { kind: "BreakStmt", span: s };
    }
    if (this.at("continue" /* Continue */)) {
      const s = this.span(this.advance());
      return { kind: "ContinueStmt", span: s };
    }
    if (this.at("unsafe" /* Unsafe */)) {
      const s = this.span(this.advance());
      this.expect("{" /* LBrace */);
      const body = this.parseStmts();
      this.expect("}" /* RBrace */);
      return { kind: "UnsafeBlock", body, span: s };
    }
    const expr = this.parseExpr();
    if (this.at("=" /* Eq */)) {
      this.advance();
      const value = this.parseExpr();
      return { kind: "Assign", target: expr, value, span: expr.span };
    }
    return { kind: "ExprStmt", expr, span: expr.span };
  }
  parseLet() {
    const s = this.span(this.peek());
    this.expect("let" /* Let */);
    const name = this.expect("IDENT" /* Ident */).value;
    let type = null;
    if (this.match(":" /* Colon */))
      type = this.parseType();
    this.expect("=" /* Eq */);
    const value = this.parseExpr();
    return { kind: "LetDecl", name, type, value, span: s };
  }
  parseVar() {
    const s = this.span(this.peek());
    this.expect("var" /* Var */);
    const name = this.expect("IDENT" /* Ident */).value;
    let type = null;
    if (this.match(":" /* Colon */))
      type = this.parseType();
    this.expect("=" /* Eq */);
    const value = this.parseExpr();
    return { kind: "VarDecl", name, type, value, span: s };
  }
  parseReturn() {
    const s = this.span(this.peek());
    this.expect("return" /* Return */);
    if (this.at("}" /* RBrace */))
      return { kind: "Return", value: null, span: s };
    return { kind: "Return", value: this.parseExpr(), span: s };
  }
  parseIf() {
    const s = this.span(this.peek());
    this.expect("if" /* If */);
    if (this.at("let" /* Let */)) {
      return this.parseIfLet(s);
    }
    const cond = this.parseExpr();
    this.expect("{" /* LBrace */);
    const thenBody = this.parseStmts();
    this.expect("}" /* RBrace */);
    let elseBody = null;
    if (this.match("else" /* Else */)) {
      if (this.at("if" /* If */)) {
        elseBody = [this.parseIf()];
      } else {
        this.expect("{" /* LBrace */);
        elseBody = this.parseStmts();
        this.expect("}" /* RBrace */);
      }
    }
    return { kind: "IfStmt", cond, thenBody, elseBody, span: s };
  }
  parseIfLet(s) {
    this.expect("let" /* Let */);
    const pattern = this.parsePattern();
    this.expect("=" /* Eq */);
    const subject = this.parseExpr();
    this.expect("{" /* LBrace */);
    const thenBody = this.parseStmts();
    this.expect("}" /* RBrace */);
    let elseBody = null;
    if (this.match("else" /* Else */)) {
      this.expect("{" /* LBrace */);
      elseBody = this.parseStmts();
      this.expect("}" /* RBrace */);
    }
    return { kind: "IfLetStmt", pattern, subject, thenBody, elseBody, span: s };
  }
  parseWhile() {
    const s = this.span(this.peek());
    this.expect("while" /* While */);
    const cond = this.parseExpr();
    this.expect("{" /* LBrace */);
    const body = this.parseStmts();
    this.expect("}" /* RBrace */);
    return { kind: "WhileStmt", cond, body, span: s };
  }
  parseFor() {
    const s = this.span(this.peek());
    this.expect("for" /* For */);
    const varName = this.expect("IDENT" /* Ident */).value;
    let varName2 = null;
    if (this.match("," /* Comma */)) {
      varName2 = this.expect("IDENT" /* Ident */).value;
    }
    this.expect("in" /* In */);
    const iterableOrStart = this.parseExpr();
    let iterable;
    if (this.match(".." /* DotDot */)) {
      const end = this.parseExpr();
      iterable = { kind: "RangeExpr", start: iterableOrStart, end, span: iterableOrStart.span };
    } else {
      iterable = iterableOrStart;
    }
    this.expect("{" /* LBrace */);
    const body = this.parseStmts();
    this.expect("}" /* RBrace */);
    return { kind: "ForInStmt", varName, varName2, iterable, body, span: s };
  }
  parseMatch() {
    const s = this.span(this.peek());
    this.expect("match" /* Match */);
    const subject = this.parseExpr();
    this.expect("{" /* LBrace */);
    const arms = [];
    while (!this.at("}" /* RBrace */)) {
      const pattern = this.parsePattern();
      this.expect("=>" /* FatArrow */);
      this.expect("{" /* LBrace */);
      const body = this.parseStmts();
      this.expect("}" /* RBrace */);
      arms.push({ pattern, body });
    }
    this.expect("}" /* RBrace */);
    return { kind: "MatchStmt", subject, arms, span: s };
  }
  parsePattern() {
    const tok = this.peek();
    const s = this.span(tok);
    if (tok.kind === "IDENT" /* Ident */ && tok.value === "_") {
      this.advance();
      return { kind: "WildcardPattern", span: s };
    }
    if (tok.kind === "INT" /* Int */) {
      this.advance();
      return { kind: "LiteralPattern", value: Number(tok.value), literalKind: "int", span: s };
    }
    if (tok.kind === "FLOAT" /* Float */) {
      this.advance();
      return { kind: "LiteralPattern", value: Number(tok.value), literalKind: "float", span: s };
    }
    if (tok.kind === "STRING" /* String */) {
      this.advance();
      return { kind: "LiteralPattern", value: tok.value, literalKind: "string", span: s };
    }
    if (tok.kind === "CHAR" /* Char */) {
      this.advance();
      return { kind: "LiteralPattern", value: tok.value, literalKind: "char", span: s };
    }
    if (tok.kind === "true" /* True */) {
      this.advance();
      return { kind: "LiteralPattern", value: true, literalKind: "bool", span: s };
    }
    if (tok.kind === "false" /* False */) {
      this.advance();
      return { kind: "LiteralPattern", value: false, literalKind: "bool", span: s };
    }
    if (tok.kind === "-" /* Minus */) {
      const next = this.tokens[this.pos + 1];
      if (next && (next.kind === "INT" /* Int */ || next.kind === "FLOAT" /* Float */)) {
        this.advance();
        const numTok = this.advance();
        const lk = numTok.kind === "INT" /* Int */ ? "int" : "float";
        return { kind: "LiteralPattern", value: -Number(numTok.value), literalKind: lk, span: s };
      }
    }
    const enumName = this.expect("IDENT" /* Ident */).value;
    this.expect("." /* Dot */);
    const variant = this.expect("IDENT" /* Ident */).value;
    const bindings = [];
    if (this.match("(" /* LParen */)) {
      while (!this.at(")" /* RParen */)) {
        bindings.push(this.expect("IDENT" /* Ident */).value);
        this.match("," /* Comma */);
      }
      this.expect(")" /* RParen */);
    }
    return { kind: "EnumPattern", enumName, variant, bindings, span: s };
  }
  parseExpr() {
    let left = this.parseOr();
    if (this.at("??" /* QuestionQuestion */)) {
      this.advance();
      const defaultExpr = this.parseOr();
      left = { kind: "DefaultValue", operand: left, default: defaultExpr, span: left.span };
    }
    return left;
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.at("||" /* PipePipe */)) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "BinOp", op: "||", left, right, span: left.span };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseBitOr();
    while (this.at("&&" /* AmpAmp */)) {
      this.advance();
      const right = this.parseBitOr();
      left = { kind: "BinOp", op: "&&", left, right, span: left.span };
    }
    return left;
  }
  parseBitOr() {
    let left = this.parseBitXor();
    while (this.at("|" /* Pipe */)) {
      this.advance();
      const right = this.parseBitXor();
      left = { kind: "BinOp", op: "|", left, right, span: left.span };
    }
    return left;
  }
  parseBitXor() {
    let left = this.parseBitAnd();
    while (this.at("^" /* Caret */)) {
      this.advance();
      const right = this.parseBitAnd();
      left = { kind: "BinOp", op: "^", left, right, span: left.span };
    }
    return left;
  }
  parseBitAnd() {
    let left = this.parseComparison();
    while (this.at("&" /* Amp */) && this.peekN(1).kind !== "mut" /* Mut */) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: "BinOp", op: "&", left, right, span: left.span };
    }
    return left;
  }
  parseComparison() {
    let left = this.parseShift();
    if (this.at("is" /* Is */)) {
      this.advance();
      const pattern = this.parsePattern();
      return { kind: "IsExpr", operand: left, pattern, span: left.span };
    }
    while (this.peek().kind === "==" /* EqEq */ || this.peek().kind === "!=" /* Neq */ || this.peek().kind === "<=" /* LtEq */ || this.peek().kind === ">=" /* GtEq */ || this.peek().kind === "<" /* Lt */ && !this.atAdjacent("<" /* Lt */) || this.peek().kind === ">" /* Gt */ && !this.atAdjacent(">" /* Gt */)) {
      const opTok = this.advance();
      const right = this.parseShift();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }
  parseShift() {
    let left = this.parseAdditive();
    while (this.atAdjacent("<" /* Lt */) || this.atAdjacent(">" /* Gt */)) {
      const isLeft = this.peek().kind === "<" /* Lt */;
      this.advance();
      this.advance();
      const right = this.parseAdditive();
      left = { kind: "BinOp", op: isLeft ? "<<" : ">>", left, right, span: left.span };
    }
    return left;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek().kind === "+" /* Plus */ || this.peek().kind === "-" /* Minus */) {
      const opTok = this.advance();
      const right = this.parseMultiplicative();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.peek().kind === "*" /* Star */ || this.peek().kind === "/" /* Slash */ || this.peek().kind === "%" /* Percent */) {
      if (this.peek().kind === "*" /* Star */ && this.pos > 0 && this.tokens[this.pos - 1].line < this.peek().line)
        break;
      const opTok = this.advance();
      const right = this.parseUnary();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }
  parseUnary() {
    if (this.peek().kind === "-" /* Minus */ || this.peek().kind === "!" /* Bang */ || this.peek().kind === "*" /* Star */ || this.peek().kind === "~" /* Tilde */ || this.peek().kind === "&" /* Amp */) {
      const tok = this.advance();
      const operand = this.parseUnary();
      return { kind: "UnaryOp", op: tok.value, operand, span: this.span(tok) };
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at("." /* Dot */)) {
        this.advance();
        const field = this.expect("IDENT" /* Ident */).value;
        if (this.at("(" /* LParen */)) {
          this.advance();
          const args = [];
          while (!this.at(")" /* RParen */)) {
            args.push(this.parseExpr());
            this.match("," /* Comma */);
          }
          this.expect(")" /* RParen */);
          expr = { kind: "MethodCall", object: expr, method: field, args, span: expr.span };
        } else {
          expr = { kind: "FieldAccess", object: expr, field, span: expr.span };
        }
      } else if (this.at("[" /* LBracket */)) {
        this.advance();
        const first = this.parseExpr();
        if (this.at(".." /* DotDot */)) {
          this.advance();
          const end = this.parseExpr();
          this.expect("]" /* RBracket */);
          expr = { kind: "MethodCall", object: expr, method: "slice", args: [first, end], span: expr.span };
        } else {
          this.expect("]" /* RBracket */);
          expr = { kind: "IndexAccess", object: expr, index: first, span: expr.span };
        }
      } else if (this.at("!" /* Bang */)) {
        this.advance();
        expr = { kind: "Unwrap", operand: expr, span: expr.span };
      } else if (this.at("?" /* Question */)) {
        this.advance();
        expr = { kind: "Propagate", operand: expr, span: expr.span };
      } else if (this.at("as" /* As */)) {
        this.advance();
        const targetType = this.parseType();
        expr = { kind: "CastExpr", operand: expr, targetType, span: expr.span };
      } else {
        break;
      }
    }
    return expr;
  }
  parsePrimary() {
    const tok = this.peek();
    const s = this.span(tok);
    if (tok.kind === "INT" /* Int */) {
      this.advance();
      return { kind: "IntLit", value: parseInt(tok.value), span: s };
    }
    if (tok.kind === "FLOAT" /* Float */) {
      this.advance();
      return { kind: "FloatLit", value: parseFloat(tok.value), span: s };
    }
    if (tok.kind === "true" /* True */) {
      this.advance();
      return { kind: "BoolLit", value: true, span: s };
    }
    if (tok.kind === "false" /* False */) {
      this.advance();
      return { kind: "BoolLit", value: false, span: s };
    }
    if (tok.kind === "null" /* Null */) {
      this.advance();
      return { kind: "EnumLit", enumName: "Option", variant: "None", args: [], span: s };
    }
    if (tok.kind === "STRING" /* String */) {
      this.advance();
      return { kind: "StringLit", value: tok.value, span: s };
    }
    if (tok.kind === "FSTRING" /* FString */) {
      this.advance();
      return this.parseFString(tok.value, s);
    }
    if (tok.kind === "CHAR" /* Char */) {
      this.advance();
      return { kind: "CharLit", value: parseInt(tok.value), span: s };
    }
    if (tok.kind === "IDENT" /* Ident */) {
      this.advance();
      if (this.at("." /* Dot */) && tok.value[0] >= "A" && tok.value[0] <= "Z") {
        this.advance();
        const variant = this.expect("IDENT" /* Ident */).value;
        const args = [];
        if (this.match("(" /* LParen */)) {
          while (!this.at(")" /* RParen */)) {
            args.push(this.parseExpr());
            this.match("," /* Comma */);
          }
          this.expect(")" /* RParen */);
        }
        return { kind: "EnumLit", enumName: tok.value, variant, args, span: s };
      }
      if (this.at("{" /* LBrace */) && tok.value[0] >= "A" && tok.value[0] <= "Z") {
        return this.parseStructLit(tok.value, s);
      }
      if (this.at("(" /* LParen */))
        return this.parseCall(tok.value, s);
      return { kind: "Ident", name: tok.value, span: s };
    }
    if (tok.kind === "[" /* LBracket */) {
      return this.parseArrayLit();
    }
    if (tok.kind === "move" /* Move */) {
      this.advance();
      if (this.at("(" /* LParen */) && this.isArrowClosure()) {
        const closure = this.parseClosure(s);
        closure.isMove = true;
        return closure;
      }
      throw new Error(`error[parse]: ${tok.line}:${tok.col}: 'move' must precede a closure`);
    }
    if (tok.kind === "(" /* LParen */) {
      if (this.isArrowClosure()) {
        return this.parseClosure(s);
      }
      this.advance();
      const expr = this.parseExpr();
      this.expect(")" /* RParen */);
      return expr;
    }
    this.error(`unexpected token '${tok.kind}'`, tok);
  }
  parseStructLit(name, span) {
    this.expect("{" /* LBrace */);
    const fields = [];
    while (!this.at("}" /* RBrace */)) {
      const fieldName = this.expect("IDENT" /* Ident */).value;
      this.expect(":" /* Colon */);
      const value = this.parseExpr();
      fields.push({ name: fieldName, value });
      this.match("," /* Comma */);
    }
    this.expect("}" /* RBrace */);
    return { kind: "StructLit", name, fields, span };
  }
  parseCall(name, span) {
    this.expect("(" /* LParen */);
    const args = [];
    while (!this.at(")" /* RParen */)) {
      args.push(this.parseExpr());
      this.match("," /* Comma */);
    }
    this.expect(")" /* RParen */);
    return { kind: "Call", func: name, args, span };
  }
  parseArrayLit() {
    const s = this.span(this.peek());
    this.expect("[" /* LBracket */);
    const elements = [];
    while (!this.at("]" /* RBracket */)) {
      elements.push(this.parseExpr());
      if (elements.length === 1 && this.match(";" /* Semicolon */)) {
        const count = parseInt(this.expect("INT" /* Int */).value);
        this.expect("]" /* RBracket */);
        return { kind: "ArrayRepeat", value: elements[0], count, span: s };
      }
      this.match("," /* Comma */);
    }
    this.expect("]" /* RBracket */);
    return { kind: "ArrayLit", elements, span: s };
  }
  isFnType() {
    let i = this.pos + 1;
    let depth = 1;
    while (depth > 0 && i < this.tokens.length) {
      if (this.tokens[i].kind === "(" /* LParen */)
        depth++;
      else if (this.tokens[i].kind === ")" /* RParen */)
        depth--;
      i++;
    }
    return i < this.tokens.length && this.tokens[i].kind === "=>" /* FatArrow */;
  }
  isArrowClosure() {
    const saved = this.pos;
    this.advance();
    if (this.at(")" /* RParen */)) {
      this.advance();
      if (this.at("=>" /* FatArrow */)) {
        this.pos = saved;
        return true;
      }
      if (this.at(":" /* Colon */)) {
        this.pos = saved;
        return true;
      }
      this.pos = saved;
      return false;
    }
    if (this.at("IDENT" /* Ident */)) {
      this.advance();
      const isColon = this.at(":" /* Colon */);
      this.pos = saved;
      return isColon;
    }
    this.pos = saved;
    return false;
  }
  parseClosure(span) {
    this.expect("(" /* LParen */);
    const params = [];
    while (!this.at(")" /* RParen */)) {
      params.push(this.parseParam());
      if (!this.at(")" /* RParen */))
        this.expect("," /* Comma */);
    }
    this.expect(")" /* RParen */);
    const retType = this.at(":" /* Colon */) ? (this.advance(), this.parseType()) : null;
    this.expect("=>" /* FatArrow */);
    let body;
    if (this.match("{" /* LBrace */)) {
      body = this.parseStmts();
      this.expect("}" /* RBrace */);
    } else {
      const expr = this.parseExpr();
      body = [{ kind: "Return", value: expr, span: expr.span }];
    }
    return { kind: "Closure", params, retType, body, span };
  }
  parseFString(raw, span) {
    const args = [];
    let lit = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "{") {
        if (lit.length > 0) {
          args.push({ kind: "StringLit", value: lit, span });
          lit = "";
        }
        i++;
        let depth = 1;
        let exprStr = "";
        while (i < raw.length && depth > 0) {
          if (raw[i] === "{")
            depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          exprStr += raw[i];
          i++;
        }
        const tokens = new Lexer(exprStr).tokenize();
        const expr = new Parser(tokens).parseExpr();
        args.push(expr);
      } else {
        lit += raw[i];
        i++;
      }
    }
    if (lit.length > 0)
      args.push({ kind: "StringLit", value: lit, span });
    if (args.length === 1 && args[0].kind === "StringLit")
      return args[0];
    return { kind: "Call", func: "format", args, span };
  }
}

// src/ast.ts
function simpleType(name) {
  return { name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
}

// src/types.ts
function typeFromAst(ty) {
  if (ty.isFn && ty.fnParams && ty.fnRet) {
    return { tag: "fn", params: ty.fnParams.map(typeFromAst), ret: typeFromAst(ty.fnRet) };
  }
  let base;
  switch (ty.name) {
    case "i8":
      base = { tag: "int", bits: 8, signed: true };
      break;
    case "i16":
      base = { tag: "int", bits: 16, signed: true };
      break;
    case "i32":
      base = { tag: "int", bits: 32, signed: true };
      break;
    case "int":
    case "i64":
      base = { tag: "int", bits: 64, signed: true };
      break;
    case "byte":
    case "u8":
      base = { tag: "int", bits: 8, signed: false };
      break;
    case "u16":
      base = { tag: "int", bits: 16, signed: false };
      break;
    case "u32":
      base = { tag: "int", bits: 32, signed: false };
      break;
    case "u64":
      base = { tag: "int", bits: 64, signed: false };
      break;
    case "f32":
      base = { tag: "float", bits: 32 };
      break;
    case "float":
    case "f64":
      base = { tag: "float", bits: 64 };
      break;
    case "bool":
      base = { tag: "bool" };
      break;
    case "void":
      base = { tag: "void" };
      break;
    case "string":
      base = { tag: "string" };
      break;
    default:
      base = { tag: "struct", name: ty.name };
      break;
  }
  let result = base;
  if (ty.isArray)
    result = { tag: "array", element: base, size: ty.arraySize };
  if (ty.isPtr)
    return { tag: "ptr", inner: result };
  if (ty.isRef)
    return { tag: "ref", inner: result, mutable: false };
  if (ty.isRefMut)
    return { tag: "ref", inner: result, mutable: true };
  return result;
}
function typeEq(a, b) {
  if (a.tag !== b.tag)
    return false;
  switch (a.tag) {
    case "int":
      return b.bits === a.bits && b.signed === a.signed;
    case "float":
      return b.bits === a.bits;
    case "bool":
    case "void":
    case "string":
    case "unknown":
      return true;
    case "ptr":
      return typeEq(a.inner, b.inner);
    case "box":
      return typeEq(a.inner, b.inner);
    case "vec":
      return typeEq(a.element, b.element);
    case "hashmap":
      return typeEq(a.key, b.key) && typeEq(a.value, b.value);
    case "ref":
      return typeEq(a.inner, b.inner) && a.mutable === b.mutable;
    case "struct":
      return a.name === b.name;
    case "enum":
      return a.name === b.name;
    case "array": {
      const ba = b;
      return typeEq(a.element, ba.element) && a.size === ba.size;
    }
    case "fn": {
      const bf = b;
      return a.params.length === bf.params.length && a.params.every((p, i) => typeEq(p, bf.params[i])) && typeEq(a.ret, bf.ret);
    }
  }
}
function typeName(t) {
  switch (t.tag) {
    case "int":
      return `${t.signed ? "i" : "u"}${t.bits}`;
    case "float":
      return `f${t.bits}`;
    case "bool":
      return "bool";
    case "void":
      return "void";
    case "string":
      return "string";
    case "ptr":
      return `*${typeName(t.inner)}`;
    case "box":
      return `Box<${typeName(t.inner)}>`;
    case "vec":
      return `Vec<${typeName(t.element)}>`;
    case "hashmap":
      return `HashMap<${typeName(t.key)}, ${typeName(t.value)}>`;
    case "ref":
      return `&${t.mutable ? "mut " : ""}${typeName(t.inner)}`;
    case "struct":
      return t.name;
    case "enum":
      return t.name;
    case "array":
      return t.size !== null ? `[${typeName(t.element)}; ${t.size}]` : `[${typeName(t.element)}]`;
    case "fn":
      return `(${t.params.map(typeName).join(", ")}) => ${typeName(t.ret)}`;
    case "unknown":
      return "<unknown>";
  }
}
function isNumeric(t) {
  return t.tag === "int" || t.tag === "float";
}
function isCopy(t, enumIsCopy, structIsAllCopy) {
  if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "ptr" || t.tag === "fn" || t.tag === "ref")
    return true;
  if (t.tag === "enum" && enumIsCopy && enumIsCopy(t.name))
    return true;
  if (t.tag === "struct" && structIsAllCopy && structIsAllCopy(t.name))
    return true;
  return false;
}

// src/checker.ts
class TypeChecker {
  warningConfig;
  diagnostics = [];
  functions = new Map;
  genericFns = new Map;
  structs = new Map;
  enums = new Map;
  genericEnums = new Map;
  genericStructs = new Map;
  returnHint = null;
  monomorphizedDecls = [];
  monomorphizedStructDecls = [];
  monomorphizedFns = [];
  dropImpls = new Set;
  unsafeDepth = 0;
  scopes = [];
  exprTypes = new Map;
  autoBorrowed = new Map;
  rewrittenCalls = new Map;
  rewrittenEnums = new Map;
  rewrittenStructLits = new Map;
  movedExprs = new Set;
  borrowedExprs = new Set;
  autoWrappedOption = new Map;
  arrayToVecCoercions = new Set;
  closureCaptures = new Map;
  closureCalls = new Map;
  closureScopeDepth = null;
  currentClosureCaptures = null;
  currentFnRetType = { tag: "void" };
  loopDepth = 0;
  returnOnlyMovesStack = [];
  inReturnInLoop = false;
  traits = new Map;
  traitImpls = new Map;
  inherentImpls = new Map;
  genericImpls = new Map;
  _pendingImplFns = [];
  resolvedMethods = new Map;
  resolvedOperators = new Map;
  fnFieldCalls = new Set;
  propagateConversions = new Map;
  constructor(warningConfig) {
    const config = warningConfig ?? { denied: new Set, allowed: new Set };
    if (!config.denied.has("unused-move"))
      config.allowed.add("unused-move");
    this.warningConfig = config;
  }
  error(msg, span, hint) {
    this.diagnostics.push({ severity: "error", span, message: msg, hint });
  }
  warn(code, msg, span, hint) {
    if (this.warningConfig.allowed.has(code))
      return;
    const severity = this.warningConfig.denied.has(code) || this.warningConfig.denied.has("*") ? "error" : "warning";
    this.diagnostics.push({ severity, span, message: msg, hint, code });
  }
  resolve(ty) {
    if (ty.isFn && ty.fnParams && ty.fnRet) {
      return { tag: "fn", params: ty.fnParams.map((p) => this.resolve(p)), ret: this.resolve(ty.fnRet) };
    }
    const typeArgs = ty.typeArgs ?? [];
    if (typeArgs.length > 0) {
      const resolvedArgs = typeArgs.map((a) => this.resolve(a));
      let result;
      if (ty.name === "Box") {
        if (resolvedArgs.length !== 1) {
          this.error(`'Box' expects 1 type argument, got ${resolvedArgs.length}`);
          return { tag: "unknown" };
        }
        result = { tag: "box", inner: resolvedArgs[0] };
      } else if (ty.name === "Vec") {
        if (resolvedArgs.length !== 1) {
          this.error(`'Vec' expects 1 type argument, got ${resolvedArgs.length}`);
          return { tag: "unknown" };
        }
        result = { tag: "vec", element: resolvedArgs[0] };
      } else if (ty.name === "HashMap") {
        if (resolvedArgs.length !== 2) {
          this.error(`'HashMap' expects 2 type arguments, got ${resolvedArgs.length}`);
          return { tag: "unknown" };
        }
        this.validateHashableKey(resolvedArgs[0]);
        result = { tag: "hashmap", key: resolvedArgs[0], value: resolvedArgs[1] };
      } else {
        const ge = this.genericEnums.get(ty.name);
        if (ge) {
          let args = resolvedArgs;
          if (args.length < ge.typeParams.length && ge.typeParamDefaults) {
            args = [...args];
            for (let i = args.length;i < ge.typeParams.length; i++) {
              const def = ge.typeParamDefaults[i];
              if (!def) {
                this.error(`'${ty.name}' requires type argument for '${ge.typeParams[i]}'`);
                return { tag: "unknown" };
              }
              args.push(def);
            }
          } else if (args.length !== ge.typeParams.length) {
            this.error(`'${ty.name}' expects ${ge.typeParams.length} type args, got ${args.length}`);
            return { tag: "unknown" };
          }
          result = { tag: "enum", name: this.monomorphizeEnum(ty.name, args) };
        } else {
          const gs = this.genericStructs.get(ty.name);
          if (gs) {
            if (resolvedArgs.length !== gs.typeParams.length) {
              this.error(`'${ty.name}' expects ${gs.typeParams.length} type args, got ${resolvedArgs.length}`);
              return { tag: "unknown" };
            }
            result = { tag: "struct", name: this.monomorphizeStruct(ty.name, resolvedArgs) };
          } else {
            this.error(`'${ty.name}' is not a generic type`);
            return { tag: "unknown" };
          }
        }
      }
      if (ty.isRef)
        return { tag: "ref", inner: result, mutable: false };
      if (ty.isRefMut)
        return { tag: "ref", inner: result, mutable: true };
      return result;
    }
    const base = typeFromAst(ty);
    if (base.tag === "struct" && this.enums.has(base.name)) {
      return { tag: "enum", name: base.name };
    }
    return base;
  }
  mangleTypeName(t) {
    switch (t.tag) {
      case "int":
        return `${t.signed ? "i" : "u"}${t.bits}`;
      case "float":
        return `f${t.bits}`;
      case "bool":
        return "bool";
      case "void":
        return "void";
      case "string":
        return "string";
      case "struct":
        return t.name;
      case "enum":
        return t.name;
      case "ptr":
        return `ptr_${this.mangleTypeName(t.inner)}`;
      case "box":
        return `Box_${this.mangleTypeName(t.inner)}`;
      case "vec":
        return `Vec_${this.mangleTypeName(t.element)}`;
      case "hashmap":
        return `HashMap_${this.mangleTypeName(t.key)}_${this.mangleTypeName(t.value)}`;
      case "array":
        return `arr_${this.mangleTypeName(t.element)}_${t.size}`;
      case "ref":
        return `ref_${this.mangleTypeName(t.inner)}`;
      case "fn":
        return `fn_${t.params.map((p) => this.mangleTypeName(p)).join("_")}_ret_${this.mangleTypeName(t.ret)}`;
      case "unknown":
        return "unknown";
    }
  }
  monomorphizeEnum(baseName, typeArgs) {
    const mangled = `${baseName}_${typeArgs.map((a) => this.mangleTypeName(a)).join("_")}`;
    if (this.enums.has(mangled))
      return mangled;
    const generic = this.genericEnums.get(baseName);
    const typeMap = new Map;
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));
    const variants = new Map;
    for (const [vName, vInfo] of generic.variants) {
      variants.set(vName, {
        tag: vInfo.tag,
        fields: vInfo.fields.map((f) => this.substituteTypeKind(f, typeMap))
      });
    }
    this.enums.set(mangled, { baseName, variants });
    const decl = {
      kind: "EnumDecl",
      name: mangled,
      typeParams: [],
      variants: generic.decl.variants.map((v) => ({
        name: v.name,
        fields: v.fields.map((f) => this.substituteMiloType(f, generic.typeParams, typeArgs))
      }))
    };
    this.monomorphizedDecls.push(decl);
    return mangled;
  }
  monomorphizeStruct(baseName, typeArgs) {
    const mangled = `${baseName}_${typeArgs.map((a) => this.mangleTypeName(a)).join("_")}`;
    if (this.structs.has(mangled))
      return mangled;
    const generic = this.genericStructs.get(baseName);
    const typeMap = new Map;
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));
    const fields = generic.decl.fields.map((f) => ({
      name: f.name,
      type: this.resolve(this.substituteMiloType(f.type, generic.typeParams, typeArgs))
    }));
    this.structs.set(mangled, { fields, baseName, typeArgs });
    const decl = {
      kind: "StructDecl",
      name: mangled,
      typeParams: [],
      fields: generic.decl.fields.map((f) => ({
        name: f.name,
        type: this.substituteMiloType(f.type, generic.typeParams, typeArgs)
      }))
    };
    this.monomorphizedStructDecls.push(decl);
    const genericImplTemplates = this.genericImpls.get(baseName);
    if (genericImplTemplates) {
      for (const { impl: gi, program: prog } of genericImplTemplates) {
        const concreteImpl = {
          kind: "ImplDecl",
          traitName: gi.traitName,
          typeName: mangled,
          typeParams: [],
          methods: gi.methods.map((m) => ({
            ...m,
            body: this.substituteBody(m.body, generic.typeParams, typeArgs),
            params: m.params.map((p) => ({
              name: p.name,
              type: this.substituteSelfInMiloType(this.substituteMiloType(p.type, generic.typeParams, typeArgs), mangled)
            })),
            retType: this.substituteSelfInMiloType(this.substituteMiloType(m.retType, generic.typeParams, typeArgs), mangled)
          })),
          span: gi.span
        };
        this.registerImpl(concreteImpl, prog, this._pendingImplFns);
      }
    }
    if (generic.decl.attributes) {
      for (const attr of generic.decl.attributes) {
        if (attr.name !== "derive")
          continue;
        for (const traitName of attr.args) {
          const impl = this.synthesizeDeriveImpl(decl, traitName);
          if (impl)
            this.registerImpl(impl, { structs: [], enums: [], functions: [], imports: [], traits: [], impls: [] }, this._pendingImplFns);
        }
      }
    }
    return mangled;
  }
  substituteTypeKind(t, typeMap) {
    if (t.tag === "struct" && typeMap.has(t.name))
      return typeMap.get(t.name);
    if (t.tag === "array")
      return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
    if (t.tag === "ref")
      return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "ptr")
      return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "box")
      return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "vec")
      return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
    if (t.tag === "hashmap")
      return { ...t, key: this.substituteTypeKind(t.key, typeMap), value: this.substituteTypeKind(t.value, typeMap) };
    if (t.tag === "fn")
      return { ...t, params: t.params.map((p) => this.substituteTypeKind(p, typeMap)), ret: this.substituteTypeKind(t.ret, typeMap) };
    return t;
  }
  substituteMiloType(ty, typeParams, typeArgs) {
    const idx = typeParams.indexOf(ty.name);
    if (idx !== -1) {
      return { ...ty, name: typeName(typeArgs[idx]) };
    }
    if (ty.isFn && ty.fnParams && ty.fnRet) {
      return {
        ...ty,
        fnParams: ty.fnParams.map((p) => this.substituteMiloType(p, typeParams, typeArgs)),
        fnRet: this.substituteMiloType(ty.fnRet, typeParams, typeArgs)
      };
    }
    if (ty.typeArgs) {
      return { ...ty, typeArgs: ty.typeArgs.map((a) => this.substituteMiloType(a, typeParams, typeArgs)) };
    }
    return ty;
  }
  monomorphizeFn(baseName, typeArgs) {
    const mangled = `${baseName}_${typeArgs.map((a) => this.mangleTypeName(a)).join("_")}`;
    if (this.functions.has(mangled))
      return mangled;
    const generic = this.genericFns.get(baseName);
    const typeMap = new Map;
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));
    for (let i = 0;i < generic.decl.typeParams.length; i++) {
      const tp = generic.decl.typeParams[i];
      const concreteType = typeArgs[i];
      for (const bound of tp.bounds) {
        if (!this.typeImplementsTrait(typeName(concreteType), bound)) {
          this.error(`type '${typeName(concreteType)}' does not implement trait '${bound}'`);
        }
      }
    }
    const params = generic.decl.params.map((p) => ({
      type: this.resolve(this.substituteMiloType(p.type, generic.typeParams, typeArgs)),
      name: p.name
    }));
    const ret = this.resolve(this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs));
    this.functions.set(mangled, { params, ret, variadic: false });
    const concreteDecl = {
      kind: "Function",
      name: mangled,
      typeParams: [],
      params: generic.decl.params.map((p) => ({
        name: p.name,
        type: this.substituteMiloType(p.type, generic.typeParams, typeArgs)
      })),
      retType: this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs),
      body: this.substituteBody(generic.decl.body, generic.typeParams, typeArgs),
      isExtern: false,
      isVariadic: false
    };
    this.monomorphizedFns.push(concreteDecl);
    this.checkFunction(concreteDecl);
    return mangled;
  }
  substituteBody(stmts, typeParams, typeArgs) {
    return JSON.parse(JSON.stringify(stmts), (key, value) => {
      if (value && typeof value === "object" && "name" in value && !("kind" in value) && typeof value.name === "string") {
        const idx = typeParams.indexOf(value.name);
        if (idx !== -1)
          return { ...value, name: typeName(typeArgs[idx]) };
      }
      return value;
    });
  }
  pushScope() {
    this.scopes.push(new Map);
  }
  popScope() {
    this.scopes.pop();
  }
  snapshotMoveState() {
    const snap = new Map;
    for (const scope of this.scopes) {
      for (const [, info] of scope)
        snap.set(info, info.moved);
    }
    return snap;
  }
  restoreMoveState(snap) {
    for (const [info, moved] of snap)
      info.moved = moved;
  }
  declare(name, info) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) {
      this.error(`variable '${name}' already declared in this scope`);
      return;
    }
    scope.set(name, info);
  }
  lookup(name) {
    for (let i = this.scopes.length - 1;i >= 0; i--) {
      const info = this.scopes[i].get(name);
      if (info) {
        if (this.closureScopeDepth !== null && i < this.closureScopeDepth && this.currentClosureCaptures) {
          if (!this.currentClosureCaptures.has(name)) {
            this.currentClosureCaptures.set(name, { name, type: info.type, mutable: info.mutable });
          }
        }
        return info;
      }
    }
    return null;
  }
  check(program) {
    const ptrU8 = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
    const i32t = { tag: "int", bits: 32, signed: true };
    this.functions.set("print", { params: [], ret: { tag: "void" }, variadic: true });
    this.functions.set("eprint", { params: [], ret: { tag: "void" }, variadic: true });
    this.functions.set("format", { params: [], ret: { tag: "string" }, variadic: true });
    this.functions.set("flush", { params: [], ret: { tag: "void" }, variadic: false });
    this.functions.set("exit", { params: [{ type: i32t, name: "code" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("_miloArgCount", { params: [], ret: { tag: "int", bits: 64, signed: true }, variadic: false });
    this.functions.set("_miloArgAt", { params: [{ type: { tag: "int", bits: 64, signed: true }, name: "index" }], ret: { tag: "string" }, variadic: false });
    this.functions.set("_cstrToString", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "string" }, variadic: false });
    this.functions.set("_loadU8", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "int", bits: 8, signed: false }, variadic: false });
    this.functions.set("_loadI32", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "int", bits: 32, signed: true }, variadic: false });
    this.functions.set("_callClosureVoid", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "fn" }, { type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "env" }], ret: { tag: "void" }, variadic: false });
    this.functions.set("assert", { params: [{ type: { tag: "bool" }, name: "cond" }], ret: { tag: "void" }, variadic: true });
    this.functions.set("max", { params: [{ type: i32t, name: "a" }, { type: i32t, name: "b" }], ret: i32t, variadic: false });
    this.functions.set("min", { params: [{ type: i32t, name: "a" }, { type: i32t, name: "b" }], ret: i32t, variadic: false });
    this.registerBuiltinTraits();
    this.registerBuiltinOption();
    this.registerBuiltinResult();
    for (const e of program.enums) {
      if (e.typeParams.length === 0) {
        this.enums.set(e.name, { variants: new Map });
      }
    }
    for (const s of program.structs) {
      if (s.typeParams.length > 0) {
        const fields = s.fields.map((f) => ({ name: f.name, type: typeFromAst(f.type) }));
        this.genericStructs.set(s.name, { typeParams: s.typeParams.map((tp) => tp.name), fields, decl: s });
      }
    }
    for (const s of program.structs) {
      if (s.typeParams.length === 0) {
        const fields = s.fields.map((f) => ({ name: f.name, type: this.resolve(f.type) }));
        for (const f of fields) {
          if (f.type.tag === "ref") {
            this.error(`struct '${s.name}' field '${f.name}': references cannot be stored in structs`, undefined, `references are second-class — use an owned type instead`);
          }
        }
        this.structs.set(s.name, { fields });
      }
    }
    for (const e of program.enums) {
      if (e.typeParams.length > 0) {
        const variants = new Map;
        e.variants.forEach((v, i) => {
          variants.set(v.name, { tag: i, fields: v.fields.map((f) => typeFromAst(f)) });
        });
        this.genericEnums.set(e.name, { typeParams: e.typeParams.map((tp) => tp.name), variants, decl: e });
      }
    }
    for (const e of program.enums) {
      if (e.typeParams.length === 0) {
        this.genericEnums.delete(e.name);
        this.enums.set(e.name, { variants: new Map });
        const variants = new Map;
        e.variants.forEach((v, i) => {
          const fields = v.fields.map((f) => this.resolve(f));
          for (const field of fields) {
            if (field.tag === "enum" && field.name === e.name) {
              this.error(`enum '${e.name}' has infinite size due to recursive field`, undefined, `wrap the recursive field in Box<${e.name}> for heap allocation`);
            }
          }
          variants.set(v.name, { tag: i, fields });
        });
        this.enums.set(e.name, { variants });
      }
    }
    for (const fn of program.functions) {
      if (fn.typeParams.length > 0) {
        this.genericFns.set(fn.name, { typeParams: fn.typeParams.map((tp) => tp.name), decl: fn });
        continue;
      }
      const params = fn.params.map((p) => ({ type: this.resolve(p.type), name: p.name }));
      const ret = this.resolve(fn.retType);
      if (ret.tag === "ref") {
        this.error(`function '${fn.name}': cannot return a reference`, undefined, `references are second-class — return an owned value instead`);
      }
      this.functions.set(fn.name, { params, ret, variadic: fn.isVariadic, isExtern: fn.isExtern });
    }
    for (const t of program.traits) {
      for (const sup of t.supertraits) {
        if (!this.traits.has(sup)) {
          this.error(`supertrait '${sup}' not found`, t.span);
        }
      }
      const methods = new Map;
      for (const m of t.methods) {
        const params = m.params.map((p) => ({ name: p.name, type: this.resolve(p.type) }));
        const ret = this.resolve(m.retType);
        methods.set(m.name, { params, ret, hasDefault: m.body !== null });
      }
      this.traits.set(t.name, { name: t.name, supertraits: t.supertraits, methods });
    }
    const derivedImpls = this.processDerives(program);
    const implFnsToCheck = [];
    for (const impl of [...program.impls, ...derivedImpls]) {
      this.registerImpl(impl, program, implFnsToCheck);
    }
    for (const fn of program.functions) {
      if (!fn.isExtern && fn.typeParams.length === 0)
        this.checkFunction(fn);
    }
    for (const fn of implFnsToCheck) {
      this.checkFunction(fn);
    }
    while (this._pendingImplFns.length > 0) {
      const batch = this._pendingImplFns.splice(0);
      for (const fn of batch) {
        this.checkFunction(fn);
      }
    }
    return {
      diagnostics: this.diagnostics,
      exprTypes: this.exprTypes,
      autoBorrowed: this.autoBorrowed,
      rewrittenCalls: this.rewrittenCalls,
      rewrittenEnums: this.rewrittenEnums,
      rewrittenStructLits: this.rewrittenStructLits,
      movedExprs: this.movedExprs,
      borrowedExprs: this.borrowedExprs,
      autoWrappedOption: this.autoWrappedOption,
      arrayToVecCoercions: this.arrayToVecCoercions,
      functions: this.functions,
      structs: this.structs,
      enums: this.enums,
      dropImpls: this.dropImpls,
      monomorphizedFns: this.monomorphizedFns,
      monomorphizedEnums: this.monomorphizedDecls,
      monomorphizedStructs: this.monomorphizedStructDecls,
      closureCaptures: this.closureCaptures,
      closureCalls: this.closureCalls,
      resolvedMethods: this.resolvedMethods,
      resolvedOperators: this.resolvedOperators,
      fnFieldCalls: this.fnFieldCalls,
      propagateConversions: this.propagateConversions
    };
  }
  processDerives(program) {
    const result = [];
    const explicitEq = new Set;
    for (const s of program.structs) {
      if (!s.attributes || s.typeParams.length > 0)
        continue;
      for (const attr of s.attributes) {
        if (attr.name !== "derive")
          continue;
        for (const traitName of attr.args) {
          if (traitName === "Eq")
            explicitEq.add(s.name);
          const impl = this.synthesizeDeriveImpl(s, traitName);
          if (impl)
            result.push(impl);
        }
      }
    }
    const derived = new Set;
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of program.structs) {
        if (s.typeParams.length > 0)
          continue;
        if (explicitEq.has(s.name))
          continue;
        if (derived.has(s.name))
          continue;
        if (program.impls.some((i) => i.traitName === "Eq" && i.typeName === s.name))
          continue;
        let allEq = true;
        for (const f of s.fields) {
          const ft = this.resolve(f.type);
          if (!this.canAutoEq(ft)) {
            allEq = false;
            break;
          }
        }
        if (allEq) {
          const impl = this.deriveEq(s, true);
          if (impl) {
            result.push(impl);
            derived.add(s.name);
            changed = true;
          }
        }
      }
    }
    return result;
  }
  canAutoEq(t) {
    if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "string")
      return true;
    if (t.tag === "enum")
      return true;
    if (t.tag === "struct") {
      const impls = this.traitImpls.get(t.name);
      return !!impls?.some((i) => i.traitName === "Eq");
    }
    return false;
  }
  synthesizeDeriveImpl(s, traitName) {
    if (traitName === "Eq")
      return this.deriveEq(s);
    this.error(`cannot derive '${traitName}' — only Eq is supported`);
    return null;
  }
  deriveEq(s, skipValidation = false) {
    if (!skipValidation) {
      for (const f of s.fields) {
        const ft = this.resolve(f.type);
        const ftName = typeName(ft);
        if (!this.typeImplementsTrait(ftName, "Eq")) {
          this.error(`cannot derive Eq for '${s.name}': field '${f.name}' of type '${ftName}' does not implement Eq`);
        }
      }
    }
    const selfParam = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    const otherParam = { name: "other", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
    let body;
    if (s.fields.length === 0) {
      body = { kind: "BoolLit", value: true };
    } else {
      const comparisons = s.fields.map((f) => ({
        kind: "BinOp",
        op: "==",
        left: { kind: "FieldAccess", object: { kind: "Ident", name: "self" }, field: f.name },
        right: { kind: "FieldAccess", object: { kind: "Ident", name: "other" }, field: f.name }
      }));
      body = comparisons.reduce((acc, cmp) => ({
        kind: "BinOp",
        op: "&&",
        left: acc,
        right: cmp
      }));
    }
    const eqFn = {
      kind: "Function",
      name: "eq",
      typeParams: [],
      params: [selfParam, otherParam],
      retType: simpleType("bool"),
      body: [{ kind: "Return", value: body }],
      isExtern: false,
      isVariadic: false
    };
    return {
      kind: "ImplDecl",
      traitName: "Eq",
      typeName: s.name,
      typeParams: [],
      methods: [eqFn]
    };
  }
  registerBuiltinOption() {
    if (this.genericEnums.has("Option"))
      return;
    const decl = {
      kind: "EnumDecl",
      name: "Option",
      typeParams: [{ name: "T", bounds: [] }],
      variants: [
        { name: "Some", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
        { name: "None", fields: [] }
      ]
    };
    const variants = new Map;
    variants.set("Some", { tag: 0, fields: [{ tag: "struct", name: "T" }] });
    variants.set("None", { tag: 1, fields: [] });
    this.genericEnums.set("Option", { typeParams: ["T"], variants, decl });
  }
  registerBuiltinResult() {
    if (this.genericEnums.has("Result"))
      return;
    const decl = {
      kind: "EnumDecl",
      name: "Result",
      typeParams: [{ name: "T", bounds: [] }, { name: "E", bounds: [] }],
      variants: [
        { name: "Ok", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
        { name: "Err", fields: [{ name: "E", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] }
      ]
    };
    const variants = new Map;
    variants.set("Ok", { tag: 0, fields: [{ tag: "struct", name: "T" }] });
    variants.set("Err", { tag: 1, fields: [{ tag: "struct", name: "E" }] });
    this.genericEnums.set("Result", {
      typeParams: ["T", "E"],
      typeParamDefaults: [null, { tag: "string" }],
      variants,
      decl
    });
  }
  registerBuiltinTraits() {
    const selfRef = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: false };
    const bool_t = { tag: "bool" };
    const i32_t = { tag: "int", bits: 32, signed: true };
    const u64_t = { tag: "int", bits: 64, signed: false };
    const string_t = { tag: "string" };
    this.traits.set("Eq", {
      name: "Eq",
      supertraits: [],
      methods: new Map([
        ["eq", { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: bool_t, hasDefault: false }]
      ])
    });
    this.traits.set("Hash", {
      name: "Hash",
      supertraits: [],
      methods: new Map([
        ["hash", { params: [{ name: "self", type: selfRef }], ret: u64_t, hasDefault: false }]
      ])
    });
    this.traits.set("Clone", {
      name: "Clone",
      supertraits: [],
      methods: new Map([
        ["clone", { params: [{ name: "self", type: selfRef }], ret: { tag: "struct", name: "Self" }, hasDefault: false }]
      ])
    });
    this.traits.set("Display", {
      name: "Display",
      supertraits: [],
      methods: new Map([
        ["toString", { params: [{ name: "self", type: selfRef }], ret: string_t, hasDefault: false }]
      ])
    });
    const selfType = { tag: "struct", name: "Self" };
    for (const [traitName, methodName] of [["Add", "add"], ["Sub", "sub"], ["Mul", "mul"], ["Div", "div"]]) {
      this.traits.set(traitName, {
        name: traitName,
        supertraits: [],
        methods: new Map([
          [methodName, { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: selfType, hasDefault: false }]
        ])
      });
    }
    const selfRefMut = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: true };
    this.traits.set("Drop", {
      name: "Drop",
      supertraits: [],
      methods: new Map([
        ["drop", { params: [{ name: "self", type: selfRefMut }], ret: { tag: "void" }, hasDefault: false }]
      ])
    });
    const primTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool", "string"];
    for (const pt of primTypes) {
      const eqMethods = new Map;
      eqMethods.set("eq", { params: [{ type: selfRef, name: "self" }, { type: selfRef, name: "other" }], ret: bool_t, variadic: false });
      this.traitImpls.set(pt, [{ traitName: "Eq", typeName: pt, methods: eqMethods }]);
    }
    const hashTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "bool", "string"];
    for (const pt of hashTypes) {
      const existing = this.traitImpls.get(pt) || [];
      const hashMethods = new Map;
      hashMethods.set("hash", { params: [{ type: selfRef, name: "self" }], ret: u64_t, variadic: false });
      existing.push({ traitName: "Hash", typeName: pt, methods: hashMethods });
      this.traitImpls.set(pt, existing);
    }
  }
  resolveTypeNameForImpl(name) {
    if (this.structs.has(name) || this.genericStructs.has(name))
      return name;
    if (this.enums.has(name) || this.genericEnums.has(name))
      return name;
    return name;
  }
  substituteSelfInMiloType(ty, concreteName) {
    if (ty.name === "Self")
      return { ...ty, name: concreteName };
    if (ty.typeArgs)
      return { ...ty, typeArgs: ty.typeArgs.map((a) => this.substituteSelfInMiloType(a, concreteName)) };
    return ty;
  }
  registerImpl(impl, program, implFnsToCheck) {
    const typeName2 = impl.typeName;
    if (impl.typeParams && impl.typeParams.length > 0 && !impl.traitName) {
      const existing = this.genericImpls.get(typeName2) || [];
      existing.push({ impl, program });
      this.genericImpls.set(typeName2, existing);
      return;
    }
    if (impl.traitName) {
      const trait = this.traits.get(impl.traitName);
      if (!trait) {
        this.error(`unknown trait '${impl.traitName}'`, impl.span);
        return;
      }
      const existing = this.traitImpls.get(typeName2) || [];
      if (existing.some((i) => i.traitName === impl.traitName)) {
        this.error(`duplicate impl '${impl.traitName}' for '${typeName2}'`, impl.span);
        return;
      }
      if (impl.traitName === "Drop") {
        const builtins = ["string", "Vec", "Box", "HashMap"];
        if (builtins.includes(typeName2)) {
          this.error(`cannot impl Drop for built-in type '${typeName2}'`, impl.span);
          return;
        }
        if (!this.structs.has(typeName2) && !this.enums.has(typeName2)) {
          this.error(`impl Drop requires a struct or enum type, got '${typeName2}'`, impl.span);
          return;
        }
        this.dropImpls.add(typeName2);
      }
      for (const sup of trait.supertraits) {
        if (!existing.some((i) => i.traitName === sup)) {
          this.error(`impl '${impl.traitName}' for '${typeName2}' requires impl '${sup}' for '${typeName2}'`, impl.span);
        }
      }
      const implMethodNames = new Set(impl.methods.map((m) => m.name));
      for (const [mName, mInfo] of trait.methods) {
        if (!mInfo.hasDefault && !implMethodNames.has(mName)) {
          this.error(`impl '${impl.traitName}' for '${typeName2}': missing required method '${mName}'`, impl.span);
        }
      }
      const methods = new Map;
      for (const m of impl.methods) {
        const traitMethod = trait.methods.get(m.name);
        if (!traitMethod) {
          this.error(`method '${m.name}' is not defined in trait '${impl.traitName}'`, impl.span);
          continue;
        }
        const mangled = `${typeName2}$${impl.traitName}$${m.name}`;
        const concreteFn = {
          ...m,
          name: mangled,
          params: m.params.map((p) => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, typeName2) })),
          retType: this.substituteSelfInMiloType(m.retType, typeName2)
        };
        const params = concreteFn.params.map((p) => ({ type: this.resolve(p.type), name: p.name }));
        const ret = this.resolve(concreteFn.retType);
        this.functions.set(mangled, { params, ret, variadic: false });
        methods.set(m.name, { params, ret, variadic: false });
        this.monomorphizedFns.push(concreteFn);
        implFnsToCheck.push(concreteFn);
      }
      for (const [mName, mInfo] of trait.methods) {
        if (mInfo.hasDefault && !implMethodNames.has(mName)) {
          const traitDecl = program.traits.find((t) => t.name === impl.traitName);
          const traitMethod = traitDecl.methods.find((m) => m.name === mName);
          const mangled = `${typeName2}$${impl.traitName}$${mName}`;
          const concreteFn = {
            kind: "Function",
            name: mangled,
            typeParams: [],
            params: traitMethod.params.map((p) => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, typeName2) })),
            retType: this.substituteSelfInMiloType(traitMethod.retType, typeName2),
            body: traitMethod.body,
            isExtern: false,
            isVariadic: false
          };
          const params = concreteFn.params.map((p) => ({ type: this.resolve(p.type), name: p.name }));
          const ret = this.resolve(concreteFn.retType);
          this.functions.set(mangled, { params, ret, variadic: false });
          methods.set(mName, { params, ret, variadic: false });
          this.monomorphizedFns.push(concreteFn);
          implFnsToCheck.push(concreteFn);
        }
      }
      existing.push({ traitName: impl.traitName, typeName: typeName2, methods });
      this.traitImpls.set(typeName2, existing);
    } else {
      if (this.inherentImpls.has(typeName2)) {
        const existing = this.inherentImpls.get(typeName2);
        for (const m of impl.methods) {
          const mangled = `${typeName2}$${m.name}`;
          const concreteFn = {
            ...m,
            name: mangled,
            params: m.params.map((p) => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, typeName2) })),
            retType: this.substituteSelfInMiloType(m.retType, typeName2)
          };
          const params = concreteFn.params.map((p) => ({ type: this.resolve(p.type), name: p.name }));
          const ret = this.resolve(concreteFn.retType);
          this.functions.set(mangled, { params, ret, variadic: false });
          existing.methods.set(m.name, { params, ret, variadic: false });
          this.monomorphizedFns.push(concreteFn);
          implFnsToCheck.push(concreteFn);
        }
      } else {
        const methods = new Map;
        for (const m of impl.methods) {
          const mangled = `${typeName2}$${m.name}`;
          const concreteFn = {
            ...m,
            name: mangled,
            params: m.params.map((p) => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, typeName2) })),
            retType: this.substituteSelfInMiloType(m.retType, typeName2)
          };
          const params = concreteFn.params.map((p) => ({ type: this.resolve(p.type), name: p.name }));
          const ret = this.resolve(concreteFn.retType);
          this.functions.set(mangled, { params, ret, variadic: false });
          methods.set(m.name, { params, ret, variadic: false });
          this.monomorphizedFns.push(concreteFn);
          implFnsToCheck.push(concreteFn);
        }
        this.inherentImpls.set(typeName2, { traitName: null, typeName: typeName2, methods });
      }
    }
  }
  resolveMethod(objTypeName, methodName) {
    const inherent = this.inherentImpls.get(objTypeName);
    if (inherent) {
      const sig = inherent.methods.get(methodName);
      if (sig)
        return { mangled: `${objTypeName}$${methodName}`, sig };
    }
    const impls = this.traitImpls.get(objTypeName);
    if (impls) {
      const matches = [];
      for (const impl of impls) {
        const sig = impl.methods.get(methodName);
        if (sig)
          matches.push({ mangled: `${objTypeName}$${impl.traitName}$${methodName}`, sig });
      }
      if (matches.length === 1)
        return matches[0];
      if (matches.length > 1) {
        this.error(`ambiguous method '${methodName}' on '${objTypeName}' — implemented by multiple traits`);
        return matches[0];
      }
    }
    return null;
  }
  typeImplementsTrait(tName, traitName) {
    const impls = this.traitImpls.get(tName);
    if (!impls)
      return false;
    if (impls.some((i) => i.traitName === traitName))
      return true;
    const trait = this.traits.get(traitName);
    if (trait) {
      for (const sup of trait.supertraits) {
        if (!this.typeImplementsTrait(tName, sup))
          return false;
      }
    }
    return false;
  }
  checkFunction(fn) {
    this.pushScope();
    const retType = this.resolve(fn.retType);
    this.currentFnRetType = retType;
    for (const p of fn.params) {
      const pType = this.resolve(p.type);
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false, borrowed: false, read: false });
    }
    for (const stmt of fn.body)
      this.checkStmt(stmt, retType);
    if (!fn.isExtern) {
      for (const p of fn.params) {
        const info = this.lookup(p.name);
        if (!info)
          continue;
        if (info.type.tag === "ref")
          continue;
        if (isCopy(info.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n)))
          continue;
        if (!info.moved) {
          this.warn("unused-move", `parameter '${p.name}' is never moved — consider taking '&${typeName(info.type)}' instead`, fn.span, `passing by reference avoids requiring callers to give up ownership`);
        }
      }
    }
    const scope = this.scopes[this.scopes.length - 1];
    for (const [name, info] of scope) {
      if (info.read || name.startsWith("_"))
        continue;
      this.warn("unused-variable", `unused variable '${name}'`, info.span, `prefix with underscore to silence: '_${name}'`);
    }
    this.popScope();
  }
  checkStmt(stmt, fnRetType) {
    const sp2 = stmt.span;
    switch (stmt.kind) {
      case "LetDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
        const valType = this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(hint);
          if (optInner && typeEq(optInner, valType)) {
            this.autoWrappedOption.set(stmt.value, hint.name);
          } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
            this.arrayToVecCoercions.add(stmt.value);
          } else {
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp2);
          }
        }
        this.declare(stmt.name, { type: hint ?? valType, mutable: false, moved: false, borrowed: false, read: false, span: sp2 });
        this.tryMove(stmt.value);
        break;
      }
      case "VarDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
        const valType = this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(hint);
          if (optInner && typeEq(optInner, valType)) {
            this.autoWrappedOption.set(stmt.value, hint.name);
          } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
            this.arrayToVecCoercions.add(stmt.value);
          } else {
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp2);
          }
        }
        this.declare(stmt.name, { type: hint ?? valType, mutable: true, moved: false, borrowed: false, read: false, span: sp2 });
        this.tryMove(stmt.value);
        break;
      }
      case "Assign": {
        const targetInfo = this.resolveAssignTarget(stmt.target);
        if (!targetInfo)
          break;
        if (!targetInfo.mutable) {
          this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`, sp2, `declare with 'var' instead of 'let' to make it mutable`);
          break;
        }
        const valType = this.checkExprWithHint(stmt.value, targetInfo.type);
        if (!typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
          const optInner = this.optionInnerType(targetInfo.type);
          if (optInner && typeEq(optInner, valType)) {
            this.autoWrappedOption.set(stmt.value, targetInfo.type.name);
          } else {
            this.error(`type mismatch: cannot assign ${typeName(valType)} to ${typeName(targetInfo.type)}`, sp2);
          }
        }
        if (stmt.target.kind === "Ident") {
          const info = this.lookup(stmt.target.name);
          if (info)
            info.moved = false;
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Return": {
        if (!stmt.value) {
          if (fnRetType.tag !== "void")
            this.error(`return without value in function returning ${typeName(fnRetType)}`, sp2);
        } else {
          const prev = this.inReturnInLoop;
          if (this.loopDepth > 0)
            this.inReturnInLoop = true;
          const valType = this.checkExprWithHint(stmt.value, fnRetType);
          if (!typeEq(fnRetType, valType) && valType.tag !== "unknown" && fnRetType.tag !== "unknown") {
            this.error(`return type mismatch: expected ${typeName(fnRetType)}, got ${typeName(valType)}`, sp2);
          }
          this.tryMove(stmt.value);
          this.inReturnInLoop = prev;
        }
        break;
      }
      case "IfStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`if condition must be bool, got ${typeName(condType)}`, sp2);
        }
        const preMoves = this.snapshotMoveState();
        this.pushScope();
        for (const s of stmt.thenBody)
          this.checkStmt(s, fnRetType);
        this.popScope();
        const thenReturns = this.bodyAlwaysReturns(stmt.thenBody);
        if (stmt.elseBody) {
          const afterThen = this.snapshotMoveState();
          this.restoreMoveState(preMoves);
          this.pushScope();
          for (const s of stmt.elseBody)
            this.checkStmt(s, fnRetType);
          this.popScope();
          const elseReturns = this.bodyAlwaysReturns(stmt.elseBody);
          const afterElse = this.snapshotMoveState();
          this.restoreMoveState(preMoves);
          for (const [info, m] of afterThen) {
            if (m && !thenReturns)
              info.moved = true;
          }
          for (const [info, m] of afterElse) {
            if (m && !elseReturns)
              info.moved = true;
          }
        } else if (thenReturns) {
          this.restoreMoveState(preMoves);
        }
        break;
      }
      case "WhileStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`while condition must be bool, got ${typeName(condType)}`, sp2);
        }
        const preMoves = this.snapshotMoveState();
        this.returnOnlyMovesStack.push(new Set);
        this.pushScope();
        this.loopDepth++;
        for (const s of stmt.body)
          this.checkStmt(s, fnRetType);
        this.loopDepth--;
        this.popScope();
        const returnMoves = this.returnOnlyMovesStack.pop();
        for (const scope of this.scopes) {
          for (const [name, info] of scope) {
            if (preMoves.get(info) === false && info.moved) {
              if (returnMoves.has(info)) {
                info.moved = false;
              } else {
                this.error(`cannot move '${name}' out of a loop`, sp2);
              }
            }
          }
        }
        break;
      }
      case "ForInStmt": {
        if (stmt.iterable.kind === "RangeExpr") {
          const startType = this.checkExpr(stmt.iterable.start);
          const endType = this.checkExpr(stmt.iterable.end);
          if (startType.tag !== "int" && startType.tag !== "unknown") {
            this.error(`for range start must be an integer, got ${typeName(startType)}`, sp2);
          }
          if (endType.tag !== "int" && endType.tag !== "unknown") {
            this.error(`for range end must be an integer, got ${typeName(endType)}`, sp2);
          }
          if (stmt.varName2) {
            this.error("range for loop takes one binding, not two", sp2);
          }
          let varType;
          if (startType.tag === "int" && endType.tag === "int") {
            varType = startType.bits >= endType.bits ? startType : endType;
          } else {
            varType = startType.tag === "int" ? startType : endType;
          }
          this.setType(stmt.iterable, varType);
          const preMoves = this.snapshotMoveState();
          this.returnOnlyMovesStack.push(new Set);
          this.pushScope();
          this.declare(stmt.varName, { type: varType, mutable: false, moved: false, borrowed: false, read: false });
          this.loopDepth++;
          for (const s of stmt.body)
            this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves = this.returnOnlyMovesStack.pop();
          for (const scope of this.scopes) {
            for (const [name, info] of scope) {
              if (preMoves.get(info) === false && info.moved) {
                if (returnMoves.has(info)) {
                  info.moved = false;
                } else {
                  this.error(`cannot move '${name}' out of a loop`, sp2);
                }
              }
            }
          }
        } else {
          const iterType = this.checkExpr(stmt.iterable);
          if (iterType.tag === "vec") {
            const elemRef = { tag: "ref", inner: iterType.element, mutable: false };
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info)
                info.borrowed = true;
            }
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set);
            this.pushScope();
            if (stmt.varName2) {
              const idxType = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
              this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            } else {
              this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body)
              this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves = this.returnOnlyMovesStack.pop();
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves.has(info)) {
                    info.moved = false;
                  } else {
                    this.error(`cannot move '${name}' out of a loop`, sp2);
                  }
                }
              }
            }
          } else if (iterType.tag === "string") {
            const byteType = { tag: "int", bits: 8, signed: false };
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set);
            this.pushScope();
            if (stmt.varName2) {
              const idxType = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
              this.declare(stmt.varName2, { type: byteType, mutable: false, moved: false, borrowed: false, read: false });
            } else {
              this.declare(stmt.varName, { type: byteType, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body)
              this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves3 = this.returnOnlyMovesStack.pop();
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves3.has(info)) {
                    info.moved = false;
                  } else {
                    this.error(`cannot move '${name}' out of a loop`, sp2);
                  }
                }
              }
            }
          } else if (iterType.tag === "hashmap") {
            const keyRef = { tag: "ref", inner: iterType.key, mutable: false };
            const valRef = { tag: "ref", inner: iterType.value, mutable: false };
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info)
                info.borrowed = true;
            }
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set);
            this.pushScope();
            this.declare(stmt.varName, { type: keyRef, mutable: false, moved: false, borrowed: false, read: false });
            if (stmt.varName2) {
              this.declare(stmt.varName2, { type: valRef, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body)
              this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves4 = this.returnOnlyMovesStack.pop();
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves4.has(info)) {
                    info.moved = false;
                  } else {
                    this.error(`cannot move '${name}' out of a loop`, sp2);
                  }
                }
              }
            }
          } else if (iterType.tag === "array") {
            const elemRef = { tag: "ref", inner: iterType.element, mutable: false };
            if (stmt.iterable.kind === "Ident") {
              const info = this.lookup(stmt.iterable.name);
              if (info)
                info.borrowed = true;
            }
            const preMoves = this.snapshotMoveState();
            this.returnOnlyMovesStack.push(new Set);
            this.pushScope();
            if (stmt.varName2) {
              const idxType = { tag: "int", bits: 64, signed: true };
              this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
              this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            } else {
              this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
            }
            this.loopDepth++;
            for (const s of stmt.body)
              this.checkStmt(s, fnRetType);
            this.loopDepth--;
            this.popScope();
            const returnMoves5 = this.returnOnlyMovesStack.pop();
            for (const scope of this.scopes) {
              for (const [name, info] of scope) {
                if (preMoves.get(info) === false && info.moved) {
                  if (returnMoves5.has(info)) {
                    info.moved = false;
                  } else {
                    this.error(`cannot move '${name}' out of a loop`, sp2);
                  }
                }
              }
            }
          } else if (iterType.tag !== "unknown") {
            this.error(`cannot iterate over type '${typeName(iterType)}'`, sp2);
          }
        }
        break;
      }
      case "BreakStmt":
        if (this.loopDepth === 0)
          this.error("'break' outside of loop", sp2);
        break;
      case "ContinueStmt":
        if (this.loopDepth === 0)
          this.error("'continue' outside of loop", sp2);
        break;
      case "ExprStmt": {
        const exprType = this.checkExpr(stmt.expr);
        if (exprType.tag === "enum") {
          const enumInfo = this.enums.get(exprType.name);
          const base = enumInfo?.baseName;
          if (base === "Result" || base === "Option") {
            this.warn("unused-result", `unused ${base} value — this may contain an error that should be handled`, sp2, `use 'let _ = ...' to discard explicitly`);
          }
        }
        break;
      }
      case "MatchStmt": {
        const subjType = this.checkExpr(stmt.subject);
        const isEnum = subjType.tag === "enum";
        const isLiteralType = subjType.tag === "int" || subjType.tag === "float" || subjType.tag === "string" || subjType.tag === "bool";
        if (!isEnum && !isLiteralType && subjType.tag !== "unknown") {
          this.error(`match subject must be an enum, integer, float, string, or bool, got ${typeName(subjType)}`, sp2);
          break;
        }
        if (isLiteralType) {
          let hasWildcard = false;
          const preMoves = this.snapshotMoveState();
          const mergedMoves = new Map;
          for (const arm of stmt.arms) {
            if (arm.pattern.kind === "WildcardPattern") {
              hasWildcard = true;
            } else if (arm.pattern.kind === "LiteralPattern") {
              const ps = arm.pattern.span;
              if (subjType.tag === "int" && arm.pattern.literalKind !== "int") {
                this.error(`expected integer literal in match arm`, ps);
              } else if (subjType.tag === "float" && arm.pattern.literalKind !== "float" && arm.pattern.literalKind !== "int") {
                this.error(`expected numeric literal in match arm`, ps);
              } else if (subjType.tag === "string" && arm.pattern.literalKind !== "string") {
                this.error(`expected string literal in match arm`, ps);
              } else if (subjType.tag === "bool" && arm.pattern.literalKind !== "bool") {
                this.error(`expected bool literal in match arm`, ps);
              }
            } else if (arm.pattern.kind === "EnumPattern") {
              this.error(`cannot use enum pattern when matching on ${typeName(subjType)}`, arm.pattern.span);
            }
            this.restoreMoveState(preMoves);
            this.pushScope();
            for (const s of arm.body)
              this.checkStmt(s, fnRetType);
            this.popScope();
            for (const [info, moved] of this.snapshotMoveState()) {
              if (moved)
                mergedMoves.set(info, true);
            }
          }
          this.restoreMoveState(preMoves);
          for (const [info] of mergedMoves)
            info.moved = true;
          if (!hasWildcard && subjType.tag === "bool") {
            const hasTrueArm = stmt.arms.some((a) => a.pattern.kind === "LiteralPattern" && a.pattern.value === true);
            const hasFalseArm = stmt.arms.some((a) => a.pattern.kind === "LiteralPattern" && a.pattern.value === false);
            if (!hasTrueArm || !hasFalseArm) {
              this.error(`non-exhaustive match on bool`, sp2);
            }
          } else if (!hasWildcard) {
            this.error(`match on ${typeName(subjType)} requires a wildcard '_' arm`, sp2);
          }
        } else if (isEnum) {
          const enumInfo = this.enums.get(subjType.name);
          const covered = new Set;
          let hasWildcard = false;
          const preMoves = this.snapshotMoveState();
          const mergedMoves = new Map;
          for (const arm of stmt.arms) {
            if (arm.pattern.kind === "WildcardPattern") {
              hasWildcard = true;
            } else if (arm.pattern.kind === "EnumPattern") {
              const ps = arm.pattern.span;
              if (arm.pattern.enumName !== subjType.name && enumInfo.baseName !== arm.pattern.enumName) {
                this.error(`pattern enum '${arm.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
              }
              const variant = enumInfo.variants.get(arm.pattern.variant);
              if (!variant) {
                this.error(`enum '${subjType.name}' has no variant '${arm.pattern.variant}'`, ps);
                continue;
              }
              if (covered.has(arm.pattern.variant)) {
                this.error(`duplicate match arm for '${arm.pattern.variant}'`, ps);
              }
              covered.add(arm.pattern.variant);
              if (arm.pattern.bindings.length !== variant.fields.length) {
                this.error(`variant '${arm.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${arm.pattern.bindings.length} bindings`, ps);
              }
            } else if (arm.pattern.kind === "LiteralPattern") {
              this.error(`cannot use literal pattern when matching on enum`, arm.pattern.span);
            }
            this.restoreMoveState(preMoves);
            this.pushScope();
            if (arm.pattern.kind === "EnumPattern") {
              const variant = enumInfo.variants.get(arm.pattern.variant);
              if (variant) {
                for (let i = 0;i < Math.min(arm.pattern.bindings.length, variant.fields.length); i++) {
                  this.declare(arm.pattern.bindings[i], { type: variant.fields[i], mutable: false, moved: false, borrowed: false, read: false });
                }
              }
            }
            for (const s of arm.body)
              this.checkStmt(s, fnRetType);
            this.popScope();
            for (const [info, moved] of this.snapshotMoveState()) {
              if (moved)
                mergedMoves.set(info, true);
            }
          }
          this.restoreMoveState(preMoves);
          for (const [info] of mergedMoves)
            info.moved = true;
          if (!hasWildcard) {
            for (const [name] of enumInfo.variants) {
              if (!covered.has(name)) {
                this.error(`non-exhaustive match: missing variant '${name}'`, sp2);
              }
            }
          }
        }
        this.tryMove(stmt.subject);
        break;
      }
      case "IfLetStmt": {
        const subjType = this.checkExpr(stmt.subject);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`if let subject must be an enum, got ${typeName(subjType)}`, sp2);
          break;
        }
        if (subjType.tag === "enum" && stmt.pattern.kind === "EnumPattern") {
          const enumInfo = this.enums.get(subjType.name);
          const ps = stmt.pattern.span;
          if (stmt.pattern.enumName !== subjType.name && enumInfo.baseName !== stmt.pattern.enumName) {
            this.error(`pattern enum '${stmt.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
          }
          const variant = enumInfo.variants.get(stmt.pattern.variant);
          if (!variant) {
            this.error(`enum '${subjType.name}' has no variant '${stmt.pattern.variant}'`, ps);
          } else if (stmt.pattern.bindings.length !== variant.fields.length) {
            this.error(`variant '${stmt.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${stmt.pattern.bindings.length} bindings`, ps);
          }
          this.pushScope();
          if (variant) {
            for (let i = 0;i < Math.min(stmt.pattern.bindings.length, variant.fields.length); i++) {
              this.declare(stmt.pattern.bindings[i], { type: variant.fields[i], mutable: false, moved: false, borrowed: false, read: false });
            }
          }
          for (const s of stmt.thenBody)
            this.checkStmt(s, fnRetType);
          this.popScope();
        } else {
          this.pushScope();
          for (const s of stmt.thenBody)
            this.checkStmt(s, fnRetType);
          this.popScope();
        }
        if (stmt.elseBody) {
          this.pushScope();
          for (const s of stmt.elseBody)
            this.checkStmt(s, fnRetType);
          this.popScope();
        }
        this.tryMove(stmt.subject);
        break;
      }
      case "UnsafeBlock": {
        this.unsafeDepth++;
        this.pushScope();
        for (const s of stmt.body)
          this.checkStmt(s, fnRetType);
        this.popScope();
        this.unsafeDepth--;
        break;
      }
    }
  }
  optionInnerType(paramType) {
    if (paramType.tag !== "enum")
      return null;
    const info = this.enums.get(paramType.name);
    if (!info || info.baseName !== "Option")
      return null;
    const someVariant = info.variants.get("Some");
    if (!someVariant || someVariant.fields.length !== 1)
      return null;
    return someVariant.fields[0];
  }
  deref(t) {
    if (t.tag === "ref")
      return t.inner;
    return t;
  }
  bodyAlwaysReturns(body) {
    for (const s of body) {
      if (s.kind === "Return")
        return true;
      if (s.kind === "BreakStmt" || s.kind === "ContinueStmt")
        return true;
      if (s.kind === "IfStmt" && s.elseBody && this.bodyAlwaysReturns(s.thenBody) && this.bodyAlwaysReturns(s.elseBody))
        return true;
      if (s.kind === "MatchStmt") {
        let allReturn = true;
        for (const arm of s.arms) {
          if (!this.bodyAlwaysReturns(arm.body)) {
            allReturn = false;
            break;
          }
        }
        if (allReturn && s.arms.length > 0)
          return true;
      }
    }
    return false;
  }
  isPayloadFreeEnum(name) {
    const info = this.enums.get(name);
    if (!info)
      return false;
    for (const [, v] of info.variants)
      if (v.fields.length > 0)
        return false;
    return true;
  }
  allCopyEnumCache = new Map;
  isAllCopyEnum(name) {
    const cached = this.allCopyEnumCache.get(name);
    if (cached !== undefined)
      return cached;
    const info = this.enums.get(name);
    if (!info) {
      this.allCopyEnumCache.set(name, false);
      return false;
    }
    this.allCopyEnumCache.set(name, false);
    const result = [...info.variants.values()].every((v) => v.fields.every((f) => isCopy(f, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))));
    this.allCopyEnumCache.set(name, result);
    return result;
  }
  allCopyCache = new Map;
  isAllCopyStruct(name) {
    const cached = this.allCopyCache.get(name);
    if (cached !== undefined)
      return cached;
    const info = this.structs.get(name);
    if (!info) {
      this.allCopyCache.set(name, false);
      return false;
    }
    this.allCopyCache.set(name, false);
    const result = info.fields.every((f) => isCopy(f.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n)));
    this.allCopyCache.set(name, result);
    return result;
  }
  inferTypeParamsFromHint(retType, hint, typeParams, typeMap) {
    if (typeParams.includes(retType.name)) {
      typeMap.set(retType.name, hint);
      return;
    }
    if (hint.tag === "struct" && retType.typeArgs) {
      const info = this.structs.get(hint.name);
      if (info?.baseName === retType.name && info.typeArgs) {
        const gs = this.genericStructs.get(retType.name);
        if (gs) {
          for (let i = 0;i < retType.typeArgs.length && i < gs.typeParams.length; i++) {
            const ta = retType.typeArgs[i];
            if (typeParams.includes(ta.name) && i < info.typeArgs.length) {
              typeMap.set(ta.name, info.typeArgs[i]);
            }
          }
        }
      }
    }
  }
  tryMove(expr) {
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (info && !isCopy(info.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
        if (info.borrowed) {
          this.error(`cannot move '${expr.name}' because it is captured by a closure`, expr.span);
          return;
        }
        info.moved = true;
        this.movedExprs.add(expr);
        if (this.loopDepth > 0 && this.returnOnlyMovesStack.length > 0) {
          const cur = this.returnOnlyMovesStack[this.returnOnlyMovesStack.length - 1];
          if (this.inReturnInLoop) {
            cur.add(info);
          } else {
            cur.delete(info);
          }
        }
      }
    }
    if (expr.kind === "IndexAccess") {
      const elemType = this.exprTypes.get(expr);
      if (elemType && !isCopy(elemType, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
        let objectIsRef = false;
        if (expr.object.kind === "Ident") {
          const info = this.lookup(expr.object.name);
          if (info && info.type.tag === "ref")
            objectIsRef = true;
        }
        if (objectIsRef) {
          this.borrowedExprs.add(expr);
        } else {
          this.movedExprs.add(expr);
        }
      }
    }
  }
  resolveAssignTarget(expr) {
    const sp2 = expr.span;
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (!info) {
        this.error(`undefined variable '${expr.name}'`, sp2);
        return null;
      }
      if (info.type.tag === "ref" && info.type.mutable) {
        this.setType(expr, info.type.inner);
        return { type: info.type.inner, mutable: true };
      }
      if (info.type.tag === "ref" && info.mutable) {
        this.setType(expr, info.type);
        return { type: info.type, mutable: true };
      }
      const t = this.deref(info.type);
      this.setType(expr, t);
      return { type: t, mutable: info.mutable };
    }
    if (expr.kind === "FieldAccess") {
      const objType = this.checkExpr(expr.object);
      if (objType.tag === "struct") {
        const info = this.structs.get(objType.name);
        if (!info) {
          this.error(`unknown struct '${objType.name}'`, sp2);
          return null;
        }
        const field = info.fields.find((f) => f.name === expr.field);
        if (!field) {
          this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp2);
          return null;
        }
        this.setType(expr, field.type);
        const rootMut = this.isRootMutable(expr.object);
        return { type: field.type, mutable: rootMut };
      }
      this.error(`cannot access field on non-struct type ${typeName(objType)}`, sp2);
      return null;
    }
    if (expr.kind === "IndexAccess") {
      const objType = this.checkExpr(expr.object);
      this.checkExpr(expr.index);
      if (objType.tag === "array") {
        this.setType(expr, objType.element);
        const rootMut = this.isRootMutable(expr.object);
        return { type: objType.element, mutable: rootMut };
      }
      if (objType.tag === "vec") {
        this.setType(expr, objType.element);
        const rootMut = this.isRootMutable(expr.object);
        return { type: objType.element, mutable: rootMut };
      }
      if (objType.tag === "ptr") {
        this.setType(expr, objType.inner);
        return { type: objType.inner, mutable: true };
      }
      this.error(`cannot index non-array type ${typeName(objType)}`, sp2);
      return null;
    }
    if (expr.kind === "UnaryOp" && expr.op === "*") {
      const ot = this.checkExpr(expr.operand);
      if (ot.tag === "ptr") {
        this.setType(expr, ot.inner);
        return { type: ot.inner, mutable: true };
      }
      if (ot.tag === "box") {
        this.setType(expr, ot.inner);
        return { type: ot.inner, mutable: true };
      }
      this.error(`cannot dereference type '${typeName(ot)}' for assignment`, sp2);
      return null;
    }
    this.error("invalid assignment target", sp2);
    return null;
  }
  isRootMutable(expr) {
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      return info?.mutable ?? false;
    }
    if (expr.kind === "FieldAccess")
      return this.isRootMutable(expr.object);
    if (expr.kind === "IndexAccess")
      return this.isRootMutable(expr.object);
    return false;
  }
  describeExpr(expr) {
    if (expr.kind === "Ident")
      return expr.name;
    if (expr.kind === "FieldAccess")
      return `${this.describeExpr(expr.object)}.${expr.field}`;
    if (expr.kind === "IndexAccess")
      return `${this.describeExpr(expr.object)}[...]`;
    return "<expr>";
  }
  checkExprWithHint(expr, hint) {
    if (hint && expr.kind !== "EnumLit") {
      const inner = this.optionInnerType(hint);
      if (inner)
        hint = inner;
    }
    if (hint && (expr.kind === "IntLit" || expr.kind === "CharLit") && hint.tag === "int") {
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (hint && expr.kind === "FloatLit" && hint.tag === "float") {
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "new" && hint?.tag === "vec") {
      if (expr.args.length !== 0) {
        this.error(`'Vec.new' takes no arguments`, expr.span);
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && expr.enumName === "HashMap" && expr.variant === "new" && hint?.tag === "hashmap") {
      if (expr.args.length !== 0) {
        this.error(`'HashMap.new' takes no arguments`, sp);
      }
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (hint && expr.kind === "ArrayLit" && hint.tag === "array") {
      for (const elem of expr.elements) {
        this.checkExprWithHint(elem, hint.element);
      }
      const result2 = { tag: "array", element: hint.element, size: expr.elements.length };
      return this.setType(expr, result2);
    }
    if (hint && expr.kind === "ArrayLit" && hint.tag === "vec") {
      for (const elem of expr.elements) {
        this.checkExprWithHint(elem, hint.element);
        this.tryMove(elem);
      }
      return this.setType(expr, hint);
    }
    if (hint && expr.kind === "ArrayRepeat" && hint.tag === "array") {
      this.checkExprWithHint(expr.value, hint.element);
      const result2 = { tag: "array", element: hint.element, size: expr.count };
      return this.setType(expr, result2);
    }
    if (expr.kind === "EnumLit" && hint?.tag === "enum") {
      const sp2 = expr.span;
      const hintEnum = this.enums.get(hint.name);
      if (hintEnum && (hintEnum.baseName === expr.enumName || hint.name === expr.enumName)) {
        const variant = hintEnum.variants.get(expr.variant);
        if (!variant) {
          this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp2);
          return { tag: "unknown" };
        }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp2);
        }
        for (let i = 0;i < Math.min(expr.args.length, variant.fields.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`, sp2);
          }
          this.tryMove(expr.args[i]);
        }
        this.rewrittenEnums.set(expr, hint.name);
        this.exprTypes.set(expr, hint);
        return hint;
      }
    }
    if (hint && hint.tag === "struct" && expr.kind === "StructLit") {
      const genericInfo = this.genericStructs.get(expr.name);
      const hintInfo = this.structs.get(hint.name);
      if (genericInfo && hintInfo && hintInfo.baseName === expr.name) {
        const sp2 = expr.span;
        for (const f of expr.fields) {
          const fieldDef = hintInfo.fields.find((d) => d.name === f.name);
          if (!fieldDef) {
            this.error(`struct '${expr.name}' has no field '${f.name}'`, sp2);
            continue;
          }
          const valType = this.checkExprWithHint(f.value, fieldDef.type);
          if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
            this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp2);
          }
          this.tryMove(f.value);
        }
        for (const d of hintInfo.fields) {
          if (!expr.fields.find((f) => f.name === d.name)) {
            this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp2);
          }
        }
        this.rewrittenStructLits.set(expr, hint.name);
        return this.setType(expr, hint);
      }
    }
    const prevHint = this.returnHint;
    this.returnHint = hint;
    const result = this.checkExpr(expr);
    this.returnHint = prevHint;
    return result;
  }
  setType(expr, type) {
    this.exprTypes.set(expr, type);
    return type;
  }
  checkExpr(expr) {
    const sp2 = expr.span;
    switch (expr.kind) {
      case "IntLit":
        return this.setType(expr, { tag: "int", bits: 32, signed: true });
      case "FloatLit":
        return this.setType(expr, { tag: "float", bits: 64 });
      case "BoolLit":
        return this.setType(expr, { tag: "bool" });
      case "CharLit":
        return this.setType(expr, { tag: "int", bits: 8, signed: false });
      case "StringLit":
        return this.setType(expr, { tag: "string" });
      case "Ident": {
        const info = this.lookup(expr.name);
        if (!info) {
          const fnSig = this.functions.get(expr.name);
          if (fnSig) {
            const fnType = { tag: "fn", params: fnSig.params.map((p) => p.type), ret: fnSig.ret };
            return this.setType(expr, fnType);
          }
          this.error(`undefined variable '${expr.name}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        info.read = true;
        if (info.moved) {
          this.error(`use of moved variable '${expr.name}'`, sp2, `ownership of '${expr.name}' was transferred earlier and it can no longer be used here. To keep it alive, clone it at the point of transfer: '${expr.name}.clone()'.`);
          return this.setType(expr, this.deref(info.type));
        }
        return this.setType(expr, this.deref(info.type));
      }
      case "BinOp": {
        if (expr.op === "&&" || expr.op === "||") {
          const lt2 = this.checkExpr(expr.left);
          const rt2 = this.checkExpr(expr.right);
          if (lt2.tag !== "bool" && lt2.tag !== "unknown")
            this.error(`operator '${expr.op}' requires bool, got ${typeName(lt2)}`, sp2);
          if (rt2.tag !== "bool" && rt2.tag !== "unknown")
            this.error(`operator '${expr.op}' requires bool, got ${typeName(rt2)}`, sp2);
          return this.setType(expr, { tag: "bool" });
        }
        let lt = this.checkExpr(expr.left);
        let rt = this.checkExpr(expr.right);
        if (lt.tag === "int" && (expr.right.kind === "IntLit" || expr.right.kind === "CharLit") && !typeEq(lt, rt)) {
          rt = this.checkExprWithHint(expr.right, lt);
        } else if (rt.tag === "int" && (expr.left.kind === "IntLit" || expr.left.kind === "CharLit") && !typeEq(lt, rt)) {
          lt = this.checkExprWithHint(expr.left, rt);
        }
        const arithOps = ["+", "-", "*", "/", "%"];
        const cmpOps = ["==", "!=", "<", ">", "<=", ">="];
        const bitOps = ["&", "|", "^", "<<", ">>"];
        if (expr.op === "+" && lt.tag === "string" && rt.tag === "string") {
          return this.setType(expr, { tag: "string" });
        }
        if ((expr.op === "==" || expr.op === "!=") && lt.tag === "string" && rt.tag === "string") {
          return this.setType(expr, { tag: "bool" });
        }
        if (arithOps.includes(expr.op)) {
          if (lt.tag === "struct" && rt.tag === "struct" && typeEq(lt, rt)) {
            const opTraitMap = { "+": "Add", "-": "Sub", "*": "Mul", "/": "Div" };
            const traitName = opTraitMap[expr.op];
            if (traitName && this.typeImplementsTrait(lt.name, traitName)) {
              const methodName = traitName.toLowerCase();
              const mangled = `${lt.name}$${traitName}$${methodName}`;
              this.resolvedOperators.set(expr, mangled);
              this.autoBorrowed.set(expr.left, { mutable: false });
              this.autoBorrowed.set(expr.right, { mutable: false });
              return this.setType(expr, lt);
            }
          }
          if (!isNumeric(lt) && lt.tag !== "unknown")
            this.error(`operator '${expr.op}' requires numeric type, got ${typeName(lt)}`, sp2);
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown")
            this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp2);
          return this.setType(expr, lt);
        }
        if (bitOps.includes(expr.op)) {
          if (lt.tag !== "int" && lt.tag !== "unknown")
            this.error(`operator '${expr.op}' requires integer type, got ${typeName(lt)}`, sp2);
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown")
            this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp2);
          return this.setType(expr, lt);
        }
        if (cmpOps.includes(expr.op)) {
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown")
            this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp2);
          if (expr.op === "==" || expr.op === "!=") {
            if (lt.tag === "enum") {
              const info = this.enums.get(lt.name);
              if (info) {
                let hasPayload = false;
                for (const [, v] of info.variants) {
                  if (v.fields.length > 0) {
                    hasPayload = true;
                    break;
                  }
                }
                if (hasPayload) {
                  this.error(`cannot use '${expr.op}' on enum '${lt.name}' with payload-bearing variants`, sp2, `use 'match' to compare`);
                }
              }
            } else if (lt.tag === "struct") {
              if (this.typeImplementsTrait(lt.name, "Eq")) {
                const mangled = `${lt.name}$Eq$eq`;
                this.resolvedOperators.set(expr, mangled);
                this.autoBorrowed.set(expr.left, { mutable: false });
                this.autoBorrowed.set(expr.right, { mutable: false });
              } else {
                this.error(`cannot use '${expr.op}' on ${typeName(lt)}`, sp2, `implement Eq trait or compare individual fields`);
              }
            } else if (lt.tag === "vec" || lt.tag === "hashmap" || lt.tag === "box" || lt.tag === "array") {
              this.error(`cannot use '${expr.op}' on ${typeName(lt)}`, sp2, `compare individual fields or implement an eq method`);
            }
          } else {
            if (!isNumeric(lt) && lt.tag !== "unknown")
              this.error(`operator '${expr.op}' requires numeric type, got ${typeName(lt)}`, sp2);
          }
          return this.setType(expr, { tag: "bool" });
        }
        this.error(`unknown operator '${expr.op}'`, sp2);
        return this.setType(expr, { tag: "unknown" });
      }
      case "UnaryOp": {
        const ot = this.checkExpr(expr.operand);
        if (expr.op === "*") {
          if (ot.tag === "box")
            return this.setType(expr, ot.inner);
          if (ot.tag === "ptr") {
            if (this.unsafeDepth === 0)
              this.error(`pointer dereference requires 'unsafe' block`, sp2);
            return this.setType(expr, ot.inner);
          }
          if (ot.tag !== "unknown")
            this.error(`cannot dereference type '${typeName(ot)}' (expected *T or Box<T>)`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (expr.op === "-") {
          if (!isNumeric(ot) && ot.tag !== "unknown")
            this.error(`unary '-' requires numeric type, got ${typeName(ot)}`, sp2);
          return this.setType(expr, ot);
        }
        if (expr.op === "!") {
          if (ot.tag !== "bool" && ot.tag !== "unknown")
            this.error(`unary '!' requires bool, got ${typeName(ot)}`, sp2);
          return this.setType(expr, { tag: "bool" });
        }
        if (expr.op === "~") {
          if (ot.tag !== "int" && ot.tag !== "unknown")
            this.error(`unary '~' requires integer type, got ${typeName(ot)}`, sp2);
          return this.setType(expr, ot);
        }
        if (expr.op === "&") {
          if (this.unsafeDepth === 0)
            this.error(`address-of operator requires 'unsafe' block`, sp2);
          if (expr.operand.kind !== "Ident" && expr.operand.kind !== "FieldAccess" && expr.operand.kind !== "IndexAccess")
            this.error(`address-of requires an lvalue (variable, field, or index)`, sp2);
          return this.setType(expr, { tag: "ptr", inner: ot });
        }
        return this.setType(expr, { tag: "unknown" });
      }
      case "Call": {
        if (expr.func === "Box") {
          if (expr.args.length !== 1) {
            this.error(`Box() expects 1 argument, got ${expr.args.length}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const argType = this.checkExpr(expr.args[0]);
          this.tryMove(expr.args[0]);
          return this.setType(expr, { tag: "box", inner: argType });
        }
        if (expr.func === "embedFile") {
          if (expr.args.length !== 1) {
            this.error(`embedFile() expects 1 argument, got ${expr.args.length}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const arg = expr.args[0];
          if (arg.kind !== "StringLit") {
            this.error(`embedFile() argument must be a string literal`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          return this.setType(expr, { tag: "string" });
        }
        if (expr.func === "jsonStringify") {
          if (expr.args.length !== 1) {
            this.error(`jsonStringify() expects 1 argument, got ${expr.args.length}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const argType = this.checkExpr(expr.args[0]);
          if (argType.tag !== "struct" && argType.tag !== "string" && argType.tag !== "bool" && argType.tag !== "int" && argType.tag !== "float") {
            this.error(`jsonStringify: unsupported type '${typeName(argType)}'`, sp2);
          }
          this.autoBorrowed.set(expr.args[0], { mutable: false });
          return this.setType(expr, { tag: "string" });
        }
        const genericFn = this.genericFns.get(expr.func);
        if (genericFn) {
          const argTypes = [];
          for (const arg of expr.args)
            argTypes.push(this.checkExpr(arg));
          if (expr.args.length !== genericFn.decl.params.length) {
            this.error(`function '${expr.func}' expects ${genericFn.decl.params.length} args, got ${expr.args.length}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const typeMap = new Map;
          const literalInferred = new Set;
          for (let i = 0;i < argTypes.length; i++) {
            const paramTy = genericFn.decl.params[i].type;
            const argIsLiteral = expr.args[i].kind === "IntLit" || expr.args[i].kind === "CharLit" || expr.args[i].kind === "FloatLit";
            if (genericFn.typeParams.includes(paramTy.name)) {
              const existing = typeMap.get(paramTy.name);
              if (existing && !typeEq(existing, argTypes[i])) {
                if (argIsLiteral && existing.tag === argTypes[i].tag) {
                  this.exprTypes.set(expr.args[i], existing);
                  argTypes[i] = existing;
                } else if (literalInferred.has(paramTy.name) && existing.tag === argTypes[i].tag) {
                  typeMap.set(paramTy.name, argTypes[i]);
                  literalInferred.delete(paramTy.name);
                } else {
                  this.error(`conflicting inference for type parameter '${paramTy.name}'`, sp2);
                }
              } else if (!existing) {
                typeMap.set(paramTy.name, argTypes[i]);
                if (argIsLiteral)
                  literalInferred.add(paramTy.name);
              }
            }
            if (paramTy.typeArgs) {
              let argResolved = argTypes[i];
              if (argResolved.tag === "ref")
                argResolved = argResolved.inner;
              if (argResolved.tag === "struct") {
                const info = this.structs.get(argResolved.name);
                if (info?.baseName && info.typeArgs) {
                  const gs = this.genericStructs.get(info.baseName);
                  if (gs && info.baseName === paramTy.name) {
                    for (let j = 0;j < paramTy.typeArgs.length && j < info.typeArgs.length; j++) {
                      const ta = paramTy.typeArgs[j];
                      if (genericFn.typeParams.includes(ta.name) && (!typeMap.has(ta.name) || literalInferred.has(ta.name))) {
                        typeMap.set(ta.name, info.typeArgs[j]);
                        literalInferred.delete(ta.name);
                      }
                    }
                  }
                }
              }
            }
          }
          let missing = genericFn.typeParams.filter((p) => !typeMap.has(p));
          if (missing.length > 0 && this.returnHint) {
            this.inferTypeParamsFromHint(genericFn.decl.retType, this.returnHint, genericFn.typeParams, typeMap);
            missing = genericFn.typeParams.filter((p) => !typeMap.has(p));
          }
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.func}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const typeArgs = genericFn.typeParams.map((p) => typeMap.get(p));
          const mangled = this.monomorphizeFn(expr.func, typeArgs);
          this.rewrittenCalls.set(expr, mangled);
          const concreteSig = this.functions.get(mangled);
          for (let i = 0;i < expr.args.length; i++) {
            if (i < concreteSig.params.length && concreteSig.params[i].type.tag === "ref") {
              this.autoBorrowed.set(expr.args[i], { mutable: concreteSig.params[i].type.mutable });
              continue;
            }
            this.tryMove(expr.args[i]);
          }
          return this.setType(expr, this.functions.get(mangled).ret);
        }
        const sig = this.functions.get(expr.func);
        if (sig?.isExtern && this.unsafeDepth === 0) {
          this.error(`calling extern function '${expr.func}' requires an unsafe block`, sp2);
        }
        if (!sig) {
          const varInfo = this.lookup(expr.func);
          if (varInfo && varInfo.type.tag === "fn") {
            varInfo.read = true;
            const fnType = varInfo.type;
            if (expr.args.length !== fnType.params.length) {
              this.error(`closure expects ${fnType.params.length} args, got ${expr.args.length}`, sp2);
            }
            for (let i = 0;i < Math.min(expr.args.length, fnType.params.length); i++) {
              const paramType = fnType.params[i];
              const hint = paramType.tag === "ref" ? paramType.inner : paramType;
              const argType = this.checkExprWithHint(expr.args[i], hint);
              if (paramType.tag === "ref") {
                if (argType.tag === "ref" && typeEq(paramType.inner, argType.inner)) {
                  continue;
                }
                this.autoBorrowed.set(expr.args[i], { mutable: paramType.mutable });
                if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
                  this.error(`closure argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
                }
              } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
                this.error(`closure argument ${i + 1}: expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
              }
            }
            for (let i = 0;i < Math.min(expr.args.length, fnType.params.length); i++) {
              if (fnType.params[i].tag === "ref")
                continue;
              this.tryMove(expr.args[i]);
            }
            this.closureCalls.set(expr, fnType);
            return this.setType(expr, fnType.ret);
          }
          this.error(`undefined function '${expr.func}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (expr.func === "assert") {
          if (expr.args.length < 1 || expr.args.length > 2) {
            this.error(`assert() expects 1-2 arguments, got ${expr.args.length}`, sp2);
            return this.setType(expr, { tag: "void" });
          }
          const condType = this.checkExpr(expr.args[0]);
          if (condType.tag !== "bool" && condType.tag !== "unknown") {
            this.error(`assert() condition must be bool, got ${typeName(condType)}`, sp2);
          }
          if (expr.args.length === 2) {
            const msgType = this.checkExpr(expr.args[1]);
            if (msgType.tag !== "string" && msgType.tag !== "unknown") {
              this.error(`assert() message must be a string, got ${typeName(msgType)}`, sp2);
            }
          }
          return this.setType(expr, { tag: "void" });
        }
        if (expr.func === "max" || expr.func === "min") {
          if (expr.args.length !== 2) {
            this.error(`${expr.func}() expects 2 arguments, got ${expr.args.length}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const aType = this.checkExpr(expr.args[0]);
          const bType = this.checkExpr(expr.args[1]);
          if (aType.tag !== "int" && aType.tag !== "float" && aType.tag !== "unknown") {
            this.error(`${expr.func}() arguments must be numeric`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          if (!typeEq(aType, bType) && bType.tag !== "unknown" && aType.tag !== "unknown") {
            this.error(`${expr.func}() arguments must be the same type, got ${typeName(aType)} and ${typeName(bType)}`, sp2);
          }
          return this.setType(expr, aType.tag !== "unknown" ? aType : bType);
        }
        if (sig.variadic) {
          if (expr.args.length < sig.params.length)
            this.error(`function '${expr.func}' expects at least ${sig.params.length} args, got ${expr.args.length}`, sp2);
        } else if (expr.args.length !== sig.params.length) {
          this.error(`function '${expr.func}' expects ${sig.params.length} args, got ${expr.args.length}`, sp2);
        }
        for (let i = 0;i < Math.min(expr.args.length, sig.params.length); i++) {
          const paramType = sig.params[i].type;
          const hint = paramType.tag === "ref" ? paramType.inner : paramType;
          const argType = this.checkExprWithHint(expr.args[i], hint);
          if (paramType.tag === "ref") {
            if (argType.tag === "ref" && typeEq(paramType.inner, argType.inner)) {
              continue;
            }
            this.autoBorrowed.set(expr.args[i], { mutable: paramType.mutable });
            if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
              this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
          } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
            const isStringToPtr = argType.tag === "string" && paramType.tag === "ptr" && paramType.inner.tag === "int" && paramType.inner.bits === 8;
            const isArrayToPtr = argType.tag === "array" && paramType.tag === "ptr" && typeEq(argType.element, paramType.inner);
            const optInner = this.optionInnerType(paramType);
            const isOptionWrap = optInner !== null && typeEq(optInner, argType);
            if (isOptionWrap) {
              this.autoWrappedOption.set(expr.args[i], paramType.name);
            } else if (!isStringToPtr && !isArrayToPtr) {
              this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
          }
        }
        for (let i = sig.params.length;i < expr.args.length; i++)
          this.checkExpr(expr.args[i]);
        for (let i = 0;i < Math.min(expr.args.length, sig.params.length); i++) {
          if (sig.params[i].type.tag === "ref")
            continue;
          const argType = this.exprTypes.get(expr.args[i]);
          const paramType = sig.params[i].type;
          if (argType?.tag === "string" && paramType.tag === "ptr")
            continue;
          if (argType?.tag === "array" && paramType.tag === "ptr")
            continue;
          this.tryMove(expr.args[i]);
        }
        return this.setType(expr, sig.ret);
      }
      case "StructLit": {
        const genericInfo = this.genericStructs.get(expr.name);
        if (genericInfo) {
          const typeMap = new Map;
          for (const f of expr.fields) {
            const fieldDef = genericInfo.fields.find((d) => d.name === f.name);
            if (!fieldDef) {
              this.error(`struct '${expr.name}' has no field '${f.name}'`, sp2);
              continue;
            }
            const valType = this.checkExpr(f.value);
            if (fieldDef.type.tag === "struct" && genericInfo.typeParams.includes(fieldDef.type.name)) {
              const existing = typeMap.get(fieldDef.type.name);
              if (existing && !typeEq(existing, valType)) {
                this.error(`conflicting inference for type parameter '${fieldDef.type.name}'`, sp2);
              } else {
                typeMap.set(fieldDef.type.name, valType);
              }
            }
          }
          const missing = genericInfo.typeParams.filter((p) => !typeMap.has(p));
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for struct '${expr.name}'`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const typeArgs = genericInfo.typeParams.map((p) => typeMap.get(p));
          const mangled = this.monomorphizeStruct(expr.name, typeArgs);
          this.rewrittenStructLits.set(expr, mangled);
          const info2 = this.structs.get(mangled);
          for (const f of expr.fields) {
            const fieldDef = info2.fields.find((d) => d.name === f.name);
            if (!fieldDef)
              continue;
            const valType = this.exprTypes.get(f.value);
            if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
              this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp2);
            }
          }
          for (const d of info2.fields) {
            if (!expr.fields.find((f) => f.name === d.name)) {
              this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp2);
            }
          }
          return this.setType(expr, { tag: "struct", name: mangled });
        }
        const info = this.structs.get(expr.name);
        if (!info) {
          this.error(`unknown struct '${expr.name}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        for (const f of expr.fields) {
          const fieldDef = info.fields.find((d) => d.name === f.name);
          if (!fieldDef) {
            this.error(`struct '${expr.name}' has no field '${f.name}'`, sp2);
            continue;
          }
          const valType = this.checkExprWithHint(f.value, fieldDef.type);
          if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
            this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp2);
          }
          this.tryMove(f.value);
        }
        for (const d of info.fields) {
          if (!expr.fields.find((f) => f.name === d.name)) {
            this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp2);
          }
        }
        return this.setType(expr, { tag: "struct", name: expr.name });
      }
      case "FieldAccess": {
        let objType = this.checkExpr(expr.object);
        if (objType.tag === "ref")
          objType = objType.inner;
        if (objType.tag === "struct") {
          const info = this.structs.get(objType.name);
          if (!info) {
            this.error(`unknown struct '${objType.name}'`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const field = info.fields.find((f) => f.name === expr.field);
          if (!field) {
            this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          return this.setType(expr, field.type);
        }
        if (objType.tag === "enum") {
          this.error(`cannot access field on enum '${objType.name}' — use match to extract values`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (objType.tag === "array" && expr.field === "len") {
          return this.setType(expr, { tag: "int", bits: 32, signed: true });
        }
        if (objType.tag === "string" && expr.field === "len") {
          return this.setType(expr, { tag: "int", bits: 64, signed: true });
        }
        if (objType.tag === "vec" && expr.field === "len") {
          return this.setType(expr, { tag: "int", bits: 64, signed: true });
        }
        if (objType.tag === "hashmap" && expr.field === "len") {
          return this.setType(expr, { tag: "int", bits: 64, signed: true });
        }
        this.error(`cannot access field '${expr.field}' on type ${typeName(objType)}`, sp2);
        return this.setType(expr, { tag: "unknown" });
      }
      case "ArrayLit": {
        if (expr.elements.length === 0) {
          this.error("cannot infer type of empty array literal", sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        const elemType = this.checkExpr(expr.elements[0]);
        for (let i = 1;i < expr.elements.length; i++) {
          const t = this.checkExpr(expr.elements[i]);
          if (!typeEq(elemType, t) && t.tag !== "unknown") {
            this.error(`array element ${i}: expected ${typeName(elemType)}, got ${typeName(t)}`, expr.elements[i].span);
          }
        }
        return this.setType(expr, { tag: "array", element: elemType, size: expr.elements.length });
      }
      case "ArrayRepeat": {
        const elemType = this.checkExprWithHint(expr.value, null);
        return this.setType(expr, { tag: "array", element: elemType, size: expr.count });
      }
      case "IndexAccess": {
        const rawObjType = this.checkExpr(expr.object);
        const objType = rawObjType.tag === "ref" ? rawObjType.inner : rawObjType;
        const idxType = this.checkExpr(expr.index);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") {
          this.error(`array index must be integer, got ${typeName(idxType)}`, sp2);
        }
        if (objType.tag === "array")
          return this.setType(expr, objType.element);
        if (objType.tag === "vec")
          return this.setType(expr, objType.element);
        if (objType.tag === "string")
          return this.setType(expr, { tag: "int", bits: 8, signed: false });
        if (objType.tag === "ptr") {
          if (this.unsafeDepth === 0)
            this.error(`pointer indexing requires 'unsafe' block`, sp2);
          return this.setType(expr, objType.inner);
        }
        this.error(`cannot index type ${typeName(objType)}`, sp2);
        return this.setType(expr, { tag: "unknown" });
      }
      case "EnumLit": {
        if (expr.enumName === "Vec" && expr.variant === "new") {
          if (expr.args.length !== 0)
            this.error(`'Vec.new' takes no arguments`, sp2);
          this.error(`cannot infer Vec element type — add a type annotation: 'let v: Vec<T> = Vec.new()'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (expr.enumName === "HashMap" && expr.variant === "new") {
          if (expr.args.length !== 0)
            this.error(`'HashMap.new' takes no arguments`, sp2);
          this.error(`cannot infer HashMap types — add a type annotation: 'let m: HashMap<K, V> = HashMap.new()'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        const genericInfo = this.genericEnums.get(expr.enumName);
        if (genericInfo) {
          const variant2 = genericInfo.variants.get(expr.variant);
          if (!variant2) {
            this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          if (expr.args.length !== variant2.fields.length) {
            this.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant2.fields.length} args, got ${expr.args.length}`, sp2);
          }
          const typeMap = new Map;
          for (let i = 0;i < Math.min(expr.args.length, variant2.fields.length); i++) {
            const argType = this.checkExpr(expr.args[i]);
            const field = variant2.fields[i];
            if (field.tag === "struct" && genericInfo.typeParams.includes(field.name)) {
              const existing = typeMap.get(field.name);
              if (existing && !typeEq(existing, argType)) {
                this.error(`conflicting inference for type parameter '${field.name}'`, sp2);
              } else {
                typeMap.set(field.name, argType);
              }
            } else if (!typeEq(field, argType) && argType.tag !== "unknown") {
              this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${typeName(field)}, got ${typeName(argType)}`, expr.args[i].span);
            }
            this.tryMove(expr.args[i]);
          }
          if (genericInfo.typeParamDefaults) {
            for (let i = 0;i < genericInfo.typeParams.length; i++) {
              const p = genericInfo.typeParams[i];
              if (!typeMap.has(p) && genericInfo.typeParamDefaults[i]) {
                typeMap.set(p, genericInfo.typeParamDefaults[i]);
              }
            }
          }
          const missing = genericInfo.typeParams.filter((p) => !typeMap.has(p));
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.enumName}.${expr.variant}`, sp2);
            return this.setType(expr, { tag: "unknown" });
          }
          const typeArgs = genericInfo.typeParams.map((p) => typeMap.get(p));
          const mangled = this.monomorphizeEnum(expr.enumName, typeArgs);
          this.rewrittenEnums.set(expr, mangled);
          return this.setType(expr, { tag: "enum", name: mangled });
        }
        const info = this.enums.get(expr.enumName);
        if (!info) {
          this.error(`unknown enum '${expr.enumName}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        const variant = info.variants.get(expr.variant);
        if (!variant) {
          this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp2);
        }
        for (let i = 0;i < Math.min(expr.args.length, variant.fields.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`, expr.args[i].span);
          }
          this.tryMove(expr.args[i]);
        }
        return this.setType(expr, { tag: "enum", name: expr.enumName });
      }
      case "Unwrap": {
        const operandType = this.checkExpr(expr.operand);
        const inner = this.unwrapableInner(operandType);
        if (!inner) {
          this.error(`'!' requires Option or Result type, got ${typeName(operandType)}`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, inner);
      }
      case "Propagate": {
        const operandType = this.checkExpr(expr.operand);
        const inner = this.unwrapableInner(operandType);
        if (!inner) {
          this.error(`'?' requires Option or Result type, got ${typeName(operandType)}`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        const retInner = this.unwrapableInner(this.currentFnRetType);
        if (!retInner) {
          this.error(`'?' requires function to return Option or Result, but returns ${typeName(this.currentFnRetType)}`, sp2);
          return this.setType(expr, inner);
        }
        const operandIsOption = this.isOptionLike(operandType);
        const retIsOption = this.isOptionLike(this.currentFnRetType);
        if (operandIsOption !== retIsOption) {
          this.error(`'?' on ${operandIsOption ? "Option" : "Result"} requires function to return ${operandIsOption ? "Option" : "Result"}, but returns ${typeName(this.currentFnRetType)}`, sp2);
        } else if (!operandIsOption) {
          const operandErr = this.unwrapableErr(operandType);
          const retErr = this.unwrapableErr(this.currentFnRetType);
          if (operandErr && retErr && !typeEq(operandErr, retErr)) {
            const conversion = this.findFromConversion(operandErr, retErr);
            if (conversion) {
              this.propagateConversions.set(expr, conversion);
            } else {
              this.error(`'?' error type mismatch: '${typeName(operandErr)}' cannot convert to '${typeName(retErr)}' (no wrapping variant found)`, sp2);
            }
          }
        }
        return this.setType(expr, inner);
      }
      case "DefaultValue": {
        const operandType = this.checkExpr(expr.operand);
        const inner = this.unwrapableInner(operandType);
        if (!inner) {
          this.error(`'??' requires Option or Result type, got ${typeName(operandType)}`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        const defaultType = this.checkExprWithHint(expr.default, inner);
        if (!typeEq(inner, defaultType) && defaultType.tag !== "unknown") {
          this.error(`'??' default type mismatch: expected ${typeName(inner)}, got ${typeName(defaultType)}`, sp2);
        }
        return this.setType(expr, inner);
      }
      case "CastExpr": {
        const fromType = this.checkExpr(expr.operand);
        const toType = this.resolve(expr.targetType);
        const fromOk = isNumeric(fromType) || fromType.tag === "bool" || fromType.tag === "ptr" || fromType.tag === "array" || fromType.tag === "fn" || fromType.tag === "unknown";
        const toOk = isNumeric(toType) || toType.tag === "ptr";
        if (!fromOk) {
          this.error(`cannot cast from ${typeName(fromType)}`, sp2);
        }
        if (!toOk) {
          this.error(`cannot cast to ${typeName(toType)}`, sp2);
        }
        if (toType.tag === "ptr" && this.unsafeDepth === 0) {
          this.error(`cast to pointer type requires 'unsafe' block`, sp2);
        }
        return this.setType(expr, toType);
      }
      case "Closure": {
        const savedClosureScopeDepth = this.closureScopeDepth;
        const savedClosureCaptures = this.currentClosureCaptures;
        this.currentClosureCaptures = new Map;
        this.pushScope();
        this.closureScopeDepth = this.scopes.length - 1;
        for (const p of expr.params) {
          const pType = this.resolve(p.type);
          this.declare(p.name, { type: pType, mutable: false, moved: false, borrowed: false, read: false });
        }
        let inferredRet = expr.retType ? this.resolve(expr.retType) : { tag: "unknown" };
        const savedRetType = this.currentFnRetType;
        this.currentFnRetType = inferredRet;
        for (const s of expr.body)
          this.checkStmt(s, inferredRet);
        if (inferredRet.tag === "unknown" && expr.body.length > 0) {
          const lastStmt = expr.body[expr.body.length - 1];
          if (lastStmt.kind === "Return" && lastStmt.value) {
            inferredRet = this.exprTypes.get(lastStmt.value) ?? { tag: "void" };
          } else if (lastStmt.kind === "ExprStmt") {
            inferredRet = { tag: "void" };
          } else {
            inferredRet = { tag: "void" };
          }
        }
        this.currentFnRetType = savedRetType;
        this.popScope();
        const captures = Array.from(this.currentClosureCaptures.values());
        this.closureCaptures.set(expr, captures);
        for (const cap of captures) {
          for (let i = this.scopes.length - 1;i >= 0; i--) {
            const info = this.scopes[i].get(cap.name);
            if (info) {
              info.borrowed = true;
              break;
            }
          }
        }
        this.closureScopeDepth = savedClosureScopeDepth;
        this.currentClosureCaptures = savedClosureCaptures;
        const paramTypes = expr.params.map((p) => this.resolve(p.type));
        return this.setType(expr, { tag: "fn", params: paramTypes, ret: inferredRet });
      }
      case "MethodCall": {
        const rawObjType = this.checkExpr(expr.object);
        const objType = rawObjType.tag === "ref" ? rawObjType.inner : rawObjType;
        if ((objType.tag === "int" || objType.tag === "float") && expr.method === "toString") {
          if (expr.args.length !== 0) {
            this.error(`'toString' takes no arguments`, sp2);
          }
          return this.setType(expr, { tag: "string" });
        }
        if (objType.tag === "vec") {
          if (expr.method === "push") {
            if (expr.args.length !== 1) {
              this.error(`'push' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "void" });
            }
            if (!this.isRootMutable(expr.object)) {
              this.error(`cannot push to immutable Vec`, sp2, `declare with 'var' to make it mutable`);
            }
            const argType = this.checkExprWithHint(expr.args[0], objType.element);
            if (!typeEq(objType.element, argType) && argType.tag !== "unknown") {
              this.error(`push: expected ${typeName(objType.element)}, got ${typeName(argType)}`, sp2);
            }
            this.tryMove(expr.args[0]);
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "pop") {
            if (expr.args.length !== 0) {
              this.error(`'pop' takes no arguments`, sp2);
            }
            if (!this.isRootMutable(expr.object)) {
              this.error(`cannot pop from immutable Vec`, sp2, `declare with 'var' to make it mutable`);
            }
            return this.setType(expr, objType.element);
          }
          if (expr.method === "map") {
            if (expr.args.length !== 1) {
              this.error(`'map' expects 1 argument`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const elemRef = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint = { tag: "fn", params: [elemRef], ret: { tag: "unknown" } };
            const cbType = this.checkExprWithHint(expr.args[0], cbHint);
            if (cbType.tag !== "fn") {
              this.error(`'map' argument must be a function`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            return this.setType(expr, { tag: "vec", element: cbType.ret });
          }
          if (expr.method === "filter") {
            if (expr.args.length !== 1) {
              this.error(`'filter' expects 1 argument`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const elemRef = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            const cbType = this.checkExprWithHint(expr.args[0], cbHint);
            if (cbType.tag !== "fn") {
              this.error(`'filter' argument must be a function`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            return this.setType(expr, { tag: "vec", element: objType.element });
          }
          if (expr.method === "each") {
            if (expr.args.length !== 1) {
              this.error(`'each' expects 1 argument`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const elemRef = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint = { tag: "fn", params: [elemRef], ret: { tag: "void" } };
            this.checkExprWithHint(expr.args[0], cbHint);
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "find") {
            if (expr.args.length !== 1) {
              this.error(`'find' expects 1 argument`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const elemRef = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            const cbType = this.checkExprWithHint(expr.args[0], cbHint);
            if (cbType.tag !== "fn") {
              this.error(`'find' argument must be a function`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            return this.setType(expr, this.resolveOptionForValue(objType.element, sp2));
          }
          if (expr.method === "any") {
            if (expr.args.length !== 1) {
              this.error(`'any' expects 1 argument`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const elemRef = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            this.checkExprWithHint(expr.args[0], cbHint);
            return this.setType(expr, { tag: "bool" });
          }
          if (expr.method === "all") {
            if (expr.args.length !== 1) {
              this.error(`'all' expects 1 argument`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const elemRef = { tag: "ref", inner: objType.element, mutable: false };
            const cbHint = { tag: "fn", params: [elemRef], ret: { tag: "bool" } };
            this.checkExprWithHint(expr.args[0], cbHint);
            return this.setType(expr, { tag: "bool" });
          }
          if (expr.method === "len") {
            if (expr.args.length !== 0) {
              this.error(`'len' takes no arguments`, sp2);
            }
            return this.setType(expr, { tag: "int", bits: 64, signed: true });
          }
          this.error(`Vec has no method '${expr.method}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (objType.tag === "hashmap") {
          if (expr.method === "insert") {
            if (expr.args.length !== 2) {
              this.error(`'insert' expects 2 arguments, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "void" });
            }
            if (!this.isRootMutable(expr.object)) {
              this.error(`cannot insert into immutable HashMap`, sp2, `declare with 'var' to make it mutable`);
            }
            const keyType = this.checkExprWithHint(expr.args[0], objType.key);
            if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
              this.error(`insert key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp2);
            }
            const valType = this.checkExprWithHint(expr.args[1], objType.value);
            if (!typeEq(objType.value, valType) && valType.tag !== "unknown") {
              this.error(`insert value: expected ${typeName(objType.value)}, got ${typeName(valType)}`, sp2);
            }
            this.tryMove(expr.args[0]);
            this.tryMove(expr.args[1]);
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "get") {
            if (expr.args.length !== 1) {
              this.error(`'get' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const keyType = this.checkExprWithHint(expr.args[0], objType.key);
            if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
              this.error(`get key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp2);
            }
            const optionType = this.resolveOptionForValue(objType.value, sp2);
            return this.setType(expr, optionType);
          }
          if (expr.method === "contains") {
            if (expr.args.length !== 1) {
              this.error(`'contains' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            const keyType = this.checkExprWithHint(expr.args[0], objType.key);
            if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
              this.error(`contains key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp2);
            }
            return this.setType(expr, { tag: "bool" });
          }
          if (expr.method === "remove") {
            if (expr.args.length !== 1) {
              this.error(`'remove' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "unknown" });
            }
            if (!this.isRootMutable(expr.object)) {
              this.error(`cannot remove from immutable HashMap`, sp2, `declare with 'var' to make it mutable`);
            }
            const keyType = this.checkExprWithHint(expr.args[0], objType.key);
            if (!typeEq(objType.key, keyType) && keyType.tag !== "unknown") {
              this.error(`remove key: expected ${typeName(objType.key)}, got ${typeName(keyType)}`, sp2);
            }
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "len") {
            if (expr.args.length !== 0) {
              this.error(`'len' takes no arguments`, sp2);
            }
            return this.setType(expr, { tag: "int", bits: 64, signed: true });
          }
          this.error(`HashMap has no method '${expr.method}'`, sp2);
          return this.setType(expr, { tag: "unknown" });
        }
        if (objType.tag === "string") {
          if (expr.method === "push") {
            if (expr.args.length !== 1) {
              this.error(`'push' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "void" });
            }
            if (!this.isRootMutable(expr.object)) {
              this.error(`cannot push to immutable string`, sp2, `declare with 'var' to make it mutable`);
            }
            const argType = this.checkExpr(expr.args[0]);
            const u8t = { tag: "int", bits: 8, signed: false };
            if (!typeEq(u8t, argType) && argType.tag !== "unknown") {
              this.error(`string.push: expected u8, got ${typeName(argType)}`, sp2);
            }
            return this.setType(expr, { tag: "void" });
          }
          if (expr.method === "substr") {
            if (expr.args.length !== 2) {
              this.error(`'substr' expects 2 arguments, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "string" });
            }
            const startType = this.checkExpr(expr.args[0]);
            const endType = this.checkExpr(expr.args[1]);
            if (startType.tag !== "int" && startType.tag !== "unknown")
              this.error(`substr start: expected integer, got ${typeName(startType)}`, sp2);
            if (endType.tag !== "int" && endType.tag !== "unknown")
              this.error(`substr end: expected integer, got ${typeName(endType)}`, sp2);
            return this.setType(expr, { tag: "string" });
          }
          if (expr.method === "slice") {
            const refStr = { tag: "ref", inner: { tag: "string" }, mutable: false };
            if (expr.args.length !== 2) {
              this.error(`'slice' expects 2 arguments, got ${expr.args.length}`, sp2);
              return this.setType(expr, refStr);
            }
            const startType = this.checkExpr(expr.args[0]);
            const endType = this.checkExpr(expr.args[1]);
            if (startType.tag !== "int" && startType.tag !== "unknown")
              this.error(`slice start: expected integer, got ${typeName(startType)}`, sp2);
            if (endType.tag !== "int" && endType.tag !== "unknown")
              this.error(`slice end: expected integer, got ${typeName(endType)}`, sp2);
            if (expr.object.kind === "Ident") {
              const info = this.lookup(expr.object.name);
              if (info)
                info.borrowed = true;
            }
            this.borrowedExprs.add(expr);
            return this.setType(expr, refStr);
          }
          if (expr.method === "parseF64") {
            if (expr.args.length !== 0) {
              this.error(`'parseF64' takes no arguments`, sp2);
            }
            return this.setType(expr, { tag: "float", bits: 64 });
          }
          if (expr.method === "clone") {
            if (expr.args.length !== 0) {
              this.error(`'clone' takes no arguments`, sp2);
            }
            return this.setType(expr, { tag: "string" });
          }
          if (expr.method === "contains" || expr.method === "startsWith" || expr.method === "endsWith") {
            if (expr.args.length !== 1) {
              this.error(`'${expr.method}' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "bool" });
            }
            const argType = this.checkExpr(expr.args[0]);
            if (argType.tag !== "string" && argType.tag !== "unknown")
              this.error(`'${expr.method}': expected string, got ${typeName(argType)}`, sp2);
            return this.setType(expr, { tag: "bool" });
          }
          if (expr.method === "indexOf") {
            if (expr.args.length !== 1) {
              this.error(`'indexOf' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "int", bits: 64, signed: true });
            }
            const argType = this.checkExpr(expr.args[0]);
            if (argType.tag !== "string" && argType.tag !== "unknown")
              this.error(`'indexOf': expected string, got ${typeName(argType)}`, sp2);
            return this.setType(expr, { tag: "int", bits: 64, signed: true });
          }
          if (expr.method === "split") {
            if (expr.args.length !== 1) {
              this.error(`'split' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "vec", element: { tag: "string" } });
            }
            const argType = this.checkExpr(expr.args[0]);
            if (argType.tag !== "string" && argType.tag !== "unknown")
              this.error(`'split': expected string, got ${typeName(argType)}`, sp2);
            return this.setType(expr, { tag: "vec", element: { tag: "string" } });
          }
          if (expr.method === "trim" || expr.method === "trimStart" || expr.method === "trimEnd" || expr.method === "toLower" || expr.method === "toUpper") {
            if (expr.args.length !== 0) {
              this.error(`'${expr.method}' takes no arguments`, sp2);
            }
            return this.setType(expr, { tag: "string" });
          }
          if (expr.method === "replace") {
            if (expr.args.length !== 2) {
              this.error(`'replace' expects 2 arguments, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "string" });
            }
            const a1 = this.checkExpr(expr.args[0]);
            const a2 = this.checkExpr(expr.args[1]);
            if (a1.tag !== "string" && a1.tag !== "unknown")
              this.error(`'replace' arg 1: expected string, got ${typeName(a1)}`, sp2);
            if (a2.tag !== "string" && a2.tag !== "unknown")
              this.error(`'replace' arg 2: expected string, got ${typeName(a2)}`, sp2);
            return this.setType(expr, { tag: "string" });
          }
          if (expr.method === "repeat") {
            if (expr.args.length !== 1) {
              this.error(`'repeat' expects 1 argument, got ${expr.args.length}`, sp2);
              return this.setType(expr, { tag: "string" });
            }
            const argType = this.checkExpr(expr.args[0]);
            if (argType.tag !== "int" && argType.tag !== "unknown")
              this.error(`'repeat': expected integer, got ${typeName(argType)}`, sp2);
            return this.setType(expr, { tag: "string" });
          }
          if (expr.method === "len") {
            if (expr.args.length !== 0) {
              this.error(`'len' takes no arguments`, sp2);
            }
            return this.setType(expr, { tag: "int", bits: 64, signed: true });
          }
        }
        const bareObjType = objType.tag === "ref" ? objType.inner : objType;
        const objTName = typeName(bareObjType);
        const resolved = this.resolveMethod(objTName, expr.method);
        if (resolved) {
          const { mangled, sig } = resolved;
          const selfParam = sig.params[0];
          if (selfParam) {
            if (selfParam.type.tag === "ref") {
              this.autoBorrowed.set(expr.object, { mutable: selfParam.type.mutable });
            } else {
              this.tryMove(expr.object);
            }
          }
          if (expr.args.length !== sig.params.length - 1) {
            this.error(`'${expr.method}' expects ${sig.params.length - 1} argument(s), got ${expr.args.length}`, sp2);
          }
          for (let i = 0;i < expr.args.length; i++) {
            const expected = sig.params[i + 1];
            if (!expected)
              break;
            const argType = this.checkExprWithHint(expr.args[i], expected.type.tag === "ref" ? expected.type.inner : expected.type);
            const bare = expected.type.tag === "ref" ? expected.type.inner : expected.type;
            if (!typeEq(bare, argType) && argType.tag !== "unknown") {
              this.error(`'${expr.method}' argument ${i + 1}: expected ${typeName(bare)}, got ${typeName(argType)}`, expr.args[i].span);
            }
            if (expected.type.tag === "ref") {
              this.autoBorrowed.set(expr.args[i], { mutable: expected.type.mutable });
            } else {
              this.tryMove(expr.args[i]);
            }
          }
          this.resolvedMethods.set(expr, mangled);
          return this.setType(expr, sig.ret);
        }
        const structType = bareObjType.tag === "struct" ? bareObjType : null;
        if (structType) {
          const sdef = this.structs.get(structType.name);
          if (sdef) {
            const field = sdef.fields.find((f) => f.name === expr.method);
            if (field && field.type.tag === "fn") {
              const fnType = field.type;
              if (expr.args.length !== fnType.params.length) {
                this.error(`'${expr.method}' expects ${fnType.params.length} argument(s), got ${expr.args.length}`, sp2);
              }
              for (let i = 0;i < expr.args.length; i++) {
                const expected = fnType.params[i];
                if (!expected)
                  break;
                const bare = expected.tag === "ref" ? expected.inner : expected;
                const argType = this.checkExprWithHint(expr.args[i], bare);
                if (!typeEq(bare, argType) && argType.tag !== "unknown") {
                  this.error(`'${expr.method}' argument ${i + 1}: expected ${typeName(bare)}, got ${typeName(argType)}`, expr.args[i].span);
                }
                if (expected.tag === "ref") {
                  this.autoBorrowed.set(expr.args[i], { mutable: expected.mutable });
                } else {
                  this.tryMove(expr.args[i]);
                }
              }
              this.fnFieldCalls = this.fnFieldCalls || new Set;
              this.fnFieldCalls.add(expr);
              return this.setType(expr, fnType.ret);
            }
          }
        }
        this.error(`type '${typeName(objType)}' has no method '${expr.method}'`, sp2);
        return this.setType(expr, { tag: "unknown" });
      }
      case "RangeExpr":
        this.error("range expressions can only be used in 'for' loops", sp2);
        return this.setType(expr, { tag: "unknown" });
      case "IsExpr": {
        const opType = this.checkExpr(expr.operand);
        if (expr.pattern.kind === "EnumPattern") {
          if (opType.tag !== "enum" && opType.tag !== "unknown") {
            this.error(`'is' pattern requires an enum type, got ${typeName(opType)}`, sp2);
          }
        }
        return this.setType(expr, { tag: "bool" });
      }
    }
  }
  validateHashableKey(t, span) {
    if (t.tag === "int" || t.tag === "bool" || t.tag === "string")
      return;
    if (t.tag !== "unknown") {
      this.error(`type '${typeName(t)}' is not hashable — only integer, bool, and string keys are supported`, span);
    }
  }
  resolveOptionForValue(valueType, span) {
    const ge = this.genericEnums.get("Option");
    if (!ge) {
      this.error(`HashMap.get requires 'enum Option<T> { Some(T), None }' to be defined`, span);
      return { tag: "unknown" };
    }
    const mangled = this.monomorphizeEnum("Option", [valueType]);
    return { tag: "enum", name: mangled };
  }
  unwrapableInner(t) {
    if (t.tag !== "enum")
      return null;
    const info = this.enums.get(t.name);
    if (!info)
      return null;
    const some = info.variants.get("Some");
    const none = info.variants.get("None");
    if (some && none && some.fields.length === 1 && none.fields.length === 0) {
      return some.fields[0];
    }
    const ok = info.variants.get("Ok");
    const err = info.variants.get("Err");
    if (ok && err && ok.fields.length === 1) {
      return ok.fields[0];
    }
    return null;
  }
  unwrapableErr(t) {
    if (t.tag !== "enum")
      return null;
    const info = this.enums.get(t.name);
    if (!info)
      return null;
    const ok = info.variants.get("Ok");
    const err = info.variants.get("Err");
    if (ok && err && ok.fields.length === 1 && err.fields.length >= 1) {
      return err.fields[0];
    }
    return null;
  }
  isOptionLike(t) {
    if (t.tag !== "enum")
      return false;
    const info = this.enums.get(t.name);
    if (!info)
      return false;
    const some = info.variants.get("Some");
    const none = info.variants.get("None");
    return !!(some && none && some.fields.length === 1 && none.fields.length === 0);
  }
  findFromConversion(sourceErr, targetErr) {
    if (targetErr.tag !== "enum")
      return null;
    const info = this.enums.get(targetErr.name);
    if (!info)
      return null;
    let matches = [];
    for (const [vName, vInfo] of info.variants) {
      if (vInfo.fields.length === 1 && typeEq(vInfo.fields[0], sourceErr)) {
        matches.push({ name: vName, tag: vInfo.tag });
      }
    }
    if (matches.length === 1) {
      return { targetEnumName: targetErr.name, wrapVariant: matches[0].name, wrapTag: matches[0].tag };
    }
    if (matches.length > 1) {
      this.error(`ambiguous From conversion: '${typeName(sourceErr)}' matches multiple variants in '${typeName(targetErr)}': ${matches.map((m) => m.name).join(", ")}`);
    }
    return null;
  }
}

// src/lower.ts
var {readFileSync, existsSync} = (() => ({}));

// node:path
function assertPath(path) {
  if (typeof path !== "string")
    throw TypeError("Path must be a string. Received " + JSON.stringify(path));
}
function normalizeStringPosix(path, allowAboveRoot) {
  var res = "", lastSegmentLength = 0, lastSlash = -1, dots = 0, code;
  for (var i = 0;i <= path.length; ++i) {
    if (i < path.length)
      code = path.charCodeAt(i);
    else if (code === 47)
      break;
    else
      code = 47;
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1)
        ;
      else if (lastSlash !== i - 1 && dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            var lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex !== res.length - 1) {
              if (lastSlashIndex === -1)
                res = "", lastSegmentLength = 0;
              else
                res = res.slice(0, lastSlashIndex), lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
              lastSlash = i, dots = 0;
              continue;
            }
          } else if (res.length === 2 || res.length === 1) {
            res = "", lastSegmentLength = 0, lastSlash = i, dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          if (res.length > 0)
            res += "/..";
          else
            res = "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0)
          res += "/" + path.slice(lastSlash + 1, i);
        else
          res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i, dots = 0;
    } else if (code === 46 && dots !== -1)
      ++dots;
    else
      dots = -1;
  }
  return res;
}
function _format(sep, pathObject) {
  var dir = pathObject.dir || pathObject.root, base = pathObject.base || (pathObject.name || "") + (pathObject.ext || "");
  if (!dir)
    return base;
  if (dir === pathObject.root)
    return dir + base;
  return dir + sep + base;
}
function resolve() {
  var resolvedPath = "", resolvedAbsolute = false, cwd;
  for (var i = arguments.length - 1;i >= -1 && !resolvedAbsolute; i--) {
    var path;
    if (i >= 0)
      path = arguments[i];
    else {
      if (cwd === undefined)
        cwd = "(() => '/playground')"();
      path = cwd;
    }
    if (assertPath(path), path.length === 0)
      continue;
    resolvedPath = path + "/" + resolvedPath, resolvedAbsolute = path.charCodeAt(0) === 47;
  }
  if (resolvedPath = normalizeStringPosix(resolvedPath, !resolvedAbsolute), resolvedAbsolute)
    if (resolvedPath.length > 0)
      return "/" + resolvedPath;
    else
      return "/";
  else if (resolvedPath.length > 0)
    return resolvedPath;
  else
    return ".";
}
function normalize(path) {
  if (assertPath(path), path.length === 0)
    return ".";
  var isAbsolute = path.charCodeAt(0) === 47, trailingSeparator = path.charCodeAt(path.length - 1) === 47;
  if (path = normalizeStringPosix(path, !isAbsolute), path.length === 0 && !isAbsolute)
    path = ".";
  if (path.length > 0 && trailingSeparator)
    path += "/";
  if (isAbsolute)
    return "/" + path;
  return path;
}
function isAbsolute(path) {
  return assertPath(path), path.length > 0 && path.charCodeAt(0) === 47;
}
function join() {
  if (arguments.length === 0)
    return ".";
  var joined;
  for (var i = 0;i < arguments.length; ++i) {
    var arg = arguments[i];
    if (assertPath(arg), arg.length > 0)
      if (joined === undefined)
        joined = arg;
      else
        joined += "/" + arg;
  }
  if (joined === undefined)
    return ".";
  return normalize(joined);
}
function relative(from, to) {
  if (assertPath(from), assertPath(to), from === to)
    return "";
  if (from = resolve(from), to = resolve(to), from === to)
    return "";
  var fromStart = 1;
  for (;fromStart < from.length; ++fromStart)
    if (from.charCodeAt(fromStart) !== 47)
      break;
  var fromEnd = from.length, fromLen = fromEnd - fromStart, toStart = 1;
  for (;toStart < to.length; ++toStart)
    if (to.charCodeAt(toStart) !== 47)
      break;
  var toEnd = to.length, toLen = toEnd - toStart, length = fromLen < toLen ? fromLen : toLen, lastCommonSep = -1, i = 0;
  for (;i <= length; ++i) {
    if (i === length) {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === 47)
          return to.slice(toStart + i + 1);
        else if (i === 0)
          return to.slice(toStart + i);
      } else if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === 47)
          lastCommonSep = i;
        else if (i === 0)
          lastCommonSep = 0;
      }
      break;
    }
    var fromCode = from.charCodeAt(fromStart + i), toCode = to.charCodeAt(toStart + i);
    if (fromCode !== toCode)
      break;
    else if (fromCode === 47)
      lastCommonSep = i;
  }
  var out = "";
  for (i = fromStart + lastCommonSep + 1;i <= fromEnd; ++i)
    if (i === fromEnd || from.charCodeAt(i) === 47)
      if (out.length === 0)
        out += "..";
      else
        out += "/..";
  if (out.length > 0)
    return out + to.slice(toStart + lastCommonSep);
  else {
    if (toStart += lastCommonSep, to.charCodeAt(toStart) === 47)
      ++toStart;
    return to.slice(toStart);
  }
}
function _makeLong(path) {
  return path;
}
function dirname(path) {
  if (assertPath(path), path.length === 0)
    return ".";
  var code = path.charCodeAt(0), hasRoot = code === 47, end = -1, matchedSlash = true;
  for (var i = path.length - 1;i >= 1; --i)
    if (code = path.charCodeAt(i), code === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else
      matchedSlash = false;
  if (end === -1)
    return hasRoot ? "/" : ".";
  if (hasRoot && end === 1)
    return "//";
  return path.slice(0, end);
}
function basename(path, ext) {
  if (ext !== undefined && typeof ext !== "string")
    throw TypeError('"ext" argument must be a string');
  assertPath(path);
  var start = 0, end = -1, matchedSlash = true, i;
  if (ext !== undefined && ext.length > 0 && ext.length <= path.length) {
    if (ext.length === path.length && ext === path)
      return "";
    var extIdx = ext.length - 1, firstNonSlashEnd = -1;
    for (i = path.length - 1;i >= 0; --i) {
      var code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1)
          matchedSlash = false, firstNonSlashEnd = i + 1;
        if (extIdx >= 0)
          if (code === ext.charCodeAt(extIdx)) {
            if (--extIdx === -1)
              end = i;
          } else
            extIdx = -1, end = firstNonSlashEnd;
      }
    }
    if (start === end)
      end = firstNonSlashEnd;
    else if (end === -1)
      end = path.length;
    return path.slice(start, end);
  } else {
    for (i = path.length - 1;i >= 0; --i)
      if (path.charCodeAt(i) === 47) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1)
        matchedSlash = false, end = i + 1;
    if (end === -1)
      return "";
    return path.slice(start, end);
  }
}
function extname(path) {
  assertPath(path);
  var startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
  for (var i = path.length - 1;i >= 0; --i) {
    var code = path.charCodeAt(i);
    if (code === 47) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1)
      matchedSlash = false, end = i + 1;
    if (code === 46) {
      if (startDot === -1)
        startDot = i;
      else if (preDotState !== 1)
        preDotState = 1;
    } else if (startDot !== -1)
      preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    return "";
  return path.slice(startDot, end);
}
function format(pathObject) {
  if (pathObject === null || typeof pathObject !== "object")
    throw TypeError('The "pathObject" argument must be of type Object. Received type ' + typeof pathObject);
  return _format("/", pathObject);
}
function parse(path) {
  assertPath(path);
  var ret = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0)
    return ret;
  var code = path.charCodeAt(0), isAbsolute2 = code === 47, start;
  if (isAbsolute2)
    ret.root = "/", start = 1;
  else
    start = 0;
  var startDot = -1, startPart = 0, end = -1, matchedSlash = true, i = path.length - 1, preDotState = 0;
  for (;i >= start; --i) {
    if (code = path.charCodeAt(i), code === 47) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1)
      matchedSlash = false, end = i + 1;
    if (code === 46) {
      if (startDot === -1)
        startDot = i;
      else if (preDotState !== 1)
        preDotState = 1;
    } else if (startDot !== -1)
      preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
    if (end !== -1)
      if (startPart === 0 && isAbsolute2)
        ret.base = ret.name = path.slice(1, end);
      else
        ret.base = ret.name = path.slice(startPart, end);
  } else {
    if (startPart === 0 && isAbsolute2)
      ret.name = path.slice(1, startDot), ret.base = path.slice(1, end);
    else
      ret.name = path.slice(startPart, startDot), ret.base = path.slice(startPart, end);
    ret.ext = path.slice(startDot, end);
  }
  if (startPart > 0)
    ret.dir = path.slice(0, startPart - 1);
  else if (isAbsolute2)
    ret.dir = "/";
  return ret;
}
var sep = "/";
var delimiter = ":";
var posix = ((p) => (p.posix = p, p))({ resolve, normalize, isAbsolute, join, relative, _makeLong, dirname, basename, extname, format, parse, sep, delimiter, win32: null, posix: null });

// src/lower.ts
function lower(program, checked, sourceDir) {
  const ctx = new LowerCtx(checked, sourceDir ?? "(() => '/playground')"());
  return ctx.lowerProgram(program);
}

class LowerCtx {
  c;
  sourceDir;
  currentRetType = { tag: "void" };
  constructor(c, sourceDir) {
    this.c = c;
    this.sourceDir = sourceDir;
  }
  lowerProgram(program) {
    const structs = [];
    for (const s of program.structs) {
      if (s.typeParams.length > 0)
        continue;
      const info = this.c.structs.get(s.name);
      if (!info)
        continue;
      structs.push({ name: s.name, fields: info.fields.map((f) => ({ name: f.name, type: f.type })) });
    }
    for (const s of this.c.monomorphizedStructs) {
      const info = this.c.structs.get(s.name);
      if (!info)
        continue;
      structs.push({ name: s.name, fields: info.fields.map((f) => ({ name: f.name, type: f.type })) });
    }
    const enums = [];
    for (const [name, info] of this.c.enums) {
      const variants = [];
      for (const [vName, v] of info.variants) {
        variants.push({ name: vName, tag: v.tag, fields: v.fields });
      }
      enums.push({ name, variants });
    }
    const functions = [];
    for (const fn of program.functions) {
      if (fn.isExtern) {
        functions.push(this.lowerExtern(fn));
        continue;
      }
      if (fn.typeParams.length > 0)
        continue;
      functions.push(this.lowerFn(fn));
    }
    for (const fn of this.c.monomorphizedFns) {
      functions.push(this.lowerFn(fn));
    }
    return { structs, enums, functions, dropImpls: this.c.dropImpls };
  }
  lowerParam(p, sig, i) {
    const resolved = sig?.params[i]?.type ?? typeFromAst(p.type);
    const innerType = resolved.tag === "ref" ? resolved.inner : resolved;
    return {
      name: p.name,
      type: innerType,
      isRef: p.type.isRef,
      isRefMut: p.type.isRefMut
    };
  }
  lowerExtern(fn) {
    const sig = this.c.functions.get(fn.name);
    return {
      name: fn.name,
      params: fn.params.map((p, i) => this.lowerParam(p, sig, i)),
      retType: sig?.ret ?? typeFromAst(fn.retType),
      body: [],
      isExtern: true,
      isVariadic: fn.isVariadic
    };
  }
  lowerFn(fn) {
    const sig = this.c.functions.get(fn.name);
    const retType = sig?.ret ?? typeFromAst(fn.retType);
    this.currentRetType = retType;
    return {
      name: fn.name,
      params: fn.params.map((p, i) => this.lowerParam(p, sig, i)),
      retType,
      body: fn.body.map((s) => this.lowerStmt(s, retType)),
      isExtern: false,
      isVariadic: fn.isVariadic
    };
  }
  lowerStmt(stmt, fnRetType) {
    switch (stmt.kind) {
      case "LetDecl":
      case "VarDecl": {
        const value = this.lowerExpr(stmt.value);
        const valType = value.type ?? this.typeOf(stmt.value) ?? { tag: "unknown" };
        return {
          kind: "Let",
          name: stmt.name,
          type: valType,
          value,
          mutable: stmt.kind === "VarDecl",
          span: stmt.span
        };
      }
      case "Assign":
        return { kind: "Assign", target: this.lowerExpr(stmt.target), value: this.lowerExpr(stmt.value), span: stmt.span };
      case "Return":
        return { kind: "Return", value: stmt.value ? this.lowerExpr(stmt.value) : null, retType: fnRetType, span: stmt.span };
      case "IfStmt":
        return {
          kind: "If",
          cond: this.lowerExpr(stmt.cond),
          thenBody: stmt.thenBody.map((s) => this.lowerStmt(s, fnRetType)),
          elseBody: stmt.elseBody ? stmt.elseBody.map((s) => this.lowerStmt(s, fnRetType)) : null,
          span: stmt.span
        };
      case "WhileStmt":
        return {
          kind: "While",
          cond: this.lowerExpr(stmt.cond),
          body: stmt.body.map((s) => this.lowerStmt(s, fnRetType)),
          span: stmt.span
        };
      case "BreakStmt":
        return { kind: "Break", span: stmt.span };
      case "ContinueStmt":
        return { kind: "Continue", span: stmt.span };
      case "ExprStmt":
        return { kind: "ExprStmt", expr: this.lowerExpr(stmt.expr), span: stmt.span };
      case "IfLetStmt": {
        const subjType = this.typeOf(stmt.subject);
        const enumName = subjType?.tag === "enum" ? subjType.name : "";
        const enumInfo = this.c.enums.get(enumName);
        const arms = [
          {
            pattern: this.lowerPattern(stmt.pattern, enumInfo),
            body: stmt.thenBody.map((s) => this.lowerStmt(s, fnRetType))
          }
        ];
        if (stmt.elseBody) {
          arms.push({
            pattern: { kind: "WildcardPattern" },
            body: stmt.elseBody.map((s) => this.lowerStmt(s, fnRetType))
          });
        } else {
          arms.push({
            pattern: { kind: "WildcardPattern" },
            body: []
          });
        }
        return { kind: "Match", subject: this.lowerExpr(stmt.subject), arms, enumName, span: stmt.span };
      }
      case "MatchStmt": {
        const subjType = this.typeOf(stmt.subject);
        const enumName = subjType?.tag === "enum" ? subjType.name : "";
        const enumInfo = this.c.enums.get(enumName);
        return {
          kind: "Match",
          subject: this.lowerExpr(stmt.subject),
          arms: stmt.arms.map((arm) => ({
            pattern: this.lowerPattern(arm.pattern, enumInfo),
            body: arm.body.map((s) => this.lowerStmt(s, fnRetType))
          })),
          enumName,
          span: stmt.span
        };
      }
      case "UnsafeBlock": {
        return {
          kind: "UnsafeBlock",
          body: stmt.body.map((s) => this.lowerStmt(s, fnRetType)),
          span: stmt.span
        };
      }
      case "ForInStmt": {
        if (stmt.iterable.kind === "RangeExpr") {
          const rangeType = this.typeOf(stmt.iterable) ?? { tag: "int", bits: 32, signed: true };
          return {
            kind: "ForRange",
            varName: stmt.varName,
            varType: rangeType,
            start: this.lowerExpr(stmt.iterable.start),
            end: this.lowerExpr(stmt.iterable.end),
            body: stmt.body.map((s) => this.lowerStmt(s, fnRetType)),
            span: stmt.span
          };
        }
        const iterType = this.typeOf(stmt.iterable);
        let iterableKind;
        let varType;
        let varType2 = null;
        if (iterType?.tag === "vec") {
          iterableKind = "vec";
          if (stmt.varName2) {
            varType = { tag: "int", bits: 64, signed: true };
            varType2 = { tag: "ref", inner: iterType.element, mutable: false };
          } else {
            varType = { tag: "ref", inner: iterType.element, mutable: false };
          }
        } else if (iterType?.tag === "string") {
          iterableKind = "string";
          if (stmt.varName2) {
            varType = { tag: "int", bits: 64, signed: true };
            varType2 = { tag: "int", bits: 8, signed: false };
          } else {
            varType = { tag: "int", bits: 8, signed: false };
          }
        } else if (iterType?.tag === "hashmap") {
          iterableKind = "hashmap";
          varType = { tag: "ref", inner: iterType.key, mutable: false };
          varType2 = { tag: "ref", inner: iterType.value, mutable: false };
        } else if (iterType?.tag === "array") {
          iterableKind = "array";
          if (stmt.varName2) {
            varType = { tag: "int", bits: 64, signed: true };
            varType2 = { tag: "ref", inner: iterType.element, mutable: false };
          } else {
            varType = { tag: "ref", inner: iterType.element, mutable: false };
          }
        } else {
          iterableKind = "vec";
          varType = { tag: "unknown" };
        }
        return {
          kind: "ForEach",
          varName: stmt.varName,
          varName2: stmt.varName2,
          varType,
          varType2,
          iterable: this.lowerExpr(stmt.iterable),
          iterableKind,
          body: stmt.body.map((s) => this.lowerStmt(s, fnRetType)),
          span: stmt.span
        };
      }
    }
  }
  lowerPattern(pattern, enumInfo) {
    if (pattern.kind === "WildcardPattern")
      return { kind: "WildcardPattern" };
    if (pattern.kind === "LiteralPattern") {
      return { kind: "LiteralPattern", value: pattern.value, literalKind: pattern.literalKind };
    }
    const variant = enumInfo?.variants.get(pattern.variant);
    return {
      kind: "EnumPattern",
      variant: pattern.variant,
      bindings: pattern.bindings.map((name, i) => ({
        name,
        type: variant?.fields[i] ?? { tag: "unknown" }
      })),
      tag: variant?.tag ?? 0
    };
  }
  lowerExpr(expr) {
    const type = this.typeOf(expr) ?? { tag: "unknown" };
    const optionName = this.c.autoWrappedOption.get(expr);
    if (optionName) {
      const inner = this.lowerExprRaw(expr, type);
      const optionType = { tag: "enum", name: optionName };
      return { kind: "EnumLit", enumName: optionName, variant: "Some", args: [inner], type: optionType, span: expr.span };
    }
    return this.lowerExprRaw(expr, type);
  }
  lowerExprRaw(expr, type) {
    switch (expr.kind) {
      case "IntLit":
        return { kind: "IntLit", value: expr.value, type, span: expr.span };
      case "FloatLit":
        return { kind: "FloatLit", value: expr.value, type, span: expr.span };
      case "BoolLit":
        return { kind: "BoolLit", value: expr.value, type, span: expr.span };
      case "CharLit":
        return { kind: "CharLit", value: expr.value, type, span: expr.span };
      case "StringLit":
        return { kind: "StringLit", value: expr.value, type, span: expr.span };
      case "Ident":
        return { kind: "Ident", name: expr.name, type, isMove: this.c.movedExprs.has(expr), span: expr.span };
      case "BinOp": {
        const resolvedOp = this.c.resolvedOperators.get(expr);
        if (resolvedOp) {
          const args = [expr.left, expr.right].map((a) => ({
            expr: this.lowerExpr(a),
            passByRef: !!this.c.autoBorrowed.get(a),
            refMut: false
          }));
          const call = { kind: "Call", func: resolvedOp, args, type, variadic: false, span: expr.span };
          if (expr.op === "!=") {
            return { kind: "UnaryOp", op: "!", operand: call, type: { tag: "bool" }, span: expr.span };
          }
          return call;
        }
        return { kind: "BinOp", op: expr.op, left: this.lowerExpr(expr.left), right: this.lowerExpr(expr.right), type, span: expr.span };
      }
      case "UnaryOp":
        if (expr.op === "*") {
          const operandType = this.c.exprTypes.get(expr.operand);
          if (operandType?.tag === "ptr")
            return { kind: "PtrDeref", operand: this.lowerExpr(expr.operand), type, span: expr.span };
          return { kind: "BoxDeref", operand: this.lowerExpr(expr.operand), type, span: expr.span };
        }
        return { kind: "UnaryOp", op: expr.op, operand: this.lowerExpr(expr.operand), type, span: expr.span };
      case "Call": {
        if (expr.func === "Box") {
          return { kind: "BoxCreate", value: this.lowerExpr(expr.args[0]), type, span: expr.span };
        }
        if (expr.func === "embedFile") {
          const path = expr.args[0].value;
          const absPath = resolve(this.sourceDir, path);
          if (!existsSync(absPath)) {
            throw new Error(`error[embed]: ${expr.span?.line}:${expr.span?.col}: cannot open '${path}'`);
          }
          const contents = readFileSync(absPath, "utf-8");
          return { kind: "StringLit", value: contents, type: { tag: "string" }, span: expr.span };
        }
        if (expr.func === "jsonStringify") {
          const argType = this.typeOf(expr.args[0]) ?? { tag: "unknown" };
          return { kind: "JsonStringify", value: this.lowerExpr(expr.args[0]), valueType: argType, type, span: expr.span };
        }
        const closureFnType = this.c.closureCalls.get(expr);
        if (closureFnType) {
          const args2 = expr.args.map((arg) => {
            const borrowed = this.c.autoBorrowed.get(arg);
            return {
              expr: this.lowerExpr(arg),
              passByRef: !!borrowed,
              refMut: borrowed?.mutable ?? false
            };
          });
          return {
            kind: "ClosureCall",
            callee: { kind: "Ident", name: expr.func, type: closureFnType, span: expr.span },
            args: args2,
            type,
            span: expr.span
          };
        }
        const funcName = this.c.rewrittenCalls.get(expr) ?? expr.func;
        const sig = this.c.functions.get(funcName);
        const args = expr.args.map((arg, i) => {
          const borrowed = this.c.autoBorrowed.get(arg);
          return {
            expr: this.lowerExpr(arg),
            passByRef: !!borrowed,
            refMut: borrowed?.mutable ?? false
          };
        });
        return { kind: "Call", func: funcName, args, type, variadic: sig?.variadic ?? false, span: expr.span };
      }
      case "StructLit": {
        const structName = this.c.rewrittenStructLits.get(expr) ?? expr.name;
        return {
          kind: "StructLit",
          name: structName,
          fields: expr.fields.map((f) => ({ name: f.name, value: this.lowerExpr(f.value) })),
          type: { tag: "struct", name: structName },
          span: expr.span
        };
      }
      case "FieldAccess": {
        const rawObjType = this.typeOf(expr.object);
        const objType = rawObjType?.tag === "ref" ? rawObjType.inner : rawObjType;
        if (objType?.tag === "array" && expr.field === "len") {
          return { kind: "ArrayLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "string" && expr.field === "len") {
          return { kind: "StringLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "vec" && expr.field === "len") {
          return { kind: "VecLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "hashmap" && expr.field === "len") {
          return { kind: "HashMapLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        return { kind: "FieldAccess", object: this.lowerExpr(expr.object), field: expr.field, type, span: expr.span };
      }
      case "ArrayLit":
        if (this.c.arrayToVecCoercions.has(expr)) {
          const vecType = { tag: "vec", element: type.tag === "array" ? type.element : type };
          return { kind: "ArrayLit", elements: expr.elements.map((e) => this.lowerExpr(e)), type: vecType, span: expr.span };
        }
        return { kind: "ArrayLit", elements: expr.elements.map((e) => this.lowerExpr(e)), type, span: expr.span };
      case "ArrayRepeat":
        return { kind: "ArrayRepeat", value: this.lowerExpr(expr.value), count: expr.count, type, span: expr.span };
      case "IndexAccess":
        return { kind: "IndexAccess", object: this.lowerExpr(expr.object), index: this.lowerExpr(expr.index), type, isMove: this.c.movedExprs.has(expr), isBorrowed: this.c.borrowedExprs.has(expr), span: expr.span };
      case "EnumLit": {
        if (expr.enumName === "Vec" && expr.variant === "new" && type.tag === "vec") {
          return { kind: "VecNew", elementType: type.element, type, span: expr.span };
        }
        if (expr.enumName === "HashMap" && expr.variant === "new" && type.tag === "hashmap") {
          return { kind: "HashMapNew", keyType: type.key, valueType: type.value, type, span: expr.span };
        }
        const enumName = this.c.rewrittenEnums.get(expr) ?? expr.enumName;
        return {
          kind: "EnumLit",
          enumName,
          variant: expr.variant,
          args: expr.args.map((a) => this.lowerExpr(a)),
          type: { tag: "enum", name: enumName },
          span: expr.span
        };
      }
      case "Unwrap": {
        const operandType = this.typeOf(expr.operand);
        return {
          kind: "Unwrap",
          operand: this.lowerExpr(expr.operand),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          type,
          span: expr.span
        };
      }
      case "Propagate": {
        const operandType = this.typeOf(expr.operand);
        const fnRetType = this.currentRetType;
        const fromConversion = this.c.propagateConversions.get(expr);
        return {
          kind: "Propagate",
          operand: this.lowerExpr(expr.operand),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          retType: fnRetType,
          fromConversion,
          type,
          span: expr.span
        };
      }
      case "DefaultValue": {
        const operandType = this.typeOf(expr.operand);
        return {
          kind: "DefaultValue",
          operand: this.lowerExpr(expr.operand),
          default: this.lowerExpr(expr.default),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          type,
          span: expr.span
        };
      }
      case "CastExpr":
        return {
          kind: "Cast",
          operand: this.lowerExpr(expr.operand),
          targetType: type,
          type,
          span: expr.span
        };
      case "MethodCall": {
        const rawObjType = this.typeOf(expr.object);
        const objType = rawObjType?.tag === "ref" ? rawObjType.inner : rawObjType;
        if ((objType?.tag === "int" || objType?.tag === "float") && expr.method === "toString") {
          return { kind: "NumberToString", value: this.lowerExpr(expr.object), valueType: objType, type, span: expr.span };
        }
        if (objType?.tag === "vec") {
          if (expr.method === "push") {
            return { kind: "VecPush", vec: this.lowerExpr(expr.object), value: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "pop") {
            return { kind: "VecPop", vec: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "map") {
            const resultElem = type.tag === "vec" ? type.element : { tag: "unknown" };
            return { kind: "VecMap", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, resultElementType: resultElem, type, span: expr.span };
          }
          if (expr.method === "filter") {
            return { kind: "VecFilter", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "each") {
            return { kind: "VecEach", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "find") {
            const optionEnumName = type.tag === "enum" ? type.name : "";
            return { kind: "VecFind", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, optionEnumName, type, span: expr.span };
          }
          if (expr.method === "any") {
            return { kind: "VecAny", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "all") {
            return { kind: "VecAll", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "len") {
            return { kind: "VecLen", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
        }
        if (objType?.tag === "hashmap") {
          if (expr.method === "insert") {
            return { kind: "HashMapInsert", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), value: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "get") {
            const optionEnumName = type.tag === "enum" ? type.name : "";
            return { kind: "HashMapGet", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), optionEnumName, type, span: expr.span };
          }
          if (expr.method === "contains") {
            return { kind: "HashMapContains", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "remove") {
            return { kind: "HashMapRemove", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "len") {
            return { kind: "HashMapLen", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
        }
        if (objType?.tag === "string") {
          if (expr.method === "push") {
            return { kind: "StringPush", str: this.lowerExpr(expr.object), byte: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "substr") {
            return { kind: "StringSubstr", str: this.lowerExpr(expr.object), start: this.lowerExpr(expr.args[0]), end: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "slice") {
            return { kind: "StringSlice", str: this.lowerExpr(expr.object), start: this.lowerExpr(expr.args[0]), end: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "parseF64") {
            return { kind: "StringParseF64", str: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "clone") {
            return { kind: "StringClone", str: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "len") {
            return { kind: "StringLen", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
          const strMethodMap = {
            contains: "strContains",
            startsWith: "strStartsWith",
            endsWith: "strEndsWith",
            indexOf: "strIndexOf",
            split: "strSplit",
            trim: "strTrim",
            trimStart: "strTrimStart",
            trimEnd: "strTrimEnd",
            toLower: "strToLower",
            toUpper: "strToUpper",
            replace: "strReplace",
            repeat: "strRepeat"
          };
          const fnName = strMethodMap[expr.method];
          if (fnName) {
            const args = [
              { expr: this.lowerExpr(expr.object), passByRef: true, refMut: false },
              ...expr.args.map((a) => ({ expr: this.lowerExpr(a), passByRef: true, refMut: false }))
            ];
            if (expr.method === "repeat" && args.length > 1) {
              args[1] = { ...args[1], passByRef: false };
            }
            return { kind: "Call", func: fnName, args, type, variadic: false, span: expr.span };
          }
        }
        const resolved = this.c.resolvedMethods.get(expr);
        if (resolved) {
          const sig = this.c.functions.get(resolved);
          const allExprs = [expr.object, ...expr.args];
          const args = allExprs.map((a, i) => {
            const borrowed = this.c.autoBorrowed.get(a);
            return {
              expr: this.lowerExpr(a),
              passByRef: !!borrowed,
              refMut: borrowed?.mutable ?? false
            };
          });
          return { kind: "Call", func: resolved, args, type, variadic: false, span: expr.span };
        }
        if (this.c.fnFieldCalls.has(expr)) {
          const callee = {
            kind: "FieldAccess",
            object: this.lowerExpr(expr.object),
            field: expr.method,
            type: { tag: "fn", params: [], ret: type }
          };
          const fnType = this.typeOf(expr);
          const objFnType = this.c.exprTypes.get(expr);
          const args = expr.args.map((a, i) => {
            const borrowed = this.c.autoBorrowed.get(a);
            return { expr: this.lowerExpr(a), passByRef: !!borrowed, refMut: borrowed?.mutable ?? false };
          });
          return { kind: "ClosureCall", callee, args, type, span: expr.span };
        }
        throw new Error(`unsupported method call: ${expr.method}`);
      }
      case "Closure": {
        const captures = this.c.closureCaptures.get(expr) ?? [];
        const retType = type.tag === "fn" ? type.ret : { tag: "void" };
        return {
          kind: "Closure",
          params: expr.params.map((p) => {
            const pType = this.c.exprTypes.get(expr);
            const resolvedType = pType?.tag === "fn" ? pType.params[expr.params.indexOf(p)] : { tag: "unknown" };
            return { name: p.name, type: resolvedType };
          }),
          body: expr.body.map((s) => this.lowerStmt(s, retType)),
          captures,
          retType,
          type,
          isMove: expr.isMove,
          span: expr.span
        };
      }
      case "RangeExpr":
        throw new Error("RangeExpr should not appear in lowerExprRaw — handled by ForInStmt");
      case "IsExpr": {
        const operand = this.lowerExpr(expr.operand);
        const opType = this.typeOf(expr.operand);
        let tag = -1;
        if (expr.pattern.kind === "EnumPattern" && opType?.tag === "enum") {
          const enumInfo = this.c.enums.get(opType.name);
          if (enumInfo) {
            const variant = enumInfo.variants.get(expr.pattern.variant);
            if (variant)
              tag = variant.tag;
          }
        }
        return { kind: "IsCheck", operand, tag, type: { tag: "bool" }, span: expr.span };
      }
    }
  }
  typeOf(expr) {
    return this.c.exprTypes.get(expr);
  }
}

// src/codegen-js.ts
class CodegenJS {
  output = [];
  indent = 0;
  tempCounter = 0;
  emit(line) {
    this.output.push("  ".repeat(this.indent) + line);
  }
  nextTemp() {
    return `_t${this.tempCounter++}`;
  }
  generate(module) {
    this.emit(`"use strict";`);
    this.emit("");
    this.emitRuntime();
    this.emitBody(module);
    return this.output.join(`
`) + `
`;
  }
  generateBody(module) {
    this.emitBody(module);
    return this.output.join(`
`) + `
`;
  }
  emitBody(module) {
    for (const s of module.structs) {
      this.genStruct(s);
    }
    for (const e of module.enums) {
      this.genEnum(e);
    }
    for (const fn of module.functions) {
      if (fn.isExtern)
        continue;
      this.genFunction(fn);
      this.emit("");
    }
    this.emit("main();");
    this.emit("__flush();");
  }
  emitRuntime() {
    this.emit("// runtime");
    this.emit("const __out = [];");
    this.emit("function __print(s) { __out.push(String(s)); }");
    this.emit("function __flush() { if (__out.length === 0) return; const text = __out.join(''); __out.length = 0; if (typeof process !== 'undefined') process.stdout.write(text); else if (typeof console !== 'undefined') console.log(text); }");
    this.emit("function __assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }");
    this.emit("function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }");
    this.emit("function __eq(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => __eq(v, b[i])); const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => __eq(a[k], b[k])); }");
    this.emit("");
  }
  genStruct(s) {
    const fields = s.fields.map((f) => f.name);
    this.emit(`class ${s.name} {`);
    this.indent++;
    this.emit(`constructor(${fields.join(", ")}) {`);
    this.indent++;
    for (const f of fields)
      this.emit(`this.${f} = ${f};`);
    this.indent--;
    this.emit("}");
    this.indent--;
    this.emit("}");
    this.emit("");
  }
  genEnum(e) {
    this.emit(`const ${e.name} = {`);
    this.indent++;
    for (const v of e.variants) {
      if (v.fields.length === 0) {
        this.emit(`${v.name}() { return { tag: ${v.tag} }; },`);
      } else {
        const params = v.fields.map((_, i) => `_${i}`).join(", ");
        this.emit(`${v.name}(${params}) { return { tag: ${v.tag}, data: [${params}] }; },`);
      }
    }
    this.indent--;
    this.emit("};");
    this.emit("");
  }
  genFunction(fn) {
    const params = fn.params.map((p) => p.name).join(", ");
    this.emit(`function ${fn.name}(${params}) {`);
    this.indent++;
    for (const stmt of fn.body) {
      this.genStmt(stmt);
    }
    this.indent--;
    this.emit("}");
  }
  genStmt(stmt) {
    switch (stmt.kind) {
      case "Let": {
        const val = this.genExpr(stmt.value);
        const kw = stmt.mutable ? "let" : "const";
        this.emit(`${kw} ${stmt.name} = ${val};`);
        break;
      }
      case "Assign": {
        const target = this.genLValue(stmt.target);
        const val = this.genExpr(stmt.value);
        this.emit(`${target} = ${val};`);
        break;
      }
      case "Return": {
        if (stmt.value) {
          this.emit(`return ${this.genExpr(stmt.value)};`);
        } else {
          this.emit("return;");
        }
        break;
      }
      case "If": {
        this.emit(`if (${this.genExpr(stmt.cond)}) {`);
        this.indent++;
        for (const s of stmt.thenBody)
          this.genStmt(s);
        this.indent--;
        if (stmt.elseBody && stmt.elseBody.length > 0) {
          this.emit("} else {");
          this.indent++;
          for (const s of stmt.elseBody)
            this.genStmt(s);
          this.indent--;
        }
        this.emit("}");
        break;
      }
      case "While": {
        this.emit(`while (${this.genExpr(stmt.cond)}) {`);
        this.indent++;
        for (const s of stmt.body)
          this.genStmt(s);
        this.indent--;
        this.emit("}");
        break;
      }
      case "Break": {
        this.emit("break;");
        break;
      }
      case "Continue": {
        this.emit("continue;");
        break;
      }
      case "ExprStmt": {
        const val = this.genExpr(stmt.expr);
        this.emit(`${val};`);
        break;
      }
      case "Match": {
        this.genMatch(stmt);
        break;
      }
      case "ForRange": {
        this.emit(`for (let ${stmt.varName} = ${this.genExpr(stmt.start)}; ${stmt.varName} < ${this.genExpr(stmt.end)}; ${stmt.varName}++) {`);
        this.indent++;
        for (const s of stmt.body)
          this.genStmt(s);
        this.indent--;
        this.emit("}");
        break;
      }
      case "ForEach": {
        const iter = this.genExpr(stmt.iterable);
        if (stmt.iterableKind === "hashmap") {
          const k = stmt.varName;
          const v = stmt.varName2 ?? "_";
          this.emit(`for (const [${k}, ${v}] of ${iter}) {`);
        } else {
          this.emit(`for (const ${stmt.varName} of ${iter}) {`);
        }
        this.indent++;
        for (const s of stmt.body)
          this.genStmt(s);
        this.indent--;
        this.emit("}");
        break;
      }
      case "UnsafeBlock": {
        for (const s of stmt.body)
          this.genStmt(s);
        break;
      }
    }
  }
  genMatch(stmt) {
    const subj = this.genExpr(stmt.subject);
    const tmp = this.nextTemp();
    this.emit(`const ${tmp} = ${subj};`);
    const isLiteral = stmt.arms.some((a) => a.pattern.kind === "LiteralPattern");
    if (isLiteral) {
      let first = true;
      for (const arm of stmt.arms) {
        if (arm.pattern.kind === "WildcardPattern") {
          this.emit(`${first ? "if (true" : "} else"} {`);
        } else if (arm.pattern.kind === "LiteralPattern") {
          const val = typeof arm.pattern.value === "string" ? JSON.stringify(arm.pattern.value) : String(arm.pattern.value);
          this.emit(`${first ? "" : "} else "}if (${tmp} === ${val}) {`);
        }
        this.indent++;
        for (const s of arm.body)
          this.genStmt(s);
        this.indent--;
        first = false;
      }
      this.emit("}");
    } else {
      let first = true;
      for (const arm of stmt.arms) {
        if (arm.pattern.kind === "WildcardPattern") {
          this.emit(`${first ? "" : "} else "}{ // wildcard`);
        } else if (arm.pattern.kind === "EnumPattern") {
          const p = arm.pattern;
          this.emit(`${first ? "" : "} else "}if (${tmp}.tag === ${p.tag}) {`);
          this.indent++;
          for (let i = 0;i < p.bindings.length; i++) {
            if (p.bindings[i].name !== "_") {
              this.emit(`const ${p.bindings[i].name} = ${tmp}.data[${i}];`);
            }
          }
          this.indent--;
        }
        this.indent++;
        for (const s of arm.body)
          this.genStmt(s);
        this.indent--;
        first = false;
      }
      this.emit("}");
    }
  }
  genExpr(expr) {
    switch (expr.kind) {
      case "IntLit":
      case "FloatLit":
        return String(expr.value);
      case "BoolLit":
        return expr.value ? "true" : "false";
      case "CharLit":
        return `String.fromCharCode(${expr.value})`;
      case "StringLit":
        return JSON.stringify(expr.value);
      case "Ident":
        return expr.name;
      case "BinOp":
        return this.genBinOp(expr);
      case "UnaryOp":
        return `(${expr.op}${this.genExpr(expr.operand)})`;
      case "Call":
        return this.genCall(expr);
      case "StructLit":
        return this.genStructLit(expr);
      case "FieldAccess":
        return `${this.genExpr(expr.object)}.${expr.field}`;
      case "ArrayLit":
        return `[${expr.elements.map((e) => this.genExpr(e)).join(", ")}]`;
      case "ArrayRepeat": {
        const val = this.genExpr(expr.value);
        return `Array.from({length: ${expr.count}}, () => __clone(${val}))`;
      }
      case "IndexAccess":
        return `${this.genExpr(expr.object)}[${this.genExpr(expr.index)}]`;
      case "EnumLit": {
        const args = expr.args.map((a) => this.genExpr(a)).join(", ");
        return `${expr.enumName}.${expr.variant}(${args})`;
      }
      case "ArrayLen":
      case "VecLen":
        return `${this.genExpr(expr.object)}.length`;
      case "StringLen":
        return `${this.genExpr(expr.object)}.length`;
      case "Unwrap":
        return `${this.genExpr(expr.operand)}.data[0]`;
      case "Propagate": {
        return `${this.genExpr(expr.operand)}.data[0]`;
      }
      case "DefaultValue": {
        const operand = this.genExpr(expr.operand);
        const def = this.genExpr(expr.default);
        return `(${operand}.tag === 0 ? ${operand}.data[0] : ${def})`;
      }
      case "Cast":
        return this.genCast(expr);
      case "IsCheck":
        return `(${this.genExpr(expr.operand)}.tag === ${expr.tag})`;
      case "BoxCreate":
        return this.genExpr(expr.value);
      case "BoxDeref":
      case "PtrDeref":
        return this.genExpr(expr.operand);
      case "VecNew":
        return "[]";
      case "VecPush":
        return `${this.genExpr(expr.vec)}.push(${this.genExpr(expr.value)})`;
      case "VecPop":
        return `${this.genExpr(expr.vec)}.pop()`;
      case "HashMapNew":
        return "new Map()";
      case "HashMapInsert":
        return `${this.genExpr(expr.map)}.set(${this.genExpr(expr.key)}, ${this.genExpr(expr.value)})`;
      case "HashMapGet": {
        const m = this.genExpr(expr.map);
        const k = this.genExpr(expr.key);
        return `(${m}.has(${k}) ? ${expr.optionEnumName}.Some(${m}.get(${k})) : ${expr.optionEnumName}.None())`;
      }
      case "HashMapContains":
        return `${this.genExpr(expr.map)}.has(${this.genExpr(expr.key)})`;
      case "HashMapRemove":
        return `${this.genExpr(expr.map)}.delete(${this.genExpr(expr.key)})`;
      case "HashMapLen":
        return `${this.genExpr(expr.object)}.size`;
      case "StringPush":
        return `(${this.genExpr(expr.str)} += String.fromCharCode(${this.genExpr(expr.byte)}))`;
      case "StringSubstr":
      case "StringSlice":
        return `${this.genExpr(expr.str)}.slice(${this.genExpr(expr.start)}, ${this.genExpr(expr.end)})`;
      case "StringParseF64":
        return `parseFloat(${this.genExpr(expr.str)})`;
      case "StringClone":
        return this.genExpr(expr.str);
      case "NumberToString":
        return `String(${this.genExpr(expr.value)})`;
      case "JsonStringify":
        return `JSON.stringify(${this.genExpr(expr.value)})`;
      case "Closure":
        return this.genClosure(expr);
      case "ClosureCall": {
        const callee = this.genExpr(expr.callee);
        const args = expr.args.map((a) => this.genExpr(a.expr)).join(", ");
        return `${callee}(${args})`;
      }
      case "VecMap":
        return `${this.genExpr(expr.vec)}.map(${this.genExpr(expr.callback)})`;
      case "VecFilter":
        return `${this.genExpr(expr.vec)}.filter(${this.genExpr(expr.callback)})`;
      case "VecEach":
        return `${this.genExpr(expr.vec)}.forEach(${this.genExpr(expr.callback)})`;
      case "VecFind": {
        const v = this.genExpr(expr.vec);
        const cb = this.genExpr(expr.callback);
        return `((_f => { const _r = ${v}.find(_f); return _r !== undefined ? ${expr.optionEnumName}.Some(_r) : ${expr.optionEnumName}.None(); })(${cb}))`;
      }
      case "VecAny":
        return `${this.genExpr(expr.vec)}.some(${this.genExpr(expr.callback)})`;
      case "VecAll":
        return `${this.genExpr(expr.vec)}.every(${this.genExpr(expr.callback)})`;
    }
  }
  genBinOp(expr) {
    const l = this.genExpr(expr.left);
    const r = this.genExpr(expr.right);
    if (expr.op === "+" && expr.left.type.tag === "string") {
      return `(${l} + ${r})`;
    }
    if (expr.op === "==" && (expr.left.type.tag === "struct" || expr.left.type.tag === "enum")) {
      return `__eq(${l}, ${r})`;
    }
    if (expr.op === "!=" && (expr.left.type.tag === "struct" || expr.left.type.tag === "enum")) {
      return `!__eq(${l}, ${r})`;
    }
    if ((expr.op === "==" || expr.op === "!=") && expr.left.type.tag === "string") {
      return `(${l} ${expr.op} ${r})`;
    }
    return `(${l} ${expr.op} ${r})`;
  }
  genCall(expr) {
    const args = expr.args.map((a) => this.genExpr(a.expr));
    switch (expr.func) {
      case "print": {
        const parts = expr.args.map((a) => this.coerceToString(a.expr));
        return `__print(${parts.join(" + ")} + "\\n")`;
      }
      case "eprint": {
        const parts = expr.args.map((a) => this.coerceToString(a.expr));
        return `__print(${parts.join(" + ")})`;
      }
      case "format": {
        const parts = expr.args.map((a) => this.coerceToString(a.expr));
        return parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
      }
      case "flush":
        return "__flush()";
      case "exit":
        return `(() => { throw new Error("exit: " + ${args[0]}); })()`;
      case "assert":
        return `__assert(${args[0]}, ${args[1] ?? '""'})`;
      case "max":
        return `Math.max(${args.join(", ")})`;
      case "min":
        return `Math.min(${args.join(", ")})`;
      default:
        return `${expr.func}(${args.join(", ")})`;
    }
  }
  genStructLit(expr) {
    const args = expr.fields.map((f) => this.genExpr(f.value)).join(", ");
    return `new ${expr.name}(${args})`;
  }
  genCast(expr) {
    const val = this.genExpr(expr.operand);
    const target = expr.targetType;
    if (target.tag === "int")
      return `(${val} | 0)`;
    if (target.tag === "float")
      return `(+${val})`;
    if (target.tag === "bool")
      return `Boolean(${val})`;
    return val;
  }
  genClosure(expr) {
    const params = expr.params.map((p) => p.name).join(", ");
    if (expr.body.length === 1 && expr.body[0].kind === "Return" && expr.body[0].value) {
      const ret = this.genExpr(expr.body[0].value);
      return `((${params}) => ${ret})`;
    }
    const lines = [];
    const prevOutput = this.output;
    this.output = lines;
    for (const s of expr.body)
      this.genStmt(s);
    this.output = prevOutput;
    return `((${params}) => {
${lines.join(`
`)}
${"  ".repeat(this.indent)}})`;
  }
  coerceToString(expr) {
    const val = this.genExpr(expr);
    if (expr.type.tag === "string")
      return val;
    if (expr.type.tag === "bool")
      return `(${val} ? "true" : "false")`;
    if (expr.type.tag === "char")
      return `String.fromCharCode(${val})`;
    if (expr.type.tag === "int" || expr.type.tag === "float")
      return `String(${val})`;
    return `String(${val})`;
  }
  genLValue(expr) {
    switch (expr.kind) {
      case "Ident":
        return expr.name;
      case "FieldAccess":
        return `${this.genLValue(expr.object)}.${expr.field}`;
      case "IndexAccess":
        return `${this.genExpr(expr.object)}[${this.genExpr(expr.index)}]`;
      case "BoxDeref":
      case "PtrDeref":
        return this.genLValue(expr.operand);
      default:
        return this.genExpr(expr);
    }
  }
}

// src/diagnostics.ts
var RESET = "\x1B[0m";
var BOLD = "\x1B[1m";
var RED = "\x1B[31m";
var YELLOW = "\x1B[33m";
var CYAN = "\x1B[36m";
var DIM = "\x1B[2m";
var SEV_COLOR = { error: RED, warning: YELLOW, hint: CYAN };
function formatDiagnostic(d, source, filePath) {
  const lines = [];
  const color = SEV_COLOR[d.severity];
  const file = filePath ?? "<input>";
  if (d.span) {
    const loc = `${file}:${d.span.line}:${d.span.col}`;
    lines.push(`${BOLD}${color}${d.severity}${RESET}${BOLD}: ${d.message}${RESET}`);
    lines.push(`  ${DIM}──>${RESET} ${loc}`);
    const srcLines = source.split(`
`);
    const lineIdx = d.span.line - 1;
    if (lineIdx >= 0 && lineIdx < srcLines.length) {
      const lineNum = String(d.span.line);
      const pad = " ".repeat(lineNum.length);
      lines.push(`${DIM}${pad} │${RESET}`);
      lines.push(`${DIM}${lineNum} │${RESET} ${srcLines[lineIdx]}`);
      lines.push(`${DIM}${pad} │${RESET} ${" ".repeat(d.span.col - 1)}${color}^${RESET}`);
    }
  } else {
    lines.push(`${BOLD}${color}${d.severity}${RESET}${BOLD}: ${d.message}${RESET}`);
  }
  if (d.hint) {
    lines.push(`  ${BOLD}${CYAN}hint${RESET}: ${d.hint}`);
  }
  return lines.join(`
`);
}

// playground/compiler.ts
var BLOCKED = new Set([
  "std/os",
  "std/thread",
  "std/sync",
  "std/sqlite",
  "std/crypto",
  "std/signal",
  "std/process",
  "std/net",
  "std/http"
]);
function resolveImportsPlayground(program) {
  const visited = new Set;
  const structs = [];
  const enums = [];
  const functions = [];
  const traits = [];
  const impls = [];
  function processImports(prog) {
    for (const imp of prog.imports) {
      const normPath = imp.path.replace(/\.milo$/, "");
      if (BLOCKED.has(normPath)) {
        throw new Error(`'${imp.path}' is not available in the playground`);
      }
      const key = normPath + ".milo";
      if (visited.has(key))
        continue;
      visited.add(key);
      const content = { "std/log.milo": `// std/log — logging to stderr with level tags

from "std/time" import { epochSecs }

fn _logMsg(tag: string, msg: string): void {
    let ts = epochSecs()
    eprint($"{tag} {ts.toString()} {msg}")
}

fn logDebug(msg: string): void {
    _logMsg("[DEBUG]", msg)
}

fn logInfo(msg: string): void {
    _logMsg("[INFO] ", msg)
}

fn logWarn(msg: string): void {
    _logMsg("[WARN] ", msg)
}

fn logError(msg: string): void {
    _logMsg("[ERROR]", msg)
}
`, "std/mem.milo": `// std/mem — memory management with automatic cleanup

from "std/os" import { free, malloc, mmap, munmap }
from "std/platform" import { mapPrivateAnon }

// ── MappedMemory ──

// Memory-mapped region. Automatically unmapped on drop.

struct MappedMemory {
    ptr: i64,
    len: i64,
}

impl Drop for MappedMemory {
    fn drop(self: &mut Self): void {
        if self.ptr != 0 {
            unsafe {
                munmap(self.ptr as *u8, self.len)
            }
        }
    }
}

// Allocate an anonymous (non-file-backed) memory-mapped region.

fn mmapAnon(size: i64): Result<MappedMemory> {
    let PROT_RW: i32 = 3
    var addr: i64 = 0
    unsafe {
        let p = mmap(0 as *u8, size, PROT_RW, mapPrivateAnon(), - 1, 0)
        addr = p as i64
    }
    let mapFailed: i64 = - 1 as i64
    if addr == mapFailed {
        return Result.Err("mmap failed")
    }
    return Result.Ok(MappedMemory {
        ptr: addr, len: size
    }
    )
}

// Memory-map a file descriptor for reading.

fn mmapFile(fFd: i32, size: i64): Result<MappedMemory> {
    let PROT_READ: i32 = 1
    let MAP_PRIVATE: i32 = 2
    var addr: i64 = 0
    unsafe {
        let p = mmap(0 as *u8, size, PROT_READ, MAP_PRIVATE, fFd, 0)
        addr = p as i64
    }
    let mapFailed: i64 = - 1 as i64
    if addr == mapFailed {
        return Result.Err("mmap failed")
    }
    return Result.Ok(MappedMemory {
        ptr: addr, len: size
    }
    )
}

// ── Arena ──

// Bump allocator with automatic cleanup.
// All allocations are 8-byte aligned. Use arenaReset() to reclaim without freeing.

struct Arena {
    base: i64,
    cap: i64,
    used: i64,
}

impl Drop for Arena {
    fn drop(self: &mut Self): void {
        if self.base != 0 {
            unsafe {
                free(self.base as *u8)
            }
        }
    }
}

// Create a new arena with the given capacity in bytes.

fn arenaNew(capacity: i64): Result<Arena> {
    unsafe {
        let p = malloc(capacity)
        let addr = p as i64
        if addr == 0 {
            return Result.Err("arena allocation failed")
        }
        return Result.Ok(Arena {
            base: addr, cap: capacity, used: 0
        }
        )
    }
}

// Allocate size bytes from the arena (8-byte aligned).
// Returns Err if the arena doesn't have enough space.

fn arenaAlloc(a: &mut Arena, size: i64): Result<i64> {
    // align to 8 bytes
    let seven: i64 = 7
    let aligned = (a.used + seven) & ~seven
    if aligned + size > a.cap {
        return Result.Err("arena out of memory")
    }
    let ptr = a.base + aligned
    a.used = aligned + size
    return Result.Ok(ptr)
}

// Reset the arena, making all previously allocated memory available for reuse.

fn arenaReset(a: &mut Arena): void {
    a.used = 0
}
`, "std/strconv.milo": `// std/strconv — string-to-number and number-to-string conversions

from "std/os" import { snprintf }

extern

fn strtol(str: *u8, endptr: *u8, base: i32): i64

extern

fn atof(str: *u8): f64

// Parse a decimal integer string. Returns None if not a valid integer.

fn parseInt(s: string): Option<i64> {
    if s.len == 0 {
        return Option.None
    }
    var start: i64 = 0
    if s[0] == 45 || s[0] == 43 {
        start = 1
    }
    if start >= s.len {
        return Option.None
    }
    var i = start
    while i < s.len {
        if s[i] < 48 || s[i] > 57 {
            return Option.None
        }
        i = i + 1
    }
    unsafe {
        return Option.Some(strtol(s, 0 as *u8, 10))
    }
}

// Parse an integer string with a given base (2, 8, 10, 16).

fn parseIntRadix(s: string, base: i32): Option<i64> {
    if s.len == 0 {
        return Option.None
    }
    unsafe {
        return Option.Some(strtol(s, 0 as *u8, base))
    }
}

// Parse a floating-point string. Returns None if not a valid number.

fn parseFloat(s: string): Option<f64> {
    if s.len == 0 {
        return Option.None
    }
    var start: i64 = 0
    if s[0] == 45 || s[0] == 43 {
        start = 1
    }
    if start >= s.len {
        return Option.None
    }
    // must start with digit or dot
    if (s[start] < 48 || s[start] > 57) && s[start] != 46 {
        return Option.None
    }
    unsafe {
        return Option.Some(atof(s))
    }
}

// Convert i64 to hexadecimal string (lowercase).

fn i64ToHex(n: i64): string {
    var buf: [u8 ; 32] = [0 ; 32]
    unsafe {
        snprintf(buf, 32, "%lx", n)
        return _cstrToString(buf as *u8)
    }
}

// Convert i64 to octal string.

fn i64ToOct(n: i64): string {
    var buf: [u8 ; 32] = [0 ; 32]
    unsafe {
        snprintf(buf, 32, "%lo", n)
        return _cstrToString(buf as *u8)
    }
}

// Convert i64 to binary string.

fn i64ToBin(n: i64): string {
    if n == 0 {
        return "0"
    }
    var result = ""
    var val = n
    while val > 0 {
        if (val & 1) == 1 {
            result = "1" + result
        } else {
            result = "0" + result
        }
        val = val >> 1
    }
    return result
}

// Format f64 with a specific number of decimal places.

fn formatFloat(n: f64, decimals: i32): string {
    var buf: [u8 ; 64] = [0 ; 64]
    unsafe {
        snprintf(buf, 64, "%.*f", decimals, n)
        return _cstrToString(buf as *u8)
    }
}
`, "std/fmt.milo": `// std/fmt — string formatting with {} placeholders
//
// Usage: fmt2("hello {}, you are {} years old", name, age.toString())
// Each {} is replaced left-to-right with the corresponding argument.

// Replace the first {} with val.

fn fmt1(template: &string, a: &string): string {
    var result = ""
    var used = false
    var i: i64 = 0
    while i < template.len {
        if !used && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            result = result + a.clone()
            used = true
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first two {} with a and b.

fn fmt2(template: &string, a: &string, b: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 2 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first three {} with a, b, and c.

fn fmt3(template: &string, a: &string, b: &string, c: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 3 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            if which == 2 {
                result = result + c.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first four {} with a, b, c, and d.

fn fmt4(template: &string, a: &string, b: &string, c: &string, d: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 4 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            if which == 2 {
                result = result + c.clone()
            }
            if which == 3 {
                result = result + d.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Left-pad a string to a minimum width.

fn padLeft(s: &string, width: i64, ch: u8): string {
    var result = ""
    var padding = width - s.len
    while padding > 0 {
        result.push(ch)
        padding = padding - 1
    }
    result = result + s.clone()
    return result
}

// Right-pad a string to a minimum width.

fn padRight(s: &string, width: i64, ch: u8): string {
    var result = s.clone()
    var padding = width - s.len
    while padding > 0 {
        result.push(ch)
        padding = padding - 1
    }
    return result
}

// Zero-pad an integer to a minimum width.

fn zeroPad(n: i64, width: i64): string {
    let s = n.toString()
    return padLeft(s, width, 48 as u8)
}

// Join a Vec<string> with a separator.

fn join(parts: &Vec<string>, sep: &string): string {
    var result = ""
    var i: i64 = 0
    while i < parts.len {
        if i > 0 {
            result = result + sep.clone()
        }
        result = result + parts[i].clone()
        i = i + 1
    }
    return result
}
`, "std/random.milo": `// std/random — random number generation
//
// Uses arc4random (macOS/BSD) — no seeding required, cryptographically strong.
// For Linux compat, could fall back to /dev/urandom via std/io.


extern

fn arc4random(): u32

extern

fn arc4random_uniform(upper: u32): u32

extern

fn arc4random_buf(buf: *u8, nbytes: i64): void

// Random u32 in [0, 2^32).

fn randU32(): u32 {
    unsafe {
        return arc4random()
    }
}

// Random i64 in [0, max). Panics if max <= 0.

fn randInt(max: i64): i64 {
    if max <= 0 {
        eprint("randInt: max must be > 0")
    }
    unsafe {
        return arc4random_uniform(max as u32) as i64
    }
}

// Random i64 in [min, max]. Panics if min > max.

fn randRange(min: i64, max: i64): i64 {
    if min > max {
        eprint("randRange: min must be <= max")
    }
    let span = max - min + 1
    return min + randInt(span)
}

// Random f64 in [0.0, 1.0).

fn randFloat(): f64 {
    let r = randU32()
    return r as f64 / 4294967296.0
}

// Random f64 in [min, max).

fn randFloatRange(min: f64, max: f64): f64 {
    return min + randFloat() * (max - min)
}

// Random bool (coin flip).

fn randBool(): bool {
    return randInt(2) == 0
}

// Shuffle a Vec<i64> in place using Fisher-Yates. Pass v.len() as n.

fn shuffleI64(v: &mut Vec<i64>, n: i64): void {
    var i = n - 1
    while i > 0 {
        let j = randRange(0, i)
        let tmp = v[i]
        v[i] = v[j]
        v[j] = tmp
        i = i - 1
    }
}

// Fill a buffer with random bytes.

fn randBytes(buf: *u8, n: i64): void {
    unsafe {
        arc4random_buf(buf, n)
    }
}
`, "std/sync.milo": `// std/sync — synchronization primitives (mutex, channel) via pthreads

from "std/os" import { free, malloc, memcpy, pthread_cond_destroy, pthread_cond_init, pthread_cond_signal, pthread_cond_wait, pthread_mutex_destroy, pthread_mutex_init, pthread_mutex_lock, pthread_mutex_unlock }

// ── Mutex ──
// Mutual exclusion lock. Wrap shared data access with lock/unlock.
//
//   let m = mutexNew()!
//   mutexLock(m)!
//   // ... critical section ...
//   mutexUnlock(m)!
//   mutexDestroy(m)

struct Mutex {
    _handle: *u8,
}

fn mutexNew(): Result<Mutex> {
    unsafe {
        let h = malloc(64)
        let r = pthread_mutex_init(h, 0 as *u8)
        if r != 0 {
            free(h)
            return Result.Err("pthread_mutex_init failed")
        }
        return Result.Ok(Mutex { _handle: h })
    }
}

fn mutexLock(m: &Mutex): Result<i32> {
    unsafe {
        let r = pthread_mutex_lock(m._handle)
        if r != 0 {
            return Result.Err("pthread_mutex_lock failed")
        }
        return Result.Ok(0)
    }
}

fn mutexUnlock(m: &Mutex): Result<i32> {
    unsafe {
        let r = pthread_mutex_unlock(m._handle)
        if r != 0 {
            return Result.Err("pthread_mutex_unlock failed")
        }
        return Result.Ok(0)
    }
}

fn mutexDestroy(m: &Mutex): void {
    unsafe {
        pthread_mutex_destroy(m._handle)
        free(m._handle)
    }
}

// ── Channel ──
// Bounded FIFO channel for safe message passing between threads.
// Channel is a handle type — copying it shares the underlying queue.
// Safe to capture in move closures and send across threads.
//
//   let ch = channelNew(16)!
//   let t = spawn(move (): void => {
//       channelSend(ch, 42)!
//   })!
//   let val = channelRecv(ch)!
//   threadJoin(t)!
//   channelDestroy(ch)

// Inner layout at _ptr (64 bytes):
//   [0..8)   mutex handle
//   [8..16)  condNotEmpty handle
//   [16..24) condNotFull handle
//   [24..32) buf pointer
//   [32..40) capacity
//   [40..48) len
//   [48..56) head
//   [56..64) tail

struct Channel {
    _ptr: *u8,
}

fn channelNew(capacity: i64): Result<Channel> {
    unsafe {
        let inner = malloc(64)

        let mtx = malloc(64)
        let r1 = pthread_mutex_init(mtx, 0 as *u8)
        if r1 != 0 {
            free(mtx)
            free(inner)
            return Result.Err("channel mutex init failed")
        }
        let cne = malloc(48)
        let r2 = pthread_cond_init(cne, 0 as *u8)
        if r2 != 0 {
            free(mtx)
            free(cne)
            free(inner)
            return Result.Err("channel cond init failed")
        }
        let cnf = malloc(48)
        let r3 = pthread_cond_init(cnf, 0 as *u8)
        if r3 != 0 {
            free(mtx)
            free(cne)
            free(cnf)
            free(inner)
            return Result.Err("channel cond init failed")
        }
        let buf = malloc(capacity * 8)

        var zero: i64 = 0
        // store pointers and initial values into inner block
        memcpy(inner, (&mtx) as *u8, 8)
        memcpy((inner as i64 + 8) as *u8, (&cne) as *u8, 8)
        memcpy((inner as i64 + 16) as *u8, (&cnf) as *u8, 8)
        memcpy((inner as i64 + 24) as *u8, (&buf) as *u8, 8)
        memcpy((inner as i64 + 32) as *u8, (&capacity) as *u8, 8)
        memcpy((inner as i64 + 40) as *u8, (&zero) as *u8, 8)
        memcpy((inner as i64 + 48) as *u8, (&zero) as *u8, 8)
        memcpy((inner as i64 + 56) as *u8, (&zero) as *u8, 8)

        return Result.Ok(Channel { _ptr: inner })
    }
}

fn channelSend(ch: &Channel, val: i64): Result<i32> {
    var v: i64 = val
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var condNE: *u8 = 0 as *u8
        memcpy((&condNE) as *u8, (base + 8) as *u8, 8)
        var condNF: *u8 = 0 as *u8
        memcpy((&condNF) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        var cap: i64 = 0
        memcpy((&cap) as *u8, (base + 32) as *u8, 8)
        var curLen: i64 = 0
        var tail: i64 = 0

        pthread_mutex_lock(mtx)
        memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        while curLen == cap {
            pthread_cond_wait(condNF, mtx)
            memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        }
        memcpy((&tail) as *u8, (base + 56) as *u8, 8)
        let slotPtr = (buf as i64 + tail * 8) as *u8
        memcpy(slotPtr, (&v) as *u8, 8)
        tail = (tail + 1) % cap
        curLen = curLen + 1
        memcpy((base + 56) as *u8, (&tail) as *u8, 8)
        memcpy((base + 40) as *u8, (&curLen) as *u8, 8)
        pthread_cond_signal(condNE)
        pthread_mutex_unlock(mtx)
        return Result.Ok(0)
    }
}

fn channelRecv(ch: &Channel): Result<i64> {
    var val: i64 = 0
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var condNE: *u8 = 0 as *u8
        memcpy((&condNE) as *u8, (base + 8) as *u8, 8)
        var condNF: *u8 = 0 as *u8
        memcpy((&condNF) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        var cap: i64 = 0
        memcpy((&cap) as *u8, (base + 32) as *u8, 8)
        var curLen: i64 = 0
        var head: i64 = 0

        pthread_mutex_lock(mtx)
        memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        while curLen == 0 {
            pthread_cond_wait(condNE, mtx)
            memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        }
        memcpy((&head) as *u8, (base + 48) as *u8, 8)
        let slotPtr = (buf as i64 + head * 8) as *u8
        memcpy((&val) as *u8, slotPtr, 8)
        head = (head + 1) % cap
        curLen = curLen - 1
        memcpy((base + 48) as *u8, (&head) as *u8, 8)
        memcpy((base + 40) as *u8, (&curLen) as *u8, 8)
        pthread_cond_signal(condNF)
        pthread_mutex_unlock(mtx)
        return Result.Ok(val)
    }
}

fn channelDestroy(ch: &Channel): void {
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var cne: *u8 = 0 as *u8
        memcpy((&cne) as *u8, (base + 8) as *u8, 8)
        var cnf: *u8 = 0 as *u8
        memcpy((&cnf) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        pthread_mutex_destroy(mtx)
        pthread_cond_destroy(cne)
        pthread_cond_destroy(cnf)
        free(mtx)
        free(cne)
        free(cnf)
        free(buf)
        free(ch._ptr)
    }
}
`, "std/toml.milo": `// std/toml — TOML config file parser
//
//   let t = tomlParse(data)!
//   let name = t.str("name")!
//   let port = t.i64("port")!
//   let db = t.table("database")!
//   let host = db.str("host")!

from "std/os" import { read }

struct Toml {
    raw: string,
    start: i64,
    end: i64,
}

impl Toml {
    fn str(self: &Self, key: &string): Option<string> {
        return tomlGetStr(self.raw, self.start, self.end, key)
    }

    fn i64(self: &Self, key: &string): Option<i64> {
        return tomlGetI64(self.raw, self.start, self.end, key)
    }

    fn f64(self: &Self, key: &string): Option<f64> {
        return tomlGetF64(self.raw, self.start, self.end, key)
    }

    fn bool(self: &Self, key: &string): Option<bool> {
        return tomlGetBool(self.raw, self.start, self.end, key)
    }

    fn table(self: &Self, key: &string): Option<Toml> {
        return tomlGetTable(self.raw, self.start, self.end, key)
    }
}

fn tomlParse(s: string): Result<Toml> {
    if s.len == 0 {
        return Result.Err("empty input")
    }
    let n = s.len
    return Result.Ok(Toml { raw: s, start: 0, end: n })
}

// ── Internal helpers ──

fn _tomlSkipWs(s: &string, pos: i64, end: i64): i64 {
    var i = pos
    while i < end {
        let c = s[i]
        if c == ' ' || c == '\\t' || c == '\\r' {
            i = i + 1
        } else if c == '#' {
            while i < end && s[i] != '\\n' { i = i + 1 }
        } else {
            break
        }
    }
    return i
}

fn _tomlSkipLine(s: &string, pos: i64, end: i64): i64 {
    var i = pos
    while i < end && s[i] != '\\n' { i = i + 1 }
    if i < end { i = i + 1 }
    return i
}

fn _tomlKeyMatches(s: &string, pos: i64, end: i64, key: &string): bool {
    var i = pos
    var j: i64 = 0
    // bare key
    while i < end && j < key.len {
        if s[i] != key[j] { return false }
        i = i + 1
        j = j + 1
    }
    if j != key.len { return false }
    // next non-ws char must be '='
    let after = _tomlSkipWs(s, i, end)
    return after < end && s[after] == '='
}

fn _tomlReadValue(s: &string, pos: i64, end: i64): i64 {
    // return end position of the value
    var i = pos
    if i >= end { return i }
    let c = s[i]
    if c == '"' {
        // quoted string
        i = i + 1
        while i < end && s[i] != '"' {
            if s[i] == '\\\\' { i = i + 1 }
            i = i + 1
        }
        if i < end { i = i + 1 }
        return i
    }
    if c == '\\'' {
        // literal string
        i = i + 1
        while i < end && s[i] != '\\'' { i = i + 1 }
        if i < end { i = i + 1 }
        return i
    }
    if c == '[' {
        // inline array — skip until matching ]
        var depth: i32 = 1
        i = i + 1
        while i < end && depth > 0 {
            if s[i] == '[' { depth = depth + 1 }
            if s[i] == ']' { depth = depth - 1 }
            if s[i] == '"' {
                i = i + 1
                while i < end && s[i] != '"' {
                    if s[i] == '\\\\' { i = i + 1 }
                    i = i + 1
                }
            }
            i = i + 1
        }
        return i
    }
    // bare value (number, bool, date) — read until newline or comment
    while i < end && s[i] != '\\n' && s[i] != '#' {
        i = i + 1
    }
    // trim trailing whitespace
    while i > pos && (s[i - 1] == ' ' || s[i - 1] == '\\t' || s[i - 1] == '\\r') {
        i = i - 1
    }
    return i
}

fn _tomlFindKey(s: &string, start: i64, end: i64, key: &string): Option<Toml> {
    var i = start
    while i < end {
        i = _tomlSkipWs(s, i, end)
        if i >= end { break }
        if s[i] == '\\n' {
            i = i + 1
            continue
        }
        // table header [name] — stop scanning if we hit one
        if s[i] == '[' { break }
        if _tomlKeyMatches(s, i, end, key) {
            // skip key and =
            var j = i
            while j < end && s[j] != '=' { j = j + 1 }
            j = j + 1
            j = _tomlSkipWs(s, j, end)
            let valStart = j
            let valEnd = _tomlReadValue(s, j, end)
            return Option.Some(Toml { raw: s.clone(), start: valStart, end: valEnd })
        }
        i = _tomlSkipLine(s, i, end)
    }
    return Option.None
}

fn tomlGetStr(s: &string, start: i64, end: i64, key: &string): Option<string> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        if t.start < t.end && (t.raw[t.start] == '"' || t.raw[t.start] == '\\'') {
            let quote = t.raw[t.start]
            var result: string = ""
            var i = t.start + 1
            while i < t.end - 1 {
                if t.raw[i] == '\\\\' && quote == '"' && i + 1 < t.end - 1 {
                    i = i + 1
                    let esc = t.raw[i]
                    if esc == 'n' { result.push('\\n') }
                    else if esc == 't' { result.push('\\t') }
                    else if esc == 'r' { result.push('\\r') }
                    else if esc == '"' { result.push('"') }
                    else if esc == '\\\\' { result.push('\\\\') }
                    else { result.push(esc) }
                } else {
                    result.push(t.raw[i])
                }
                i = i + 1
            }
            return Option.Some(result)
        }
        // bare string
        return Option.Some(t.raw[t.start..t.end].clone())
    }
    return Option.None
}

fn tomlGetI64(s: &string, start: i64, end: i64, key: &string): Option<i64> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        var result: i64 = 0
        var negative: bool = false
        var i = t.start
        if i < t.end && t.raw[i] == '-' {
            negative = true
            i = i + 1
        }
        if i < t.end && t.raw[i] == '+' { i = i + 1 }
        while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
            result = result * 10 + (t.raw[i] as i32 - 48) as i64
            i = i + 1
        }
        if negative { result = 0 - result }
        return Option.Some(result)
    }
    return Option.None
}

fn tomlGetF64(s: &string, start: i64, end: i64, key: &string): Option<f64> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        var result: f64 = 0.0
        var negative: bool = false
        var i = t.start
        if i < t.end && t.raw[i] == '-' {
            negative = true
            i = i + 1
        }
        if i < t.end && t.raw[i] == '+' { i = i + 1 }
        while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
            result = result * 10.0 + (t.raw[i] as i32 - 48) as f64
            i = i + 1
        }
        if i < t.end && t.raw[i] == '.' {
            i = i + 1
            var frac: f64 = 0.1
            while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
                result = result + (t.raw[i] as i32 - 48) as f64 * frac
                frac = frac * 0.1
                i = i + 1
            }
        }
        if negative { result = 0.0 - result }
        return Option.Some(result)
    }
    return Option.None
}

fn tomlGetBool(s: &string, start: i64, end: i64, key: &string): Option<bool> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        if t.end - t.start == 4 && t.raw[t.start] == 't' {
            return Option.Some(true)
        }
        if t.end - t.start == 5 && t.raw[t.start] == 'f' {
            return Option.Some(false)
        }
    }
    return Option.None
}

fn tomlGetTable(s: &string, start: i64, end: i64, key: &string): Option<Toml> {
    // search for [key] header
    var i = start
    while i < end {
        i = _tomlSkipWs(s, i, end)
        if i >= end { break }
        if s[i] == '\\n' {
            i = i + 1
            continue
        }
        if s[i] == '[' && (i + 1 >= end || s[i + 1] != '[') {
            let hdrStart = i + 1
            var hdrEnd = hdrStart
            while hdrEnd < end && s[hdrEnd] != ']' { hdrEnd = hdrEnd + 1 }
            let hdrName = s[hdrStart..hdrEnd]
            if _strEq(hdrName, key) {
                // table body: from next line until next [header] or EOF
                let bodyStart = _tomlSkipLine(s, hdrEnd + 1, end)
                var bodyEnd = bodyStart
                var j = bodyStart
                while j < end {
                    j = _tomlSkipWs(s, j, end)
                    if j >= end { break }
                    if s[j] == '\\n' {
                        j = j + 1
                        continue
                    }
                    if s[j] == '[' {
                        bodyEnd = j
                        break
                    }
                    j = _tomlSkipLine(s, j, end)
                    bodyEnd = j
                }
                if j >= end { bodyEnd = end }
                return Option.Some(Toml { raw: s.clone(), start: bodyStart, end: bodyEnd })
            }
        }
        i = _tomlSkipLine(s, i, end)
    }
    return Option.None
}

fn _strEq(a: &string, b: &string): bool {
    if a.len != b.len { return false }
    var i: i64 = 0
    while i < a.len {
        if a[i] != b[i] { return false }
        i = i + 1
    }
    return true
}
`, "std/unicode.milo": `// std/unicode — character classification and case conversion
//
// Currently ASCII-only. UTF-8 multi-byte codepoint support deferred.

// Classify ASCII bytes.

fn isAscii(ch: u8): bool {
    return ch < 128
}

fn isDigit(ch: u8): bool {
    return ch >= 48 && ch <= 57
}

fn isLower(ch: u8): bool {
    return ch >= 97 && ch <= 122
}

fn isUpper(ch: u8): bool {
    return ch >= 65 && ch <= 90
}

fn isAlpha(ch: u8): bool {
    return isLower(ch) || isUpper(ch)
}

fn isAlphanumeric(ch: u8): bool {
    return isAlpha(ch) || isDigit(ch)
}

fn isWhitespace(ch: u8): bool {
    return ch == 32 || ch == 9 || ch == 10 || ch == 13 || ch == 12
}

fn isPunctuation(ch: u8): bool {
    return (ch >= 33 && ch <= 47) || (ch >= 58 && ch <= 64) || (ch >= 91 && ch <= 96) || (ch >= 123 && ch <= 126)
}

fn isHexDigit(ch: u8): bool {
    return isDigit(ch) || (ch >= 97 && ch <= 102) || (ch >= 65 && ch <= 70)
}

fn isPrintable(ch: u8): bool {
    return ch >= 32 && ch < 127
}

fn isControl(ch: u8): bool {
    return ch < 32 || ch == 127
}

// Case conversion for ASCII bytes.

fn toLowerChar(ch: u8): u8 {
    if isUpper(ch) {
        return ch + 32
    }
    return ch
}

fn toUpperChar(ch: u8): u8 {
    if isLower(ch) {
        return ch - 32
    }
    return ch
}

// Check if an entire string is numeric (all digits).

fn isNumeric(s: &string): bool {
    if s.len == 0 {
        return false
    }
    var i: i64 = 0
    while i < s.len {
        if !isDigit(s[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

// Check if an entire string is alphabetic.

fn isAlphaStr(s: &string): bool {
    if s.len == 0 {
        return false
    }
    var i: i64 = 0
    while i < s.len {
        if !isAlpha(s[i]) {
            return false
        }
        i = i + 1
    }
    return true
}
`, "std/env.milo": `// std/env — environment variable access

from "std/os" import { getenv }

// Get an environment variable. Returns None if not set.

fn getEnv(name: string): Option<string> {
    unsafe {
        let ptr = getenv(name)
        if ptr as i64 == 0 as i64 {
            return Option.None
        }
        return Option.Some(_cstrToString(ptr))
    }
}

// Get an environment variable with a default value.

fn getEnvOr(name: string, defaultVal: string): string {
    match getEnv(name) {
        Option.Some(val) => {
            return val
        }
        Option.None => {
            return defaultVal
        }
    }
}
`, "std/arena.milo": `// std/arena — generational arena for cyclic and graph data structures
//
// Handles are freely copyable and storable (unlike &T).
// Generation checks detect use-after-free at runtime.
//
// Handle<T> carries a phantom type param so handles from one arena cannot
// accidentally be used with another arena of a different element type.
// Returning &T is forbidden by second-class refs; mutation goes through
// arenaSet (full overwrite) or arenaModify (closure on current value).

// Opaque handle to an arena slot. Safe to copy, store, and return.
// T is phantom — not stored, only used for type-checking handle/arena pairs.

@derive(Eq)
struct Handle<T> {
    index: i32,
    generation: i32,
}

// Generational arena backed by Vec<T>.

struct Arena<T> {
    data: Vec<T>,
    gens: Vec<i32>,
    freeList: Vec<i32>,
    live: i64,
}

// Create a new empty arena.

fn arenaNew<T> (): Arena<T> {
    var a: Arena<T> = Arena {
        data: Vec.new(),
        gens: Vec.new(),
        freeList: Vec.new(),
        live: 0,
    }
    return a
}

// Insert a value and return a handle to it.

fn arenaAlloc<T> (a: &mut Arena<T>, val: T): Handle<T> {
    if a.freeList.len > 0 {
        let fi = a.freeList[a.freeList.len - 1]
        a.freeList.pop()
        let idx = fi as i64
        a.data[idx] = val
        let gen = a.gens[idx]
        a.live = a.live + 1
        var h: Handle<T> = Handle {
            index: fi, generation: gen
        }
        return h
    }
    let idx = a.data.len
    a.data.push(val)
    a.gens.push(1)
    a.live = a.live + 1
    var h: Handle<T> = Handle {
        index: idx as i32, generation: 1
    }
    return h
}

// Check whether a handle is still valid.

fn arenaValid<T> (a: &Arena<T>, h: Handle<T>): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    return a.gens[idx] == h.generation
}

// Free a slot, bumping its generation so stale handles are detected.

fn arenaFree<T> (a: &mut Arena<T>, h: Handle<T>): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.gens[idx] = a.gens[idx] + 1
    a.freeList.push(h.index)
    a.live = a.live - 1
    return true
}

// Get a copy of the value at a handle. Returns None if the handle is stale.
// Returns by value, not &T, because second-class refs cannot be stored in
// Option<_>. For large T, prefer arenaModify to avoid the copy churn.

fn arenaGet<T> (a: &Arena<T>, h: Handle<T>): Option<T> {
    let idx = h.index as i64
    if idx < 0 {
        return Option.None
    }
    if idx >= a.data.len {
        return Option.None
    }
    if a.gens[idx] != h.generation {
        return Option.None
    }
    return Option.Some(a.data[idx])
}

// Overwrite the value at a handle. Returns false if the handle is stale.

fn arenaSet<T> (a: &mut Arena<T>, h: Handle<T>, val: T): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.data[idx] = val
    return true
}

// In-place update via closure. Avoids the manual get/modify/set dance and
// is the recommended way to mutate a single field of an arena value.
// Returns false if the handle is stale (closure not invoked).

fn arenaModify<T> (a: &mut Arena<T>, h: Handle<T>, f: (T) => T): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.data[idx] = f(a.data[idx])
    return true
}

// Number of live entries.

fn arenaLen<T> (a: &Arena<T>): i64 {
    return a.live
}

// Method API — same functionality, nicer syntax.

impl Arena<T> {
    fn alloc(self: &mut Self, val: T): Handle<T> {
        return arenaAlloc(self, val)
    }

    fn get(self: &Self, h: Handle<T>): Option<T> {
        return arenaGet(self, h)
    }

    fn set(self: &mut Self, h: Handle<T>, val: T): bool {
        return arenaSet(self, h, val)
    }

    fn modify(self: &mut Self, h: Handle<T>, f: (T) => T): bool {
        return arenaModify(self, h, f)
    }

    fn free(self: &mut Self, h: Handle<T>): bool {
        return arenaFree(self, h)
    }

    fn valid(self: &Self, h: Handle<T>): bool {
        return arenaValid(self, h)
    }
}

`, "std/http.milo": `// std/http — high-level HTTP server for Milo

from "std/os" import { accept, bind, close, getsockname, listen, ntohs, read, setsockopt, socket, write }
from "std/platform" import { SockAddrIn, makeSockaddr, makeZeroedSockaddr, solSocket, soReuseaddr }

// ── Public types ──

// Incoming HTTP request with method and path.

struct Request {
    method: string,
    path: string,
}

// Key-value pair for path params and response headers.
struct Param {
    name: string,
    value: string,
}

// Request context passed to route handlers.
// Contains the matched request, extracted path params, and response state.
struct Context {
    req: Request,
    params: Vec<Param>,
    statusCode: i32,
    respHeaders: Vec<Param>,
}

impl Context {
    fn param(self: &Self, name: &string): string {
        var i: i64 = 0
        while i < self.params.len {
            if self.params[i].name == *name {
                return self.params[i].value.clone()
            }
            i = i + 1
        }
        return ""
    }

    fn setStatus(self: &mut Self, code: i32): void {
        self.statusCode = code
    }

    fn setHeader(self: &mut Self, name: string, value: string): void {
        self.respHeaders.push(Param { name: name, value: value })
    }

    fn text(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "text/plain; charset=utf-8", body)
        }
        return Response.Text(body)
    }

    fn json(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "application/json", body)
        }
        return Response.Json(body)
    }

    fn html(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "text/html; charset=utf-8", body)
        }
        return Response.Html(body)
    }

    fn redirect(self: &Self, url: string): Response {
        return Response.Status(302, "text/plain; charset=utf-8", url)
    }
}

// HTTP response type.
// Text/Html/Json set the content-type automatically.
// Status(code, contentType, body) for custom responses.

enum Response {
    Text(string),
    Html(string),
    Json(string),
    NotFound,
    Status(i32, string, string),
}

// ── Internal helpers ──

fn bufToStr(buf: &[u8 ; 8192], start: i64, end: i64): string {
    var s: string = ""
    var i: i64 = start
    while i < end {
        s.push(buf[i])
        i = i + 1
    }
    return s
}

fn parseRequest(buf: &[u8 ; 8192], n: i64): Request {
    var i: i64 = 0
    while i < n && buf[i] != ' ' {
        i = i + 1
    }
    let method = bufToStr(buf, 0, i)
    while i < n && buf[i] == ' ' {
        i = i + 1
    }
    let pathStart = i
    while i < n && buf[i] != ' ' {
        i = i + 1
    }
    let path = bufToStr(buf, pathStart, i)
    return Request {
        method: method, path: path
    }
}

fn statusText(status: i32): string {
    if status == 200 {
        return "200 OK"
    }
    if status == 201 {
        return "201 Created"
    }
    if status == 204 {
        return "204 No Content"
    }
    if status == 301 {
        return "301 Moved Permanently"
    }
    if status == 400 {
        return "400 Bad Request"
    }
    if status == 404 {
        return "404 Not Found"
    }
    if status == 500 {
        return "500 Internal Server Error"
    }
    return "200 OK"
}

fn sendRaw(fd: i32, status: i32, contentType: string, body: string): void {
    var resp: string = "HTTP/1.1 " + statusText(status)
    resp = resp + "\\r\\nContent-Type: " + contentType
    resp = resp + "\\r\\nContent-Length: " + body.len.toString()
    resp = resp + "\\r\\nConnection: close"
    resp = resp + "\\r\\nServer: milo"
    resp = resp + "\\r\\n\\r\\n"
    resp = resp + body
    unsafe {
        write(fd, resp, resp.len)
    }
}

fn sendResponse(fd: i32, response: Response): void {
    match response {
        Response.Text(body) => {
            sendRaw(fd, 200, "text/plain; charset=utf-8", body)
        }
        Response.Html(body) => {
            sendRaw(fd, 200, "text/html; charset=utf-8", body)
        }
        Response.Json(body) => {
            sendRaw(fd, 200, "application/json", body)
        }
        Response.NotFound => {
            sendRaw(fd, 404, "text/plain; charset=utf-8", "404 Not Found")
        }
        Response.Status(code, ct, body) => {
            sendRaw(fd, code, ct, body)
        }
    }
}

// ── Socket with automatic cleanup ──

struct Socket {
    fd: i32,
}

impl Drop for Socket {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

// ── Public API ──

// Start an HTTP server on the given port.
// Pass null for port to let the OS pick an available port.
// The handler receives a Request and returns a Response.
// Example:
//   serve(8080, fn(req: &Request): Response {
//       return Response.Text("hello")
//   })

fn serve(port: u16?, handler: (&Request) => Response): Result<void> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let BACKLOG: i32 = 1024
    let BUF_SIZE: i64 = 8192
    let SIZEOF_SOCKADDR_IN: u32 = 16

    // port 0 tells the OS to pick a random available port
    var bindPort: u16 = 0
    if let Option.Some(p) = port {
        bindPort = p
    }

    unsafe {
        let rawFd = socket(AF_INET, SOCK_STREAM, 0)
        if rawFd < 0 {
            return Result.Err("socket() failed")
        }
        let sock = Socket {
            fd: rawFd
        }

        var one: i32 = 1
        setsockopt(sock.fd, solSocket(), soReuseaddr(), one, 4)

        var addr = makeSockaddr(bindPort, 0)

        if bind(sock.fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            return Result.Err("bind() failed")
        }

        if listen(sock.fd, BACKLOG) < 0 {
            return Result.Err("listen() failed")
        }

        // retrieve actual port (needed when bindPort was 0)
        var boundAddr = makeZeroedSockaddr()
        var boundLen: u32 = SIZEOF_SOCKADDR_IN
        getsockname(sock.fd, boundAddr, boundLen)
        let actualPort = ntohs(boundAddr.sinPort)

        print($"listening on http://localhost:{actualPort}")

        while true {
            var clientAddr = makeZeroedSockaddr()
            var addrlen: u32 = SIZEOF_SOCKADDR_IN
            let clientFd = accept(sock.fd, clientAddr, addrlen)
            if clientFd < 0 {
                continue
            }

            var buf: [u8 ; 8192] = [0 ; 8192]
            let n = read(clientFd, buf, BUF_SIZE)
            if n > 0 {
                let req = parseRequest(buf, n)
                let resp = handler(req)
                sendResponse(clientFd, resp)
            }
            close(clientFd)
        }
    }
    return Result.Err("server exited")
}

// ── Router ──

struct Route {
    method: string,
    pattern: string,
    paramNames: Vec<string>,
    handler: (&mut Context) => Response,
}

struct Router {
    routes: Vec<Route>,
    middleware: Vec<(&mut Context, (&mut Context) => Response) => Response>,
}

impl Router {
    fn new(): Router {
        return Router {
            routes: [],
            middleware: [],
        }
    }

    fn get(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("GET", pattern, h)
    }

    fn post(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("POST", pattern, h)
    }

    fn put(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("PUT", pattern, h)
    }

    fn delete(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("DELETE", pattern, h)
    }

    fn all(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("*", pattern, h)
    }

    fn use(self: &mut Self, mw: (&mut Context, (&mut Context) => Response) => Response): void {
        self.middleware.push(mw)
    }

    fn addRoute(self: &mut Self, method: string, pattern: string, h: (&mut Context) => Response): void {
        let paramNames = extractParamNames(pattern)
        self.routes.push(Route {
            method: method,
            pattern: pattern,
            paramNames: paramNames,
            handler: h,
        })
    }

    fn handle(self: &Self, req: Request): Response {
        var i: i64 = 0
        while i < self.routes.len {
            let route = self.routes[i]
            if route.method == "*" || route.method == req.method {
                let params = matchRoute(route.pattern, route.paramNames, req.path)
                if let Option.Some(matched) = params {
                    var ctx = Context {
                        req: req,
                        params: matched,
                        statusCode: 200,
                        respHeaders: [],
                    }
                    let handler = route.handler
                    // wrap handler with middleware chain (innermost first)
                    var final: (&mut Context) => Response = handler
                    var m: i64 = self.middleware.len - 1
                    while m >= 0 {
                        let mw = self.middleware[m]
                        let next = final
                        final = (c: &mut Context) => {
                            return mw(c, next)
                        }
                        m = m - 1
                    }
                    return final(ctx)
                }
            }
            i = i + 1
        }
        return Response.NotFound
    }
}

// Start an HTTP server using a Router.
fn serveRouter(port: u16?, router: &Router): Result<void> {
    return serve(port, (req: &Request) => {
        // clone request since router.handle takes ownership
        let owned = Request { method: req.method.clone(), path: req.path.clone() }
        return router.handle(owned)
    })
}

// ── Path matching ──

// Extract param names from pattern like "/user/:id/posts/:postId"
fn extractParamNames(pattern: &string): Vec<string> {
    var names: Vec<string> = []
    var i: i64 = 0
    while i < pattern.len {
        if pattern[i] == ':' {
            var j: i64 = i + 1
            while j < pattern.len && pattern[j] != '/' {
                j = j + 1
            }
            var name: string = ""
            var k: i64 = i + 1
            while k < j {
                name.push(pattern[k])
                k = k + 1
            }
            names.push(name)
            i = j
        } else {
            i = i + 1
        }
    }
    return names
}

// Match a request path against a route pattern.
// Returns Some(params) on match, None on mismatch.
fn matchRoute(pattern: &string, paramNames: &Vec<string>, path: &string): Option<Vec<Param>> {
    let patSegs = splitPath(pattern)
    let pathSegs = splitPath(path)

    // wildcard: pattern ending with "*" matches any suffix
    var hasWildcard: bool = false
    if patSegs.len > 0 && patSegs[patSegs.len - 1] == "*" {
        hasWildcard = true
    }

    if !hasWildcard && patSegs.len != pathSegs.len {
        return Option.None
    }
    if hasWildcard && pathSegs.len < patSegs.len - 1 {
        return Option.None
    }

    var params: Vec<Param> = []
    var paramIdx: i64 = 0
    var segCount: i64 = patSegs.len
    if hasWildcard {
        segCount = segCount - 1
    }

    var i: i64 = 0
    while i < segCount {
        let pat = patSegs[i]
        if i >= pathSegs.len {
            return Option.None
        }
        let seg = pathSegs[i]
        if pat.len > 0 && pat[0] == ':' {
            // param segment — capture value
            if paramIdx < paramNames.len {
                params.push(Param { name: paramNames[paramIdx].clone(), value: seg.clone() })
                paramIdx = paramIdx + 1
            }
        } else if pat != seg {
            return Option.None
        }
        i = i + 1
    }
    return Option.Some(params)
}

// Split path by '/' into non-empty segments
fn splitPath(path: &string): Vec<string> {
    var segs: Vec<string> = []
    var current: string = ""
    var i: i64 = 0
    while i < path.len {
        if path[i] == '/' {
            if current.len > 0 {
                segs.push(current)
                current = ""
            }
        } else {
            current.push(path[i])
        }
        i = i + 1
    }
    if current.len > 0 {
        segs.push(current)
    }
    return segs
}
`, "std/args.milo": `// std/args — command-line argument parsing

// Return all command-line arguments as a Vec<string>.
// Index 0 is the program name.

fn args(): Vec<string> {
    var result: Vec<string> = Vec.new()
    let n = _miloArgCount()
    var i: i64 = 0
    while i < n {
        result.push(_miloArgAt(i))
        i = i + 1
    }
    return result
}

// Get the value following a --name flag.
// Returns null if the flag is not present.
// Example: getFlag("port") returns the value after --port.

fn getFlag(name: &string): string? {
    let all = args()
    let flag = "--" + name
    var i: i64 = 0
    while i < all.len {
        if all[i] == flag {
            if i + 1 < all.len {
                return Option.Some(all[i + 1])
            }
        }
        i = i + 1
    }
    return null
}

// Check if a --name flag is present in the arguments.

fn hasFlag(name: &string): bool {
    let all = args()
    let flag = "--" + name
    var i: i64 = 0
    while i < all.len {
        if all[i] == flag {
            return true
        }
        i = i + 1
    }
    return false
}
`, "std/set.milo": `// std/set — HashSet<T> backed by HashMap<T, bool>

struct HashSet<T> {
    inner: HashMap<T, bool>,
}

// Create an empty HashSet.

fn setNew<T> (): HashSet<T> {
    return HashSet {
        inner: HashMap.new()
    }
}

// Add a value to the set.

fn setAdd<T> (s: &mut HashSet<T>, val: T): void {
    s.inner.insert(val, true)
}

// Check if the set contains a value.

fn setContains<T> (s: &HashSet<T>, val: T): bool {
    return s.inner.contains(val)
}

// Remove a value from the set.

fn setRemove<T> (s: &mut HashSet<T>, val: T): void {
    s.inner.remove(val)
}

// Number of elements in the set.

fn setLen<T> (s: &HashSet<T>): i64 {
    return s.inner.len
}
`, "std/csv.milo": `// std/csv — CSV parse and write with quoting/escaping


// Parse a CSV string into a Vec of rows, each row a Vec of fields.

fn csvParse(input: &string): Vec<Vec<string>> {
    var rows: Vec<Vec<string>> = Vec.new()
    var row: Vec<string> = Vec.new()
    var field = ""
    var inQuote = false
    var i: i64 = 0
    while i < input.len {
        let ch = input[i]
        if inQuote {
            if ch == 34 {
                // double quote: peek for escaped quote
                if i + 1 < input.len && input[i + 1] == 34 {
                    field.push(34 as u8)
                    i = i + 2
                    continue
                }
                inQuote = false
            } else {
                field.push(ch)
            }
        } else {
            if ch == 34 {
                inQuote = true
            } else {
                if ch == 44 {
                    row.push(field)
                    field = ""
                } else {
                    if ch == 10 {
                        row.push(field)
                        field = ""
                        rows.push(row)
                        row = Vec.new()
                    } else {
                        if ch != 13 {
                            field.push(ch)
                        }
                    }
                }
            }
        }
        i = i + 1
    }
    if field.len > 0 || row.len > 0 {
        row.push(field)
        rows.push(row)
    }
    return rows
}

// Quote a field if it contains commas, quotes, or newlines.

fn _csvQuoteField(val: &string): string {
    var needsQuote = false
    var j: i64 = 0
    while j < val.len {
        let ch = val[j]
        if ch == 44 || ch == 34 || ch == 10 || ch == 13 {
            needsQuote = true
            break
        }
        j = j + 1
    }
    if !needsQuote {
        return val.clone()
    }
    var quoted = "\\""
    var k: i64 = 0
    while k < val.len {
        let ch = val[k]
        if ch == 34 {
            quoted = quoted + "\\"\\""
        } else {
            quoted.push(ch)
        }
        k = k + 1
    }
    quoted = quoted + "\\""
    return quoted
}

// Serialize rows to a CSV string.

fn csvStringify(rows: &Vec<Vec<string>>): string {
    var output = ""
    var ri: i64 = 0
    while ri < rows.len {
        var ci: i64 = 0
        while ci < rows[ri].len {
            if ci > 0 {
                output = output + ","
            }
            output = output + _csvQuoteField(rows[ri][ci])
            ci = ci + 1
        }
        output = output + "\\n"
        ri = ri + 1
    }
    return output
}
`, "std/path.milo": `// std/path — file path manipulation


// Get the file extension including the dot. Returns "" if none.

fn pathExt(path: &string): string {
    var i: i64 = path.len - 1
    while i >= 0 as i64 {
        if path[i] == 46 {
            return path.substr(i, path.len)
        }
        if path[i] == 47 {
            return ""
        }
        i = i - 1
    }
    return ""
}

// Get the last component of a path.

fn pathBasename(path: &string): string {
    if path.len == 0 {
        return ""
    }
    var end: i64 = path.len
    // strip trailing slashes
    while end > 0 as i64 && path[end - 1] == 47 {
        end = end - 1
    }
    if end == 0 as i64 {
        return "/"
    }
    var i: i64 = end - 1
    while i >= 0 as i64 {
        if path[i] == 47 {
            return path.substr(i + 1, end)
        }
        i = i - 1
    }
    return path.substr(0 as i64, end)
}

// Get the directory portion of a path.

fn pathDirname(path: &string): string {
    if path.len == 0 {
        return "."
    }
    var end: i64 = path.len
    // strip trailing slashes
    while end > 0 as i64 && path[end - 1] == 47 {
        end = end - 1
    }
    if end == 0 as i64 {
        return "/"
    }
    // find last slash
    var i: i64 = end - 1
    while i >= 0 as i64 {
        if path[i] == 47 {
            if i == 0 as i64 {
                return "/"
            }
            return path.substr(0 as i64, i)
        }
        i = i - 1
    }
    return "."
}

// Join two path components with a separator.

fn pathJoin(a: &string, b: &string): string {
    if a.len == 0 {
        return b.clone()
    }
    if b.len == 0 {
        return a.clone()
    }
    if a[a.len - 1] == 47 {
        return a + b
    }
    return a + "/" + b
}

// Get the filename without extension.

fn pathStem(path: &string): string {
    let base = pathBasename(path)
    var i: i64 = base.len - 1
    while i > 0 as i64 {
        if base[i] == 46 {
            return base.substr(0 as i64, i)
        }
        i = i - 1
    }
    return base
}
`, "std/signal.milo": `// std/signal — OS signal handling (POSIX)


extern fn signal(signum: i32, handler: *u8): *u8

let SIGHUP: i32 = 1
let SIGINT: i32 = 2
let SIGQUIT: i32 = 3
let SIGABRT: i32 = 6
let SIGKILL: i32 = 9
let SIGALRM: i32 = 14
let SIGTERM: i32 = 15

// Register a handler for a signal. Handler receives the signal number.
fn onSignal(sig: i32, handler: fn(i32): void): void {
    unsafe {
        signal(sig, handler as *u8)
    }
}

// Ignore a signal.
fn ignoreSignal(sig: i32): void {
    unsafe {
        signal(sig, 1 as *u8)
    }
}

// Reset a signal to default behavior.
fn resetSignal(sig: i32): void {
    unsafe {
        signal(sig, 0 as *u8)
    }
}
`, "std/prelude.milo": `// std/prelude — auto-imported into every Milo program (suppress with --no-prelude)

from "std/string" import { strContains, strIndexOf, strIndexOfFrom, strStartsWith, strEndsWith, strToLower, strToUpper, strTrim, strTrimStart, strTrimEnd, strSplit, strRepeat, strReplace, charIsWhitespace, charIsDigit, charIsAlpha, charIsAlphanumeric, trim }
`, "std/color.milo": `// std/color — ANSI terminal colors and styles

fn red(s: &string): string { return "\\x1b[31m" + s + "\\x1b[0m" }
fn green(s: &string): string { return "\\x1b[32m" + s + "\\x1b[0m" }
fn yellow(s: &string): string { return "\\x1b[33m" + s + "\\x1b[0m" }
fn blue(s: &string): string { return "\\x1b[34m" + s + "\\x1b[0m" }
fn magenta(s: &string): string { return "\\x1b[35m" + s + "\\x1b[0m" }
fn cyan(s: &string): string { return "\\x1b[36m" + s + "\\x1b[0m" }
fn white(s: &string): string { return "\\x1b[37m" + s + "\\x1b[0m" }
fn gray(s: &string): string { return "\\x1b[90m" + s + "\\x1b[0m" }

fn bold(s: &string): string { return "\\x1b[1m" + s + "\\x1b[0m" }
fn dim(s: &string): string { return "\\x1b[2m" + s + "\\x1b[0m" }
fn italic(s: &string): string { return "\\x1b[3m" + s + "\\x1b[0m" }
fn underline(s: &string): string { return "\\x1b[4m" + s + "\\x1b[0m" }
fn strikethrough(s: &string): string { return "\\x1b[9m" + s + "\\x1b[0m" }

fn bgRed(s: &string): string { return "\\x1b[41m" + s + "\\x1b[0m" }
fn bgGreen(s: &string): string { return "\\x1b[42m" + s + "\\x1b[0m" }
fn bgYellow(s: &string): string { return "\\x1b[43m" + s + "\\x1b[0m" }
fn bgBlue(s: &string): string { return "\\x1b[44m" + s + "\\x1b[0m" }
`, "std/crypto.milo": `// std/crypto — cryptographic hash functions
//
// macOS: wraps CommonCrypto (CC_SHA256, CC_MD5)
// Linux: would wrap OpenSSL (SHA256, MD5) — same signatures


extern

fn CC_SHA256(_data: *u8, _len: u32, _md: *u8): *u8

extern

fn CC_MD5(_data: *u8, _len: u32, _md: *u8): *u8

fn _bytesToHex(buf: &[u8 ; 32], n: i64): string {
    var result = ""
    var i: i64 = 0
    while i < n {
        let b = buf[i]
        let hi = b >> 4
        let lo = b & 15
        if hi < 10 {
            result.push(hi + 48)
        } else {
            result.push(hi - 10 + 97)
        }
        if lo < 10 {
            result.push(lo + 48)
        } else {
            result.push(lo - 10 + 97)
        }
        i = i + 1
    }
    return result
}

// Compute SHA-256 hash of a string. Returns 64-char lowercase hex string.

fn sha256(input: &string): string {
    var hash: [u8 ; 32] = [0 ; 32]
    unsafe {
        CC_SHA256(input, input.len as u32, hash)
    }
    return _bytesToHex(hash, 32)
}

// Compute MD5 hash of a string. Returns 32-char lowercase hex string.

fn md5(input: &string): string {
    var hash: [u8 ; 32] = [0 ; 32]
    unsafe {
        CC_MD5(input, input.len as u32, hash)
    }
    return _bytesToHex(hash, 16)
}
`, "std/os.milo": `// std/os — typed libc bindings for Milo

// ── I/O ──

extern

fn read(fd: i32, buf: *u8, nbyte: i64): i64

extern

fn write(fd: i32, buf: *u8, nbyte: i64): i64

extern

fn open(path: *u8, flags: i32,...): i32

extern

fn close(fd: i32): i32

extern

fn lseek(fd: i32, offset: i64, whence: i32): i64

extern

fn fstat(fd: i32, buf: *u8): i32

extern

fn stat(path: *u8, buf: *u8): i32

extern

fn access(path: *u8, mode: i32): i32

extern

fn puts(s: *u8): i32

extern

fn printf(fmt: *u8,...): i32

// ── Memory ──

extern

fn malloc(size: i64): *u8

extern

fn realloc(ptr: *u8, size: i64): *u8

extern

fn free(ptr: *u8): void

extern

fn memcpy(dst: *u8, src: *u8, n: i64): *u8

extern

fn memset(dst: *u8, c: i32, n: i64): *u8

extern

fn memmove(dst: *u8, src: *u8, n: i64): *u8

extern

fn mmap(addr: *u8, len: i64, prot: i32, flags: i32, fd: i32, offset: i64): *u8

extern

fn munmap(addr: *u8, len: i64): i32

// ── Error ──

extern

fn strerror(errnum: i32): *u8

// ── Strings ──

extern

fn strlen(s: *u8): i64

extern

fn strcmp(a: *u8, b: *u8): i32

extern

fn strncmp(a: *u8, b: *u8, n: i64): i32

extern

fn snprintf(buf: *u8, size: i64, fmt: *u8,...): i32

// ── Network ──

extern

fn socket(domain: i32, type: i32, protocol: i32): i32

extern

fn bind(sockfd: i32, addr: &SockAddrIn, addrlen: u32): i32

extern

fn listen(sockfd: i32, backlog: i32): i32

extern

fn accept(sockfd: i32, addr: &mut SockAddrIn, addrlen: &mut u32): i32

extern

fn connect(sockfd: i32, addr: &SockAddrIn, addrlen: u32): i32

extern

fn setsockopt(fd: i32, level: i32, opt: i32, val: &i32, len: u32): i32

extern

fn htons(hostshort: u16): u16

extern

fn ntohs(netshort: u16): u16

extern

fn getsockname(fd: i32, addr: &mut SockAddrIn, addrlen: &mut u32): i32

extern

fn inet_pton(af: i32, src: *u8, dst: *u8): i32

// ── TLS (OpenSSL) ──

extern

fn TLS_client_method(): *u8

extern

fn SSL_CTX_new(method: *u8): *u8

extern

fn SSL_CTX_free(ctx: *u8): void

extern

fn SSL_CTX_set_default_verify_paths(ctx: *u8): i32

extern

fn SSL_new(ctx: *u8): *u8

extern

fn SSL_set_fd(ssl: *u8, fd: i32): i32

extern

fn SSL_connect(ssl: *u8): i32

extern

fn SSL_read(ssl: *u8, buf: *u8, num: i32): i32

extern

fn SSL_write(ssl: *u8, buf: *u8, num: i32): i32

extern

fn SSL_free(ssl: *u8): void

extern

fn SSL_ctrl(ssl: *u8, cmd: i32, larg: i64, parg: *u8): i64

// ── DNS ──

extern

fn getaddrinfo(node: *u8, service: *u8, hints: *u8, res: *u8): i32

extern

fn freeaddrinfo(res: *u8): void

// ── Directory ──

extern

fn opendir(path: *u8): *u8

extern

fn closedir(dir: *u8): i32

extern

fn readdir(dir: *u8): *u8

// ── Process ──

extern

fn exit(status: i32): void

extern

fn getenv(name: *u8): *u8

extern

fn system(cmd: *u8): i32

extern

fn fork(): i32

extern

fn execl(path: *u8,...): i32

extern

fn waitpid(pid: i32, status: *u8, options: i32): i32

extern

fn dup2(oldfd: i32, newfd: i32): i32

extern

fn pipe(fds: *u8): i32

extern

fn kill(pid: i32, sig: i32): i32

// ── pthreads ──

extern

fn pthread_create(thread: *u8, attr: *u8, start: *u8, arg: *u8): i32

extern

fn pthread_join(thread: i64, retval: *u8): i32

extern

fn pthread_mutex_init(mutex: *u8, attr: *u8): i32

extern

fn pthread_mutex_lock(mutex: *u8): i32

extern

fn pthread_mutex_unlock(mutex: *u8): i32

extern

fn pthread_mutex_destroy(mutex: *u8): i32

extern

fn pthread_cond_init(cond: *u8, attr: *u8): i32

extern

fn pthread_cond_wait(cond: *u8, mutex: *u8): i32

extern

fn pthread_cond_signal(cond: *u8): i32

extern

fn pthread_cond_broadcast(cond: *u8): i32

extern

fn pthread_cond_destroy(cond: *u8): i32
`, "std/datetime.milo": `// std/datetime — date/time components and formatting from epoch seconds

from "std/time" import { epochSecs, since }

struct DateTime {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    weekday: i32,
}

fn dateTimeFromEpoch(epochSec: i64): DateTime {
    // days since 1970-01-01
    var secs = epochSec
    let totalDays = secs / 86400
    let daySeconds = secs - totalDays * 86400

    let hour = (daySeconds / 3600) as i32
    let minute = ((daySeconds - (hour as i64) * 3600) / 60) as i32
    let second = (daySeconds - (hour as i64) * 3600 - (minute as i64) * 60) as i32

    // weekday: 1970-01-01 was Thursday (4)
    var wd = ((totalDays + 4) % 7) as i32
    if wd < 0 { wd = wd + 7 }

    // civil date from day count (Hinnant algorithm)
    var z = totalDays + 719468
    var eraInput = z
    if z < 0 { eraInput = z - 146096 }
    let era = eraInput / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    var m = mp + 3
    if mp >= 10 { m = mp - 9 }
    var yr = y
    if m <= 2 { yr = y + 1 }

    return DateTime {
        year: yr as i32, month: m as i32, day: d as i32,
        hour: hour, minute: minute, second: second,
        weekday: wd,
    }
}

fn dateTimeNow(): DateTime {
    return dateTimeFromEpoch(epochSecs())
}

fn dateTimeFormat(dt: &DateTime): string {
    // ISO 8601: 2024-03-15T14:30:00
    var result: string = ""
    result = result + _padI32(dt.year, 4) + "-" + _padI32(dt.month, 2) + "-" + _padI32(dt.day, 2)
    result = result + "T"
    result = result + _padI32(dt.hour, 2) + ":" + _padI32(dt.minute, 2) + ":" + _padI32(dt.second, 2)
    return result
}

fn dateTimeFormatDate(dt: &DateTime): string {
    return _padI32(dt.year, 4) + "-" + _padI32(dt.month, 2) + "-" + _padI32(dt.day, 2)
}

fn dateTimeFormatTime(dt: &DateTime): string {
    return _padI32(dt.hour, 2) + ":" + _padI32(dt.minute, 2) + ":" + _padI32(dt.second, 2)
}

fn weekdayName(wd: i32): string {
    if wd == 0 { return "Sunday" }
    if wd == 1 { return "Monday" }
    if wd == 2 { return "Tuesday" }
    if wd == 3 { return "Wednesday" }
    if wd == 4 { return "Thursday" }
    if wd == 5 { return "Friday" }
    if wd == 6 { return "Saturday" }
    return "Unknown"
}

fn monthName(m: i32): string {
    if m == 1 { return "January" }
    if m == 2 { return "February" }
    if m == 3 { return "March" }
    if m == 4 { return "April" }
    if m == 5 { return "May" }
    if m == 6 { return "June" }
    if m == 7 { return "July" }
    if m == 8 { return "August" }
    if m == 9 { return "September" }
    if m == 10 { return "October" }
    if m == 11 { return "November" }
    if m == 12 { return "December" }
    return "Unknown"
}

fn _padI32(val: i32, width: i32): string {
    var s = format(val)
    while s.len < width as i64 {
        s = "0" + s
    }
    return s
}
`, "std/math.milo": `// std/math — mathematical functions (wraps libm)


// ── libm bindings ──

extern

fn sqrt(x: f64): f64

extern

fn pow(base: f64, exp: f64): f64

extern

fn sin(x: f64): f64

extern

fn cos(x: f64): f64

extern

fn tan(x: f64): f64

extern

fn atan2(y: f64, x: f64): f64

extern

fn floor(x: f64): f64

extern

fn ceil(x: f64): f64

extern

fn round(x: f64): f64

extern

fn fabs(x: f64): f64

extern

fn fmod(x: f64, y: f64): f64

extern

fn log(x: f64): f64

extern

fn log2(x: f64): f64

extern

fn log10(x: f64): f64

extern

fn exp(x: f64): f64

// ── safe wrappers ──

fn mathSqrt(x: f64): f64 {
    unsafe {
        return sqrt(x)
    }
}

fn mathPow(base: f64, exponent: f64): f64 {
    unsafe {
        return pow(base, exponent)
    }
}

fn mathSin(x: f64): f64 {
    unsafe {
        return sin(x)
    }
}

fn mathCos(x: f64): f64 {
    unsafe {
        return cos(x)
    }
}

fn mathTan(x: f64): f64 {
    unsafe {
        return tan(x)
    }
}

fn mathAtan2(y: f64, x: f64): f64 {
    unsafe {
        return atan2(y, x)
    }
}

fn mathFloor(x: f64): f64 {
    unsafe {
        return floor(x)
    }
}

fn mathCeil(x: f64): f64 {
    unsafe {
        return ceil(x)
    }
}

fn mathRound(x: f64): f64 {
    unsafe {
        return round(x)
    }
}

fn mathAbs(x: f64): f64 {
    unsafe {
        return fabs(x)
    }
}

fn mathMod(x: f64, y: f64): f64 {
    unsafe {
        return fmod(x, y)
    }
}

fn mathLog(x: f64): f64 {
    unsafe {
        return log(x)
    }
}

fn mathLog2(x: f64): f64 {
    unsafe {
        return log2(x)
    }
}

fn mathLog10(x: f64): f64 {
    unsafe {
        return log10(x)
    }
}

fn mathExp(x: f64): f64 {
    unsafe {
        return exp(x)
    }
}

// ── integer helpers ──

fn absI64(x: i64): i64 {
    if x < 0 {
        return 0 - x
    }
    return x
}

fn absI32(x: i32): i32 {
    if x < 0 as i32 {
        return 0 as i32 - x
    }
    return x
}

fn minI64(a: i64, b: i64): i64 {
    if a < b {
        return a
    }
    return b
}

fn maxI64(a: i64, b: i64): i64 {
    if a > b {
        return a
    }
    return b
}

fn minI32(a: i32, b: i32): i32 {
    if a < b {
        return a
    }
    return b
}

fn maxI32(a: i32, b: i32): i32 {
    if a > b {
        return a
    }
    return b
}

fn minF64(a: f64, b: f64): f64 {
    if a < b {
        return a
    }
    return b
}

fn maxF64(a: f64, b: f64): f64 {
    if a > b {
        return a
    }
    return b
}

fn clampI64(x: i64, lo: i64, hi: i64): i64 {
    if x < lo {
        return lo
    }
    if x > hi {
        return hi
    }
    return x
}

fn clampF64(x: f64, lo: f64, hi: f64): f64 {
    if x < lo {
        return lo
    }
    if x > hi {
        return hi
    }
    return x
}

// ── constants ──

fn mathPi(): f64 {
    return 3.14159265358979323846
}

fn mathE(): f64 {
    return 2.71828182845904523536
}

fn mathInf(): f64 {
    return 1.0 / 0.0
}
`, "std/testing.milo": `// std/testing — test assertion functions

from "std/os" import { exit }

fn _testFail(): void {
    unsafe { exit(1) }
}

fn assert(cond: bool): void {
    if !cond {
        eprint("  assertion failed")
        _testFail()
    }
}

fn assertMsg(cond: bool, msg: string): void {
    if !cond {
        eprint($"  assertion failed: {msg}")
        _testFail()
    }
}

fn assertEqual(got: i32, expected: i32): void {
    if got != expected {
        eprint($"  assertEqual failed: got {got}, expected {expected}")
        _testFail()
    }
}

fn assertEqual64(got: i64, expected: i64): void {
    if got != expected {
        eprint($"  assertEqual64 failed: got {got}, expected {expected}")
        _testFail()
    }
}

fn assertStrEqual(got: &string, expected: &string): void {
    if got != expected {
        eprint("  assertStrEqual failed")
        _testFail()
    }
}

fn assertBool(got: bool, expected: bool): void {
    if got != expected {
        eprint("  assertBool failed")
        _testFail()
    }
}
`, "std/thread.milo": `// std/thread — OS thread spawning and joining via pthreads

from "std/os" import { free, malloc, memcpy, pthread_create, pthread_join }
from "std/time" import { sleepMs }

// Handle to a spawned OS thread.

struct Thread {
    id: i64,
}

// Spawn a new OS thread running the given function.
// The function receives a *u8 argument for passing data.
// The caller must ensure the pointed-to data outlives the thread.
//
//   fn worker(arg: *u8): *u8 { ... }
//   var data: i64 = 42
//   let t = threadSpawn(worker as *u8, (&data) as *u8)!
//   threadJoin(t)!

fn threadSpawn(func: *u8, arg: *u8): Result<Thread> {
    var tid: i64 = 0
    unsafe {
        let r = pthread_create((&tid) as *u8, 0 as *u8, func, arg)
        if r != 0 {
            return Result.Err("pthread_create failed")
        }
    }
    return Result.Ok(Thread { id: tid })
}

// Spawn a thread running a no-arg function (convenience wrapper).
//
//   fn work(arg: *u8): *u8 { print("hi"); return 0 as *u8 }
//   let t = threadSpawnFn(work)!

fn threadSpawnFn(func: (*u8) => *u8): Result<Thread> {
    unsafe {
        return threadSpawn(func as *u8, 0 as *u8)
    }
}

// Block until the thread finishes.

fn threadJoin(t: &Thread): Result<i32> {
    unsafe {
        let r = pthread_join(t.id, 0 as *u8)
        if r != 0 {
            return Result.Err("pthread_join failed")
        }
        return Result.Ok(0)
    }
}

// ── Safe spawn with move closures ──
// The closure's captures are heap-allocated (by move semantics) and
// passed to the thread via the pthread arg pointer. No unsafe needed
// by the caller.
//
//   let offset: i64 = 10
//   let t = spawn(move (): void => {
//       print($"offset is {offset}")
//   })!
//   threadJoin(t)!

// trampoline: receives packed { fnPtr, envPtr } via pthread arg
fn _closureTrampoline(arg: *u8): *u8 {
    unsafe {
        let base = arg as i64
        var fnPtr: *u8 = 0 as *u8
        var envPtr: *u8 = 0 as *u8
        memcpy((&fnPtr) as *u8, arg, 8)
        memcpy((&envPtr) as *u8, (base + 8) as *u8, 8)
        _callClosureVoid(fnPtr, envPtr)
        // free the packed struct (closure env is freed by drop glue or leaks — acceptable for threads)
        free(arg)
        return 0 as *u8
    }
}

fn spawn(f: () => void): Result<Thread> {
    unsafe {
        // f is { ptr fnPtr, ptr envPtr } — pack both into a heap block for the trampoline
        let packed = malloc(16)
        // extract fn ptr and env ptr from closure tuple
        // the closure is passed as two ptr args; we need the raw values
        let fPtr = f as *u8
        // for the env, we need the second element of the tuple
        // _closurePairEnv is a builtin that extracts element 1
        // ... actually, f is a { ptr, ptr } passed as a parameter.
        // When f is a fn param, it's stored as { ptr, ptr } in an alloca.
        // We need to extract both elements.
        // Let's just pass f's alloca address — it already contains { fnPtr, envPtr }
        memcpy(packed, (&f) as *u8, 16)
        let t = threadSpawn(_closureTrampoline as *u8, packed)
        return t
    }
}

// Sleep the current thread for the given number of milliseconds.

fn threadSleep(ms: i64): void {
    sleepMs(ms)
}
`, "std/uuid.milo": `// std/uuid — UUID v4 generation (random, RFC 4122)

from "std/random" import { arc4random_buf }

fn _byteToHex(b: u8): string {
    var s = ""
    s.push(_hexChar(b >> 4))
    s.push(_hexChar(b & 15 as u8))
    return s
}

// Generate a random UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000").

fn uuidV4(): string {
    var buf: [u8; 16] = [0 as u8; 16]
    unsafe { arc4random_buf(buf as *u8, 16) }

    // version 4: high nibble of byte 6 = 0100
    buf[6] = (buf[6] & 0x0f as u8) | 0x40 as u8
    // variant 1: high bits of byte 8 = 10
    buf[8] = (buf[8] & 0x3f as u8) | 0x80 as u8

    var s = ""
    s = s + _byteToHex(buf[0]) + _byteToHex(buf[1]) + _byteToHex(buf[2]) + _byteToHex(buf[3])
    s = s + "-"
    s = s + _byteToHex(buf[4]) + _byteToHex(buf[5])
    s = s + "-"
    s = s + _byteToHex(buf[6]) + _byteToHex(buf[7])
    s = s + "-"
    s = s + _byteToHex(buf[8]) + _byteToHex(buf[9])
    s = s + "-"
    s = s + _byteToHex(buf[10]) + _byteToHex(buf[11]) + _byteToHex(buf[12])
    s = s + _byteToHex(buf[13]) + _byteToHex(buf[14]) + _byteToHex(buf[15])
    return s
}
`, "std/argparse.milo": `// std/argparse — command-line argument parser with auto-generated help
from "std/args" import {
    args
}

struct FlagDef {
    longName: string,
    shortName: string,
    help: string,
    defaultVal: string,
    isBool: bool,
    required: bool,
}

struct PositionalDef {
    name: string,
    help: string,
    required: bool,
}

// Declarative command-line argument parser with auto-generated --help.
// Create with newParser(), add flags with addString/addBool/addRequired,
// then call .parse() to get a ParsedArgs.

struct ArgParser {
    name: string,
    description: string,
    usage: string,
    flags: Vec<FlagDef>,
    positionals: Vec<PositionalDef>,
}

// Parsed command-line arguments.
// Access values with .getString(), .getI64(), .getU16(), .getBool().
// Check presence with .has(). Positional args in .positional field.

struct ParsedArgs {
    prog: string,
    entries: Vec<ArgEntry>,
    positional: Vec<string>,
}

struct ArgEntry {
    name: string,
    value: string,
    present: bool,
}

// Create a new argument parser with a program name and description.

fn newParser(name: string, description: string): ArgParser {
    return ArgParser {
        name: name,
        description: description,
        usage: "",
        flags: Vec.new(),
        positionals: Vec.new(),
    }
}

impl ArgParser {
    // Add a string flag with long name, short alias, help text, and default.
    // Example: parser.addString("output", "o", "Output file", "out.txt")
    fn addString(self: &mut Self, long: string, short: string, help: string, defaultVal: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: defaultVal,
            isBool: false,
            required: false,
        }
        )
    }

    // Add a required string flag. parse() exits with error if missing.
    fn addRequired(self: &mut Self, long: string, short: string, help: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: "",
            isBool: false,
            required: true,
        }
        )
    }

    // Add a boolean flag (present = true, absent = false).
    fn addBool(self: &mut Self, long: string, short: string, help: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: "",
            isBool: true,
            required: false,
        }
        )
    }

    // Add a required positional argument.
    fn addPositional(self: &mut Self, name: string, help: string): void {
        self.positionals.push(PositionalDef {
            name: name, help: help, required: true
        }
        )
    }

    // Add an optional positional argument.
    fn addOptionalPositional(self: &mut Self, name: string, help: string): void {
        self.positionals.push(PositionalDef {
            name: name, help: help, required: false
        }
        )
    }

    // Generate formatted help text for all registered flags.
    fn helpText(self: &Self): string {
        var text: string = self.name + " - " + self.description + "\\n\\n"
        if self.usage.len > 0 {
            text = text + "usage: " + self.usage + "\\n\\n"
        } else {
            var usageLine: string = "usage: " + self.name + " [options]"
            var pi: i64 = 0
            while pi < self.positionals.len {
                if self.positionals[pi].required {
                    usageLine = usageLine + " <" + self.positionals[pi].name + ">"
                } else {
                    usageLine = usageLine + " [" + self.positionals[pi].name + "]"
                }
                pi = pi + 1
            }
            text = text + usageLine + "\\n\\n"
        }
        if self.positionals.len > 0 {
            text = text + "arguments:\\n"
            var pi2: i64 = 0
            while pi2 < self.positionals.len {
                var pline: string = "  <" + self.positionals[pi2].name + ">"
                while pline.len < 30 {
                    pline = pline + " "
                }
                pline = pline + self.positionals[pi2].help
                text = text + pline + "\\n"
                pi2 = pi2 + 1
            }
            text = text + "\\n"
        }

        text = text + "options:\\n"
        var i: i64 = 0
        while i < self.flags.len {
            var fline: string = "  "
            if self.flags[i].shortName.len > 0 {
                fline = fline + "-" + self.flags[i].shortName + ", "
            } else {
                fline = fline + "    "
            }
            fline = fline + "--" + self.flags[i].longName
            if !self.flags[i].isBool {
                fline = fline + " <value>"
            }
            while fline.len < 30 {
                fline = fline + " "
            }
            fline = fline + self.flags[i].help
            if !self.flags[i].isBool && self.flags[i].defaultVal.len > 0 {
                fline = fline + " (default: " + self.flags[i].defaultVal + ")"
            }
            if self.flags[i].required {
                fline = fline + " (required)"
            }
            text = text + fline + "\\n"
            i = i + 1
        }
        text = text + "  -h, --help                  Show this help message\\n"
        return text
    }

    // Parse command-line arguments and return ParsedArgs.
    // Automatically handles --help. Exits on invalid input.
    fn parse(self: &Self): ParsedArgs {
        let argv = args()
        var result = ParsedArgs {
            prog: self.name.clone(),
            entries: Vec.new(),
            positional: Vec.new(),
        }

        // initialize flag entries with defaults
        var fi: i64 = 0
        while fi < self.flags.len {
            result.entries.push(ArgEntry {
                name: self.flags[fi].longName.clone(),
                value: self.flags[fi].defaultVal.clone(),
                present: false,
            }
            )
            fi = fi + 1
        }

        // initialize positional entries
        var pi: i64 = 0
        while pi < self.positionals.len {
            result.entries.push(ArgEntry {
                name: self.positionals[pi].name.clone(),
                value: "",
                present: false,
            }
            )
            pi = pi + 1
        }

        var posIdx: i64 = 0
        var i: i64 = 1
        while i < argv.len {
            let arg = argv[i]

            if arg == "--help" || arg == "-h" {
                print(self.helpText())
                unsafe {
                    exit(0)
                }
            }

            if arg.len >= 2 && arg[0] == 45 {
                var matched: bool = false
                var fi2: i64 = 0
                while fi2 < self.flags.len {
                    let longFlag = "--" + self.flags[fi2].longName
                    var isMatch: bool = false
                    if arg == longFlag {
                        isMatch = true
                    }
                    if self.flags[fi2].shortName.len > 0 {
                        let shortFlag = "-" + self.flags[fi2].shortName
                        if arg == shortFlag {
                            isMatch = true
                        }
                    }

                    if isMatch {
                        matched = true
                        if self.flags[fi2].isBool {
                            result.entries[fi2] = ArgEntry {
                                name: self.flags[fi2].longName.clone(),
                                value: "true",
                                present: true,
                            }
                        } else {
                            if i + 1 >= argv.len {
                                print($"error: --{self.flags[fi2].longName} requires a value\\n\\n{self.helpText()}")
                                unsafe {
                                    exit(1)
                                }
                            }
                            i = i + 1
                            result.entries[fi2] = ArgEntry {
                                name: self.flags[fi2].longName.clone(),
                                value: argv[i].clone(),
                                present: true,
                            }
                        }
                    }
                    fi2 = fi2 + 1
                }

                if !matched {
                    print($"error: unknown flag '{arg}'\\n\\n{self.helpText()}")
                    unsafe {
                        exit(1)
                    }
                }
            } else {
                result.positional.push(arg.clone())
                // map to named positional entry
                if posIdx < self.positionals.len {
                    let entryIdx = self.flags.len + posIdx
                    result.entries[entryIdx] = ArgEntry {
                        name: self.positionals[posIdx].name.clone(),
                        value: arg.clone(),
                        present: true,
                    }
                    posIdx = posIdx + 1
                }
            }

            i = i + 1
        }

        // validate required flags
        var ri: i64 = 0
        while ri < self.flags.len {
            if self.flags[ri].required && !result.entries[ri].present {
                print($"error: --{self.flags[ri].longName} is required\\n\\n{self.helpText()}")
                unsafe {
                    exit(1)
                }
            }
            ri = ri + 1
        }

        // validate required positionals
        var rp: i64 = 0
        while rp < self.positionals.len {
            if self.positionals[rp].required {
                let entryIdx = self.flags.len + rp
                if !result.entries[entryIdx].present {
                    print($"error: missing required argument <{self.positionals[rp].name}>\\n\\n{self.helpText()}")
                    unsafe {
                        exit(1)
                    }
                }
            }
            rp = rp + 1
        }

        return result
    }
}

// ── integer parsing helper ──

fn _argparseParseI64(s: &string): i64 {
    var result: i64 = 0
    var neg: bool = false
    var i: i64 = 0
    if s.len > 0 && s[0] == 45 {
        neg = true
        i = 1
    }
    while i < s.len {
        let d = s[i]as i64 - 48
        result = result * 10 + d
        i = i + 1
    }
    if neg {
        return 0 - result
    }
    return result
}

fn _argparseIsNumeric(s: &string): bool {
    var i: i64 = 0
    if s.len == 0 {
        return false
    }
    if s[0] == 45 {
        i = 1
    }
    if i >= s.len {
        return false
    }
    while i < s.len {
        let c = s[i]
        if c < 48 || c > 57 {
            return false
        }
        i = i + 1
    }
    return true
}

impl ParsedArgs {
    // Get the string value of a flag by its long name.
    fn getString(self: &Self, name: &string): string {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name {
                return self.entries[i].value.clone()
            }
            i = i + 1
        }
        return ""
    }

    // Get an integer value of a flag. Exits if the value is not numeric.
    fn getI64(self: &Self, name: &string): i64 {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name {
                let val = self.entries[i].value.clone()
                if !_argparseIsNumeric(val) {
                    print($"error: --{name}: expected integer, got '{val}'")
                    unsafe {
                        exit(1)
                    }
                }
                return _argparseParseI64(val)
            }
            i = i + 1
        }
        print($"error: --{name}: unknown flag")
        unsafe {
            exit(1)
        }
        return 0
    }

    // Get a u16 value of a flag. Exits if out of range 0..65535.
    fn getU16(self: &Self, name: &string): u16 {
        let val = self.getI64(name)
        if val < 0 || val > 65535 {
            print($"error: --{name}: value {val} out of range 0..65535")
            unsafe {
                exit(1)
            }
        }
        return val as u16
    }

    // Check if a boolean flag was set.
    fn getBool(self: &Self, name: &string): bool {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name && self.entries[i].present {
                return true
            }
            i = i + 1
        }
        return false
    }

    // Check if a flag was provided on the command line.
    fn has(self: &Self, name: &string): bool {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name && self.entries[i].present {
                return true
            }
            i = i + 1
        }
        return false
    }
}
`, "std/base64.milo": `// std/base64 — base64 encode/decode

fn _b64EncodeChar(val: u8): u8 {
    if val < 26 {
        return val + 65
    }
    if val < 52 {
        return val - 26 + 97
    }
    if val < 62 {
        return val - 52 + 48
    }
    if val == 62 {
        return 43
    }
    return 47
}

fn _b64DecodeChar(ch: u8): u8 {
    if ch >= 65 && ch <= 90 {
        return ch - 65
    }
    if ch >= 97 && ch <= 122 {
        return ch - 97 + 26
    }
    if ch >= 48 && ch <= 57 {
        return ch - 48 + 52
    }
    if ch == 43 {
        return 62
    }
    if ch == 47 {
        return 63
    }
    return 0
}

// Encode a string to base64.

fn base64Encode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 2 < input.len {
        let a = input[i]
        let b = input[i + 1]
        let c = input[i + 2]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar(((a & 3) << 4) | (b >> 4)))
        result.push(_b64EncodeChar(((b & 15) << 2) | (c >> 6)))
        result.push(_b64EncodeChar(c & 63))
        i = i + 3
    }
    let remaining = input.len - i
    if remaining == 2 {
        let a = input[i]
        let b = input[i + 1]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar(((a & 3) << 4) | (b >> 4)))
        result.push(_b64EncodeChar((b & 15) << 2))
        result.push(61 as u8)
    }
    if remaining == 1 {
        let a = input[i]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar((a & 3) << 4))
        result.push(61 as u8)
        result.push(61 as u8)
    }
    return result
}

// Decode a base64 string.

fn base64Decode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 3 < input.len {
        if input[i] == 61 {
            break
        }
        let a = _b64DecodeChar(input[i])
        let b = _b64DecodeChar(input[i + 1])
        let c = _b64DecodeChar(input[i + 2])
        let d = _b64DecodeChar(input[i + 3])
        result.push((a << 2) | (b >> 4))
        if input[i + 2] != 61 {
            result.push(((b & 15) << 4) | (c >> 2))
        }
        if input[i + 3] != 61 {
            result.push(((c & 3) << 6) | d)
        }
        i = i + 4
    }
    return result
}
`, "std/process.milo": `// std/process — command execution and process control

from "std/os" import { execl, exit, fork, kill, read, system, waitpid }
from "std/io" import { readFile }

// ── Simple command execution ──

// Execute a shell command and return its exit code.
// Example: let code = run("ls -la")!

fn run(cmd: &string): Result<i32> {
    unsafe {
        let status = system(cmd)
        if status < 0 {
            return Result.Err("system() failed")
        }
        // macOS: exit code is in bits 8-15
        let exitCode = (status >> 8) & 255
        return Result.Ok(exitCode)
    }
}

// ── Process with lifecycle management ──

// Handle to a spawned child process.

struct Process {
    pid: i32,
}

// Fork and exec a program at the given path.
// Returns a Process handle for lifecycle management.

fn spawn(path: &string): Result<Process> {
    unsafe {
        let pid = fork()
        if pid < 0 {
            return Result.Err("fork() failed")
        }
        if pid == 0 {
            execl(path, path, 0 as *u8)
            exit(127)
        }
        return Result.Ok(Process {
            pid: pid
        }
        )
    }
}

// Block until the process exits and return its exit code.

fn waitFor(p: &Process): Result<i32> {
    var statusBuf: [u8 ; 4] = [0 ; 4]
    unsafe {
        let r = waitpid(p.pid, statusBuf, 0)
        if r < 0 {
            return Result.Err("waitpid() failed")
        }
        let raw = (statusBuf[1]as i32)
        return Result.Ok(raw)
    }
}

// Execute a shell command and return its stdout as a string.
// Uses shell redirection to a temp file under the hood.

fn capture(cmd: &string): Result<string> {
    let tmpPath: string = "/tmp/.milo_capture"
    let fullCmd = cmd + " > " + tmpPath + " 2>&1"
    let code = run(fullCmd)!
    if code != 0 {
        return Result.Err("command failed with exit code")
    }
    let content = readFile(tmpPath)
    match content {
        Result.Ok(s) => {
            return Result.Ok(s)
        }
        Result.Err(e) => {
            return Result.Err("failed to read capture output")
        }
    }
}

// Send a signal to the process (e.g., 9 for SIGKILL, 15 for SIGTERM).

fn signal(p: &Process, sig: i32): Result<i32> {
    unsafe {
        let r = kill(p.pid, sig)
        if r < 0 {
            return Result.Err("kill() failed")
        }
        return Result.Ok(0)
    }
}
`, "std/sort.milo": `// std/sort — in-place sorting for Vec types

// Sort Vec<i64> in ascending order.

fn sortI64(v: &mut Vec<i64>): void {
    _qsortI64(v, 0, v.len - 1)
}

// Sort Vec<i32> in ascending order.

fn sortI32(v: &mut Vec<i32>): void {
    _qsortI32(v, 0 as i32, (v.len - 1) as i32)
}

// Sort Vec<string> in lexicographic order.

fn sortStrings(v: &mut Vec<string>): void {
    _isortStrings(v, 0, v.len - 1)
}

// Reverse a Vec<i64> in place.

fn reverseI64(v: &mut Vec<i64>): void {
    var lo: i64 = 0
    var hi = v.len - 1
    while lo < hi {
        let tmp = v[lo]
        v[lo] = v[hi]
        v[hi] = tmp
        lo = lo + 1
        hi = hi - 1
    }
}

// ── quicksort i64 ──

fn _qsortI64(v: &mut Vec<i64>, lo: i64, hi: i64): void {
    if lo >= hi {
        return
    }
    let pivot = v[hi]
    var i = lo
    var j = lo
    while j < hi {
        if v[j] <= pivot {
            let tmp = v[i]
            v[i] = v[j]
            v[j] = tmp
            i = i + 1
        }
        j = j + 1
    }
    let tmp = v[i]
    v[i] = v[hi]
    v[hi] = tmp
    _qsortI64(v, lo, i - 1)
    _qsortI64(v, i + 1, hi)
}

// ── quicksort i32 ──

fn _qsortI32(v: &mut Vec<i32>, lo: i32, hi: i32): void {
    if lo >= hi {
        return
    }
    let pivot = v[hi]
    var i = lo
    var j = lo
    while j < hi {
        if v[j] <= pivot {
            let tmp = v[i]
            v[i] = v[j]
            v[j] = tmp
            i = i + 1 as i32
        }
        j = j + 1 as i32
    }
    let tmp = v[i]
    v[i] = v[hi]
    v[hi] = tmp
    _qsortI32(v, lo, i - 1 as i32)
    _qsortI32(v, i + 1 as i32, hi)
}

// ── insertion sort for strings (stable, good for small n) ──

fn _strLessThan(a: &string, b: &string): bool {
    var i: i64 = 0
    while i < a.len && i < b.len {
        if a[i] < b[i] {
            return true
        }
        if a[i] > b[i] {
            return false
        }
        i = i + 1
    }
    return a.len < b.len
}

fn _isortStrings(v: &mut Vec<string>, lo: i64, hi: i64): void {
    if lo >= hi {
        return
    }
    var i = lo + 1
    while i <= hi {
        let key = v[i].clone()
        var j = i - 1
        while j >= lo {
            if _strLessThan(key, v[j]) {
                v[j + 1] = v[j].clone()
                j = j - 1
            } else {
                break
            }
        }
        v[j + 1] = key
        i = i + 1
    }
}
`, "std/net.milo": `// std/net — TCP, DNS, HTTP client with automatic cleanup

from "std/os" import { SSL_CTX_free, SSL_CTX_new, SSL_CTX_set_default_verify_paths, SSL_connect, SSL_ctrl, SSL_free, SSL_new, SSL_read, SSL_set_fd, SSL_write, TLS_client_method, close, connect, freeaddrinfo, getaddrinfo, read, socket, write }
from "std/platform" import { SockAddrIn, addrinfoAddrOffset, makeSockaddr }
from "std/json" import { Json, jsonParse }

// ── NetError ──

enum NetError {
    DnsFailure(string),
    ConnectionFailed(string),
    TlsError(string),
    SendFailed(string),
    Other(string),
}

// ── TcpStream ──

// TCP connection handle. Automatically closes the fd when dropped.

struct TcpStream {
    fd: i32,
}

impl Drop for TcpStream {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

// Construct an IPv4 address from four octets.
// Example: ip4(127, 0, 0, 1) for localhost.

fn ip4(a: u8, b: u8, c: u8, d: u8): u32 {
    let a32 = a as u32
    let b32 = b as u32
    let c32 = c as u32
    let d32 = d as u32
    return a32 | (b32 << 8) | (c32 << 16) | (d32 << 24)
}

fn tcpConnect(ip: u32, port: u16): Result<TcpStream, NetError> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let SIZEOF_SOCKADDR_IN: u32 = 16

    unsafe {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return Result.Err(NetError.ConnectionFailed("socket() failed"))
        }

        var addr = makeSockaddr(port, ip)

        if connect(fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            close(fd)
            return Result.Err(NetError.ConnectionFailed("connect() failed"))
        }

        return Result.Ok(TcpStream {
            fd: fd
        }
        )
    }
}

fn tcpSend(s: &TcpStream, data: &string): Result<i64, NetError> {
    unsafe {
        let n = write(s.fd, data, data.len)
        if n < 0 {
            return Result.Err(NetError.SendFailed("tcp send failed"))
        }
        return Result.Ok(n)
    }
}

fn tcpRecv(s: &TcpStream): Result<string, NetError> {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(s.fd, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

// ── TLS Stream ──

// TLS/SSL connection handle. Frees SSL context and closes fd on drop.

struct TlsStream {
    fd: i32,
    ssl: i64,
    ctx: i64,
}

impl Drop for TlsStream {
    fn drop(self: &mut Self): void {
        unsafe {
            if self.ssl != 0 {
                SSL_free(self.ssl as *u8)
            }
            if self.ctx != 0 {
                SSL_CTX_free(self.ctx as *u8)
            }
            if self.fd >= 0 {
                close(self.fd)
            }
        }
    }
}

fn tlsConnect(ip: u32, port: u16, hostname: &string): Result<TlsStream, NetError> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let SIZEOF_SOCKADDR_IN: u32 = 16

    unsafe {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return Result.Err(NetError.ConnectionFailed("socket() failed"))
        }

        var addr = makeSockaddr(port, ip)

        if connect(fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            close(fd)
            return Result.Err(NetError.ConnectionFailed("connect() failed"))
        }

        let method = TLS_client_method()
        let ctx = SSL_CTX_new(method)
        let ctxAddr = ctx as i64
        if ctxAddr == 0 {
            close(fd)
            return Result.Err(NetError.TlsError("SSL_CTX_new failed"))
        }
        SSL_CTX_set_default_verify_paths(ctx)

        let ssl = SSL_new(ctx)
        let sslAddr = ssl as i64
        if sslAddr == 0 {
            SSL_CTX_free(ctx)
            close(fd)
            return Result.Err(NetError.TlsError("SSL_new failed"))
        }

        // SNI hostname for certificate validation
        SSL_ctrl(ssl, 55, 0, hostname)
        SSL_set_fd(ssl, fd)

        let r = SSL_connect(ssl)
        if r != 1 {
            SSL_free(ssl)
            SSL_CTX_free(ctx)
            close(fd)
            return Result.Err(NetError.TlsError("SSL handshake failed"))
        }

        return Result.Ok(TlsStream {
            fd: fd, ssl: sslAddr, ctx: ctxAddr
        }
        )
    }
}

fn tlsSend(s: &TlsStream, data: &string): Result<i64, NetError> {
    unsafe {
        let n = SSL_write(s.ssl as *u8, data, data.len as i32)
        if n < 0 {
            return Result.Err(NetError.SendFailed("SSL_write failed"))
        }
        return Result.Ok(n as i64)
    }
}

fn tlsRecv(s: &TlsStream): Result<string, NetError> {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = SSL_read(s.ssl as *u8, buf as *u8, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n as i64 {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

// ── DNS ──

fn resolve(hostname: &string): Result<u32, NetError> {
    var hints: [u8 ; 48] = [0 ; 48]
    unsafe {
        let hintsFamily = (hints as *i32)
        hintsFamily[1] = 2
        hintsFamily[2] = 1
    }

    var resBuf: [u8 ; 8] = [0 ; 8]
    unsafe {
        let err = getaddrinfo(hostname, 0 as *u8, hints as *u8, resBuf as *u8)
        if err != 0 {
            return Result.Err(NetError.DnsFailure(hostname.clone()))
        }
        let infoPtr =*(resBuf as *i64)
        let addrPtr =*((infoPtr + addrinfoAddrOffset()) as *i64)
        let ip =*((addrPtr + 4) as *u32)
        freeaddrinfo(infoPtr as *u8)
        return Result.Ok(ip)
    }
}

// ── HTTP Response ──

// HTTP response with status code, headers, and body.

struct Response {
    status: i32,
    headers: string,
    body: string,
}

impl Response {
    // Return the response body as a string.
    fn text(self: &Self): string {
        return self.body.clone()
    }

    // Parse the response body as JSON.
    fn json(self: &Self): Json {
        return jsonParse(self.body.clone())
    }

    // Return true if the status code is 2xx (success).
    fn ok(self: &Self): bool {
        return self.status >= 200 && self.status < 300
    }

    // Look up a response header by name (case-insensitive).
    fn header(self: &Self, name: &string): string {
        return findHeader(self.headers, name)
    }
}

// ── String helpers ──

fn strEqNocase(a: &string, ai: i64, b: &string, blen: i64): bool {
    var i: i64 = 0
    while i < blen {
        var ca: u8 = a[ai + i]
        var cb: u8 = b[i]
        // lowercase ASCII
        if ca >= 'A' && ca <= 'Z' {
            ca = ca + 32
        }
        if cb >= 'A' && cb <= 'Z' {
            cb = cb + 32
        }
        if ca != cb {
            return false
        }
        i = i + 1
    }
    return true
}

fn findHeader(headers: &string, name: &string): string {
    // search for "Name: value" in headers (case-insensitive name match)
    var i: i64 = 0
    while i + name.len + 1 < headers.len {
        // check if we're at line start (i==0 or preceded by \\n)
        if i == 0 || headers[i - 1] == '\\n' {
            if strEqNocase(headers, i, name, name.len) && headers[i + name.len] == ':' {
                var start: i64 = i + name.len + 1
                // skip spaces after colon
                while start < headers.len && headers[start] == ' ' {
                    start = start + 1
                }
                var end: i64 = start
                while end < headers.len && headers[end] != '\\r' && headers[end] != '\\n' {
                    end = end + 1
                }
                return headers[start..end]
            }
        }
        i = i + 1
    }
    return ""
}

fn startsWith(s: &string, prefix: &string): bool {
    if s.len < prefix.len {
        return false
    }
    var i: i64 = 0
    while i < prefix.len {
        if s[i] != prefix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

fn hexDigit(c: u8): i64 {
    if c >= '0' && c <= '9' {
        return (c - '0') as i64
    }
    if c >= 'a' && c <= 'f' {
        return (c - 'a') as i64 + 10
    }
    if c >= 'A' && c <= 'F' {
        return (c - 'A') as i64 + 10
    }
    return - 1 as i64
}

// ── HTTP parsing ──

fn parseStatus(raw: &string): i32 {
    if raw.len < 12 {
        return 0
    }
    var code: i32 = 0
    var i: i64 = 9
    while i < raw.len && raw[i] >= '0' && raw[i] <= '9' {
        code = code * 10 + (raw[i]as i32 - 48)
        i = i + 1
    }
    return code
}

fn parseRawHeaders(raw: &string): string {
    var start: i64 = 0
    var i: i64 = 0
    while i + 1 < raw.len {
        if raw[i] == '\\r' && raw[i + 1] == '\\n' {
            if start == 0 {
                start = i + 2
            }
            if i + 3 < raw.len && raw[i + 2] == '\\r' && raw[i + 3] == '\\n' {
                return raw[start..i]
            }
        }
        i = i + 1
    }
    return ""
}

fn parseBody(raw: &string): string {
    var i: i64 = 0
    while i + 3 < raw.len {
        if raw[i] == '\\r' && raw[i + 1] == '\\n' && raw[i + 2] == '\\r' && raw[i + 3] == '\\n' {
            return raw[i + 4..raw.len]
        }
        i = i + 1
    }
    return raw.clone()
}

fn decodeChunked(rawBody: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < rawBody.len {
        // parse hex chunk size
        var chunkSize: i64 = 0
        while i < rawBody.len {
            let d = hexDigit(rawBody[i])
            if d < 0 {
                break
            }
            chunkSize = chunkSize * 16 + d
            i = i + 1
        }
        // skip \\r\\n after size
        if i + 1 < rawBody.len && rawBody[i] == '\\r' {
            i = i + 2
        }
        if chunkSize == 0 {
            break
        }
        // copy chunk data
        var j: i64 = 0
        while j < chunkSize && i < rawBody.len {
            result.push(rawBody[i])
            i = i + 1
            j = j + 1
        }
        // skip trailing \\r\\n
        if i + 1 < rawBody.len && rawBody[i] == '\\r' {
            i = i + 2
        }
    }
    return result
}

fn parseResponse(raw: string): Response {
    let status = parseStatus(raw)
    let headers = parseRawHeaders(raw)
    var body = parseBody(raw)
    // handle chunked transfer encoding
    let te = findHeader(headers, "Transfer-Encoding")
    let chunked: string = "chunked"
    if startsWith(te, chunked) {
        body = decodeChunked(body)
    }
    return Response {
        status: status, headers: headers, body: body
    }
}

// ── URL parsing ──

fn isHttps(url: &string): bool {
    return url.len > 8 && url[0] == 'h' && url[4] == 's' && url[5] == ':' && url[6] == '/' && url[7] == '/'
}

fn schemeOffset(url: &string): i64 {
    if isHttps(url) {
        return 8
    }
    if url.len > 7 && url[0] == 'h' && url[4] == ':' && url[5] == '/' && url[6] == '/' {
        return 7
    }
    return 0
}

fn parseHost(url: &string): string {
    let start = schemeOffset(url)
    var end: i64 = start
    while end < url.len && url[end] != '/' && url[end] != ':' {
        end = end + 1
    }
    return url[start..end]
}

fn parsePort(url: &string): u16 {
    var i: i64 = schemeOffset(url)
    while i < url.len && url[i] != '/' && url[i] != ':' {
        i = i + 1
    }
    if i < url.len && url[i] == ':' {
        i = i + 1
        var port: i32 = 0
        while i < url.len && url[i] >= '0' && url[i] <= '9' {
            port = port * 10 + (url[i]as i32 - 48)
            i = i + 1
        }
        return port as u16
    }
    if isHttps(url) {
        return 443
    }
    return 80
}

fn parsePath(url: &string): string {
    var i: i64 = schemeOffset(url)
    while i < url.len && url[i] != '/' {
        i = i + 1
    }
    if i >= url.len {
        return "/"
    }
    return url[i..url.len]
}

// ── FetchOptions ──

// HTTP request configuration: method, headers, and body.

struct FetchOptions {
    method: string,
    headers: string,
    body: string,
}

// ── HTTP client ──

fn httpDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError> {
    let stream = tcpConnect(ip, port)?
    var req: string = opts.method.clone() + " " + path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n"
    if opts.headers.len > 0 {
        req = req + opts.headers.clone() + "\\r\\n"
    }
    if opts.body.len > 0 {
        req = req + "Content-Length: " + opts.body.len.toString() + "\\r\\n\\r\\n" + opts.body.clone()
    } else {
        req = req + "\\r\\n"
    }
    tcpSend(stream, req)?
    let raw = tcpRecv(stream)?
    return Result.Ok(parseResponse(raw))
}

fn httpsDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError> {
    let stream = tlsConnect(ip, port, host)?
    var req: string = opts.method.clone() + " " + path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n"
    if opts.headers.len > 0 {
        req = req + opts.headers.clone() + "\\r\\n"
    }
    if opts.body.len > 0 {
        req = req + "Content-Length: " + opts.body.len.toString() + "\\r\\n\\r\\n" + opts.body.clone()
    } else {
        req = req + "\\r\\n"
    }
    tlsSend(stream, req)?
    let raw = tlsRecv(stream)?
    return Result.Ok(parseResponse(raw))
}

fn doFetch(url: string, opts: FetchOptions): Result<Response, NetError> {
    let useTls = isHttps(url)
    let host = parseHost(url)
    let port = parsePort(url)
    let path = parsePath(url)
    let ip = resolve(host)?

    var resp: Result<Response, NetError> = Result.Err(NetError.Other(""))
    if useTls {
        resp = httpsDo(ip, port, host.clone(), path, opts)
    } else {
        resp = httpDo(ip, port, host, path, opts)
    }

    let r = resp?

    // follow redirects (301, 302, 307, 308)
    if r.status == 301 || r.status == 302 || r.status == 307 || r.status == 308 {
        let loc = r.header("Location")
        if loc.len > 0 {
            var redirOpts = FetchOptions {
                method: opts.method.clone(),
                headers: opts.headers.clone(),
                body: opts.body.clone(),
            }
            if r.status == 301 || r.status == 302 {
                redirOpts.method = "GET"
                redirOpts.body = ""
            }
            return doFetch(loc, redirOpts)
        }
    }
    return Result.Ok(r)
}

// ── Public API ──

fn fetch(url: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "GET", headers: "", body: ""
    }
    return doFetch(url.clone(), opts)
}

fn fetchWith(url: &string, opts: FetchOptions): Result<Response, NetError> {
    return doFetch(url.clone(), opts)
}

fn fetchPost(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "POST",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url.clone(), opts)
}

fn fetchPut(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "PUT",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url.clone(), opts)
}

fn fetchDelete(url: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "DELETE", headers: "", body: ""
    }
    return doFetch(url.clone(), opts)
}

fn fetchPatch(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "PATCH",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url, opts)
}
`, "std/platform.linux.milo": `// platform-specific constants and helpers for Linux

from "std/os" import { htons }

struct SockAddrIn {
    sinFamily: u16,
    sinPort: u16,
    sinAddr: u32,
    sinZero: [u8 ; 8],
}

fn makeSockaddr(port: u16, addr: u32): SockAddrIn {
    unsafe {
        return SockAddrIn {
            sinFamily: 2 as u16,
            sinPort: htons(port),
            sinAddr: addr,
            sinZero: [0 ; 8],
        }
    }
}

fn makeZeroedSockaddr(): SockAddrIn {
    return SockAddrIn {
        sinFamily: 0 as u16, sinPort: 0, sinAddr: 0, sinZero: [0 ; 8],
    }
}

fn solSocket(): i32 {
    return 1
}

fn soReuseaddr(): i32 {
    return 2
}

fn mapPrivateAnon(): i32 {
    return 34
}

fn oWriteCreateTrunc(): i32 {
    return 577
}

fn oWriteCreateAppend(): i32 {
    return 1089
}
// offset of aiAddr field in struct addrinfo (swapped with aiCanonname vs macOS)

fn addrinfoAddrOffset(): i64 {
    return 24
}
// struct stat layout (Linux x8664)

fn statModeOffset(): i64 {
    return 24
}

fn statSizeOffset(): i64 {
    return 48
}

fn statBufSize(): i64 {
    return 144
}
// struct dirent layout

fn direntTypeOffset(): i64 {
    return 18
}

fn direntNameOffset(): i64 {
    return 19
}
// errno access — glibc uses __errno_location() to get errno pointer

extern

fn __errno_location(): *u8

fn getErrno(): i32 {
    unsafe {
        return _loadI32(__errno_location())
    }
}
`, "std/regex.milo": `// std/regex — regular expression matching (wraps POSIX regex.h)


extern

fn regcomp(_preg: *u8, _regex: *u8, _cflags: i32): i32

extern

fn regexec(_preg: *u8, _str: *u8, _nmatch: i64, _pmatch: *u8, _eflags: i32): i32

extern

fn regfree(_preg: *u8): void

// ── Regex handle ──

struct Regex {
    _preg: [u8 ; 128],
    _valid: bool,
}

// Compile a POSIX extended regular expression. Returns None on invalid pattern.

fn regexNew(pattern: string): Option<Regex> {
    var r = Regex {
        _preg: [0 ; 128], _valid: false
    }
    unsafe {
        let rc = regcomp(r._preg, pattern, 1)
        if rc != 0 {
            return Option.None
        }
    }
    r._valid = true
    return Option.Some(r)
}

fn _readMatchI64(buf: &[u8 ; 160], off: i64): i64 {
    var val: i64 = 0
    var k: i64 = 0
    while k < 8 {
        val = val | ((buf[off + k]as i64) << (k * 8))
        k = k + 1
    }
    return val
}

// Test if a string matches the pattern.

fn regexMatch(re: &mut Regex, input: &string): bool {
    unsafe {
        return regexec(re._preg, input, 0, 0 as *u8, 0) == 0
    }
}

// Match result: start and end byte offsets.

struct RegexMatch {
    start: i64,
    end: i64,
}

// Find the first match in a string. Returns None if no match.

fn regexFind(re: &mut Regex, input: &string): Option<RegexMatch> {
    var pmatch: [u8 ; 160] = [0 ; 160]
    unsafe {
        let rc = regexec(re._preg, input, 1, pmatch, 0)
        if rc != 0 {
            return Option.None
        }
    }
    let so = _readMatchI64(pmatch, 0)
    let eo = _readMatchI64(pmatch, 8)
    return Option.Some(RegexMatch {
        start: so, end: eo
    }
    )
}

// Find all non-overlapping matches in a string.

fn regexFindAll(re: &mut Regex, input: &string): Vec<RegexMatch> {
    var matches: Vec<RegexMatch> = Vec.new()
    var offset: i64 = 0
    var pmatch: [u8 ; 160] = [0 ; 160]
    while offset < input.len {
        let tail = input[offset..input.len]
        unsafe {
            let rc = regexec(re._preg, tail, 1, pmatch, 0)
            if rc != 0 {
                break
            }
        }
        let so = _readMatchI64(pmatch, 0)
        let eo = _readMatchI64(pmatch, 8)
        matches.push(RegexMatch {
            start: offset + so, end: offset + eo
        }
        )
        offset = offset + eo
        if so == eo {
            offset = offset + 1
        }
    }
    return matches
}
`, "std/time.milo": `// std/time — wall clock, monotonic timing, sleep


extern

fn gettimeofday(tv: *u8, tz: *u8): i32

extern

fn usleep(usec: u32): i32

// ── helpers ──

fn _readI64FromBuf(buf: &[u8 ; 16], off: i64): i64 {
    var val: i64 = 0
    var i: i64 = 0
    while i < 8 {
        val = val | ((buf[off + i]as i64) << (i * 8))
        i = i + 1
    }
    return val
}

// ── Instant — a point in time ──

struct Instant {
    sec: i64,
    usec: i64,
}

// Capture the current wall-clock time.

fn now(): Instant {
    var tv: [u8 ; 16] = [0 ; 16]
    unsafe {
        gettimeofday(tv, 0 as *u8)
    }
    let sec = _readI64FromBuf(tv, 0)
    let usec = _readI64FromBuf(tv, 8)
    return Instant {
        sec: sec, usec: usec
    }
}

// Milliseconds since Unix epoch.

fn epochMillis(): i64 {
    let t = now()
    return t.sec * 1000 + t.usec / 1000
}

// Seconds since Unix epoch.

fn epochSecs(): i64 {
    let t = now()
    return t.sec
}

// ── Duration — elapsed time between two Instants ──

struct Duration {
    totalUsec: i64,
}

// Elapsed time between two instants.

fn elapsed(start: Instant, end: Instant): Duration {
    let usec = (end.sec - start.sec) * 1000000 + (end.usec - start.usec)
    return Duration {
        totalUsec: usec
    }
}

// Elapsed time since an instant.

fn since(start: Instant): Duration {
    return elapsed(start, now())
}

// Duration accessors.

fn durationSecs(d: &Duration): i64 {
    return d.totalUsec / 1000000
}

fn durationMillis(d: &Duration): i64 {
    return d.totalUsec / 1000
}

fn durationMicros(d: &Duration): i64 {
    return d.totalUsec
}

// ── Sleep ──

// Sleep for the given number of milliseconds.

fn sleepMs(ms: i64): void {
    unsafe {
        usleep((ms * 1000) as u32)
    }
}

// Sleep for the given number of seconds.

fn sleepSecs(secs: i64): void {
    var remaining = secs
    while remaining > 0 {
        var chunk = remaining
        if chunk > 30 {
            chunk = 30
        }
        unsafe {
            usleep((chunk * 1000000) as u32)
        }
        remaining = remaining - chunk
    }
}
`, "std/url.milo": `// std/url — URL parsing into components


struct Url {
    scheme: string,
    host: string,
    port: i32,
    path: string,
    query: string,
    fragment: string,
    raw: string,
}

fn urlParse(s: string): Result<Url> {
    var scheme: string = ""
    var host: string = ""
    var port: i32 = 0
    var path: string = ""
    var query: string = ""
    var fragment: string = ""
    var i: i64 = 0

    // scheme
    var schemeEnd: i64 = 0
    while schemeEnd < s.len {
        if s[schemeEnd] == ':' {
            break
        }
        if s[schemeEnd] == '/' || s[schemeEnd] == '?' || s[schemeEnd] == '#' {
            break
        }
        schemeEnd = schemeEnd + 1
    }
    if schemeEnd < s.len && s[schemeEnd] == ':' {
        scheme = s[0..schemeEnd].clone()
        i = schemeEnd + 1
    }

    // authority (//host:port)
    if i + 1 < s.len && s[i] == '/' && s[i + 1] == '/' {
        i = i + 2
        let authStart = i
        while i < s.len && s[i] != '/' && s[i] != '?' && s[i] != '#' {
            i = i + 1
        }
        let auth = s[authStart..i]

        // split host:port
        var colonPos: i64 = - 1 as i64
        var j: i64 = auth.len - 1
        while j >= 0 {
            if auth[j] == ':' {
                colonPos = j
                break
            }
            if auth[j] == ']' {
                break
            }
            j = j - 1
        }

        if colonPos > 0 {
            host = auth[0..colonPos].clone()
            let portStr = auth[colonPos + 1..auth.len]
            port = _parsePort(portStr)
        } else {
            host = auth.clone()
        }
    }

    // path
    let pathStart = i
    while i < s.len && s[i] != '?' && s[i] != '#' {
        i = i + 1
    }
    path = s[pathStart..i].clone()

    // query
    if i < s.len && s[i] == '?' {
        i = i + 1
        let qStart = i
        while i < s.len && s[i] != '#' {
            i = i + 1
        }
        query = s[qStart..i].clone()
    }

    // fragment
    if i < s.len && s[i] == '#' {
        i = i + 1
        fragment = s[i..s.len].clone()
    }

    // default ports
    if port == 0 {
        if scheme == "http" { port = 80 }
        if scheme == "https" { port = 443 }
    }

    return Result.Ok(Url {
        scheme: scheme, host: host, port: port,
        path: path, query: query, fragment: fragment,
        raw: s.clone(),
    })
}

fn _parsePort(s: &string): i32 {
    var result: i32 = 0
    var i: i64 = 0
    while i < s.len {
        let c = s[i]
        if c < '0' || c > '9' { return 0 }
        result = result * 10 + (c as i32 - 48)
        i = i + 1
    }
    return result
}

fn urlQueryGet(u: &Url, key: &string): Option<string> {
    if u.query.len == 0 { return Option.None }
    var i: i64 = 0
    while i < u.query.len {
        let kStart = i
        while i < u.query.len && u.query[i] != '=' && u.query[i] != '&' {
            i = i + 1
        }
        let k = u.query[kStart..i]
        var val: string = ""
        if i < u.query.len && u.query[i] == '=' {
            i = i + 1
            let vStart = i
            while i < u.query.len && u.query[i] != '&' {
                i = i + 1
            }
            val = u.query[vStart..i].clone()
        }
        if _strEqUrl(k, key) {
            return Option.Some(val)
        }
        if i < u.query.len && u.query[i] == '&' {
            i = i + 1
        }
    }
    return Option.None
}

fn _strEqUrl(a: &string, b: &string): bool {
    if a.len != b.len { return false }
    var i: i64 = 0
    while i < a.len {
        if a[i] != b[i] { return false }
        i = i + 1
    }
    return true
}

fn urlString(u: &Url): string {
    var result: string = ""
    if u.scheme.len > 0 {
        result = result + u.scheme + "://"
    }
    result = result + u.host
    if u.port > 0 && u.port != 80 && u.port != 443 {
        result = result + ":" + format(u.port)
    }
    result = result + u.path
    if u.query.len > 0 {
        result = result + "?" + u.query
    }
    if u.fragment.len > 0 {
        result = result + "#" + u.fragment
    }
    return result
}
`, "std/string.milo": `// std/string — string utility functions

// Check if haystack contains needle.

fn strContains(haystack: &string, needle: &string): bool {
    if needle.len == 0 {
        return true
    }
    if needle.len > haystack.len {
        return false
    }
    var i: i64 = 0
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return true
        }
        i = i + 1
    }
    return false
}

// Find first occurrence of needle in haystack. Returns -1 if not found.

fn strIndexOf(haystack: &string, needle: &string): i64 {
    var notFound: i64 = 0
    notFound = notFound - 1
    if needle.len == 0 {
        return 0 as i64
    }
    if needle.len > haystack.len {
        return notFound
    }
    var i: i64 = 0
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return i
        }
        i = i + 1
    }
    return notFound
}

// Find first occurrence of needle starting at pos. Returns -1 if not found.

fn strIndexOfFrom(haystack: &string, needle: &string, pos: i64): i64 {
    var notFound: i64 = 0
    notFound = notFound - 1
    if needle.len == 0 {
        return pos
    }
    if pos < 0 as i64 {
        return notFound
    }
    if pos + needle.len > haystack.len {
        return notFound
    }
    var i: i64 = pos
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return i
        }
        i = i + 1
    }
    return notFound
}

// Check if string starts with prefix.

fn strStartsWith(s: &string, prefix: &string): bool {
    if prefix.len > s.len {
        return false
    }
    var i: i64 = 0
    while i < prefix.len {
        if s[i] != prefix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

// Check if string ends with suffix.

fn strEndsWith(s: &string, suffix: &string): bool {
    if suffix.len > s.len {
        return false
    }
    let offset = s.len - suffix.len
    var i: i64 = 0
    while i < suffix.len {
        if s[offset + i] != suffix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

// Return new string with ASCII uppercase letters converted to lowercase.

fn strToLower(s: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < s.len {
        let ch = s[i]
        if ch >= 65 && ch <= 90 {
            result.push(ch + 32)
        } else {
            result.push(ch)
        }
        i = i + 1
    }
    return result
}

// Return new string with ASCII lowercase letters converted to uppercase.

fn strToUpper(s: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < s.len {
        let ch = s[i]
        if ch >= 97 && ch <= 122 {
            result.push(ch - 32)
        } else {
            result.push(ch)
        }
        i = i + 1
    }
    return result
}

// Strip leading and trailing ASCII whitespace (space, tab, newline, carriage return).

fn strTrim(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    var end: i64 = s.len
    while end > start {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    if start >= end {
        return ""
    }
    return s.substr(start, end)
}

// Strip leading ASCII whitespace.

fn strTrimStart(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    if start >= s.len {
        return ""
    }
    return s.substr(start, s.len)
}

// Strip trailing ASCII whitespace.

fn strTrimEnd(s: &string): string {
    var end: i64 = s.len
    while end > 0 as i64 {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    if end <= 0 as i64 {
        return ""
    }
    return s.substr(0 as i64, end)
}

// Split string by separator. Returns Vec of substrings.

fn strSplit(s: &string, sep: &string): Vec<string> {
    var result: Vec<string> = Vec.new()
    var notFound: i64 = 0
    notFound = notFound - 1
    if sep.len == 0 {
        var i: i64 = 0
        while i < s.len {
            result.push(s.substr(i, i + 1))
            i = i + 1
        }
        return result
    }
    var pos: i64 = 0
    while pos <= s.len {
        let idx = strIndexOfFrom(s, sep, pos)
        if idx == notFound {
            result.push(s.substr(pos, s.len))
            break
        }
        result.push(s.substr(pos, idx))
        pos = idx + sep.len
    }
    return result
}

// Repeat a string n times.

fn strRepeat(s: &string, n: i64): string {
    var result: string = ""
    var i: i64 = 0
    while i < n {
        result = result + s
        i = i + 1
    }
    return result
}

// Replace all occurrences of old with newVal.

fn strReplace(s: &string, old: &string, newVal: &string): string {
    if old.len == 0 {
        return s.clone()
    }
    var notFound: i64 = 0
    notFound = notFound - 1
    var result: string = ""
    var pos: i64 = 0
    while pos < s.len {
        let idx = strIndexOfFrom(s, old, pos)
        if idx == notFound {
            result = result + s.substr(pos, s.len)
            break
        }
        if idx > pos {
            result = result + s.substr(pos, idx)
        }
        result = result + newVal
        pos = idx + old.len
    }
    return result
}

// Check if a byte is ASCII whitespace.

fn charIsWhitespace(ch: u8): bool {
    return ch == 32 || ch == 9 || ch == 10 || ch == 13
}

// Check if a byte is an ASCII digit.

fn charIsDigit(ch: u8): bool {
    return ch >= 48 && ch <= 57
}

// Check if a byte is an ASCII letter.

fn charIsAlpha(ch: u8): bool {
    return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
}

// Check if a byte is an ASCII letter or digit.

fn charIsAlphanumeric(ch: u8): bool {
    return charIsAlpha(ch) || charIsDigit(ch)
}

// Remove leading and trailing whitespace (spaces, tabs, newlines, carriage returns).

fn trim(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    var end: i64 = s.len
    while end > start {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    return s.substr(start, end)
}
`, "std/sqlite.milo": `// std/sqlite — SQLite3 database bindings
//
// Requires libsqlite3. Link flag added automatically by compiler.
//
//   let db = dbOpen("app.db")!
//   dbExec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")!
//   dbExec(db, "INSERT INTO users (name) VALUES ('alice')")!
//   let stmt = dbQuery(db, "SELECT id, name FROM users")!
//   while dbStep(stmt) {
//       print($"{dbColumnInt(stmt, 0)} {dbColumnText(stmt, 1)}")
//   }
//   dbFinalize(stmt)
//   dbClose(db)


extern fn sqlite3_open(filename: *u8, db: *u8): i32
extern fn sqlite3_close(db: *u8): i32
extern fn sqlite3_exec(db: *u8, sql: *u8, callback: *u8, arg: *u8, errmsg: *u8): i32
extern fn sqlite3_prepare_v2(db: *u8, sql: *u8, nByte: i32, stmt: *u8, tail: *u8): i32
extern fn sqlite3_step(stmt: *u8): i32
extern fn sqlite3_finalize(stmt: *u8): i32
extern fn sqlite3_column_int(stmt: *u8, col: i32): i32
extern fn sqlite3_column_int64(stmt: *u8, col: i32): i64
extern fn sqlite3_column_double(stmt: *u8, col: i32): f64
extern fn sqlite3_column_text(stmt: *u8, col: i32): *u8
extern fn sqlite3_column_count(stmt: *u8): i32
extern fn sqlite3_column_type(stmt: *u8, col: i32): i32
extern fn sqlite3_bind_int(stmt: *u8, idx: i32, val: i32): i32
extern fn sqlite3_bind_int64(stmt: *u8, idx: i32, val: i64): i32
extern fn sqlite3_bind_double(stmt: *u8, idx: i32, val: f64): i32
extern fn sqlite3_bind_text(stmt: *u8, idx: i32, text: *u8, n: i32, destructor: *u8): i32
extern fn sqlite3_bind_null(stmt: *u8, idx: i32): i32
extern fn sqlite3_reset(stmt: *u8): i32
extern fn sqlite3_errmsg(db: *u8): *u8
extern fn sqlite3_changes(db: *u8): i32
extern fn sqlite3_last_insert_rowid(db: *u8): i64

struct Database {
    _handle: *u8,
}

struct Statement {
    _handle: *u8,
    _db: *u8,
}

fn dbOpen(path: string): Result<Database> {
    unsafe {
        var handle: *u8 = 0 as *u8
        let rc = sqlite3_open(path, (&handle) as *u8)
        if rc != 0 {
            if handle != 0 as *u8 { sqlite3_close(handle) }
            return Result.Err("sqlite3_open failed")
        }
        return Result.Ok(Database { _handle: handle })
    }
}

fn dbClose(db: &Database): void {
    unsafe { sqlite3_close(db._handle) }
}

fn dbExec(db: &Database, sql: string): Result<i32> {
    unsafe {
        let rc = sqlite3_exec(db._handle, sql, 0 as *u8, 0 as *u8, 0 as *u8)
        if rc != 0 {
            let msg = _cstrToString(sqlite3_errmsg(db._handle))
            return Result.Err(msg)
        }
        return Result.Ok(sqlite3_changes(db._handle))
    }
}

fn dbQuery(db: &Database, sql: string): Result<Statement> {
    unsafe {
        var handle: *u8 = 0 as *u8
        let rc = sqlite3_prepare_v2(db._handle, sql, 0 - 1, (&handle) as *u8, 0 as *u8)
        if rc != 0 {
            let msg = _cstrToString(sqlite3_errmsg(db._handle))
            return Result.Err(msg)
        }
        return Result.Ok(Statement { _handle: handle, _db: db._handle })
    }
}

fn dbStep(stmt: &Statement): bool {
    unsafe { return sqlite3_step(stmt._handle) == 100 }
}

fn dbColumnInt(stmt: &Statement, col: i32): i32 {
    unsafe { return sqlite3_column_int(stmt._handle, col) }
}

fn dbColumnInt64(stmt: &Statement, col: i32): i64 {
    unsafe { return sqlite3_column_int64(stmt._handle, col) }
}

fn dbColumnFloat(stmt: &Statement, col: i32): f64 {
    unsafe { return sqlite3_column_double(stmt._handle, col) }
}

fn dbColumnText(stmt: &Statement, col: i32): string {
    unsafe {
        let ptr = sqlite3_column_text(stmt._handle, col)
        if ptr == 0 as *u8 { return "" }
        return _cstrToString(ptr)
    }
}

fn dbColumnCount(stmt: &Statement): i32 {
    unsafe { return sqlite3_column_count(stmt._handle) }
}

fn dbColumnIsNull(stmt: &Statement, col: i32): bool {
    unsafe { return sqlite3_column_type(stmt._handle, col) == 5 }
}

fn dbFinalize(stmt: &Statement): void {
    unsafe { sqlite3_finalize(stmt._handle) }
}

fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_int(stmt._handle, idx, val)
        if rc != 0 { return Result.Err("bind_int failed") }
        return Result.Ok(0)
    }
}

fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_int64(stmt._handle, idx, val)
        if rc != 0 { return Result.Err("bind_int64 failed") }
        return Result.Ok(0)
    }
}

fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_text(stmt._handle, idx, val, 0 - 1, (0 - 1) as *u8)
        if rc != 0 { return Result.Err("bind_text failed") }
        return Result.Ok(0)
    }
}

fn dbBindNull(stmt: &Statement, idx: i32): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_null(stmt._handle, idx)
        if rc != 0 { return Result.Err("bind_null failed") }
        return Result.Ok(0)
    }
}

fn dbReset(stmt: &Statement): void {
    unsafe { sqlite3_reset(stmt._handle) }
}

fn dbLastInsertId(db: &Database): i64 {
    unsafe { return sqlite3_last_insert_rowid(db._handle) }
}
`, "std/json.milo": `// std/json — zero-copy JSON parser with ergonomic accessors
//
// Quick usage:
//   let j = jsonParse(data)!
//   let name = j.str("name")!        // Option<string>
//   let age = j.i64("age")!          // Option<i64>
//   let nested = j.get("addr")!      // Option<Json>

struct Json {
    raw: string,
    start: i64,
    end: i64,
}

impl Json {
    // ── Keyed accessors (object fields) ──

    fn get(self: &Self, key: &string): Option<Json> {
        return jsonGetImpl(self.raw, self.start, self.end, key)
    }

    fn str(self: &Self, key: &string): Option<string> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isStr() {
                return Option.Some(jsonStrImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn i64(self: &Self, key: &string): Option<i64> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isNum() {
                return Option.Some(jsonIntImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn f64(self: &Self, key: &string): Option<f64> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isNum() {
                return Option.Some(jsonNumImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn bool(self: &Self, key: &string): Option<bool> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isBool() {
                return Option.Some(j.start < j.end && j.raw[j.start] == 't')
            }
        }
        return Option.None
    }

    // ── Bare value extraction (for array elements, after .get()) ──

    fn asStr(self: &Self): Option<string> {
        if self.isStr() {
            return Option.Some(jsonStrImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asI64(self: &Self): Option<i64> {
        if self.isNum() {
            return Option.Some(jsonIntImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asF64(self: &Self): Option<f64> {
        if self.isNum() {
            return Option.Some(jsonNumImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asBool(self: &Self): Option<bool> {
        if self.isBool() {
            return Option.Some(self.start < self.end && self.raw[self.start] == 't')
        }
        return Option.None
    }

    // ── Array access ──

    fn at(self: &Self, index: i64): Option<Json> {
        return jsonAtImpl(self.raw, self.start, self.end, index)
    }

    // ── Type checks ──

    fn isNull(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == 'n'
    }

    fn isStr(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '"'
    }

    fn isNum(self: &Self): bool {
        if self.start >= self.end {
            return false
        }
        let c = self.raw[self.start]
        return c == '-' || (c >= '0' && c <= '9')
    }

    fn isBool(self: &Self): bool {
        if self.start >= self.end {
            return false
        }
        let c = self.raw[self.start]
        return c == 't' || c == 'f'
    }

    fn isArray(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '['
    }

    fn isObject(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '{'
    }

    fn len(self: &Self): i64 {
        return jsonLenImpl(self.raw, self.start, self.end)
    }

    fn rawStr(self: &Self): string {
        return self.raw[self.start..self.end].clone()
    }

    // Return all keys of a JSON object.
    fn keys(self: &Self): Vec<string> {
        return jsonKeysImpl(self.raw, self.start, self.end)
    }
}

fn jsonParse(s: string): Result<Json> {
    if s.len == 0 {
        return Result.Err("empty input")
    }
    let i = skipWs(s, 0)
    if i >= s.len {
        return Result.Err("empty input")
    }
    let e = skipValue(s, i)
    let afterWs = skipWs(s, e)
    if afterWs != s.len {
        return Result.Err("trailing content")
    }
    if e == i {
        return Result.Err("invalid JSON")
    }
    return Result.Ok(Json {
        raw: s, start: i, end: e
    }
    )
}

// ── Internal helpers ──

fn skipWs(s: &string, pos: i64): i64 {
    var i: i64 = pos
    while i < s.len {
        let c = s[i]
        if c != ' ' && c != '\\t' && c != '\\n' && c != '\\r' {
            break
        }
        i = i + 1
    }
    return i
}

fn skipValue(s: &string, pos: i64): i64 {
    if pos >= s.len {
        return pos
    }
    let c = s[pos]
    if c == '"' {
        return skipString(s, pos)
    }
    if c == '{' {
        return skipObject(s, pos)
    }
    if c == '[' {
        return skipArray(s, pos)
    }
    if c == 't' {
        return pos + 4
    }
    if c == 'f' {
        return pos + 5
    }
    if c == 'n' {
        return pos + 4
    }
    return skipNumber(s, pos)
}

fn skipString(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    while i < s.len {
        if s[i] == '\\\\' {
            i = i + 2
        } else if s[i] == '"' {
            return i + 1
        } else {
            i = i + 1
        }
    }
    return i
}

fn skipNumber(s: &string, pos: i64): i64 {
    var i: i64 = pos
    if i < s.len && s[i] == '-' {
        i = i + 1
    }
    while i < s.len && s[i] >= '0' && s[i] <= '9' {
        i = i + 1
    }
    if i < s.len && s[i] == '.' {
        i = i + 1
        while i < s.len && s[i] >= '0' && s[i] <= '9' {
            i = i + 1
        }
    }
    if i < s.len && (s[i] == 'e' || s[i] == 'E') {
        i = i + 1
        if i < s.len && (s[i] == '+' || s[i] == '-') {
            i = i + 1
        }
        while i < s.len && s[i] >= '0' && s[i] <= '9' {
            i = i + 1
        }
    }
    return i
}

fn skipObject(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    i = skipWs(s, i)
    if i < s.len && s[i] == '}' {
        return i + 1
    }
    while i < s.len {
        i = skipWs(s, i)
        if i >= s.len || s[i] != '"' {
            break
        }
        i = skipString(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ',' {
            i = i + 1
        } else {
            break
        }
    }
    if i < s.len && s[i] == '}' {
        i = i + 1
    }
    return i
}

fn skipArray(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    i = skipWs(s, i)
    if i < s.len && s[i] == ']' {
        return i + 1
    }
    while i < s.len {
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ',' {
            i = i + 1
        } else {
            break
        }
    }
    if i < s.len && s[i] == ']' {
        i = i + 1
    }
    return i
}

fn keyMatches(s: &string, pos: i64, key: &string): bool {
    if pos >= s.len || s[pos] != '"' {
        return false
    }
    var i: i64 = 0
    var j: i64 = pos + 1
    while i < key.len && j < s.len {
        if s[j] == '\\\\' {
            j = j + 1
            if j >= s.len {
                return false
            }
        }
        if s[j] != key[i] {
            return false
        }
        i = i + 1
        j = j + 1
    }
    return i == key.len && j < s.len && s[j] == '"'
}

fn jsonGetImpl(s: &string, start: i64, end: i64, key: &string): Option<Json> {
    if start >= end || s[start] != '{' {
        return Option.None
    }
    var i: i64 = start + 1
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == '}' {
            return Option.None
        }
        let keyStart = i
        if s[i] != '"' {
            return Option.None
        }
        let keyEnd = skipString(s, i)
        let matched = keyMatches(s, keyStart, key)
        i = skipWs(s, keyEnd)
        if i < end && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        let valStart = i
        let valEnd = skipValue(s, i)
        if matched {
            return Option.Some(Json {
                raw: s.clone(), start: valStart, end: valEnd
            }
            )
        }
        i = skipWs(s, valEnd)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return Option.None
}

fn jsonAtImpl(s: &string, start: i64, end: i64, index: i64): Option<Json> {
    if start >= end || s[start] != '[' {
        return Option.None
    }
    var i: i64 = start + 1
    var idx: i64 = 0
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == ']' {
            return Option.None
        }
        let valStart = i
        let valEnd = skipValue(s, i)
        if idx == index {
            return Option.Some(Json {
                raw: s.clone(), start: valStart, end: valEnd
            }
            )
        }
        idx = idx + 1
        i = skipWs(s, valEnd)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return Option.None
}

fn jsonLenImpl(s: &string, start: i64, end: i64): i64 {
    if start >= end {
        return 0
    }
    let c = s[start]
    if c == '[' {
        var i: i64 = start + 1
        i = skipWs(s, i)
        if i < end && s[i] == ']' {
            return 0
        }
        var count: i64 = 0
        while i < end {
            i = skipWs(s, i)
            if i >= end || s[i] == ']' {
                break
            }
            i = skipValue(s, i)
            count = count + 1
            i = skipWs(s, i)
            if i < end && s[i] == ',' {
                i = i + 1
            }
        }
        return count
    }
    if c == '{' {
        var i: i64 = start + 1
        i = skipWs(s, i)
        if i < end && s[i] == '}' {
            return 0
        }
        var count: i64 = 0
        while i < end {
            i = skipWs(s, i)
            if i >= end || s[i] == '}' {
                break
            }
            i = skipString(s, i)
            i = skipWs(s, i)
            if i < end && s[i] == ':' {
                i = i + 1
            }
            i = skipWs(s, i)
            i = skipValue(s, i)
            count = count + 1
            i = skipWs(s, i)
            if i < end && s[i] == ',' {
                i = i + 1
            }
        }
        return count
    }
    return 0
}

fn jsonStrImpl(s: &string, start: i64, end: i64): string {
    if start >= end || s[start] != '"' {
        return ""
    }
    var result: string = ""
    var i: i64 = start + 1
    while i < end && s[i] != '"' {
        if s[i] == '\\\\' && i + 1 < end {
            i = i + 1
            let esc = s[i]
            if esc == 'n' {
                result.push('\\n')
            } 
            else if esc == 't' {
                result.push('\\t')
            } 
            else if esc == 'r' {
                result.push('\\r')
            } 
            else if esc == '"' {
                result.push('"')
            } 
            else if esc == '\\\\' {
                result.push('\\\\')
            } 
            else if esc == '/' {
                result.push('/')
            } 
            else {
                result.push(esc)
            }
        } else {
            result.push(s[i])
        }
        i = i + 1
    }
    return result
}

fn jsonNumImpl(s: &string, start: i64, end: i64): f64 {
    var result: f64 = 0.0
    var negative: bool = false
    var i: i64 = start
    if i < end && s[i] == '-' {
        negative = true
        i = i + 1
    }
    while i < end && s[i] >= '0' && s[i] <= '9' {
        result = result * 10.0 + (s[i]as i32 - 48) as f64
        i = i + 1
    }
    if i < end && s[i] == '.' {
        i = i + 1
        var frac: f64 = 0.1
        while i < end && s[i] >= '0' && s[i] <= '9' {
            result = result + (s[i]as i32 - 48) as f64 * frac
            frac = frac * 0.1
            i = i + 1
        }
    }
    if negative {
        result = 0.0 - result
    }
    return result
}

fn jsonIntImpl(s: &string, start: i64, end: i64): i64 {
    var result: i64 = 0
    var negative: bool = false
    var i: i64 = start
    if i < end && s[i] == '-' {
        negative = true
        i = i + 1
    }
    while i < end && s[i] >= '0' && s[i] <= '9' {
        result = result * 10 + (s[i]as i32 - 48) as i64
        i = i + 1
    }
    if negative {
        result = 0 - result
    }
    return result
}

fn jsonKeysImpl(s: &string, start: i64, end: i64): Vec<string> {
    var result: Vec<string> = Vec.new()
    if start >= end || s[start] != '{' {
        return result
    }
    var i: i64 = start + 1
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == '}' {
            break
        }
        if s[i] != '"' {
            break
        }
        let keyStart = i
        let keyEnd = skipString(s, i)
        let key = jsonStrImpl(s, keyStart, keyEnd)
        result.push(key)
        i = skipWs(s, keyEnd)
        if i < end && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return result
}
`, "std/platform.darwin.milo": `// platform-specific constants and helpers for macOS/BSD

from "std/os" import { htons }

struct SockAddrIn {
    sinLen: u8,
    sinFamily: u8,
    sinPort: u16,
    sinAddr: u32,
    sinZero: [u8 ; 8],
}

fn makeSockaddr(port: u16, addr: u32): SockAddrIn {
    unsafe {
        return SockAddrIn {
            sinLen: 16 as u8,
            sinFamily: 2 as u8,
            sinPort: htons(port),
            sinAddr: addr,
            sinZero: [0 ; 8],
        }
    }
}

fn makeZeroedSockaddr(): SockAddrIn {
    return SockAddrIn {
        sinLen: 0, sinFamily: 0, sinPort: 0, sinAddr: 0, sinZero: [0 ; 8],
    }
}

fn solSocket(): i32 {
    return 65535
}

fn soReuseaddr(): i32 {
    return 4
}

fn mapPrivateAnon(): i32 {
    return 4098
}

fn oWriteCreateTrunc(): i32 {
    return 1537
}

fn oWriteCreateAppend(): i32 {
    return 521
}
// offset of aiAddr field in struct addrinfo

fn addrinfoAddrOffset(): i64 {
    return 32
}
// struct stat layout (macOS aarch64/x8664)

fn statModeOffset(): i64 {
    return 4
}

fn statSizeOffset(): i64 {
    return 96
}

fn statBufSize(): i64 {
    return 144
}
// struct dirent layout

fn direntTypeOffset(): i64 {
    return 20
}

fn direntNameOffset(): i64 {
    return 21
}
// errno access — macOS uses __error() to get errno pointer

extern

fn __error(): *u8

fn getErrno(): i32 {
    unsafe {
        return _loadI32(__error())
    }
}
`, "std/fs.milo": `// std/fs — filesystem operations

from "std/os" import { access, closedir, opendir, read, readdir, stat }
from "std/io" import { IoError, openWrite, writeAll }
from "std/platform" import { direntNameOffset, direntTypeOffset, statBufSize, statModeOffset, statSizeOffset }

// File metadata from stat().

struct FileInfo {
    size: i64,
    mode: i32,
    exists: bool,
}

// Get file metadata. Returns FileInfo with exists=false if path doesn't exist.

fn fileInfo(path: &string): FileInfo {
    var buf: [u8 ; 144] = [0 ; 144]
    unsafe {
        let r = stat(path, buf)
        if r != 0 {
            return FileInfo {
                size: 0 as i64, mode: 0, exists: false
            }
        }
        let modeOff = statModeOffset()
        let sizeOff = statSizeOffset()
        // read u16 mode (macOS) — works for permission bits
        let modeLo = buf[modeOff]as i32
        let modeHi = buf[modeOff + 1]as i32
        let mode = modeLo | (modeHi << 8)
        // read i64 size
        var size: i64 = 0
        var i: i64 = 0
        while i < 8 {
            size = size | ((buf[sizeOff + i]as i64) << (i * 8))
            i = i + 1
        }
        return FileInfo {
            size: size, mode: mode, exists: true
        }
    }
}

// Check if a path exists.

fn pathExists(path: &string): bool {
    unsafe {
        return access(path, 0) == 0
    }
}

// Check if a path is a directory.

fn isDir(path: &string): bool {
    let info = fileInfo(path)
    if !info.exists {
        return false
    }
    // S_IFDIR = 0x4000 = 16384, S_IFMT = 0xF000 = 61440
    return (info.mode & 61440) == 16384
}

// Check if a path is a regular file.

fn isFile(path: &string): bool {
    let info = fileInfo(path)
    if !info.exists {
        return false
    }
    // S_IFREG = 0x8000 = 32768
    return (info.mode & 61440) == 32768
}

// Get file size in bytes. Returns -1 if file doesn't exist.

fn fileSizePath(path: &string): i64 {
    let info = fileInfo(path)
    var negOne: i64 = 0
    negOne = negOne - 1
    if !info.exists {
        return negOne
    }
    return info.size
}

// Directory entry from readDir().

struct DirEntry {
    name: string,
    isDir: bool,
    isFile: bool,
}

// List directory contents. Returns empty vec on error.

fn readDir(path: &string): Vec<DirEntry> {
    var entries: Vec<DirEntry> = Vec.new()
    unsafe {
        let dir = opendir(path)
        if dir as i64 == 0 as i64 {
            return entries
        }
        let nameOff = direntNameOffset()
        let typeOff = direntTypeOffset()
        while true {
            let ent = readdir(dir)
            if ent as i64 == 0 as i64 {
                break
            }
            let dType = _loadU8((ent as i64 + typeOff) as *u8)
            let namePtr = (ent as i64 + nameOff) as *u8
            let name = _cstrToString(namePtr)

            if name == "." || name == ".." {
                let skip = 0
            } else {
                // DT_DIR = 4, DT_REG = 8
                entries.push(DirEntry {
                    name: name,
                    isDir: dType == 4,
                    isFile: dType == 8,
                }
                )
            }
        }
        closedir(dir)
    }
    return entries
}

// Write a string to a file, creating or truncating it.

fn writeFile(path: &string, data: &string): Result<i64, IoError> {
    let f = openWrite(path)?
    return writeAll(f, data)
}
`, "std/hex.milo": `// std/hex — hex encode/decode for strings

fn _hexChar(val: u8): u8 {
    if val < 10 {
        return val + 48
    }
    return val - 10 + 97
}

fn _hexVal(ch: u8): u8 {
    if ch >= 48 && ch <= 57 {
        return ch - 48
    }
    if ch >= 97 && ch <= 102 {
        return ch - 97 + 10
    }
    if ch >= 65 && ch <= 70 {
        return ch - 65 + 10
    }
    return 0
}

// Encode a string as hex (each byte becomes two hex chars).

fn hexEncode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i < input.len {
        let b = input[i]
        result.push(_hexChar(b >> 4))
        result.push(_hexChar(b & 15))
        i = i + 1
    }
    return result
}

// Decode a hex string back to bytes.

fn hexDecode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 1 < input.len {
        let hi = _hexVal(input[i])
        let lo = _hexVal(input[i + 1])
        result.push(((hi << 4) | lo) as u8)
        i = i + 2
    }
    return result
}
`, "std/io.milo": `// std/io — file and directory I/O with automatic cleanup

from "std/os" import { close, lseek, open, read, strerror, write }
from "std/platform" import { getErrno, oWriteCreateAppend, oWriteCreateTrunc }

// ── IoError ──

enum IoError {
    NotFound(string),
    PermissionDenied(string),
    IsDirectory(string),
    AlreadyExists(string),
    Other(string),
}

// map errno to IoError variant with path context

fn _ioError(path: &string): IoError {
    unsafe {
        let e = getErrno()
        if e == 2 {
            return IoError.NotFound(path.clone())
        }
        if e == 13 {
            return IoError.PermissionDenied(path.clone())
        }
        if e == 21 {
            return IoError.IsDirectory(path.clone())
        }
        if e == 17 {
            return IoError.AlreadyExists(path.clone())
        }
        let reason = _cstrToString(strerror(e))
        return IoError.Other("'" + path + "': " + reason)
    }
}

// Write a string to stdout without appending a newline.

fn writeStdout(s: &string): void {
    unsafe {
        write(1, s, s.len)
    }
}

// ── File ──

// Owned file handle. Automatically closes the fd when dropped.

struct File {
    fd: i32,
}

impl Drop for File {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

fn openRead(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, 0)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn openWrite(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, oWriteCreateTrunc(), 420)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn openAppend(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, oWriteCreateAppend(), 420)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn fileSize(f: &File): i64 {
    unsafe {
        let cur = lseek(f.fd, 0, 1)
        let size = lseek(f.fd, 0, 2)
        lseek(f.fd, cur, 0)
        return size
    }
}

fn readAll(f: &File): Result<string, IoError> {
    let size = fileSize(f)
    if size < 0 {
        return Result.Err(IoError.Other("failed to get file size"))
    }
    unsafe {
        lseek(f.fd, 0, 0)
    }
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(f.fd, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

fn writeAll(f: &File, data: &string): Result<i64, IoError> {
    unsafe {
        let n = write(f.fd, data, data.len)
        if n < 0 {
            return Result.Err(IoError.Other("write failed"))
        }
        return Result.Ok(n)
    }
}

fn readFile(path: &string): Result<string, IoError> {
    let f = openRead(path)?
    return readAll(f)
}

// Write a string to stdout without a trailing newline.

fn writeStr(s: &string): void {
    unsafe { write(1, s, s.len) }
}

// Write a single byte to stdout.

fn putChar(ch: u8): void {
    var _pcBuf: [u8; 1] = [0; 1]
    _pcBuf[0] = ch
    unsafe { write(1, _pcBuf, 1) }
}

// Split a string into lines on newline boundaries.

fn splitLines(content: &string): Vec<string> {
    var result: Vec<string> = Vec.new()
    var cur = ""
    var idx: i64 = 0
    while idx < content.len {
        let byte = content[idx]
        if byte == 10 {
            result.push(cur)
            cur = ""
        } else {
            if byte != 13 {
                cur.push(byte)
            }
        }
        idx = idx + 1
    }
    if cur.len > 0 {
        result.push(cur)
    }
    return result
}

// Read a file and return its contents as a Vec of lines.

fn readLines(path: &string): Result<Vec<string>, IoError> {
    let content = readFile(path)?
    return Result.Ok(splitLines(content))
}

// Read a single line from a file descriptor (reads byte-by-byte until newline or EOF).

fn _readLineFd(fd: i32): Option<string> {
    var _rlBuf: [u8 ; 1] = [0 ; 1]
    var _rlResult = ""
    var _rlGot = false
    while true {
        unsafe {
            let n = read(fd, _rlBuf, 1)
            if n <= 0 {
                if _rlGot {
                    return Option.Some(_rlResult)
                }
                return Option.None
            }
        }
        _rlGot = true
        if _rlBuf[0] == 10 {
            return Option.Some(_rlResult)
        }
        if _rlBuf[0] != 13 {
            _rlResult.push(_rlBuf[0])
        }
    }
    return Option.None
}

// Read a single line from stdin. Returns None at EOF.

fn readLine(): Option<string> {
    return _readLineFd(0)
}

// Read all available data from stdin into a string.

fn readStdin(): string {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(0, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return result
}
` }[key];
      if (content === undefined) {
        throw new Error(`cannot resolve '${imp.path}' in playground`);
      }
      const tokens = new Lexer(content).tokenize();
      const imported = new Parser(tokens).parse();
      if (imp.names) {
        const available = new Set;
        for (const s of imported.structs)
          available.add(s.name);
        for (const e of imported.enums)
          available.add(e.name);
        for (const f of imported.functions)
          available.add(f.name);
        for (const t of imported.traits)
          available.add(t.name);
        for (const name of imp.names) {
          if (!available.has(name)) {
            throw new Error(`'${name}' not found in '${imp.path}'`);
          }
        }
      }
      structs.push(...imported.structs);
      enums.push(...imported.enums);
      functions.push(...imported.functions);
      traits.push(...imported.traits);
      impls.push(...imported.impls);
      processImports(imported);
    }
  }
  const preludeKey = "std/prelude.milo";
  if ({ "std/log.milo": `// std/log — logging to stderr with level tags

from "std/time" import { epochSecs }

fn _logMsg(tag: string, msg: string): void {
    let ts = epochSecs()
    eprint($"{tag} {ts.toString()} {msg}")
}

fn logDebug(msg: string): void {
    _logMsg("[DEBUG]", msg)
}

fn logInfo(msg: string): void {
    _logMsg("[INFO] ", msg)
}

fn logWarn(msg: string): void {
    _logMsg("[WARN] ", msg)
}

fn logError(msg: string): void {
    _logMsg("[ERROR]", msg)
}
`, "std/mem.milo": `// std/mem — memory management with automatic cleanup

from "std/os" import { free, malloc, mmap, munmap }
from "std/platform" import { mapPrivateAnon }

// ── MappedMemory ──

// Memory-mapped region. Automatically unmapped on drop.

struct MappedMemory {
    ptr: i64,
    len: i64,
}

impl Drop for MappedMemory {
    fn drop(self: &mut Self): void {
        if self.ptr != 0 {
            unsafe {
                munmap(self.ptr as *u8, self.len)
            }
        }
    }
}

// Allocate an anonymous (non-file-backed) memory-mapped region.

fn mmapAnon(size: i64): Result<MappedMemory> {
    let PROT_RW: i32 = 3
    var addr: i64 = 0
    unsafe {
        let p = mmap(0 as *u8, size, PROT_RW, mapPrivateAnon(), - 1, 0)
        addr = p as i64
    }
    let mapFailed: i64 = - 1 as i64
    if addr == mapFailed {
        return Result.Err("mmap failed")
    }
    return Result.Ok(MappedMemory {
        ptr: addr, len: size
    }
    )
}

// Memory-map a file descriptor for reading.

fn mmapFile(fFd: i32, size: i64): Result<MappedMemory> {
    let PROT_READ: i32 = 1
    let MAP_PRIVATE: i32 = 2
    var addr: i64 = 0
    unsafe {
        let p = mmap(0 as *u8, size, PROT_READ, MAP_PRIVATE, fFd, 0)
        addr = p as i64
    }
    let mapFailed: i64 = - 1 as i64
    if addr == mapFailed {
        return Result.Err("mmap failed")
    }
    return Result.Ok(MappedMemory {
        ptr: addr, len: size
    }
    )
}

// ── Arena ──

// Bump allocator with automatic cleanup.
// All allocations are 8-byte aligned. Use arenaReset() to reclaim without freeing.

struct Arena {
    base: i64,
    cap: i64,
    used: i64,
}

impl Drop for Arena {
    fn drop(self: &mut Self): void {
        if self.base != 0 {
            unsafe {
                free(self.base as *u8)
            }
        }
    }
}

// Create a new arena with the given capacity in bytes.

fn arenaNew(capacity: i64): Result<Arena> {
    unsafe {
        let p = malloc(capacity)
        let addr = p as i64
        if addr == 0 {
            return Result.Err("arena allocation failed")
        }
        return Result.Ok(Arena {
            base: addr, cap: capacity, used: 0
        }
        )
    }
}

// Allocate size bytes from the arena (8-byte aligned).
// Returns Err if the arena doesn't have enough space.

fn arenaAlloc(a: &mut Arena, size: i64): Result<i64> {
    // align to 8 bytes
    let seven: i64 = 7
    let aligned = (a.used + seven) & ~seven
    if aligned + size > a.cap {
        return Result.Err("arena out of memory")
    }
    let ptr = a.base + aligned
    a.used = aligned + size
    return Result.Ok(ptr)
}

// Reset the arena, making all previously allocated memory available for reuse.

fn arenaReset(a: &mut Arena): void {
    a.used = 0
}
`, "std/strconv.milo": `// std/strconv — string-to-number and number-to-string conversions

from "std/os" import { snprintf }

extern

fn strtol(str: *u8, endptr: *u8, base: i32): i64

extern

fn atof(str: *u8): f64

// Parse a decimal integer string. Returns None if not a valid integer.

fn parseInt(s: string): Option<i64> {
    if s.len == 0 {
        return Option.None
    }
    var start: i64 = 0
    if s[0] == 45 || s[0] == 43 {
        start = 1
    }
    if start >= s.len {
        return Option.None
    }
    var i = start
    while i < s.len {
        if s[i] < 48 || s[i] > 57 {
            return Option.None
        }
        i = i + 1
    }
    unsafe {
        return Option.Some(strtol(s, 0 as *u8, 10))
    }
}

// Parse an integer string with a given base (2, 8, 10, 16).

fn parseIntRadix(s: string, base: i32): Option<i64> {
    if s.len == 0 {
        return Option.None
    }
    unsafe {
        return Option.Some(strtol(s, 0 as *u8, base))
    }
}

// Parse a floating-point string. Returns None if not a valid number.

fn parseFloat(s: string): Option<f64> {
    if s.len == 0 {
        return Option.None
    }
    var start: i64 = 0
    if s[0] == 45 || s[0] == 43 {
        start = 1
    }
    if start >= s.len {
        return Option.None
    }
    // must start with digit or dot
    if (s[start] < 48 || s[start] > 57) && s[start] != 46 {
        return Option.None
    }
    unsafe {
        return Option.Some(atof(s))
    }
}

// Convert i64 to hexadecimal string (lowercase).

fn i64ToHex(n: i64): string {
    var buf: [u8 ; 32] = [0 ; 32]
    unsafe {
        snprintf(buf, 32, "%lx", n)
        return _cstrToString(buf as *u8)
    }
}

// Convert i64 to octal string.

fn i64ToOct(n: i64): string {
    var buf: [u8 ; 32] = [0 ; 32]
    unsafe {
        snprintf(buf, 32, "%lo", n)
        return _cstrToString(buf as *u8)
    }
}

// Convert i64 to binary string.

fn i64ToBin(n: i64): string {
    if n == 0 {
        return "0"
    }
    var result = ""
    var val = n
    while val > 0 {
        if (val & 1) == 1 {
            result = "1" + result
        } else {
            result = "0" + result
        }
        val = val >> 1
    }
    return result
}

// Format f64 with a specific number of decimal places.

fn formatFloat(n: f64, decimals: i32): string {
    var buf: [u8 ; 64] = [0 ; 64]
    unsafe {
        snprintf(buf, 64, "%.*f", decimals, n)
        return _cstrToString(buf as *u8)
    }
}
`, "std/fmt.milo": `// std/fmt — string formatting with {} placeholders
//
// Usage: fmt2("hello {}, you are {} years old", name, age.toString())
// Each {} is replaced left-to-right with the corresponding argument.

// Replace the first {} with val.

fn fmt1(template: &string, a: &string): string {
    var result = ""
    var used = false
    var i: i64 = 0
    while i < template.len {
        if !used && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            result = result + a.clone()
            used = true
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first two {} with a and b.

fn fmt2(template: &string, a: &string, b: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 2 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first three {} with a, b, and c.

fn fmt3(template: &string, a: &string, b: &string, c: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 3 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            if which == 2 {
                result = result + c.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first four {} with a, b, c, and d.

fn fmt4(template: &string, a: &string, b: &string, c: &string, d: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 4 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            if which == 2 {
                result = result + c.clone()
            }
            if which == 3 {
                result = result + d.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Left-pad a string to a minimum width.

fn padLeft(s: &string, width: i64, ch: u8): string {
    var result = ""
    var padding = width - s.len
    while padding > 0 {
        result.push(ch)
        padding = padding - 1
    }
    result = result + s.clone()
    return result
}

// Right-pad a string to a minimum width.

fn padRight(s: &string, width: i64, ch: u8): string {
    var result = s.clone()
    var padding = width - s.len
    while padding > 0 {
        result.push(ch)
        padding = padding - 1
    }
    return result
}

// Zero-pad an integer to a minimum width.

fn zeroPad(n: i64, width: i64): string {
    let s = n.toString()
    return padLeft(s, width, 48 as u8)
}

// Join a Vec<string> with a separator.

fn join(parts: &Vec<string>, sep: &string): string {
    var result = ""
    var i: i64 = 0
    while i < parts.len {
        if i > 0 {
            result = result + sep.clone()
        }
        result = result + parts[i].clone()
        i = i + 1
    }
    return result
}
`, "std/random.milo": `// std/random — random number generation
//
// Uses arc4random (macOS/BSD) — no seeding required, cryptographically strong.
// For Linux compat, could fall back to /dev/urandom via std/io.


extern

fn arc4random(): u32

extern

fn arc4random_uniform(upper: u32): u32

extern

fn arc4random_buf(buf: *u8, nbytes: i64): void

// Random u32 in [0, 2^32).

fn randU32(): u32 {
    unsafe {
        return arc4random()
    }
}

// Random i64 in [0, max). Panics if max <= 0.

fn randInt(max: i64): i64 {
    if max <= 0 {
        eprint("randInt: max must be > 0")
    }
    unsafe {
        return arc4random_uniform(max as u32) as i64
    }
}

// Random i64 in [min, max]. Panics if min > max.

fn randRange(min: i64, max: i64): i64 {
    if min > max {
        eprint("randRange: min must be <= max")
    }
    let span = max - min + 1
    return min + randInt(span)
}

// Random f64 in [0.0, 1.0).

fn randFloat(): f64 {
    let r = randU32()
    return r as f64 / 4294967296.0
}

// Random f64 in [min, max).

fn randFloatRange(min: f64, max: f64): f64 {
    return min + randFloat() * (max - min)
}

// Random bool (coin flip).

fn randBool(): bool {
    return randInt(2) == 0
}

// Shuffle a Vec<i64> in place using Fisher-Yates. Pass v.len() as n.

fn shuffleI64(v: &mut Vec<i64>, n: i64): void {
    var i = n - 1
    while i > 0 {
        let j = randRange(0, i)
        let tmp = v[i]
        v[i] = v[j]
        v[j] = tmp
        i = i - 1
    }
}

// Fill a buffer with random bytes.

fn randBytes(buf: *u8, n: i64): void {
    unsafe {
        arc4random_buf(buf, n)
    }
}
`, "std/sync.milo": `// std/sync — synchronization primitives (mutex, channel) via pthreads

from "std/os" import { free, malloc, memcpy, pthread_cond_destroy, pthread_cond_init, pthread_cond_signal, pthread_cond_wait, pthread_mutex_destroy, pthread_mutex_init, pthread_mutex_lock, pthread_mutex_unlock }

// ── Mutex ──
// Mutual exclusion lock. Wrap shared data access with lock/unlock.
//
//   let m = mutexNew()!
//   mutexLock(m)!
//   // ... critical section ...
//   mutexUnlock(m)!
//   mutexDestroy(m)

struct Mutex {
    _handle: *u8,
}

fn mutexNew(): Result<Mutex> {
    unsafe {
        let h = malloc(64)
        let r = pthread_mutex_init(h, 0 as *u8)
        if r != 0 {
            free(h)
            return Result.Err("pthread_mutex_init failed")
        }
        return Result.Ok(Mutex { _handle: h })
    }
}

fn mutexLock(m: &Mutex): Result<i32> {
    unsafe {
        let r = pthread_mutex_lock(m._handle)
        if r != 0 {
            return Result.Err("pthread_mutex_lock failed")
        }
        return Result.Ok(0)
    }
}

fn mutexUnlock(m: &Mutex): Result<i32> {
    unsafe {
        let r = pthread_mutex_unlock(m._handle)
        if r != 0 {
            return Result.Err("pthread_mutex_unlock failed")
        }
        return Result.Ok(0)
    }
}

fn mutexDestroy(m: &Mutex): void {
    unsafe {
        pthread_mutex_destroy(m._handle)
        free(m._handle)
    }
}

// ── Channel ──
// Bounded FIFO channel for safe message passing between threads.
// Channel is a handle type — copying it shares the underlying queue.
// Safe to capture in move closures and send across threads.
//
//   let ch = channelNew(16)!
//   let t = spawn(move (): void => {
//       channelSend(ch, 42)!
//   })!
//   let val = channelRecv(ch)!
//   threadJoin(t)!
//   channelDestroy(ch)

// Inner layout at _ptr (64 bytes):
//   [0..8)   mutex handle
//   [8..16)  condNotEmpty handle
//   [16..24) condNotFull handle
//   [24..32) buf pointer
//   [32..40) capacity
//   [40..48) len
//   [48..56) head
//   [56..64) tail

struct Channel {
    _ptr: *u8,
}

fn channelNew(capacity: i64): Result<Channel> {
    unsafe {
        let inner = malloc(64)

        let mtx = malloc(64)
        let r1 = pthread_mutex_init(mtx, 0 as *u8)
        if r1 != 0 {
            free(mtx)
            free(inner)
            return Result.Err("channel mutex init failed")
        }
        let cne = malloc(48)
        let r2 = pthread_cond_init(cne, 0 as *u8)
        if r2 != 0 {
            free(mtx)
            free(cne)
            free(inner)
            return Result.Err("channel cond init failed")
        }
        let cnf = malloc(48)
        let r3 = pthread_cond_init(cnf, 0 as *u8)
        if r3 != 0 {
            free(mtx)
            free(cne)
            free(cnf)
            free(inner)
            return Result.Err("channel cond init failed")
        }
        let buf = malloc(capacity * 8)

        var zero: i64 = 0
        // store pointers and initial values into inner block
        memcpy(inner, (&mtx) as *u8, 8)
        memcpy((inner as i64 + 8) as *u8, (&cne) as *u8, 8)
        memcpy((inner as i64 + 16) as *u8, (&cnf) as *u8, 8)
        memcpy((inner as i64 + 24) as *u8, (&buf) as *u8, 8)
        memcpy((inner as i64 + 32) as *u8, (&capacity) as *u8, 8)
        memcpy((inner as i64 + 40) as *u8, (&zero) as *u8, 8)
        memcpy((inner as i64 + 48) as *u8, (&zero) as *u8, 8)
        memcpy((inner as i64 + 56) as *u8, (&zero) as *u8, 8)

        return Result.Ok(Channel { _ptr: inner })
    }
}

fn channelSend(ch: &Channel, val: i64): Result<i32> {
    var v: i64 = val
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var condNE: *u8 = 0 as *u8
        memcpy((&condNE) as *u8, (base + 8) as *u8, 8)
        var condNF: *u8 = 0 as *u8
        memcpy((&condNF) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        var cap: i64 = 0
        memcpy((&cap) as *u8, (base + 32) as *u8, 8)
        var curLen: i64 = 0
        var tail: i64 = 0

        pthread_mutex_lock(mtx)
        memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        while curLen == cap {
            pthread_cond_wait(condNF, mtx)
            memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        }
        memcpy((&tail) as *u8, (base + 56) as *u8, 8)
        let slotPtr = (buf as i64 + tail * 8) as *u8
        memcpy(slotPtr, (&v) as *u8, 8)
        tail = (tail + 1) % cap
        curLen = curLen + 1
        memcpy((base + 56) as *u8, (&tail) as *u8, 8)
        memcpy((base + 40) as *u8, (&curLen) as *u8, 8)
        pthread_cond_signal(condNE)
        pthread_mutex_unlock(mtx)
        return Result.Ok(0)
    }
}

fn channelRecv(ch: &Channel): Result<i64> {
    var val: i64 = 0
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var condNE: *u8 = 0 as *u8
        memcpy((&condNE) as *u8, (base + 8) as *u8, 8)
        var condNF: *u8 = 0 as *u8
        memcpy((&condNF) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        var cap: i64 = 0
        memcpy((&cap) as *u8, (base + 32) as *u8, 8)
        var curLen: i64 = 0
        var head: i64 = 0

        pthread_mutex_lock(mtx)
        memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        while curLen == 0 {
            pthread_cond_wait(condNE, mtx)
            memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        }
        memcpy((&head) as *u8, (base + 48) as *u8, 8)
        let slotPtr = (buf as i64 + head * 8) as *u8
        memcpy((&val) as *u8, slotPtr, 8)
        head = (head + 1) % cap
        curLen = curLen - 1
        memcpy((base + 48) as *u8, (&head) as *u8, 8)
        memcpy((base + 40) as *u8, (&curLen) as *u8, 8)
        pthread_cond_signal(condNF)
        pthread_mutex_unlock(mtx)
        return Result.Ok(val)
    }
}

fn channelDestroy(ch: &Channel): void {
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var cne: *u8 = 0 as *u8
        memcpy((&cne) as *u8, (base + 8) as *u8, 8)
        var cnf: *u8 = 0 as *u8
        memcpy((&cnf) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        pthread_mutex_destroy(mtx)
        pthread_cond_destroy(cne)
        pthread_cond_destroy(cnf)
        free(mtx)
        free(cne)
        free(cnf)
        free(buf)
        free(ch._ptr)
    }
}
`, "std/toml.milo": `// std/toml — TOML config file parser
//
//   let t = tomlParse(data)!
//   let name = t.str("name")!
//   let port = t.i64("port")!
//   let db = t.table("database")!
//   let host = db.str("host")!

from "std/os" import { read }

struct Toml {
    raw: string,
    start: i64,
    end: i64,
}

impl Toml {
    fn str(self: &Self, key: &string): Option<string> {
        return tomlGetStr(self.raw, self.start, self.end, key)
    }

    fn i64(self: &Self, key: &string): Option<i64> {
        return tomlGetI64(self.raw, self.start, self.end, key)
    }

    fn f64(self: &Self, key: &string): Option<f64> {
        return tomlGetF64(self.raw, self.start, self.end, key)
    }

    fn bool(self: &Self, key: &string): Option<bool> {
        return tomlGetBool(self.raw, self.start, self.end, key)
    }

    fn table(self: &Self, key: &string): Option<Toml> {
        return tomlGetTable(self.raw, self.start, self.end, key)
    }
}

fn tomlParse(s: string): Result<Toml> {
    if s.len == 0 {
        return Result.Err("empty input")
    }
    let n = s.len
    return Result.Ok(Toml { raw: s, start: 0, end: n })
}

// ── Internal helpers ──

fn _tomlSkipWs(s: &string, pos: i64, end: i64): i64 {
    var i = pos
    while i < end {
        let c = s[i]
        if c == ' ' || c == '\\t' || c == '\\r' {
            i = i + 1
        } else if c == '#' {
            while i < end && s[i] != '\\n' { i = i + 1 }
        } else {
            break
        }
    }
    return i
}

fn _tomlSkipLine(s: &string, pos: i64, end: i64): i64 {
    var i = pos
    while i < end && s[i] != '\\n' { i = i + 1 }
    if i < end { i = i + 1 }
    return i
}

fn _tomlKeyMatches(s: &string, pos: i64, end: i64, key: &string): bool {
    var i = pos
    var j: i64 = 0
    // bare key
    while i < end && j < key.len {
        if s[i] != key[j] { return false }
        i = i + 1
        j = j + 1
    }
    if j != key.len { return false }
    // next non-ws char must be '='
    let after = _tomlSkipWs(s, i, end)
    return after < end && s[after] == '='
}

fn _tomlReadValue(s: &string, pos: i64, end: i64): i64 {
    // return end position of the value
    var i = pos
    if i >= end { return i }
    let c = s[i]
    if c == '"' {
        // quoted string
        i = i + 1
        while i < end && s[i] != '"' {
            if s[i] == '\\\\' { i = i + 1 }
            i = i + 1
        }
        if i < end { i = i + 1 }
        return i
    }
    if c == '\\'' {
        // literal string
        i = i + 1
        while i < end && s[i] != '\\'' { i = i + 1 }
        if i < end { i = i + 1 }
        return i
    }
    if c == '[' {
        // inline array — skip until matching ]
        var depth: i32 = 1
        i = i + 1
        while i < end && depth > 0 {
            if s[i] == '[' { depth = depth + 1 }
            if s[i] == ']' { depth = depth - 1 }
            if s[i] == '"' {
                i = i + 1
                while i < end && s[i] != '"' {
                    if s[i] == '\\\\' { i = i + 1 }
                    i = i + 1
                }
            }
            i = i + 1
        }
        return i
    }
    // bare value (number, bool, date) — read until newline or comment
    while i < end && s[i] != '\\n' && s[i] != '#' {
        i = i + 1
    }
    // trim trailing whitespace
    while i > pos && (s[i - 1] == ' ' || s[i - 1] == '\\t' || s[i - 1] == '\\r') {
        i = i - 1
    }
    return i
}

fn _tomlFindKey(s: &string, start: i64, end: i64, key: &string): Option<Toml> {
    var i = start
    while i < end {
        i = _tomlSkipWs(s, i, end)
        if i >= end { break }
        if s[i] == '\\n' {
            i = i + 1
            continue
        }
        // table header [name] — stop scanning if we hit one
        if s[i] == '[' { break }
        if _tomlKeyMatches(s, i, end, key) {
            // skip key and =
            var j = i
            while j < end && s[j] != '=' { j = j + 1 }
            j = j + 1
            j = _tomlSkipWs(s, j, end)
            let valStart = j
            let valEnd = _tomlReadValue(s, j, end)
            return Option.Some(Toml { raw: s.clone(), start: valStart, end: valEnd })
        }
        i = _tomlSkipLine(s, i, end)
    }
    return Option.None
}

fn tomlGetStr(s: &string, start: i64, end: i64, key: &string): Option<string> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        if t.start < t.end && (t.raw[t.start] == '"' || t.raw[t.start] == '\\'') {
            let quote = t.raw[t.start]
            var result: string = ""
            var i = t.start + 1
            while i < t.end - 1 {
                if t.raw[i] == '\\\\' && quote == '"' && i + 1 < t.end - 1 {
                    i = i + 1
                    let esc = t.raw[i]
                    if esc == 'n' { result.push('\\n') }
                    else if esc == 't' { result.push('\\t') }
                    else if esc == 'r' { result.push('\\r') }
                    else if esc == '"' { result.push('"') }
                    else if esc == '\\\\' { result.push('\\\\') }
                    else { result.push(esc) }
                } else {
                    result.push(t.raw[i])
                }
                i = i + 1
            }
            return Option.Some(result)
        }
        // bare string
        return Option.Some(t.raw[t.start..t.end].clone())
    }
    return Option.None
}

fn tomlGetI64(s: &string, start: i64, end: i64, key: &string): Option<i64> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        var result: i64 = 0
        var negative: bool = false
        var i = t.start
        if i < t.end && t.raw[i] == '-' {
            negative = true
            i = i + 1
        }
        if i < t.end && t.raw[i] == '+' { i = i + 1 }
        while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
            result = result * 10 + (t.raw[i] as i32 - 48) as i64
            i = i + 1
        }
        if negative { result = 0 - result }
        return Option.Some(result)
    }
    return Option.None
}

fn tomlGetF64(s: &string, start: i64, end: i64, key: &string): Option<f64> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        var result: f64 = 0.0
        var negative: bool = false
        var i = t.start
        if i < t.end && t.raw[i] == '-' {
            negative = true
            i = i + 1
        }
        if i < t.end && t.raw[i] == '+' { i = i + 1 }
        while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
            result = result * 10.0 + (t.raw[i] as i32 - 48) as f64
            i = i + 1
        }
        if i < t.end && t.raw[i] == '.' {
            i = i + 1
            var frac: f64 = 0.1
            while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
                result = result + (t.raw[i] as i32 - 48) as f64 * frac
                frac = frac * 0.1
                i = i + 1
            }
        }
        if negative { result = 0.0 - result }
        return Option.Some(result)
    }
    return Option.None
}

fn tomlGetBool(s: &string, start: i64, end: i64, key: &string): Option<bool> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        if t.end - t.start == 4 && t.raw[t.start] == 't' {
            return Option.Some(true)
        }
        if t.end - t.start == 5 && t.raw[t.start] == 'f' {
            return Option.Some(false)
        }
    }
    return Option.None
}

fn tomlGetTable(s: &string, start: i64, end: i64, key: &string): Option<Toml> {
    // search for [key] header
    var i = start
    while i < end {
        i = _tomlSkipWs(s, i, end)
        if i >= end { break }
        if s[i] == '\\n' {
            i = i + 1
            continue
        }
        if s[i] == '[' && (i + 1 >= end || s[i + 1] != '[') {
            let hdrStart = i + 1
            var hdrEnd = hdrStart
            while hdrEnd < end && s[hdrEnd] != ']' { hdrEnd = hdrEnd + 1 }
            let hdrName = s[hdrStart..hdrEnd]
            if _strEq(hdrName, key) {
                // table body: from next line until next [header] or EOF
                let bodyStart = _tomlSkipLine(s, hdrEnd + 1, end)
                var bodyEnd = bodyStart
                var j = bodyStart
                while j < end {
                    j = _tomlSkipWs(s, j, end)
                    if j >= end { break }
                    if s[j] == '\\n' {
                        j = j + 1
                        continue
                    }
                    if s[j] == '[' {
                        bodyEnd = j
                        break
                    }
                    j = _tomlSkipLine(s, j, end)
                    bodyEnd = j
                }
                if j >= end { bodyEnd = end }
                return Option.Some(Toml { raw: s.clone(), start: bodyStart, end: bodyEnd })
            }
        }
        i = _tomlSkipLine(s, i, end)
    }
    return Option.None
}

fn _strEq(a: &string, b: &string): bool {
    if a.len != b.len { return false }
    var i: i64 = 0
    while i < a.len {
        if a[i] != b[i] { return false }
        i = i + 1
    }
    return true
}
`, "std/unicode.milo": `// std/unicode — character classification and case conversion
//
// Currently ASCII-only. UTF-8 multi-byte codepoint support deferred.

// Classify ASCII bytes.

fn isAscii(ch: u8): bool {
    return ch < 128
}

fn isDigit(ch: u8): bool {
    return ch >= 48 && ch <= 57
}

fn isLower(ch: u8): bool {
    return ch >= 97 && ch <= 122
}

fn isUpper(ch: u8): bool {
    return ch >= 65 && ch <= 90
}

fn isAlpha(ch: u8): bool {
    return isLower(ch) || isUpper(ch)
}

fn isAlphanumeric(ch: u8): bool {
    return isAlpha(ch) || isDigit(ch)
}

fn isWhitespace(ch: u8): bool {
    return ch == 32 || ch == 9 || ch == 10 || ch == 13 || ch == 12
}

fn isPunctuation(ch: u8): bool {
    return (ch >= 33 && ch <= 47) || (ch >= 58 && ch <= 64) || (ch >= 91 && ch <= 96) || (ch >= 123 && ch <= 126)
}

fn isHexDigit(ch: u8): bool {
    return isDigit(ch) || (ch >= 97 && ch <= 102) || (ch >= 65 && ch <= 70)
}

fn isPrintable(ch: u8): bool {
    return ch >= 32 && ch < 127
}

fn isControl(ch: u8): bool {
    return ch < 32 || ch == 127
}

// Case conversion for ASCII bytes.

fn toLowerChar(ch: u8): u8 {
    if isUpper(ch) {
        return ch + 32
    }
    return ch
}

fn toUpperChar(ch: u8): u8 {
    if isLower(ch) {
        return ch - 32
    }
    return ch
}

// Check if an entire string is numeric (all digits).

fn isNumeric(s: &string): bool {
    if s.len == 0 {
        return false
    }
    var i: i64 = 0
    while i < s.len {
        if !isDigit(s[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

// Check if an entire string is alphabetic.

fn isAlphaStr(s: &string): bool {
    if s.len == 0 {
        return false
    }
    var i: i64 = 0
    while i < s.len {
        if !isAlpha(s[i]) {
            return false
        }
        i = i + 1
    }
    return true
}
`, "std/env.milo": `// std/env — environment variable access

from "std/os" import { getenv }

// Get an environment variable. Returns None if not set.

fn getEnv(name: string): Option<string> {
    unsafe {
        let ptr = getenv(name)
        if ptr as i64 == 0 as i64 {
            return Option.None
        }
        return Option.Some(_cstrToString(ptr))
    }
}

// Get an environment variable with a default value.

fn getEnvOr(name: string, defaultVal: string): string {
    match getEnv(name) {
        Option.Some(val) => {
            return val
        }
        Option.None => {
            return defaultVal
        }
    }
}
`, "std/arena.milo": `// std/arena — generational arena for cyclic and graph data structures
//
// Handles are freely copyable and storable (unlike &T).
// Generation checks detect use-after-free at runtime.
//
// Handle<T> carries a phantom type param so handles from one arena cannot
// accidentally be used with another arena of a different element type.
// Returning &T is forbidden by second-class refs; mutation goes through
// arenaSet (full overwrite) or arenaModify (closure on current value).

// Opaque handle to an arena slot. Safe to copy, store, and return.
// T is phantom — not stored, only used for type-checking handle/arena pairs.

@derive(Eq)
struct Handle<T> {
    index: i32,
    generation: i32,
}

// Generational arena backed by Vec<T>.

struct Arena<T> {
    data: Vec<T>,
    gens: Vec<i32>,
    freeList: Vec<i32>,
    live: i64,
}

// Create a new empty arena.

fn arenaNew<T> (): Arena<T> {
    var a: Arena<T> = Arena {
        data: Vec.new(),
        gens: Vec.new(),
        freeList: Vec.new(),
        live: 0,
    }
    return a
}

// Insert a value and return a handle to it.

fn arenaAlloc<T> (a: &mut Arena<T>, val: T): Handle<T> {
    if a.freeList.len > 0 {
        let fi = a.freeList[a.freeList.len - 1]
        a.freeList.pop()
        let idx = fi as i64
        a.data[idx] = val
        let gen = a.gens[idx]
        a.live = a.live + 1
        var h: Handle<T> = Handle {
            index: fi, generation: gen
        }
        return h
    }
    let idx = a.data.len
    a.data.push(val)
    a.gens.push(1)
    a.live = a.live + 1
    var h: Handle<T> = Handle {
        index: idx as i32, generation: 1
    }
    return h
}

// Check whether a handle is still valid.

fn arenaValid<T> (a: &Arena<T>, h: Handle<T>): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    return a.gens[idx] == h.generation
}

// Free a slot, bumping its generation so stale handles are detected.

fn arenaFree<T> (a: &mut Arena<T>, h: Handle<T>): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.gens[idx] = a.gens[idx] + 1
    a.freeList.push(h.index)
    a.live = a.live - 1
    return true
}

// Get a copy of the value at a handle. Returns None if the handle is stale.
// Returns by value, not &T, because second-class refs cannot be stored in
// Option<_>. For large T, prefer arenaModify to avoid the copy churn.

fn arenaGet<T> (a: &Arena<T>, h: Handle<T>): Option<T> {
    let idx = h.index as i64
    if idx < 0 {
        return Option.None
    }
    if idx >= a.data.len {
        return Option.None
    }
    if a.gens[idx] != h.generation {
        return Option.None
    }
    return Option.Some(a.data[idx])
}

// Overwrite the value at a handle. Returns false if the handle is stale.

fn arenaSet<T> (a: &mut Arena<T>, h: Handle<T>, val: T): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.data[idx] = val
    return true
}

// In-place update via closure. Avoids the manual get/modify/set dance and
// is the recommended way to mutate a single field of an arena value.
// Returns false if the handle is stale (closure not invoked).

fn arenaModify<T> (a: &mut Arena<T>, h: Handle<T>, f: (T) => T): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.data[idx] = f(a.data[idx])
    return true
}

// Number of live entries.

fn arenaLen<T> (a: &Arena<T>): i64 {
    return a.live
}

// Method API — same functionality, nicer syntax.

impl Arena<T> {
    fn alloc(self: &mut Self, val: T): Handle<T> {
        return arenaAlloc(self, val)
    }

    fn get(self: &Self, h: Handle<T>): Option<T> {
        return arenaGet(self, h)
    }

    fn set(self: &mut Self, h: Handle<T>, val: T): bool {
        return arenaSet(self, h, val)
    }

    fn modify(self: &mut Self, h: Handle<T>, f: (T) => T): bool {
        return arenaModify(self, h, f)
    }

    fn free(self: &mut Self, h: Handle<T>): bool {
        return arenaFree(self, h)
    }

    fn valid(self: &Self, h: Handle<T>): bool {
        return arenaValid(self, h)
    }
}

`, "std/http.milo": `// std/http — high-level HTTP server for Milo

from "std/os" import { accept, bind, close, getsockname, listen, ntohs, read, setsockopt, socket, write }
from "std/platform" import { SockAddrIn, makeSockaddr, makeZeroedSockaddr, solSocket, soReuseaddr }

// ── Public types ──

// Incoming HTTP request with method and path.

struct Request {
    method: string,
    path: string,
}

// Key-value pair for path params and response headers.
struct Param {
    name: string,
    value: string,
}

// Request context passed to route handlers.
// Contains the matched request, extracted path params, and response state.
struct Context {
    req: Request,
    params: Vec<Param>,
    statusCode: i32,
    respHeaders: Vec<Param>,
}

impl Context {
    fn param(self: &Self, name: &string): string {
        var i: i64 = 0
        while i < self.params.len {
            if self.params[i].name == *name {
                return self.params[i].value.clone()
            }
            i = i + 1
        }
        return ""
    }

    fn setStatus(self: &mut Self, code: i32): void {
        self.statusCode = code
    }

    fn setHeader(self: &mut Self, name: string, value: string): void {
        self.respHeaders.push(Param { name: name, value: value })
    }

    fn text(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "text/plain; charset=utf-8", body)
        }
        return Response.Text(body)
    }

    fn json(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "application/json", body)
        }
        return Response.Json(body)
    }

    fn html(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "text/html; charset=utf-8", body)
        }
        return Response.Html(body)
    }

    fn redirect(self: &Self, url: string): Response {
        return Response.Status(302, "text/plain; charset=utf-8", url)
    }
}

// HTTP response type.
// Text/Html/Json set the content-type automatically.
// Status(code, contentType, body) for custom responses.

enum Response {
    Text(string),
    Html(string),
    Json(string),
    NotFound,
    Status(i32, string, string),
}

// ── Internal helpers ──

fn bufToStr(buf: &[u8 ; 8192], start: i64, end: i64): string {
    var s: string = ""
    var i: i64 = start
    while i < end {
        s.push(buf[i])
        i = i + 1
    }
    return s
}

fn parseRequest(buf: &[u8 ; 8192], n: i64): Request {
    var i: i64 = 0
    while i < n && buf[i] != ' ' {
        i = i + 1
    }
    let method = bufToStr(buf, 0, i)
    while i < n && buf[i] == ' ' {
        i = i + 1
    }
    let pathStart = i
    while i < n && buf[i] != ' ' {
        i = i + 1
    }
    let path = bufToStr(buf, pathStart, i)
    return Request {
        method: method, path: path
    }
}

fn statusText(status: i32): string {
    if status == 200 {
        return "200 OK"
    }
    if status == 201 {
        return "201 Created"
    }
    if status == 204 {
        return "204 No Content"
    }
    if status == 301 {
        return "301 Moved Permanently"
    }
    if status == 400 {
        return "400 Bad Request"
    }
    if status == 404 {
        return "404 Not Found"
    }
    if status == 500 {
        return "500 Internal Server Error"
    }
    return "200 OK"
}

fn sendRaw(fd: i32, status: i32, contentType: string, body: string): void {
    var resp: string = "HTTP/1.1 " + statusText(status)
    resp = resp + "\\r\\nContent-Type: " + contentType
    resp = resp + "\\r\\nContent-Length: " + body.len.toString()
    resp = resp + "\\r\\nConnection: close"
    resp = resp + "\\r\\nServer: milo"
    resp = resp + "\\r\\n\\r\\n"
    resp = resp + body
    unsafe {
        write(fd, resp, resp.len)
    }
}

fn sendResponse(fd: i32, response: Response): void {
    match response {
        Response.Text(body) => {
            sendRaw(fd, 200, "text/plain; charset=utf-8", body)
        }
        Response.Html(body) => {
            sendRaw(fd, 200, "text/html; charset=utf-8", body)
        }
        Response.Json(body) => {
            sendRaw(fd, 200, "application/json", body)
        }
        Response.NotFound => {
            sendRaw(fd, 404, "text/plain; charset=utf-8", "404 Not Found")
        }
        Response.Status(code, ct, body) => {
            sendRaw(fd, code, ct, body)
        }
    }
}

// ── Socket with automatic cleanup ──

struct Socket {
    fd: i32,
}

impl Drop for Socket {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

// ── Public API ──

// Start an HTTP server on the given port.
// Pass null for port to let the OS pick an available port.
// The handler receives a Request and returns a Response.
// Example:
//   serve(8080, fn(req: &Request): Response {
//       return Response.Text("hello")
//   })

fn serve(port: u16?, handler: (&Request) => Response): Result<void> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let BACKLOG: i32 = 1024
    let BUF_SIZE: i64 = 8192
    let SIZEOF_SOCKADDR_IN: u32 = 16

    // port 0 tells the OS to pick a random available port
    var bindPort: u16 = 0
    if let Option.Some(p) = port {
        bindPort = p
    }

    unsafe {
        let rawFd = socket(AF_INET, SOCK_STREAM, 0)
        if rawFd < 0 {
            return Result.Err("socket() failed")
        }
        let sock = Socket {
            fd: rawFd
        }

        var one: i32 = 1
        setsockopt(sock.fd, solSocket(), soReuseaddr(), one, 4)

        var addr = makeSockaddr(bindPort, 0)

        if bind(sock.fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            return Result.Err("bind() failed")
        }

        if listen(sock.fd, BACKLOG) < 0 {
            return Result.Err("listen() failed")
        }

        // retrieve actual port (needed when bindPort was 0)
        var boundAddr = makeZeroedSockaddr()
        var boundLen: u32 = SIZEOF_SOCKADDR_IN
        getsockname(sock.fd, boundAddr, boundLen)
        let actualPort = ntohs(boundAddr.sinPort)

        print($"listening on http://localhost:{actualPort}")

        while true {
            var clientAddr = makeZeroedSockaddr()
            var addrlen: u32 = SIZEOF_SOCKADDR_IN
            let clientFd = accept(sock.fd, clientAddr, addrlen)
            if clientFd < 0 {
                continue
            }

            var buf: [u8 ; 8192] = [0 ; 8192]
            let n = read(clientFd, buf, BUF_SIZE)
            if n > 0 {
                let req = parseRequest(buf, n)
                let resp = handler(req)
                sendResponse(clientFd, resp)
            }
            close(clientFd)
        }
    }
    return Result.Err("server exited")
}

// ── Router ──

struct Route {
    method: string,
    pattern: string,
    paramNames: Vec<string>,
    handler: (&mut Context) => Response,
}

struct Router {
    routes: Vec<Route>,
    middleware: Vec<(&mut Context, (&mut Context) => Response) => Response>,
}

impl Router {
    fn new(): Router {
        return Router {
            routes: [],
            middleware: [],
        }
    }

    fn get(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("GET", pattern, h)
    }

    fn post(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("POST", pattern, h)
    }

    fn put(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("PUT", pattern, h)
    }

    fn delete(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("DELETE", pattern, h)
    }

    fn all(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("*", pattern, h)
    }

    fn use(self: &mut Self, mw: (&mut Context, (&mut Context) => Response) => Response): void {
        self.middleware.push(mw)
    }

    fn addRoute(self: &mut Self, method: string, pattern: string, h: (&mut Context) => Response): void {
        let paramNames = extractParamNames(pattern)
        self.routes.push(Route {
            method: method,
            pattern: pattern,
            paramNames: paramNames,
            handler: h,
        })
    }

    fn handle(self: &Self, req: Request): Response {
        var i: i64 = 0
        while i < self.routes.len {
            let route = self.routes[i]
            if route.method == "*" || route.method == req.method {
                let params = matchRoute(route.pattern, route.paramNames, req.path)
                if let Option.Some(matched) = params {
                    var ctx = Context {
                        req: req,
                        params: matched,
                        statusCode: 200,
                        respHeaders: [],
                    }
                    let handler = route.handler
                    // wrap handler with middleware chain (innermost first)
                    var final: (&mut Context) => Response = handler
                    var m: i64 = self.middleware.len - 1
                    while m >= 0 {
                        let mw = self.middleware[m]
                        let next = final
                        final = (c: &mut Context) => {
                            return mw(c, next)
                        }
                        m = m - 1
                    }
                    return final(ctx)
                }
            }
            i = i + 1
        }
        return Response.NotFound
    }
}

// Start an HTTP server using a Router.
fn serveRouter(port: u16?, router: &Router): Result<void> {
    return serve(port, (req: &Request) => {
        // clone request since router.handle takes ownership
        let owned = Request { method: req.method.clone(), path: req.path.clone() }
        return router.handle(owned)
    })
}

// ── Path matching ──

// Extract param names from pattern like "/user/:id/posts/:postId"
fn extractParamNames(pattern: &string): Vec<string> {
    var names: Vec<string> = []
    var i: i64 = 0
    while i < pattern.len {
        if pattern[i] == ':' {
            var j: i64 = i + 1
            while j < pattern.len && pattern[j] != '/' {
                j = j + 1
            }
            var name: string = ""
            var k: i64 = i + 1
            while k < j {
                name.push(pattern[k])
                k = k + 1
            }
            names.push(name)
            i = j
        } else {
            i = i + 1
        }
    }
    return names
}

// Match a request path against a route pattern.
// Returns Some(params) on match, None on mismatch.
fn matchRoute(pattern: &string, paramNames: &Vec<string>, path: &string): Option<Vec<Param>> {
    let patSegs = splitPath(pattern)
    let pathSegs = splitPath(path)

    // wildcard: pattern ending with "*" matches any suffix
    var hasWildcard: bool = false
    if patSegs.len > 0 && patSegs[patSegs.len - 1] == "*" {
        hasWildcard = true
    }

    if !hasWildcard && patSegs.len != pathSegs.len {
        return Option.None
    }
    if hasWildcard && pathSegs.len < patSegs.len - 1 {
        return Option.None
    }

    var params: Vec<Param> = []
    var paramIdx: i64 = 0
    var segCount: i64 = patSegs.len
    if hasWildcard {
        segCount = segCount - 1
    }

    var i: i64 = 0
    while i < segCount {
        let pat = patSegs[i]
        if i >= pathSegs.len {
            return Option.None
        }
        let seg = pathSegs[i]
        if pat.len > 0 && pat[0] == ':' {
            // param segment — capture value
            if paramIdx < paramNames.len {
                params.push(Param { name: paramNames[paramIdx].clone(), value: seg.clone() })
                paramIdx = paramIdx + 1
            }
        } else if pat != seg {
            return Option.None
        }
        i = i + 1
    }
    return Option.Some(params)
}

// Split path by '/' into non-empty segments
fn splitPath(path: &string): Vec<string> {
    var segs: Vec<string> = []
    var current: string = ""
    var i: i64 = 0
    while i < path.len {
        if path[i] == '/' {
            if current.len > 0 {
                segs.push(current)
                current = ""
            }
        } else {
            current.push(path[i])
        }
        i = i + 1
    }
    if current.len > 0 {
        segs.push(current)
    }
    return segs
}
`, "std/args.milo": `// std/args — command-line argument parsing

// Return all command-line arguments as a Vec<string>.
// Index 0 is the program name.

fn args(): Vec<string> {
    var result: Vec<string> = Vec.new()
    let n = _miloArgCount()
    var i: i64 = 0
    while i < n {
        result.push(_miloArgAt(i))
        i = i + 1
    }
    return result
}

// Get the value following a --name flag.
// Returns null if the flag is not present.
// Example: getFlag("port") returns the value after --port.

fn getFlag(name: &string): string? {
    let all = args()
    let flag = "--" + name
    var i: i64 = 0
    while i < all.len {
        if all[i] == flag {
            if i + 1 < all.len {
                return Option.Some(all[i + 1])
            }
        }
        i = i + 1
    }
    return null
}

// Check if a --name flag is present in the arguments.

fn hasFlag(name: &string): bool {
    let all = args()
    let flag = "--" + name
    var i: i64 = 0
    while i < all.len {
        if all[i] == flag {
            return true
        }
        i = i + 1
    }
    return false
}
`, "std/set.milo": `// std/set — HashSet<T> backed by HashMap<T, bool>

struct HashSet<T> {
    inner: HashMap<T, bool>,
}

// Create an empty HashSet.

fn setNew<T> (): HashSet<T> {
    return HashSet {
        inner: HashMap.new()
    }
}

// Add a value to the set.

fn setAdd<T> (s: &mut HashSet<T>, val: T): void {
    s.inner.insert(val, true)
}

// Check if the set contains a value.

fn setContains<T> (s: &HashSet<T>, val: T): bool {
    return s.inner.contains(val)
}

// Remove a value from the set.

fn setRemove<T> (s: &mut HashSet<T>, val: T): void {
    s.inner.remove(val)
}

// Number of elements in the set.

fn setLen<T> (s: &HashSet<T>): i64 {
    return s.inner.len
}
`, "std/csv.milo": `// std/csv — CSV parse and write with quoting/escaping


// Parse a CSV string into a Vec of rows, each row a Vec of fields.

fn csvParse(input: &string): Vec<Vec<string>> {
    var rows: Vec<Vec<string>> = Vec.new()
    var row: Vec<string> = Vec.new()
    var field = ""
    var inQuote = false
    var i: i64 = 0
    while i < input.len {
        let ch = input[i]
        if inQuote {
            if ch == 34 {
                // double quote: peek for escaped quote
                if i + 1 < input.len && input[i + 1] == 34 {
                    field.push(34 as u8)
                    i = i + 2
                    continue
                }
                inQuote = false
            } else {
                field.push(ch)
            }
        } else {
            if ch == 34 {
                inQuote = true
            } else {
                if ch == 44 {
                    row.push(field)
                    field = ""
                } else {
                    if ch == 10 {
                        row.push(field)
                        field = ""
                        rows.push(row)
                        row = Vec.new()
                    } else {
                        if ch != 13 {
                            field.push(ch)
                        }
                    }
                }
            }
        }
        i = i + 1
    }
    if field.len > 0 || row.len > 0 {
        row.push(field)
        rows.push(row)
    }
    return rows
}

// Quote a field if it contains commas, quotes, or newlines.

fn _csvQuoteField(val: &string): string {
    var needsQuote = false
    var j: i64 = 0
    while j < val.len {
        let ch = val[j]
        if ch == 44 || ch == 34 || ch == 10 || ch == 13 {
            needsQuote = true
            break
        }
        j = j + 1
    }
    if !needsQuote {
        return val.clone()
    }
    var quoted = "\\""
    var k: i64 = 0
    while k < val.len {
        let ch = val[k]
        if ch == 34 {
            quoted = quoted + "\\"\\""
        } else {
            quoted.push(ch)
        }
        k = k + 1
    }
    quoted = quoted + "\\""
    return quoted
}

// Serialize rows to a CSV string.

fn csvStringify(rows: &Vec<Vec<string>>): string {
    var output = ""
    var ri: i64 = 0
    while ri < rows.len {
        var ci: i64 = 0
        while ci < rows[ri].len {
            if ci > 0 {
                output = output + ","
            }
            output = output + _csvQuoteField(rows[ri][ci])
            ci = ci + 1
        }
        output = output + "\\n"
        ri = ri + 1
    }
    return output
}
`, "std/path.milo": `// std/path — file path manipulation


// Get the file extension including the dot. Returns "" if none.

fn pathExt(path: &string): string {
    var i: i64 = path.len - 1
    while i >= 0 as i64 {
        if path[i] == 46 {
            return path.substr(i, path.len)
        }
        if path[i] == 47 {
            return ""
        }
        i = i - 1
    }
    return ""
}

// Get the last component of a path.

fn pathBasename(path: &string): string {
    if path.len == 0 {
        return ""
    }
    var end: i64 = path.len
    // strip trailing slashes
    while end > 0 as i64 && path[end - 1] == 47 {
        end = end - 1
    }
    if end == 0 as i64 {
        return "/"
    }
    var i: i64 = end - 1
    while i >= 0 as i64 {
        if path[i] == 47 {
            return path.substr(i + 1, end)
        }
        i = i - 1
    }
    return path.substr(0 as i64, end)
}

// Get the directory portion of a path.

fn pathDirname(path: &string): string {
    if path.len == 0 {
        return "."
    }
    var end: i64 = path.len
    // strip trailing slashes
    while end > 0 as i64 && path[end - 1] == 47 {
        end = end - 1
    }
    if end == 0 as i64 {
        return "/"
    }
    // find last slash
    var i: i64 = end - 1
    while i >= 0 as i64 {
        if path[i] == 47 {
            if i == 0 as i64 {
                return "/"
            }
            return path.substr(0 as i64, i)
        }
        i = i - 1
    }
    return "."
}

// Join two path components with a separator.

fn pathJoin(a: &string, b: &string): string {
    if a.len == 0 {
        return b.clone()
    }
    if b.len == 0 {
        return a.clone()
    }
    if a[a.len - 1] == 47 {
        return a + b
    }
    return a + "/" + b
}

// Get the filename without extension.

fn pathStem(path: &string): string {
    let base = pathBasename(path)
    var i: i64 = base.len - 1
    while i > 0 as i64 {
        if base[i] == 46 {
            return base.substr(0 as i64, i)
        }
        i = i - 1
    }
    return base
}
`, "std/signal.milo": `// std/signal — OS signal handling (POSIX)


extern fn signal(signum: i32, handler: *u8): *u8

let SIGHUP: i32 = 1
let SIGINT: i32 = 2
let SIGQUIT: i32 = 3
let SIGABRT: i32 = 6
let SIGKILL: i32 = 9
let SIGALRM: i32 = 14
let SIGTERM: i32 = 15

// Register a handler for a signal. Handler receives the signal number.
fn onSignal(sig: i32, handler: fn(i32): void): void {
    unsafe {
        signal(sig, handler as *u8)
    }
}

// Ignore a signal.
fn ignoreSignal(sig: i32): void {
    unsafe {
        signal(sig, 1 as *u8)
    }
}

// Reset a signal to default behavior.
fn resetSignal(sig: i32): void {
    unsafe {
        signal(sig, 0 as *u8)
    }
}
`, "std/prelude.milo": `// std/prelude — auto-imported into every Milo program (suppress with --no-prelude)

from "std/string" import { strContains, strIndexOf, strIndexOfFrom, strStartsWith, strEndsWith, strToLower, strToUpper, strTrim, strTrimStart, strTrimEnd, strSplit, strRepeat, strReplace, charIsWhitespace, charIsDigit, charIsAlpha, charIsAlphanumeric, trim }
`, "std/color.milo": `// std/color — ANSI terminal colors and styles

fn red(s: &string): string { return "\\x1b[31m" + s + "\\x1b[0m" }
fn green(s: &string): string { return "\\x1b[32m" + s + "\\x1b[0m" }
fn yellow(s: &string): string { return "\\x1b[33m" + s + "\\x1b[0m" }
fn blue(s: &string): string { return "\\x1b[34m" + s + "\\x1b[0m" }
fn magenta(s: &string): string { return "\\x1b[35m" + s + "\\x1b[0m" }
fn cyan(s: &string): string { return "\\x1b[36m" + s + "\\x1b[0m" }
fn white(s: &string): string { return "\\x1b[37m" + s + "\\x1b[0m" }
fn gray(s: &string): string { return "\\x1b[90m" + s + "\\x1b[0m" }

fn bold(s: &string): string { return "\\x1b[1m" + s + "\\x1b[0m" }
fn dim(s: &string): string { return "\\x1b[2m" + s + "\\x1b[0m" }
fn italic(s: &string): string { return "\\x1b[3m" + s + "\\x1b[0m" }
fn underline(s: &string): string { return "\\x1b[4m" + s + "\\x1b[0m" }
fn strikethrough(s: &string): string { return "\\x1b[9m" + s + "\\x1b[0m" }

fn bgRed(s: &string): string { return "\\x1b[41m" + s + "\\x1b[0m" }
fn bgGreen(s: &string): string { return "\\x1b[42m" + s + "\\x1b[0m" }
fn bgYellow(s: &string): string { return "\\x1b[43m" + s + "\\x1b[0m" }
fn bgBlue(s: &string): string { return "\\x1b[44m" + s + "\\x1b[0m" }
`, "std/crypto.milo": `// std/crypto — cryptographic hash functions
//
// macOS: wraps CommonCrypto (CC_SHA256, CC_MD5)
// Linux: would wrap OpenSSL (SHA256, MD5) — same signatures


extern

fn CC_SHA256(_data: *u8, _len: u32, _md: *u8): *u8

extern

fn CC_MD5(_data: *u8, _len: u32, _md: *u8): *u8

fn _bytesToHex(buf: &[u8 ; 32], n: i64): string {
    var result = ""
    var i: i64 = 0
    while i < n {
        let b = buf[i]
        let hi = b >> 4
        let lo = b & 15
        if hi < 10 {
            result.push(hi + 48)
        } else {
            result.push(hi - 10 + 97)
        }
        if lo < 10 {
            result.push(lo + 48)
        } else {
            result.push(lo - 10 + 97)
        }
        i = i + 1
    }
    return result
}

// Compute SHA-256 hash of a string. Returns 64-char lowercase hex string.

fn sha256(input: &string): string {
    var hash: [u8 ; 32] = [0 ; 32]
    unsafe {
        CC_SHA256(input, input.len as u32, hash)
    }
    return _bytesToHex(hash, 32)
}

// Compute MD5 hash of a string. Returns 32-char lowercase hex string.

fn md5(input: &string): string {
    var hash: [u8 ; 32] = [0 ; 32]
    unsafe {
        CC_MD5(input, input.len as u32, hash)
    }
    return _bytesToHex(hash, 16)
}
`, "std/os.milo": `// std/os — typed libc bindings for Milo

// ── I/O ──

extern

fn read(fd: i32, buf: *u8, nbyte: i64): i64

extern

fn write(fd: i32, buf: *u8, nbyte: i64): i64

extern

fn open(path: *u8, flags: i32,...): i32

extern

fn close(fd: i32): i32

extern

fn lseek(fd: i32, offset: i64, whence: i32): i64

extern

fn fstat(fd: i32, buf: *u8): i32

extern

fn stat(path: *u8, buf: *u8): i32

extern

fn access(path: *u8, mode: i32): i32

extern

fn puts(s: *u8): i32

extern

fn printf(fmt: *u8,...): i32

// ── Memory ──

extern

fn malloc(size: i64): *u8

extern

fn realloc(ptr: *u8, size: i64): *u8

extern

fn free(ptr: *u8): void

extern

fn memcpy(dst: *u8, src: *u8, n: i64): *u8

extern

fn memset(dst: *u8, c: i32, n: i64): *u8

extern

fn memmove(dst: *u8, src: *u8, n: i64): *u8

extern

fn mmap(addr: *u8, len: i64, prot: i32, flags: i32, fd: i32, offset: i64): *u8

extern

fn munmap(addr: *u8, len: i64): i32

// ── Error ──

extern

fn strerror(errnum: i32): *u8

// ── Strings ──

extern

fn strlen(s: *u8): i64

extern

fn strcmp(a: *u8, b: *u8): i32

extern

fn strncmp(a: *u8, b: *u8, n: i64): i32

extern

fn snprintf(buf: *u8, size: i64, fmt: *u8,...): i32

// ── Network ──

extern

fn socket(domain: i32, type: i32, protocol: i32): i32

extern

fn bind(sockfd: i32, addr: &SockAddrIn, addrlen: u32): i32

extern

fn listen(sockfd: i32, backlog: i32): i32

extern

fn accept(sockfd: i32, addr: &mut SockAddrIn, addrlen: &mut u32): i32

extern

fn connect(sockfd: i32, addr: &SockAddrIn, addrlen: u32): i32

extern

fn setsockopt(fd: i32, level: i32, opt: i32, val: &i32, len: u32): i32

extern

fn htons(hostshort: u16): u16

extern

fn ntohs(netshort: u16): u16

extern

fn getsockname(fd: i32, addr: &mut SockAddrIn, addrlen: &mut u32): i32

extern

fn inet_pton(af: i32, src: *u8, dst: *u8): i32

// ── TLS (OpenSSL) ──

extern

fn TLS_client_method(): *u8

extern

fn SSL_CTX_new(method: *u8): *u8

extern

fn SSL_CTX_free(ctx: *u8): void

extern

fn SSL_CTX_set_default_verify_paths(ctx: *u8): i32

extern

fn SSL_new(ctx: *u8): *u8

extern

fn SSL_set_fd(ssl: *u8, fd: i32): i32

extern

fn SSL_connect(ssl: *u8): i32

extern

fn SSL_read(ssl: *u8, buf: *u8, num: i32): i32

extern

fn SSL_write(ssl: *u8, buf: *u8, num: i32): i32

extern

fn SSL_free(ssl: *u8): void

extern

fn SSL_ctrl(ssl: *u8, cmd: i32, larg: i64, parg: *u8): i64

// ── DNS ──

extern

fn getaddrinfo(node: *u8, service: *u8, hints: *u8, res: *u8): i32

extern

fn freeaddrinfo(res: *u8): void

// ── Directory ──

extern

fn opendir(path: *u8): *u8

extern

fn closedir(dir: *u8): i32

extern

fn readdir(dir: *u8): *u8

// ── Process ──

extern

fn exit(status: i32): void

extern

fn getenv(name: *u8): *u8

extern

fn system(cmd: *u8): i32

extern

fn fork(): i32

extern

fn execl(path: *u8,...): i32

extern

fn waitpid(pid: i32, status: *u8, options: i32): i32

extern

fn dup2(oldfd: i32, newfd: i32): i32

extern

fn pipe(fds: *u8): i32

extern

fn kill(pid: i32, sig: i32): i32

// ── pthreads ──

extern

fn pthread_create(thread: *u8, attr: *u8, start: *u8, arg: *u8): i32

extern

fn pthread_join(thread: i64, retval: *u8): i32

extern

fn pthread_mutex_init(mutex: *u8, attr: *u8): i32

extern

fn pthread_mutex_lock(mutex: *u8): i32

extern

fn pthread_mutex_unlock(mutex: *u8): i32

extern

fn pthread_mutex_destroy(mutex: *u8): i32

extern

fn pthread_cond_init(cond: *u8, attr: *u8): i32

extern

fn pthread_cond_wait(cond: *u8, mutex: *u8): i32

extern

fn pthread_cond_signal(cond: *u8): i32

extern

fn pthread_cond_broadcast(cond: *u8): i32

extern

fn pthread_cond_destroy(cond: *u8): i32
`, "std/datetime.milo": `// std/datetime — date/time components and formatting from epoch seconds

from "std/time" import { epochSecs, since }

struct DateTime {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    weekday: i32,
}

fn dateTimeFromEpoch(epochSec: i64): DateTime {
    // days since 1970-01-01
    var secs = epochSec
    let totalDays = secs / 86400
    let daySeconds = secs - totalDays * 86400

    let hour = (daySeconds / 3600) as i32
    let minute = ((daySeconds - (hour as i64) * 3600) / 60) as i32
    let second = (daySeconds - (hour as i64) * 3600 - (minute as i64) * 60) as i32

    // weekday: 1970-01-01 was Thursday (4)
    var wd = ((totalDays + 4) % 7) as i32
    if wd < 0 { wd = wd + 7 }

    // civil date from day count (Hinnant algorithm)
    var z = totalDays + 719468
    var eraInput = z
    if z < 0 { eraInput = z - 146096 }
    let era = eraInput / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    var m = mp + 3
    if mp >= 10 { m = mp - 9 }
    var yr = y
    if m <= 2 { yr = y + 1 }

    return DateTime {
        year: yr as i32, month: m as i32, day: d as i32,
        hour: hour, minute: minute, second: second,
        weekday: wd,
    }
}

fn dateTimeNow(): DateTime {
    return dateTimeFromEpoch(epochSecs())
}

fn dateTimeFormat(dt: &DateTime): string {
    // ISO 8601: 2024-03-15T14:30:00
    var result: string = ""
    result = result + _padI32(dt.year, 4) + "-" + _padI32(dt.month, 2) + "-" + _padI32(dt.day, 2)
    result = result + "T"
    result = result + _padI32(dt.hour, 2) + ":" + _padI32(dt.minute, 2) + ":" + _padI32(dt.second, 2)
    return result
}

fn dateTimeFormatDate(dt: &DateTime): string {
    return _padI32(dt.year, 4) + "-" + _padI32(dt.month, 2) + "-" + _padI32(dt.day, 2)
}

fn dateTimeFormatTime(dt: &DateTime): string {
    return _padI32(dt.hour, 2) + ":" + _padI32(dt.minute, 2) + ":" + _padI32(dt.second, 2)
}

fn weekdayName(wd: i32): string {
    if wd == 0 { return "Sunday" }
    if wd == 1 { return "Monday" }
    if wd == 2 { return "Tuesday" }
    if wd == 3 { return "Wednesday" }
    if wd == 4 { return "Thursday" }
    if wd == 5 { return "Friday" }
    if wd == 6 { return "Saturday" }
    return "Unknown"
}

fn monthName(m: i32): string {
    if m == 1 { return "January" }
    if m == 2 { return "February" }
    if m == 3 { return "March" }
    if m == 4 { return "April" }
    if m == 5 { return "May" }
    if m == 6 { return "June" }
    if m == 7 { return "July" }
    if m == 8 { return "August" }
    if m == 9 { return "September" }
    if m == 10 { return "October" }
    if m == 11 { return "November" }
    if m == 12 { return "December" }
    return "Unknown"
}

fn _padI32(val: i32, width: i32): string {
    var s = format(val)
    while s.len < width as i64 {
        s = "0" + s
    }
    return s
}
`, "std/math.milo": `// std/math — mathematical functions (wraps libm)


// ── libm bindings ──

extern

fn sqrt(x: f64): f64

extern

fn pow(base: f64, exp: f64): f64

extern

fn sin(x: f64): f64

extern

fn cos(x: f64): f64

extern

fn tan(x: f64): f64

extern

fn atan2(y: f64, x: f64): f64

extern

fn floor(x: f64): f64

extern

fn ceil(x: f64): f64

extern

fn round(x: f64): f64

extern

fn fabs(x: f64): f64

extern

fn fmod(x: f64, y: f64): f64

extern

fn log(x: f64): f64

extern

fn log2(x: f64): f64

extern

fn log10(x: f64): f64

extern

fn exp(x: f64): f64

// ── safe wrappers ──

fn mathSqrt(x: f64): f64 {
    unsafe {
        return sqrt(x)
    }
}

fn mathPow(base: f64, exponent: f64): f64 {
    unsafe {
        return pow(base, exponent)
    }
}

fn mathSin(x: f64): f64 {
    unsafe {
        return sin(x)
    }
}

fn mathCos(x: f64): f64 {
    unsafe {
        return cos(x)
    }
}

fn mathTan(x: f64): f64 {
    unsafe {
        return tan(x)
    }
}

fn mathAtan2(y: f64, x: f64): f64 {
    unsafe {
        return atan2(y, x)
    }
}

fn mathFloor(x: f64): f64 {
    unsafe {
        return floor(x)
    }
}

fn mathCeil(x: f64): f64 {
    unsafe {
        return ceil(x)
    }
}

fn mathRound(x: f64): f64 {
    unsafe {
        return round(x)
    }
}

fn mathAbs(x: f64): f64 {
    unsafe {
        return fabs(x)
    }
}

fn mathMod(x: f64, y: f64): f64 {
    unsafe {
        return fmod(x, y)
    }
}

fn mathLog(x: f64): f64 {
    unsafe {
        return log(x)
    }
}

fn mathLog2(x: f64): f64 {
    unsafe {
        return log2(x)
    }
}

fn mathLog10(x: f64): f64 {
    unsafe {
        return log10(x)
    }
}

fn mathExp(x: f64): f64 {
    unsafe {
        return exp(x)
    }
}

// ── integer helpers ──

fn absI64(x: i64): i64 {
    if x < 0 {
        return 0 - x
    }
    return x
}

fn absI32(x: i32): i32 {
    if x < 0 as i32 {
        return 0 as i32 - x
    }
    return x
}

fn minI64(a: i64, b: i64): i64 {
    if a < b {
        return a
    }
    return b
}

fn maxI64(a: i64, b: i64): i64 {
    if a > b {
        return a
    }
    return b
}

fn minI32(a: i32, b: i32): i32 {
    if a < b {
        return a
    }
    return b
}

fn maxI32(a: i32, b: i32): i32 {
    if a > b {
        return a
    }
    return b
}

fn minF64(a: f64, b: f64): f64 {
    if a < b {
        return a
    }
    return b
}

fn maxF64(a: f64, b: f64): f64 {
    if a > b {
        return a
    }
    return b
}

fn clampI64(x: i64, lo: i64, hi: i64): i64 {
    if x < lo {
        return lo
    }
    if x > hi {
        return hi
    }
    return x
}

fn clampF64(x: f64, lo: f64, hi: f64): f64 {
    if x < lo {
        return lo
    }
    if x > hi {
        return hi
    }
    return x
}

// ── constants ──

fn mathPi(): f64 {
    return 3.14159265358979323846
}

fn mathE(): f64 {
    return 2.71828182845904523536
}

fn mathInf(): f64 {
    return 1.0 / 0.0
}
`, "std/testing.milo": `// std/testing — test assertion functions

from "std/os" import { exit }

fn _testFail(): void {
    unsafe { exit(1) }
}

fn assert(cond: bool): void {
    if !cond {
        eprint("  assertion failed")
        _testFail()
    }
}

fn assertMsg(cond: bool, msg: string): void {
    if !cond {
        eprint($"  assertion failed: {msg}")
        _testFail()
    }
}

fn assertEqual(got: i32, expected: i32): void {
    if got != expected {
        eprint($"  assertEqual failed: got {got}, expected {expected}")
        _testFail()
    }
}

fn assertEqual64(got: i64, expected: i64): void {
    if got != expected {
        eprint($"  assertEqual64 failed: got {got}, expected {expected}")
        _testFail()
    }
}

fn assertStrEqual(got: &string, expected: &string): void {
    if got != expected {
        eprint("  assertStrEqual failed")
        _testFail()
    }
}

fn assertBool(got: bool, expected: bool): void {
    if got != expected {
        eprint("  assertBool failed")
        _testFail()
    }
}
`, "std/thread.milo": `// std/thread — OS thread spawning and joining via pthreads

from "std/os" import { free, malloc, memcpy, pthread_create, pthread_join }
from "std/time" import { sleepMs }

// Handle to a spawned OS thread.

struct Thread {
    id: i64,
}

// Spawn a new OS thread running the given function.
// The function receives a *u8 argument for passing data.
// The caller must ensure the pointed-to data outlives the thread.
//
//   fn worker(arg: *u8): *u8 { ... }
//   var data: i64 = 42
//   let t = threadSpawn(worker as *u8, (&data) as *u8)!
//   threadJoin(t)!

fn threadSpawn(func: *u8, arg: *u8): Result<Thread> {
    var tid: i64 = 0
    unsafe {
        let r = pthread_create((&tid) as *u8, 0 as *u8, func, arg)
        if r != 0 {
            return Result.Err("pthread_create failed")
        }
    }
    return Result.Ok(Thread { id: tid })
}

// Spawn a thread running a no-arg function (convenience wrapper).
//
//   fn work(arg: *u8): *u8 { print("hi"); return 0 as *u8 }
//   let t = threadSpawnFn(work)!

fn threadSpawnFn(func: (*u8) => *u8): Result<Thread> {
    unsafe {
        return threadSpawn(func as *u8, 0 as *u8)
    }
}

// Block until the thread finishes.

fn threadJoin(t: &Thread): Result<i32> {
    unsafe {
        let r = pthread_join(t.id, 0 as *u8)
        if r != 0 {
            return Result.Err("pthread_join failed")
        }
        return Result.Ok(0)
    }
}

// ── Safe spawn with move closures ──
// The closure's captures are heap-allocated (by move semantics) and
// passed to the thread via the pthread arg pointer. No unsafe needed
// by the caller.
//
//   let offset: i64 = 10
//   let t = spawn(move (): void => {
//       print($"offset is {offset}")
//   })!
//   threadJoin(t)!

// trampoline: receives packed { fnPtr, envPtr } via pthread arg
fn _closureTrampoline(arg: *u8): *u8 {
    unsafe {
        let base = arg as i64
        var fnPtr: *u8 = 0 as *u8
        var envPtr: *u8 = 0 as *u8
        memcpy((&fnPtr) as *u8, arg, 8)
        memcpy((&envPtr) as *u8, (base + 8) as *u8, 8)
        _callClosureVoid(fnPtr, envPtr)
        // free the packed struct (closure env is freed by drop glue or leaks — acceptable for threads)
        free(arg)
        return 0 as *u8
    }
}

fn spawn(f: () => void): Result<Thread> {
    unsafe {
        // f is { ptr fnPtr, ptr envPtr } — pack both into a heap block for the trampoline
        let packed = malloc(16)
        // extract fn ptr and env ptr from closure tuple
        // the closure is passed as two ptr args; we need the raw values
        let fPtr = f as *u8
        // for the env, we need the second element of the tuple
        // _closurePairEnv is a builtin that extracts element 1
        // ... actually, f is a { ptr, ptr } passed as a parameter.
        // When f is a fn param, it's stored as { ptr, ptr } in an alloca.
        // We need to extract both elements.
        // Let's just pass f's alloca address — it already contains { fnPtr, envPtr }
        memcpy(packed, (&f) as *u8, 16)
        let t = threadSpawn(_closureTrampoline as *u8, packed)
        return t
    }
}

// Sleep the current thread for the given number of milliseconds.

fn threadSleep(ms: i64): void {
    sleepMs(ms)
}
`, "std/uuid.milo": `// std/uuid — UUID v4 generation (random, RFC 4122)

from "std/random" import { arc4random_buf }

fn _byteToHex(b: u8): string {
    var s = ""
    s.push(_hexChar(b >> 4))
    s.push(_hexChar(b & 15 as u8))
    return s
}

// Generate a random UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000").

fn uuidV4(): string {
    var buf: [u8; 16] = [0 as u8; 16]
    unsafe { arc4random_buf(buf as *u8, 16) }

    // version 4: high nibble of byte 6 = 0100
    buf[6] = (buf[6] & 0x0f as u8) | 0x40 as u8
    // variant 1: high bits of byte 8 = 10
    buf[8] = (buf[8] & 0x3f as u8) | 0x80 as u8

    var s = ""
    s = s + _byteToHex(buf[0]) + _byteToHex(buf[1]) + _byteToHex(buf[2]) + _byteToHex(buf[3])
    s = s + "-"
    s = s + _byteToHex(buf[4]) + _byteToHex(buf[5])
    s = s + "-"
    s = s + _byteToHex(buf[6]) + _byteToHex(buf[7])
    s = s + "-"
    s = s + _byteToHex(buf[8]) + _byteToHex(buf[9])
    s = s + "-"
    s = s + _byteToHex(buf[10]) + _byteToHex(buf[11]) + _byteToHex(buf[12])
    s = s + _byteToHex(buf[13]) + _byteToHex(buf[14]) + _byteToHex(buf[15])
    return s
}
`, "std/argparse.milo": `// std/argparse — command-line argument parser with auto-generated help
from "std/args" import {
    args
}

struct FlagDef {
    longName: string,
    shortName: string,
    help: string,
    defaultVal: string,
    isBool: bool,
    required: bool,
}

struct PositionalDef {
    name: string,
    help: string,
    required: bool,
}

// Declarative command-line argument parser with auto-generated --help.
// Create with newParser(), add flags with addString/addBool/addRequired,
// then call .parse() to get a ParsedArgs.

struct ArgParser {
    name: string,
    description: string,
    usage: string,
    flags: Vec<FlagDef>,
    positionals: Vec<PositionalDef>,
}

// Parsed command-line arguments.
// Access values with .getString(), .getI64(), .getU16(), .getBool().
// Check presence with .has(). Positional args in .positional field.

struct ParsedArgs {
    prog: string,
    entries: Vec<ArgEntry>,
    positional: Vec<string>,
}

struct ArgEntry {
    name: string,
    value: string,
    present: bool,
}

// Create a new argument parser with a program name and description.

fn newParser(name: string, description: string): ArgParser {
    return ArgParser {
        name: name,
        description: description,
        usage: "",
        flags: Vec.new(),
        positionals: Vec.new(),
    }
}

impl ArgParser {
    // Add a string flag with long name, short alias, help text, and default.
    // Example: parser.addString("output", "o", "Output file", "out.txt")
    fn addString(self: &mut Self, long: string, short: string, help: string, defaultVal: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: defaultVal,
            isBool: false,
            required: false,
        }
        )
    }

    // Add a required string flag. parse() exits with error if missing.
    fn addRequired(self: &mut Self, long: string, short: string, help: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: "",
            isBool: false,
            required: true,
        }
        )
    }

    // Add a boolean flag (present = true, absent = false).
    fn addBool(self: &mut Self, long: string, short: string, help: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: "",
            isBool: true,
            required: false,
        }
        )
    }

    // Add a required positional argument.
    fn addPositional(self: &mut Self, name: string, help: string): void {
        self.positionals.push(PositionalDef {
            name: name, help: help, required: true
        }
        )
    }

    // Add an optional positional argument.
    fn addOptionalPositional(self: &mut Self, name: string, help: string): void {
        self.positionals.push(PositionalDef {
            name: name, help: help, required: false
        }
        )
    }

    // Generate formatted help text for all registered flags.
    fn helpText(self: &Self): string {
        var text: string = self.name + " - " + self.description + "\\n\\n"
        if self.usage.len > 0 {
            text = text + "usage: " + self.usage + "\\n\\n"
        } else {
            var usageLine: string = "usage: " + self.name + " [options]"
            var pi: i64 = 0
            while pi < self.positionals.len {
                if self.positionals[pi].required {
                    usageLine = usageLine + " <" + self.positionals[pi].name + ">"
                } else {
                    usageLine = usageLine + " [" + self.positionals[pi].name + "]"
                }
                pi = pi + 1
            }
            text = text + usageLine + "\\n\\n"
        }
        if self.positionals.len > 0 {
            text = text + "arguments:\\n"
            var pi2: i64 = 0
            while pi2 < self.positionals.len {
                var pline: string = "  <" + self.positionals[pi2].name + ">"
                while pline.len < 30 {
                    pline = pline + " "
                }
                pline = pline + self.positionals[pi2].help
                text = text + pline + "\\n"
                pi2 = pi2 + 1
            }
            text = text + "\\n"
        }

        text = text + "options:\\n"
        var i: i64 = 0
        while i < self.flags.len {
            var fline: string = "  "
            if self.flags[i].shortName.len > 0 {
                fline = fline + "-" + self.flags[i].shortName + ", "
            } else {
                fline = fline + "    "
            }
            fline = fline + "--" + self.flags[i].longName
            if !self.flags[i].isBool {
                fline = fline + " <value>"
            }
            while fline.len < 30 {
                fline = fline + " "
            }
            fline = fline + self.flags[i].help
            if !self.flags[i].isBool && self.flags[i].defaultVal.len > 0 {
                fline = fline + " (default: " + self.flags[i].defaultVal + ")"
            }
            if self.flags[i].required {
                fline = fline + " (required)"
            }
            text = text + fline + "\\n"
            i = i + 1
        }
        text = text + "  -h, --help                  Show this help message\\n"
        return text
    }

    // Parse command-line arguments and return ParsedArgs.
    // Automatically handles --help. Exits on invalid input.
    fn parse(self: &Self): ParsedArgs {
        let argv = args()
        var result = ParsedArgs {
            prog: self.name.clone(),
            entries: Vec.new(),
            positional: Vec.new(),
        }

        // initialize flag entries with defaults
        var fi: i64 = 0
        while fi < self.flags.len {
            result.entries.push(ArgEntry {
                name: self.flags[fi].longName.clone(),
                value: self.flags[fi].defaultVal.clone(),
                present: false,
            }
            )
            fi = fi + 1
        }

        // initialize positional entries
        var pi: i64 = 0
        while pi < self.positionals.len {
            result.entries.push(ArgEntry {
                name: self.positionals[pi].name.clone(),
                value: "",
                present: false,
            }
            )
            pi = pi + 1
        }

        var posIdx: i64 = 0
        var i: i64 = 1
        while i < argv.len {
            let arg = argv[i]

            if arg == "--help" || arg == "-h" {
                print(self.helpText())
                unsafe {
                    exit(0)
                }
            }

            if arg.len >= 2 && arg[0] == 45 {
                var matched: bool = false
                var fi2: i64 = 0
                while fi2 < self.flags.len {
                    let longFlag = "--" + self.flags[fi2].longName
                    var isMatch: bool = false
                    if arg == longFlag {
                        isMatch = true
                    }
                    if self.flags[fi2].shortName.len > 0 {
                        let shortFlag = "-" + self.flags[fi2].shortName
                        if arg == shortFlag {
                            isMatch = true
                        }
                    }

                    if isMatch {
                        matched = true
                        if self.flags[fi2].isBool {
                            result.entries[fi2] = ArgEntry {
                                name: self.flags[fi2].longName.clone(),
                                value: "true",
                                present: true,
                            }
                        } else {
                            if i + 1 >= argv.len {
                                print($"error: --{self.flags[fi2].longName} requires a value\\n\\n{self.helpText()}")
                                unsafe {
                                    exit(1)
                                }
                            }
                            i = i + 1
                            result.entries[fi2] = ArgEntry {
                                name: self.flags[fi2].longName.clone(),
                                value: argv[i].clone(),
                                present: true,
                            }
                        }
                    }
                    fi2 = fi2 + 1
                }

                if !matched {
                    print($"error: unknown flag '{arg}'\\n\\n{self.helpText()}")
                    unsafe {
                        exit(1)
                    }
                }
            } else {
                result.positional.push(arg.clone())
                // map to named positional entry
                if posIdx < self.positionals.len {
                    let entryIdx = self.flags.len + posIdx
                    result.entries[entryIdx] = ArgEntry {
                        name: self.positionals[posIdx].name.clone(),
                        value: arg.clone(),
                        present: true,
                    }
                    posIdx = posIdx + 1
                }
            }

            i = i + 1
        }

        // validate required flags
        var ri: i64 = 0
        while ri < self.flags.len {
            if self.flags[ri].required && !result.entries[ri].present {
                print($"error: --{self.flags[ri].longName} is required\\n\\n{self.helpText()}")
                unsafe {
                    exit(1)
                }
            }
            ri = ri + 1
        }

        // validate required positionals
        var rp: i64 = 0
        while rp < self.positionals.len {
            if self.positionals[rp].required {
                let entryIdx = self.flags.len + rp
                if !result.entries[entryIdx].present {
                    print($"error: missing required argument <{self.positionals[rp].name}>\\n\\n{self.helpText()}")
                    unsafe {
                        exit(1)
                    }
                }
            }
            rp = rp + 1
        }

        return result
    }
}

// ── integer parsing helper ──

fn _argparseParseI64(s: &string): i64 {
    var result: i64 = 0
    var neg: bool = false
    var i: i64 = 0
    if s.len > 0 && s[0] == 45 {
        neg = true
        i = 1
    }
    while i < s.len {
        let d = s[i]as i64 - 48
        result = result * 10 + d
        i = i + 1
    }
    if neg {
        return 0 - result
    }
    return result
}

fn _argparseIsNumeric(s: &string): bool {
    var i: i64 = 0
    if s.len == 0 {
        return false
    }
    if s[0] == 45 {
        i = 1
    }
    if i >= s.len {
        return false
    }
    while i < s.len {
        let c = s[i]
        if c < 48 || c > 57 {
            return false
        }
        i = i + 1
    }
    return true
}

impl ParsedArgs {
    // Get the string value of a flag by its long name.
    fn getString(self: &Self, name: &string): string {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name {
                return self.entries[i].value.clone()
            }
            i = i + 1
        }
        return ""
    }

    // Get an integer value of a flag. Exits if the value is not numeric.
    fn getI64(self: &Self, name: &string): i64 {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name {
                let val = self.entries[i].value.clone()
                if !_argparseIsNumeric(val) {
                    print($"error: --{name}: expected integer, got '{val}'")
                    unsafe {
                        exit(1)
                    }
                }
                return _argparseParseI64(val)
            }
            i = i + 1
        }
        print($"error: --{name}: unknown flag")
        unsafe {
            exit(1)
        }
        return 0
    }

    // Get a u16 value of a flag. Exits if out of range 0..65535.
    fn getU16(self: &Self, name: &string): u16 {
        let val = self.getI64(name)
        if val < 0 || val > 65535 {
            print($"error: --{name}: value {val} out of range 0..65535")
            unsafe {
                exit(1)
            }
        }
        return val as u16
    }

    // Check if a boolean flag was set.
    fn getBool(self: &Self, name: &string): bool {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name && self.entries[i].present {
                return true
            }
            i = i + 1
        }
        return false
    }

    // Check if a flag was provided on the command line.
    fn has(self: &Self, name: &string): bool {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name && self.entries[i].present {
                return true
            }
            i = i + 1
        }
        return false
    }
}
`, "std/base64.milo": `// std/base64 — base64 encode/decode

fn _b64EncodeChar(val: u8): u8 {
    if val < 26 {
        return val + 65
    }
    if val < 52 {
        return val - 26 + 97
    }
    if val < 62 {
        return val - 52 + 48
    }
    if val == 62 {
        return 43
    }
    return 47
}

fn _b64DecodeChar(ch: u8): u8 {
    if ch >= 65 && ch <= 90 {
        return ch - 65
    }
    if ch >= 97 && ch <= 122 {
        return ch - 97 + 26
    }
    if ch >= 48 && ch <= 57 {
        return ch - 48 + 52
    }
    if ch == 43 {
        return 62
    }
    if ch == 47 {
        return 63
    }
    return 0
}

// Encode a string to base64.

fn base64Encode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 2 < input.len {
        let a = input[i]
        let b = input[i + 1]
        let c = input[i + 2]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar(((a & 3) << 4) | (b >> 4)))
        result.push(_b64EncodeChar(((b & 15) << 2) | (c >> 6)))
        result.push(_b64EncodeChar(c & 63))
        i = i + 3
    }
    let remaining = input.len - i
    if remaining == 2 {
        let a = input[i]
        let b = input[i + 1]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar(((a & 3) << 4) | (b >> 4)))
        result.push(_b64EncodeChar((b & 15) << 2))
        result.push(61 as u8)
    }
    if remaining == 1 {
        let a = input[i]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar((a & 3) << 4))
        result.push(61 as u8)
        result.push(61 as u8)
    }
    return result
}

// Decode a base64 string.

fn base64Decode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 3 < input.len {
        if input[i] == 61 {
            break
        }
        let a = _b64DecodeChar(input[i])
        let b = _b64DecodeChar(input[i + 1])
        let c = _b64DecodeChar(input[i + 2])
        let d = _b64DecodeChar(input[i + 3])
        result.push((a << 2) | (b >> 4))
        if input[i + 2] != 61 {
            result.push(((b & 15) << 4) | (c >> 2))
        }
        if input[i + 3] != 61 {
            result.push(((c & 3) << 6) | d)
        }
        i = i + 4
    }
    return result
}
`, "std/process.milo": `// std/process — command execution and process control

from "std/os" import { execl, exit, fork, kill, read, system, waitpid }
from "std/io" import { readFile }

// ── Simple command execution ──

// Execute a shell command and return its exit code.
// Example: let code = run("ls -la")!

fn run(cmd: &string): Result<i32> {
    unsafe {
        let status = system(cmd)
        if status < 0 {
            return Result.Err("system() failed")
        }
        // macOS: exit code is in bits 8-15
        let exitCode = (status >> 8) & 255
        return Result.Ok(exitCode)
    }
}

// ── Process with lifecycle management ──

// Handle to a spawned child process.

struct Process {
    pid: i32,
}

// Fork and exec a program at the given path.
// Returns a Process handle for lifecycle management.

fn spawn(path: &string): Result<Process> {
    unsafe {
        let pid = fork()
        if pid < 0 {
            return Result.Err("fork() failed")
        }
        if pid == 0 {
            execl(path, path, 0 as *u8)
            exit(127)
        }
        return Result.Ok(Process {
            pid: pid
        }
        )
    }
}

// Block until the process exits and return its exit code.

fn waitFor(p: &Process): Result<i32> {
    var statusBuf: [u8 ; 4] = [0 ; 4]
    unsafe {
        let r = waitpid(p.pid, statusBuf, 0)
        if r < 0 {
            return Result.Err("waitpid() failed")
        }
        let raw = (statusBuf[1]as i32)
        return Result.Ok(raw)
    }
}

// Execute a shell command and return its stdout as a string.
// Uses shell redirection to a temp file under the hood.

fn capture(cmd: &string): Result<string> {
    let tmpPath: string = "/tmp/.milo_capture"
    let fullCmd = cmd + " > " + tmpPath + " 2>&1"
    let code = run(fullCmd)!
    if code != 0 {
        return Result.Err("command failed with exit code")
    }
    let content = readFile(tmpPath)
    match content {
        Result.Ok(s) => {
            return Result.Ok(s)
        }
        Result.Err(e) => {
            return Result.Err("failed to read capture output")
        }
    }
}

// Send a signal to the process (e.g., 9 for SIGKILL, 15 for SIGTERM).

fn signal(p: &Process, sig: i32): Result<i32> {
    unsafe {
        let r = kill(p.pid, sig)
        if r < 0 {
            return Result.Err("kill() failed")
        }
        return Result.Ok(0)
    }
}
`, "std/sort.milo": `// std/sort — in-place sorting for Vec types

// Sort Vec<i64> in ascending order.

fn sortI64(v: &mut Vec<i64>): void {
    _qsortI64(v, 0, v.len - 1)
}

// Sort Vec<i32> in ascending order.

fn sortI32(v: &mut Vec<i32>): void {
    _qsortI32(v, 0 as i32, (v.len - 1) as i32)
}

// Sort Vec<string> in lexicographic order.

fn sortStrings(v: &mut Vec<string>): void {
    _isortStrings(v, 0, v.len - 1)
}

// Reverse a Vec<i64> in place.

fn reverseI64(v: &mut Vec<i64>): void {
    var lo: i64 = 0
    var hi = v.len - 1
    while lo < hi {
        let tmp = v[lo]
        v[lo] = v[hi]
        v[hi] = tmp
        lo = lo + 1
        hi = hi - 1
    }
}

// ── quicksort i64 ──

fn _qsortI64(v: &mut Vec<i64>, lo: i64, hi: i64): void {
    if lo >= hi {
        return
    }
    let pivot = v[hi]
    var i = lo
    var j = lo
    while j < hi {
        if v[j] <= pivot {
            let tmp = v[i]
            v[i] = v[j]
            v[j] = tmp
            i = i + 1
        }
        j = j + 1
    }
    let tmp = v[i]
    v[i] = v[hi]
    v[hi] = tmp
    _qsortI64(v, lo, i - 1)
    _qsortI64(v, i + 1, hi)
}

// ── quicksort i32 ──

fn _qsortI32(v: &mut Vec<i32>, lo: i32, hi: i32): void {
    if lo >= hi {
        return
    }
    let pivot = v[hi]
    var i = lo
    var j = lo
    while j < hi {
        if v[j] <= pivot {
            let tmp = v[i]
            v[i] = v[j]
            v[j] = tmp
            i = i + 1 as i32
        }
        j = j + 1 as i32
    }
    let tmp = v[i]
    v[i] = v[hi]
    v[hi] = tmp
    _qsortI32(v, lo, i - 1 as i32)
    _qsortI32(v, i + 1 as i32, hi)
}

// ── insertion sort for strings (stable, good for small n) ──

fn _strLessThan(a: &string, b: &string): bool {
    var i: i64 = 0
    while i < a.len && i < b.len {
        if a[i] < b[i] {
            return true
        }
        if a[i] > b[i] {
            return false
        }
        i = i + 1
    }
    return a.len < b.len
}

fn _isortStrings(v: &mut Vec<string>, lo: i64, hi: i64): void {
    if lo >= hi {
        return
    }
    var i = lo + 1
    while i <= hi {
        let key = v[i].clone()
        var j = i - 1
        while j >= lo {
            if _strLessThan(key, v[j]) {
                v[j + 1] = v[j].clone()
                j = j - 1
            } else {
                break
            }
        }
        v[j + 1] = key
        i = i + 1
    }
}
`, "std/net.milo": `// std/net — TCP, DNS, HTTP client with automatic cleanup

from "std/os" import { SSL_CTX_free, SSL_CTX_new, SSL_CTX_set_default_verify_paths, SSL_connect, SSL_ctrl, SSL_free, SSL_new, SSL_read, SSL_set_fd, SSL_write, TLS_client_method, close, connect, freeaddrinfo, getaddrinfo, read, socket, write }
from "std/platform" import { SockAddrIn, addrinfoAddrOffset, makeSockaddr }
from "std/json" import { Json, jsonParse }

// ── NetError ──

enum NetError {
    DnsFailure(string),
    ConnectionFailed(string),
    TlsError(string),
    SendFailed(string),
    Other(string),
}

// ── TcpStream ──

// TCP connection handle. Automatically closes the fd when dropped.

struct TcpStream {
    fd: i32,
}

impl Drop for TcpStream {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

// Construct an IPv4 address from four octets.
// Example: ip4(127, 0, 0, 1) for localhost.

fn ip4(a: u8, b: u8, c: u8, d: u8): u32 {
    let a32 = a as u32
    let b32 = b as u32
    let c32 = c as u32
    let d32 = d as u32
    return a32 | (b32 << 8) | (c32 << 16) | (d32 << 24)
}

fn tcpConnect(ip: u32, port: u16): Result<TcpStream, NetError> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let SIZEOF_SOCKADDR_IN: u32 = 16

    unsafe {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return Result.Err(NetError.ConnectionFailed("socket() failed"))
        }

        var addr = makeSockaddr(port, ip)

        if connect(fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            close(fd)
            return Result.Err(NetError.ConnectionFailed("connect() failed"))
        }

        return Result.Ok(TcpStream {
            fd: fd
        }
        )
    }
}

fn tcpSend(s: &TcpStream, data: &string): Result<i64, NetError> {
    unsafe {
        let n = write(s.fd, data, data.len)
        if n < 0 {
            return Result.Err(NetError.SendFailed("tcp send failed"))
        }
        return Result.Ok(n)
    }
}

fn tcpRecv(s: &TcpStream): Result<string, NetError> {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(s.fd, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

// ── TLS Stream ──

// TLS/SSL connection handle. Frees SSL context and closes fd on drop.

struct TlsStream {
    fd: i32,
    ssl: i64,
    ctx: i64,
}

impl Drop for TlsStream {
    fn drop(self: &mut Self): void {
        unsafe {
            if self.ssl != 0 {
                SSL_free(self.ssl as *u8)
            }
            if self.ctx != 0 {
                SSL_CTX_free(self.ctx as *u8)
            }
            if self.fd >= 0 {
                close(self.fd)
            }
        }
    }
}

fn tlsConnect(ip: u32, port: u16, hostname: &string): Result<TlsStream, NetError> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let SIZEOF_SOCKADDR_IN: u32 = 16

    unsafe {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return Result.Err(NetError.ConnectionFailed("socket() failed"))
        }

        var addr = makeSockaddr(port, ip)

        if connect(fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            close(fd)
            return Result.Err(NetError.ConnectionFailed("connect() failed"))
        }

        let method = TLS_client_method()
        let ctx = SSL_CTX_new(method)
        let ctxAddr = ctx as i64
        if ctxAddr == 0 {
            close(fd)
            return Result.Err(NetError.TlsError("SSL_CTX_new failed"))
        }
        SSL_CTX_set_default_verify_paths(ctx)

        let ssl = SSL_new(ctx)
        let sslAddr = ssl as i64
        if sslAddr == 0 {
            SSL_CTX_free(ctx)
            close(fd)
            return Result.Err(NetError.TlsError("SSL_new failed"))
        }

        // SNI hostname for certificate validation
        SSL_ctrl(ssl, 55, 0, hostname)
        SSL_set_fd(ssl, fd)

        let r = SSL_connect(ssl)
        if r != 1 {
            SSL_free(ssl)
            SSL_CTX_free(ctx)
            close(fd)
            return Result.Err(NetError.TlsError("SSL handshake failed"))
        }

        return Result.Ok(TlsStream {
            fd: fd, ssl: sslAddr, ctx: ctxAddr
        }
        )
    }
}

fn tlsSend(s: &TlsStream, data: &string): Result<i64, NetError> {
    unsafe {
        let n = SSL_write(s.ssl as *u8, data, data.len as i32)
        if n < 0 {
            return Result.Err(NetError.SendFailed("SSL_write failed"))
        }
        return Result.Ok(n as i64)
    }
}

fn tlsRecv(s: &TlsStream): Result<string, NetError> {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = SSL_read(s.ssl as *u8, buf as *u8, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n as i64 {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

// ── DNS ──

fn resolve(hostname: &string): Result<u32, NetError> {
    var hints: [u8 ; 48] = [0 ; 48]
    unsafe {
        let hintsFamily = (hints as *i32)
        hintsFamily[1] = 2
        hintsFamily[2] = 1
    }

    var resBuf: [u8 ; 8] = [0 ; 8]
    unsafe {
        let err = getaddrinfo(hostname, 0 as *u8, hints as *u8, resBuf as *u8)
        if err != 0 {
            return Result.Err(NetError.DnsFailure(hostname.clone()))
        }
        let infoPtr =*(resBuf as *i64)
        let addrPtr =*((infoPtr + addrinfoAddrOffset()) as *i64)
        let ip =*((addrPtr + 4) as *u32)
        freeaddrinfo(infoPtr as *u8)
        return Result.Ok(ip)
    }
}

// ── HTTP Response ──

// HTTP response with status code, headers, and body.

struct Response {
    status: i32,
    headers: string,
    body: string,
}

impl Response {
    // Return the response body as a string.
    fn text(self: &Self): string {
        return self.body.clone()
    }

    // Parse the response body as JSON.
    fn json(self: &Self): Json {
        return jsonParse(self.body.clone())
    }

    // Return true if the status code is 2xx (success).
    fn ok(self: &Self): bool {
        return self.status >= 200 && self.status < 300
    }

    // Look up a response header by name (case-insensitive).
    fn header(self: &Self, name: &string): string {
        return findHeader(self.headers, name)
    }
}

// ── String helpers ──

fn strEqNocase(a: &string, ai: i64, b: &string, blen: i64): bool {
    var i: i64 = 0
    while i < blen {
        var ca: u8 = a[ai + i]
        var cb: u8 = b[i]
        // lowercase ASCII
        if ca >= 'A' && ca <= 'Z' {
            ca = ca + 32
        }
        if cb >= 'A' && cb <= 'Z' {
            cb = cb + 32
        }
        if ca != cb {
            return false
        }
        i = i + 1
    }
    return true
}

fn findHeader(headers: &string, name: &string): string {
    // search for "Name: value" in headers (case-insensitive name match)
    var i: i64 = 0
    while i + name.len + 1 < headers.len {
        // check if we're at line start (i==0 or preceded by \\n)
        if i == 0 || headers[i - 1] == '\\n' {
            if strEqNocase(headers, i, name, name.len) && headers[i + name.len] == ':' {
                var start: i64 = i + name.len + 1
                // skip spaces after colon
                while start < headers.len && headers[start] == ' ' {
                    start = start + 1
                }
                var end: i64 = start
                while end < headers.len && headers[end] != '\\r' && headers[end] != '\\n' {
                    end = end + 1
                }
                return headers[start..end]
            }
        }
        i = i + 1
    }
    return ""
}

fn startsWith(s: &string, prefix: &string): bool {
    if s.len < prefix.len {
        return false
    }
    var i: i64 = 0
    while i < prefix.len {
        if s[i] != prefix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

fn hexDigit(c: u8): i64 {
    if c >= '0' && c <= '9' {
        return (c - '0') as i64
    }
    if c >= 'a' && c <= 'f' {
        return (c - 'a') as i64 + 10
    }
    if c >= 'A' && c <= 'F' {
        return (c - 'A') as i64 + 10
    }
    return - 1 as i64
}

// ── HTTP parsing ──

fn parseStatus(raw: &string): i32 {
    if raw.len < 12 {
        return 0
    }
    var code: i32 = 0
    var i: i64 = 9
    while i < raw.len && raw[i] >= '0' && raw[i] <= '9' {
        code = code * 10 + (raw[i]as i32 - 48)
        i = i + 1
    }
    return code
}

fn parseRawHeaders(raw: &string): string {
    var start: i64 = 0
    var i: i64 = 0
    while i + 1 < raw.len {
        if raw[i] == '\\r' && raw[i + 1] == '\\n' {
            if start == 0 {
                start = i + 2
            }
            if i + 3 < raw.len && raw[i + 2] == '\\r' && raw[i + 3] == '\\n' {
                return raw[start..i]
            }
        }
        i = i + 1
    }
    return ""
}

fn parseBody(raw: &string): string {
    var i: i64 = 0
    while i + 3 < raw.len {
        if raw[i] == '\\r' && raw[i + 1] == '\\n' && raw[i + 2] == '\\r' && raw[i + 3] == '\\n' {
            return raw[i + 4..raw.len]
        }
        i = i + 1
    }
    return raw.clone()
}

fn decodeChunked(rawBody: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < rawBody.len {
        // parse hex chunk size
        var chunkSize: i64 = 0
        while i < rawBody.len {
            let d = hexDigit(rawBody[i])
            if d < 0 {
                break
            }
            chunkSize = chunkSize * 16 + d
            i = i + 1
        }
        // skip \\r\\n after size
        if i + 1 < rawBody.len && rawBody[i] == '\\r' {
            i = i + 2
        }
        if chunkSize == 0 {
            break
        }
        // copy chunk data
        var j: i64 = 0
        while j < chunkSize && i < rawBody.len {
            result.push(rawBody[i])
            i = i + 1
            j = j + 1
        }
        // skip trailing \\r\\n
        if i + 1 < rawBody.len && rawBody[i] == '\\r' {
            i = i + 2
        }
    }
    return result
}

fn parseResponse(raw: string): Response {
    let status = parseStatus(raw)
    let headers = parseRawHeaders(raw)
    var body = parseBody(raw)
    // handle chunked transfer encoding
    let te = findHeader(headers, "Transfer-Encoding")
    let chunked: string = "chunked"
    if startsWith(te, chunked) {
        body = decodeChunked(body)
    }
    return Response {
        status: status, headers: headers, body: body
    }
}

// ── URL parsing ──

fn isHttps(url: &string): bool {
    return url.len > 8 && url[0] == 'h' && url[4] == 's' && url[5] == ':' && url[6] == '/' && url[7] == '/'
}

fn schemeOffset(url: &string): i64 {
    if isHttps(url) {
        return 8
    }
    if url.len > 7 && url[0] == 'h' && url[4] == ':' && url[5] == '/' && url[6] == '/' {
        return 7
    }
    return 0
}

fn parseHost(url: &string): string {
    let start = schemeOffset(url)
    var end: i64 = start
    while end < url.len && url[end] != '/' && url[end] != ':' {
        end = end + 1
    }
    return url[start..end]
}

fn parsePort(url: &string): u16 {
    var i: i64 = schemeOffset(url)
    while i < url.len && url[i] != '/' && url[i] != ':' {
        i = i + 1
    }
    if i < url.len && url[i] == ':' {
        i = i + 1
        var port: i32 = 0
        while i < url.len && url[i] >= '0' && url[i] <= '9' {
            port = port * 10 + (url[i]as i32 - 48)
            i = i + 1
        }
        return port as u16
    }
    if isHttps(url) {
        return 443
    }
    return 80
}

fn parsePath(url: &string): string {
    var i: i64 = schemeOffset(url)
    while i < url.len && url[i] != '/' {
        i = i + 1
    }
    if i >= url.len {
        return "/"
    }
    return url[i..url.len]
}

// ── FetchOptions ──

// HTTP request configuration: method, headers, and body.

struct FetchOptions {
    method: string,
    headers: string,
    body: string,
}

// ── HTTP client ──

fn httpDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError> {
    let stream = tcpConnect(ip, port)?
    var req: string = opts.method.clone() + " " + path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n"
    if opts.headers.len > 0 {
        req = req + opts.headers.clone() + "\\r\\n"
    }
    if opts.body.len > 0 {
        req = req + "Content-Length: " + opts.body.len.toString() + "\\r\\n\\r\\n" + opts.body.clone()
    } else {
        req = req + "\\r\\n"
    }
    tcpSend(stream, req)?
    let raw = tcpRecv(stream)?
    return Result.Ok(parseResponse(raw))
}

fn httpsDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError> {
    let stream = tlsConnect(ip, port, host)?
    var req: string = opts.method.clone() + " " + path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n"
    if opts.headers.len > 0 {
        req = req + opts.headers.clone() + "\\r\\n"
    }
    if opts.body.len > 0 {
        req = req + "Content-Length: " + opts.body.len.toString() + "\\r\\n\\r\\n" + opts.body.clone()
    } else {
        req = req + "\\r\\n"
    }
    tlsSend(stream, req)?
    let raw = tlsRecv(stream)?
    return Result.Ok(parseResponse(raw))
}

fn doFetch(url: string, opts: FetchOptions): Result<Response, NetError> {
    let useTls = isHttps(url)
    let host = parseHost(url)
    let port = parsePort(url)
    let path = parsePath(url)
    let ip = resolve(host)?

    var resp: Result<Response, NetError> = Result.Err(NetError.Other(""))
    if useTls {
        resp = httpsDo(ip, port, host.clone(), path, opts)
    } else {
        resp = httpDo(ip, port, host, path, opts)
    }

    let r = resp?

    // follow redirects (301, 302, 307, 308)
    if r.status == 301 || r.status == 302 || r.status == 307 || r.status == 308 {
        let loc = r.header("Location")
        if loc.len > 0 {
            var redirOpts = FetchOptions {
                method: opts.method.clone(),
                headers: opts.headers.clone(),
                body: opts.body.clone(),
            }
            if r.status == 301 || r.status == 302 {
                redirOpts.method = "GET"
                redirOpts.body = ""
            }
            return doFetch(loc, redirOpts)
        }
    }
    return Result.Ok(r)
}

// ── Public API ──

fn fetch(url: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "GET", headers: "", body: ""
    }
    return doFetch(url.clone(), opts)
}

fn fetchWith(url: &string, opts: FetchOptions): Result<Response, NetError> {
    return doFetch(url.clone(), opts)
}

fn fetchPost(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "POST",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url.clone(), opts)
}

fn fetchPut(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "PUT",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url.clone(), opts)
}

fn fetchDelete(url: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "DELETE", headers: "", body: ""
    }
    return doFetch(url.clone(), opts)
}

fn fetchPatch(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "PATCH",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url, opts)
}
`, "std/platform.linux.milo": `// platform-specific constants and helpers for Linux

from "std/os" import { htons }

struct SockAddrIn {
    sinFamily: u16,
    sinPort: u16,
    sinAddr: u32,
    sinZero: [u8 ; 8],
}

fn makeSockaddr(port: u16, addr: u32): SockAddrIn {
    unsafe {
        return SockAddrIn {
            sinFamily: 2 as u16,
            sinPort: htons(port),
            sinAddr: addr,
            sinZero: [0 ; 8],
        }
    }
}

fn makeZeroedSockaddr(): SockAddrIn {
    return SockAddrIn {
        sinFamily: 0 as u16, sinPort: 0, sinAddr: 0, sinZero: [0 ; 8],
    }
}

fn solSocket(): i32 {
    return 1
}

fn soReuseaddr(): i32 {
    return 2
}

fn mapPrivateAnon(): i32 {
    return 34
}

fn oWriteCreateTrunc(): i32 {
    return 577
}

fn oWriteCreateAppend(): i32 {
    return 1089
}
// offset of aiAddr field in struct addrinfo (swapped with aiCanonname vs macOS)

fn addrinfoAddrOffset(): i64 {
    return 24
}
// struct stat layout (Linux x8664)

fn statModeOffset(): i64 {
    return 24
}

fn statSizeOffset(): i64 {
    return 48
}

fn statBufSize(): i64 {
    return 144
}
// struct dirent layout

fn direntTypeOffset(): i64 {
    return 18
}

fn direntNameOffset(): i64 {
    return 19
}
// errno access — glibc uses __errno_location() to get errno pointer

extern

fn __errno_location(): *u8

fn getErrno(): i32 {
    unsafe {
        return _loadI32(__errno_location())
    }
}
`, "std/regex.milo": `// std/regex — regular expression matching (wraps POSIX regex.h)


extern

fn regcomp(_preg: *u8, _regex: *u8, _cflags: i32): i32

extern

fn regexec(_preg: *u8, _str: *u8, _nmatch: i64, _pmatch: *u8, _eflags: i32): i32

extern

fn regfree(_preg: *u8): void

// ── Regex handle ──

struct Regex {
    _preg: [u8 ; 128],
    _valid: bool,
}

// Compile a POSIX extended regular expression. Returns None on invalid pattern.

fn regexNew(pattern: string): Option<Regex> {
    var r = Regex {
        _preg: [0 ; 128], _valid: false
    }
    unsafe {
        let rc = regcomp(r._preg, pattern, 1)
        if rc != 0 {
            return Option.None
        }
    }
    r._valid = true
    return Option.Some(r)
}

fn _readMatchI64(buf: &[u8 ; 160], off: i64): i64 {
    var val: i64 = 0
    var k: i64 = 0
    while k < 8 {
        val = val | ((buf[off + k]as i64) << (k * 8))
        k = k + 1
    }
    return val
}

// Test if a string matches the pattern.

fn regexMatch(re: &mut Regex, input: &string): bool {
    unsafe {
        return regexec(re._preg, input, 0, 0 as *u8, 0) == 0
    }
}

// Match result: start and end byte offsets.

struct RegexMatch {
    start: i64,
    end: i64,
}

// Find the first match in a string. Returns None if no match.

fn regexFind(re: &mut Regex, input: &string): Option<RegexMatch> {
    var pmatch: [u8 ; 160] = [0 ; 160]
    unsafe {
        let rc = regexec(re._preg, input, 1, pmatch, 0)
        if rc != 0 {
            return Option.None
        }
    }
    let so = _readMatchI64(pmatch, 0)
    let eo = _readMatchI64(pmatch, 8)
    return Option.Some(RegexMatch {
        start: so, end: eo
    }
    )
}

// Find all non-overlapping matches in a string.

fn regexFindAll(re: &mut Regex, input: &string): Vec<RegexMatch> {
    var matches: Vec<RegexMatch> = Vec.new()
    var offset: i64 = 0
    var pmatch: [u8 ; 160] = [0 ; 160]
    while offset < input.len {
        let tail = input[offset..input.len]
        unsafe {
            let rc = regexec(re._preg, tail, 1, pmatch, 0)
            if rc != 0 {
                break
            }
        }
        let so = _readMatchI64(pmatch, 0)
        let eo = _readMatchI64(pmatch, 8)
        matches.push(RegexMatch {
            start: offset + so, end: offset + eo
        }
        )
        offset = offset + eo
        if so == eo {
            offset = offset + 1
        }
    }
    return matches
}
`, "std/time.milo": `// std/time — wall clock, monotonic timing, sleep


extern

fn gettimeofday(tv: *u8, tz: *u8): i32

extern

fn usleep(usec: u32): i32

// ── helpers ──

fn _readI64FromBuf(buf: &[u8 ; 16], off: i64): i64 {
    var val: i64 = 0
    var i: i64 = 0
    while i < 8 {
        val = val | ((buf[off + i]as i64) << (i * 8))
        i = i + 1
    }
    return val
}

// ── Instant — a point in time ──

struct Instant {
    sec: i64,
    usec: i64,
}

// Capture the current wall-clock time.

fn now(): Instant {
    var tv: [u8 ; 16] = [0 ; 16]
    unsafe {
        gettimeofday(tv, 0 as *u8)
    }
    let sec = _readI64FromBuf(tv, 0)
    let usec = _readI64FromBuf(tv, 8)
    return Instant {
        sec: sec, usec: usec
    }
}

// Milliseconds since Unix epoch.

fn epochMillis(): i64 {
    let t = now()
    return t.sec * 1000 + t.usec / 1000
}

// Seconds since Unix epoch.

fn epochSecs(): i64 {
    let t = now()
    return t.sec
}

// ── Duration — elapsed time between two Instants ──

struct Duration {
    totalUsec: i64,
}

// Elapsed time between two instants.

fn elapsed(start: Instant, end: Instant): Duration {
    let usec = (end.sec - start.sec) * 1000000 + (end.usec - start.usec)
    return Duration {
        totalUsec: usec
    }
}

// Elapsed time since an instant.

fn since(start: Instant): Duration {
    return elapsed(start, now())
}

// Duration accessors.

fn durationSecs(d: &Duration): i64 {
    return d.totalUsec / 1000000
}

fn durationMillis(d: &Duration): i64 {
    return d.totalUsec / 1000
}

fn durationMicros(d: &Duration): i64 {
    return d.totalUsec
}

// ── Sleep ──

// Sleep for the given number of milliseconds.

fn sleepMs(ms: i64): void {
    unsafe {
        usleep((ms * 1000) as u32)
    }
}

// Sleep for the given number of seconds.

fn sleepSecs(secs: i64): void {
    var remaining = secs
    while remaining > 0 {
        var chunk = remaining
        if chunk > 30 {
            chunk = 30
        }
        unsafe {
            usleep((chunk * 1000000) as u32)
        }
        remaining = remaining - chunk
    }
}
`, "std/url.milo": `// std/url — URL parsing into components


struct Url {
    scheme: string,
    host: string,
    port: i32,
    path: string,
    query: string,
    fragment: string,
    raw: string,
}

fn urlParse(s: string): Result<Url> {
    var scheme: string = ""
    var host: string = ""
    var port: i32 = 0
    var path: string = ""
    var query: string = ""
    var fragment: string = ""
    var i: i64 = 0

    // scheme
    var schemeEnd: i64 = 0
    while schemeEnd < s.len {
        if s[schemeEnd] == ':' {
            break
        }
        if s[schemeEnd] == '/' || s[schemeEnd] == '?' || s[schemeEnd] == '#' {
            break
        }
        schemeEnd = schemeEnd + 1
    }
    if schemeEnd < s.len && s[schemeEnd] == ':' {
        scheme = s[0..schemeEnd].clone()
        i = schemeEnd + 1
    }

    // authority (//host:port)
    if i + 1 < s.len && s[i] == '/' && s[i + 1] == '/' {
        i = i + 2
        let authStart = i
        while i < s.len && s[i] != '/' && s[i] != '?' && s[i] != '#' {
            i = i + 1
        }
        let auth = s[authStart..i]

        // split host:port
        var colonPos: i64 = - 1 as i64
        var j: i64 = auth.len - 1
        while j >= 0 {
            if auth[j] == ':' {
                colonPos = j
                break
            }
            if auth[j] == ']' {
                break
            }
            j = j - 1
        }

        if colonPos > 0 {
            host = auth[0..colonPos].clone()
            let portStr = auth[colonPos + 1..auth.len]
            port = _parsePort(portStr)
        } else {
            host = auth.clone()
        }
    }

    // path
    let pathStart = i
    while i < s.len && s[i] != '?' && s[i] != '#' {
        i = i + 1
    }
    path = s[pathStart..i].clone()

    // query
    if i < s.len && s[i] == '?' {
        i = i + 1
        let qStart = i
        while i < s.len && s[i] != '#' {
            i = i + 1
        }
        query = s[qStart..i].clone()
    }

    // fragment
    if i < s.len && s[i] == '#' {
        i = i + 1
        fragment = s[i..s.len].clone()
    }

    // default ports
    if port == 0 {
        if scheme == "http" { port = 80 }
        if scheme == "https" { port = 443 }
    }

    return Result.Ok(Url {
        scheme: scheme, host: host, port: port,
        path: path, query: query, fragment: fragment,
        raw: s.clone(),
    })
}

fn _parsePort(s: &string): i32 {
    var result: i32 = 0
    var i: i64 = 0
    while i < s.len {
        let c = s[i]
        if c < '0' || c > '9' { return 0 }
        result = result * 10 + (c as i32 - 48)
        i = i + 1
    }
    return result
}

fn urlQueryGet(u: &Url, key: &string): Option<string> {
    if u.query.len == 0 { return Option.None }
    var i: i64 = 0
    while i < u.query.len {
        let kStart = i
        while i < u.query.len && u.query[i] != '=' && u.query[i] != '&' {
            i = i + 1
        }
        let k = u.query[kStart..i]
        var val: string = ""
        if i < u.query.len && u.query[i] == '=' {
            i = i + 1
            let vStart = i
            while i < u.query.len && u.query[i] != '&' {
                i = i + 1
            }
            val = u.query[vStart..i].clone()
        }
        if _strEqUrl(k, key) {
            return Option.Some(val)
        }
        if i < u.query.len && u.query[i] == '&' {
            i = i + 1
        }
    }
    return Option.None
}

fn _strEqUrl(a: &string, b: &string): bool {
    if a.len != b.len { return false }
    var i: i64 = 0
    while i < a.len {
        if a[i] != b[i] { return false }
        i = i + 1
    }
    return true
}

fn urlString(u: &Url): string {
    var result: string = ""
    if u.scheme.len > 0 {
        result = result + u.scheme + "://"
    }
    result = result + u.host
    if u.port > 0 && u.port != 80 && u.port != 443 {
        result = result + ":" + format(u.port)
    }
    result = result + u.path
    if u.query.len > 0 {
        result = result + "?" + u.query
    }
    if u.fragment.len > 0 {
        result = result + "#" + u.fragment
    }
    return result
}
`, "std/string.milo": `// std/string — string utility functions

// Check if haystack contains needle.

fn strContains(haystack: &string, needle: &string): bool {
    if needle.len == 0 {
        return true
    }
    if needle.len > haystack.len {
        return false
    }
    var i: i64 = 0
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return true
        }
        i = i + 1
    }
    return false
}

// Find first occurrence of needle in haystack. Returns -1 if not found.

fn strIndexOf(haystack: &string, needle: &string): i64 {
    var notFound: i64 = 0
    notFound = notFound - 1
    if needle.len == 0 {
        return 0 as i64
    }
    if needle.len > haystack.len {
        return notFound
    }
    var i: i64 = 0
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return i
        }
        i = i + 1
    }
    return notFound
}

// Find first occurrence of needle starting at pos. Returns -1 if not found.

fn strIndexOfFrom(haystack: &string, needle: &string, pos: i64): i64 {
    var notFound: i64 = 0
    notFound = notFound - 1
    if needle.len == 0 {
        return pos
    }
    if pos < 0 as i64 {
        return notFound
    }
    if pos + needle.len > haystack.len {
        return notFound
    }
    var i: i64 = pos
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return i
        }
        i = i + 1
    }
    return notFound
}

// Check if string starts with prefix.

fn strStartsWith(s: &string, prefix: &string): bool {
    if prefix.len > s.len {
        return false
    }
    var i: i64 = 0
    while i < prefix.len {
        if s[i] != prefix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

// Check if string ends with suffix.

fn strEndsWith(s: &string, suffix: &string): bool {
    if suffix.len > s.len {
        return false
    }
    let offset = s.len - suffix.len
    var i: i64 = 0
    while i < suffix.len {
        if s[offset + i] != suffix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

// Return new string with ASCII uppercase letters converted to lowercase.

fn strToLower(s: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < s.len {
        let ch = s[i]
        if ch >= 65 && ch <= 90 {
            result.push(ch + 32)
        } else {
            result.push(ch)
        }
        i = i + 1
    }
    return result
}

// Return new string with ASCII lowercase letters converted to uppercase.

fn strToUpper(s: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < s.len {
        let ch = s[i]
        if ch >= 97 && ch <= 122 {
            result.push(ch - 32)
        } else {
            result.push(ch)
        }
        i = i + 1
    }
    return result
}

// Strip leading and trailing ASCII whitespace (space, tab, newline, carriage return).

fn strTrim(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    var end: i64 = s.len
    while end > start {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    if start >= end {
        return ""
    }
    return s.substr(start, end)
}

// Strip leading ASCII whitespace.

fn strTrimStart(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    if start >= s.len {
        return ""
    }
    return s.substr(start, s.len)
}

// Strip trailing ASCII whitespace.

fn strTrimEnd(s: &string): string {
    var end: i64 = s.len
    while end > 0 as i64 {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    if end <= 0 as i64 {
        return ""
    }
    return s.substr(0 as i64, end)
}

// Split string by separator. Returns Vec of substrings.

fn strSplit(s: &string, sep: &string): Vec<string> {
    var result: Vec<string> = Vec.new()
    var notFound: i64 = 0
    notFound = notFound - 1
    if sep.len == 0 {
        var i: i64 = 0
        while i < s.len {
            result.push(s.substr(i, i + 1))
            i = i + 1
        }
        return result
    }
    var pos: i64 = 0
    while pos <= s.len {
        let idx = strIndexOfFrom(s, sep, pos)
        if idx == notFound {
            result.push(s.substr(pos, s.len))
            break
        }
        result.push(s.substr(pos, idx))
        pos = idx + sep.len
    }
    return result
}

// Repeat a string n times.

fn strRepeat(s: &string, n: i64): string {
    var result: string = ""
    var i: i64 = 0
    while i < n {
        result = result + s
        i = i + 1
    }
    return result
}

// Replace all occurrences of old with newVal.

fn strReplace(s: &string, old: &string, newVal: &string): string {
    if old.len == 0 {
        return s.clone()
    }
    var notFound: i64 = 0
    notFound = notFound - 1
    var result: string = ""
    var pos: i64 = 0
    while pos < s.len {
        let idx = strIndexOfFrom(s, old, pos)
        if idx == notFound {
            result = result + s.substr(pos, s.len)
            break
        }
        if idx > pos {
            result = result + s.substr(pos, idx)
        }
        result = result + newVal
        pos = idx + old.len
    }
    return result
}

// Check if a byte is ASCII whitespace.

fn charIsWhitespace(ch: u8): bool {
    return ch == 32 || ch == 9 || ch == 10 || ch == 13
}

// Check if a byte is an ASCII digit.

fn charIsDigit(ch: u8): bool {
    return ch >= 48 && ch <= 57
}

// Check if a byte is an ASCII letter.

fn charIsAlpha(ch: u8): bool {
    return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
}

// Check if a byte is an ASCII letter or digit.

fn charIsAlphanumeric(ch: u8): bool {
    return charIsAlpha(ch) || charIsDigit(ch)
}

// Remove leading and trailing whitespace (spaces, tabs, newlines, carriage returns).

fn trim(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    var end: i64 = s.len
    while end > start {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    return s.substr(start, end)
}
`, "std/sqlite.milo": `// std/sqlite — SQLite3 database bindings
//
// Requires libsqlite3. Link flag added automatically by compiler.
//
//   let db = dbOpen("app.db")!
//   dbExec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")!
//   dbExec(db, "INSERT INTO users (name) VALUES ('alice')")!
//   let stmt = dbQuery(db, "SELECT id, name FROM users")!
//   while dbStep(stmt) {
//       print($"{dbColumnInt(stmt, 0)} {dbColumnText(stmt, 1)}")
//   }
//   dbFinalize(stmt)
//   dbClose(db)


extern fn sqlite3_open(filename: *u8, db: *u8): i32
extern fn sqlite3_close(db: *u8): i32
extern fn sqlite3_exec(db: *u8, sql: *u8, callback: *u8, arg: *u8, errmsg: *u8): i32
extern fn sqlite3_prepare_v2(db: *u8, sql: *u8, nByte: i32, stmt: *u8, tail: *u8): i32
extern fn sqlite3_step(stmt: *u8): i32
extern fn sqlite3_finalize(stmt: *u8): i32
extern fn sqlite3_column_int(stmt: *u8, col: i32): i32
extern fn sqlite3_column_int64(stmt: *u8, col: i32): i64
extern fn sqlite3_column_double(stmt: *u8, col: i32): f64
extern fn sqlite3_column_text(stmt: *u8, col: i32): *u8
extern fn sqlite3_column_count(stmt: *u8): i32
extern fn sqlite3_column_type(stmt: *u8, col: i32): i32
extern fn sqlite3_bind_int(stmt: *u8, idx: i32, val: i32): i32
extern fn sqlite3_bind_int64(stmt: *u8, idx: i32, val: i64): i32
extern fn sqlite3_bind_double(stmt: *u8, idx: i32, val: f64): i32
extern fn sqlite3_bind_text(stmt: *u8, idx: i32, text: *u8, n: i32, destructor: *u8): i32
extern fn sqlite3_bind_null(stmt: *u8, idx: i32): i32
extern fn sqlite3_reset(stmt: *u8): i32
extern fn sqlite3_errmsg(db: *u8): *u8
extern fn sqlite3_changes(db: *u8): i32
extern fn sqlite3_last_insert_rowid(db: *u8): i64

struct Database {
    _handle: *u8,
}

struct Statement {
    _handle: *u8,
    _db: *u8,
}

fn dbOpen(path: string): Result<Database> {
    unsafe {
        var handle: *u8 = 0 as *u8
        let rc = sqlite3_open(path, (&handle) as *u8)
        if rc != 0 {
            if handle != 0 as *u8 { sqlite3_close(handle) }
            return Result.Err("sqlite3_open failed")
        }
        return Result.Ok(Database { _handle: handle })
    }
}

fn dbClose(db: &Database): void {
    unsafe { sqlite3_close(db._handle) }
}

fn dbExec(db: &Database, sql: string): Result<i32> {
    unsafe {
        let rc = sqlite3_exec(db._handle, sql, 0 as *u8, 0 as *u8, 0 as *u8)
        if rc != 0 {
            let msg = _cstrToString(sqlite3_errmsg(db._handle))
            return Result.Err(msg)
        }
        return Result.Ok(sqlite3_changes(db._handle))
    }
}

fn dbQuery(db: &Database, sql: string): Result<Statement> {
    unsafe {
        var handle: *u8 = 0 as *u8
        let rc = sqlite3_prepare_v2(db._handle, sql, 0 - 1, (&handle) as *u8, 0 as *u8)
        if rc != 0 {
            let msg = _cstrToString(sqlite3_errmsg(db._handle))
            return Result.Err(msg)
        }
        return Result.Ok(Statement { _handle: handle, _db: db._handle })
    }
}

fn dbStep(stmt: &Statement): bool {
    unsafe { return sqlite3_step(stmt._handle) == 100 }
}

fn dbColumnInt(stmt: &Statement, col: i32): i32 {
    unsafe { return sqlite3_column_int(stmt._handle, col) }
}

fn dbColumnInt64(stmt: &Statement, col: i32): i64 {
    unsafe { return sqlite3_column_int64(stmt._handle, col) }
}

fn dbColumnFloat(stmt: &Statement, col: i32): f64 {
    unsafe { return sqlite3_column_double(stmt._handle, col) }
}

fn dbColumnText(stmt: &Statement, col: i32): string {
    unsafe {
        let ptr = sqlite3_column_text(stmt._handle, col)
        if ptr == 0 as *u8 { return "" }
        return _cstrToString(ptr)
    }
}

fn dbColumnCount(stmt: &Statement): i32 {
    unsafe { return sqlite3_column_count(stmt._handle) }
}

fn dbColumnIsNull(stmt: &Statement, col: i32): bool {
    unsafe { return sqlite3_column_type(stmt._handle, col) == 5 }
}

fn dbFinalize(stmt: &Statement): void {
    unsafe { sqlite3_finalize(stmt._handle) }
}

fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_int(stmt._handle, idx, val)
        if rc != 0 { return Result.Err("bind_int failed") }
        return Result.Ok(0)
    }
}

fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_int64(stmt._handle, idx, val)
        if rc != 0 { return Result.Err("bind_int64 failed") }
        return Result.Ok(0)
    }
}

fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_text(stmt._handle, idx, val, 0 - 1, (0 - 1) as *u8)
        if rc != 0 { return Result.Err("bind_text failed") }
        return Result.Ok(0)
    }
}

fn dbBindNull(stmt: &Statement, idx: i32): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_null(stmt._handle, idx)
        if rc != 0 { return Result.Err("bind_null failed") }
        return Result.Ok(0)
    }
}

fn dbReset(stmt: &Statement): void {
    unsafe { sqlite3_reset(stmt._handle) }
}

fn dbLastInsertId(db: &Database): i64 {
    unsafe { return sqlite3_last_insert_rowid(db._handle) }
}
`, "std/json.milo": `// std/json — zero-copy JSON parser with ergonomic accessors
//
// Quick usage:
//   let j = jsonParse(data)!
//   let name = j.str("name")!        // Option<string>
//   let age = j.i64("age")!          // Option<i64>
//   let nested = j.get("addr")!      // Option<Json>

struct Json {
    raw: string,
    start: i64,
    end: i64,
}

impl Json {
    // ── Keyed accessors (object fields) ──

    fn get(self: &Self, key: &string): Option<Json> {
        return jsonGetImpl(self.raw, self.start, self.end, key)
    }

    fn str(self: &Self, key: &string): Option<string> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isStr() {
                return Option.Some(jsonStrImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn i64(self: &Self, key: &string): Option<i64> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isNum() {
                return Option.Some(jsonIntImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn f64(self: &Self, key: &string): Option<f64> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isNum() {
                return Option.Some(jsonNumImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn bool(self: &Self, key: &string): Option<bool> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isBool() {
                return Option.Some(j.start < j.end && j.raw[j.start] == 't')
            }
        }
        return Option.None
    }

    // ── Bare value extraction (for array elements, after .get()) ──

    fn asStr(self: &Self): Option<string> {
        if self.isStr() {
            return Option.Some(jsonStrImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asI64(self: &Self): Option<i64> {
        if self.isNum() {
            return Option.Some(jsonIntImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asF64(self: &Self): Option<f64> {
        if self.isNum() {
            return Option.Some(jsonNumImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asBool(self: &Self): Option<bool> {
        if self.isBool() {
            return Option.Some(self.start < self.end && self.raw[self.start] == 't')
        }
        return Option.None
    }

    // ── Array access ──

    fn at(self: &Self, index: i64): Option<Json> {
        return jsonAtImpl(self.raw, self.start, self.end, index)
    }

    // ── Type checks ──

    fn isNull(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == 'n'
    }

    fn isStr(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '"'
    }

    fn isNum(self: &Self): bool {
        if self.start >= self.end {
            return false
        }
        let c = self.raw[self.start]
        return c == '-' || (c >= '0' && c <= '9')
    }

    fn isBool(self: &Self): bool {
        if self.start >= self.end {
            return false
        }
        let c = self.raw[self.start]
        return c == 't' || c == 'f'
    }

    fn isArray(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '['
    }

    fn isObject(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '{'
    }

    fn len(self: &Self): i64 {
        return jsonLenImpl(self.raw, self.start, self.end)
    }

    fn rawStr(self: &Self): string {
        return self.raw[self.start..self.end].clone()
    }

    // Return all keys of a JSON object.
    fn keys(self: &Self): Vec<string> {
        return jsonKeysImpl(self.raw, self.start, self.end)
    }
}

fn jsonParse(s: string): Result<Json> {
    if s.len == 0 {
        return Result.Err("empty input")
    }
    let i = skipWs(s, 0)
    if i >= s.len {
        return Result.Err("empty input")
    }
    let e = skipValue(s, i)
    let afterWs = skipWs(s, e)
    if afterWs != s.len {
        return Result.Err("trailing content")
    }
    if e == i {
        return Result.Err("invalid JSON")
    }
    return Result.Ok(Json {
        raw: s, start: i, end: e
    }
    )
}

// ── Internal helpers ──

fn skipWs(s: &string, pos: i64): i64 {
    var i: i64 = pos
    while i < s.len {
        let c = s[i]
        if c != ' ' && c != '\\t' && c != '\\n' && c != '\\r' {
            break
        }
        i = i + 1
    }
    return i
}

fn skipValue(s: &string, pos: i64): i64 {
    if pos >= s.len {
        return pos
    }
    let c = s[pos]
    if c == '"' {
        return skipString(s, pos)
    }
    if c == '{' {
        return skipObject(s, pos)
    }
    if c == '[' {
        return skipArray(s, pos)
    }
    if c == 't' {
        return pos + 4
    }
    if c == 'f' {
        return pos + 5
    }
    if c == 'n' {
        return pos + 4
    }
    return skipNumber(s, pos)
}

fn skipString(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    while i < s.len {
        if s[i] == '\\\\' {
            i = i + 2
        } else if s[i] == '"' {
            return i + 1
        } else {
            i = i + 1
        }
    }
    return i
}

fn skipNumber(s: &string, pos: i64): i64 {
    var i: i64 = pos
    if i < s.len && s[i] == '-' {
        i = i + 1
    }
    while i < s.len && s[i] >= '0' && s[i] <= '9' {
        i = i + 1
    }
    if i < s.len && s[i] == '.' {
        i = i + 1
        while i < s.len && s[i] >= '0' && s[i] <= '9' {
            i = i + 1
        }
    }
    if i < s.len && (s[i] == 'e' || s[i] == 'E') {
        i = i + 1
        if i < s.len && (s[i] == '+' || s[i] == '-') {
            i = i + 1
        }
        while i < s.len && s[i] >= '0' && s[i] <= '9' {
            i = i + 1
        }
    }
    return i
}

fn skipObject(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    i = skipWs(s, i)
    if i < s.len && s[i] == '}' {
        return i + 1
    }
    while i < s.len {
        i = skipWs(s, i)
        if i >= s.len || s[i] != '"' {
            break
        }
        i = skipString(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ',' {
            i = i + 1
        } else {
            break
        }
    }
    if i < s.len && s[i] == '}' {
        i = i + 1
    }
    return i
}

fn skipArray(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    i = skipWs(s, i)
    if i < s.len && s[i] == ']' {
        return i + 1
    }
    while i < s.len {
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ',' {
            i = i + 1
        } else {
            break
        }
    }
    if i < s.len && s[i] == ']' {
        i = i + 1
    }
    return i
}

fn keyMatches(s: &string, pos: i64, key: &string): bool {
    if pos >= s.len || s[pos] != '"' {
        return false
    }
    var i: i64 = 0
    var j: i64 = pos + 1
    while i < key.len && j < s.len {
        if s[j] == '\\\\' {
            j = j + 1
            if j >= s.len {
                return false
            }
        }
        if s[j] != key[i] {
            return false
        }
        i = i + 1
        j = j + 1
    }
    return i == key.len && j < s.len && s[j] == '"'
}

fn jsonGetImpl(s: &string, start: i64, end: i64, key: &string): Option<Json> {
    if start >= end || s[start] != '{' {
        return Option.None
    }
    var i: i64 = start + 1
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == '}' {
            return Option.None
        }
        let keyStart = i
        if s[i] != '"' {
            return Option.None
        }
        let keyEnd = skipString(s, i)
        let matched = keyMatches(s, keyStart, key)
        i = skipWs(s, keyEnd)
        if i < end && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        let valStart = i
        let valEnd = skipValue(s, i)
        if matched {
            return Option.Some(Json {
                raw: s.clone(), start: valStart, end: valEnd
            }
            )
        }
        i = skipWs(s, valEnd)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return Option.None
}

fn jsonAtImpl(s: &string, start: i64, end: i64, index: i64): Option<Json> {
    if start >= end || s[start] != '[' {
        return Option.None
    }
    var i: i64 = start + 1
    var idx: i64 = 0
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == ']' {
            return Option.None
        }
        let valStart = i
        let valEnd = skipValue(s, i)
        if idx == index {
            return Option.Some(Json {
                raw: s.clone(), start: valStart, end: valEnd
            }
            )
        }
        idx = idx + 1
        i = skipWs(s, valEnd)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return Option.None
}

fn jsonLenImpl(s: &string, start: i64, end: i64): i64 {
    if start >= end {
        return 0
    }
    let c = s[start]
    if c == '[' {
        var i: i64 = start + 1
        i = skipWs(s, i)
        if i < end && s[i] == ']' {
            return 0
        }
        var count: i64 = 0
        while i < end {
            i = skipWs(s, i)
            if i >= end || s[i] == ']' {
                break
            }
            i = skipValue(s, i)
            count = count + 1
            i = skipWs(s, i)
            if i < end && s[i] == ',' {
                i = i + 1
            }
        }
        return count
    }
    if c == '{' {
        var i: i64 = start + 1
        i = skipWs(s, i)
        if i < end && s[i] == '}' {
            return 0
        }
        var count: i64 = 0
        while i < end {
            i = skipWs(s, i)
            if i >= end || s[i] == '}' {
                break
            }
            i = skipString(s, i)
            i = skipWs(s, i)
            if i < end && s[i] == ':' {
                i = i + 1
            }
            i = skipWs(s, i)
            i = skipValue(s, i)
            count = count + 1
            i = skipWs(s, i)
            if i < end && s[i] == ',' {
                i = i + 1
            }
        }
        return count
    }
    return 0
}

fn jsonStrImpl(s: &string, start: i64, end: i64): string {
    if start >= end || s[start] != '"' {
        return ""
    }
    var result: string = ""
    var i: i64 = start + 1
    while i < end && s[i] != '"' {
        if s[i] == '\\\\' && i + 1 < end {
            i = i + 1
            let esc = s[i]
            if esc == 'n' {
                result.push('\\n')
            } 
            else if esc == 't' {
                result.push('\\t')
            } 
            else if esc == 'r' {
                result.push('\\r')
            } 
            else if esc == '"' {
                result.push('"')
            } 
            else if esc == '\\\\' {
                result.push('\\\\')
            } 
            else if esc == '/' {
                result.push('/')
            } 
            else {
                result.push(esc)
            }
        } else {
            result.push(s[i])
        }
        i = i + 1
    }
    return result
}

fn jsonNumImpl(s: &string, start: i64, end: i64): f64 {
    var result: f64 = 0.0
    var negative: bool = false
    var i: i64 = start
    if i < end && s[i] == '-' {
        negative = true
        i = i + 1
    }
    while i < end && s[i] >= '0' && s[i] <= '9' {
        result = result * 10.0 + (s[i]as i32 - 48) as f64
        i = i + 1
    }
    if i < end && s[i] == '.' {
        i = i + 1
        var frac: f64 = 0.1
        while i < end && s[i] >= '0' && s[i] <= '9' {
            result = result + (s[i]as i32 - 48) as f64 * frac
            frac = frac * 0.1
            i = i + 1
        }
    }
    if negative {
        result = 0.0 - result
    }
    return result
}

fn jsonIntImpl(s: &string, start: i64, end: i64): i64 {
    var result: i64 = 0
    var negative: bool = false
    var i: i64 = start
    if i < end && s[i] == '-' {
        negative = true
        i = i + 1
    }
    while i < end && s[i] >= '0' && s[i] <= '9' {
        result = result * 10 + (s[i]as i32 - 48) as i64
        i = i + 1
    }
    if negative {
        result = 0 - result
    }
    return result
}

fn jsonKeysImpl(s: &string, start: i64, end: i64): Vec<string> {
    var result: Vec<string> = Vec.new()
    if start >= end || s[start] != '{' {
        return result
    }
    var i: i64 = start + 1
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == '}' {
            break
        }
        if s[i] != '"' {
            break
        }
        let keyStart = i
        let keyEnd = skipString(s, i)
        let key = jsonStrImpl(s, keyStart, keyEnd)
        result.push(key)
        i = skipWs(s, keyEnd)
        if i < end && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return result
}
`, "std/platform.darwin.milo": `// platform-specific constants and helpers for macOS/BSD

from "std/os" import { htons }

struct SockAddrIn {
    sinLen: u8,
    sinFamily: u8,
    sinPort: u16,
    sinAddr: u32,
    sinZero: [u8 ; 8],
}

fn makeSockaddr(port: u16, addr: u32): SockAddrIn {
    unsafe {
        return SockAddrIn {
            sinLen: 16 as u8,
            sinFamily: 2 as u8,
            sinPort: htons(port),
            sinAddr: addr,
            sinZero: [0 ; 8],
        }
    }
}

fn makeZeroedSockaddr(): SockAddrIn {
    return SockAddrIn {
        sinLen: 0, sinFamily: 0, sinPort: 0, sinAddr: 0, sinZero: [0 ; 8],
    }
}

fn solSocket(): i32 {
    return 65535
}

fn soReuseaddr(): i32 {
    return 4
}

fn mapPrivateAnon(): i32 {
    return 4098
}

fn oWriteCreateTrunc(): i32 {
    return 1537
}

fn oWriteCreateAppend(): i32 {
    return 521
}
// offset of aiAddr field in struct addrinfo

fn addrinfoAddrOffset(): i64 {
    return 32
}
// struct stat layout (macOS aarch64/x8664)

fn statModeOffset(): i64 {
    return 4
}

fn statSizeOffset(): i64 {
    return 96
}

fn statBufSize(): i64 {
    return 144
}
// struct dirent layout

fn direntTypeOffset(): i64 {
    return 20
}

fn direntNameOffset(): i64 {
    return 21
}
// errno access — macOS uses __error() to get errno pointer

extern

fn __error(): *u8

fn getErrno(): i32 {
    unsafe {
        return _loadI32(__error())
    }
}
`, "std/fs.milo": `// std/fs — filesystem operations

from "std/os" import { access, closedir, opendir, read, readdir, stat }
from "std/io" import { IoError, openWrite, writeAll }
from "std/platform" import { direntNameOffset, direntTypeOffset, statBufSize, statModeOffset, statSizeOffset }

// File metadata from stat().

struct FileInfo {
    size: i64,
    mode: i32,
    exists: bool,
}

// Get file metadata. Returns FileInfo with exists=false if path doesn't exist.

fn fileInfo(path: &string): FileInfo {
    var buf: [u8 ; 144] = [0 ; 144]
    unsafe {
        let r = stat(path, buf)
        if r != 0 {
            return FileInfo {
                size: 0 as i64, mode: 0, exists: false
            }
        }
        let modeOff = statModeOffset()
        let sizeOff = statSizeOffset()
        // read u16 mode (macOS) — works for permission bits
        let modeLo = buf[modeOff]as i32
        let modeHi = buf[modeOff + 1]as i32
        let mode = modeLo | (modeHi << 8)
        // read i64 size
        var size: i64 = 0
        var i: i64 = 0
        while i < 8 {
            size = size | ((buf[sizeOff + i]as i64) << (i * 8))
            i = i + 1
        }
        return FileInfo {
            size: size, mode: mode, exists: true
        }
    }
}

// Check if a path exists.

fn pathExists(path: &string): bool {
    unsafe {
        return access(path, 0) == 0
    }
}

// Check if a path is a directory.

fn isDir(path: &string): bool {
    let info = fileInfo(path)
    if !info.exists {
        return false
    }
    // S_IFDIR = 0x4000 = 16384, S_IFMT = 0xF000 = 61440
    return (info.mode & 61440) == 16384
}

// Check if a path is a regular file.

fn isFile(path: &string): bool {
    let info = fileInfo(path)
    if !info.exists {
        return false
    }
    // S_IFREG = 0x8000 = 32768
    return (info.mode & 61440) == 32768
}

// Get file size in bytes. Returns -1 if file doesn't exist.

fn fileSizePath(path: &string): i64 {
    let info = fileInfo(path)
    var negOne: i64 = 0
    negOne = negOne - 1
    if !info.exists {
        return negOne
    }
    return info.size
}

// Directory entry from readDir().

struct DirEntry {
    name: string,
    isDir: bool,
    isFile: bool,
}

// List directory contents. Returns empty vec on error.

fn readDir(path: &string): Vec<DirEntry> {
    var entries: Vec<DirEntry> = Vec.new()
    unsafe {
        let dir = opendir(path)
        if dir as i64 == 0 as i64 {
            return entries
        }
        let nameOff = direntNameOffset()
        let typeOff = direntTypeOffset()
        while true {
            let ent = readdir(dir)
            if ent as i64 == 0 as i64 {
                break
            }
            let dType = _loadU8((ent as i64 + typeOff) as *u8)
            let namePtr = (ent as i64 + nameOff) as *u8
            let name = _cstrToString(namePtr)

            if name == "." || name == ".." {
                let skip = 0
            } else {
                // DT_DIR = 4, DT_REG = 8
                entries.push(DirEntry {
                    name: name,
                    isDir: dType == 4,
                    isFile: dType == 8,
                }
                )
            }
        }
        closedir(dir)
    }
    return entries
}

// Write a string to a file, creating or truncating it.

fn writeFile(path: &string, data: &string): Result<i64, IoError> {
    let f = openWrite(path)?
    return writeAll(f, data)
}
`, "std/hex.milo": `// std/hex — hex encode/decode for strings

fn _hexChar(val: u8): u8 {
    if val < 10 {
        return val + 48
    }
    return val - 10 + 97
}

fn _hexVal(ch: u8): u8 {
    if ch >= 48 && ch <= 57 {
        return ch - 48
    }
    if ch >= 97 && ch <= 102 {
        return ch - 97 + 10
    }
    if ch >= 65 && ch <= 70 {
        return ch - 65 + 10
    }
    return 0
}

// Encode a string as hex (each byte becomes two hex chars).

fn hexEncode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i < input.len {
        let b = input[i]
        result.push(_hexChar(b >> 4))
        result.push(_hexChar(b & 15))
        i = i + 1
    }
    return result
}

// Decode a hex string back to bytes.

fn hexDecode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 1 < input.len {
        let hi = _hexVal(input[i])
        let lo = _hexVal(input[i + 1])
        result.push(((hi << 4) | lo) as u8)
        i = i + 2
    }
    return result
}
`, "std/io.milo": `// std/io — file and directory I/O with automatic cleanup

from "std/os" import { close, lseek, open, read, strerror, write }
from "std/platform" import { getErrno, oWriteCreateAppend, oWriteCreateTrunc }

// ── IoError ──

enum IoError {
    NotFound(string),
    PermissionDenied(string),
    IsDirectory(string),
    AlreadyExists(string),
    Other(string),
}

// map errno to IoError variant with path context

fn _ioError(path: &string): IoError {
    unsafe {
        let e = getErrno()
        if e == 2 {
            return IoError.NotFound(path.clone())
        }
        if e == 13 {
            return IoError.PermissionDenied(path.clone())
        }
        if e == 21 {
            return IoError.IsDirectory(path.clone())
        }
        if e == 17 {
            return IoError.AlreadyExists(path.clone())
        }
        let reason = _cstrToString(strerror(e))
        return IoError.Other("'" + path + "': " + reason)
    }
}

// Write a string to stdout without appending a newline.

fn writeStdout(s: &string): void {
    unsafe {
        write(1, s, s.len)
    }
}

// ── File ──

// Owned file handle. Automatically closes the fd when dropped.

struct File {
    fd: i32,
}

impl Drop for File {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

fn openRead(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, 0)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn openWrite(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, oWriteCreateTrunc(), 420)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn openAppend(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, oWriteCreateAppend(), 420)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn fileSize(f: &File): i64 {
    unsafe {
        let cur = lseek(f.fd, 0, 1)
        let size = lseek(f.fd, 0, 2)
        lseek(f.fd, cur, 0)
        return size
    }
}

fn readAll(f: &File): Result<string, IoError> {
    let size = fileSize(f)
    if size < 0 {
        return Result.Err(IoError.Other("failed to get file size"))
    }
    unsafe {
        lseek(f.fd, 0, 0)
    }
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(f.fd, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

fn writeAll(f: &File, data: &string): Result<i64, IoError> {
    unsafe {
        let n = write(f.fd, data, data.len)
        if n < 0 {
            return Result.Err(IoError.Other("write failed"))
        }
        return Result.Ok(n)
    }
}

fn readFile(path: &string): Result<string, IoError> {
    let f = openRead(path)?
    return readAll(f)
}

// Write a string to stdout without a trailing newline.

fn writeStr(s: &string): void {
    unsafe { write(1, s, s.len) }
}

// Write a single byte to stdout.

fn putChar(ch: u8): void {
    var _pcBuf: [u8; 1] = [0; 1]
    _pcBuf[0] = ch
    unsafe { write(1, _pcBuf, 1) }
}

// Split a string into lines on newline boundaries.

fn splitLines(content: &string): Vec<string> {
    var result: Vec<string> = Vec.new()
    var cur = ""
    var idx: i64 = 0
    while idx < content.len {
        let byte = content[idx]
        if byte == 10 {
            result.push(cur)
            cur = ""
        } else {
            if byte != 13 {
                cur.push(byte)
            }
        }
        idx = idx + 1
    }
    if cur.len > 0 {
        result.push(cur)
    }
    return result
}

// Read a file and return its contents as a Vec of lines.

fn readLines(path: &string): Result<Vec<string>, IoError> {
    let content = readFile(path)?
    return Result.Ok(splitLines(content))
}

// Read a single line from a file descriptor (reads byte-by-byte until newline or EOF).

fn _readLineFd(fd: i32): Option<string> {
    var _rlBuf: [u8 ; 1] = [0 ; 1]
    var _rlResult = ""
    var _rlGot = false
    while true {
        unsafe {
            let n = read(fd, _rlBuf, 1)
            if n <= 0 {
                if _rlGot {
                    return Option.Some(_rlResult)
                }
                return Option.None
            }
        }
        _rlGot = true
        if _rlBuf[0] == 10 {
            return Option.Some(_rlResult)
        }
        if _rlBuf[0] != 13 {
            _rlResult.push(_rlBuf[0])
        }
    }
    return Option.None
}

// Read a single line from stdin. Returns None at EOF.

fn readLine(): Option<string> {
    return _readLineFd(0)
}

// Read all available data from stdin into a string.

fn readStdin(): string {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(0, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return result
}
` }[preludeKey] && !visited.has(preludeKey)) {
    visited.add(preludeKey);
    const prelude = new Parser(new Lexer({ "std/log.milo": `// std/log — logging to stderr with level tags

from "std/time" import { epochSecs }

fn _logMsg(tag: string, msg: string): void {
    let ts = epochSecs()
    eprint($"{tag} {ts.toString()} {msg}")
}

fn logDebug(msg: string): void {
    _logMsg("[DEBUG]", msg)
}

fn logInfo(msg: string): void {
    _logMsg("[INFO] ", msg)
}

fn logWarn(msg: string): void {
    _logMsg("[WARN] ", msg)
}

fn logError(msg: string): void {
    _logMsg("[ERROR]", msg)
}
`, "std/mem.milo": `// std/mem — memory management with automatic cleanup

from "std/os" import { free, malloc, mmap, munmap }
from "std/platform" import { mapPrivateAnon }

// ── MappedMemory ──

// Memory-mapped region. Automatically unmapped on drop.

struct MappedMemory {
    ptr: i64,
    len: i64,
}

impl Drop for MappedMemory {
    fn drop(self: &mut Self): void {
        if self.ptr != 0 {
            unsafe {
                munmap(self.ptr as *u8, self.len)
            }
        }
    }
}

// Allocate an anonymous (non-file-backed) memory-mapped region.

fn mmapAnon(size: i64): Result<MappedMemory> {
    let PROT_RW: i32 = 3
    var addr: i64 = 0
    unsafe {
        let p = mmap(0 as *u8, size, PROT_RW, mapPrivateAnon(), - 1, 0)
        addr = p as i64
    }
    let mapFailed: i64 = - 1 as i64
    if addr == mapFailed {
        return Result.Err("mmap failed")
    }
    return Result.Ok(MappedMemory {
        ptr: addr, len: size
    }
    )
}

// Memory-map a file descriptor for reading.

fn mmapFile(fFd: i32, size: i64): Result<MappedMemory> {
    let PROT_READ: i32 = 1
    let MAP_PRIVATE: i32 = 2
    var addr: i64 = 0
    unsafe {
        let p = mmap(0 as *u8, size, PROT_READ, MAP_PRIVATE, fFd, 0)
        addr = p as i64
    }
    let mapFailed: i64 = - 1 as i64
    if addr == mapFailed {
        return Result.Err("mmap failed")
    }
    return Result.Ok(MappedMemory {
        ptr: addr, len: size
    }
    )
}

// ── Arena ──

// Bump allocator with automatic cleanup.
// All allocations are 8-byte aligned. Use arenaReset() to reclaim without freeing.

struct Arena {
    base: i64,
    cap: i64,
    used: i64,
}

impl Drop for Arena {
    fn drop(self: &mut Self): void {
        if self.base != 0 {
            unsafe {
                free(self.base as *u8)
            }
        }
    }
}

// Create a new arena with the given capacity in bytes.

fn arenaNew(capacity: i64): Result<Arena> {
    unsafe {
        let p = malloc(capacity)
        let addr = p as i64
        if addr == 0 {
            return Result.Err("arena allocation failed")
        }
        return Result.Ok(Arena {
            base: addr, cap: capacity, used: 0
        }
        )
    }
}

// Allocate size bytes from the arena (8-byte aligned).
// Returns Err if the arena doesn't have enough space.

fn arenaAlloc(a: &mut Arena, size: i64): Result<i64> {
    // align to 8 bytes
    let seven: i64 = 7
    let aligned = (a.used + seven) & ~seven
    if aligned + size > a.cap {
        return Result.Err("arena out of memory")
    }
    let ptr = a.base + aligned
    a.used = aligned + size
    return Result.Ok(ptr)
}

// Reset the arena, making all previously allocated memory available for reuse.

fn arenaReset(a: &mut Arena): void {
    a.used = 0
}
`, "std/strconv.milo": `// std/strconv — string-to-number and number-to-string conversions

from "std/os" import { snprintf }

extern

fn strtol(str: *u8, endptr: *u8, base: i32): i64

extern

fn atof(str: *u8): f64

// Parse a decimal integer string. Returns None if not a valid integer.

fn parseInt(s: string): Option<i64> {
    if s.len == 0 {
        return Option.None
    }
    var start: i64 = 0
    if s[0] == 45 || s[0] == 43 {
        start = 1
    }
    if start >= s.len {
        return Option.None
    }
    var i = start
    while i < s.len {
        if s[i] < 48 || s[i] > 57 {
            return Option.None
        }
        i = i + 1
    }
    unsafe {
        return Option.Some(strtol(s, 0 as *u8, 10))
    }
}

// Parse an integer string with a given base (2, 8, 10, 16).

fn parseIntRadix(s: string, base: i32): Option<i64> {
    if s.len == 0 {
        return Option.None
    }
    unsafe {
        return Option.Some(strtol(s, 0 as *u8, base))
    }
}

// Parse a floating-point string. Returns None if not a valid number.

fn parseFloat(s: string): Option<f64> {
    if s.len == 0 {
        return Option.None
    }
    var start: i64 = 0
    if s[0] == 45 || s[0] == 43 {
        start = 1
    }
    if start >= s.len {
        return Option.None
    }
    // must start with digit or dot
    if (s[start] < 48 || s[start] > 57) && s[start] != 46 {
        return Option.None
    }
    unsafe {
        return Option.Some(atof(s))
    }
}

// Convert i64 to hexadecimal string (lowercase).

fn i64ToHex(n: i64): string {
    var buf: [u8 ; 32] = [0 ; 32]
    unsafe {
        snprintf(buf, 32, "%lx", n)
        return _cstrToString(buf as *u8)
    }
}

// Convert i64 to octal string.

fn i64ToOct(n: i64): string {
    var buf: [u8 ; 32] = [0 ; 32]
    unsafe {
        snprintf(buf, 32, "%lo", n)
        return _cstrToString(buf as *u8)
    }
}

// Convert i64 to binary string.

fn i64ToBin(n: i64): string {
    if n == 0 {
        return "0"
    }
    var result = ""
    var val = n
    while val > 0 {
        if (val & 1) == 1 {
            result = "1" + result
        } else {
            result = "0" + result
        }
        val = val >> 1
    }
    return result
}

// Format f64 with a specific number of decimal places.

fn formatFloat(n: f64, decimals: i32): string {
    var buf: [u8 ; 64] = [0 ; 64]
    unsafe {
        snprintf(buf, 64, "%.*f", decimals, n)
        return _cstrToString(buf as *u8)
    }
}
`, "std/fmt.milo": `// std/fmt — string formatting with {} placeholders
//
// Usage: fmt2("hello {}, you are {} years old", name, age.toString())
// Each {} is replaced left-to-right with the corresponding argument.

// Replace the first {} with val.

fn fmt1(template: &string, a: &string): string {
    var result = ""
    var used = false
    var i: i64 = 0
    while i < template.len {
        if !used && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            result = result + a.clone()
            used = true
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first two {} with a and b.

fn fmt2(template: &string, a: &string, b: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 2 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first three {} with a, b, and c.

fn fmt3(template: &string, a: &string, b: &string, c: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 3 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            if which == 2 {
                result = result + c.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Replace the first four {} with a, b, c, and d.

fn fmt4(template: &string, a: &string, b: &string, c: &string, d: &string): string {
    var result = ""
    var which = 0
    var i: i64 = 0
    while i < template.len {
        if which < 4 && template[i] == 123 && i + 1 < template.len && template[i + 1] == 125 {
            if which == 0 {
                result = result + a.clone()
            }
            if which == 1 {
                result = result + b.clone()
            }
            if which == 2 {
                result = result + c.clone()
            }
            if which == 3 {
                result = result + d.clone()
            }
            which = which + 1
            i = i + 2
        } else {
            result.push(template[i])
            i = i + 1
        }
    }
    return result
}

// Left-pad a string to a minimum width.

fn padLeft(s: &string, width: i64, ch: u8): string {
    var result = ""
    var padding = width - s.len
    while padding > 0 {
        result.push(ch)
        padding = padding - 1
    }
    result = result + s.clone()
    return result
}

// Right-pad a string to a minimum width.

fn padRight(s: &string, width: i64, ch: u8): string {
    var result = s.clone()
    var padding = width - s.len
    while padding > 0 {
        result.push(ch)
        padding = padding - 1
    }
    return result
}

// Zero-pad an integer to a minimum width.

fn zeroPad(n: i64, width: i64): string {
    let s = n.toString()
    return padLeft(s, width, 48 as u8)
}

// Join a Vec<string> with a separator.

fn join(parts: &Vec<string>, sep: &string): string {
    var result = ""
    var i: i64 = 0
    while i < parts.len {
        if i > 0 {
            result = result + sep.clone()
        }
        result = result + parts[i].clone()
        i = i + 1
    }
    return result
}
`, "std/random.milo": `// std/random — random number generation
//
// Uses arc4random (macOS/BSD) — no seeding required, cryptographically strong.
// For Linux compat, could fall back to /dev/urandom via std/io.


extern

fn arc4random(): u32

extern

fn arc4random_uniform(upper: u32): u32

extern

fn arc4random_buf(buf: *u8, nbytes: i64): void

// Random u32 in [0, 2^32).

fn randU32(): u32 {
    unsafe {
        return arc4random()
    }
}

// Random i64 in [0, max). Panics if max <= 0.

fn randInt(max: i64): i64 {
    if max <= 0 {
        eprint("randInt: max must be > 0")
    }
    unsafe {
        return arc4random_uniform(max as u32) as i64
    }
}

// Random i64 in [min, max]. Panics if min > max.

fn randRange(min: i64, max: i64): i64 {
    if min > max {
        eprint("randRange: min must be <= max")
    }
    let span = max - min + 1
    return min + randInt(span)
}

// Random f64 in [0.0, 1.0).

fn randFloat(): f64 {
    let r = randU32()
    return r as f64 / 4294967296.0
}

// Random f64 in [min, max).

fn randFloatRange(min: f64, max: f64): f64 {
    return min + randFloat() * (max - min)
}

// Random bool (coin flip).

fn randBool(): bool {
    return randInt(2) == 0
}

// Shuffle a Vec<i64> in place using Fisher-Yates. Pass v.len() as n.

fn shuffleI64(v: &mut Vec<i64>, n: i64): void {
    var i = n - 1
    while i > 0 {
        let j = randRange(0, i)
        let tmp = v[i]
        v[i] = v[j]
        v[j] = tmp
        i = i - 1
    }
}

// Fill a buffer with random bytes.

fn randBytes(buf: *u8, n: i64): void {
    unsafe {
        arc4random_buf(buf, n)
    }
}
`, "std/sync.milo": `// std/sync — synchronization primitives (mutex, channel) via pthreads

from "std/os" import { free, malloc, memcpy, pthread_cond_destroy, pthread_cond_init, pthread_cond_signal, pthread_cond_wait, pthread_mutex_destroy, pthread_mutex_init, pthread_mutex_lock, pthread_mutex_unlock }

// ── Mutex ──
// Mutual exclusion lock. Wrap shared data access with lock/unlock.
//
//   let m = mutexNew()!
//   mutexLock(m)!
//   // ... critical section ...
//   mutexUnlock(m)!
//   mutexDestroy(m)

struct Mutex {
    _handle: *u8,
}

fn mutexNew(): Result<Mutex> {
    unsafe {
        let h = malloc(64)
        let r = pthread_mutex_init(h, 0 as *u8)
        if r != 0 {
            free(h)
            return Result.Err("pthread_mutex_init failed")
        }
        return Result.Ok(Mutex { _handle: h })
    }
}

fn mutexLock(m: &Mutex): Result<i32> {
    unsafe {
        let r = pthread_mutex_lock(m._handle)
        if r != 0 {
            return Result.Err("pthread_mutex_lock failed")
        }
        return Result.Ok(0)
    }
}

fn mutexUnlock(m: &Mutex): Result<i32> {
    unsafe {
        let r = pthread_mutex_unlock(m._handle)
        if r != 0 {
            return Result.Err("pthread_mutex_unlock failed")
        }
        return Result.Ok(0)
    }
}

fn mutexDestroy(m: &Mutex): void {
    unsafe {
        pthread_mutex_destroy(m._handle)
        free(m._handle)
    }
}

// ── Channel ──
// Bounded FIFO channel for safe message passing between threads.
// Channel is a handle type — copying it shares the underlying queue.
// Safe to capture in move closures and send across threads.
//
//   let ch = channelNew(16)!
//   let t = spawn(move (): void => {
//       channelSend(ch, 42)!
//   })!
//   let val = channelRecv(ch)!
//   threadJoin(t)!
//   channelDestroy(ch)

// Inner layout at _ptr (64 bytes):
//   [0..8)   mutex handle
//   [8..16)  condNotEmpty handle
//   [16..24) condNotFull handle
//   [24..32) buf pointer
//   [32..40) capacity
//   [40..48) len
//   [48..56) head
//   [56..64) tail

struct Channel {
    _ptr: *u8,
}

fn channelNew(capacity: i64): Result<Channel> {
    unsafe {
        let inner = malloc(64)

        let mtx = malloc(64)
        let r1 = pthread_mutex_init(mtx, 0 as *u8)
        if r1 != 0 {
            free(mtx)
            free(inner)
            return Result.Err("channel mutex init failed")
        }
        let cne = malloc(48)
        let r2 = pthread_cond_init(cne, 0 as *u8)
        if r2 != 0 {
            free(mtx)
            free(cne)
            free(inner)
            return Result.Err("channel cond init failed")
        }
        let cnf = malloc(48)
        let r3 = pthread_cond_init(cnf, 0 as *u8)
        if r3 != 0 {
            free(mtx)
            free(cne)
            free(cnf)
            free(inner)
            return Result.Err("channel cond init failed")
        }
        let buf = malloc(capacity * 8)

        var zero: i64 = 0
        // store pointers and initial values into inner block
        memcpy(inner, (&mtx) as *u8, 8)
        memcpy((inner as i64 + 8) as *u8, (&cne) as *u8, 8)
        memcpy((inner as i64 + 16) as *u8, (&cnf) as *u8, 8)
        memcpy((inner as i64 + 24) as *u8, (&buf) as *u8, 8)
        memcpy((inner as i64 + 32) as *u8, (&capacity) as *u8, 8)
        memcpy((inner as i64 + 40) as *u8, (&zero) as *u8, 8)
        memcpy((inner as i64 + 48) as *u8, (&zero) as *u8, 8)
        memcpy((inner as i64 + 56) as *u8, (&zero) as *u8, 8)

        return Result.Ok(Channel { _ptr: inner })
    }
}

fn channelSend(ch: &Channel, val: i64): Result<i32> {
    var v: i64 = val
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var condNE: *u8 = 0 as *u8
        memcpy((&condNE) as *u8, (base + 8) as *u8, 8)
        var condNF: *u8 = 0 as *u8
        memcpy((&condNF) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        var cap: i64 = 0
        memcpy((&cap) as *u8, (base + 32) as *u8, 8)
        var curLen: i64 = 0
        var tail: i64 = 0

        pthread_mutex_lock(mtx)
        memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        while curLen == cap {
            pthread_cond_wait(condNF, mtx)
            memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        }
        memcpy((&tail) as *u8, (base + 56) as *u8, 8)
        let slotPtr = (buf as i64 + tail * 8) as *u8
        memcpy(slotPtr, (&v) as *u8, 8)
        tail = (tail + 1) % cap
        curLen = curLen + 1
        memcpy((base + 56) as *u8, (&tail) as *u8, 8)
        memcpy((base + 40) as *u8, (&curLen) as *u8, 8)
        pthread_cond_signal(condNE)
        pthread_mutex_unlock(mtx)
        return Result.Ok(0)
    }
}

fn channelRecv(ch: &Channel): Result<i64> {
    var val: i64 = 0
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var condNE: *u8 = 0 as *u8
        memcpy((&condNE) as *u8, (base + 8) as *u8, 8)
        var condNF: *u8 = 0 as *u8
        memcpy((&condNF) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        var cap: i64 = 0
        memcpy((&cap) as *u8, (base + 32) as *u8, 8)
        var curLen: i64 = 0
        var head: i64 = 0

        pthread_mutex_lock(mtx)
        memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        while curLen == 0 {
            pthread_cond_wait(condNE, mtx)
            memcpy((&curLen) as *u8, (base + 40) as *u8, 8)
        }
        memcpy((&head) as *u8, (base + 48) as *u8, 8)
        let slotPtr = (buf as i64 + head * 8) as *u8
        memcpy((&val) as *u8, slotPtr, 8)
        head = (head + 1) % cap
        curLen = curLen - 1
        memcpy((base + 48) as *u8, (&head) as *u8, 8)
        memcpy((base + 40) as *u8, (&curLen) as *u8, 8)
        pthread_cond_signal(condNF)
        pthread_mutex_unlock(mtx)
        return Result.Ok(val)
    }
}

fn channelDestroy(ch: &Channel): void {
    unsafe {
        let base = ch._ptr as i64
        var mtx: *u8 = 0 as *u8
        memcpy((&mtx) as *u8, ch._ptr, 8)
        var cne: *u8 = 0 as *u8
        memcpy((&cne) as *u8, (base + 8) as *u8, 8)
        var cnf: *u8 = 0 as *u8
        memcpy((&cnf) as *u8, (base + 16) as *u8, 8)
        var buf: *u8 = 0 as *u8
        memcpy((&buf) as *u8, (base + 24) as *u8, 8)
        pthread_mutex_destroy(mtx)
        pthread_cond_destroy(cne)
        pthread_cond_destroy(cnf)
        free(mtx)
        free(cne)
        free(cnf)
        free(buf)
        free(ch._ptr)
    }
}
`, "std/toml.milo": `// std/toml — TOML config file parser
//
//   let t = tomlParse(data)!
//   let name = t.str("name")!
//   let port = t.i64("port")!
//   let db = t.table("database")!
//   let host = db.str("host")!

from "std/os" import { read }

struct Toml {
    raw: string,
    start: i64,
    end: i64,
}

impl Toml {
    fn str(self: &Self, key: &string): Option<string> {
        return tomlGetStr(self.raw, self.start, self.end, key)
    }

    fn i64(self: &Self, key: &string): Option<i64> {
        return tomlGetI64(self.raw, self.start, self.end, key)
    }

    fn f64(self: &Self, key: &string): Option<f64> {
        return tomlGetF64(self.raw, self.start, self.end, key)
    }

    fn bool(self: &Self, key: &string): Option<bool> {
        return tomlGetBool(self.raw, self.start, self.end, key)
    }

    fn table(self: &Self, key: &string): Option<Toml> {
        return tomlGetTable(self.raw, self.start, self.end, key)
    }
}

fn tomlParse(s: string): Result<Toml> {
    if s.len == 0 {
        return Result.Err("empty input")
    }
    let n = s.len
    return Result.Ok(Toml { raw: s, start: 0, end: n })
}

// ── Internal helpers ──

fn _tomlSkipWs(s: &string, pos: i64, end: i64): i64 {
    var i = pos
    while i < end {
        let c = s[i]
        if c == ' ' || c == '\\t' || c == '\\r' {
            i = i + 1
        } else if c == '#' {
            while i < end && s[i] != '\\n' { i = i + 1 }
        } else {
            break
        }
    }
    return i
}

fn _tomlSkipLine(s: &string, pos: i64, end: i64): i64 {
    var i = pos
    while i < end && s[i] != '\\n' { i = i + 1 }
    if i < end { i = i + 1 }
    return i
}

fn _tomlKeyMatches(s: &string, pos: i64, end: i64, key: &string): bool {
    var i = pos
    var j: i64 = 0
    // bare key
    while i < end && j < key.len {
        if s[i] != key[j] { return false }
        i = i + 1
        j = j + 1
    }
    if j != key.len { return false }
    // next non-ws char must be '='
    let after = _tomlSkipWs(s, i, end)
    return after < end && s[after] == '='
}

fn _tomlReadValue(s: &string, pos: i64, end: i64): i64 {
    // return end position of the value
    var i = pos
    if i >= end { return i }
    let c = s[i]
    if c == '"' {
        // quoted string
        i = i + 1
        while i < end && s[i] != '"' {
            if s[i] == '\\\\' { i = i + 1 }
            i = i + 1
        }
        if i < end { i = i + 1 }
        return i
    }
    if c == '\\'' {
        // literal string
        i = i + 1
        while i < end && s[i] != '\\'' { i = i + 1 }
        if i < end { i = i + 1 }
        return i
    }
    if c == '[' {
        // inline array — skip until matching ]
        var depth: i32 = 1
        i = i + 1
        while i < end && depth > 0 {
            if s[i] == '[' { depth = depth + 1 }
            if s[i] == ']' { depth = depth - 1 }
            if s[i] == '"' {
                i = i + 1
                while i < end && s[i] != '"' {
                    if s[i] == '\\\\' { i = i + 1 }
                    i = i + 1
                }
            }
            i = i + 1
        }
        return i
    }
    // bare value (number, bool, date) — read until newline or comment
    while i < end && s[i] != '\\n' && s[i] != '#' {
        i = i + 1
    }
    // trim trailing whitespace
    while i > pos && (s[i - 1] == ' ' || s[i - 1] == '\\t' || s[i - 1] == '\\r') {
        i = i - 1
    }
    return i
}

fn _tomlFindKey(s: &string, start: i64, end: i64, key: &string): Option<Toml> {
    var i = start
    while i < end {
        i = _tomlSkipWs(s, i, end)
        if i >= end { break }
        if s[i] == '\\n' {
            i = i + 1
            continue
        }
        // table header [name] — stop scanning if we hit one
        if s[i] == '[' { break }
        if _tomlKeyMatches(s, i, end, key) {
            // skip key and =
            var j = i
            while j < end && s[j] != '=' { j = j + 1 }
            j = j + 1
            j = _tomlSkipWs(s, j, end)
            let valStart = j
            let valEnd = _tomlReadValue(s, j, end)
            return Option.Some(Toml { raw: s.clone(), start: valStart, end: valEnd })
        }
        i = _tomlSkipLine(s, i, end)
    }
    return Option.None
}

fn tomlGetStr(s: &string, start: i64, end: i64, key: &string): Option<string> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        if t.start < t.end && (t.raw[t.start] == '"' || t.raw[t.start] == '\\'') {
            let quote = t.raw[t.start]
            var result: string = ""
            var i = t.start + 1
            while i < t.end - 1 {
                if t.raw[i] == '\\\\' && quote == '"' && i + 1 < t.end - 1 {
                    i = i + 1
                    let esc = t.raw[i]
                    if esc == 'n' { result.push('\\n') }
                    else if esc == 't' { result.push('\\t') }
                    else if esc == 'r' { result.push('\\r') }
                    else if esc == '"' { result.push('"') }
                    else if esc == '\\\\' { result.push('\\\\') }
                    else { result.push(esc) }
                } else {
                    result.push(t.raw[i])
                }
                i = i + 1
            }
            return Option.Some(result)
        }
        // bare string
        return Option.Some(t.raw[t.start..t.end].clone())
    }
    return Option.None
}

fn tomlGetI64(s: &string, start: i64, end: i64, key: &string): Option<i64> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        var result: i64 = 0
        var negative: bool = false
        var i = t.start
        if i < t.end && t.raw[i] == '-' {
            negative = true
            i = i + 1
        }
        if i < t.end && t.raw[i] == '+' { i = i + 1 }
        while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
            result = result * 10 + (t.raw[i] as i32 - 48) as i64
            i = i + 1
        }
        if negative { result = 0 - result }
        return Option.Some(result)
    }
    return Option.None
}

fn tomlGetF64(s: &string, start: i64, end: i64, key: &string): Option<f64> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        var result: f64 = 0.0
        var negative: bool = false
        var i = t.start
        if i < t.end && t.raw[i] == '-' {
            negative = true
            i = i + 1
        }
        if i < t.end && t.raw[i] == '+' { i = i + 1 }
        while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
            result = result * 10.0 + (t.raw[i] as i32 - 48) as f64
            i = i + 1
        }
        if i < t.end && t.raw[i] == '.' {
            i = i + 1
            var frac: f64 = 0.1
            while i < t.end && t.raw[i] >= '0' && t.raw[i] <= '9' {
                result = result + (t.raw[i] as i32 - 48) as f64 * frac
                frac = frac * 0.1
                i = i + 1
            }
        }
        if negative { result = 0.0 - result }
        return Option.Some(result)
    }
    return Option.None
}

fn tomlGetBool(s: &string, start: i64, end: i64, key: &string): Option<bool> {
    let v = _tomlFindKey(s, start, end, key)
    if let Option.Some(t) = v {
        if t.end - t.start == 4 && t.raw[t.start] == 't' {
            return Option.Some(true)
        }
        if t.end - t.start == 5 && t.raw[t.start] == 'f' {
            return Option.Some(false)
        }
    }
    return Option.None
}

fn tomlGetTable(s: &string, start: i64, end: i64, key: &string): Option<Toml> {
    // search for [key] header
    var i = start
    while i < end {
        i = _tomlSkipWs(s, i, end)
        if i >= end { break }
        if s[i] == '\\n' {
            i = i + 1
            continue
        }
        if s[i] == '[' && (i + 1 >= end || s[i + 1] != '[') {
            let hdrStart = i + 1
            var hdrEnd = hdrStart
            while hdrEnd < end && s[hdrEnd] != ']' { hdrEnd = hdrEnd + 1 }
            let hdrName = s[hdrStart..hdrEnd]
            if _strEq(hdrName, key) {
                // table body: from next line until next [header] or EOF
                let bodyStart = _tomlSkipLine(s, hdrEnd + 1, end)
                var bodyEnd = bodyStart
                var j = bodyStart
                while j < end {
                    j = _tomlSkipWs(s, j, end)
                    if j >= end { break }
                    if s[j] == '\\n' {
                        j = j + 1
                        continue
                    }
                    if s[j] == '[' {
                        bodyEnd = j
                        break
                    }
                    j = _tomlSkipLine(s, j, end)
                    bodyEnd = j
                }
                if j >= end { bodyEnd = end }
                return Option.Some(Toml { raw: s.clone(), start: bodyStart, end: bodyEnd })
            }
        }
        i = _tomlSkipLine(s, i, end)
    }
    return Option.None
}

fn _strEq(a: &string, b: &string): bool {
    if a.len != b.len { return false }
    var i: i64 = 0
    while i < a.len {
        if a[i] != b[i] { return false }
        i = i + 1
    }
    return true
}
`, "std/unicode.milo": `// std/unicode — character classification and case conversion
//
// Currently ASCII-only. UTF-8 multi-byte codepoint support deferred.

// Classify ASCII bytes.

fn isAscii(ch: u8): bool {
    return ch < 128
}

fn isDigit(ch: u8): bool {
    return ch >= 48 && ch <= 57
}

fn isLower(ch: u8): bool {
    return ch >= 97 && ch <= 122
}

fn isUpper(ch: u8): bool {
    return ch >= 65 && ch <= 90
}

fn isAlpha(ch: u8): bool {
    return isLower(ch) || isUpper(ch)
}

fn isAlphanumeric(ch: u8): bool {
    return isAlpha(ch) || isDigit(ch)
}

fn isWhitespace(ch: u8): bool {
    return ch == 32 || ch == 9 || ch == 10 || ch == 13 || ch == 12
}

fn isPunctuation(ch: u8): bool {
    return (ch >= 33 && ch <= 47) || (ch >= 58 && ch <= 64) || (ch >= 91 && ch <= 96) || (ch >= 123 && ch <= 126)
}

fn isHexDigit(ch: u8): bool {
    return isDigit(ch) || (ch >= 97 && ch <= 102) || (ch >= 65 && ch <= 70)
}

fn isPrintable(ch: u8): bool {
    return ch >= 32 && ch < 127
}

fn isControl(ch: u8): bool {
    return ch < 32 || ch == 127
}

// Case conversion for ASCII bytes.

fn toLowerChar(ch: u8): u8 {
    if isUpper(ch) {
        return ch + 32
    }
    return ch
}

fn toUpperChar(ch: u8): u8 {
    if isLower(ch) {
        return ch - 32
    }
    return ch
}

// Check if an entire string is numeric (all digits).

fn isNumeric(s: &string): bool {
    if s.len == 0 {
        return false
    }
    var i: i64 = 0
    while i < s.len {
        if !isDigit(s[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

// Check if an entire string is alphabetic.

fn isAlphaStr(s: &string): bool {
    if s.len == 0 {
        return false
    }
    var i: i64 = 0
    while i < s.len {
        if !isAlpha(s[i]) {
            return false
        }
        i = i + 1
    }
    return true
}
`, "std/env.milo": `// std/env — environment variable access

from "std/os" import { getenv }

// Get an environment variable. Returns None if not set.

fn getEnv(name: string): Option<string> {
    unsafe {
        let ptr = getenv(name)
        if ptr as i64 == 0 as i64 {
            return Option.None
        }
        return Option.Some(_cstrToString(ptr))
    }
}

// Get an environment variable with a default value.

fn getEnvOr(name: string, defaultVal: string): string {
    match getEnv(name) {
        Option.Some(val) => {
            return val
        }
        Option.None => {
            return defaultVal
        }
    }
}
`, "std/arena.milo": `// std/arena — generational arena for cyclic and graph data structures
//
// Handles are freely copyable and storable (unlike &T).
// Generation checks detect use-after-free at runtime.
//
// Handle<T> carries a phantom type param so handles from one arena cannot
// accidentally be used with another arena of a different element type.
// Returning &T is forbidden by second-class refs; mutation goes through
// arenaSet (full overwrite) or arenaModify (closure on current value).

// Opaque handle to an arena slot. Safe to copy, store, and return.
// T is phantom — not stored, only used for type-checking handle/arena pairs.

@derive(Eq)
struct Handle<T> {
    index: i32,
    generation: i32,
}

// Generational arena backed by Vec<T>.

struct Arena<T> {
    data: Vec<T>,
    gens: Vec<i32>,
    freeList: Vec<i32>,
    live: i64,
}

// Create a new empty arena.

fn arenaNew<T> (): Arena<T> {
    var a: Arena<T> = Arena {
        data: Vec.new(),
        gens: Vec.new(),
        freeList: Vec.new(),
        live: 0,
    }
    return a
}

// Insert a value and return a handle to it.

fn arenaAlloc<T> (a: &mut Arena<T>, val: T): Handle<T> {
    if a.freeList.len > 0 {
        let fi = a.freeList[a.freeList.len - 1]
        a.freeList.pop()
        let idx = fi as i64
        a.data[idx] = val
        let gen = a.gens[idx]
        a.live = a.live + 1
        var h: Handle<T> = Handle {
            index: fi, generation: gen
        }
        return h
    }
    let idx = a.data.len
    a.data.push(val)
    a.gens.push(1)
    a.live = a.live + 1
    var h: Handle<T> = Handle {
        index: idx as i32, generation: 1
    }
    return h
}

// Check whether a handle is still valid.

fn arenaValid<T> (a: &Arena<T>, h: Handle<T>): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    return a.gens[idx] == h.generation
}

// Free a slot, bumping its generation so stale handles are detected.

fn arenaFree<T> (a: &mut Arena<T>, h: Handle<T>): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.gens[idx] = a.gens[idx] + 1
    a.freeList.push(h.index)
    a.live = a.live - 1
    return true
}

// Get a copy of the value at a handle. Returns None if the handle is stale.
// Returns by value, not &T, because second-class refs cannot be stored in
// Option<_>. For large T, prefer arenaModify to avoid the copy churn.

fn arenaGet<T> (a: &Arena<T>, h: Handle<T>): Option<T> {
    let idx = h.index as i64
    if idx < 0 {
        return Option.None
    }
    if idx >= a.data.len {
        return Option.None
    }
    if a.gens[idx] != h.generation {
        return Option.None
    }
    return Option.Some(a.data[idx])
}

// Overwrite the value at a handle. Returns false if the handle is stale.

fn arenaSet<T> (a: &mut Arena<T>, h: Handle<T>, val: T): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.data[idx] = val
    return true
}

// In-place update via closure. Avoids the manual get/modify/set dance and
// is the recommended way to mutate a single field of an arena value.
// Returns false if the handle is stale (closure not invoked).

fn arenaModify<T> (a: &mut Arena<T>, h: Handle<T>, f: (T) => T): bool {
    let idx = h.index as i64
    if idx < 0 {
        return false
    }
    if idx >= a.data.len {
        return false
    }
    if a.gens[idx] != h.generation {
        return false
    }
    a.data[idx] = f(a.data[idx])
    return true
}

// Number of live entries.

fn arenaLen<T> (a: &Arena<T>): i64 {
    return a.live
}

// Method API — same functionality, nicer syntax.

impl Arena<T> {
    fn alloc(self: &mut Self, val: T): Handle<T> {
        return arenaAlloc(self, val)
    }

    fn get(self: &Self, h: Handle<T>): Option<T> {
        return arenaGet(self, h)
    }

    fn set(self: &mut Self, h: Handle<T>, val: T): bool {
        return arenaSet(self, h, val)
    }

    fn modify(self: &mut Self, h: Handle<T>, f: (T) => T): bool {
        return arenaModify(self, h, f)
    }

    fn free(self: &mut Self, h: Handle<T>): bool {
        return arenaFree(self, h)
    }

    fn valid(self: &Self, h: Handle<T>): bool {
        return arenaValid(self, h)
    }
}

`, "std/http.milo": `// std/http — high-level HTTP server for Milo

from "std/os" import { accept, bind, close, getsockname, listen, ntohs, read, setsockopt, socket, write }
from "std/platform" import { SockAddrIn, makeSockaddr, makeZeroedSockaddr, solSocket, soReuseaddr }

// ── Public types ──

// Incoming HTTP request with method and path.

struct Request {
    method: string,
    path: string,
}

// Key-value pair for path params and response headers.
struct Param {
    name: string,
    value: string,
}

// Request context passed to route handlers.
// Contains the matched request, extracted path params, and response state.
struct Context {
    req: Request,
    params: Vec<Param>,
    statusCode: i32,
    respHeaders: Vec<Param>,
}

impl Context {
    fn param(self: &Self, name: &string): string {
        var i: i64 = 0
        while i < self.params.len {
            if self.params[i].name == *name {
                return self.params[i].value.clone()
            }
            i = i + 1
        }
        return ""
    }

    fn setStatus(self: &mut Self, code: i32): void {
        self.statusCode = code
    }

    fn setHeader(self: &mut Self, name: string, value: string): void {
        self.respHeaders.push(Param { name: name, value: value })
    }

    fn text(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "text/plain; charset=utf-8", body)
        }
        return Response.Text(body)
    }

    fn json(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "application/json", body)
        }
        return Response.Json(body)
    }

    fn html(self: &Self, body: string): Response {
        if self.statusCode != 200 {
            return Response.Status(self.statusCode, "text/html; charset=utf-8", body)
        }
        return Response.Html(body)
    }

    fn redirect(self: &Self, url: string): Response {
        return Response.Status(302, "text/plain; charset=utf-8", url)
    }
}

// HTTP response type.
// Text/Html/Json set the content-type automatically.
// Status(code, contentType, body) for custom responses.

enum Response {
    Text(string),
    Html(string),
    Json(string),
    NotFound,
    Status(i32, string, string),
}

// ── Internal helpers ──

fn bufToStr(buf: &[u8 ; 8192], start: i64, end: i64): string {
    var s: string = ""
    var i: i64 = start
    while i < end {
        s.push(buf[i])
        i = i + 1
    }
    return s
}

fn parseRequest(buf: &[u8 ; 8192], n: i64): Request {
    var i: i64 = 0
    while i < n && buf[i] != ' ' {
        i = i + 1
    }
    let method = bufToStr(buf, 0, i)
    while i < n && buf[i] == ' ' {
        i = i + 1
    }
    let pathStart = i
    while i < n && buf[i] != ' ' {
        i = i + 1
    }
    let path = bufToStr(buf, pathStart, i)
    return Request {
        method: method, path: path
    }
}

fn statusText(status: i32): string {
    if status == 200 {
        return "200 OK"
    }
    if status == 201 {
        return "201 Created"
    }
    if status == 204 {
        return "204 No Content"
    }
    if status == 301 {
        return "301 Moved Permanently"
    }
    if status == 400 {
        return "400 Bad Request"
    }
    if status == 404 {
        return "404 Not Found"
    }
    if status == 500 {
        return "500 Internal Server Error"
    }
    return "200 OK"
}

fn sendRaw(fd: i32, status: i32, contentType: string, body: string): void {
    var resp: string = "HTTP/1.1 " + statusText(status)
    resp = resp + "\\r\\nContent-Type: " + contentType
    resp = resp + "\\r\\nContent-Length: " + body.len.toString()
    resp = resp + "\\r\\nConnection: close"
    resp = resp + "\\r\\nServer: milo"
    resp = resp + "\\r\\n\\r\\n"
    resp = resp + body
    unsafe {
        write(fd, resp, resp.len)
    }
}

fn sendResponse(fd: i32, response: Response): void {
    match response {
        Response.Text(body) => {
            sendRaw(fd, 200, "text/plain; charset=utf-8", body)
        }
        Response.Html(body) => {
            sendRaw(fd, 200, "text/html; charset=utf-8", body)
        }
        Response.Json(body) => {
            sendRaw(fd, 200, "application/json", body)
        }
        Response.NotFound => {
            sendRaw(fd, 404, "text/plain; charset=utf-8", "404 Not Found")
        }
        Response.Status(code, ct, body) => {
            sendRaw(fd, code, ct, body)
        }
    }
}

// ── Socket with automatic cleanup ──

struct Socket {
    fd: i32,
}

impl Drop for Socket {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

// ── Public API ──

// Start an HTTP server on the given port.
// Pass null for port to let the OS pick an available port.
// The handler receives a Request and returns a Response.
// Example:
//   serve(8080, fn(req: &Request): Response {
//       return Response.Text("hello")
//   })

fn serve(port: u16?, handler: (&Request) => Response): Result<void> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let BACKLOG: i32 = 1024
    let BUF_SIZE: i64 = 8192
    let SIZEOF_SOCKADDR_IN: u32 = 16

    // port 0 tells the OS to pick a random available port
    var bindPort: u16 = 0
    if let Option.Some(p) = port {
        bindPort = p
    }

    unsafe {
        let rawFd = socket(AF_INET, SOCK_STREAM, 0)
        if rawFd < 0 {
            return Result.Err("socket() failed")
        }
        let sock = Socket {
            fd: rawFd
        }

        var one: i32 = 1
        setsockopt(sock.fd, solSocket(), soReuseaddr(), one, 4)

        var addr = makeSockaddr(bindPort, 0)

        if bind(sock.fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            return Result.Err("bind() failed")
        }

        if listen(sock.fd, BACKLOG) < 0 {
            return Result.Err("listen() failed")
        }

        // retrieve actual port (needed when bindPort was 0)
        var boundAddr = makeZeroedSockaddr()
        var boundLen: u32 = SIZEOF_SOCKADDR_IN
        getsockname(sock.fd, boundAddr, boundLen)
        let actualPort = ntohs(boundAddr.sinPort)

        print($"listening on http://localhost:{actualPort}")

        while true {
            var clientAddr = makeZeroedSockaddr()
            var addrlen: u32 = SIZEOF_SOCKADDR_IN
            let clientFd = accept(sock.fd, clientAddr, addrlen)
            if clientFd < 0 {
                continue
            }

            var buf: [u8 ; 8192] = [0 ; 8192]
            let n = read(clientFd, buf, BUF_SIZE)
            if n > 0 {
                let req = parseRequest(buf, n)
                let resp = handler(req)
                sendResponse(clientFd, resp)
            }
            close(clientFd)
        }
    }
    return Result.Err("server exited")
}

// ── Router ──

struct Route {
    method: string,
    pattern: string,
    paramNames: Vec<string>,
    handler: (&mut Context) => Response,
}

struct Router {
    routes: Vec<Route>,
    middleware: Vec<(&mut Context, (&mut Context) => Response) => Response>,
}

impl Router {
    fn new(): Router {
        return Router {
            routes: [],
            middleware: [],
        }
    }

    fn get(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("GET", pattern, h)
    }

    fn post(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("POST", pattern, h)
    }

    fn put(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("PUT", pattern, h)
    }

    fn delete(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("DELETE", pattern, h)
    }

    fn all(self: &mut Self, pattern: string, h: (&mut Context) => Response): void {
        self.addRoute("*", pattern, h)
    }

    fn use(self: &mut Self, mw: (&mut Context, (&mut Context) => Response) => Response): void {
        self.middleware.push(mw)
    }

    fn addRoute(self: &mut Self, method: string, pattern: string, h: (&mut Context) => Response): void {
        let paramNames = extractParamNames(pattern)
        self.routes.push(Route {
            method: method,
            pattern: pattern,
            paramNames: paramNames,
            handler: h,
        })
    }

    fn handle(self: &Self, req: Request): Response {
        var i: i64 = 0
        while i < self.routes.len {
            let route = self.routes[i]
            if route.method == "*" || route.method == req.method {
                let params = matchRoute(route.pattern, route.paramNames, req.path)
                if let Option.Some(matched) = params {
                    var ctx = Context {
                        req: req,
                        params: matched,
                        statusCode: 200,
                        respHeaders: [],
                    }
                    let handler = route.handler
                    // wrap handler with middleware chain (innermost first)
                    var final: (&mut Context) => Response = handler
                    var m: i64 = self.middleware.len - 1
                    while m >= 0 {
                        let mw = self.middleware[m]
                        let next = final
                        final = (c: &mut Context) => {
                            return mw(c, next)
                        }
                        m = m - 1
                    }
                    return final(ctx)
                }
            }
            i = i + 1
        }
        return Response.NotFound
    }
}

// Start an HTTP server using a Router.
fn serveRouter(port: u16?, router: &Router): Result<void> {
    return serve(port, (req: &Request) => {
        // clone request since router.handle takes ownership
        let owned = Request { method: req.method.clone(), path: req.path.clone() }
        return router.handle(owned)
    })
}

// ── Path matching ──

// Extract param names from pattern like "/user/:id/posts/:postId"
fn extractParamNames(pattern: &string): Vec<string> {
    var names: Vec<string> = []
    var i: i64 = 0
    while i < pattern.len {
        if pattern[i] == ':' {
            var j: i64 = i + 1
            while j < pattern.len && pattern[j] != '/' {
                j = j + 1
            }
            var name: string = ""
            var k: i64 = i + 1
            while k < j {
                name.push(pattern[k])
                k = k + 1
            }
            names.push(name)
            i = j
        } else {
            i = i + 1
        }
    }
    return names
}

// Match a request path against a route pattern.
// Returns Some(params) on match, None on mismatch.
fn matchRoute(pattern: &string, paramNames: &Vec<string>, path: &string): Option<Vec<Param>> {
    let patSegs = splitPath(pattern)
    let pathSegs = splitPath(path)

    // wildcard: pattern ending with "*" matches any suffix
    var hasWildcard: bool = false
    if patSegs.len > 0 && patSegs[patSegs.len - 1] == "*" {
        hasWildcard = true
    }

    if !hasWildcard && patSegs.len != pathSegs.len {
        return Option.None
    }
    if hasWildcard && pathSegs.len < patSegs.len - 1 {
        return Option.None
    }

    var params: Vec<Param> = []
    var paramIdx: i64 = 0
    var segCount: i64 = patSegs.len
    if hasWildcard {
        segCount = segCount - 1
    }

    var i: i64 = 0
    while i < segCount {
        let pat = patSegs[i]
        if i >= pathSegs.len {
            return Option.None
        }
        let seg = pathSegs[i]
        if pat.len > 0 && pat[0] == ':' {
            // param segment — capture value
            if paramIdx < paramNames.len {
                params.push(Param { name: paramNames[paramIdx].clone(), value: seg.clone() })
                paramIdx = paramIdx + 1
            }
        } else if pat != seg {
            return Option.None
        }
        i = i + 1
    }
    return Option.Some(params)
}

// Split path by '/' into non-empty segments
fn splitPath(path: &string): Vec<string> {
    var segs: Vec<string> = []
    var current: string = ""
    var i: i64 = 0
    while i < path.len {
        if path[i] == '/' {
            if current.len > 0 {
                segs.push(current)
                current = ""
            }
        } else {
            current.push(path[i])
        }
        i = i + 1
    }
    if current.len > 0 {
        segs.push(current)
    }
    return segs
}
`, "std/args.milo": `// std/args — command-line argument parsing

// Return all command-line arguments as a Vec<string>.
// Index 0 is the program name.

fn args(): Vec<string> {
    var result: Vec<string> = Vec.new()
    let n = _miloArgCount()
    var i: i64 = 0
    while i < n {
        result.push(_miloArgAt(i))
        i = i + 1
    }
    return result
}

// Get the value following a --name flag.
// Returns null if the flag is not present.
// Example: getFlag("port") returns the value after --port.

fn getFlag(name: &string): string? {
    let all = args()
    let flag = "--" + name
    var i: i64 = 0
    while i < all.len {
        if all[i] == flag {
            if i + 1 < all.len {
                return Option.Some(all[i + 1])
            }
        }
        i = i + 1
    }
    return null
}

// Check if a --name flag is present in the arguments.

fn hasFlag(name: &string): bool {
    let all = args()
    let flag = "--" + name
    var i: i64 = 0
    while i < all.len {
        if all[i] == flag {
            return true
        }
        i = i + 1
    }
    return false
}
`, "std/set.milo": `// std/set — HashSet<T> backed by HashMap<T, bool>

struct HashSet<T> {
    inner: HashMap<T, bool>,
}

// Create an empty HashSet.

fn setNew<T> (): HashSet<T> {
    return HashSet {
        inner: HashMap.new()
    }
}

// Add a value to the set.

fn setAdd<T> (s: &mut HashSet<T>, val: T): void {
    s.inner.insert(val, true)
}

// Check if the set contains a value.

fn setContains<T> (s: &HashSet<T>, val: T): bool {
    return s.inner.contains(val)
}

// Remove a value from the set.

fn setRemove<T> (s: &mut HashSet<T>, val: T): void {
    s.inner.remove(val)
}

// Number of elements in the set.

fn setLen<T> (s: &HashSet<T>): i64 {
    return s.inner.len
}
`, "std/csv.milo": `// std/csv — CSV parse and write with quoting/escaping


// Parse a CSV string into a Vec of rows, each row a Vec of fields.

fn csvParse(input: &string): Vec<Vec<string>> {
    var rows: Vec<Vec<string>> = Vec.new()
    var row: Vec<string> = Vec.new()
    var field = ""
    var inQuote = false
    var i: i64 = 0
    while i < input.len {
        let ch = input[i]
        if inQuote {
            if ch == 34 {
                // double quote: peek for escaped quote
                if i + 1 < input.len && input[i + 1] == 34 {
                    field.push(34 as u8)
                    i = i + 2
                    continue
                }
                inQuote = false
            } else {
                field.push(ch)
            }
        } else {
            if ch == 34 {
                inQuote = true
            } else {
                if ch == 44 {
                    row.push(field)
                    field = ""
                } else {
                    if ch == 10 {
                        row.push(field)
                        field = ""
                        rows.push(row)
                        row = Vec.new()
                    } else {
                        if ch != 13 {
                            field.push(ch)
                        }
                    }
                }
            }
        }
        i = i + 1
    }
    if field.len > 0 || row.len > 0 {
        row.push(field)
        rows.push(row)
    }
    return rows
}

// Quote a field if it contains commas, quotes, or newlines.

fn _csvQuoteField(val: &string): string {
    var needsQuote = false
    var j: i64 = 0
    while j < val.len {
        let ch = val[j]
        if ch == 44 || ch == 34 || ch == 10 || ch == 13 {
            needsQuote = true
            break
        }
        j = j + 1
    }
    if !needsQuote {
        return val.clone()
    }
    var quoted = "\\""
    var k: i64 = 0
    while k < val.len {
        let ch = val[k]
        if ch == 34 {
            quoted = quoted + "\\"\\""
        } else {
            quoted.push(ch)
        }
        k = k + 1
    }
    quoted = quoted + "\\""
    return quoted
}

// Serialize rows to a CSV string.

fn csvStringify(rows: &Vec<Vec<string>>): string {
    var output = ""
    var ri: i64 = 0
    while ri < rows.len {
        var ci: i64 = 0
        while ci < rows[ri].len {
            if ci > 0 {
                output = output + ","
            }
            output = output + _csvQuoteField(rows[ri][ci])
            ci = ci + 1
        }
        output = output + "\\n"
        ri = ri + 1
    }
    return output
}
`, "std/path.milo": `// std/path — file path manipulation


// Get the file extension including the dot. Returns "" if none.

fn pathExt(path: &string): string {
    var i: i64 = path.len - 1
    while i >= 0 as i64 {
        if path[i] == 46 {
            return path.substr(i, path.len)
        }
        if path[i] == 47 {
            return ""
        }
        i = i - 1
    }
    return ""
}

// Get the last component of a path.

fn pathBasename(path: &string): string {
    if path.len == 0 {
        return ""
    }
    var end: i64 = path.len
    // strip trailing slashes
    while end > 0 as i64 && path[end - 1] == 47 {
        end = end - 1
    }
    if end == 0 as i64 {
        return "/"
    }
    var i: i64 = end - 1
    while i >= 0 as i64 {
        if path[i] == 47 {
            return path.substr(i + 1, end)
        }
        i = i - 1
    }
    return path.substr(0 as i64, end)
}

// Get the directory portion of a path.

fn pathDirname(path: &string): string {
    if path.len == 0 {
        return "."
    }
    var end: i64 = path.len
    // strip trailing slashes
    while end > 0 as i64 && path[end - 1] == 47 {
        end = end - 1
    }
    if end == 0 as i64 {
        return "/"
    }
    // find last slash
    var i: i64 = end - 1
    while i >= 0 as i64 {
        if path[i] == 47 {
            if i == 0 as i64 {
                return "/"
            }
            return path.substr(0 as i64, i)
        }
        i = i - 1
    }
    return "."
}

// Join two path components with a separator.

fn pathJoin(a: &string, b: &string): string {
    if a.len == 0 {
        return b.clone()
    }
    if b.len == 0 {
        return a.clone()
    }
    if a[a.len - 1] == 47 {
        return a + b
    }
    return a + "/" + b
}

// Get the filename without extension.

fn pathStem(path: &string): string {
    let base = pathBasename(path)
    var i: i64 = base.len - 1
    while i > 0 as i64 {
        if base[i] == 46 {
            return base.substr(0 as i64, i)
        }
        i = i - 1
    }
    return base
}
`, "std/signal.milo": `// std/signal — OS signal handling (POSIX)


extern fn signal(signum: i32, handler: *u8): *u8

let SIGHUP: i32 = 1
let SIGINT: i32 = 2
let SIGQUIT: i32 = 3
let SIGABRT: i32 = 6
let SIGKILL: i32 = 9
let SIGALRM: i32 = 14
let SIGTERM: i32 = 15

// Register a handler for a signal. Handler receives the signal number.
fn onSignal(sig: i32, handler: fn(i32): void): void {
    unsafe {
        signal(sig, handler as *u8)
    }
}

// Ignore a signal.
fn ignoreSignal(sig: i32): void {
    unsafe {
        signal(sig, 1 as *u8)
    }
}

// Reset a signal to default behavior.
fn resetSignal(sig: i32): void {
    unsafe {
        signal(sig, 0 as *u8)
    }
}
`, "std/prelude.milo": `// std/prelude — auto-imported into every Milo program (suppress with --no-prelude)

from "std/string" import { strContains, strIndexOf, strIndexOfFrom, strStartsWith, strEndsWith, strToLower, strToUpper, strTrim, strTrimStart, strTrimEnd, strSplit, strRepeat, strReplace, charIsWhitespace, charIsDigit, charIsAlpha, charIsAlphanumeric, trim }
`, "std/color.milo": `// std/color — ANSI terminal colors and styles

fn red(s: &string): string { return "\\x1b[31m" + s + "\\x1b[0m" }
fn green(s: &string): string { return "\\x1b[32m" + s + "\\x1b[0m" }
fn yellow(s: &string): string { return "\\x1b[33m" + s + "\\x1b[0m" }
fn blue(s: &string): string { return "\\x1b[34m" + s + "\\x1b[0m" }
fn magenta(s: &string): string { return "\\x1b[35m" + s + "\\x1b[0m" }
fn cyan(s: &string): string { return "\\x1b[36m" + s + "\\x1b[0m" }
fn white(s: &string): string { return "\\x1b[37m" + s + "\\x1b[0m" }
fn gray(s: &string): string { return "\\x1b[90m" + s + "\\x1b[0m" }

fn bold(s: &string): string { return "\\x1b[1m" + s + "\\x1b[0m" }
fn dim(s: &string): string { return "\\x1b[2m" + s + "\\x1b[0m" }
fn italic(s: &string): string { return "\\x1b[3m" + s + "\\x1b[0m" }
fn underline(s: &string): string { return "\\x1b[4m" + s + "\\x1b[0m" }
fn strikethrough(s: &string): string { return "\\x1b[9m" + s + "\\x1b[0m" }

fn bgRed(s: &string): string { return "\\x1b[41m" + s + "\\x1b[0m" }
fn bgGreen(s: &string): string { return "\\x1b[42m" + s + "\\x1b[0m" }
fn bgYellow(s: &string): string { return "\\x1b[43m" + s + "\\x1b[0m" }
fn bgBlue(s: &string): string { return "\\x1b[44m" + s + "\\x1b[0m" }
`, "std/crypto.milo": `// std/crypto — cryptographic hash functions
//
// macOS: wraps CommonCrypto (CC_SHA256, CC_MD5)
// Linux: would wrap OpenSSL (SHA256, MD5) — same signatures


extern

fn CC_SHA256(_data: *u8, _len: u32, _md: *u8): *u8

extern

fn CC_MD5(_data: *u8, _len: u32, _md: *u8): *u8

fn _bytesToHex(buf: &[u8 ; 32], n: i64): string {
    var result = ""
    var i: i64 = 0
    while i < n {
        let b = buf[i]
        let hi = b >> 4
        let lo = b & 15
        if hi < 10 {
            result.push(hi + 48)
        } else {
            result.push(hi - 10 + 97)
        }
        if lo < 10 {
            result.push(lo + 48)
        } else {
            result.push(lo - 10 + 97)
        }
        i = i + 1
    }
    return result
}

// Compute SHA-256 hash of a string. Returns 64-char lowercase hex string.

fn sha256(input: &string): string {
    var hash: [u8 ; 32] = [0 ; 32]
    unsafe {
        CC_SHA256(input, input.len as u32, hash)
    }
    return _bytesToHex(hash, 32)
}

// Compute MD5 hash of a string. Returns 32-char lowercase hex string.

fn md5(input: &string): string {
    var hash: [u8 ; 32] = [0 ; 32]
    unsafe {
        CC_MD5(input, input.len as u32, hash)
    }
    return _bytesToHex(hash, 16)
}
`, "std/os.milo": `// std/os — typed libc bindings for Milo

// ── I/O ──

extern

fn read(fd: i32, buf: *u8, nbyte: i64): i64

extern

fn write(fd: i32, buf: *u8, nbyte: i64): i64

extern

fn open(path: *u8, flags: i32,...): i32

extern

fn close(fd: i32): i32

extern

fn lseek(fd: i32, offset: i64, whence: i32): i64

extern

fn fstat(fd: i32, buf: *u8): i32

extern

fn stat(path: *u8, buf: *u8): i32

extern

fn access(path: *u8, mode: i32): i32

extern

fn puts(s: *u8): i32

extern

fn printf(fmt: *u8,...): i32

// ── Memory ──

extern

fn malloc(size: i64): *u8

extern

fn realloc(ptr: *u8, size: i64): *u8

extern

fn free(ptr: *u8): void

extern

fn memcpy(dst: *u8, src: *u8, n: i64): *u8

extern

fn memset(dst: *u8, c: i32, n: i64): *u8

extern

fn memmove(dst: *u8, src: *u8, n: i64): *u8

extern

fn mmap(addr: *u8, len: i64, prot: i32, flags: i32, fd: i32, offset: i64): *u8

extern

fn munmap(addr: *u8, len: i64): i32

// ── Error ──

extern

fn strerror(errnum: i32): *u8

// ── Strings ──

extern

fn strlen(s: *u8): i64

extern

fn strcmp(a: *u8, b: *u8): i32

extern

fn strncmp(a: *u8, b: *u8, n: i64): i32

extern

fn snprintf(buf: *u8, size: i64, fmt: *u8,...): i32

// ── Network ──

extern

fn socket(domain: i32, type: i32, protocol: i32): i32

extern

fn bind(sockfd: i32, addr: &SockAddrIn, addrlen: u32): i32

extern

fn listen(sockfd: i32, backlog: i32): i32

extern

fn accept(sockfd: i32, addr: &mut SockAddrIn, addrlen: &mut u32): i32

extern

fn connect(sockfd: i32, addr: &SockAddrIn, addrlen: u32): i32

extern

fn setsockopt(fd: i32, level: i32, opt: i32, val: &i32, len: u32): i32

extern

fn htons(hostshort: u16): u16

extern

fn ntohs(netshort: u16): u16

extern

fn getsockname(fd: i32, addr: &mut SockAddrIn, addrlen: &mut u32): i32

extern

fn inet_pton(af: i32, src: *u8, dst: *u8): i32

// ── TLS (OpenSSL) ──

extern

fn TLS_client_method(): *u8

extern

fn SSL_CTX_new(method: *u8): *u8

extern

fn SSL_CTX_free(ctx: *u8): void

extern

fn SSL_CTX_set_default_verify_paths(ctx: *u8): i32

extern

fn SSL_new(ctx: *u8): *u8

extern

fn SSL_set_fd(ssl: *u8, fd: i32): i32

extern

fn SSL_connect(ssl: *u8): i32

extern

fn SSL_read(ssl: *u8, buf: *u8, num: i32): i32

extern

fn SSL_write(ssl: *u8, buf: *u8, num: i32): i32

extern

fn SSL_free(ssl: *u8): void

extern

fn SSL_ctrl(ssl: *u8, cmd: i32, larg: i64, parg: *u8): i64

// ── DNS ──

extern

fn getaddrinfo(node: *u8, service: *u8, hints: *u8, res: *u8): i32

extern

fn freeaddrinfo(res: *u8): void

// ── Directory ──

extern

fn opendir(path: *u8): *u8

extern

fn closedir(dir: *u8): i32

extern

fn readdir(dir: *u8): *u8

// ── Process ──

extern

fn exit(status: i32): void

extern

fn getenv(name: *u8): *u8

extern

fn system(cmd: *u8): i32

extern

fn fork(): i32

extern

fn execl(path: *u8,...): i32

extern

fn waitpid(pid: i32, status: *u8, options: i32): i32

extern

fn dup2(oldfd: i32, newfd: i32): i32

extern

fn pipe(fds: *u8): i32

extern

fn kill(pid: i32, sig: i32): i32

// ── pthreads ──

extern

fn pthread_create(thread: *u8, attr: *u8, start: *u8, arg: *u8): i32

extern

fn pthread_join(thread: i64, retval: *u8): i32

extern

fn pthread_mutex_init(mutex: *u8, attr: *u8): i32

extern

fn pthread_mutex_lock(mutex: *u8): i32

extern

fn pthread_mutex_unlock(mutex: *u8): i32

extern

fn pthread_mutex_destroy(mutex: *u8): i32

extern

fn pthread_cond_init(cond: *u8, attr: *u8): i32

extern

fn pthread_cond_wait(cond: *u8, mutex: *u8): i32

extern

fn pthread_cond_signal(cond: *u8): i32

extern

fn pthread_cond_broadcast(cond: *u8): i32

extern

fn pthread_cond_destroy(cond: *u8): i32
`, "std/datetime.milo": `// std/datetime — date/time components and formatting from epoch seconds

from "std/time" import { epochSecs, since }

struct DateTime {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    weekday: i32,
}

fn dateTimeFromEpoch(epochSec: i64): DateTime {
    // days since 1970-01-01
    var secs = epochSec
    let totalDays = secs / 86400
    let daySeconds = secs - totalDays * 86400

    let hour = (daySeconds / 3600) as i32
    let minute = ((daySeconds - (hour as i64) * 3600) / 60) as i32
    let second = (daySeconds - (hour as i64) * 3600 - (minute as i64) * 60) as i32

    // weekday: 1970-01-01 was Thursday (4)
    var wd = ((totalDays + 4) % 7) as i32
    if wd < 0 { wd = wd + 7 }

    // civil date from day count (Hinnant algorithm)
    var z = totalDays + 719468
    var eraInput = z
    if z < 0 { eraInput = z - 146096 }
    let era = eraInput / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    var m = mp + 3
    if mp >= 10 { m = mp - 9 }
    var yr = y
    if m <= 2 { yr = y + 1 }

    return DateTime {
        year: yr as i32, month: m as i32, day: d as i32,
        hour: hour, minute: minute, second: second,
        weekday: wd,
    }
}

fn dateTimeNow(): DateTime {
    return dateTimeFromEpoch(epochSecs())
}

fn dateTimeFormat(dt: &DateTime): string {
    // ISO 8601: 2024-03-15T14:30:00
    var result: string = ""
    result = result + _padI32(dt.year, 4) + "-" + _padI32(dt.month, 2) + "-" + _padI32(dt.day, 2)
    result = result + "T"
    result = result + _padI32(dt.hour, 2) + ":" + _padI32(dt.minute, 2) + ":" + _padI32(dt.second, 2)
    return result
}

fn dateTimeFormatDate(dt: &DateTime): string {
    return _padI32(dt.year, 4) + "-" + _padI32(dt.month, 2) + "-" + _padI32(dt.day, 2)
}

fn dateTimeFormatTime(dt: &DateTime): string {
    return _padI32(dt.hour, 2) + ":" + _padI32(dt.minute, 2) + ":" + _padI32(dt.second, 2)
}

fn weekdayName(wd: i32): string {
    if wd == 0 { return "Sunday" }
    if wd == 1 { return "Monday" }
    if wd == 2 { return "Tuesday" }
    if wd == 3 { return "Wednesday" }
    if wd == 4 { return "Thursday" }
    if wd == 5 { return "Friday" }
    if wd == 6 { return "Saturday" }
    return "Unknown"
}

fn monthName(m: i32): string {
    if m == 1 { return "January" }
    if m == 2 { return "February" }
    if m == 3 { return "March" }
    if m == 4 { return "April" }
    if m == 5 { return "May" }
    if m == 6 { return "June" }
    if m == 7 { return "July" }
    if m == 8 { return "August" }
    if m == 9 { return "September" }
    if m == 10 { return "October" }
    if m == 11 { return "November" }
    if m == 12 { return "December" }
    return "Unknown"
}

fn _padI32(val: i32, width: i32): string {
    var s = format(val)
    while s.len < width as i64 {
        s = "0" + s
    }
    return s
}
`, "std/math.milo": `// std/math — mathematical functions (wraps libm)


// ── libm bindings ──

extern

fn sqrt(x: f64): f64

extern

fn pow(base: f64, exp: f64): f64

extern

fn sin(x: f64): f64

extern

fn cos(x: f64): f64

extern

fn tan(x: f64): f64

extern

fn atan2(y: f64, x: f64): f64

extern

fn floor(x: f64): f64

extern

fn ceil(x: f64): f64

extern

fn round(x: f64): f64

extern

fn fabs(x: f64): f64

extern

fn fmod(x: f64, y: f64): f64

extern

fn log(x: f64): f64

extern

fn log2(x: f64): f64

extern

fn log10(x: f64): f64

extern

fn exp(x: f64): f64

// ── safe wrappers ──

fn mathSqrt(x: f64): f64 {
    unsafe {
        return sqrt(x)
    }
}

fn mathPow(base: f64, exponent: f64): f64 {
    unsafe {
        return pow(base, exponent)
    }
}

fn mathSin(x: f64): f64 {
    unsafe {
        return sin(x)
    }
}

fn mathCos(x: f64): f64 {
    unsafe {
        return cos(x)
    }
}

fn mathTan(x: f64): f64 {
    unsafe {
        return tan(x)
    }
}

fn mathAtan2(y: f64, x: f64): f64 {
    unsafe {
        return atan2(y, x)
    }
}

fn mathFloor(x: f64): f64 {
    unsafe {
        return floor(x)
    }
}

fn mathCeil(x: f64): f64 {
    unsafe {
        return ceil(x)
    }
}

fn mathRound(x: f64): f64 {
    unsafe {
        return round(x)
    }
}

fn mathAbs(x: f64): f64 {
    unsafe {
        return fabs(x)
    }
}

fn mathMod(x: f64, y: f64): f64 {
    unsafe {
        return fmod(x, y)
    }
}

fn mathLog(x: f64): f64 {
    unsafe {
        return log(x)
    }
}

fn mathLog2(x: f64): f64 {
    unsafe {
        return log2(x)
    }
}

fn mathLog10(x: f64): f64 {
    unsafe {
        return log10(x)
    }
}

fn mathExp(x: f64): f64 {
    unsafe {
        return exp(x)
    }
}

// ── integer helpers ──

fn absI64(x: i64): i64 {
    if x < 0 {
        return 0 - x
    }
    return x
}

fn absI32(x: i32): i32 {
    if x < 0 as i32 {
        return 0 as i32 - x
    }
    return x
}

fn minI64(a: i64, b: i64): i64 {
    if a < b {
        return a
    }
    return b
}

fn maxI64(a: i64, b: i64): i64 {
    if a > b {
        return a
    }
    return b
}

fn minI32(a: i32, b: i32): i32 {
    if a < b {
        return a
    }
    return b
}

fn maxI32(a: i32, b: i32): i32 {
    if a > b {
        return a
    }
    return b
}

fn minF64(a: f64, b: f64): f64 {
    if a < b {
        return a
    }
    return b
}

fn maxF64(a: f64, b: f64): f64 {
    if a > b {
        return a
    }
    return b
}

fn clampI64(x: i64, lo: i64, hi: i64): i64 {
    if x < lo {
        return lo
    }
    if x > hi {
        return hi
    }
    return x
}

fn clampF64(x: f64, lo: f64, hi: f64): f64 {
    if x < lo {
        return lo
    }
    if x > hi {
        return hi
    }
    return x
}

// ── constants ──

fn mathPi(): f64 {
    return 3.14159265358979323846
}

fn mathE(): f64 {
    return 2.71828182845904523536
}

fn mathInf(): f64 {
    return 1.0 / 0.0
}
`, "std/testing.milo": `// std/testing — test assertion functions

from "std/os" import { exit }

fn _testFail(): void {
    unsafe { exit(1) }
}

fn assert(cond: bool): void {
    if !cond {
        eprint("  assertion failed")
        _testFail()
    }
}

fn assertMsg(cond: bool, msg: string): void {
    if !cond {
        eprint($"  assertion failed: {msg}")
        _testFail()
    }
}

fn assertEqual(got: i32, expected: i32): void {
    if got != expected {
        eprint($"  assertEqual failed: got {got}, expected {expected}")
        _testFail()
    }
}

fn assertEqual64(got: i64, expected: i64): void {
    if got != expected {
        eprint($"  assertEqual64 failed: got {got}, expected {expected}")
        _testFail()
    }
}

fn assertStrEqual(got: &string, expected: &string): void {
    if got != expected {
        eprint("  assertStrEqual failed")
        _testFail()
    }
}

fn assertBool(got: bool, expected: bool): void {
    if got != expected {
        eprint("  assertBool failed")
        _testFail()
    }
}
`, "std/thread.milo": `// std/thread — OS thread spawning and joining via pthreads

from "std/os" import { free, malloc, memcpy, pthread_create, pthread_join }
from "std/time" import { sleepMs }

// Handle to a spawned OS thread.

struct Thread {
    id: i64,
}

// Spawn a new OS thread running the given function.
// The function receives a *u8 argument for passing data.
// The caller must ensure the pointed-to data outlives the thread.
//
//   fn worker(arg: *u8): *u8 { ... }
//   var data: i64 = 42
//   let t = threadSpawn(worker as *u8, (&data) as *u8)!
//   threadJoin(t)!

fn threadSpawn(func: *u8, arg: *u8): Result<Thread> {
    var tid: i64 = 0
    unsafe {
        let r = pthread_create((&tid) as *u8, 0 as *u8, func, arg)
        if r != 0 {
            return Result.Err("pthread_create failed")
        }
    }
    return Result.Ok(Thread { id: tid })
}

// Spawn a thread running a no-arg function (convenience wrapper).
//
//   fn work(arg: *u8): *u8 { print("hi"); return 0 as *u8 }
//   let t = threadSpawnFn(work)!

fn threadSpawnFn(func: (*u8) => *u8): Result<Thread> {
    unsafe {
        return threadSpawn(func as *u8, 0 as *u8)
    }
}

// Block until the thread finishes.

fn threadJoin(t: &Thread): Result<i32> {
    unsafe {
        let r = pthread_join(t.id, 0 as *u8)
        if r != 0 {
            return Result.Err("pthread_join failed")
        }
        return Result.Ok(0)
    }
}

// ── Safe spawn with move closures ──
// The closure's captures are heap-allocated (by move semantics) and
// passed to the thread via the pthread arg pointer. No unsafe needed
// by the caller.
//
//   let offset: i64 = 10
//   let t = spawn(move (): void => {
//       print($"offset is {offset}")
//   })!
//   threadJoin(t)!

// trampoline: receives packed { fnPtr, envPtr } via pthread arg
fn _closureTrampoline(arg: *u8): *u8 {
    unsafe {
        let base = arg as i64
        var fnPtr: *u8 = 0 as *u8
        var envPtr: *u8 = 0 as *u8
        memcpy((&fnPtr) as *u8, arg, 8)
        memcpy((&envPtr) as *u8, (base + 8) as *u8, 8)
        _callClosureVoid(fnPtr, envPtr)
        // free the packed struct (closure env is freed by drop glue or leaks — acceptable for threads)
        free(arg)
        return 0 as *u8
    }
}

fn spawn(f: () => void): Result<Thread> {
    unsafe {
        // f is { ptr fnPtr, ptr envPtr } — pack both into a heap block for the trampoline
        let packed = malloc(16)
        // extract fn ptr and env ptr from closure tuple
        // the closure is passed as two ptr args; we need the raw values
        let fPtr = f as *u8
        // for the env, we need the second element of the tuple
        // _closurePairEnv is a builtin that extracts element 1
        // ... actually, f is a { ptr, ptr } passed as a parameter.
        // When f is a fn param, it's stored as { ptr, ptr } in an alloca.
        // We need to extract both elements.
        // Let's just pass f's alloca address — it already contains { fnPtr, envPtr }
        memcpy(packed, (&f) as *u8, 16)
        let t = threadSpawn(_closureTrampoline as *u8, packed)
        return t
    }
}

// Sleep the current thread for the given number of milliseconds.

fn threadSleep(ms: i64): void {
    sleepMs(ms)
}
`, "std/uuid.milo": `// std/uuid — UUID v4 generation (random, RFC 4122)

from "std/random" import { arc4random_buf }

fn _byteToHex(b: u8): string {
    var s = ""
    s.push(_hexChar(b >> 4))
    s.push(_hexChar(b & 15 as u8))
    return s
}

// Generate a random UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000").

fn uuidV4(): string {
    var buf: [u8; 16] = [0 as u8; 16]
    unsafe { arc4random_buf(buf as *u8, 16) }

    // version 4: high nibble of byte 6 = 0100
    buf[6] = (buf[6] & 0x0f as u8) | 0x40 as u8
    // variant 1: high bits of byte 8 = 10
    buf[8] = (buf[8] & 0x3f as u8) | 0x80 as u8

    var s = ""
    s = s + _byteToHex(buf[0]) + _byteToHex(buf[1]) + _byteToHex(buf[2]) + _byteToHex(buf[3])
    s = s + "-"
    s = s + _byteToHex(buf[4]) + _byteToHex(buf[5])
    s = s + "-"
    s = s + _byteToHex(buf[6]) + _byteToHex(buf[7])
    s = s + "-"
    s = s + _byteToHex(buf[8]) + _byteToHex(buf[9])
    s = s + "-"
    s = s + _byteToHex(buf[10]) + _byteToHex(buf[11]) + _byteToHex(buf[12])
    s = s + _byteToHex(buf[13]) + _byteToHex(buf[14]) + _byteToHex(buf[15])
    return s
}
`, "std/argparse.milo": `// std/argparse — command-line argument parser with auto-generated help
from "std/args" import {
    args
}

struct FlagDef {
    longName: string,
    shortName: string,
    help: string,
    defaultVal: string,
    isBool: bool,
    required: bool,
}

struct PositionalDef {
    name: string,
    help: string,
    required: bool,
}

// Declarative command-line argument parser with auto-generated --help.
// Create with newParser(), add flags with addString/addBool/addRequired,
// then call .parse() to get a ParsedArgs.

struct ArgParser {
    name: string,
    description: string,
    usage: string,
    flags: Vec<FlagDef>,
    positionals: Vec<PositionalDef>,
}

// Parsed command-line arguments.
// Access values with .getString(), .getI64(), .getU16(), .getBool().
// Check presence with .has(). Positional args in .positional field.

struct ParsedArgs {
    prog: string,
    entries: Vec<ArgEntry>,
    positional: Vec<string>,
}

struct ArgEntry {
    name: string,
    value: string,
    present: bool,
}

// Create a new argument parser with a program name and description.

fn newParser(name: string, description: string): ArgParser {
    return ArgParser {
        name: name,
        description: description,
        usage: "",
        flags: Vec.new(),
        positionals: Vec.new(),
    }
}

impl ArgParser {
    // Add a string flag with long name, short alias, help text, and default.
    // Example: parser.addString("output", "o", "Output file", "out.txt")
    fn addString(self: &mut Self, long: string, short: string, help: string, defaultVal: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: defaultVal,
            isBool: false,
            required: false,
        }
        )
    }

    // Add a required string flag. parse() exits with error if missing.
    fn addRequired(self: &mut Self, long: string, short: string, help: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: "",
            isBool: false,
            required: true,
        }
        )
    }

    // Add a boolean flag (present = true, absent = false).
    fn addBool(self: &mut Self, long: string, short: string, help: string): void {
        self.flags.push(FlagDef {
            longName: long,
            shortName: short,
            help: help,
            defaultVal: "",
            isBool: true,
            required: false,
        }
        )
    }

    // Add a required positional argument.
    fn addPositional(self: &mut Self, name: string, help: string): void {
        self.positionals.push(PositionalDef {
            name: name, help: help, required: true
        }
        )
    }

    // Add an optional positional argument.
    fn addOptionalPositional(self: &mut Self, name: string, help: string): void {
        self.positionals.push(PositionalDef {
            name: name, help: help, required: false
        }
        )
    }

    // Generate formatted help text for all registered flags.
    fn helpText(self: &Self): string {
        var text: string = self.name + " - " + self.description + "\\n\\n"
        if self.usage.len > 0 {
            text = text + "usage: " + self.usage + "\\n\\n"
        } else {
            var usageLine: string = "usage: " + self.name + " [options]"
            var pi: i64 = 0
            while pi < self.positionals.len {
                if self.positionals[pi].required {
                    usageLine = usageLine + " <" + self.positionals[pi].name + ">"
                } else {
                    usageLine = usageLine + " [" + self.positionals[pi].name + "]"
                }
                pi = pi + 1
            }
            text = text + usageLine + "\\n\\n"
        }
        if self.positionals.len > 0 {
            text = text + "arguments:\\n"
            var pi2: i64 = 0
            while pi2 < self.positionals.len {
                var pline: string = "  <" + self.positionals[pi2].name + ">"
                while pline.len < 30 {
                    pline = pline + " "
                }
                pline = pline + self.positionals[pi2].help
                text = text + pline + "\\n"
                pi2 = pi2 + 1
            }
            text = text + "\\n"
        }

        text = text + "options:\\n"
        var i: i64 = 0
        while i < self.flags.len {
            var fline: string = "  "
            if self.flags[i].shortName.len > 0 {
                fline = fline + "-" + self.flags[i].shortName + ", "
            } else {
                fline = fline + "    "
            }
            fline = fline + "--" + self.flags[i].longName
            if !self.flags[i].isBool {
                fline = fline + " <value>"
            }
            while fline.len < 30 {
                fline = fline + " "
            }
            fline = fline + self.flags[i].help
            if !self.flags[i].isBool && self.flags[i].defaultVal.len > 0 {
                fline = fline + " (default: " + self.flags[i].defaultVal + ")"
            }
            if self.flags[i].required {
                fline = fline + " (required)"
            }
            text = text + fline + "\\n"
            i = i + 1
        }
        text = text + "  -h, --help                  Show this help message\\n"
        return text
    }

    // Parse command-line arguments and return ParsedArgs.
    // Automatically handles --help. Exits on invalid input.
    fn parse(self: &Self): ParsedArgs {
        let argv = args()
        var result = ParsedArgs {
            prog: self.name.clone(),
            entries: Vec.new(),
            positional: Vec.new(),
        }

        // initialize flag entries with defaults
        var fi: i64 = 0
        while fi < self.flags.len {
            result.entries.push(ArgEntry {
                name: self.flags[fi].longName.clone(),
                value: self.flags[fi].defaultVal.clone(),
                present: false,
            }
            )
            fi = fi + 1
        }

        // initialize positional entries
        var pi: i64 = 0
        while pi < self.positionals.len {
            result.entries.push(ArgEntry {
                name: self.positionals[pi].name.clone(),
                value: "",
                present: false,
            }
            )
            pi = pi + 1
        }

        var posIdx: i64 = 0
        var i: i64 = 1
        while i < argv.len {
            let arg = argv[i]

            if arg == "--help" || arg == "-h" {
                print(self.helpText())
                unsafe {
                    exit(0)
                }
            }

            if arg.len >= 2 && arg[0] == 45 {
                var matched: bool = false
                var fi2: i64 = 0
                while fi2 < self.flags.len {
                    let longFlag = "--" + self.flags[fi2].longName
                    var isMatch: bool = false
                    if arg == longFlag {
                        isMatch = true
                    }
                    if self.flags[fi2].shortName.len > 0 {
                        let shortFlag = "-" + self.flags[fi2].shortName
                        if arg == shortFlag {
                            isMatch = true
                        }
                    }

                    if isMatch {
                        matched = true
                        if self.flags[fi2].isBool {
                            result.entries[fi2] = ArgEntry {
                                name: self.flags[fi2].longName.clone(),
                                value: "true",
                                present: true,
                            }
                        } else {
                            if i + 1 >= argv.len {
                                print($"error: --{self.flags[fi2].longName} requires a value\\n\\n{self.helpText()}")
                                unsafe {
                                    exit(1)
                                }
                            }
                            i = i + 1
                            result.entries[fi2] = ArgEntry {
                                name: self.flags[fi2].longName.clone(),
                                value: argv[i].clone(),
                                present: true,
                            }
                        }
                    }
                    fi2 = fi2 + 1
                }

                if !matched {
                    print($"error: unknown flag '{arg}'\\n\\n{self.helpText()}")
                    unsafe {
                        exit(1)
                    }
                }
            } else {
                result.positional.push(arg.clone())
                // map to named positional entry
                if posIdx < self.positionals.len {
                    let entryIdx = self.flags.len + posIdx
                    result.entries[entryIdx] = ArgEntry {
                        name: self.positionals[posIdx].name.clone(),
                        value: arg.clone(),
                        present: true,
                    }
                    posIdx = posIdx + 1
                }
            }

            i = i + 1
        }

        // validate required flags
        var ri: i64 = 0
        while ri < self.flags.len {
            if self.flags[ri].required && !result.entries[ri].present {
                print($"error: --{self.flags[ri].longName} is required\\n\\n{self.helpText()}")
                unsafe {
                    exit(1)
                }
            }
            ri = ri + 1
        }

        // validate required positionals
        var rp: i64 = 0
        while rp < self.positionals.len {
            if self.positionals[rp].required {
                let entryIdx = self.flags.len + rp
                if !result.entries[entryIdx].present {
                    print($"error: missing required argument <{self.positionals[rp].name}>\\n\\n{self.helpText()}")
                    unsafe {
                        exit(1)
                    }
                }
            }
            rp = rp + 1
        }

        return result
    }
}

// ── integer parsing helper ──

fn _argparseParseI64(s: &string): i64 {
    var result: i64 = 0
    var neg: bool = false
    var i: i64 = 0
    if s.len > 0 && s[0] == 45 {
        neg = true
        i = 1
    }
    while i < s.len {
        let d = s[i]as i64 - 48
        result = result * 10 + d
        i = i + 1
    }
    if neg {
        return 0 - result
    }
    return result
}

fn _argparseIsNumeric(s: &string): bool {
    var i: i64 = 0
    if s.len == 0 {
        return false
    }
    if s[0] == 45 {
        i = 1
    }
    if i >= s.len {
        return false
    }
    while i < s.len {
        let c = s[i]
        if c < 48 || c > 57 {
            return false
        }
        i = i + 1
    }
    return true
}

impl ParsedArgs {
    // Get the string value of a flag by its long name.
    fn getString(self: &Self, name: &string): string {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name {
                return self.entries[i].value.clone()
            }
            i = i + 1
        }
        return ""
    }

    // Get an integer value of a flag. Exits if the value is not numeric.
    fn getI64(self: &Self, name: &string): i64 {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name {
                let val = self.entries[i].value.clone()
                if !_argparseIsNumeric(val) {
                    print($"error: --{name}: expected integer, got '{val}'")
                    unsafe {
                        exit(1)
                    }
                }
                return _argparseParseI64(val)
            }
            i = i + 1
        }
        print($"error: --{name}: unknown flag")
        unsafe {
            exit(1)
        }
        return 0
    }

    // Get a u16 value of a flag. Exits if out of range 0..65535.
    fn getU16(self: &Self, name: &string): u16 {
        let val = self.getI64(name)
        if val < 0 || val > 65535 {
            print($"error: --{name}: value {val} out of range 0..65535")
            unsafe {
                exit(1)
            }
        }
        return val as u16
    }

    // Check if a boolean flag was set.
    fn getBool(self: &Self, name: &string): bool {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name && self.entries[i].present {
                return true
            }
            i = i + 1
        }
        return false
    }

    // Check if a flag was provided on the command line.
    fn has(self: &Self, name: &string): bool {
        var i: i64 = 0
        while i < self.entries.len {
            if self.entries[i].name == name && self.entries[i].present {
                return true
            }
            i = i + 1
        }
        return false
    }
}
`, "std/base64.milo": `// std/base64 — base64 encode/decode

fn _b64EncodeChar(val: u8): u8 {
    if val < 26 {
        return val + 65
    }
    if val < 52 {
        return val - 26 + 97
    }
    if val < 62 {
        return val - 52 + 48
    }
    if val == 62 {
        return 43
    }
    return 47
}

fn _b64DecodeChar(ch: u8): u8 {
    if ch >= 65 && ch <= 90 {
        return ch - 65
    }
    if ch >= 97 && ch <= 122 {
        return ch - 97 + 26
    }
    if ch >= 48 && ch <= 57 {
        return ch - 48 + 52
    }
    if ch == 43 {
        return 62
    }
    if ch == 47 {
        return 63
    }
    return 0
}

// Encode a string to base64.

fn base64Encode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 2 < input.len {
        let a = input[i]
        let b = input[i + 1]
        let c = input[i + 2]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar(((a & 3) << 4) | (b >> 4)))
        result.push(_b64EncodeChar(((b & 15) << 2) | (c >> 6)))
        result.push(_b64EncodeChar(c & 63))
        i = i + 3
    }
    let remaining = input.len - i
    if remaining == 2 {
        let a = input[i]
        let b = input[i + 1]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar(((a & 3) << 4) | (b >> 4)))
        result.push(_b64EncodeChar((b & 15) << 2))
        result.push(61 as u8)
    }
    if remaining == 1 {
        let a = input[i]
        result.push(_b64EncodeChar(a >> 2))
        result.push(_b64EncodeChar((a & 3) << 4))
        result.push(61 as u8)
        result.push(61 as u8)
    }
    return result
}

// Decode a base64 string.

fn base64Decode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 3 < input.len {
        if input[i] == 61 {
            break
        }
        let a = _b64DecodeChar(input[i])
        let b = _b64DecodeChar(input[i + 1])
        let c = _b64DecodeChar(input[i + 2])
        let d = _b64DecodeChar(input[i + 3])
        result.push((a << 2) | (b >> 4))
        if input[i + 2] != 61 {
            result.push(((b & 15) << 4) | (c >> 2))
        }
        if input[i + 3] != 61 {
            result.push(((c & 3) << 6) | d)
        }
        i = i + 4
    }
    return result
}
`, "std/process.milo": `// std/process — command execution and process control

from "std/os" import { execl, exit, fork, kill, read, system, waitpid }
from "std/io" import { readFile }

// ── Simple command execution ──

// Execute a shell command and return its exit code.
// Example: let code = run("ls -la")!

fn run(cmd: &string): Result<i32> {
    unsafe {
        let status = system(cmd)
        if status < 0 {
            return Result.Err("system() failed")
        }
        // macOS: exit code is in bits 8-15
        let exitCode = (status >> 8) & 255
        return Result.Ok(exitCode)
    }
}

// ── Process with lifecycle management ──

// Handle to a spawned child process.

struct Process {
    pid: i32,
}

// Fork and exec a program at the given path.
// Returns a Process handle for lifecycle management.

fn spawn(path: &string): Result<Process> {
    unsafe {
        let pid = fork()
        if pid < 0 {
            return Result.Err("fork() failed")
        }
        if pid == 0 {
            execl(path, path, 0 as *u8)
            exit(127)
        }
        return Result.Ok(Process {
            pid: pid
        }
        )
    }
}

// Block until the process exits and return its exit code.

fn waitFor(p: &Process): Result<i32> {
    var statusBuf: [u8 ; 4] = [0 ; 4]
    unsafe {
        let r = waitpid(p.pid, statusBuf, 0)
        if r < 0 {
            return Result.Err("waitpid() failed")
        }
        let raw = (statusBuf[1]as i32)
        return Result.Ok(raw)
    }
}

// Execute a shell command and return its stdout as a string.
// Uses shell redirection to a temp file under the hood.

fn capture(cmd: &string): Result<string> {
    let tmpPath: string = "/tmp/.milo_capture"
    let fullCmd = cmd + " > " + tmpPath + " 2>&1"
    let code = run(fullCmd)!
    if code != 0 {
        return Result.Err("command failed with exit code")
    }
    let content = readFile(tmpPath)
    match content {
        Result.Ok(s) => {
            return Result.Ok(s)
        }
        Result.Err(e) => {
            return Result.Err("failed to read capture output")
        }
    }
}

// Send a signal to the process (e.g., 9 for SIGKILL, 15 for SIGTERM).

fn signal(p: &Process, sig: i32): Result<i32> {
    unsafe {
        let r = kill(p.pid, sig)
        if r < 0 {
            return Result.Err("kill() failed")
        }
        return Result.Ok(0)
    }
}
`, "std/sort.milo": `// std/sort — in-place sorting for Vec types

// Sort Vec<i64> in ascending order.

fn sortI64(v: &mut Vec<i64>): void {
    _qsortI64(v, 0, v.len - 1)
}

// Sort Vec<i32> in ascending order.

fn sortI32(v: &mut Vec<i32>): void {
    _qsortI32(v, 0 as i32, (v.len - 1) as i32)
}

// Sort Vec<string> in lexicographic order.

fn sortStrings(v: &mut Vec<string>): void {
    _isortStrings(v, 0, v.len - 1)
}

// Reverse a Vec<i64> in place.

fn reverseI64(v: &mut Vec<i64>): void {
    var lo: i64 = 0
    var hi = v.len - 1
    while lo < hi {
        let tmp = v[lo]
        v[lo] = v[hi]
        v[hi] = tmp
        lo = lo + 1
        hi = hi - 1
    }
}

// ── quicksort i64 ──

fn _qsortI64(v: &mut Vec<i64>, lo: i64, hi: i64): void {
    if lo >= hi {
        return
    }
    let pivot = v[hi]
    var i = lo
    var j = lo
    while j < hi {
        if v[j] <= pivot {
            let tmp = v[i]
            v[i] = v[j]
            v[j] = tmp
            i = i + 1
        }
        j = j + 1
    }
    let tmp = v[i]
    v[i] = v[hi]
    v[hi] = tmp
    _qsortI64(v, lo, i - 1)
    _qsortI64(v, i + 1, hi)
}

// ── quicksort i32 ──

fn _qsortI32(v: &mut Vec<i32>, lo: i32, hi: i32): void {
    if lo >= hi {
        return
    }
    let pivot = v[hi]
    var i = lo
    var j = lo
    while j < hi {
        if v[j] <= pivot {
            let tmp = v[i]
            v[i] = v[j]
            v[j] = tmp
            i = i + 1 as i32
        }
        j = j + 1 as i32
    }
    let tmp = v[i]
    v[i] = v[hi]
    v[hi] = tmp
    _qsortI32(v, lo, i - 1 as i32)
    _qsortI32(v, i + 1 as i32, hi)
}

// ── insertion sort for strings (stable, good for small n) ──

fn _strLessThan(a: &string, b: &string): bool {
    var i: i64 = 0
    while i < a.len && i < b.len {
        if a[i] < b[i] {
            return true
        }
        if a[i] > b[i] {
            return false
        }
        i = i + 1
    }
    return a.len < b.len
}

fn _isortStrings(v: &mut Vec<string>, lo: i64, hi: i64): void {
    if lo >= hi {
        return
    }
    var i = lo + 1
    while i <= hi {
        let key = v[i].clone()
        var j = i - 1
        while j >= lo {
            if _strLessThan(key, v[j]) {
                v[j + 1] = v[j].clone()
                j = j - 1
            } else {
                break
            }
        }
        v[j + 1] = key
        i = i + 1
    }
}
`, "std/net.milo": `// std/net — TCP, DNS, HTTP client with automatic cleanup

from "std/os" import { SSL_CTX_free, SSL_CTX_new, SSL_CTX_set_default_verify_paths, SSL_connect, SSL_ctrl, SSL_free, SSL_new, SSL_read, SSL_set_fd, SSL_write, TLS_client_method, close, connect, freeaddrinfo, getaddrinfo, read, socket, write }
from "std/platform" import { SockAddrIn, addrinfoAddrOffset, makeSockaddr }
from "std/json" import { Json, jsonParse }

// ── NetError ──

enum NetError {
    DnsFailure(string),
    ConnectionFailed(string),
    TlsError(string),
    SendFailed(string),
    Other(string),
}

// ── TcpStream ──

// TCP connection handle. Automatically closes the fd when dropped.

struct TcpStream {
    fd: i32,
}

impl Drop for TcpStream {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

// Construct an IPv4 address from four octets.
// Example: ip4(127, 0, 0, 1) for localhost.

fn ip4(a: u8, b: u8, c: u8, d: u8): u32 {
    let a32 = a as u32
    let b32 = b as u32
    let c32 = c as u32
    let d32 = d as u32
    return a32 | (b32 << 8) | (c32 << 16) | (d32 << 24)
}

fn tcpConnect(ip: u32, port: u16): Result<TcpStream, NetError> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let SIZEOF_SOCKADDR_IN: u32 = 16

    unsafe {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return Result.Err(NetError.ConnectionFailed("socket() failed"))
        }

        var addr = makeSockaddr(port, ip)

        if connect(fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            close(fd)
            return Result.Err(NetError.ConnectionFailed("connect() failed"))
        }

        return Result.Ok(TcpStream {
            fd: fd
        }
        )
    }
}

fn tcpSend(s: &TcpStream, data: &string): Result<i64, NetError> {
    unsafe {
        let n = write(s.fd, data, data.len)
        if n < 0 {
            return Result.Err(NetError.SendFailed("tcp send failed"))
        }
        return Result.Ok(n)
    }
}

fn tcpRecv(s: &TcpStream): Result<string, NetError> {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(s.fd, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

// ── TLS Stream ──

// TLS/SSL connection handle. Frees SSL context and closes fd on drop.

struct TlsStream {
    fd: i32,
    ssl: i64,
    ctx: i64,
}

impl Drop for TlsStream {
    fn drop(self: &mut Self): void {
        unsafe {
            if self.ssl != 0 {
                SSL_free(self.ssl as *u8)
            }
            if self.ctx != 0 {
                SSL_CTX_free(self.ctx as *u8)
            }
            if self.fd >= 0 {
                close(self.fd)
            }
        }
    }
}

fn tlsConnect(ip: u32, port: u16, hostname: &string): Result<TlsStream, NetError> {
    let AF_INET: i32 = 2
    let SOCK_STREAM: i32 = 1
    let SIZEOF_SOCKADDR_IN: u32 = 16

    unsafe {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return Result.Err(NetError.ConnectionFailed("socket() failed"))
        }

        var addr = makeSockaddr(port, ip)

        if connect(fd, addr, SIZEOF_SOCKADDR_IN) < 0 {
            close(fd)
            return Result.Err(NetError.ConnectionFailed("connect() failed"))
        }

        let method = TLS_client_method()
        let ctx = SSL_CTX_new(method)
        let ctxAddr = ctx as i64
        if ctxAddr == 0 {
            close(fd)
            return Result.Err(NetError.TlsError("SSL_CTX_new failed"))
        }
        SSL_CTX_set_default_verify_paths(ctx)

        let ssl = SSL_new(ctx)
        let sslAddr = ssl as i64
        if sslAddr == 0 {
            SSL_CTX_free(ctx)
            close(fd)
            return Result.Err(NetError.TlsError("SSL_new failed"))
        }

        // SNI hostname for certificate validation
        SSL_ctrl(ssl, 55, 0, hostname)
        SSL_set_fd(ssl, fd)

        let r = SSL_connect(ssl)
        if r != 1 {
            SSL_free(ssl)
            SSL_CTX_free(ctx)
            close(fd)
            return Result.Err(NetError.TlsError("SSL handshake failed"))
        }

        return Result.Ok(TlsStream {
            fd: fd, ssl: sslAddr, ctx: ctxAddr
        }
        )
    }
}

fn tlsSend(s: &TlsStream, data: &string): Result<i64, NetError> {
    unsafe {
        let n = SSL_write(s.ssl as *u8, data, data.len as i32)
        if n < 0 {
            return Result.Err(NetError.SendFailed("SSL_write failed"))
        }
        return Result.Ok(n as i64)
    }
}

fn tlsRecv(s: &TlsStream): Result<string, NetError> {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = SSL_read(s.ssl as *u8, buf as *u8, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n as i64 {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

// ── DNS ──

fn resolve(hostname: &string): Result<u32, NetError> {
    var hints: [u8 ; 48] = [0 ; 48]
    unsafe {
        let hintsFamily = (hints as *i32)
        hintsFamily[1] = 2
        hintsFamily[2] = 1
    }

    var resBuf: [u8 ; 8] = [0 ; 8]
    unsafe {
        let err = getaddrinfo(hostname, 0 as *u8, hints as *u8, resBuf as *u8)
        if err != 0 {
            return Result.Err(NetError.DnsFailure(hostname.clone()))
        }
        let infoPtr =*(resBuf as *i64)
        let addrPtr =*((infoPtr + addrinfoAddrOffset()) as *i64)
        let ip =*((addrPtr + 4) as *u32)
        freeaddrinfo(infoPtr as *u8)
        return Result.Ok(ip)
    }
}

// ── HTTP Response ──

// HTTP response with status code, headers, and body.

struct Response {
    status: i32,
    headers: string,
    body: string,
}

impl Response {
    // Return the response body as a string.
    fn text(self: &Self): string {
        return self.body.clone()
    }

    // Parse the response body as JSON.
    fn json(self: &Self): Json {
        return jsonParse(self.body.clone())
    }

    // Return true if the status code is 2xx (success).
    fn ok(self: &Self): bool {
        return self.status >= 200 && self.status < 300
    }

    // Look up a response header by name (case-insensitive).
    fn header(self: &Self, name: &string): string {
        return findHeader(self.headers, name)
    }
}

// ── String helpers ──

fn strEqNocase(a: &string, ai: i64, b: &string, blen: i64): bool {
    var i: i64 = 0
    while i < blen {
        var ca: u8 = a[ai + i]
        var cb: u8 = b[i]
        // lowercase ASCII
        if ca >= 'A' && ca <= 'Z' {
            ca = ca + 32
        }
        if cb >= 'A' && cb <= 'Z' {
            cb = cb + 32
        }
        if ca != cb {
            return false
        }
        i = i + 1
    }
    return true
}

fn findHeader(headers: &string, name: &string): string {
    // search for "Name: value" in headers (case-insensitive name match)
    var i: i64 = 0
    while i + name.len + 1 < headers.len {
        // check if we're at line start (i==0 or preceded by \\n)
        if i == 0 || headers[i - 1] == '\\n' {
            if strEqNocase(headers, i, name, name.len) && headers[i + name.len] == ':' {
                var start: i64 = i + name.len + 1
                // skip spaces after colon
                while start < headers.len && headers[start] == ' ' {
                    start = start + 1
                }
                var end: i64 = start
                while end < headers.len && headers[end] != '\\r' && headers[end] != '\\n' {
                    end = end + 1
                }
                return headers[start..end]
            }
        }
        i = i + 1
    }
    return ""
}

fn startsWith(s: &string, prefix: &string): bool {
    if s.len < prefix.len {
        return false
    }
    var i: i64 = 0
    while i < prefix.len {
        if s[i] != prefix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

fn hexDigit(c: u8): i64 {
    if c >= '0' && c <= '9' {
        return (c - '0') as i64
    }
    if c >= 'a' && c <= 'f' {
        return (c - 'a') as i64 + 10
    }
    if c >= 'A' && c <= 'F' {
        return (c - 'A') as i64 + 10
    }
    return - 1 as i64
}

// ── HTTP parsing ──

fn parseStatus(raw: &string): i32 {
    if raw.len < 12 {
        return 0
    }
    var code: i32 = 0
    var i: i64 = 9
    while i < raw.len && raw[i] >= '0' && raw[i] <= '9' {
        code = code * 10 + (raw[i]as i32 - 48)
        i = i + 1
    }
    return code
}

fn parseRawHeaders(raw: &string): string {
    var start: i64 = 0
    var i: i64 = 0
    while i + 1 < raw.len {
        if raw[i] == '\\r' && raw[i + 1] == '\\n' {
            if start == 0 {
                start = i + 2
            }
            if i + 3 < raw.len && raw[i + 2] == '\\r' && raw[i + 3] == '\\n' {
                return raw[start..i]
            }
        }
        i = i + 1
    }
    return ""
}

fn parseBody(raw: &string): string {
    var i: i64 = 0
    while i + 3 < raw.len {
        if raw[i] == '\\r' && raw[i + 1] == '\\n' && raw[i + 2] == '\\r' && raw[i + 3] == '\\n' {
            return raw[i + 4..raw.len]
        }
        i = i + 1
    }
    return raw.clone()
}

fn decodeChunked(rawBody: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < rawBody.len {
        // parse hex chunk size
        var chunkSize: i64 = 0
        while i < rawBody.len {
            let d = hexDigit(rawBody[i])
            if d < 0 {
                break
            }
            chunkSize = chunkSize * 16 + d
            i = i + 1
        }
        // skip \\r\\n after size
        if i + 1 < rawBody.len && rawBody[i] == '\\r' {
            i = i + 2
        }
        if chunkSize == 0 {
            break
        }
        // copy chunk data
        var j: i64 = 0
        while j < chunkSize && i < rawBody.len {
            result.push(rawBody[i])
            i = i + 1
            j = j + 1
        }
        // skip trailing \\r\\n
        if i + 1 < rawBody.len && rawBody[i] == '\\r' {
            i = i + 2
        }
    }
    return result
}

fn parseResponse(raw: string): Response {
    let status = parseStatus(raw)
    let headers = parseRawHeaders(raw)
    var body = parseBody(raw)
    // handle chunked transfer encoding
    let te = findHeader(headers, "Transfer-Encoding")
    let chunked: string = "chunked"
    if startsWith(te, chunked) {
        body = decodeChunked(body)
    }
    return Response {
        status: status, headers: headers, body: body
    }
}

// ── URL parsing ──

fn isHttps(url: &string): bool {
    return url.len > 8 && url[0] == 'h' && url[4] == 's' && url[5] == ':' && url[6] == '/' && url[7] == '/'
}

fn schemeOffset(url: &string): i64 {
    if isHttps(url) {
        return 8
    }
    if url.len > 7 && url[0] == 'h' && url[4] == ':' && url[5] == '/' && url[6] == '/' {
        return 7
    }
    return 0
}

fn parseHost(url: &string): string {
    let start = schemeOffset(url)
    var end: i64 = start
    while end < url.len && url[end] != '/' && url[end] != ':' {
        end = end + 1
    }
    return url[start..end]
}

fn parsePort(url: &string): u16 {
    var i: i64 = schemeOffset(url)
    while i < url.len && url[i] != '/' && url[i] != ':' {
        i = i + 1
    }
    if i < url.len && url[i] == ':' {
        i = i + 1
        var port: i32 = 0
        while i < url.len && url[i] >= '0' && url[i] <= '9' {
            port = port * 10 + (url[i]as i32 - 48)
            i = i + 1
        }
        return port as u16
    }
    if isHttps(url) {
        return 443
    }
    return 80
}

fn parsePath(url: &string): string {
    var i: i64 = schemeOffset(url)
    while i < url.len && url[i] != '/' {
        i = i + 1
    }
    if i >= url.len {
        return "/"
    }
    return url[i..url.len]
}

// ── FetchOptions ──

// HTTP request configuration: method, headers, and body.

struct FetchOptions {
    method: string,
    headers: string,
    body: string,
}

// ── HTTP client ──

fn httpDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError> {
    let stream = tcpConnect(ip, port)?
    var req: string = opts.method.clone() + " " + path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n"
    if opts.headers.len > 0 {
        req = req + opts.headers.clone() + "\\r\\n"
    }
    if opts.body.len > 0 {
        req = req + "Content-Length: " + opts.body.len.toString() + "\\r\\n\\r\\n" + opts.body.clone()
    } else {
        req = req + "\\r\\n"
    }
    tcpSend(stream, req)?
    let raw = tcpRecv(stream)?
    return Result.Ok(parseResponse(raw))
}

fn httpsDo(ip: u32, port: u16, host: string, path: string, opts: &FetchOptions): Result<Response, NetError> {
    let stream = tlsConnect(ip, port, host)?
    var req: string = opts.method.clone() + " " + path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n"
    if opts.headers.len > 0 {
        req = req + opts.headers.clone() + "\\r\\n"
    }
    if opts.body.len > 0 {
        req = req + "Content-Length: " + opts.body.len.toString() + "\\r\\n\\r\\n" + opts.body.clone()
    } else {
        req = req + "\\r\\n"
    }
    tlsSend(stream, req)?
    let raw = tlsRecv(stream)?
    return Result.Ok(parseResponse(raw))
}

fn doFetch(url: string, opts: FetchOptions): Result<Response, NetError> {
    let useTls = isHttps(url)
    let host = parseHost(url)
    let port = parsePort(url)
    let path = parsePath(url)
    let ip = resolve(host)?

    var resp: Result<Response, NetError> = Result.Err(NetError.Other(""))
    if useTls {
        resp = httpsDo(ip, port, host.clone(), path, opts)
    } else {
        resp = httpDo(ip, port, host, path, opts)
    }

    let r = resp?

    // follow redirects (301, 302, 307, 308)
    if r.status == 301 || r.status == 302 || r.status == 307 || r.status == 308 {
        let loc = r.header("Location")
        if loc.len > 0 {
            var redirOpts = FetchOptions {
                method: opts.method.clone(),
                headers: opts.headers.clone(),
                body: opts.body.clone(),
            }
            if r.status == 301 || r.status == 302 {
                redirOpts.method = "GET"
                redirOpts.body = ""
            }
            return doFetch(loc, redirOpts)
        }
    }
    return Result.Ok(r)
}

// ── Public API ──

fn fetch(url: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "GET", headers: "", body: ""
    }
    return doFetch(url.clone(), opts)
}

fn fetchWith(url: &string, opts: FetchOptions): Result<Response, NetError> {
    return doFetch(url.clone(), opts)
}

fn fetchPost(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "POST",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url.clone(), opts)
}

fn fetchPut(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "PUT",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url.clone(), opts)
}

fn fetchDelete(url: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "DELETE", headers: "", body: ""
    }
    return doFetch(url.clone(), opts)
}

fn fetchPatch(url: &string, body: &string): Result<Response, NetError> {
    var opts = FetchOptions {
        method: "PATCH",
        headers: "Content-Type: application/json",
        body: body.clone(),
    }
    return doFetch(url, opts)
}
`, "std/platform.linux.milo": `// platform-specific constants and helpers for Linux

from "std/os" import { htons }

struct SockAddrIn {
    sinFamily: u16,
    sinPort: u16,
    sinAddr: u32,
    sinZero: [u8 ; 8],
}

fn makeSockaddr(port: u16, addr: u32): SockAddrIn {
    unsafe {
        return SockAddrIn {
            sinFamily: 2 as u16,
            sinPort: htons(port),
            sinAddr: addr,
            sinZero: [0 ; 8],
        }
    }
}

fn makeZeroedSockaddr(): SockAddrIn {
    return SockAddrIn {
        sinFamily: 0 as u16, sinPort: 0, sinAddr: 0, sinZero: [0 ; 8],
    }
}

fn solSocket(): i32 {
    return 1
}

fn soReuseaddr(): i32 {
    return 2
}

fn mapPrivateAnon(): i32 {
    return 34
}

fn oWriteCreateTrunc(): i32 {
    return 577
}

fn oWriteCreateAppend(): i32 {
    return 1089
}
// offset of aiAddr field in struct addrinfo (swapped with aiCanonname vs macOS)

fn addrinfoAddrOffset(): i64 {
    return 24
}
// struct stat layout (Linux x8664)

fn statModeOffset(): i64 {
    return 24
}

fn statSizeOffset(): i64 {
    return 48
}

fn statBufSize(): i64 {
    return 144
}
// struct dirent layout

fn direntTypeOffset(): i64 {
    return 18
}

fn direntNameOffset(): i64 {
    return 19
}
// errno access — glibc uses __errno_location() to get errno pointer

extern

fn __errno_location(): *u8

fn getErrno(): i32 {
    unsafe {
        return _loadI32(__errno_location())
    }
}
`, "std/regex.milo": `// std/regex — regular expression matching (wraps POSIX regex.h)


extern

fn regcomp(_preg: *u8, _regex: *u8, _cflags: i32): i32

extern

fn regexec(_preg: *u8, _str: *u8, _nmatch: i64, _pmatch: *u8, _eflags: i32): i32

extern

fn regfree(_preg: *u8): void

// ── Regex handle ──

struct Regex {
    _preg: [u8 ; 128],
    _valid: bool,
}

// Compile a POSIX extended regular expression. Returns None on invalid pattern.

fn regexNew(pattern: string): Option<Regex> {
    var r = Regex {
        _preg: [0 ; 128], _valid: false
    }
    unsafe {
        let rc = regcomp(r._preg, pattern, 1)
        if rc != 0 {
            return Option.None
        }
    }
    r._valid = true
    return Option.Some(r)
}

fn _readMatchI64(buf: &[u8 ; 160], off: i64): i64 {
    var val: i64 = 0
    var k: i64 = 0
    while k < 8 {
        val = val | ((buf[off + k]as i64) << (k * 8))
        k = k + 1
    }
    return val
}

// Test if a string matches the pattern.

fn regexMatch(re: &mut Regex, input: &string): bool {
    unsafe {
        return regexec(re._preg, input, 0, 0 as *u8, 0) == 0
    }
}

// Match result: start and end byte offsets.

struct RegexMatch {
    start: i64,
    end: i64,
}

// Find the first match in a string. Returns None if no match.

fn regexFind(re: &mut Regex, input: &string): Option<RegexMatch> {
    var pmatch: [u8 ; 160] = [0 ; 160]
    unsafe {
        let rc = regexec(re._preg, input, 1, pmatch, 0)
        if rc != 0 {
            return Option.None
        }
    }
    let so = _readMatchI64(pmatch, 0)
    let eo = _readMatchI64(pmatch, 8)
    return Option.Some(RegexMatch {
        start: so, end: eo
    }
    )
}

// Find all non-overlapping matches in a string.

fn regexFindAll(re: &mut Regex, input: &string): Vec<RegexMatch> {
    var matches: Vec<RegexMatch> = Vec.new()
    var offset: i64 = 0
    var pmatch: [u8 ; 160] = [0 ; 160]
    while offset < input.len {
        let tail = input[offset..input.len]
        unsafe {
            let rc = regexec(re._preg, tail, 1, pmatch, 0)
            if rc != 0 {
                break
            }
        }
        let so = _readMatchI64(pmatch, 0)
        let eo = _readMatchI64(pmatch, 8)
        matches.push(RegexMatch {
            start: offset + so, end: offset + eo
        }
        )
        offset = offset + eo
        if so == eo {
            offset = offset + 1
        }
    }
    return matches
}
`, "std/time.milo": `// std/time — wall clock, monotonic timing, sleep


extern

fn gettimeofday(tv: *u8, tz: *u8): i32

extern

fn usleep(usec: u32): i32

// ── helpers ──

fn _readI64FromBuf(buf: &[u8 ; 16], off: i64): i64 {
    var val: i64 = 0
    var i: i64 = 0
    while i < 8 {
        val = val | ((buf[off + i]as i64) << (i * 8))
        i = i + 1
    }
    return val
}

// ── Instant — a point in time ──

struct Instant {
    sec: i64,
    usec: i64,
}

// Capture the current wall-clock time.

fn now(): Instant {
    var tv: [u8 ; 16] = [0 ; 16]
    unsafe {
        gettimeofday(tv, 0 as *u8)
    }
    let sec = _readI64FromBuf(tv, 0)
    let usec = _readI64FromBuf(tv, 8)
    return Instant {
        sec: sec, usec: usec
    }
}

// Milliseconds since Unix epoch.

fn epochMillis(): i64 {
    let t = now()
    return t.sec * 1000 + t.usec / 1000
}

// Seconds since Unix epoch.

fn epochSecs(): i64 {
    let t = now()
    return t.sec
}

// ── Duration — elapsed time between two Instants ──

struct Duration {
    totalUsec: i64,
}

// Elapsed time between two instants.

fn elapsed(start: Instant, end: Instant): Duration {
    let usec = (end.sec - start.sec) * 1000000 + (end.usec - start.usec)
    return Duration {
        totalUsec: usec
    }
}

// Elapsed time since an instant.

fn since(start: Instant): Duration {
    return elapsed(start, now())
}

// Duration accessors.

fn durationSecs(d: &Duration): i64 {
    return d.totalUsec / 1000000
}

fn durationMillis(d: &Duration): i64 {
    return d.totalUsec / 1000
}

fn durationMicros(d: &Duration): i64 {
    return d.totalUsec
}

// ── Sleep ──

// Sleep for the given number of milliseconds.

fn sleepMs(ms: i64): void {
    unsafe {
        usleep((ms * 1000) as u32)
    }
}

// Sleep for the given number of seconds.

fn sleepSecs(secs: i64): void {
    var remaining = secs
    while remaining > 0 {
        var chunk = remaining
        if chunk > 30 {
            chunk = 30
        }
        unsafe {
            usleep((chunk * 1000000) as u32)
        }
        remaining = remaining - chunk
    }
}
`, "std/url.milo": `// std/url — URL parsing into components


struct Url {
    scheme: string,
    host: string,
    port: i32,
    path: string,
    query: string,
    fragment: string,
    raw: string,
}

fn urlParse(s: string): Result<Url> {
    var scheme: string = ""
    var host: string = ""
    var port: i32 = 0
    var path: string = ""
    var query: string = ""
    var fragment: string = ""
    var i: i64 = 0

    // scheme
    var schemeEnd: i64 = 0
    while schemeEnd < s.len {
        if s[schemeEnd] == ':' {
            break
        }
        if s[schemeEnd] == '/' || s[schemeEnd] == '?' || s[schemeEnd] == '#' {
            break
        }
        schemeEnd = schemeEnd + 1
    }
    if schemeEnd < s.len && s[schemeEnd] == ':' {
        scheme = s[0..schemeEnd].clone()
        i = schemeEnd + 1
    }

    // authority (//host:port)
    if i + 1 < s.len && s[i] == '/' && s[i + 1] == '/' {
        i = i + 2
        let authStart = i
        while i < s.len && s[i] != '/' && s[i] != '?' && s[i] != '#' {
            i = i + 1
        }
        let auth = s[authStart..i]

        // split host:port
        var colonPos: i64 = - 1 as i64
        var j: i64 = auth.len - 1
        while j >= 0 {
            if auth[j] == ':' {
                colonPos = j
                break
            }
            if auth[j] == ']' {
                break
            }
            j = j - 1
        }

        if colonPos > 0 {
            host = auth[0..colonPos].clone()
            let portStr = auth[colonPos + 1..auth.len]
            port = _parsePort(portStr)
        } else {
            host = auth.clone()
        }
    }

    // path
    let pathStart = i
    while i < s.len && s[i] != '?' && s[i] != '#' {
        i = i + 1
    }
    path = s[pathStart..i].clone()

    // query
    if i < s.len && s[i] == '?' {
        i = i + 1
        let qStart = i
        while i < s.len && s[i] != '#' {
            i = i + 1
        }
        query = s[qStart..i].clone()
    }

    // fragment
    if i < s.len && s[i] == '#' {
        i = i + 1
        fragment = s[i..s.len].clone()
    }

    // default ports
    if port == 0 {
        if scheme == "http" { port = 80 }
        if scheme == "https" { port = 443 }
    }

    return Result.Ok(Url {
        scheme: scheme, host: host, port: port,
        path: path, query: query, fragment: fragment,
        raw: s.clone(),
    })
}

fn _parsePort(s: &string): i32 {
    var result: i32 = 0
    var i: i64 = 0
    while i < s.len {
        let c = s[i]
        if c < '0' || c > '9' { return 0 }
        result = result * 10 + (c as i32 - 48)
        i = i + 1
    }
    return result
}

fn urlQueryGet(u: &Url, key: &string): Option<string> {
    if u.query.len == 0 { return Option.None }
    var i: i64 = 0
    while i < u.query.len {
        let kStart = i
        while i < u.query.len && u.query[i] != '=' && u.query[i] != '&' {
            i = i + 1
        }
        let k = u.query[kStart..i]
        var val: string = ""
        if i < u.query.len && u.query[i] == '=' {
            i = i + 1
            let vStart = i
            while i < u.query.len && u.query[i] != '&' {
                i = i + 1
            }
            val = u.query[vStart..i].clone()
        }
        if _strEqUrl(k, key) {
            return Option.Some(val)
        }
        if i < u.query.len && u.query[i] == '&' {
            i = i + 1
        }
    }
    return Option.None
}

fn _strEqUrl(a: &string, b: &string): bool {
    if a.len != b.len { return false }
    var i: i64 = 0
    while i < a.len {
        if a[i] != b[i] { return false }
        i = i + 1
    }
    return true
}

fn urlString(u: &Url): string {
    var result: string = ""
    if u.scheme.len > 0 {
        result = result + u.scheme + "://"
    }
    result = result + u.host
    if u.port > 0 && u.port != 80 && u.port != 443 {
        result = result + ":" + format(u.port)
    }
    result = result + u.path
    if u.query.len > 0 {
        result = result + "?" + u.query
    }
    if u.fragment.len > 0 {
        result = result + "#" + u.fragment
    }
    return result
}
`, "std/string.milo": `// std/string — string utility functions

// Check if haystack contains needle.

fn strContains(haystack: &string, needle: &string): bool {
    if needle.len == 0 {
        return true
    }
    if needle.len > haystack.len {
        return false
    }
    var i: i64 = 0
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return true
        }
        i = i + 1
    }
    return false
}

// Find first occurrence of needle in haystack. Returns -1 if not found.

fn strIndexOf(haystack: &string, needle: &string): i64 {
    var notFound: i64 = 0
    notFound = notFound - 1
    if needle.len == 0 {
        return 0 as i64
    }
    if needle.len > haystack.len {
        return notFound
    }
    var i: i64 = 0
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return i
        }
        i = i + 1
    }
    return notFound
}

// Find first occurrence of needle starting at pos. Returns -1 if not found.

fn strIndexOfFrom(haystack: &string, needle: &string, pos: i64): i64 {
    var notFound: i64 = 0
    notFound = notFound - 1
    if needle.len == 0 {
        return pos
    }
    if pos < 0 as i64 {
        return notFound
    }
    if pos + needle.len > haystack.len {
        return notFound
    }
    var i: i64 = pos
    while i <= haystack.len - needle.len {
        var j: i64 = 0
        while j < needle.len {
            if haystack[i + j] != needle[j] {
                break
            }
            j = j + 1
        }
        if j == needle.len {
            return i
        }
        i = i + 1
    }
    return notFound
}

// Check if string starts with prefix.

fn strStartsWith(s: &string, prefix: &string): bool {
    if prefix.len > s.len {
        return false
    }
    var i: i64 = 0
    while i < prefix.len {
        if s[i] != prefix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

// Check if string ends with suffix.

fn strEndsWith(s: &string, suffix: &string): bool {
    if suffix.len > s.len {
        return false
    }
    let offset = s.len - suffix.len
    var i: i64 = 0
    while i < suffix.len {
        if s[offset + i] != suffix[i] {
            return false
        }
        i = i + 1
    }
    return true
}

// Return new string with ASCII uppercase letters converted to lowercase.

fn strToLower(s: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < s.len {
        let ch = s[i]
        if ch >= 65 && ch <= 90 {
            result.push(ch + 32)
        } else {
            result.push(ch)
        }
        i = i + 1
    }
    return result
}

// Return new string with ASCII lowercase letters converted to uppercase.

fn strToUpper(s: &string): string {
    var result: string = ""
    var i: i64 = 0
    while i < s.len {
        let ch = s[i]
        if ch >= 97 && ch <= 122 {
            result.push(ch - 32)
        } else {
            result.push(ch)
        }
        i = i + 1
    }
    return result
}

// Strip leading and trailing ASCII whitespace (space, tab, newline, carriage return).

fn strTrim(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    var end: i64 = s.len
    while end > start {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    if start >= end {
        return ""
    }
    return s.substr(start, end)
}

// Strip leading ASCII whitespace.

fn strTrimStart(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    if start >= s.len {
        return ""
    }
    return s.substr(start, s.len)
}

// Strip trailing ASCII whitespace.

fn strTrimEnd(s: &string): string {
    var end: i64 = s.len
    while end > 0 as i64 {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    if end <= 0 as i64 {
        return ""
    }
    return s.substr(0 as i64, end)
}

// Split string by separator. Returns Vec of substrings.

fn strSplit(s: &string, sep: &string): Vec<string> {
    var result: Vec<string> = Vec.new()
    var notFound: i64 = 0
    notFound = notFound - 1
    if sep.len == 0 {
        var i: i64 = 0
        while i < s.len {
            result.push(s.substr(i, i + 1))
            i = i + 1
        }
        return result
    }
    var pos: i64 = 0
    while pos <= s.len {
        let idx = strIndexOfFrom(s, sep, pos)
        if idx == notFound {
            result.push(s.substr(pos, s.len))
            break
        }
        result.push(s.substr(pos, idx))
        pos = idx + sep.len
    }
    return result
}

// Repeat a string n times.

fn strRepeat(s: &string, n: i64): string {
    var result: string = ""
    var i: i64 = 0
    while i < n {
        result = result + s
        i = i + 1
    }
    return result
}

// Replace all occurrences of old with newVal.

fn strReplace(s: &string, old: &string, newVal: &string): string {
    if old.len == 0 {
        return s.clone()
    }
    var notFound: i64 = 0
    notFound = notFound - 1
    var result: string = ""
    var pos: i64 = 0
    while pos < s.len {
        let idx = strIndexOfFrom(s, old, pos)
        if idx == notFound {
            result = result + s.substr(pos, s.len)
            break
        }
        if idx > pos {
            result = result + s.substr(pos, idx)
        }
        result = result + newVal
        pos = idx + old.len
    }
    return result
}

// Check if a byte is ASCII whitespace.

fn charIsWhitespace(ch: u8): bool {
    return ch == 32 || ch == 9 || ch == 10 || ch == 13
}

// Check if a byte is an ASCII digit.

fn charIsDigit(ch: u8): bool {
    return ch >= 48 && ch <= 57
}

// Check if a byte is an ASCII letter.

fn charIsAlpha(ch: u8): bool {
    return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
}

// Check if a byte is an ASCII letter or digit.

fn charIsAlphanumeric(ch: u8): bool {
    return charIsAlpha(ch) || charIsDigit(ch)
}

// Remove leading and trailing whitespace (spaces, tabs, newlines, carriage returns).

fn trim(s: &string): string {
    var start: i64 = 0
    while start < s.len {
        let ch = s[start]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        start = start + 1
    }
    var end: i64 = s.len
    while end > start {
        let ch = s[end - 1]
        if ch != 32 && ch != 9 && ch != 10 && ch != 13 {
            break
        }
        end = end - 1
    }
    return s.substr(start, end)
}
`, "std/sqlite.milo": `// std/sqlite — SQLite3 database bindings
//
// Requires libsqlite3. Link flag added automatically by compiler.
//
//   let db = dbOpen("app.db")!
//   dbExec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")!
//   dbExec(db, "INSERT INTO users (name) VALUES ('alice')")!
//   let stmt = dbQuery(db, "SELECT id, name FROM users")!
//   while dbStep(stmt) {
//       print($"{dbColumnInt(stmt, 0)} {dbColumnText(stmt, 1)}")
//   }
//   dbFinalize(stmt)
//   dbClose(db)


extern fn sqlite3_open(filename: *u8, db: *u8): i32
extern fn sqlite3_close(db: *u8): i32
extern fn sqlite3_exec(db: *u8, sql: *u8, callback: *u8, arg: *u8, errmsg: *u8): i32
extern fn sqlite3_prepare_v2(db: *u8, sql: *u8, nByte: i32, stmt: *u8, tail: *u8): i32
extern fn sqlite3_step(stmt: *u8): i32
extern fn sqlite3_finalize(stmt: *u8): i32
extern fn sqlite3_column_int(stmt: *u8, col: i32): i32
extern fn sqlite3_column_int64(stmt: *u8, col: i32): i64
extern fn sqlite3_column_double(stmt: *u8, col: i32): f64
extern fn sqlite3_column_text(stmt: *u8, col: i32): *u8
extern fn sqlite3_column_count(stmt: *u8): i32
extern fn sqlite3_column_type(stmt: *u8, col: i32): i32
extern fn sqlite3_bind_int(stmt: *u8, idx: i32, val: i32): i32
extern fn sqlite3_bind_int64(stmt: *u8, idx: i32, val: i64): i32
extern fn sqlite3_bind_double(stmt: *u8, idx: i32, val: f64): i32
extern fn sqlite3_bind_text(stmt: *u8, idx: i32, text: *u8, n: i32, destructor: *u8): i32
extern fn sqlite3_bind_null(stmt: *u8, idx: i32): i32
extern fn sqlite3_reset(stmt: *u8): i32
extern fn sqlite3_errmsg(db: *u8): *u8
extern fn sqlite3_changes(db: *u8): i32
extern fn sqlite3_last_insert_rowid(db: *u8): i64

struct Database {
    _handle: *u8,
}

struct Statement {
    _handle: *u8,
    _db: *u8,
}

fn dbOpen(path: string): Result<Database> {
    unsafe {
        var handle: *u8 = 0 as *u8
        let rc = sqlite3_open(path, (&handle) as *u8)
        if rc != 0 {
            if handle != 0 as *u8 { sqlite3_close(handle) }
            return Result.Err("sqlite3_open failed")
        }
        return Result.Ok(Database { _handle: handle })
    }
}

fn dbClose(db: &Database): void {
    unsafe { sqlite3_close(db._handle) }
}

fn dbExec(db: &Database, sql: string): Result<i32> {
    unsafe {
        let rc = sqlite3_exec(db._handle, sql, 0 as *u8, 0 as *u8, 0 as *u8)
        if rc != 0 {
            let msg = _cstrToString(sqlite3_errmsg(db._handle))
            return Result.Err(msg)
        }
        return Result.Ok(sqlite3_changes(db._handle))
    }
}

fn dbQuery(db: &Database, sql: string): Result<Statement> {
    unsafe {
        var handle: *u8 = 0 as *u8
        let rc = sqlite3_prepare_v2(db._handle, sql, 0 - 1, (&handle) as *u8, 0 as *u8)
        if rc != 0 {
            let msg = _cstrToString(sqlite3_errmsg(db._handle))
            return Result.Err(msg)
        }
        return Result.Ok(Statement { _handle: handle, _db: db._handle })
    }
}

fn dbStep(stmt: &Statement): bool {
    unsafe { return sqlite3_step(stmt._handle) == 100 }
}

fn dbColumnInt(stmt: &Statement, col: i32): i32 {
    unsafe { return sqlite3_column_int(stmt._handle, col) }
}

fn dbColumnInt64(stmt: &Statement, col: i32): i64 {
    unsafe { return sqlite3_column_int64(stmt._handle, col) }
}

fn dbColumnFloat(stmt: &Statement, col: i32): f64 {
    unsafe { return sqlite3_column_double(stmt._handle, col) }
}

fn dbColumnText(stmt: &Statement, col: i32): string {
    unsafe {
        let ptr = sqlite3_column_text(stmt._handle, col)
        if ptr == 0 as *u8 { return "" }
        return _cstrToString(ptr)
    }
}

fn dbColumnCount(stmt: &Statement): i32 {
    unsafe { return sqlite3_column_count(stmt._handle) }
}

fn dbColumnIsNull(stmt: &Statement, col: i32): bool {
    unsafe { return sqlite3_column_type(stmt._handle, col) == 5 }
}

fn dbFinalize(stmt: &Statement): void {
    unsafe { sqlite3_finalize(stmt._handle) }
}

fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_int(stmt._handle, idx, val)
        if rc != 0 { return Result.Err("bind_int failed") }
        return Result.Ok(0)
    }
}

fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_int64(stmt._handle, idx, val)
        if rc != 0 { return Result.Err("bind_int64 failed") }
        return Result.Ok(0)
    }
}

fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_text(stmt._handle, idx, val, 0 - 1, (0 - 1) as *u8)
        if rc != 0 { return Result.Err("bind_text failed") }
        return Result.Ok(0)
    }
}

fn dbBindNull(stmt: &Statement, idx: i32): Result<i32> {
    unsafe {
        let rc = sqlite3_bind_null(stmt._handle, idx)
        if rc != 0 { return Result.Err("bind_null failed") }
        return Result.Ok(0)
    }
}

fn dbReset(stmt: &Statement): void {
    unsafe { sqlite3_reset(stmt._handle) }
}

fn dbLastInsertId(db: &Database): i64 {
    unsafe { return sqlite3_last_insert_rowid(db._handle) }
}
`, "std/json.milo": `// std/json — zero-copy JSON parser with ergonomic accessors
//
// Quick usage:
//   let j = jsonParse(data)!
//   let name = j.str("name")!        // Option<string>
//   let age = j.i64("age")!          // Option<i64>
//   let nested = j.get("addr")!      // Option<Json>

struct Json {
    raw: string,
    start: i64,
    end: i64,
}

impl Json {
    // ── Keyed accessors (object fields) ──

    fn get(self: &Self, key: &string): Option<Json> {
        return jsonGetImpl(self.raw, self.start, self.end, key)
    }

    fn str(self: &Self, key: &string): Option<string> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isStr() {
                return Option.Some(jsonStrImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn i64(self: &Self, key: &string): Option<i64> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isNum() {
                return Option.Some(jsonIntImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn f64(self: &Self, key: &string): Option<f64> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isNum() {
                return Option.Some(jsonNumImpl(j.raw, j.start, j.end))
            }
        }
        return Option.None
    }

    fn bool(self: &Self, key: &string): Option<bool> {
        let v = jsonGetImpl(self.raw, self.start, self.end, key)
        if let Option.Some(j) = v {
            if j.isBool() {
                return Option.Some(j.start < j.end && j.raw[j.start] == 't')
            }
        }
        return Option.None
    }

    // ── Bare value extraction (for array elements, after .get()) ──

    fn asStr(self: &Self): Option<string> {
        if self.isStr() {
            return Option.Some(jsonStrImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asI64(self: &Self): Option<i64> {
        if self.isNum() {
            return Option.Some(jsonIntImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asF64(self: &Self): Option<f64> {
        if self.isNum() {
            return Option.Some(jsonNumImpl(self.raw, self.start, self.end))
        }
        return Option.None
    }

    fn asBool(self: &Self): Option<bool> {
        if self.isBool() {
            return Option.Some(self.start < self.end && self.raw[self.start] == 't')
        }
        return Option.None
    }

    // ── Array access ──

    fn at(self: &Self, index: i64): Option<Json> {
        return jsonAtImpl(self.raw, self.start, self.end, index)
    }

    // ── Type checks ──

    fn isNull(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == 'n'
    }

    fn isStr(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '"'
    }

    fn isNum(self: &Self): bool {
        if self.start >= self.end {
            return false
        }
        let c = self.raw[self.start]
        return c == '-' || (c >= '0' && c <= '9')
    }

    fn isBool(self: &Self): bool {
        if self.start >= self.end {
            return false
        }
        let c = self.raw[self.start]
        return c == 't' || c == 'f'
    }

    fn isArray(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '['
    }

    fn isObject(self: &Self): bool {
        return self.start < self.end && self.raw[self.start] == '{'
    }

    fn len(self: &Self): i64 {
        return jsonLenImpl(self.raw, self.start, self.end)
    }

    fn rawStr(self: &Self): string {
        return self.raw[self.start..self.end].clone()
    }

    // Return all keys of a JSON object.
    fn keys(self: &Self): Vec<string> {
        return jsonKeysImpl(self.raw, self.start, self.end)
    }
}

fn jsonParse(s: string): Result<Json> {
    if s.len == 0 {
        return Result.Err("empty input")
    }
    let i = skipWs(s, 0)
    if i >= s.len {
        return Result.Err("empty input")
    }
    let e = skipValue(s, i)
    let afterWs = skipWs(s, e)
    if afterWs != s.len {
        return Result.Err("trailing content")
    }
    if e == i {
        return Result.Err("invalid JSON")
    }
    return Result.Ok(Json {
        raw: s, start: i, end: e
    }
    )
}

// ── Internal helpers ──

fn skipWs(s: &string, pos: i64): i64 {
    var i: i64 = pos
    while i < s.len {
        let c = s[i]
        if c != ' ' && c != '\\t' && c != '\\n' && c != '\\r' {
            break
        }
        i = i + 1
    }
    return i
}

fn skipValue(s: &string, pos: i64): i64 {
    if pos >= s.len {
        return pos
    }
    let c = s[pos]
    if c == '"' {
        return skipString(s, pos)
    }
    if c == '{' {
        return skipObject(s, pos)
    }
    if c == '[' {
        return skipArray(s, pos)
    }
    if c == 't' {
        return pos + 4
    }
    if c == 'f' {
        return pos + 5
    }
    if c == 'n' {
        return pos + 4
    }
    return skipNumber(s, pos)
}

fn skipString(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    while i < s.len {
        if s[i] == '\\\\' {
            i = i + 2
        } else if s[i] == '"' {
            return i + 1
        } else {
            i = i + 1
        }
    }
    return i
}

fn skipNumber(s: &string, pos: i64): i64 {
    var i: i64 = pos
    if i < s.len && s[i] == '-' {
        i = i + 1
    }
    while i < s.len && s[i] >= '0' && s[i] <= '9' {
        i = i + 1
    }
    if i < s.len && s[i] == '.' {
        i = i + 1
        while i < s.len && s[i] >= '0' && s[i] <= '9' {
            i = i + 1
        }
    }
    if i < s.len && (s[i] == 'e' || s[i] == 'E') {
        i = i + 1
        if i < s.len && (s[i] == '+' || s[i] == '-') {
            i = i + 1
        }
        while i < s.len && s[i] >= '0' && s[i] <= '9' {
            i = i + 1
        }
    }
    return i
}

fn skipObject(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    i = skipWs(s, i)
    if i < s.len && s[i] == '}' {
        return i + 1
    }
    while i < s.len {
        i = skipWs(s, i)
        if i >= s.len || s[i] != '"' {
            break
        }
        i = skipString(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ',' {
            i = i + 1
        } else {
            break
        }
    }
    if i < s.len && s[i] == '}' {
        i = i + 1
    }
    return i
}

fn skipArray(s: &string, pos: i64): i64 {
    var i: i64 = pos + 1
    i = skipWs(s, i)
    if i < s.len && s[i] == ']' {
        return i + 1
    }
    while i < s.len {
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < s.len && s[i] == ',' {
            i = i + 1
        } else {
            break
        }
    }
    if i < s.len && s[i] == ']' {
        i = i + 1
    }
    return i
}

fn keyMatches(s: &string, pos: i64, key: &string): bool {
    if pos >= s.len || s[pos] != '"' {
        return false
    }
    var i: i64 = 0
    var j: i64 = pos + 1
    while i < key.len && j < s.len {
        if s[j] == '\\\\' {
            j = j + 1
            if j >= s.len {
                return false
            }
        }
        if s[j] != key[i] {
            return false
        }
        i = i + 1
        j = j + 1
    }
    return i == key.len && j < s.len && s[j] == '"'
}

fn jsonGetImpl(s: &string, start: i64, end: i64, key: &string): Option<Json> {
    if start >= end || s[start] != '{' {
        return Option.None
    }
    var i: i64 = start + 1
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == '}' {
            return Option.None
        }
        let keyStart = i
        if s[i] != '"' {
            return Option.None
        }
        let keyEnd = skipString(s, i)
        let matched = keyMatches(s, keyStart, key)
        i = skipWs(s, keyEnd)
        if i < end && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        let valStart = i
        let valEnd = skipValue(s, i)
        if matched {
            return Option.Some(Json {
                raw: s.clone(), start: valStart, end: valEnd
            }
            )
        }
        i = skipWs(s, valEnd)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return Option.None
}

fn jsonAtImpl(s: &string, start: i64, end: i64, index: i64): Option<Json> {
    if start >= end || s[start] != '[' {
        return Option.None
    }
    var i: i64 = start + 1
    var idx: i64 = 0
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == ']' {
            return Option.None
        }
        let valStart = i
        let valEnd = skipValue(s, i)
        if idx == index {
            return Option.Some(Json {
                raw: s.clone(), start: valStart, end: valEnd
            }
            )
        }
        idx = idx + 1
        i = skipWs(s, valEnd)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return Option.None
}

fn jsonLenImpl(s: &string, start: i64, end: i64): i64 {
    if start >= end {
        return 0
    }
    let c = s[start]
    if c == '[' {
        var i: i64 = start + 1
        i = skipWs(s, i)
        if i < end && s[i] == ']' {
            return 0
        }
        var count: i64 = 0
        while i < end {
            i = skipWs(s, i)
            if i >= end || s[i] == ']' {
                break
            }
            i = skipValue(s, i)
            count = count + 1
            i = skipWs(s, i)
            if i < end && s[i] == ',' {
                i = i + 1
            }
        }
        return count
    }
    if c == '{' {
        var i: i64 = start + 1
        i = skipWs(s, i)
        if i < end && s[i] == '}' {
            return 0
        }
        var count: i64 = 0
        while i < end {
            i = skipWs(s, i)
            if i >= end || s[i] == '}' {
                break
            }
            i = skipString(s, i)
            i = skipWs(s, i)
            if i < end && s[i] == ':' {
                i = i + 1
            }
            i = skipWs(s, i)
            i = skipValue(s, i)
            count = count + 1
            i = skipWs(s, i)
            if i < end && s[i] == ',' {
                i = i + 1
            }
        }
        return count
    }
    return 0
}

fn jsonStrImpl(s: &string, start: i64, end: i64): string {
    if start >= end || s[start] != '"' {
        return ""
    }
    var result: string = ""
    var i: i64 = start + 1
    while i < end && s[i] != '"' {
        if s[i] == '\\\\' && i + 1 < end {
            i = i + 1
            let esc = s[i]
            if esc == 'n' {
                result.push('\\n')
            } 
            else if esc == 't' {
                result.push('\\t')
            } 
            else if esc == 'r' {
                result.push('\\r')
            } 
            else if esc == '"' {
                result.push('"')
            } 
            else if esc == '\\\\' {
                result.push('\\\\')
            } 
            else if esc == '/' {
                result.push('/')
            } 
            else {
                result.push(esc)
            }
        } else {
            result.push(s[i])
        }
        i = i + 1
    }
    return result
}

fn jsonNumImpl(s: &string, start: i64, end: i64): f64 {
    var result: f64 = 0.0
    var negative: bool = false
    var i: i64 = start
    if i < end && s[i] == '-' {
        negative = true
        i = i + 1
    }
    while i < end && s[i] >= '0' && s[i] <= '9' {
        result = result * 10.0 + (s[i]as i32 - 48) as f64
        i = i + 1
    }
    if i < end && s[i] == '.' {
        i = i + 1
        var frac: f64 = 0.1
        while i < end && s[i] >= '0' && s[i] <= '9' {
            result = result + (s[i]as i32 - 48) as f64 * frac
            frac = frac * 0.1
            i = i + 1
        }
    }
    if negative {
        result = 0.0 - result
    }
    return result
}

fn jsonIntImpl(s: &string, start: i64, end: i64): i64 {
    var result: i64 = 0
    var negative: bool = false
    var i: i64 = start
    if i < end && s[i] == '-' {
        negative = true
        i = i + 1
    }
    while i < end && s[i] >= '0' && s[i] <= '9' {
        result = result * 10 + (s[i]as i32 - 48) as i64
        i = i + 1
    }
    if negative {
        result = 0 - result
    }
    return result
}

fn jsonKeysImpl(s: &string, start: i64, end: i64): Vec<string> {
    var result: Vec<string> = Vec.new()
    if start >= end || s[start] != '{' {
        return result
    }
    var i: i64 = start + 1
    while i < end {
        i = skipWs(s, i)
        if i >= end || s[i] == '}' {
            break
        }
        if s[i] != '"' {
            break
        }
        let keyStart = i
        let keyEnd = skipString(s, i)
        let key = jsonStrImpl(s, keyStart, keyEnd)
        result.push(key)
        i = skipWs(s, keyEnd)
        if i < end && s[i] == ':' {
            i = i + 1
        }
        i = skipWs(s, i)
        i = skipValue(s, i)
        i = skipWs(s, i)
        if i < end && s[i] == ',' {
            i = i + 1
        }
    }
    return result
}
`, "std/platform.darwin.milo": `// platform-specific constants and helpers for macOS/BSD

from "std/os" import { htons }

struct SockAddrIn {
    sinLen: u8,
    sinFamily: u8,
    sinPort: u16,
    sinAddr: u32,
    sinZero: [u8 ; 8],
}

fn makeSockaddr(port: u16, addr: u32): SockAddrIn {
    unsafe {
        return SockAddrIn {
            sinLen: 16 as u8,
            sinFamily: 2 as u8,
            sinPort: htons(port),
            sinAddr: addr,
            sinZero: [0 ; 8],
        }
    }
}

fn makeZeroedSockaddr(): SockAddrIn {
    return SockAddrIn {
        sinLen: 0, sinFamily: 0, sinPort: 0, sinAddr: 0, sinZero: [0 ; 8],
    }
}

fn solSocket(): i32 {
    return 65535
}

fn soReuseaddr(): i32 {
    return 4
}

fn mapPrivateAnon(): i32 {
    return 4098
}

fn oWriteCreateTrunc(): i32 {
    return 1537
}

fn oWriteCreateAppend(): i32 {
    return 521
}
// offset of aiAddr field in struct addrinfo

fn addrinfoAddrOffset(): i64 {
    return 32
}
// struct stat layout (macOS aarch64/x8664)

fn statModeOffset(): i64 {
    return 4
}

fn statSizeOffset(): i64 {
    return 96
}

fn statBufSize(): i64 {
    return 144
}
// struct dirent layout

fn direntTypeOffset(): i64 {
    return 20
}

fn direntNameOffset(): i64 {
    return 21
}
// errno access — macOS uses __error() to get errno pointer

extern

fn __error(): *u8

fn getErrno(): i32 {
    unsafe {
        return _loadI32(__error())
    }
}
`, "std/fs.milo": `// std/fs — filesystem operations

from "std/os" import { access, closedir, opendir, read, readdir, stat }
from "std/io" import { IoError, openWrite, writeAll }
from "std/platform" import { direntNameOffset, direntTypeOffset, statBufSize, statModeOffset, statSizeOffset }

// File metadata from stat().

struct FileInfo {
    size: i64,
    mode: i32,
    exists: bool,
}

// Get file metadata. Returns FileInfo with exists=false if path doesn't exist.

fn fileInfo(path: &string): FileInfo {
    var buf: [u8 ; 144] = [0 ; 144]
    unsafe {
        let r = stat(path, buf)
        if r != 0 {
            return FileInfo {
                size: 0 as i64, mode: 0, exists: false
            }
        }
        let modeOff = statModeOffset()
        let sizeOff = statSizeOffset()
        // read u16 mode (macOS) — works for permission bits
        let modeLo = buf[modeOff]as i32
        let modeHi = buf[modeOff + 1]as i32
        let mode = modeLo | (modeHi << 8)
        // read i64 size
        var size: i64 = 0
        var i: i64 = 0
        while i < 8 {
            size = size | ((buf[sizeOff + i]as i64) << (i * 8))
            i = i + 1
        }
        return FileInfo {
            size: size, mode: mode, exists: true
        }
    }
}

// Check if a path exists.

fn pathExists(path: &string): bool {
    unsafe {
        return access(path, 0) == 0
    }
}

// Check if a path is a directory.

fn isDir(path: &string): bool {
    let info = fileInfo(path)
    if !info.exists {
        return false
    }
    // S_IFDIR = 0x4000 = 16384, S_IFMT = 0xF000 = 61440
    return (info.mode & 61440) == 16384
}

// Check if a path is a regular file.

fn isFile(path: &string): bool {
    let info = fileInfo(path)
    if !info.exists {
        return false
    }
    // S_IFREG = 0x8000 = 32768
    return (info.mode & 61440) == 32768
}

// Get file size in bytes. Returns -1 if file doesn't exist.

fn fileSizePath(path: &string): i64 {
    let info = fileInfo(path)
    var negOne: i64 = 0
    negOne = negOne - 1
    if !info.exists {
        return negOne
    }
    return info.size
}

// Directory entry from readDir().

struct DirEntry {
    name: string,
    isDir: bool,
    isFile: bool,
}

// List directory contents. Returns empty vec on error.

fn readDir(path: &string): Vec<DirEntry> {
    var entries: Vec<DirEntry> = Vec.new()
    unsafe {
        let dir = opendir(path)
        if dir as i64 == 0 as i64 {
            return entries
        }
        let nameOff = direntNameOffset()
        let typeOff = direntTypeOffset()
        while true {
            let ent = readdir(dir)
            if ent as i64 == 0 as i64 {
                break
            }
            let dType = _loadU8((ent as i64 + typeOff) as *u8)
            let namePtr = (ent as i64 + nameOff) as *u8
            let name = _cstrToString(namePtr)

            if name == "." || name == ".." {
                let skip = 0
            } else {
                // DT_DIR = 4, DT_REG = 8
                entries.push(DirEntry {
                    name: name,
                    isDir: dType == 4,
                    isFile: dType == 8,
                }
                )
            }
        }
        closedir(dir)
    }
    return entries
}

// Write a string to a file, creating or truncating it.

fn writeFile(path: &string, data: &string): Result<i64, IoError> {
    let f = openWrite(path)?
    return writeAll(f, data)
}
`, "std/hex.milo": `// std/hex — hex encode/decode for strings

fn _hexChar(val: u8): u8 {
    if val < 10 {
        return val + 48
    }
    return val - 10 + 97
}

fn _hexVal(ch: u8): u8 {
    if ch >= 48 && ch <= 57 {
        return ch - 48
    }
    if ch >= 97 && ch <= 102 {
        return ch - 97 + 10
    }
    if ch >= 65 && ch <= 70 {
        return ch - 65 + 10
    }
    return 0
}

// Encode a string as hex (each byte becomes two hex chars).

fn hexEncode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i < input.len {
        let b = input[i]
        result.push(_hexChar(b >> 4))
        result.push(_hexChar(b & 15))
        i = i + 1
    }
    return result
}

// Decode a hex string back to bytes.

fn hexDecode(input: &string): string {
    var result = ""
    var i: i64 = 0
    while i + 1 < input.len {
        let hi = _hexVal(input[i])
        let lo = _hexVal(input[i + 1])
        result.push(((hi << 4) | lo) as u8)
        i = i + 2
    }
    return result
}
`, "std/io.milo": `// std/io — file and directory I/O with automatic cleanup

from "std/os" import { close, lseek, open, read, strerror, write }
from "std/platform" import { getErrno, oWriteCreateAppend, oWriteCreateTrunc }

// ── IoError ──

enum IoError {
    NotFound(string),
    PermissionDenied(string),
    IsDirectory(string),
    AlreadyExists(string),
    Other(string),
}

// map errno to IoError variant with path context

fn _ioError(path: &string): IoError {
    unsafe {
        let e = getErrno()
        if e == 2 {
            return IoError.NotFound(path.clone())
        }
        if e == 13 {
            return IoError.PermissionDenied(path.clone())
        }
        if e == 21 {
            return IoError.IsDirectory(path.clone())
        }
        if e == 17 {
            return IoError.AlreadyExists(path.clone())
        }
        let reason = _cstrToString(strerror(e))
        return IoError.Other("'" + path + "': " + reason)
    }
}

// Write a string to stdout without appending a newline.

fn writeStdout(s: &string): void {
    unsafe {
        write(1, s, s.len)
    }
}

// ── File ──

// Owned file handle. Automatically closes the fd when dropped.

struct File {
    fd: i32,
}

impl Drop for File {
    fn drop(self: &mut Self): void {
        if self.fd >= 0 {
            unsafe {
                close(self.fd)
            }
        }
    }
}

fn openRead(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, 0)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn openWrite(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, oWriteCreateTrunc(), 420)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn openAppend(path: &string): Result<File, IoError> {
    unsafe {
        let fd = open(path, oWriteCreateAppend(), 420)
        if fd < 0 {
            return Result.Err(_ioError(path))
        }
        return Result.Ok(File {
            fd: fd
        }
        )
    }
}

fn fileSize(f: &File): i64 {
    unsafe {
        let cur = lseek(f.fd, 0, 1)
        let size = lseek(f.fd, 0, 2)
        lseek(f.fd, cur, 0)
        return size
    }
}

fn readAll(f: &File): Result<string, IoError> {
    let size = fileSize(f)
    if size < 0 {
        return Result.Err(IoError.Other("failed to get file size"))
    }
    unsafe {
        lseek(f.fd, 0, 0)
    }
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(f.fd, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return Result.Ok(result)
}

fn writeAll(f: &File, data: &string): Result<i64, IoError> {
    unsafe {
        let n = write(f.fd, data, data.len)
        if n < 0 {
            return Result.Err(IoError.Other("write failed"))
        }
        return Result.Ok(n)
    }
}

fn readFile(path: &string): Result<string, IoError> {
    let f = openRead(path)?
    return readAll(f)
}

// Write a string to stdout without a trailing newline.

fn writeStr(s: &string): void {
    unsafe { write(1, s, s.len) }
}

// Write a single byte to stdout.

fn putChar(ch: u8): void {
    var _pcBuf: [u8; 1] = [0; 1]
    _pcBuf[0] = ch
    unsafe { write(1, _pcBuf, 1) }
}

// Split a string into lines on newline boundaries.

fn splitLines(content: &string): Vec<string> {
    var result: Vec<string> = Vec.new()
    var cur = ""
    var idx: i64 = 0
    while idx < content.len {
        let byte = content[idx]
        if byte == 10 {
            result.push(cur)
            cur = ""
        } else {
            if byte != 13 {
                cur.push(byte)
            }
        }
        idx = idx + 1
    }
    if cur.len > 0 {
        result.push(cur)
    }
    return result
}

// Read a file and return its contents as a Vec of lines.

fn readLines(path: &string): Result<Vec<string>, IoError> {
    let content = readFile(path)?
    return Result.Ok(splitLines(content))
}

// Read a single line from a file descriptor (reads byte-by-byte until newline or EOF).

fn _readLineFd(fd: i32): Option<string> {
    var _rlBuf: [u8 ; 1] = [0 ; 1]
    var _rlResult = ""
    var _rlGot = false
    while true {
        unsafe {
            let n = read(fd, _rlBuf, 1)
            if n <= 0 {
                if _rlGot {
                    return Option.Some(_rlResult)
                }
                return Option.None
            }
        }
        _rlGot = true
        if _rlBuf[0] == 10 {
            return Option.Some(_rlResult)
        }
        if _rlBuf[0] != 13 {
            _rlResult.push(_rlBuf[0])
        }
    }
    return Option.None
}

// Read a single line from stdin. Returns None at EOF.

fn readLine(): Option<string> {
    return _readLineFd(0)
}

// Read all available data from stdin into a string.

fn readStdin(): string {
    var result: string = ""
    var buf: [u8 ; 4096] = [0 ; 4096]
    while true {
        unsafe {
            let n = read(0, buf, 4096)
            if n <= 0 {
                break
            }
            var i: i64 = 0
            while i < n {
                result.push(buf[i])
                i = i + 1
            }
        }
    }
    return result
}
` }[preludeKey]).tokenize()).parse();
    structs.push(...prelude.structs);
    enums.push(...prelude.enums);
    functions.push(...prelude.functions);
    traits.push(...prelude.traits);
    impls.push(...prelude.impls);
    processImports(prelude);
  }
  structs.push(...program.structs);
  enums.push(...program.enums);
  functions.push(...program.functions);
  traits.push(...program.traits);
  impls.push(...program.impls);
  processImports(program);
  function dedup(arr) {
    const seen = new Set;
    const result = [];
    for (let i = arr.length - 1;i >= 0; i--) {
      if (!seen.has(arr[i].name)) {
        seen.add(arr[i].name);
        result.unshift(arr[i]);
      }
    }
    return result;
  }
  return { structs: dedup(structs), enums: dedup(enums), functions: dedup(functions), imports: [], traits: dedup(traits), impls };
}
function compile(source) {
  try {
    const tokens = new Lexer(source).tokenize();
    const program = new Parser(tokens).parse();
    const resolved = resolveImportsPlayground(program);
    const checked = new TypeChecker().check(resolved);
    const errors = checked.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      const formatted = errors.map((d) => formatDiagnostic(d, source)).join(`

`);
      return { ok: false, error: formatted };
    }
    const hirModule = lower(resolved, checked, "/playground");
    const js = new CodegenJS().generate(hirModule);
    return { ok: true, js };
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
}
function compileAndRun(source) {
  try {
    const tokens = new Lexer(source).tokenize();
    const program = new Parser(tokens).parse();
    const resolved = resolveImportsPlayground(program);
    const checked = new TypeChecker().check(resolved);
    const errors = checked.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      const formatted = errors.map((d) => formatDiagnostic(d, source)).join(`

`);
      return { ok: false, error: formatted };
    }
    const hirModule = lower(resolved, checked, "/playground");
    const fullJs = new CodegenJS().generate(hirModule);
    const bodyJs = new CodegenJS().generateBody(hirModule);
    const captured = [];
    const runtime = `
      const __out = [];
      function __print(s) { __out.push(String(s)); }
      function __flush() { if (__out.length) { __captured.push(__out.join('')); __out.length = 0; } }
      function __assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }
      function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }
      function __eq(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => __eq(v, b[i])); const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => __eq(a[k], b[k])); }
    `;
    const fn = new Function("__captured", runtime + bodyJs);
    fn(captured);
    return { ok: true, js: fullJs, output: captured.join("") };
  } catch (e) {
    if (e.message) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: String(e) };
  }
}
globalThis.MiloPlayground = { compile, compileAndRun };
export {
  compileAndRun,
  compile
};
