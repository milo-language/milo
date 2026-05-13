import { Token, TokenKind } from "./tokens";
import type {
  MiloType, Param, Expr, Stmt, Function, Program, StructDecl, StructField,
  EnumDecl, EnumVariant, Pattern, MatchArm, Span, ImportDecl, CastExpr,
  TraitDecl, TraitMethod, ImplDecl, Attribute,
} from "./ast";

export class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private span(tok: Token): Span { return { line: tok.line, col: tok.col }; }

  private at(kind: TokenKind): boolean { return this.peek().kind === kind; }

  private match(kind: TokenKind): Token | null {
    if (this.at(kind)) return this.advance();
    return null;
  }

  private expect(kind: TokenKind): Token {
    const tok = this.advance();
    if (tok.kind !== kind) this.error(`expected '${kind}', got '${tok.kind}' ('${tok.value}')`, tok);
    return tok;
  }

  private error(msg: string, tok: Token): never {
    throw new Error(`error[parse]: ${tok.line}:${tok.col}: ${msg}`);
  }

  parse(): Program {
    const structs: StructDecl[] = [];
    const enums: EnumDecl[] = [];
    const functions: Function[] = [];
    const imports: ImportDecl[] = [];
    const traits: TraitDecl[] = [];
    const impls: ImplDecl[] = [];
    while (!this.at(TokenKind.Eof)) {
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
        functions.push(this.parseExternFn());
      } else if (this.at(TokenKind.Fn)) {
        functions.push(this.parseFn());
      } else if (this.at(TokenKind.Trait)) {
        traits.push(this.parseTraitDecl());
      } else if (this.at(TokenKind.Impl)) {
        impls.push(this.parseImplDecl());
      } else {
        this.error(`expected declaration, got '${this.peek().kind}'`, this.peek());
      }
    }
    return { structs, enums, functions, imports, traits, impls };
  }

  private parseImport(): ImportDecl {
    // from "path" import { a, b, c }
    if (this.at(TokenKind.From)) {
      const tok = this.advance();
      const pathTok = this.expect(TokenKind.String);
      this.expect(TokenKind.Import);
      this.expect(TokenKind.LBrace);
      const names: string[] = [];
      while (!this.at(TokenKind.RBrace)) {
        names.push(this.expect(TokenKind.Ident).value);
        this.match(TokenKind.Comma);
      }
      this.expect(TokenKind.RBrace);
      return { kind: "ImportDecl", path: pathTok.value, names, span: { line: tok.line, col: tok.col } };
    }
    // import "path" (glob — backward compat)
    const tok = this.expect(TokenKind.Import);
    const pathTok = this.expect(TokenKind.String);
    return { kind: "ImportDecl", path: pathTok.value, names: null, span: { line: tok.line, col: tok.col } };
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
    // fn(T1, T2): R
    if (this.at(TokenKind.Fn)) {
      this.advance();
      this.expect(TokenKind.LParen);
      const fnParams: MiloType[] = [];
      while (!this.at(TokenKind.RParen)) {
        fnParams.push(this.parseType());
        if (!this.at(TokenKind.RParen)) this.expect(TokenKind.Comma);
      }
      this.expect(TokenKind.RParen);
      this.expect(TokenKind.Colon);
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
    // T? desugars to Option<T>
    if (this.match(TokenKind.Question)) {
      result = { name: "Option", typeArgs: [result], isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    return result;
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
    return { kind: "Function", name, typeParams: [], params, retType, body: [], isExtern: true, isVariadic: variadic };
  }

  private parseFn(): Function {
    this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "Function", name, typeParams, params, retType, body, isExtern: false, isVariadic: variadic };
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
    if (this.at(TokenKind.Match)) return this.parseMatch();
    if (this.at(TokenKind.Break)) { const s = this.span(this.advance()); return { kind: "BreakStmt", span: s }; }
    if (this.at(TokenKind.Continue)) { const s = this.span(this.advance()); return { kind: "ContinueStmt", span: s }; }

    const expr = this.parseExpr();
    // assignment: x = ..., x.field = ..., x[i] = ...
    if (this.at(TokenKind.Eq)) {
      this.advance();
      const value = this.parseExpr();
      return { kind: "Assign", target: expr, value, span: expr.span };
    }
    return { kind: "ExprStmt", expr, span: expr.span };
  }

  private parseLet(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.Let);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    return { kind: "LetDecl", name, type, value, span: s };
  }

  private parseVar(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.Var);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
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
    const cond = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "WhileStmt", cond, body, span: s };
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

  private parsePattern(): Pattern {
    const tok = this.peek();
    const s = this.span(tok);
    if (tok.kind === TokenKind.Ident && tok.value === "_") {
      this.advance();
      return { kind: "WildcardPattern", span: s };
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
    let left = this.parseComparison();
    while (this.at(TokenKind.AmpAmp)) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: "BinOp", op: "&&", left, right, span: left.span };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (this.peek().kind === TokenKind.EqEq || this.peek().kind === TokenKind.Neq ||
           this.peek().kind === TokenKind.Lt || this.peek().kind === TokenKind.Gt ||
           this.peek().kind === TokenKind.LtEq || this.peek().kind === TokenKind.GtEq) {
      const opTok = this.advance();
      const right = this.parseAdditive();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
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
      const opTok = this.advance();
      const right = this.parseUnary();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().kind === TokenKind.Minus || this.peek().kind === TokenKind.Bang || this.peek().kind === TokenKind.Star) {
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
        const field = this.expect(TokenKind.Ident).value;
        if (this.at(TokenKind.LParen)) {
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
        const index = this.parseExpr();
        this.expect(TokenKind.RBracket);
        expr = { kind: "IndexAccess", object: expr, index, span: expr.span };
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
      return { kind: "IntLit", value: parseInt(tok.value), span: s };
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
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "StringLit", value: tok.value, span: s };
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
      // struct literal: Name { field: value, ... }
      if (this.at(TokenKind.LBrace) && tok.value[0] >= "A" && tok.value[0] <= "Z") {
        return this.parseStructLit(tok.value, s);
      }
      // function call: name(args)
      if (this.at(TokenKind.LParen)) return this.parseCall(tok.value, s);
      return { kind: "Ident", name: tok.value, span: s };
    }
    // array literal: [a, b, c]
    if (tok.kind === TokenKind.LBracket) {
      return this.parseArrayLit();
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

  // lookahead: is this ( the start of an arrow closure?
  // () =>  or  (ident : ...) =>
  private isArrowClosure(): boolean {
    const saved = this.pos;
    this.advance(); // skip (
    if (this.at(TokenKind.RParen)) {
      this.advance();
      const isArrow = this.at(TokenKind.FatArrow);
      this.pos = saved;
      return isArrow;
    }
    if (this.at(TokenKind.Ident)) {
      this.advance();
      const isColon = this.at(TokenKind.Colon);
      this.pos = saved;
      return isColon;
    }
    this.pos = saved;
    return false;
  }

  // (params) => expr  or  (params): RetType => { body }
  private parseClosure(span: Span): Expr {
    this.expect(TokenKind.LParen);
    const params: Param[] = [];
    while (!this.at(TokenKind.RParen)) {
      params.push(this.parseParam());
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
}
