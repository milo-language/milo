import { Token, TokenKind } from "./tokens";
import type {
  MiloType, Param, Expr, Stmt, Function, Program, StructDecl, StructField,
} from "./ast";

export class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

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
    console.error(`error[parse]: ${msg} at ${tok.line}:${tok.col}`);
    process.exit(1);
  }

  parse(): Program {
    const structs: StructDecl[] = [];
    const functions: Function[] = [];
    while (!this.at(TokenKind.Eof)) {
      if (this.at(TokenKind.Struct)) {
        structs.push(this.parseStruct());
      } else if (this.at(TokenKind.Extern)) {
        functions.push(this.parseExternFn());
      } else if (this.at(TokenKind.Fn)) {
        functions.push(this.parseFn());
      } else {
        this.error(`expected 'struct', 'fn', or 'extern', got '${this.peek().kind}'`, this.peek());
      }
    }
    return { structs, functions };
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
    const tok = this.advance();
    return { name: tok.value, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
  }

  // ── Struct ──

  private parseStruct(): StructDecl {
    this.expect(TokenKind.Struct);
    const name = this.expect(TokenKind.Ident).value;
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
    return { kind: "StructDecl", name, fields };
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
    if (this.match(TokenKind.Arrow)) return this.parseType();
    return { name: "void", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
  }

  private parseExternFn(): Function {
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    return { kind: "Function", name, params, retType, body: [], isExtern: true, isVariadic: variadic };
  }

  private parseFn(): Function {
    this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    const { params, variadic } = this.parseParamList();
    const retType = this.parseReturnType();
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "Function", name, params, retType, body, isExtern: false, isVariadic: variadic };
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

    const expr = this.parseExpr();
    // assignment: x = ..., x.field = ..., x[i] = ...
    if (this.at(TokenKind.Eq)) {
      this.advance();
      const value = this.parseExpr();
      return { kind: "Assign", target: expr, value };
    }
    return { kind: "ExprStmt", expr };
  }

  private parseLet(): Stmt {
    this.expect(TokenKind.Let);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    return { kind: "LetDecl", name, type, value };
  }

  private parseVar(): Stmt {
    this.expect(TokenKind.Var);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    return { kind: "VarDecl", name, type, value };
  }

  private parseReturn(): Stmt {
    this.expect(TokenKind.Return);
    if (this.at(TokenKind.RBrace)) return { kind: "Return", value: null };
    return { kind: "Return", value: this.parseExpr() };
  }

  private parseIf(): Stmt {
    this.expect(TokenKind.If);
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
    return { kind: "IfStmt", cond, thenBody, elseBody };
  }

  private parseWhile(): Stmt {
    this.expect(TokenKind.While);
    const cond = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "WhileStmt", cond, body };
  }

  // ── Expression parsing (precedence climbing) ──

  private parseExpr(): Expr { return this.parseComparison(); }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (this.peek().kind === TokenKind.EqEq || this.peek().kind === TokenKind.Neq ||
           this.peek().kind === TokenKind.Lt || this.peek().kind === TokenKind.Gt ||
           this.peek().kind === TokenKind.LtEq || this.peek().kind === TokenKind.GtEq) {
      const op = this.advance().value;
      const right = this.parseAdditive();
      left = { kind: "BinOp", op, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().kind === TokenKind.Plus || this.peek().kind === TokenKind.Minus) {
      const op = this.advance().value;
      const right = this.parseMultiplicative();
      left = { kind: "BinOp", op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === TokenKind.Star || this.peek().kind === TokenKind.Slash || this.peek().kind === TokenKind.Percent) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { kind: "BinOp", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().kind === TokenKind.Minus || this.peek().kind === TokenKind.Bang) {
      const op = this.advance().value;
      const operand = this.parseUnary();
      return { kind: "UnaryOp", op, operand };
    }
    return this.parsePostfix();
  }

  // field access (x.y) and index access (x[i]) are left-associative postfix ops
  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at(TokenKind.Dot)) {
        this.advance();
        const field = this.expect(TokenKind.Ident).value;
        expr = { kind: "FieldAccess", object: expr, field };
      } else if (this.at(TokenKind.LBracket)) {
        this.advance();
        const index = this.parseExpr();
        this.expect(TokenKind.RBracket);
        expr = { kind: "IndexAccess", object: expr, index };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    if (tok.kind === TokenKind.Int) {
      this.advance();
      return { kind: "IntLit", value: parseInt(tok.value) };
    }
    if (tok.kind === TokenKind.Float) {
      this.advance();
      return { kind: "FloatLit", value: parseFloat(tok.value) };
    }
    if (tok.kind === TokenKind.True) {
      this.advance();
      return { kind: "BoolLit", value: true };
    }
    if (tok.kind === TokenKind.False) {
      this.advance();
      return { kind: "BoolLit", value: false };
    }
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "StringLit", value: tok.value };
    }
    if (tok.kind === TokenKind.Ident) {
      this.advance();
      // struct literal: Name { field: value, ... }
      if (this.at(TokenKind.LBrace) && tok.value[0] >= "A" && tok.value[0] <= "Z") {
        return this.parseStructLit(tok.value);
      }
      // function call: name(args)
      if (this.at(TokenKind.LParen)) return this.parseCall(tok.value);
      return { kind: "Ident", name: tok.value };
    }
    // array literal: [a, b, c]
    if (tok.kind === TokenKind.LBracket) {
      return this.parseArrayLit();
    }
    if (tok.kind === TokenKind.LParen) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(TokenKind.RParen);
      return expr;
    }

    this.error(`unexpected token '${tok.kind}'`, tok);
  }

  private parseStructLit(name: string): Expr {
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
    return { kind: "StructLit", name, fields };
  }

  private parseCall(name: string): Expr {
    this.expect(TokenKind.LParen);
    const args: Expr[] = [];
    while (!this.at(TokenKind.RParen)) {
      args.push(this.parseExpr());
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    return { kind: "Call", func: name, args };
  }

  private parseArrayLit(): Expr {
    this.expect(TokenKind.LBracket);
    const elements: Expr[] = [];
    while (!this.at(TokenKind.RBracket)) {
      elements.push(this.parseExpr());
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBracket);
    return { kind: "ArrayLit", elements };
  }
}
