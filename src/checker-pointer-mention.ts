// Which identifier does an expression mention first, among a set of names? Used by the portable
// pointer-escape pass (src/checker-pointer-escape.ts). A separate class and file so the generated
// walker for it does not clash with the pass's own walker.
import type { Expr, Ident } from "./ast";
import { walkExpr } from "./ast-walk-pointer-mention";
import type { Parent, EdgeKey } from "./ast-walk-types";

export class MentionScan {
  next = 0;
  names: string[] = [];

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  visitIdent(n: Ident, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.names.push(n.name); }
}

// The first mentioned name that is in `aliases`, or "" when none is.
export function firstMention(e: Expr, aliases: Map<string, boolean>): string {
  const scan = new MentionScan();
  walkExpr(scan, e, { kind: "None", id: -1, op: "" }, "root", -1);
  for (const nm of scan.names) {
    const on = aliases.get(nm);
    if (on !== undefined && on) { return nm; }
  }
  return "";
}
