// HIR -> the source-level `milo` MLIR dialect (mlir/Milo.td), as text, for the functions
// MILO_MLIR=1 compiles through milo-opt (docs/mlir-backend.md). A printer, not a lowering:
// structured control flow stays region ops, `var` stays a slot, Milo's checked arithmetic
// stays one op carrying its trap; every rewrite after this is a milo-opt pass.
//
// `emitMlirFunction` throws `MlirUnsupported` for anything outside the subset the dialect
// covers, so the function stays on legacy codegen; `mlirSupports` is that test alone.

import type { HIRExpr, HIRFunction, HIRStmt } from "./hir";
import type { TypeKind } from "./types";
import type { Span } from "./ast";

export interface MlirEmitCtx {
  trapOnOverflow: boolean;
  // requires/ensures/invariant become runtime checks only when on (-O0 by default).
  contractChecks: boolean;
  checkLocation(span?: Span): { file: string; line: number; col: number } | null;
  isBuiltinName(name: string): boolean;
  fnSigs: Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>;
  sretFns: Set<string>;
  llvmType(t: TypeKind): string;
}

export class MlirUnsupported extends Error {
  constructor(readonly reason: string) { super(`mlir: unsupported ${reason}`); }
}

// `*T` for any T: untyped, as the pointee type rides on each access.
const PTR = "!milo.ptr";

/** The dialect's type for a Milo scalar (ints carry signedness), or null. */
export function mlirType(t: TypeKind): string | null {
  if (t.tag === "int" && t.min === undefined && t.max === undefined) return `${t.signed ? "si" : "ui"}${t.bits}`;
  if (t.tag === "float") return t.bits === 32 ? "f32" : "f64";
  if (t.tag === "bool") return "i1";
  if (t.tag === "ptr") return PTR;
  return null;
}

function scalar(t: TypeKind, what: string): string {
  const m = mlirType(t);
  if (m === null) throw new MlirUnsupported(`${what} of type ${t.tag}`);
  return m;
}

/** MLIR string literal (symbol names, file names in locations). */
function quote(s: string): string {
  let out = "";
  for (const ch of Buffer.from(s, "utf-8")) {
    if (ch === 0x22 || ch === 0x5c || ch < 0x20 || ch >= 0x7f) out += `\\${ch.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(ch);
  }
  return `"${out}"`;
}

// Bit-exact float literals: NaN payloads and -0 survive, f32 is rounded the way legacy
// codegen rounds it.
function floatLit(v: number, ty: string): string {
  if (ty === "f32") {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v);
    return `0x${b.getUint32(0).toString(16).toUpperCase().padStart(8, "0")}`;
  }
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  return `0x${b.getBigUint64(0).toString(16).toUpperCase().padStart(16, "0")}`;
}

interface Val { ref: string; ty: string }
// A `var` is a slot; so is a by-ref param, whose slot is the caller's (`param` is its index).
type Binding = { kind: "ssa"; v: Val } | { kind: "var"; ref: string; ty: string; param?: number };

const ARITH: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "rem", "<<": "shl", ">>": "shr" };
const BITS: Record<string, string> = { "&": "and", "|": "or", "^": "xor" };
const CMPS: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };

class FnEmitter {
  private body: string[] = [];
  private vars: string[] = [];
  private depth = 1;
  private n = 0;
  private loops = 0;
  private scopes: Map<string, Binding>[] = [new Map()];
  readonly callees = new Map<string, string>();
  // Each call, with the param index of every by-ref argument that is one of this fn's own
  // by-ref params (null for anything else): what codegen's stub must reproduce.
  readonly calls: { name: string; refParams: (number | null)[] }[] = [];

  constructor(private fn: HIRFunction, private cx: MlirEmitCtx, private fns: Map<string, HIRFunction>) {}

  run(): string {
    const fn = this.fn;
    if (fn.isExtern) throw new MlirUnsupported("extern fn");
    if (fn.isVariadic) throw new MlirUnsupported("variadic fn");
    // main's prologue (argc/argv, global init, stdout buffering) is legacy codegen's.
    if (fn.name === "main") throw new MlirUnsupported("main");
    if (fn.replayEngine) throw new MlirUnsupported("replay engine fn");
    if (this.cx.contractChecks && (fn.contracts?.length || fn.oldSnapshots?.length)) throw new MlirUnsupported("contracts");
    if (fn.entryGuards?.length) throw new MlirUnsupported("lazy global guard");
    if (this.cx.sretFns.has(fn.name)) throw new MlirUnsupported("sret");
    const params = fn.params.map((p, i) => {
      const ty = scalar(p.type, p.isRef || p.isRefMut ? "by-ref param" : "param");
      if (p.isRef || p.isRefMut) {
        this.bind(p.name, { kind: "var", ref: `%p${i}`, ty, param: i });
        return `%p${i}: !milo.ref<${ty}>`;
      }
      this.bind(p.name, { kind: "ssa", v: { ref: `%p${i}`, ty } });
      return `%p${i}: ${ty}`;
    });
    const ret = fn.retType.tag === "void" ? null : scalar(fn.retType, "return");
    if (!this.stmts(fn.body)) this.emit(ret === null ? "milo.return" : "milo.unreachable");
    const head = `func.func @${quote(fn.name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} {`;
    return [head, ...this.vars, ...this.body, "}"].join("\n");
  }

  private emit(line: string): void { this.body.push(`${"  ".repeat(this.depth)}${line}`); }
  private fresh(): string { return `%v${this.n++}`; }
  private bind(name: string, b: Binding): void { this.scopes[this.scopes.length - 1].set(name, b); }

  private lookup(name: string): Binding {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b) return b;
    }
    throw new MlirUnsupported("global or unknown ident");
  }

  private loc(span: Span | undefined): string {
    const l = this.cx.checkLocation(span);
    if (!l) throw new MlirUnsupported("no source file for a panic location");
    return `loc(${quote(l.file)}:${l.line}:${l.col})`;
  }

  /** A region's body; adds `term` unless it already ended in a jump. */
  private region(open: string, fill: () => boolean, term = "milo.yield"): boolean {
    this.emit(open);
    this.depth++;
    this.scopes.push(new Map());
    const done = fill();
    if (!done) this.emit(term);
    this.scopes.pop();
    this.depth--;
    return done;
  }

  /** True when the statements end in a jump: whatever follows is dead. */
  private stmts(body: HIRStmt[]): boolean {
    for (const s of body) if (this.stmt(s)) return true;
    return false;
  }

  private stmt(s: HIRStmt): boolean {
    switch (s.kind) {
      case "Let": {
        if (s.viewBind) throw new MlirUnsupported("view let");
        const ty = scalar(s.type, "let");
        const v = this.expr(s.value);
        if (v.ty !== ty) throw new MlirUnsupported("let of a different type");
        if (!s.mutable) { this.bind(s.name, { kind: "ssa", v }); return false; }
        const ref = this.fresh();
        this.vars.push(`  ${ref} = milo.var ${quote(s.name)} : !milo.ref<${ty}>`);
        this.emit(`milo.store ${v.ref}, ${ref} : !milo.ref<${ty}>`);
        this.bind(s.name, { kind: "var", ref, ty });
        return false;
      }
      case "Assign": {
        if (s.isInit) throw new MlirUnsupported("init assign");
        if (s.target.kind === "PtrDeref") {
          const ty = scalar(s.target.type, "store through a pointer");
          const p = this.expr(s.target.operand);
          const v = this.expr(s.value);
          if (p.ty !== PTR || v.ty !== ty) throw new MlirUnsupported("store through a pointer of another type");
          this.emit(`milo.ptr.store ${v.ref}, ${p.ref} : ${ty}`);
          return false;
        }
        if (s.target.kind !== "Ident") throw new MlirUnsupported(`assign to ${s.target.kind}`);
        const b = this.lookup(s.target.name);
        if (b.kind !== "var") throw new MlirUnsupported("assign to an immutable binding");
        const v = this.expr(s.value);
        if (v.ty !== b.ty) throw new MlirUnsupported("assign of a different type");
        this.emit(`milo.store ${v.ref}, ${b.ref} : !milo.ref<${b.ty}>`);
        return false;
      }
      case "Return": {
        if (!s.value) { this.emit("milo.return"); return true; }
        const v = this.expr(s.value);
        if (v.ty !== mlirType(this.fn.retType)) throw new MlirUnsupported("return of a different type");
        this.emit(`milo.return ${v.ref} : ${v.ty}`);
        return true;
      }
      case "ExprStmt":
        this.expr(s.expr, true);
        return false;
      case "If": {
        const c = this.expr(s.cond);
        let thenDone = false;
        let elseDone = false;
        thenDone = this.region(`milo.if ${c.ref} {`, () => this.stmts(s.thenBody));
        if (s.elseBody) elseDone = this.region("} else {", () => this.stmts(s.elseBody!));
        this.emit("}");
        if (thenDone && elseDone) {
          // milo.if is not a terminator; the block still needs one, and nothing reaches it.
          this.emit("milo.unreachable");
          return true;
        }
        return false;
      }
      case "While": {
        if (this.cx.contractChecks && s.invariants?.length) throw new MlirUnsupported("loop invariant");
        this.loops++;
        if (s.cond.kind === "BoolLit" && s.cond.value) {
          this.region("milo.loop {", () => this.stmts(s.body));
        } else {
          this.region("milo.while {", () => {
            const c = this.expr(s.cond);
            this.emit(`milo.condition ${c.ref}`);
            return true;
          });
          this.region("} do {", () => this.stmts(s.body));
        }
        this.emit("}");
        this.loops--;
        return false;
      }
      case "ForRange": {
        if (this.cx.contractChecks && s.invariants?.length) throw new MlirUnsupported("loop invariant");
        const ty = scalar(s.varType, "for var");
        if (ty === "i1" || ty === PTR || ty.startsWith("f")) throw new MlirUnsupported("for over a non-int");
        const start = this.expr(s.start);
        const end = this.expr(s.end);
        // Legacy codegen widens a narrower bound by the loop variable's signedness, which
        // milo.cast (source signedness) would not match; such loops stay legacy.
        if (start.ty !== ty || end.ty !== ty) throw new MlirUnsupported("for bound of a different type");
        const iv = this.fresh();
        this.loops++;
        this.region(`milo.for ${start.ref} to ${end.ref} : ${ty} {`, () => {
          this.emit(`^bb0(${iv}: ${ty}):`);
          this.bind(s.varName, { kind: "ssa", v: { ref: iv, ty } });
          return this.stmts(s.body);
        });
        this.emit("}");
        this.loops--;
        return false;
      }
      case "Break":
      case "Continue":
        if (this.loops === 0) throw new MlirUnsupported(`${s.kind} outside a loop`);
        this.emit(s.kind === "Break" ? "milo.break" : "milo.continue");
        return true;
      case "Block":
        // Opens no scope: a `let` in it binds in the enclosing one.
        return this.stmts(s.body);
      case "UnsafeBlock": {
        this.scopes.push(new Map());
        try { return this.stmts(s.body); } finally { this.scopes.pop(); }
      }
      default:
        throw new MlirUnsupported(`stmt ${s.kind}`);
    }
  }

  private def(rhs: string, ty: string, loc = ""): Val {
    const ref = this.fresh();
    this.emit(`${ref} = ${rhs}${loc ? ` ${loc}` : ""}`);
    return { ref, ty };
  }

  /** `stmt`: evaluated for effect only, so a void call is fine. */
  private expr(e: HIRExpr, stmt = false): Val {
    switch (e.kind) {
      case "IntLit":
      case "CharLit": {
        const ty = scalar(e.type, e.kind);
        if (ty === "i1" || ty === PTR) throw new MlirUnsupported(`int literal of type ${ty}`);
        return this.def(`milo.const ${BigInt(e.value)} : ${ty}`, ty);
      }
      case "BoolLit":
        return this.def(`milo.const ${e.value}`, "i1");
      case "FloatLit": {
        const ty = scalar(e.type, "FloatLit");
        if (ty !== "f32" && ty !== "f64") throw new MlirUnsupported("float literal of int type");
        return this.def(`milo.const ${floatLit(e.value, ty)} : ${ty}`, ty);
      }
      case "Ident": {
        const b = this.lookup(e.name);
        if (b.kind === "ssa") return b.v;
        return this.def(`milo.load ${b.ref} : !milo.ref<${b.ty}>`, b.ty);
      }
      case "BinOp": return this.binop(e);
      case "UnaryOp": return this.unop(e);
      case "Cast": {
        const from = scalar(e.operand.type, "cast source");
        const to = scalar(e.targetType, "cast target");
        const v = this.expr(e.operand);
        if (v.ty !== from) throw new MlirUnsupported("cast operand type");
        if (from === to) return v;
        if ((from === PTR && to.startsWith("f")) || (to === PTR && from.startsWith("f"))) throw new MlirUnsupported("cast between a pointer and a float");
        return this.def(`milo.cast ${v.ref} : ${from} to ${to}`, to);
      }
      case "Call": return this.call(e, stmt);
      case "PtrDeref": {
        const ty = scalar(e.type, "load through a pointer");
        const p = this.expr(e.operand);
        if (p.ty !== PTR) throw new MlirUnsupported("deref of a non-pointer");
        return this.def(`milo.ptr.load ${p.ref} : ${ty}`, ty);
      }
      default:
        throw new MlirUnsupported(`expr ${e.kind}`);
    }
  }

  private binop(e: HIRExpr & { kind: "BinOp" }): Val {
    if (e.op === "&&" || e.op === "||") {
      // `a && b` is `if a { b } else { false }`: b runs only when a does not decide it.
      const l = this.expr(e.left);
      if (l.ty !== "i1") throw new MlirUnsupported("logical operand type");
      const ref = this.fresh();
      const isAnd = e.op === "&&";
      const rhs = () => {
        const r = this.expr(e.right);
        if (r.ty !== "i1") throw new MlirUnsupported("logical operand type");
        this.emit(`milo.yield ${r.ref} : i1`);
        return true;
      };
      const lit = () => { const c = this.def(`milo.const ${!isAnd}`, "i1"); this.emit(`milo.yield ${c.ref} : i1`); return true; };
      this.region(`${ref} = milo.if ${l.ref} -> i1 {`, isAnd ? rhs : lit);
      this.region("} else {", isAnd ? lit : rhs);
      this.emit("}");
      return { ref, ty: "i1" };
    }
    const ty = scalar(e.left.type, "binop operand");
    if (ty === PTR && !(e.op in CMPS)) throw new MlirUnsupported(`pointer ${e.op}`);
    const l = this.expr(e.left), r = this.expr(e.right);
    if (l.ty !== ty || r.ty !== ty) throw new MlirUnsupported("binop operand types");
    if (e.op in CMPS) return this.def(`milo.cmp ${CMPS[e.op]}, ${l.ref}, ${r.ref} : ${ty}`, "i1");
    if (scalar(e.type, "binop result") !== ty) throw new MlirUnsupported("binop result type");
    if (e.op in BITS) {
      if (ty.startsWith("f")) throw new MlirUnsupported("bitwise op on a float");
      return this.def(`milo.${BITS[e.op]} ${l.ref}, ${r.ref} : ${ty}`, ty);
    }
    const op = ARITH[e.op];
    if (!op) throw new MlirUnsupported(`binop ${e.op}`);
    const isInt = ty.startsWith("s") || ty.startsWith("u");
    if (!isInt && (op === "shl" || op === "shr")) throw new MlirUnsupported("shift of a non-int");
    if (ty === "i1") throw new MlirUnsupported("arithmetic on bool");
    // Mirrors emitScalarBinOp: + - * trap only with overflow checks on, outside @wrapping,
    // and with a span; / % << >> trap unless @wrapping.
    const wrapping = isInt && (op === "add" || op === "sub" || op === "mul"
      ? !(this.cx.trapOnOverflow && !this.fn.isWrapping && e.span)
      : !!this.fn.isWrapping);
    return this.def(`milo.${op} ${l.ref}, ${r.ref}${wrapping ? " wrapping" : ""} : ${ty}`, ty, isInt ? this.loc(e.span) : "");
  }

  private unop(e: HIRExpr & { kind: "UnaryOp" }): Val {
    const ty = scalar(e.type, "unop");
    if (ty === PTR) throw new MlirUnsupported(`unop ${e.op} on a pointer`);
    if (e.op === "-") {
      // A negated literal is a constant, as in codegen: i32's MIN is spelled
      // `-2147483648` and must not reach a checked negation of 2147483648.
      if (e.operand.kind === "IntLit" && e.operand.type.tag === "int" && e.operand.type.signed) {
        if (scalar(e.operand.type, "literal") !== ty) throw new MlirUnsupported("negated literal type");
        return this.def(`milo.const ${-BigInt(e.operand.value)} : ${ty}`, ty);
      }
      const v = this.expr(e.operand);
      if (v.ty !== ty || ty === "i1") throw new MlirUnsupported("negation operand type");
      const isInt = !ty.startsWith("f");
      const wrapping = isInt && !(this.cx.trapOnOverflow && !this.fn.isWrapping && e.span);
      return this.def(`milo.neg ${v.ref}${wrapping ? " wrapping" : ""} : ${ty}`, ty, isInt ? this.loc(e.span) : "");
    }
    if (e.op === "!" || e.op === "~") {
      const v = this.expr(e.operand);
      if (v.ty !== ty || ty.startsWith("f") || (e.op === "!") !== (ty === "i1")) throw new MlirUnsupported(`unop ${e.op} operand type`);
      return this.def(`milo.not ${v.ref} : ${ty}`, ty);
    }
    throw new MlirUnsupported(`unop ${e.op}`);
  }

  /**
   * The slot a by-ref argument borrows. A `var` or a by-ref param is its own slot; an
   * immutable value lent as `&T` gets a fresh one, as legacy codegen spills it.
   */
  private place(e: HIRExpr, refTy: string): { ref: string; param?: number } {
    if (e.kind !== "Ident") throw new MlirUnsupported(`by-ref arg ${e.kind}`);
    const b = this.lookup(e.name);
    if (`!milo.ref<${b.kind === "var" ? b.ty : b.v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
    if (b.kind === "var") return { ref: b.ref, param: b.param };
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(e.name)} : ${refTy}`);
    this.emit(`milo.store ${b.v.ref}, ${ref} : ${refTy}`);
    return { ref };
  }

  private call(e: HIRExpr & { kind: "Call" }, stmt: boolean): Val {
    if (e.variadic) throw new MlirUnsupported("variadic call");
    if (this.cx.isBuiltinName(e.func)) throw new MlirUnsupported("builtin call");
    const callee = this.fns.get(e.func);
    const sig = this.cx.fnSigs.get(e.func);
    if (!callee || !sig || sig.variadic || this.cx.sretFns.has(e.func)) throw new MlirUnsupported("callee");
    // An extern's call goes to its C symbol; keep those on legacy codegen for now.
    if (callee.isExtern && callee.linkName && callee.linkName !== callee.name) throw new MlirUnsupported("callee link name");
    if (callee.params.length !== e.args.length) throw new MlirUnsupported("callee arity");
    const paramTys = callee.params.map((p, i) => {
      const byRef = p.isRef || p.isRefMut;
      if (byRef !== e.args[i].passByRef) throw new MlirUnsupported("by-ref arg mismatch");
      const ty = scalar(p.type, byRef ? "by-ref arg" : "call arg");
      if (sig.paramTypes[i] !== (byRef ? "ptr" : this.cx.llvmType(p.type))) throw new MlirUnsupported("callee signature");
      return byRef ? `!milo.ref<${ty}>` : ty;
    });
    const ret = callee.retType.tag === "void" ? null : scalar(callee.retType, "call result");
    if (ret !== null ? sig.retType !== this.cx.llvmType(callee.retType) : sig.retType !== "void") throw new MlirUnsupported("callee signature");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const provenance: (number | null)[] = [];
    const args = e.args.map((a, i) => {
      if (a.passByRef) {
        const ref = this.place(a.expr, paramTys[i]);
        refs.push({ ref: ref.ref, mut: a.refMut, ty: paramTys[i] });
        provenance.push(ref.param ?? null);
        return ref.ref;
      }
      const v = this.expr(a.expr);
      if (v.ty !== paramTys[i]) throw new MlirUnsupported("call arg type");
      provenance.push(null);
      return v.ref;
    });
    // As legacy genCall: after every argument, one check per pair with a `&mut`; a pair
    // that is the same SSA value is the same static place, which the checker already
    // rejected.
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if ((!refs[i].mut && !refs[j].mut) || refs[i].ref === refs[j].ref) continue;
        this.emit(`milo.check_unaliased ${refs[i].ref}, ${refs[j].ref} : ${refs[i].ty}, ${refs[j].ty} ${this.loc(e.span)}`);
      }
    }
    const fnTy = `(${paramTys.join(", ")}) -> ${ret === null ? "()" : ret}`;
    this.callees.set(e.func, fnTy);
    this.calls.push({ name: e.func, refParams: provenance });
    const call = `func.call @${quote(e.func)}(${args.join(", ")}) : ${fnTy}`;
    if (ret === null) { this.emit(call); return { ref: "", ty: "" }; }
    return this.def(call, ret);
  }
}

export interface MlirFunction {
  name: string;
  text: string;
  /** Every function it calls, with the dialect's function type. */
  callees: Map<string, string>;
  calls: FnEmitter["calls"];
}

/** `fn` in the dialect, or the reason it stays on legacy codegen. */
export function emitMlirFunction(fn: HIRFunction, cx: MlirEmitCtx, fns: Map<string, HIRFunction>): MlirFunction | string {
  const em = new FnEmitter(fn, cx, fns);
  try {
    return { name: fn.name, text: em.run(), callees: em.callees, calls: em.calls };
  } catch (err) {
    if (err instanceof MlirUnsupported) return err.reason;
    throw err;
  }
}

/** Why `fn` stays on legacy codegen, or null when the dialect covers it. */
export function mlirSupports(fn: HIRFunction, cx: MlirEmitCtx, fns: Map<string, HIRFunction>): string | null {
  const r = emitMlirFunction(fn, cx, fns);
  return typeof r === "string" ? r : null;
}

/** One module: the functions, plus a declaration for every callee not among them. */
export function mlirModuleText(funcs: MlirFunction[]): string {
  const have = new Set(funcs.map(f => f.name));
  const callees = new Map<string, string>();
  for (const f of funcs) for (const [k, v] of f.callees) if (!have.has(k)) callees.set(k, v);
  const decls = [...callees].map(([k, ty]) => {
    const [args, ret] = ty.split(" -> ");
    return `func.func private @${quote(k)}${args}${ret === "()" ? "" : ` -> ${ret}`}`;
  });
  return [...decls, ...funcs.map(f => f.text), ""].join("\n");
}
