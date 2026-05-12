import { Token, TokenKind } from "./tokens";
import type {
  MiloType, Param, Expr, Stmt, Function, Program,
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
    const functions: Function[] = [];
    while (!this.at(TokenKind.Eof)) {
      if (this.at(TokenKind.Extern)) {
        functions.push(this.parseExternFn());
      } else if (this.at(TokenKind.Fn)) {
        functions.push(this.parseFn());
      } else {
        this.error(`expected 'fn' or 'extern', got '${this.peek().kind}'`, this.peek());
      }
    }
    return { functions };
  }

  private parseType(): MiloType {
    if (this.match(TokenKind.Star)) {
      const inner = this.parseType();
      return { name: inner.name, isPtr: true };
    }
    const tok = this.advance();
    return { name: tok.value, isPtr: false };
  }

  private parseParam(): Param {
    const isRef = !!this.match(TokenKind.Amp);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.Colon);
    const type = this.parseType();
    return { name, type, isRef };
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
    return { name: "void", isPtr: false };
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
    // check for assignment
    if (expr.kind === "Ident" && this.at(TokenKind.Eq)) {
      this.advance();
      const value = this.parseExpr();
      return { kind: "Assign", name: expr.name, value };
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
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    if (tok.kind === TokenKind.Int) {
      this.advance();
      return { kind: "IntLit", value: parseInt(tok.value) };
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
      if (this.at(TokenKind.LParen)) return this.parseCall(tok.value);
      return { kind: "Ident", name: tok.value };
    }
    if (tok.kind === TokenKind.LParen) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(TokenKind.RParen);
      return expr;
    }

    this.error(`unexpected token '${tok.kind}'`, tok);
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
}
