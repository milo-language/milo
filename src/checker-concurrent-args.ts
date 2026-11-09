// The `@concurrent` closure-argument check, in the portable subset: plain data in, findings out.
// A `@concurrent` fn runs its closure argument on several threads at once over one shared
// environment, so the argument must visibly not write: a named fn, or a literal whose captures are
// only read. Which calls resolve to a `@concurrent` fn and what each fn-typed argument is are
// checker facts the host restates here keyed by node id (src/checker-concurrent-args-host.ts),
// numbered the way the walker numbers nodes. Only the shadowing test needs the walk: a name the
// body declared earlier is a local, not the named fn it spells.
import type { Span, Stmt, Call, MethodCall, EnumLit, LetDecl, VarDecl } from "./ast";
import { walkStmts } from "./ast-walk-concurrent-args";
import type { Parent, EdgeKey } from "./ast-walk-types";

export interface BodyTask { body: Stmt[]; base: number; params: string[] }

// What the checker knows about one fn-typed argument.
//   ARG_BAD_CLOSURE   a closure literal that writes (or moves) a capture: reported at once
//   ARG_NAMED         an identifier spelling a named fn, valid unless the body declared a local of that name
//   ARG_OPAQUE        anything else: the checker cannot see whether it writes
export const ARG_BAD_CLOSURE = 1;
export const ARG_NAMED = 2;
export const ARG_OPAQUE = 3;
// `span` is where a report lands; `name` is the identifier (ARG_NAMED) or the written capture;
// `moves` says the capture is moved out rather than written.
export interface ArgFact { verdict: number; name: string; moves: boolean; span: Span | undefined }
export interface CallFact { id: number; who: string; args: ArgFact[] }

export interface ConcurrentArgsInput { tasks: BodyTask[]; facts: CallFact[] }
export interface Finding { message: string; hint: string; span: Span | undefined }

export class ConcurrentArgsScan {
  next = 0;
  factIdx = new Map<number, number>();
  bound = new Map<string, boolean>();
  out: Finding[] = [];

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public facts: CallFact[]) {}

  index(): void {
    let i = 0;
    while (i < this.facts.length) {
      this.factIdx.set(this.facts[i].id, i);
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
    this.bound = new Map<string, boolean>();
    let i = 0;
    while (i < task.params.length) {
      this.bound.set(task.params[i], true);
      i++;
    }
  }

  visitLetDecl(n: LetDecl, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.bound.set(n.name, true); }
  visitVarDecl(n: VarDecl, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.bound.set(n.name, true); }

  visitCall(_n: Call, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.check(id); }
  visitMethodCall(_n: MethodCall, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.check(id); }
  visitEnumLit(_n: EnumLit, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.check(id); }

  factAt(id: number): number {
    const got = this.factIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  check(id: number): void {
    const at = this.factAt(id);
    if (at < 0) { return; }
    const who = this.facts[at].who;
    const args = this.facts[at].args;
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a.verdict === ARG_BAD_CLOSURE) {
        let how = "writes";
        if (a.moves) { how = "moves"; }
        this.out.push({
          message: `'${who}' runs this closure on several threads at once, and it ${how} its capture '${a.name}'`,
          hint: `every worker shares one environment, so the writes race: give each worker its own state through parallelMapWith's states, or a std/sync atomic`,
          span: a.span,
        });
      } else if (a.verdict === ARG_OPAQUE || this.bound.has(a.name)) {
        this.out.push({
          message: `'${who}' runs its closure argument on several threads at once, and the checker cannot see whether this one writes its captures`,
          hint: `pass a named fn or write the closure literal at the call`,
          span: a.span,
        });
      }
      i++;
    }
  }
}

export function concurrentArgsFindings(input: ConcurrentArgsInput): Finding[] {
  const scan = new ConcurrentArgsScan(input.facts);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
