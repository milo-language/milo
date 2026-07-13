import { Token, TokenKind } from "./tokens";
import { Lexer } from "./lexer";
import { ParseError } from "./diagnostics";
import type {
  MiloType, Param, Expr, Stmt, Function, Program, StructDecl, StructField,
  EnumDecl, EnumVariant, Pattern, MatchArm, Span, ImportDecl, CastExpr,
  TraitDecl, TraitMethod, ImplDecl, Attribute, TypeAlias, InterfaceDecl, GlobalDecl,
} from "./ast";

export class Parser {
  private pos = 0;

  // `source`/`filePath` are optional — when provided, thrown ParseErrors carry them
  // so the CLI renders the offending file's source line + caret (essential for errors
  // inside imported files, which would otherwise render against the entry file).
  constructor(private tokens: Token[], private source?: string, private filePath?: string) {}

  private cloneExpr(e: Expr): Expr { return structuredClone(e); }
  private peek(): Token { return this.tokens[this.pos]; }
  private peekN(n: number): Token { return this.tokens[this.pos + n]; }
  // adjacent same-kind tokens with no intervening whitespace — used for << and >>
  private atAdjacent(k: TokenKind): boolean {
    const a = this.peek();
    const b = this.peekN(1);
    return a && b && a.kind === k && b.kind === k && a.line === b.line && b.col === a.col + 1;
  }
  private advance(): Token { return this.tokens[this.pos++]; }
  private span(tok: Token): Span { return { line: tok.line, col: tok.col }; }

  private at(kind: TokenKind): boolean { return this.peek().kind === kind; }

  private match(kind: TokenKind): Token | null {
    if (this.at(kind)) return this.advance();
    return null;
  }

  private expect(kind: TokenKind): Token {
    const tok = this.advance();
    if (tok.kind !== kind) this.error(`expected '${kind}', got '${tok.kind}' ('${tok.value}')`, tok, kind);
    return tok;
  }

  // Throw a parse error carrying a structured Diagnostic (span + message + hint).
  // `expected`, when given, drives a precise "expected X" hint; a ';' reaching here
  // is mid-expression (trailing/separating ';' is tolerated in parseStmts), so the
  // hint reflects that ';' is a statement separator, not valid inside an expression.
  private error(msg: string, tok: Token, expected?: TokenKind, hintOverride?: string): never {
    let hint = hintOverride;
    if (hint === undefined) {
      if (tok.kind === TokenKind.Semicolon) {
        hint = "';' separates statements and can't appear inside an expression — remove it";
      } else if (expected !== undefined) {
        hint = `expected '${expected}' here`;
      }
    }
    throw new ParseError({
      severity: "error",
      span: { line: tok.line, col: tok.col },
      message: msg,
      hint,
      code: "parse",
    }, this.source, this.filePath);
  }

  parse(): Program {
    const structs: StructDecl[] = [];
    const enums: EnumDecl[] = [];
    const functions: Function[] = [];
    const imports: ImportDecl[] = [];
    const traits: TraitDecl[] = [];
    const impls: ImplDecl[] = [];
    const typeAliases: TypeAlias[] = [];
    const interfaces: InterfaceDecl[] = [];
    const globals: GlobalDecl[] = [];
    while (!this.at(TokenKind.Eof)) {
      // trailing ';' after a top-level decl is a cosmetic no-op (see parseStmts)
      if (this.match(TokenKind.Semicolon)) continue;
      // collect attributes before struct/enum
      let attrs: Attribute[] | undefined;
      while (this.at(TokenKind.At)) {
        if (!attrs) attrs = [];
        attrs.push(this.parseAttribute());
      }
      if (this.at(TokenKind.Import) || this.at(TokenKind.From)) {
        imports.push(this.parseImport());
      } else if (this.at(TokenKind.Struct)) {
        const s = this.parseStruct();
        if (attrs) s.attributes = attrs;
        structs.push(s);
      } else if (this.at(TokenKind.Enum)) {
        const e = this.parseEnum();
        if (attrs) e.attributes = attrs;
        enums.push(e);
      } else if (this.at(TokenKind.Extern)) {
        const nextTok = this.tokens[this.pos + 1];
        if (nextTok && nextTok.kind === TokenKind.Struct) {
          const s = this.parseExternStruct();
          if (attrs) s.attributes = attrs;
          structs.push(s);
        } else if (nextTok && nextTok.kind === TokenKind.Type) {
          structs.push(this.parseExternType());
        } else {
          functions.push(this.parseExternFn());
        }
      } else if (this.at(TokenKind.Fn)) {
        functions.push(this.parseFn());
      } else if (this.at(TokenKind.Trait)) {
        traits.push(this.parseTraitDecl());
      } else if (this.at(TokenKind.Impl)) {
        impls.push(this.parseImplDecl());
      } else if (this.at(TokenKind.Type)) {
        typeAliases.push(this.parseTypeAlias());
      } else if (this.at(TokenKind.Interface)) {
        interfaces.push(this.parseInterfaceDecl());
      } else if (this.at(TokenKind.Let) || this.at(TokenKind.Var)) {
        globals.push(this.parseGlobalDecl());
      } else if (this.at(TokenKind.Ident) && this.peek().value === "thread_local") {
        globals.push(this.parseGlobalDecl());
      } else {
        this.error(`expected declaration, got '${this.peek().kind}'`, this.peek());
      }
    }
    return { structs, enums, functions, imports, traits, impls, typeAliases, interfaces, globals };
  }

  private parseImport(): ImportDecl {
    if (this.at(TokenKind.From)) {
      const tok = this.advance();
      const pathTok = this.expect(TokenKind.String);
      this.expect(TokenKind.Import);
      // from "path" import { a, b, c }
      this.expect(TokenKind.LBrace);
      const names: string[] = [];
      while (!this.at(TokenKind.RBrace)) {
        names.push(this.expect(TokenKind.Ident).value);
        this.match(TokenKind.Comma);
      }
      this.expect(TokenKind.RBrace);
      return { kind: "ImportDecl", path: pathTok.value, names, span: { line: tok.line, col: tok.col } };
    }
    // bare import "path" → error with hint
    if (this.at(TokenKind.Import)) {
      const tok = this.advance();
      const pathTok = this.expect(TokenKind.String);
      this.error(`use 'from "${pathTok.value}" import { ... }'`, tok);
    }
    this.error("expected 'from' import declaration", this.peek());
  }

  // ── Types ──

  private parseType(): MiloType {
    // &T or &mut T
    if (this.match(TokenKind.Amp)) {
      const isMut = !!this.match(TokenKind.Mut);
      const inner = this.parseType();
      return { ...inner, isRef: !isMut, isRefMut: isMut };
    }
    // *T
    if (this.match(TokenKind.Star)) {
      const inner = this.parseType();
      return { ...inner, isPtr: true };
    }
    // [T] or [T; N]
    if (this.match(TokenKind.LBracket)) {
      const inner = this.parseType();
      let arraySize: number | null = null;
      if (this.match(TokenKind.Semicolon)) {
        arraySize = parseInt(this.expect(TokenKind.Int).value);
      }
      this.expect(TokenKind.RBracket);
      return { name: inner.name, isPtr: false, isRef: false, isRefMut: false, isArray: true, arraySize };
    }
    // (T1, T2) => R
    if (this.at(TokenKind.LParen) && this.isFnType()) {
      this.advance();
      const fnParams: MiloType[] = [];
      while (!this.at(TokenKind.RParen)) {
        fnParams.push(this.parseType());
        if (!this.at(TokenKind.RParen)) this.expect(TokenKind.Comma);
      }
      this.expect(TokenKind.RParen);
      this.expect(TokenKind.FatArrow);
      const fnRet = this.parseType();
      return { name: "fn", isFn: true, fnParams, fnRet, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    const tok = this.advance();
    let typeArgs: MiloType[] | undefined;
    if (this.at(TokenKind.Lt)) {
      this.advance();
      typeArgs = [this.parseType()];
      while (this.match(TokenKind.Comma)) {
        typeArgs.push(this.parseType());
      }
      this.expect(TokenKind.Gt);
    }
    let result: MiloType = { name: tok.value, typeArgs, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    // i32(0..50000) — range constraint on integer types (must be on same line to avoid ambiguity)
    if (this.at(TokenKind.LParen) && !typeArgs && this.peek().line === tok.line) {
      const isIntType = /^[iu]\d+$|^int$|^byte$/.test(tok.value);
      if (isIntType) {
        this.advance(); // consume (
        let negative = false;
        if (this.match(TokenKind.Minus)) negative = true;
        const minTok = this.expect(TokenKind.Int);
        const rangeMin = (negative ? -1 : 1) * parseInt(minTok.value);
        this.expect(TokenKind.DotDot);
        negative = false;
        if (this.match(TokenKind.Minus)) negative = true;
        const maxTok = this.expect(TokenKind.Int);
        const rangeMax = (negative ? -1 : 1) * parseInt(maxTok.value);
        this.expect(TokenKind.RParen);
        result.rangeMin = rangeMin;
        result.rangeMax = rangeMax;
      }
    }
    // T? desugars to Option<T>
    if (this.match(TokenKind.Question)) {
      result = { name: "Option", typeArgs: [result], isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    return result;
  }

  // ── Type Alias ──

  private parseTypeAlias(): TypeAlias {
    const tok = this.expect(TokenKind.Type);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Eq);
    const type = this.parseType();
    return { kind: "TypeAlias", name, type, span: this.span(tok) };
  }

  // ── Struct ──

  private parseStruct(): StructDecl {
    this.expect(TokenKind.Struct);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    this.expect(TokenKind.LBrace);
    const fields: StructField[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const fieldName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Colon);
      const fieldType = this.parseType();
      fields.push({ name: fieldName, type: fieldType });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "StructDecl", name, typeParams, fields };
  }

  // ── Enum ──

  private parseEnum(): EnumDecl {
    this.expect(TokenKind.Enum);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    this.expect(TokenKind.LBrace);
    const variants: EnumVariant[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const variantName = this.expect(TokenKind.Ident).value;
      const fields: MiloType[] = [];
      if (this.match(TokenKind.LParen)) {
        while (!this.at(TokenKind.RParen)) {
          fields.push(this.parseType());
          this.match(TokenKind.Comma);
        }
        this.expect(TokenKind.RParen);
      }
      variants.push({ name: variantName, fields });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "EnumDecl", name, typeParams, variants };
  }

  // ── Functions ──

  private parseParam(): Param {
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Colon);
    const type = this.parseType();
    return { name, type };
  }

  private parseParamList(): { params: Param[]; variadic: boolean } {
    this.expect(TokenKind.LParen);
    const params: Param[] = [];
    let variadic = false;
    while (!this.at(TokenKind.RParen)) {
      if (this.at(TokenKind.DotDotDot)) {
        this.advance();
        variadic = true;
        break;
      }
      params.push(this.parseParam());
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    return { params, variadic };
  }

  private parseReturnType(): MiloType {
    if (this.match(TokenKind.Colon)) return this.parseType();
    return { name: "void", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
  }

  private parseExternFn(): Function {
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    return { kind: "Function", name, typeParams: [], params, retType, contracts: [], body: [], isExtern: true, isVariadic: variadic };
  }

  private parseExternType(): StructDecl {
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Type);
    const name = this.expect(TokenKind.Ident).value;
    return { kind: "StructDecl", name, typeParams: [], fields: [], isExtern: true, isOpaque: true };
  }

  private parseExternStruct(): StructDecl {
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Struct);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    if (typeParams.length > 0) this.error(`extern structs cannot have type parameters`, this.peek());
    this.expect(TokenKind.LBrace);
    const fields: StructField[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const fieldName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Colon);
      const fieldType = this.parseType();
      fields.push({ name: fieldName, type: fieldType });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "StructDecl", name, typeParams: [], fields, isExtern: true };
  }

  private parseFn(): Function {
    this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    const contracts = this.parseContracts();
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "Function", name, typeParams, params, retType, contracts, body, isExtern: false, isVariadic: variadic };
  }

  private parseContracts(): import("./ast").Contract[] {
    const contracts: import("./ast").Contract[] = [];
    while (this.at(TokenKind.Requires) || this.at(TokenKind.Ensures) || this.at(TokenKind.Invariant)) {
      const s = this.span(this.peek());
      const kind = this.advance().value as "requires" | "ensures" | "invariant";
      const expr = this.parseExpr();
      contracts.push({ kind, expr, span: s });
    }
    return contracts;
  }

  private parseTypeParams(): import("./ast").TypeParam[] {
    const typeParams: import("./ast").TypeParam[] = [];
    if (this.match(TokenKind.Lt)) {
      typeParams.push(this.parseOneTypeParam());
      while (this.match(TokenKind.Comma)) {
        typeParams.push(this.parseOneTypeParam());
      }
      this.expect(TokenKind.Gt);
    }
    return typeParams;
  }

  private parseOneTypeParam(): import("./ast").TypeParam {
    const name = this.expect(TokenKind.Ident).value;
    const bounds: string[] = [];
    if (this.match(TokenKind.Colon)) {
      bounds.push(this.expect(TokenKind.Ident).value);
      while (this.match(TokenKind.Plus)) {
        bounds.push(this.expect(TokenKind.Ident).value);
      }
    }
    return { name, bounds };
  }

  private parseAttribute(): Attribute {
    this.expect(TokenKind.At);
    const name = this.expect(TokenKind.Ident).value;
    const args: string[] = [];
    if (this.match(TokenKind.LParen)) {
      args.push(this.expect(TokenKind.Ident).value);
      while (this.match(TokenKind.Comma)) {
        args.push(this.expect(TokenKind.Ident).value);
      }
      this.expect(TokenKind.RParen);
    }
    return { name, args };
  }

  private parseTraitDecl(): TraitDecl {
    const tok = this.expect(TokenKind.Trait);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    const supertraits: string[] = [];
    if (this.match(TokenKind.Colon)) {
      supertraits.push(this.expect(TokenKind.Ident).value);
      while (this.match(TokenKind.Plus)) {
        supertraits.push(this.expect(TokenKind.Ident).value);
      }
    }
    this.expect(TokenKind.LBrace);
    const methods: TraitMethod[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      methods.push(this.parseTraitMethod());
    }
    this.expect(TokenKind.RBrace);
    return { kind: "TraitDecl", name, typeParams, supertraits, methods, span: this.span(tok) };
  }

  private parseTraitMethod(): TraitMethod {
    const tok = this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    const { params } = this.parseParamList();
    const retType = this.parseReturnType();
    let body: Stmt[] | null = null;
    if (this.at(TokenKind.LBrace)) {
      this.advance();
      body = this.parseStmts();
      this.expect(TokenKind.RBrace);
    }
    return { name, params, retType, body, span: this.span(tok) };
  }

  private parseInterfaceDecl(): InterfaceDecl {
    const tok = this.expect(TokenKind.Interface);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LBrace);
    const methods: TraitMethod[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      methods.push(this.parseTraitMethod());
    }
    this.expect(TokenKind.RBrace);
    return { kind: "InterfaceDecl", name, methods, span: this.span(tok) };
  }

  private parseImplDecl(): ImplDecl {
    const tok = this.expect(TokenKind.Impl);
    const firstName = this.expect(TokenKind.Ident).value;
    let traitName: string | null = null;
    let typeName: string;
    const typeParams = this.parseTypeParams();
    if (this.match(TokenKind.For)) {
      traitName = firstName;
      typeName = this.expect(TokenKind.Ident).value;
    } else {
      typeName = firstName;
    }
    this.expect(TokenKind.LBrace);
    const methods: Function[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      methods.push(this.parseFn());
    }
    this.expect(TokenKind.RBrace);
    return { kind: "ImplDecl", traitName, typeName, typeParams, methods, span: this.span(tok) };
  }

  // ── Statements ──

  private parseStmts(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      // ';' is cosmetic in Milo — statements are newline/grammar-delimited, so a
      // trailing (or same-line separating, or empty) ';' is a no-op. Tolerated at
      // boundaries only; a ';' inside an expression still errors in parseExpr.
      if (this.match(TokenKind.Semicolon)) continue;
      stmts.push(this.parseStmt());
    }
    return stmts;
  }

  private parseStmt(): Stmt {
    if (this.at(TokenKind.Let)) return this.parseLet();
    if (this.at(TokenKind.Var)) return this.parseVar();
    if (this.at(TokenKind.Return)) return this.parseReturn();
    if (this.at(TokenKind.If)) return this.parseIf();
    if (this.at(TokenKind.While)) return this.parseWhile();
    if (this.at(TokenKind.For)) return this.parseFor();
    if (this.at(TokenKind.Match)) return this.parseMatch();
    if (this.at(TokenKind.Break)) { const s = this.span(this.advance()); return { kind: "BreakStmt", span: s }; }
    if (this.at(TokenKind.Continue)) { const s = this.span(this.advance()); return { kind: "ContinueStmt", span: s }; }
    if (this.at(TokenKind.Unsafe)) {
      const s = this.span(this.advance());
      this.expect(TokenKind.LBrace);
      const body = this.parseStmts();
      this.expect(TokenKind.RBrace);
      return { kind: "UnsafeBlock", body, span: s };
    }

    const expr = this.parseExpr();
    // assignment: x = ..., x.field = ..., x[i] = ...
    if (this.at(TokenKind.Eq)) {
      this.advance();
      const value = this.parseExpr();
      return { kind: "Assign", target: expr, value, span: expr.span };
    }
    // compound assignment: x += ..., x -= ..., etc.
    const compoundOps: Record<string, string> = {
      [TokenKind.PlusEq]: "+", [TokenKind.MinusEq]: "-",
      [TokenKind.StarEq]: "*", [TokenKind.SlashEq]: "/", [TokenKind.PercentEq]: "%",
      [TokenKind.AmpEq]: "&", [TokenKind.PipeEq]: "|", [TokenKind.CaretEq]: "^",
    };
    const op = compoundOps[this.peek().kind];
    if (op) {
      this.advance();
      const rhs = this.parseExpr();
      const value: Expr = { kind: "BinOp", op, left: this.cloneExpr(expr), right: rhs, span: expr.span };
      return { kind: "Assign", target: expr, value, span: expr.span };
    }
    return { kind: "ExprStmt", expr, span: expr.span };
  }

  private parseGlobalDecl(): GlobalDecl {
    const s = this.span(this.peek());
    // optional `thread_local` modifier (contextual keyword) → per-thread storage
    let threadLocal = false;
    if (this.at(TokenKind.Ident) && this.peek().value === "thread_local") {
      threadLocal = true;
      this.advance();
    }
    const mutable = this.at(TokenKind.Var);
    this.advance();
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    return { kind: "GlobalDecl", name, type, value, mutable, threadLocal, span: s };
  }

  // Tokens that can never begin an expression. Seeing one where a binding's
  // value should be means the value is missing (e.g. `let x =` then `return`).
  private static readonly NON_EXPR_START = new Set<TokenKind>([
    TokenKind.Let, TokenKind.Var, TokenKind.Return, TokenKind.Else,
    TokenKind.While, TokenKind.For, TokenKind.Break, TokenKind.Continue,
    TokenKind.Semicolon, TokenKind.RBrace, TokenKind.Eof,
  ]);

  // After consuming `=`, error if no expression follows. Anchored at the binding
  // keyword, not the unrelated next token: the real cause is the dangling
  // `let x =` a line earlier, so pointing the caret there (with the offending
  // token named in the message) is what makes the diagnostic land.
  private requireBindingValue(kw: "let" | "var", name: string, kwTok: Token): void {
    const next = this.peek();
    if (Parser.NON_EXPR_START.has(next.kind)) {
      this.error(
        `${kw} binding '${name}' has no value after '='`,
        kwTok, undefined,
        `expected an expression after '=' — found '${next.value}'; e.g. '${kw} ${name} = 0'`,
      );
    }
  }

  private parseLet(): Stmt {
    const letTok = this.expect(TokenKind.Let);
    const s = this.span(letTok);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    this.requireBindingValue("let", name, letTok);
    const value = this.parseExpr();
    return { kind: "LetDecl", name, type, value, span: s };
  }

  private parseVar(): Stmt {
    const varTok = this.expect(TokenKind.Var);
    const s = this.span(varTok);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    this.requireBindingValue("var", name, varTok);
    const value = this.parseExpr();
    return { kind: "VarDecl", name, type, value, span: s };
  }

  private parseReturn(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.Return);
    if (this.at(TokenKind.RBrace)) return { kind: "Return", value: null, span: s };
    return { kind: "Return", value: this.parseExpr(), span: s };
  }

  private parseIf(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.If);
    if (this.at(TokenKind.Let)) {
      return this.parseIfLet(s);
    }
    const cond = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const thenBody = this.parseStmts();
    this.expect(TokenKind.RBrace);
    let elseBody: Stmt[] | null = null;
    if (this.match(TokenKind.Else)) {
      if (this.at(TokenKind.If)) {
        elseBody = [this.parseIf()];
      } else {
        this.expect(TokenKind.LBrace);
        elseBody = this.parseStmts();
        this.expect(TokenKind.RBrace);
      }
    }
    return { kind: "IfStmt", cond, thenBody, elseBody, span: s };
  }

  private parseIfExpr(s: Span): Expr {
    this.expect(TokenKind.If);
    const cond = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const thenBody = this.parseStmts();
    this.expect(TokenKind.RBrace);
    this.expect(TokenKind.Else);
    let elseBody: Stmt[];
    if (this.at(TokenKind.If)) {
      const innerSpan = this.span(this.peek());
      elseBody = [{ kind: "ExprStmt" as const, expr: this.parseIfExpr(innerSpan), span: innerSpan }];
    } else {
      this.expect(TokenKind.LBrace);
      elseBody = this.parseStmts();
      this.expect(TokenKind.RBrace);
    }
    // An arm block whose tail is a statement-form `if/else` still yields that
    // if's value in expression context. parseStmts parsed it as an IfStmt (no
    // value); reinterpret it as an if-expression so nested `if c { a } else { b }`
    // arms typecheck and codegen as values. Scoped to if-expr arms, so plain
    // statement-ifs elsewhere are untouched.
    this.valueTailToExpr(thenBody);
    this.valueTailToExpr(elseBody);
    return { kind: "IfExpr", cond, thenBody, elseBody, span: s };
  }

  // Rewrite a block's trailing statement-form if/else into an if-expression, in
  // place, recursing so deeply-nested arms convert too.
  private valueTailToExpr(body: Stmt[]): void {
    if (body.length === 0) return;
    const last = body[body.length - 1];
    if (last.kind === "IfStmt" && last.elseBody) {
      this.valueTailToExpr(last.thenBody);
      this.valueTailToExpr(last.elseBody);
      const asExpr: Expr = { kind: "IfExpr", cond: last.cond, thenBody: last.thenBody, elseBody: last.elseBody, span: last.span };
      body[body.length - 1] = { kind: "ExprStmt", expr: asExpr, span: last.span };
    }
  }

  private parseIfLet(s: Span): Stmt {
    this.expect(TokenKind.Let);
    const pattern = this.parsePattern();
    this.expect(TokenKind.Eq);
    const subject = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const thenBody = this.parseStmts();
    this.expect(TokenKind.RBrace);
    let elseBody: Stmt[] | null = null;
    if (this.match(TokenKind.Else)) {
      this.expect(TokenKind.LBrace);
      elseBody = this.parseStmts();
      this.expect(TokenKind.RBrace);
    }
    return { kind: "IfLetStmt", pattern, subject, thenBody, elseBody, span: s };
  }

  private parseWhile(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.While);
    // `while let P = subj { body }` desugars to
    //   `while true { if let P = subj { body } else { break } }`
    // so the existing if-let + while machinery handles binding and exhaustion.
    if (this.at(TokenKind.Let)) {
      this.expect(TokenKind.Let);
      const pattern = this.parsePattern();
      this.expect(TokenKind.Eq);
      const subject = this.parseExpr();
      const invariants = this.parseContracts().filter(c => c.kind === "invariant");
      this.expect(TokenKind.LBrace);
      const body = this.parseStmts();
      this.expect(TokenKind.RBrace);
      const ifLet: Stmt = {
        kind: "IfLetStmt", pattern, subject, thenBody: body,
        elseBody: [{ kind: "BreakStmt", span: s }], span: s,
      };
      return { kind: "WhileStmt", cond: { kind: "BoolLit", value: true, span: s }, invariants, body: [ifLet], span: s };
    }
    const cond = this.parseExpr();
    const invariants = this.parseContracts().filter(c => c.kind === "invariant");
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "WhileStmt", cond, invariants, body, span: s };
  }

  private parseFor(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.For);
    const varName = this.expect(TokenKind.Ident).value;
    let varName2: string | null = null;
    if (this.match(TokenKind.Comma)) {
      varName2 = this.expect(TokenKind.Ident).value;
    }
    this.expect(TokenKind.In);
    const iterableOrStart = this.parseExpr();
    let iterable: Expr;
    if (this.match(TokenKind.DotDot)) {
      const end = this.parseExpr();
      iterable = { kind: "RangeExpr", start: iterableOrStart, end, span: iterableOrStart.span };
    } else {
      iterable = iterableOrStart;
    }
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "ForInStmt", varName, varName2, iterable, body, span: s };
  }

  // ── Match ──

  private parseMatch(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.Match);
    const subject = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const arms: MatchArm[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const pattern = this.parsePattern();
      this.expect(TokenKind.FatArrow);
      this.expect(TokenKind.LBrace);
      const body = this.parseStmts();
      this.expect(TokenKind.RBrace);
      arms.push({ pattern, body });
    }
    this.expect(TokenKind.RBrace);
    return { kind: "MatchStmt", subject, arms, span: s };
  }

  // Expression-position match: each arm yields a value. Accepts both a braced
  // block (`P => { stmts; value }`) and a bare expression (`P => value`) with an
  // optional trailing comma, so `match o { Some(x) => x, None => 0 }` works.
  private parseMatchExpr(s: Span): Expr {
    this.expect(TokenKind.Match);
    const subject = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const arms: MatchArm[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const pattern = this.parsePattern();
      this.expect(TokenKind.FatArrow);
      let body: Stmt[];
      if (this.at(TokenKind.LBrace)) {
        this.expect(TokenKind.LBrace);
        body = this.parseStmts();
        this.expect(TokenKind.RBrace);
        this.valueTailToExpr(body);
      } else {
        const es = this.span(this.peek());
        body = [{ kind: "ExprStmt", expr: this.parseExpr(), span: es }];
      }
      arms.push({ pattern, body });
      this.match(TokenKind.Comma); // optional separator between arms
    }
    this.expect(TokenKind.RBrace);
    return { kind: "MatchExpr", subject, arms, span: s };
  }

  private parsePattern(): Pattern {
    const tok = this.peek();
    const s = this.span(tok);
    if (tok.kind === TokenKind.Ident && tok.value === "_") {
      this.advance();
      return { kind: "WildcardPattern", span: s };
    }
    // Literal patterns: integers, floats, strings, chars, bools
    if (tok.kind === TokenKind.Int) {
      this.advance();
      return { kind: "LiteralPattern", value: Number(tok.value), literalKind: "int", span: s };
    }
    if (tok.kind === TokenKind.Float) {
      this.advance();
      return { kind: "LiteralPattern", value: Number(tok.value), literalKind: "float", span: s };
    }
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "LiteralPattern", value: tok.value, literalKind: "string", span: s };
    }
    if (tok.kind === TokenKind.Char) {
      this.advance();
      return { kind: "LiteralPattern", value: tok.value, literalKind: "char", span: s };
    }
    if (tok.kind === TokenKind.True) {
      this.advance();
      return { kind: "LiteralPattern", value: true, literalKind: "bool", span: s };
    }
    if (tok.kind === TokenKind.False) {
      this.advance();
      return { kind: "LiteralPattern", value: false, literalKind: "bool", span: s };
    }
    // Negative integer/float literal
    if (tok.kind === TokenKind.Minus) {
      const next = this.tokens[this.pos + 1];
      if (next && (next.kind === TokenKind.Int || next.kind === TokenKind.Float)) {
        this.advance(); // consume -
        const numTok = this.advance();
        const lk = numTok.kind === TokenKind.Int ? "int" as const : "float" as const;
        return { kind: "LiteralPattern", value: -Number(numTok.value), literalKind: lk, span: s };
      }
    }
    const enumName = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Dot);
    const variant = this.expect(TokenKind.Ident).value;
    const bindings: string[] = [];
    if (this.match(TokenKind.LParen)) {
      while (!this.at(TokenKind.RParen)) {
        bindings.push(this.expect(TokenKind.Ident).value);
        this.match(TokenKind.Comma);
      }
      this.expect(TokenKind.RParen);
    }
    return { kind: "EnumPattern", enumName, variant, bindings, span: s };
  }

  // ── Expression parsing (precedence climbing) ──

  private parseExpr(): Expr {
    let left = this.parseOr();
    if (this.at(TokenKind.QuestionQuestion)) {
      this.advance();
      const defaultExpr = this.parseOr();
      left = { kind: "DefaultValue", operand: left, default: defaultExpr, span: left.span };
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.at(TokenKind.PipePipe)) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "BinOp", op: "||", left, right, span: left.span };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseBitOr();
    while (this.at(TokenKind.AmpAmp)) {
      this.advance();
      const right = this.parseBitOr();
      left = { kind: "BinOp", op: "&&", left, right, span: left.span };
    }
    return left;
  }

  private parseBitOr(): Expr {
    let left = this.parseBitXor();
    while (this.at(TokenKind.Pipe)) {
      this.advance();
      const right = this.parseBitXor();
      left = { kind: "BinOp", op: "|", left, right, span: left.span };
    }
    return left;
  }

  private parseBitXor(): Expr {
    let left = this.parseBitAnd();
    while (this.at(TokenKind.Caret)) {
      this.advance();
      const right = this.parseBitAnd();
      left = { kind: "BinOp", op: "^", left, right, span: left.span };
    }
    return left;
  }

  private parseBitAnd(): Expr {
    let left = this.parseComparison();
    // single & between exprs (&& already consumed at higher level)
    while (this.at(TokenKind.Amp) && this.peekN(1).kind !== TokenKind.Mut) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: "BinOp", op: "&", left, right, span: left.span };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseShift();
    if (this.at(TokenKind.Is)) {
      this.advance();
      const pattern = this.parsePattern();
      return { kind: "IsExpr", operand: left, pattern, span: left.span };
    }
    while (this.peek().kind === TokenKind.EqEq || this.peek().kind === TokenKind.Neq ||
           this.peek().kind === TokenKind.LtEq || this.peek().kind === TokenKind.GtEq ||
           // single Lt/Gt only when not part of an adjacent shift pair (handled at parseShift)
           (this.peek().kind === TokenKind.Lt && !this.atAdjacent(TokenKind.Lt)) ||
           (this.peek().kind === TokenKind.Gt && !this.atAdjacent(TokenKind.Gt))) {
      const opTok = this.advance();
      const right = this.parseShift();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseShift(): Expr {
    let left = this.parseAdditive();
    while (this.atAdjacent(TokenKind.Lt) || this.atAdjacent(TokenKind.Gt)) {
      const isLeft = this.peek().kind === TokenKind.Lt;
      this.advance(); this.advance();
      const right = this.parseAdditive();
      left = { kind: "BinOp", op: isLeft ? "<<" : ">>", left, right, span: left.span };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().kind === TokenKind.Plus || this.peek().kind === TokenKind.Minus) {
      const opTok = this.advance();
      const right = this.parseMultiplicative();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === TokenKind.Star || this.peek().kind === TokenKind.Slash || this.peek().kind === TokenKind.Percent) {
      // `*` on a new line is unary dereference, not binary multiply
      if (this.peek().kind === TokenKind.Star && this.pos > 0 && this.tokens[this.pos - 1].line < this.peek().line) break;
      const opTok = this.advance();
      const right = this.parseUnary();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().kind === TokenKind.Minus || this.peek().kind === TokenKind.Bang || this.peek().kind === TokenKind.Star || this.peek().kind === TokenKind.Tilde || this.peek().kind === TokenKind.Amp) {
      const tok = this.advance();
      const operand = this.parseUnary();
      return { kind: "UnaryOp", op: tok.value, operand, span: this.span(tok) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at(TokenKind.Dot)) {
        this.advance();
        const fieldTok = this.expect(TokenKind.Ident);
        const field = fieldTok.value;
        if (this.at(TokenKind.LParen) && this.peek().line === fieldTok.line) {
          this.advance();
          const args: Expr[] = [];
          while (!this.at(TokenKind.RParen)) {
            args.push(this.parseExpr());
            this.match(TokenKind.Comma);
          }
          this.expect(TokenKind.RParen);
          expr = { kind: "MethodCall", object: expr, method: field, args, span: expr.span };
        } else {
          expr = { kind: "FieldAccess", object: expr, field, span: expr.span };
        }
      } else if (this.at(TokenKind.LBracket)) {
        this.advance();
        const first = this.parseExpr();
        if (this.at(TokenKind.DotDot)) {
          this.advance();
          const end = this.parseExpr();
          this.expect(TokenKind.RBracket);
          // s[a..b] desugars to s.slice(a, b) — zero-copy &string
          expr = { kind: "MethodCall", object: expr, method: "slice", args: [first, end], span: expr.span };
        } else {
          this.expect(TokenKind.RBracket);
          expr = { kind: "IndexAccess", object: expr, index: first, span: expr.span };
        }
      } else if (this.at(TokenKind.Bang)) {
        this.advance();
        expr = { kind: "Unwrap", operand: expr, span: expr.span };
      } else if (this.at(TokenKind.Question)) {
        this.advance();
        expr = { kind: "Propagate", operand: expr, span: expr.span };
      } else if (this.at(TokenKind.As)) {
        this.advance();
        const targetType = this.parseType();
        expr = { kind: "CastExpr", operand: expr, targetType, span: expr.span };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    const s = this.span(tok);

    if (tok.kind === TokenKind.Int) {
      this.advance();
      // lexer already normalized hex/binary to a plain decimal string and
      // stripped underscores, so BigInt() parses it losslessly.
      return { kind: "IntLit", value: BigInt(tok.value), span: s };
    }
    if (tok.kind === TokenKind.Float) {
      this.advance();
      return { kind: "FloatLit", value: parseFloat(tok.value), span: s };
    }
    if (tok.kind === TokenKind.True) {
      this.advance();
      return { kind: "BoolLit", value: true, span: s };
    }
    if (tok.kind === TokenKind.False) {
      this.advance();
      return { kind: "BoolLit", value: false, span: s };
    }
    if (tok.kind === TokenKind.Null) {
      this.advance();
      return { kind: "EnumLit", enumName: "Option", variant: "None", args: [], span: s };
    }
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "StringLit", value: tok.value, span: s };
    }
    if (tok.kind === TokenKind.FString) {
      this.advance();
      return this.parseFString(tok.value, s);
    }
    if (tok.kind === TokenKind.Char) {
      this.advance();
      return { kind: "CharLit", value: parseInt(tok.value), span: s };
    }
    if (tok.kind === TokenKind.Ident) {
      this.advance();
      // enum variant: Name.Variant or Name.Variant(args)
      if (this.at(TokenKind.Dot) && tok.value[0] >= "A" && tok.value[0] <= "Z") {
        this.advance();
        const variant = this.expect(TokenKind.Ident).value;
        const args: Expr[] = [];
        if (this.match(TokenKind.LParen)) {
          while (!this.at(TokenKind.RParen)) {
            args.push(this.parseExpr());
            this.match(TokenKind.Comma);
          }
          this.expect(TokenKind.RParen);
        }
        return { kind: "EnumLit", enumName: tok.value, variant, args, span: s };
      }
      // generic static call: Name<TypeArgs>.method(args)
      if (this.at(TokenKind.Lt) && tok.value[0] >= "A" && tok.value[0] <= "Z") {
        const saved = this.pos;
        try {
          this.advance(); // consume <
          const typeArgs: import("./ast").MiloType[] = [this.parseType()];
          while (this.match(TokenKind.Comma)) {
            typeArgs.push(this.parseType());
          }
          this.expect(TokenKind.Gt);
          this.expect(TokenKind.Dot);
          const variant = this.expect(TokenKind.Ident).value;
          const args: Expr[] = [];
          if (this.match(TokenKind.LParen)) {
            while (!this.at(TokenKind.RParen)) {
              args.push(this.parseExpr());
              this.match(TokenKind.Comma);
            }
            this.expect(TokenKind.RParen);
          }
          return { kind: "EnumLit", enumName: tok.value, variant, args, typeArgs, span: s };
        } catch {
          this.pos = saved;
        }
      }
      // struct literal: Name { field: value, ... }
      // disambiguate from control-flow braces via lookahead: empty `{}` or `{ IDENT :`
      if (this.at(TokenKind.LBrace) && tok.value[0] >= "A" && tok.value[0] <= "Z"
          && (this.peekN(1).kind === TokenKind.RBrace
              || (this.peekN(1).kind === TokenKind.Ident && this.peekN(2).kind === TokenKind.Colon))) {
        return this.parseStructLit(tok.value, s);
      }
      // sizeOf<Type>() / zeroed<Type>() / offsetOf<Type>("field") — builtins with explicit type arg
      if ((tok.value === "sizeOf" || tok.value === "zeroed" || tok.value === "offsetOf") && this.at(TokenKind.Lt)) {
        this.advance(); // consume <
        const typeArg = this.parseType();
        this.expect(TokenKind.Gt);
        this.expect(TokenKind.LParen);
        const args: Expr[] = [];
        if (!this.at(TokenKind.RParen)) {
          args.push(this.parseExpr());
        }
        this.expect(TokenKind.RParen);
        return { kind: "Call", func: tok.value, args, typeArgs: [typeArg], span: s };
      }
      // function call: name(args) — `(` must be on same line to avoid cross-line ambiguity
      if (this.at(TokenKind.LParen) && this.peek().line === tok.line) return this.parseCall(tok.value, s);
      return { kind: "Ident", name: tok.value, span: s };
    }
    // array literal: [a, b, c]
    if (tok.kind === TokenKind.LBracket) {
      return this.parseArrayLit();
    }
    if (tok.kind === TokenKind.Move) {
      this.advance(); // consume 'move'
      if (this.at(TokenKind.LParen) && this.isArrowClosure()) {
        const closure = this.parseClosure(s);
        (closure as any).isMove = true;
        return closure;
      }
      this.error("'move' must precede a closure", tok);
    }
    if (tok.kind === TokenKind.LParen) {
      if (this.isArrowClosure()) {
        return this.parseClosure(s);
      }
      this.advance();
      const expr = this.parseExpr();
      this.expect(TokenKind.RParen);
      return expr;
    }

    // anonymous struct literal: { field: value, ... }
    if (tok.kind === TokenKind.LBrace && this.peekN(1).kind === TokenKind.Ident && this.peekN(2).kind === TokenKind.Colon) {
      return this.parseStructLit("", s);
    }

    if (tok.kind === TokenKind.If) {
      return this.parseIfExpr(s);
    }

    if (tok.kind === TokenKind.Match) {
      return this.parseMatchExpr(s);
    }

    this.error(`unexpected token '${tok.kind}'`, tok);
  }

  private parseStructLit(name: string, span: Span): Expr {
    this.expect(TokenKind.LBrace);
    const fields: { name: string; value: Expr }[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const fieldName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Colon);
      const value = this.parseExpr();
      fields.push({ name: fieldName, value });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "StructLit", name, fields, span };
  }

  private parseCall(name: string, span: Span): Expr {
    this.expect(TokenKind.LParen);
    const args: Expr[] = [];
    while (!this.at(TokenKind.RParen)) {
      args.push(this.parseExpr());
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    return { kind: "Call", func: name, args, span };
  }

  private parseArrayLit(): Expr {
    const s = this.span(this.peek());
    this.expect(TokenKind.LBracket);
    const elements: Expr[] = [];
    while (!this.at(TokenKind.RBracket)) {
      elements.push(this.parseExpr());
      // [value; count] repeat syntax
      if (elements.length === 1 && this.match(TokenKind.Semicolon)) {
        const count = parseInt(this.expect(TokenKind.Int).value);
        this.expect(TokenKind.RBracket);
        return { kind: "ArrayRepeat", value: elements[0], count, span: s };
      }
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBracket);
    return { kind: "ArrayLit", elements, span: s };
  }

  // lookahead: is this ( a function type like (T1, T2) => R?
  private isFnType(): boolean {
    let i = this.pos + 1;
    let depth = 1;
    while (depth > 0 && i < this.tokens.length) {
      if (this.tokens[i].kind === TokenKind.LParen) depth++;
      else if (this.tokens[i].kind === TokenKind.RParen) depth--;
      i++;
    }
    return i < this.tokens.length && this.tokens[i].kind === TokenKind.FatArrow;
  }

  // lookahead: is this ( the start of an arrow closure?
  // () =>  or  (ident : ...) =>
  private isArrowClosure(): boolean {
    const saved = this.pos;
    this.advance(); // skip (
    if (this.at(TokenKind.RParen)) {
      this.advance();
      if (this.at(TokenKind.FatArrow)) { this.pos = saved; return true; }
      if (this.at(TokenKind.Colon)) { this.pos = saved; return true; }
      this.pos = saved;
      return false;
    }
    if (this.at(TokenKind.Ident)) {
      this.advance();
      if (this.at(TokenKind.Colon)) { this.pos = saved; return true; }
      // untyped params: (x) => ..., (x, y) => ...
      if (this.at(TokenKind.Comma) || this.at(TokenKind.RParen)) {
        while (!this.at(TokenKind.RParen) && !this.at(TokenKind.Eof)) this.advance();
        if (this.at(TokenKind.RParen)) {
          this.advance();
          if (this.at(TokenKind.FatArrow) || this.at(TokenKind.Colon)) {
            this.pos = saved;
            return true;
          }
        }
      }
    }
    this.pos = saved;
    return false;
  }

  // (params) => expr  or  (params): RetType => { body }
  private parseClosure(span: Span): Expr {
    this.expect(TokenKind.LParen);
    const params: Param[] = [];
    while (!this.at(TokenKind.RParen)) {
      const name = this.expect(TokenKind.Ident).value;
      const type = this.at(TokenKind.Colon) ? (this.advance(), this.parseType()) : null;
      params.push({ name, type });
      if (!this.at(TokenKind.RParen)) this.expect(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    const retType = this.at(TokenKind.Colon) ? (this.advance(), this.parseType()) : null;
    this.expect(TokenKind.FatArrow);
    let body: Stmt[];
    if (this.match(TokenKind.LBrace)) {
      body = this.parseStmts();
      this.expect(TokenKind.RBrace);
    } else {
      const expr = this.parseExpr();
      body = [{ kind: "Return" as const, value: expr, span: expr.span }];
    }
    return { kind: "Closure", params, retType, body, span };
  }

  // $"hello {name}, you are {age} years old" → format("hello ", name, ", you are ", age, " years old")
  private parseFString(raw: string, span: Span): Expr {
    const args: Expr[] = [];
    let lit = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "{") {
        if (lit.length > 0) { args.push({ kind: "StringLit", value: lit, span }); lit = ""; }
        i++;
        let depth = 1;
        let exprStr = "";
        while (i < raw.length && depth > 0) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") { depth--; if (depth === 0) { i++; break; } }
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
    if (lit.length > 0) args.push({ kind: "StringLit", value: lit, span });
    if (args.length === 1 && args[0].kind === "StringLit") return args[0];
    return { kind: "Call", func: "format", args, span };
  }
}
