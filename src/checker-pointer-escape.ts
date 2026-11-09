// The pointer-parameter-escape check, in the portable subset: plain data in, findings out. A
// pointer parameter (or a local that aliases one) may not be stored in a mutable global. Which
// expressions carry a raw pointer, which method calls mutate their receiver and the root variable
// of each assignment target or receiver are checker facts the host restates here keyed by node id
// (src/checker-pointer-escape-host.ts), numbered the way the walker numbers nodes.
//
// A pointer parameter stored in a global outlives every holder the pointer-view rule can
// see. `let p = v.ptr()` freezes `v` while `p` is live, and passing `p` to a callee is a
// hold for the duration of the call; a callee that copies the parameter into a mutable
// global keeps it past the call, and the next `v.push` is a use-after-free with zero
// `unsafe` (backlog #43, ASan-verified). Rather than summarize "which fns stash which
// params" and freeze the caller's buffer forever, the store itself is rejected: the
// buffer belongs in the global, the pointer does not. Decided by type, so a struct or
// Vec that carries the pointer counts, and a `*T` laundered to `i64` does not (documented
// gap: an integer is not a pointer to the checker). `@externalLinkage` entry points are
// exempt: their pointer parameters come from C, which owns them by contract.
import type { Span, Stmt, Expr, LetDecl, VarDecl, Assign, MethodCall } from "./ast";
import { walkStmts } from "./ast-walk-pointer-escape";
import type { Parent, EdgeKey } from "./ast-walk-types";
import { firstMention } from "./checker-pointer-mention";

// One function body: `base` is the id of its first node, `params` the names of its parameters
// that carry a raw pointer.
export interface BodyTask { body: Stmt[]; base: number; params: string[] }

// For a LetDecl, VarDecl or Assign: `valuePtr` says the assigned value carries a raw pointer.
// For an Assign, `root` is the variable at the root of the target. For a MethodCall (present only
// when it mutates its receiver): `root` is the receiver's root and `argPtr[i]` says argument i
// carries a raw pointer. "" means no root.
export interface PtrFact { id: number; root: string; valuePtr: boolean; argPtr: boolean[] }

// `globals`: the names of the program's mutable globals.
export interface PointerEscapeInput { tasks: BodyTask[]; facts: PtrFact[]; globals: string[] }
export interface Finding { message: string; hint: string; span: Span | undefined }

export class PointerEscapeScan {
  next = 0;
  // Every binding that may alias a pointer parameter: the parameters themselves, then each
  // `let`/`var` whose initializer mentions one and still carries a pointer.
  aliases = new Map<string, boolean>();
  shadowed = new Set<string>();
  globals = new Set<string>();
  factIdx = new Map<number, number>();
  out: Finding[] = [];

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public facts: PtrFact[], public globalNames: string[]) {}

  index(): void {
    let i = 0;
    while (i < this.facts.length) {
      this.factIdx.set(this.facts[i].id, i);
      i++;
    }
    for (const g of this.globalNames) { this.globals.add(g); }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
    this.aliases = new Map<string, boolean>();
    for (const p of task.params) { this.aliases.set(p, true); }
    this.shadowed = new Set<string>();
  }

  fact(id: number): number {
    const got = this.factIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  isGlobal(g: string): boolean {
    return g !== "" && this.globals.has(g) && !this.shadowed.has(g);
  }

  hint(g: string, p: string): string {
    return `'${p}' points into a buffer some caller owns, and '${g}' outlives that call; store the buffer itself in '${g}' (or an index into it), not the pointer`;
  }

  // The alias the value mentions, or "" when it does not carry a pointer or mentions none.
  pointerValue(carries: boolean, value: Expr): string {
    if (!carries) { return ""; }
    return firstMention(value, this.aliases);
  }

  // The initializer is judged against the aliases as they were before this name is bound.
  binding(name: string, id: number, value: Expr): void {
    if (this.globals.has(name)) { this.shadowed.add(name); }
    let carries = false;
    const at = this.fact(id);
    if (at >= 0) { carries = this.facts[at].valuePtr; }
    const p = this.pointerValue(carries, value);
    this.aliases.set(name, p !== "");
  }

  visitLetDecl(n: LetDecl, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.binding(n.name, id, n.value); }
  visitVarDecl(n: VarDecl, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.binding(n.name, id, n.value); }

  visitAssign(n: Assign, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const at = this.fact(id);
    if (at < 0) { return; }
    const root = this.facts[at].root;
    if (!this.isGlobal(root)) { return; }
    const p = this.pointerValue(this.facts[at].valuePtr, n.value);
    if (p === "") { return; }
    this.out.push({
      message: `pointer parameter '${p}' is stored in the global '${root}', which outlives the buffer it points into`,
      hint: this.hint(root, p),
      span: n.span,
    });
  }

  visitMethodCall(n: MethodCall, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const at = this.fact(id);
    if (at < 0) { return; }
    const root = this.facts[at].root;
    if (!this.isGlobal(root)) { return; }
    let i = 0;
    while (i < n.args.length && i < this.facts[at].argPtr.length) {
      const p = this.pointerValue(this.facts[at].argPtr[i], n.args[i]);
      if (p !== "") {
        this.out.push({
          message: `pointer parameter '${p}' is stored in the global '${root}' by '${n.method}', which outlives the buffer it points into`,
          hint: this.hint(root, p),
          span: n.span,
        });
        return;
      }
      i++;
    }
  }
}

export function pointerEscapeFindings(input: PointerEscapeInput): Finding[] {
  const scan = new PointerEscapeScan(input.facts, input.globals);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
