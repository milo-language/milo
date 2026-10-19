// HIR -> MIR lowering (docs/plans/codegen-ir-2026-10.md, phase 2). MIR owns the function's
// control flow, scalar locals and scalar arithmetic. A statement or scalar expression outside
// that subset becomes an `opaque` statement that HIR codegen emits in place, so the subset can
// grow one node group per commit without a function falling back whole. A function still falls
// back when an unsupported piece cannot be made opaque (see `opaqueOk`).

import type { HIRExpr, HIRFunction, HIRStmt } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";
import { MirBuilder, validateMir, type Binding, type BlockId, type LocalId, type MirBinOp, type MirBody, type Operand } from "./mir";

export interface MirLowerCtx {
  /** Overflow traps on, and the function is not @wrapping. */
  checked: boolean;
  /** Whether a call to `name` with these argument types can be emitted as a plain call. */
  calleeOk(name: string, argTypes: TypeKind[], retType: TypeKind): boolean;
}

/** Thrown for anything outside the supported subset; `reason` feeds the coverage report. */
export class Unsupported extends Error {
  constructor(readonly reason: string) { super(`mir: unsupported ${reason}`); }
}

/** Integers without a declared range, floats and bools: values with no ownership and no layout. */
export function isMirScalar(t: TypeKind): boolean {
  return (t.tag === "int" && t.min === undefined && t.max === undefined) || t.tag === "float" || t.tag === "bool";
}

const BINOPS = new Set<string>(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", "==", "!=", "<", "<=", ">", ">="]);
const BOOL: TypeKind = { tag: "bool" };

interface Loop { brk: BlockId; cont: BlockId }

const LOOPS = new Set(["While", "ForRange", "ForEach", "ForIterator", "ForStrView"]);

/**
 * Whether HIR codegen can emit `node` on its own inside a MIR body: no `break`/`continue`
 * that leaves it (codegen would branch to its own loop labels, which a MIR loop never sets).
 * A jump inside a loop or closure that the node itself contains stays inside it.
 */
function opaqueOk(node: unknown): boolean {
  const walk = (n: unknown, inLoop: boolean): boolean => {
    if (Array.isArray(n)) return n.every(x => walk(x, inLoop));
    if (n === null || typeof n !== "object") return true;
    const kind = (n as { kind?: unknown }).kind;
    if ((kind === "Break" || kind === "Continue") && !inLoop) return false;
    const inner = inLoop || (typeof kind === "string" && (LOOPS.has(kind) || kind === "Closure"));
    for (const [k, v] of Object.entries(n)) {
      // Types and spans hold no statements.
      if (k === "type" || k === "span" || k === "retType" || k === "targetType") continue;
      if (!walk(v, inner)) return false;
    }
    return true;
  };
  return walk(node, false);
}

/**
 * Names `s` binds for the statements after it: a `let`, a null-ref unwrap, and pattern
 * bindings marked `escapes` (let-else desugars to a match whose bindings outlive it).
 */
function bindsPast(s: HIRStmt): string[] {
  const out: string[] = [];
  if (s.kind === "Let" || s.kind === "NullRefUnwrap") out.push(s.name);
  return out.concat(escapingBindings(s));
}

function escapingBindings(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== "object") return;
    const o = n as { escapes?: unknown; name?: unknown };
    if (o.escapes === true && typeof o.name === "string") out.push(o.name);
    for (const [k, v] of Object.entries(n)) if (k !== "type" && k !== "span") walk(v);
  };
  walk(node);
  return out;
}

/** The codegen-visible name of MIR local `id`; `.` cannot appear in a Milo identifier. */
export function mirLocalName(id: LocalId): string { return `mir.${id}`; }

class Lower {
  readonly b: MirBuilder;
  private scopes: Map<string, Binding>[] = [new Map()];
  private loops: Loop[] = [];
  private opaqueLets = 0;

  constructor(private fn: HIRFunction, private ctx: MirLowerCtx) {
    this.b = new MirBuilder(fn.name, fn.retType);
  }

  run(): MirBody {
    const fn = this.fn;
    // A by-value scalar parameter is a MIR local living in the slot genFunction's prologue
    // spilled it to; any other parameter is reachable only from opaque statements.
    for (const p of fn.params) {
      if (p.isRef || p.isRefMut || !isMirScalar(p.type)) continue;
      const id = this.b.local(p.type, p.name);
      this.b.body.params.push(id);
      this.bind(p.name, { name: p.name, local: id });
    }
    // A non-scalar result is returned by opaque `return` statements only.
    if (isMirScalar(fn.retType)) this.b.body.ret = this.b.local(fn.retType);
    this.stmts(fn.body);
    // Falling off the end: only a void fn gets here live (the checker rejects the rest), and
    // for anything else the block is unreachable past a `while true`.
    if (!this.b.terminated) this.b.terminate(fn.retType.tag === "void" ? { kind: "return" } : { kind: "unreachable" });
    validateMir(this.b.body);
    return this.b.body;
  }

  private scalar(t: TypeKind, what: string): void {
    if (!isMirScalar(t)) throw new Unsupported(`${what} of type ${t.tag}`);
  }

  private bind(name: string, bd: Binding): void { this.scopes[this.scopes.length - 1].set(name, bd); }

  /** The MIR local `name` refers to; anything else (a global, an opaque let) is opaque-only. */
  private lookup(name: string): LocalId {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const bd = this.scopes[i].get(name);
      if (bd !== undefined) {
        if ("local" in bd) return bd.local;
        throw new Unsupported("local declared by an opaque let");
      }
    }
    throw new Unsupported("global or unknown ident");
  }

  /** Every binding visible here, innermost first wins. */
  private visible(): Binding[] {
    const m = new Map<string, Binding>();
    for (const sc of this.scopes) for (const [k, v] of sc) m.set(k, v);
    return [...m.values()];
  }

  private opaque(hir: HIRStmt, extra: Binding[] = [], binds?: number, names?: string[]): void {
    this.b.push({ kind: "opaque", hir, scope: [...this.visible(), ...extra], binds, names, span: hir.span });
  }

  private scoped(body: HIRStmt[]): void {
    this.scopes.push(new Map());
    try { this.stmts(body); } finally { this.scopes.pop(); }
  }

  private stmts(body: HIRStmt[]): void {
    for (const s of body) {
      // The checker rejects unreachable code; a terminated block here means the rest is dead.
      if (this.b.terminated) return;
      const m = this.b.mark();
      const depth = this.scopes.length, loops = this.loops.length;
      try {
        this.stmt(s);
      } catch (err) {
        // A statement that binds past itself can be opaque only at top level, where the
        // function's drop glue on return drops what it bound.
        if (!(err instanceof Unsupported) || !opaqueOk(s) || (bindsPast(s).length > 0 && !this.topLevel())) throw err;
        this.b.rollback(m);
        this.scopes.length = depth;
        this.loops.length = loops;
        this.b.body.opaqueReasons.push(err.reason);
        this.opaqueStmt(s);
      }
    }
  }

  /** Function scope, outside any MIR loop: where HIR codegen drops a local at return. */
  private topLevel(): boolean { return this.scopes.length === 1 && this.loops.length === 0; }

  private opaqueStmt(s: HIRStmt): void {
    const names = bindsPast(s);
    if (names.length > 0) {
      const key = this.opaqueLets++;
      this.opaque(s, [], key, names);
      for (const name of names) this.bind(name, { name, cg: key });
      return;
    }
    this.opaque(s);
    // An opaque `return` ends the block; HIR codegen emitted the `ret`.
    if (s.kind === "Return") this.b.terminate({ kind: "unreachable" });
  }

  private stmt(s: HIRStmt): void {
    switch (s.kind) {
      case "Let": {
        if (s.viewBind) throw new Unsupported("view let");
        this.scalar(s.type, "let");
        const v = this.operand(s.value);
        const id = this.b.local(s.type, s.name, s.mutable, s.span);
        this.b.assign({ local: id }, { kind: "use", op: v }, s.span);
        this.bind(s.name, { name: s.name, local: id });
        return;
      }
      case "Assign": {
        if (s.isInit) throw new Unsupported("init assign");
        if (s.target.kind !== "Ident") throw new Unsupported(`assign to ${s.target.kind}`);
        const id = this.lookup(s.target.name);
        const v = this.operand(s.value);
        this.b.assign({ local: id }, { kind: "use", op: v }, s.span);
        return;
      }
      case "Return": {
        if (s.value) {
          if (this.b.body.ret === null) throw new Unsupported("non-scalar return value");
          const v = this.operand(s.value);
          this.b.assign({ local: this.b.body.ret! }, { kind: "use", op: v }, s.span);
        }
        this.b.terminate({ kind: "return" });
        return;
      }
      case "ExprStmt": {
        this.effect(s.expr);
        return;
      }
      case "If": {
        const cond = this.operand(s.cond);
        const then = this.b.newBlock(), join = this.b.newBlock();
        const els = s.elseBody ? this.b.newBlock() : join;
        this.b.terminate({ kind: "if", cond, then, else: els });
        this.b.switchTo(then);
        this.scoped(s.thenBody);
        if (!this.b.terminated) this.b.terminate({ kind: "goto", target: join });
        if (s.elseBody) {
          this.b.switchTo(els);
          this.scoped(s.elseBody);
          if (!this.b.terminated) this.b.terminate({ kind: "goto", target: join });
        }
        this.b.switchTo(join);
        return;
      }
      case "While": {
        if (s.invariants?.length) throw new Unsupported("loop invariant");
        const head = this.b.newBlock(), body = this.b.newBlock(), exit = this.b.newBlock();
        this.b.terminate({ kind: "goto", target: head });
        this.b.switchTo(head);
        const cond = this.operand(s.cond);
        this.b.terminate({ kind: "if", cond, then: body, else: exit });
        this.b.switchTo(body);
        this.loops.push({ brk: exit, cont: head });
        this.scoped(s.body);
        this.loops.pop();
        if (!this.b.terminated) this.b.terminate({ kind: "goto", target: head });
        this.b.switchTo(exit);
        return;
      }
      case "Break":
      case "Continue": {
        const loop = this.loops[this.loops.length - 1];
        if (!loop) throw new Unsupported(`${s.kind} outside a lowered loop`);
        this.b.terminate({ kind: "goto", target: s.kind === "Break" ? loop.brk : loop.cont });
        return;
      }
      case "Block":
        // A Block opens no scope, so a `let` in it binds in the enclosing one.
        this.stmts(s.body);
        return;
      case "UnsafeBlock":
        this.scoped(s.body);
        return;
      default:
        throw new Unsupported(`stmt ${s.kind}`);
    }
  }

  /** An expression evaluated for its effect only (a call statement). */
  private effect(e: HIRExpr): void {
    if (e.kind === "Call" && e.type.tag === "void") { this.call(e, null); return; }
    this.operand(e);
  }

  private temp(t: TypeKind, span?: Span): LocalId { return this.b.local(t, undefined, false, span); }

  /**
   * Lower `e` to an operand; anything that is not a constant or a local read goes through a
   * temp. A scalar expression MIR cannot lower is assigned to a temp by an opaque statement.
   */
  private operand(e: HIRExpr): Operand {
    const m = this.b.mark();
    try {
      return this.operandRaw(e);
    } catch (err) {
      // An expression whose bindings escape it (a let-else match) must go opaque with its
      // whole statement, which records what it binds.
      if (!(err instanceof Unsupported) || !isMirScalar(e.type) || !opaqueOk(e) || escapingBindings(e).length > 0) throw err;
      this.b.rollback(m);
      this.b.body.opaqueReasons.push(err.reason);
      const t = this.temp(e.type, e.span);
      const name = mirLocalName(t);
      const target: HIRExpr = { kind: "Ident", name, type: e.type, span: e.span };
      this.opaque({ kind: "Assign", target, value: e, span: e.span }, [{ name, local: t }]);
      return { kind: "copy", place: { local: t } };
    }
  }

  private operandRaw(e: HIRExpr): Operand {
    switch (e.kind) {
      case "IntLit":
      case "CharLit":
        this.scalar(e.type, e.kind);
        return { kind: "const", value: { kind: "int", value: BigInt(e.value), ty: e.type } };
      case "BoolLit":
        return { kind: "const", value: { kind: "bool", value: e.value } };
      case "FloatLit":
        this.scalar(e.type, "FloatLit");
        return { kind: "const", value: { kind: "float", value: e.value, ty: e.type } };
      case "Ident":
        return { kind: "copy", place: { local: this.lookup(e.name) } };
      case "BinOp": {
        if (e.op === "&&" || e.op === "||") return this.shortCircuit(e);
        if (!BINOPS.has(e.op)) throw new Unsupported(`binop ${e.op}`);
        this.scalar(e.left.type, "binop operand");
        this.scalar(e.type, "binop result");
        const left = this.operand(e.left), right = this.operand(e.right);
        const t = this.temp(e.type, e.span);
        this.b.assign({ local: t }, { kind: "binop", op: e.op as MirBinOp, left, right, ty: e.left.type, checked: this.ctx.checked, span: e.span }, e.span);
        return { kind: "copy", place: { local: t } };
      }
      case "UnaryOp": {
        if (e.op !== "-" && e.op !== "!" && e.op !== "~") throw new Unsupported(`unop ${e.op}`);
        this.scalar(e.type, "unop");
        // A negated literal is a constant, as in codegen: i32's INT_MIN is spelled `-2147483648`
        // and must not reach a checked negation of 2147483648.
        if (e.op === "-" && e.operand.kind === "IntLit" && e.operand.type.tag === "int" && e.operand.type.signed) {
          return { kind: "const", value: { kind: "int", value: -BigInt(e.operand.value), ty: e.operand.type } };
        }
        const operand = this.operand(e.operand);
        const t = this.temp(e.type, e.span);
        this.b.assign({ local: t }, { kind: "unop", op: e.op, operand, ty: e.operand.type, checked: this.ctx.checked, span: e.span }, e.span);
        return { kind: "copy", place: { local: t } };
      }
      case "Cast": {
        this.scalar(e.operand.type, "cast source");
        this.scalar(e.targetType, "cast target");
        const operand = this.operand(e.operand);
        const t = this.temp(e.targetType, e.span);
        this.b.assign({ local: t }, { kind: "cast", operand, from: e.operand.type, to: e.targetType, span: e.span }, e.span);
        return { kind: "copy", place: { local: t } };
      }
      case "Call": {
        if (e.type.tag === "void") throw new Unsupported("void call as value");
        const t = this.temp(e.type, e.span);
        this.call(e, t);
        return { kind: "copy", place: { local: t } };
      }
      default:
        throw new Unsupported(`expr ${e.kind}`);
    }
  }

  private call(e: HIRExpr & { kind: "Call" }, dest: LocalId | null): void {
    if (e.variadic) throw new Unsupported("variadic call");
    for (const a of e.args) {
      if (a.passByRef) throw new Unsupported("by-ref arg");
      this.scalar(a.expr.type, "call arg");
    }
    if (e.type.tag !== "void") this.scalar(e.type, "call result");
    if (!this.ctx.calleeOk(e.func, e.args.map(a => a.expr.type), e.type)) throw new Unsupported("callee");
    const args = e.args.map(a => this.operand(a.expr));
    const next = this.b.newBlock();
    this.b.terminate({ kind: "call", fn: e.func, args, dest: dest === null ? null : { local: dest }, retTy: e.type, next, span: e.span });
    this.b.switchTo(next);
  }

  // `a && b` / `a || b`: the right side runs only when the left does not decide the result.
  private shortCircuit(e: HIRExpr & { kind: "BinOp" }): Operand {
    const t = this.temp(BOOL, e.span);
    const left = this.operand(e.left);
    this.b.assign({ local: t }, { kind: "use", op: left }, e.span);
    const rhs = this.b.newBlock(), join = this.b.newBlock();
    const isAnd = e.op === "&&";
    this.b.terminate({ kind: "if", cond: { kind: "copy", place: { local: t } }, then: isAnd ? rhs : join, else: isAnd ? join : rhs });
    this.b.switchTo(rhs);
    const right = this.operand(e.right);
    this.b.assign({ local: t }, { kind: "use", op: right }, e.span);
    this.b.terminate({ kind: "goto", target: join });
    this.b.switchTo(join);
    return { kind: "copy", place: { local: t } };
  }
}

/** Why `fn` cannot be lowered, or null when it can. Cheap enough for the coverage report. */
export function lowerToMir(fn: HIRFunction, ctx: MirLowerCtx): MirBody | Unsupported {
  if (fn.isExtern) return new Unsupported("extern fn");
  if (fn.isVariadic) return new Unsupported("variadic fn");
  try {
    return new Lower(fn, ctx).run();
  } catch (err) {
    if (err instanceof Unsupported) return err;
    throw err;
  }
}
