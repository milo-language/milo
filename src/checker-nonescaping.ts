// The non-escaping closure parameter check, in the portable subset: plain data in, findings out.
// A plain closure parameter (not `move`) may only be called or passed on to another plain closure
// parameter; this pass reports every other use of one. The checker's object-keyed facts (call
// resolution, closure captures, expression types) reach it as `NonEscapingInput`, numbered the way
// the walker numbers nodes, by src/checker-nonescaping-host.ts.
import type { Span, Stmt, ClosureExpr, Ident } from "./ast";
import { walkStmts } from "./ast-walk-nonescaping";
import type { Parent, EdgeKey } from "./ast-walk-types";
import { isTrue } from "./mutability-scan";

// One body to scan: `base` is the id of its first node, `params` the plain closure parameters
// in scope, `who` how the hint names the owner ("'f'" or "the closure").
export interface BodyTask { body: Stmt[]; base: number; params: string[]; who: string }

// A Call, MethodCall or EnumLit with arguments. `keeps[i]` is true when argument i lands in a
// parameter that may keep it, or in one the checker cannot resolve (the fail-closed rule).
export interface CallFact { id: number; callee: string; span: Span | undefined; keeps: boolean[] }
// Consecutive entries with one id are one closure's captures.
export interface CaptureFact { id: number; name: string }

export interface NonEscapingInput { tasks: BodyTask[]; calls: CallFact[]; captures: CaptureFact[] }
export interface Finding { message: string; hint: string; span: Span | undefined }

const GENERIC = "is used as a value here, which may keep it past the call";

function keyOf(span: Span | undefined, name: string): string {
  if (span !== undefined) {
    let file = "";
    if (span.file !== undefined) { file = span.file; }
    return `${file}:${span.line}:${span.col}:${name}`;
  }
  return ":0:0:" + name;
}

export class NonEscapingScan {
  next = 0;
  params = new Set<string>();
  who = "";
  // The same use reached through two tasks (a closure body inside its function's body, a
  // generic body per instance) is reported once.
  seen = new Set<string>();
  out: Finding[] = [];
  callIdx = new Map<number, number>();
  capIdx = new Map<number, number>();

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public calls: CallFact[], public captures: CaptureFact[]) {}

  index(): void {
    let i = 0;
    while (i < this.calls.length) {
      this.callIdx.set(this.calls[i].id, i);
      i++;
    }
    i = 0;
    while (i < this.captures.length) {
      if (!this.capIdx.has(this.captures[i].id)) { this.capIdx.set(this.captures[i].id, i); }
      i++;
    }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
    this.params = new Set<string>(task.params);
    this.who = task.who;
  }

  report(name: string, span: Span | undefined, what: string): void {
    const key = keyOf(span, name);
    if (this.seen.has(key)) { return; }
    this.seen.add(key);
    this.out.push({
      message: `non-escaping closure parameter '${name}' ${what}`,
      hint: `a plain closure parameter can only be called or passed on to another plain closure parameter; if ${this.who} stores, returns or spawns it, declare it '${name}: move (…) => …'`,
      span,
    });
  }

  // What happens to the parameter is read off where the identifier sits.
  visitIdent(n: Ident, _id: number, parent: Parent, key: EdgeKey, index: number): void {
    if (!this.params.has(n.name)) { return; }
    if (parent.kind === "Return") {
      this.report(n.name, n.span, "is returned");
    } else if (parent.kind === "StructLit" && (key === "value" || key === "base")) {
      this.report(n.name, n.span, "is stored in a struct");
    } else if (parent.kind === "Assign" && key === "value") {
      this.report(n.name, n.span, "is stored");
    } else if ((parent.kind === "Call" || parent.kind === "MethodCall" || parent.kind === "EnumLit") && key === "args") {
      const at = this.callIdx.get(parent.id);
      if (at !== undefined && this.calls[at].keeps[index]) {
        const call = this.calls[at];
        const what = `is passed to '${call.callee}', which may keep it`;
        if (n.span !== undefined) {
          this.report(n.name, n.span, what);
        } else {
          this.report(n.name, call.span, what);
        }
      }
    } else {
      this.report(n.name, n.span, GENERIC);
    }
  }

  // A by-reference capture is fine here: checkEscapingClosures keeps that closure inside this
  // frame, the same as one that borrows a local.
  visitClosure(n: ClosureExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const at = this.capIdx.get(id);
    if (at !== undefined && isTrue(n.isMove)) {
      let j = at;
      while (j < this.captures.length && this.captures[j].id === id) {
        // A local copy: report() takes self mutably, so it cannot also read self.captures.
        const name = this.captures[j].name;
        if (this.params.has(name)) {
          this.report(name, n.span, "is captured by a 'move' closure");
        }
        j++;
      }
    }
  }
}

export function nonEscapingFindings(input: NonEscapingInput): Finding[] {
  const scan = new NonEscapingScan(input.calls, input.captures);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
