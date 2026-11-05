// The visitor behind src/checker-mutability.ts, in the portable subset (scripts/ts2milo/subset.ts)
// so it can be transpiled to Milo. The walk that drives it is generated (src/ast-walk.ts).
//
// Node identity: the checker keys its facts by object (a WeakSet, Maps, Sets of Expr). Here a
// fact is keyed by the node's id instead, its pre-order position in the walk of its function
// plus that function's `base`. src/checker-mutability-host.ts, the only place that still sees
// object identity, turns the checker's sets into `MutFacts` with the same numbering.
import type { Span, Assign, ForInStmt, UnaryOp, MethodCall, CastExpr, Call, ClosureExpr, Ident, VarDecl } from "./ast";
import type { Parent, EdgeKey, NodeKind } from "./ast-walk-types";

export interface RootFact { id: number; name: string }
// Consecutive entries with one id are one closure's captures.
export interface CaptureFact { id: number; name: string; mutated: boolean }
// A Call or MethodCall the pass looks at: where it resolved, its callee's `&mut` params, and
// which of its arguments were written `&mut x`.
export interface CallFact { id: number; callee: string; hasSig: boolean; mutParams: boolean[]; explicitArgs: boolean[] }
export interface MutFacts {
  total: number;
  mutated: number[];
  aggregate: number[];
  arrays: number[];
  roots: RootFact[];
  captures: CaptureFact[];
  calls: CallFact[];
}

export interface CallSite { callee: string; span: Span; explicit: boolean; idx: number }
export interface VarEntry { name: string; span: Span; ok: boolean }

// A span with no file reads as "", as in every key and comparison here.
export function fileOf(s: Span): string {
  if (s.file !== undefined) { return s.file; }
  return "";
}

export function spanKey(s: Span): string {
  return `${fileOf(s)}:${s.line}:${s.col}`;
}

export function isTrue(b: boolean | undefined): boolean {
  if (b !== undefined) { return b; }
  return false;
}

// Parents an Ident may sit under without handing out the `&mut` itself: reading through it.
// Return is safe because a fn returning `&mut` is skipped up front.
function isReadParent(k: NodeKind): boolean {
  return k === "Return" || k === "ExprStmt" || k === "FieldAccess" || k === "IndexAccess" || k === "BinOp"
    || k === "CastExpr" || k === "IfStmt" || k === "WhileStmt" || k === "IsExpr" || k === "Unwrap";
}

export class MutScan {
  next = 0;
  // 0: the names written. 1: `var` declarations. 2: call sites and every identifier. 3: whether
  // the `watch` name escapes (leaves `written` alone, so a mode 0 result survives it). One class
  // so one generated walker serves all four.
  mode = 0;
  watch = "";
  escapes = false;
  written = new Set<string>();
  vars: VarEntry[] = [];
  varIndex = new Map<string, number>();
  values = new Set<string>();
  sites: CallSite[] = [];
  siteIndex = new Map<string, number>();

  constructor(
    public facts: MutFacts,
    public mutated: Set<number>,
    public aggregate: Set<number>,
    public arrays: Set<number>,
    public rootIdx: Map<number, number>,
    public capIdx: Map<number, number>,
    public callIdx: Map<number, number>,
  ) {}

  enter(): number {
    const id = this.next;
    this.next = this.next + 1;
    return id;
  }

  begin(base: number, mode: number, watch: string): void {
    this.next = base;
    this.mode = mode;
    this.watch = watch;
    this.escapes = false;
    if (mode === 0) { this.written = new Set<string>(); }
  }

  mark(id: number): void {
    const at = this.rootIdx.get(id);
    if (at !== undefined) { this.written.add(this.facts.roots[at].name); }
  }

  node(id: number): void {
    if (this.mode === 0 && this.mutated.has(id)) { this.mark(id); }
  }

  visitIdent(n: Ident, id: number, parent: Parent, key: EdgeKey, index: number): void {
    if (this.mode === 2) { this.values.add(n.name); }
    if (this.mode === 3 && n.name === this.watch && !this.readsOnly(parent, key, index)) { this.escapes = true; }
  }

  visitClosure(n: ClosureExpr, id: number, parent: Parent, key: EdgeKey, index: number): void {
    if (this.mode !== 0) { return; }
    const at = this.capIdx.get(id);
    if (at !== undefined) {
      let j = at;
      while (j < this.facts.captures.length && this.facts.captures[j].id === id) {
        if (this.facts.captures[j].mutated) { this.written.add(this.facts.captures[j].name); }
        j++;
      }
    }
  }

  visitVarDecl(n: VarDecl, id: number, parent: Parent, key: EdgeKey, index: number): void {
    if (this.mode === 1 && n.span !== undefined) {
      const k = spanKey(n.span);
      const at = this.varIndex.get(k);
      if (at !== undefined) {
        if (this.written.has(n.name)) { this.vars[at].ok = false; }
      } else {
        this.varIndex.set(k, this.vars.length);
        this.vars.push({ name: n.name, span: n.span, ok: !this.written.has(n.name) });
      }
    }
  }

  // Every argument of a resolved call is a call site; the same span seen again (a generic
  // body checked once per instance) replaces the earlier entry but keeps its position.
  visitCall(n: Call, id: number, parent: Parent, key: EdgeKey, index: number): void {
    const at = this.callIdx.get(id);
    if (this.mode === 2 && at !== undefined && this.facts.calls[at].callee !== "") {
      let k = 0;
      for (const a of n.args) {
        const sp = a.span;
        if (sp !== undefined) {
          const kk = this.facts.calls[at].callee + "\n" + spanKey(sp);
          const entry: CallSite = { callee: this.facts.calls[at].callee, span: sp, explicit: this.facts.calls[at].explicitArgs[k], idx: k };
          const prev = this.siteIndex.get(kk);
          if (prev !== undefined) {
            this.sites[prev] = entry;
          } else {
            this.siteIndex.set(kk, this.sites.length);
            this.sites.push(entry);
          }
        }
        k++;
      }
    }
  }

  afterAssign(n: Assign, id: number, kids: number[]): void {
    if (this.mode === 0) { this.mark(kids[0]); }
  }

  // A struct iterated by value is an iterator: the loop calls its mutating next().
  afterForInStmt(n: ForInStmt, id: number, kids: number[]): void {
    if (this.mode === 0 && (isTrue(n.mutRef) || this.aggregate.has(kids[0]))) { this.mark(kids[0]); }
  }

  afterUnaryOp(n: UnaryOp, id: number, kids: number[]): void {
    if (this.mode === 0 && n.op === "&mut") { this.mark(kids[0]); }
  }

  // A raw address can be written through anywhere.
  afterMethodCall(n: MethodCall, id: number, kids: number[]): void {
    if (this.mode === 0 && (n.method === "addrOf" || n.method === "ptr")) { this.mark(kids[0]); }
  }

  // `arr as *T` hands out the array's own storage: C or a raw store may write it.
  afterCastExpr(n: CastExpr, id: number, kids: number[]): void {
    if (this.mode === 0 && this.arrays.has(kids[0]) && n.targetType.isPtr) { this.mark(kids[0]); }
  }

  afterCall(n: Call, id: number, kids: number[]): void {
    if (this.mode === 0 && (n.func === "swap" || n.func === "replace" || n.func === "take")) {
      let k = 0;
      while (k < kids.length) {
        this.mark(kids[k]);
        k++;
      }
    }
  }

  // Whether the Ident under `parent` only reads through the reference. Anything not on the
  // list (bound to a name, stored, returned, handed to a callee that takes `&mut`) keeps the
  // `&mut`.
  readsOnly(parent: Parent, key: EdgeKey, index: number): boolean {
    if (parent.kind === "None") { return false; }
    if (parent.kind === "UnaryOp") { return parent.op !== "&mut"; }
    if (parent.kind === "MethodCall") {
      if (key === "object") { return true; }
      const at = this.callIdx.get(parent.id);
      if (at !== undefined && this.facts.calls[at].hasSig && index + 1 < this.facts.calls[at].mutParams.length) {
        return !this.facts.calls[at].mutParams[index + 1];
      }
      return false;
    }
    if (parent.kind === "Call") {
      // An unknown callee is a builtin (print, format, ...): none keeps a `&mut` argument.
      const at = this.callIdx.get(parent.id);
      if (at !== undefined && this.facts.calls[at].hasSig && index < this.facts.calls[at].mutParams.length) {
        return !this.facts.calls[at].mutParams[index];
      }
      return true;
    }
    if (parent.kind === "IfStmt" || parent.kind === "WhileStmt") { return key === "cond"; }
    return isReadParent(parent.kind);
  }
}
