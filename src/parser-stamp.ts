// Overwrites every span in a parsed subtree (f-string fragments are parsed on their own and
// start over at 1:1). The generated walker (src/ast-walk-stamp.ts) calls one hook per node
// family, so a node kind added to src/ast.ts is covered without touching this file.
import type { Expr, Stmt, Pattern, ChainClause, Contract, Span } from "./ast";

export class StampScan {
  next = 0;

  constructor(public span: Span) {}

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  onExpr(e: Expr): void {
    e.span = this.span;
  }

  onStmt(s: Stmt): void {
    s.span = this.span;
  }

  onPattern(p: Pattern): void {
    p.span = this.span;
  }

  onChainClause(c: ChainClause): void {
    c.span = this.span;
  }

  onContract(k: Contract): void {
    k.span = this.span;
  }
}
