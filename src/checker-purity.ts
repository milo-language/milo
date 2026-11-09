// The @pure body check, in the portable subset: plain data in, findings out. A @pure fn may touch
// only its parameters and locals, call only @pure fns, and contain no `unsafe` block. Which
// identifiers are an unshadowed mutable global, and how each call resolved, are checker facts
// the host restates here keyed by node id (src/checker-purity-host.ts), numbered the way the
// walker numbers nodes.
import type { Span, Stmt, UnsafeBlock, Ident, Call, MethodCall, EnumLit, ClosureExpr, ForInStmt, LetDecl, VarDecl, LetElseStmt, LetClause, IfChainStmt, EnumPattern, LiteralPattern, WildcardPattern, Contract } from "./ast";
import { walkStmts } from "./ast-walk-purity";
import type { Parent, EdgeKey } from "./ast-walk-types";

// One @pure body: `base` is the id of its first node, `params` its parameter names, `who` how
// messages name it, `fnName` the key that limits a global to one report per function.
export interface BodyTask { body: Stmt[]; base: number; params: string[]; who: string; fnName: string }

// What a call turned out to be. IMPURE_NONE means nothing to report.
export const IMPURE_NONE = 0;
export const IMPURE_FN_VALUE = 1;
export const IMPURE_INTERFACE = 2;
export const IMPURE_FN_FIELD = 3;
export const IMPURE_EXTERN = 4;
export const IMPURE_CALLEE = 5;

// A Call, MethodCall or EnumLit the body walk reached. `name` is the called name as written,
// `target` the resolved callee and `pretty` how messages spell it, `iface` the interface for a
// dynamic call.
export interface CallFact { id: number; verdict: number; name: string; target: string; pretty: string; iface: string }

// `globals`: the names of the program's mutable globals.
export interface PurityInput { tasks: BodyTask[]; calls: CallFact[]; globals: string[] }
export interface Finding { message: string; hint: string; span: Span | undefined }

export class PurityScan {
  next = 0;
  who = "";
  fnName = "";
  // Every instance of a pure generic walks the same source span, so the same violation would
  // be reported once per instantiation.
  seen = new Set<string>();
  out: Finding[] = [];
  callIdx = new Map<number, number>();
  globals = new Set<string>();
  // Lexical scopes, innermost last: each statement list pushes one, and a name is local when any
  // scope holds it.
  scopes: Set<string>[] = [];
  // Names a node binds for the statement list that follows it, keyed by the node that owns the
  // list: a for loop's variables, a closure's parameters, a pattern's bindings (match arm, if-let,
  // let-else, a let clause in an if chain).
  binds = new Map<number, string[]>();
  // The node a pattern (possibly nested) belongs to.
  patOwner = new Map<number, number>();
  chains = new Set<number>();
  // An if chain's scope is set aside while its else body runs: bindings from its `let` clauses
  // reach the then body only.
  parked = new Map<number, Set<string>>();
  depth = 0;
  // The old check never looked inside loop invariants, so nothing there is reported.
  contractDepth = 0;

  constructor(public input: PurityInput) {}

  index(): void {
    let i = 0;
    while (i < this.input.calls.length) {
      this.callIdx.set(this.input.calls[i].id, i);
      i++;
    }
    for (const g of this.input.globals) { this.globals.add(g); }
  }

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(task: BodyTask): void {
    this.next = task.base;
    this.who = task.who;
    this.fnName = task.fnName;
    this.scopes = [new Set<string>(task.params)];
    this.depth = 1;
  }

  bound(name: string): boolean {
    let i = 0;
    while (i < this.depth) {
      if (this.scopes[i].has(name)) { return true; }
      i++;
    }
    return false;
  }

  bind(name: string): void {
    this.scopes[this.depth - 1].add(name);
  }

  pushScope(scope: Set<string>): void {
    if (this.depth < this.scopes.length) {
      this.scopes[this.depth] = scope;
    } else {
      this.scopes.push(scope);
    }
    this.depth = this.depth + 1;
  }

  popScope(): Set<string> {
    this.depth = this.depth - 1;
    return this.scopes[this.depth];
  }

  enterStmts(parentId: number, key: EdgeKey): void {
    if (key === "elseBody" && this.chains.has(parentId)) {
      this.parked.set(parentId, this.popScope());
    }
    const scope = new Set<string>();
    if (key === "body" || key === "thenBody") {
      const names = this.binds.get(parentId);
      if (names !== undefined) {
        for (const nm of names) { scope.add(nm); }
      }
    }
    this.pushScope(scope);
  }

  exitStmts(parentId: number, key: EdgeKey): void {
    this.popScope();
    if (key === "elseBody" && this.chains.has(parentId)) {
      const chain = this.parked.get(parentId);
      if (chain !== undefined) { this.pushScope(chain); }
    }
  }

  // Walk the initializer before binding the name: in `let x = x + 1` the right-hand `x` is
  // still whatever `x` meant outside.
  afterLetDecl(n: LetDecl, _id: number, _kids: number[]): void { this.bind(n.name); }
  afterVarDecl(n: VarDecl, _id: number, _kids: number[]): void { this.bind(n.name); }

  // The bind escapes into the enclosing scope, that is the point of let-else.
  afterLetElseStmt(_n: LetElseStmt, id: number, _kids: number[]): void { this.bindOwned(id); }

  bindOwned(id: number): void {
    const names = this.binds.get(id);
    if (names !== undefined) {
      for (const nm of names) { this.bind(nm); }
    }
  }

  visitClosure(n: ClosureExpr, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const names: string[] = [];
    for (const p of n.params) { names.push(p.name); }
    this.binds.set(id, names);
  }

  visitForInStmt(n: ForInStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    const names = [n.varName];
    if (n.varName2 !== null) { names.push(n.varName2); }
    this.binds.set(id, names);
  }

  visitIfChainStmt(_n: IfChainStmt, id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    this.chains.add(id);
    this.pushScope(new Set<string>());
  }

  afterIfChainStmt(_n: IfChainStmt, _id: number, _kids: number[]): void { this.popScope(); }

  // A let clause's pattern binds for the clauses after it and the then body, not its own subject.
  afterLetClause(_n: LetClause, id: number, _kids: number[]): void { this.bindOwned(id); }

  pattern(id: number, parent: Parent): number {
    let owner = parent.id;
    if (parent.kind === "EnumPattern") {
      const o = this.patOwner.get(parent.id);
      if (o !== undefined) { owner = o; }
    } else {
      this.binds.set(owner, []);
    }
    this.patOwner.set(id, owner);
    return owner;
  }

  visitEnumPattern(n: EnumPattern, id: number, parent: Parent, _key: EdgeKey, _index: number): void {
    const owner = this.pattern(id, parent);
    const names = this.binds.get(owner);
    if (names !== undefined) {
      let i = 0;
      while (i < n.bindings.length) {
        // A nested sub-pattern at this position is visited on its own and binds there.
        let nested = false;
        if (n.args !== undefined && n.args[i] !== undefined && n.args[i] !== null) { nested = true; }
        if (!nested) { names.push(n.bindings[i]); }
        i++;
      }
    }
  }
  visitLiteralPattern(_n: LiteralPattern, id: number, parent: Parent, _key: EdgeKey, _index: number): void { this.pattern(id, parent); }
  visitWildcardPattern(_n: WildcardPattern, id: number, parent: Parent, _key: EdgeKey, _index: number): void { this.pattern(id, parent); }

  visitContract(_n: Contract, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.contractDepth = this.contractDepth + 1; }
  afterContract(_n: Contract, _id: number, _kids: number[]): void { this.contractDepth = this.contractDepth - 1; }

  fail(message: string, span: Span | undefined, hint: string, key: string): void {
    let k = key;
    if (k === "") {
      let line = 0;
      let col = 0;
      if (span !== undefined) { line = span.line; col = span.col; }
      k = `${line}:${col}:${message}`;
    }
    if (this.contractDepth > 0 || this.seen.has(k)) { return; }
    this.seen.add(k);
    this.out.push({ message, hint, span });
  }

  // One report per global per function: `g = g + 1` is a read and a write of the same
  // mistake, and repeating it per mention buries the fix.
  visitIdent(n: Ident, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    if (!this.globals.has(n.name) || this.bound(n.name)) { return; }
    this.fail(`'${this.who}' is @pure but touches the mutable global '${n.name}'`, n.span,
      `a @pure fn reads and writes only its parameters and its own locals — pass '${n.name}' in as a parameter, or make it a 'let'`,
      `${this.fnName}|global|${n.name}`);
  }

  call(id: number, span: Span | undefined): void {
    let at = -1;
    const got = this.callIdx.get(id);
    if (got !== undefined) { at = got; }
    if (at < 0) { return; }
    const f = this.input.calls[at];
    if (f.verdict === IMPURE_FN_VALUE) {
      this.fail(`'${this.who}' is @pure but calls the function value '${f.name}'`, span,
        `purity is not part of a fn type, so the compiler cannot see what this call does — call a named @pure fn instead`, "");
    } else if (f.verdict === IMPURE_INTERFACE) {
      this.fail(`'${this.who}' is @pure but calls '${f.name}' through the interface '${f.iface}'`, span,
        `dynamic dispatch hides which body runs, and purity is not part of an interface method's signature`, "");
    } else if (f.verdict === IMPURE_FN_FIELD) {
      this.fail(`'${this.who}' is @pure but calls the fn-typed field '${f.name}'`, span,
        `purity is not part of a fn type, so the compiler cannot see what this call does`, "");
    } else if (f.verdict === IMPURE_EXTERN) {
      this.fail(`'${this.who}' is @pure but calls extern fn '${f.pretty}'`, span,
        `an extern's body is compiled elsewhere, so nothing here can check it — write '@pure extern fn ${f.target}(...)' to assert it has no effects, or drop '@pure' from '${this.who}'`, "");
    } else if (f.verdict === IMPURE_CALLEE) {
      this.fail(`'${this.who}' is @pure but calls '${f.pretty}', which is not`, span,
        `purity is transitive — mark '${f.pretty}' '@pure' too, or drop '@pure' from '${this.who}'`, "");
    }
  }

  visitCall(n: Call, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.call(id, n.span); }
  visitEnumLit(n: EnumLit, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.call(id, n.span); }
  visitMethodCall(n: MethodCall, id: number, _parent: Parent, _key: EdgeKey, _index: number): void { this.call(id, n.span); }

  visitUnsafeBlock(n: UnsafeBlock, _id: number, _parent: Parent, _key: EdgeKey, _index: number): void {
    this.fail(`'${this.who}' is @pure but contains an 'unsafe' block`, n.span,
      `raw memory access is exactly the ambient effect '@pure' rules out`, "");
  }
}

export function purityFindings(input: PurityInput): Finding[] {
  const scan = new PurityScan(input);
  scan.index();
  for (const task of input.tasks) {
    scan.begin(task);
    walkStmts(scan, task.body, { kind: "None", id: -1, op: "" }, "root");
  }
  return scan.out;
}
