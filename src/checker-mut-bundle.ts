// The `&mut` parameter bundle check, in the portable subset: plain data in, findings out. A free
// fn with three or more `&mut` parameters is a struct's method with the struct un-bundled. Which
// fns qualify and what each call resolves to are checker facts the host restates here keyed by
// node id (src/checker-mut-bundle-host.ts), numbered the way the walker numbers nodes.
//
// The threshold is on the signature; the call sites only sharpen the message: when every caller
// passes the same variables in the same slots the fn is threading state (std/json's parser),
// which is the case the hint fits exactly, as opposed to out-parameters fed different locals each
// time (`lbmMacro(&mut rho, &mut ux, &mut uy)`).
import type { Span, Stmt, Call } from "./ast";
import { walkStmts } from "./ast-walk-mut-bundle";
import type { Parent, EdgeKey } from "./ast-walk-types";

export interface BodyTask { body: Stmt[]; base: number }

// A fn to judge: its name as the user wrote it, how many `&mut` parameters it has, where it is.
export interface Subject { pretty: string; mutCount: number; span: Span | undefined }

// For a Call that resolved to subject `subject`: `roots[j]` is the root variable of the argument
// in the j-th `&mut` slot, "" when it has none.
export interface CallFact { id: number; subject: number; roots: string[] }

export interface MutBundleInput { tasks: BodyTask[]; facts: CallFact[]; subjects: Subject[] }
export interface Finding { message: string; hint: string; span: Span | undefined }

export class MutBundleScan {
  next = 0;
  factIdx = new Map<number, number>();
  // A call inside a generic body is copied into every instance; counting it per instance would
  // inflate "all K call sites", so each source position counts once.
  seen = new Map<string, boolean>();
  // Per subject: call sites counted, the fact of the first one, and whether every site so far
  // passed the same defined variable in every slot.
  count: number[] = [];
  first: number[] = [];
  together: boolean[] = [];
  out: Finding[] = [];

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public facts: CallFact[], public subjects: Subject[]) {}

  index(): void {
    let i = 0;
    while (i < this.facts.length) {
      this.factIdx.set(this.facts[i].id, i);
      i++;
    }
    let s = 0;
    while (s < this.subjects.length) {
      this.count.push(0);
      this.first.push(-1);
      this.together.push(true);
      s++;
    }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
  }

  fact(id: number): number {
    const got = this.factIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  visitCall(n: Call, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const at = this.fact(id);
    if (at < 0) { return; }
    const s = this.facts[at].subject;
    const sp = n.span;
    if (sp !== undefined) {
      let file = "";
      const f = sp.file;
      if (f !== undefined) { file = f; }
      const key = `${file}:${sp.line}:${sp.col}`;
      if (this.seen.has(key)) { return; }
      this.seen.set(key, true);
    }
    const roots = this.facts[at].roots;
    if (this.count[s] === 0) {
      this.first[s] = at;
      let j = 0;
      while (j < roots.length) {
        if (roots[j] === "") { this.together[s] = false; }
        j++;
      }
    } else {
      const firstRoots = this.facts[this.first[s]].roots;
      let j = 0;
      while (j < roots.length) {
        if (roots[j] !== firstRoots[j]) { this.together[s] = false; }
        j++;
      }
    }
    this.count[s] = this.count[s] + 1;
  }

  report(): void {
    let s = 0;
    while (s < this.subjects.length) {
      const sub = this.subjects[s];
      let msg = `fn ${sub.pretty} threads ${sub.mutCount} &mut parameters`;
      const calls = this.count[s];
      if (calls >= 2 && this.together[s]) {
        msg = msg + `; the same ${sub.mutCount} variables travel together at all ${calls} call sites`;
      }
      this.out.push({
        message: msg,
        hint: `bundle them in a struct and make ${sub.pretty} a method on it: a receiver needs no &mut marker at call sites, and named fields cannot be passed in the wrong order`,
        span: sub.span,
      });
      s++;
    }
  }
}

export function mutBundleFindings(input: MutBundleInput): Finding[] {
  const scan = new MutBundleScan(input.facts, input.subjects);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  scan.report();
  return scan.out;
}
