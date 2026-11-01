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
  // std/replay is in the program, so replay-engine fns count their depth (codegen replayEngineScope).
  replayScope: boolean;
  // requires/ensures/invariant become runtime checks only when on (-O0 by default).
  contractChecks: boolean;
  checkLocation(span?: Span): { file: string; line: number; col: number } | null;
  isBuiltinName(name: string): boolean;
  fnSigs: Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>;
  sretFns: Set<string>;
  llvmType(t: TypeKind): string;
  // main is taken only when it is the process entry (no green-task wrapper around it).
  readonly mlirMainOk: boolean;
  mlirPrintHelper(stderr: boolean, parts: { key: string; type: TypeKind }[]): string;
  hasStringType: boolean;
  structLayouts: Map<string, { fields: { name: string; typeKind: TypeKind }[] }>;
  mlirEnumLayout(name: string): { size: number; align: number; variants: { name: string; tag: number; fields: TypeKind[]; offsets: number[] }[] } | null;
  needsDropCg(t: TypeKind): boolean;
  typeSizeOf(t: TypeKind): number;
}

export class MlirUnsupported extends Error {
  constructor(readonly reason: string) { super(`mlir: unsupported ${reason}`); }
}

// `*T` for any T: untyped, as the pointee type rides on each access.
const PTR = "!milo.ptr";
// Only ever a literal until drops exist (Milo.td StringType).
const STR = "!milo.string";

/** The dialect's type for a Milo scalar (ints carry signedness), or null. */
export function mlirType(t: TypeKind): string | null {
  if (t.tag === "int" && t.min === undefined && t.max === undefined) return `${t.signed ? "si" : "ui"}${t.bits}`;
  if (t.tag === "float") return t.bits === 32 ? "f32" : "f64";
  if (t.tag === "bool") return "i1";
  if (t.tag === "ptr") return PTR;
  return null;
}

/** The element type of a Vec of scalars, or null. */
function vecElem(t: TypeKind): string | null {
  if (t.tag !== "vec") return null;
  const e = mlirType(t.element);
  return e === null || e === PTR ? null : e;
}

function scalar(t: TypeKind, what: string): string {
  const m = mlirType(t);
  if (m === null) throw new MlirUnsupported(`${what} of type ${t.tag}`);
  return m;
}

const aggregates = new WeakMap<MlirEmitCtx, Map<string, string | null>>();

/**
 * The dialect's type for a value of `t`: a scalar, or a struct or enum made of such values
 * with no drop glue (owned values are M4). Null otherwise, and for an aggregate of 128
 * bytes or more, which legacy codegen never holds as an SSA value (isBigAgg).
 */
function valueType(cx: MlirEmitCtx, t: TypeKind): string | null {
  const m = mlirType(t);
  if (m !== null || (t.tag !== "struct" && t.tag !== "enum")) return m;
  let cache = aggregates.get(cx);
  if (!cache) aggregates.set(cx, cache = new Map());
  const key = `${t.tag} ${t.name}`;
  if (cache.has(key)) return cache.get(key)!;
  // A type that contains itself is behind a Heap, which this rejects anyway.
  cache.set(key, null);
  const r = aggregateType(cx, t);
  cache.set(key, r);
  return r;
}

function aggregateType(cx: MlirEmitCtx, t: TypeKind & { tag: "struct" | "enum" }): string | null {
  if (cx.needsDropCg(t) || cx.typeSizeOf(t) >= 128 || cx.llvmType(t) !== `%${t.name}`) return null;
  if (t.tag === "struct") {
    const l = cx.structLayouts.get(t.name);
    const fields = l?.fields.map(f => valueType(cx, f.typeKind));
    if (!fields || fields.some(f => f === null)) return null;
    return `!milo.struct<${quote(t.name)}${fields.map(f => `, ${f}`).join("")}>`;
  }
  const l = cx.mlirEnumLayout(t.name);
  if (!l) return null;
  const variants: string[] = [];
  for (const v of l.variants) {
    const fields = v.fields.map(f => valueType(cx, f));
    if (fields.some(f => f === null)) return null;
    variants.push(`${v.tag}: (${fields.map((f, k) => `${f} at ${v.offsets[k]}`).join(", ")})`);
  }
  return `!milo.enum<${quote(t.name)}, size = ${l.size}, align = ${l.align}, [${variants.join(", ")}]>`;
}

function stripRefs(t: TypeKind): TypeKind {
  while (t.tag === "ref") t = t.inner;
  return t;
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
// A `vec` is a `&Vec<T>` / `&mut Vec<T>` param: the address of the caller's header.
type Binding = { kind: "ssa"; v: Val } | { kind: "var"; ref: string; ty: string; param?: number }
  | { kind: "vec"; ref: string; elem: string; param: number } | { kind: "opaque"; what: string };

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
    // main's prologue (argc/argv, global init, stdout buffering) is legacy codegen's; the
    // splice keeps it. Behind a green-task wrapper main is another function, left legacy.
    const isMain = fn.name === "main";
    if (isMain && (!this.cx.mlirMainOk || fn.params.length || fn.retType.tag !== "void")) throw new MlirUnsupported("main");
    if (this.cx.contractChecks && (fn.contracts?.length || fn.oldSnapshots?.length)) throw new MlirUnsupported("contracts");
    if (fn.entryGuards?.length) throw new MlirUnsupported("lazy global guard");
    if (this.cx.sretFns.has(fn.name)) throw new MlirUnsupported("sret");
    const params = fn.params.map((p, i) => {
      // A by-ref param of a type the dialect lacks is just a pointer in the signature; the
      // function qualifies only if it never names it (lookup refuses).
      const elem = vecElem(p.type);
      if ((p.isRef || p.isRefMut) && elem !== null) {
        this.bind(p.name, { kind: "vec", ref: `%p${i}`, elem, param: i });
        return `%p${i}: !milo.vec<${elem}>`;
      }
      if ((p.isRef || p.isRefMut) && valueType(this.cx, p.type) === null) {
        this.bind(p.name, { kind: "opaque", what: p.type.tag });
        return `%p${i}: ${PTR}`;
      }
      const ty = this.value(p.type, p.isRef || p.isRefMut ? "by-ref param" : "param");
      if (p.isRef || p.isRefMut) {
        this.bind(p.name, { kind: "var", ref: `%p${i}`, ty, param: i });
        return `%p${i}: !milo.ref<${ty}>`;
      }
      this.bind(p.name, { kind: "ssa", v: { ref: `%p${i}`, ty } });
      return `%p${i}: ${ty}`;
    });
    // main is `i32 @main(i32 argc, ptr argv)` and returns 0, as legacy emits it.
    if (isMain) params.push("%argc: si32", `%argv: ${PTR}`);
    const ret = isMain ? "si32" : fn.retType.tag === "void" ? null : this.value(fn.retType, "return");
    this.isMain = isMain;
    this.retTy = ret;
    // As legacy replayEngineScope, which applies only when std/replay is in the program.
    this.replay = !!fn.replayEngine && this.cx.replayScope;
    if (this.replay) this.emit("milo.replay.enter");
    if (!this.stmts(fn.body)) {
      if (isMain) this.retMain();
      else if (ret === null) this.ret("milo.return");
      else this.emit("milo.unreachable");
    }
    const head = `func.func @${quote(fn.name)}(${params.join(", ")})${ret === null ? "" : ` -> ${ret}`} {`;
    return [head, ...this.vars, ...this.body, "}"].join("\n");
  }

  private replay = false;
  private isMain = false;
  private retTy: string | null = null;

  private value(t: TypeKind, what: string): string {
    const v = valueType(this.cx, t);
    if (v === null) throw new MlirUnsupported(`${what} of type ${t.tag}`);
    return v;
  }
  private retMain(): void {
    const z = this.def("milo.const 0 : si32", "si32");
    this.ret(`milo.return ${z.ref} : si32`);
  }
  private ret(line: string): void {
    if (this.replay) this.emit("milo.replay.exit");
    this.emit(line);
  }

  private emit(line: string): void { this.body.push(`${"  ".repeat(this.depth)}${line}`); }
  private fresh(): string { return `%v${this.n++}`; }
  private bind(name: string, b: Binding): void { this.scopes[this.scopes.length - 1].set(name, b); }

  private lookup(name: string): Exclude<Binding, { kind: "opaque" }> {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const b = this.scopes[i].get(name);
      if (b?.kind === "opaque") throw new MlirUnsupported(`use of a by-ref param of type ${b.what}`);
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
        if (s.type.tag === "string" && !s.mutable && s.value.kind === "StringLit") {
          this.bind(s.name, { kind: "ssa", v: this.expr(s.value) });
          return false;
        }
        const ty = this.value(s.type, "let");
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
          // The value first, then the place: legacy genStmt Assign's order.
          const v = this.expr(s.value);
          const p = this.expr(s.target.operand);
          if (p.ty !== PTR || v.ty !== ty) throw new MlirUnsupported("store through a pointer of another type");
          this.emit(`milo.ptr.store ${v.ref}, ${p.ref} : ${ty}`);
          return false;
        }
        if (s.target.kind === "IndexAccess") {
          const v = this.expr(s.value);
          const { vec, elem, index } = this.indexPlace(s.target);
          if (v.ty !== elem) throw new MlirUnsupported("element store of another type");
          this.emit(`milo.index.store ${v.ref}, ${vec}[${index}] : ${elem}, !milo.vec<${elem}> ${this.loc(s.target.span)}`);
          return false;
        }
        if (s.target.kind === "FieldAccess") {
          const v = this.expr(s.value);
          const p = this.fieldPlace(s.target);
          if (!p) throw new MlirUnsupported("assign to a field of a value");
          if (v.ty !== p.ty) throw new MlirUnsupported("field store of another type");
          this.emit(`milo.store ${v.ref}, ${p.ref} : !milo.ref<${p.ty}>`);
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
        if (!s.value && this.isMain) { this.retMain(); return true; }
        if (!s.value) { this.ret("milo.return"); return true; }
        const v = this.expr(s.value);
        if (v.ty !== this.retTy) throw new MlirUnsupported("return of a different type");
        this.ret(`milo.return ${v.ref} : ${v.ty}`);
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
      case "Match":
        return this.match(s, null).done;
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
      case "StringLit":
        this.cx.hasStringType = true;
        return this.def(`milo.string.lit ${quote(e.value)}`, STR);
      case "FloatLit": {
        const ty = scalar(e.type, "FloatLit");
        if (ty !== "f32" && ty !== "f64") throw new MlirUnsupported("float literal of int type");
        return this.def(`milo.const ${floatLit(e.value, ty)} : ${ty}`, ty);
      }
      case "Ident": {
        const b = this.lookup(e.name);
        if (b.kind === "ssa") return b.v;
        if (b.kind === "vec") throw new MlirUnsupported("a Vec as a value");
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
      case "IndexAccess": {
        const { vec, elem, index } = this.indexPlace(e);
        return this.def(`milo.index ${vec}[${index}] : !milo.vec<${elem}> -> ${elem}`, elem, this.loc(e.span));
      }
      case "VecLen": {
        const b = e.object.kind === "Ident" ? this.lookup(e.object.name) : null;
        if (b?.kind !== "vec") throw new MlirUnsupported("len of a Vec that is not a by-ref param");
        return this.def(`milo.len ${b.ref} : !milo.vec<${b.elem}>`, "si64");
      }
      case "PtrDeref": {
        const ty = scalar(e.type, "load through a pointer");
        const p = this.expr(e.operand);
        if (p.ty !== PTR) throw new MlirUnsupported("deref of a non-pointer");
        return this.def(`milo.ptr.load ${p.ref} : ${ty}`, ty);
      }
      case "FieldAccess": {
        // A field of a place is read in place, as legacy genFieldPtr does; of a value, out
        // of the value.
        const p = this.fieldPlace(e);
        if (p) return this.def(`milo.load ${p.ref} : !milo.ref<${p.ty}>`, p.ty);
        const { index, ty } = this.field(e);
        const s = this.expr(e.object);
        return this.def(`milo.struct.get ${s.ref}[${index}] : ${s.ty} -> ${ty}`, ty);
      }
      case "StructLit": return this.structLit(e);
      case "EnumLit": {
        const ty = this.value(e.type, "enum literal");
        const v = this.cx.mlirEnumLayout(e.enumName)?.variants.find(x => x.name === e.variant);
        if (!v || v.fields.length !== e.args.length) throw new MlirUnsupported("enum variant");
        const args = e.args.map(a => this.expr(a));
        const fields = v.fields.map(f => this.value(f, "payload"));
        if (args.some((a, k) => a.ty !== fields[k])) throw new MlirUnsupported("payload of another type");
        const ops = args.length ? ` (${args.map(a => a.ref).join(", ")} : ${fields.join(", ")})` : "";
        return this.def(`milo.enum.new ${v.tag}${ops} -> ${ty}`, ty);
      }
      case "IsCheck": {
        const v = this.expr(e.operand);
        if (!v.ty.startsWith("!milo.enum<")) throw new MlirUnsupported("`is` on a non-enum");
        const tag = this.def(`milo.enum.tag ${v.ref} : ${v.ty}`, "si32");
        const want = this.def(`milo.const ${e.tag} : si32`, "si32");
        return this.def(`milo.cmp eq, ${tag.ref}, ${want.ref} : si32`, "i1");
      }
      case "IfExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("if-expression without a value");
        const ty = this.value(e.type, "if-expression");
        const c = this.expr(e.cond);
        if (c.ty !== "i1") throw new MlirUnsupported("if condition type");
        const ref = this.fresh();
        this.region(`${ref} = milo.if ${c.ref} -> ${ty} {`, () => this.tail(e.thenBody, ty));
        this.region("} else {", () => this.tail(e.elseBody, ty));
        this.emit("}");
        return { ref, ty };
      }
      case "MatchExpr": {
        if (e.type.tag === "void" || e.type.tag === "never") throw new MlirUnsupported("match-expression without a value");
        return this.match(e, this.value(e.type, "match-expression")).v;
      }
      default:
        throw new MlirUnsupported(`expr ${e.kind}`);
    }
  }

  /** The index and value type of the struct field `e` reads. */
  private field(e: HIRExpr & { kind: "FieldAccess" }): { index: number; ty: string } {
    const st = stripRefs(e.object.type);
    if (st.tag !== "struct") throw new MlirUnsupported(`field of a ${st.tag}`);
    const index = this.cx.structLayouts.get(st.name)?.fields.findIndex(f => f.name === e.field) ?? -1;
    if (index < 0) throw new MlirUnsupported("unknown field");
    return { index, ty: this.value(e.type, "field") };
  }

  /** The slot `e` names (a `var`, a by-ref param, a field of either), or null for a value. */
  private fieldPlace(e: HIRExpr): { ref: string; ty: string; param?: number } | null {
    if (e.kind === "Ident") {
      const b = this.lookup(e.name);
      return b.kind === "var" ? { ref: b.ref, ty: b.ty, param: b.param } : null;
    }
    if (e.kind !== "FieldAccess") return null;
    const base = this.fieldPlace(e.object);
    if (!base) return null;
    const { index, ty } = this.field(e);
    const r = this.def(`milo.field_ref ${base.ref}[${index}] : !milo.ref<${base.ty}> -> !milo.ref<${ty}>`, `!milo.ref<${ty}>`);
    return { ref: r.ref, ty, param: base.param };
  }

  /**
   * `S { a: x, ..base }`: the listed fields in source order, then the base, as legacy
   * genStructLit evaluates them; the unlisted fields come out of the base.
   */
  private structLit(e: HIRExpr & { kind: "StructLit" }): Val {
    const ty = this.value(e.type, "struct literal");
    const layout = this.cx.structLayouts.get(e.name);
    if (!layout) throw new MlirUnsupported("struct layout");
    const given = new Map<string, Val>();
    for (const f of e.fields) given.set(f.name, this.expr(f.value));
    const base = e.base ? this.expr(e.base) : null;
    if (base && base.ty !== ty) throw new MlirUnsupported("struct update base of another type");
    const ops = layout.fields.map((f, i) => {
      const fty = this.value(f.typeKind, "field");
      const v = given.get(f.name) ?? (base ? this.def(`milo.struct.get ${base.ref}[${i}] : ${ty} -> ${fty}`, fty) : null);
      if (!v || v.ty !== fty) throw new MlirUnsupported("struct literal field");
      return v;
    });
    const operands = ops.length ? `${ops.map(o => o.ref).join(", ")} : ${ops.map(o => o.ty).join(", ")} ` : "";
    return this.def(`milo.struct.new ${operands}-> ${ty}`, ty);
  }

  /**
   * A value-producing block (if-expression and match arms): every statement but the last,
   * then the last one's value yielded. Always returns true: it ends in a yield or a jump.
   */
  private tail(body: HIRStmt[], ty: string): boolean {
    const last = body[body.length - 1];
    if (this.stmts(body.slice(0, -1))) return true;
    if (last?.kind !== "ExprStmt") {
      if (last && this.stmt(last)) return true;
      throw new MlirUnsupported("value block without a value");
    }
    const v = this.expr(last.expr);
    if (v.ty !== ty) throw new MlirUnsupported("block value of another type");
    this.emit(`milo.yield ${v.ref} : ${ty}`);
    return true;
  }

  /**
   * `match` as milo.match: one region per arm, the `_` arm last. A flat enum pattern's
   * bindings are its arm's block arguments (payload i is binding i); a literal pattern on
   * an int or bool is a case value. `resultTy` makes it an expression.
   */
  private match(m: { subject: HIRExpr; arms: (HIRStmt & { kind: "Match" })["arms"]; subjectIsMut?: boolean },
    resultTy: string | null): { done: boolean; v: Val } {
    // A `&mut` subject binds views that write the payload in place.
    if (m.subjectIsMut) throw new MlirUnsupported("match on a &mut subject");
    const subj = this.expr(m.subject);
    const isEnum = subj.ty.startsWith("!milo.enum<");
    const st = stripRefs(m.subject.type);
    const layout = isEnum && st.tag === "enum" ? this.cx.mlirEnumLayout(st.name) : null;
    if (isEnum && !layout) throw new MlirUnsupported("match subject layout");
    if (!isEnum && !/^([su]i\d+|i1)$/.test(subj.ty)) throw new MlirUnsupported(`match on ${subj.ty}`);
    const cases: bigint[] = [];
    const arms: { arm: typeof m.arms[0]; args: { name: string; ty: string }[] }[] = [];
    let dflt: typeof m.arms[0] | null = null;
    for (const arm of m.arms) {
      const p = arm.pattern;
      if (p.kind === "WildcardPattern") {
        if (dflt) throw new MlirUnsupported("two wildcard arms");
        dflt = arm;
        continue;
      }
      let c: bigint;
      let args: { name: string; ty: string }[] = [];
      if (p.kind === "EnumPattern") {
        if (!layout || p.tests) throw new MlirUnsupported("nested pattern");
        const v = layout.variants.find(x => x.tag === p.tag);
        if (!v || p.bindings.length > v.fields.length || p.bindings.some(b => b.escapes || b.path)) throw new MlirUnsupported("enum pattern");
        c = BigInt(p.tag);
        args = v.fields.map((f, k) => ({ name: p.bindings[k]?.name ?? "_", ty: this.value(f, "payload") }));
      } else {
        if (isEnum || !["int", "char", "bool"].includes(p.literalKind)) throw new MlirUnsupported(`${p.literalKind} pattern`);
        // As the i64 holding its bits: a u64 case above i64::MAX wraps, the switch reads it back at the width.
        c = BigInt.asIntN(64, typeof p.value === "boolean" ? BigInt(p.value ? 1 : 0) : BigInt(p.value));
      }
      if (cases.includes(c)) throw new MlirUnsupported("two arms for one case");
      cases.push(c);
      arms.push({ arm, args });
    }
    if (dflt) arms.push({ arm: dflt, args: [] });
    const ref = resultTy ? this.fresh() : "";
    const head = `${resultTy ? `${ref} = ` : ""}milo.match ${subj.ref} : ${subj.ty}${resultTy ? ` -> ${resultTy}` : ""} [${cases.join(", ")}]${dflt ? " default" : ""} {`;
    let allDone = true;
    arms.forEach(({ arm, args }, i) => {
      const done = this.region(i === 0 ? head : "}, {", () => {
        if (args.length) {
          const refs = args.map(() => this.fresh());
          this.emit(`^bb0(${args.map((a, k) => `${refs[k]}: ${a.ty}`).join(", ")}):`);
          // A binding is a mutable copy of the payload, as legacy bindPayloads makes it:
          // `c.bump()` in the arm changes the binding.
          args.forEach((a, k) => {
            if (a.name === "_") return;
            const slot = this.fresh();
            this.vars.push(`  ${slot} = milo.var ${quote(a.name)} : !milo.ref<${a.ty}>`);
            this.emit(`milo.store ${refs[k]}, ${slot} : !milo.ref<${a.ty}>`);
            this.bind(a.name, { kind: "var", ref: slot, ty: a.ty });
          });
        }
        return resultTy ? this.tail(arm.body, resultTy) : this.stmts(arm.body);
      });
      if (!done) allDone = false;
    });
    this.emit("}");
    // A match that is not exhaustive by its cases alone still is by the checker, so
    // arms that all jump leave nothing after them.
    if (!resultTy && allDone && arms.length) { this.emit("milo.unreachable"); return { done: true, v: { ref: "", ty: "" } }; }
    return { done: false, v: { ref, ty: resultTy ?? "" } };
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
   * `v[i]` on a by-ref Vec param: the Vec, its element type and the index as si64. Object
   * first, then the index, as legacy genVecBoundsCheckedPtr evaluates them; a narrower
   * index widens by its own signedness (legacy indexToI64), which milo.cast does.
   */
  private indexPlace(e: HIRExpr & { kind: "IndexAccess" }): { vec: string; elem: string; index: string } {
    const b = e.object.kind === "Ident" ? this.lookup(e.object.name) : null;
    if (b?.kind !== "vec") throw new MlirUnsupported("index into something other than a by-ref Vec param");
    const i = this.expr(e.index);
    if (!/^[su]i\d+$/.test(i.ty)) throw new MlirUnsupported("non-int index");
    const index = i.ty === "si64" ? i.ref : this.def(`milo.cast ${i.ref} : ${i.ty} to si64`, "si64").ref;
    return { vec: b.ref, elem: b.elem, index };
  }

  /**
   * The slot a by-ref argument borrows. A `var` or a by-ref param is its own slot; an
   * immutable value lent as `&T` gets a fresh one, as legacy codegen spills it.
   */
  private place(e: HIRExpr, refTy: string, mut: boolean): { ref: string; param?: number } {
    if (e.kind === "FieldAccess") {
      // A field of a slot is lent in place; the slot's param, if any, is where it points.
      const p = this.fieldPlace(e);
      if (!p || `!milo.ref<${p.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg of a field of a value");
      return { ref: p.ref, param: p.param };
    }
    if (e.kind !== "Ident") {
      // A value lent as `&T` (`f(Shape.Empty)`) gets a slot of its own, as legacy spills it.
      if (mut) throw new MlirUnsupported(`by-ref &mut arg ${e.kind}`);
      const v = this.expr(e);
      if (`!milo.ref<${v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
      const ref = this.fresh();
      this.vars.push(`  ${ref} = milo.var "arg" : ${refTy}`);
      this.emit(`milo.store ${v.ref}, ${ref} : ${refTy}`);
      return { ref };
    }
    const b = this.lookup(e.name);
    if (b.kind === "vec") {
      if (`!milo.vec<${b.elem}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
      return { ref: b.ref, param: b.param };
    }
    if (`!milo.ref<${b.kind === "var" ? b.ty : b.v.ty}>` !== refTy) throw new MlirUnsupported("by-ref arg type");
    if (b.kind === "var") return { ref: b.ref, param: b.param };
    // A spilled copy would take the callee's writes and drop them.
    if (mut) throw new MlirUnsupported("&mut of an immutable binding");
    const ref = this.fresh();
    this.vars.push(`  ${ref} = milo.var ${quote(e.name)} : ${refTy}`);
    this.emit(`milo.store ${b.v.ref}, ${ref} : ${refTy}`);
    return { ref };
  }

  /**
   * print/eprint: one milo.print of every part. An interpolated string is
   * `print(format(parts))`; printing the parts displays the same text without building the
   * string (format and print share legacy's int and float formatting).
   */
  private print(e: HIRExpr & { kind: "Call" }): Val {
    let args = e.args;
    const only = args.length === 1 ? args[0].expr : null;
    if (only?.kind === "Call" && only.func === "format" && this.cx.isBuiltinName("format")) args = only.args;
    const parts = args.map(a => {
      if (a.passByRef) throw new MlirUnsupported("by-ref print part");
      let t = a.expr.type;
      while (t.tag === "ref") t = t.inner;
      const v = this.expr(a.expr);
      // Scalar.cpp printKey spells the same names.
      const key = v.ty === STR ? "string" : v.ty === PTR ? "ptr"
        : t.tag === "struct" ? `S${t.name}` : t.tag === "enum" ? `E${t.name}` : v.ty;
      if (key !== "string" && valueType(this.cx, t) !== v.ty) throw new MlirUnsupported(`print part of type ${t.tag}`);
      return { v, key, type: t };
    });
    this.cx.mlirPrintHelper(e.func === "eprint", parts.map(p => ({ key: p.key, type: p.type })));
    const flag = e.func === "eprint" ? " stderr" : "";
    if (parts.length === 0) this.emit(`milo.print${flag}`);
    else this.emit(`milo.print${flag} ${parts.map(p => p.v.ref).join(", ")} : ${parts.map(p => p.v.ty).join(", ")}`);
    return { ref: "", ty: "" };
  }

  private call(e: HIRExpr & { kind: "Call" }, stmt: boolean): Val {
    if ((e.func === "print" || e.func === "eprint") && this.cx.isBuiltinName(e.func)) return this.print(e);
    if (e.variadic) throw new MlirUnsupported("variadic call");
    if (this.cx.isBuiltinName(e.func)) throw new MlirUnsupported(`builtin ${e.func}`);
    const callee = this.fns.get(e.func);
    const sig = this.cx.fnSigs.get(e.func);
    if (!callee || !sig || sig.variadic || this.cx.sretFns.has(e.func)) throw new MlirUnsupported("callee");
    // An extern's call goes to its C symbol; keep those on legacy codegen for now.
    if (callee.isExtern && callee.linkName && callee.linkName !== callee.name) throw new MlirUnsupported("callee link name");
    if (callee.params.length !== e.args.length) throw new MlirUnsupported("callee arity");
    const paramTys = callee.params.map((p, i) => {
      const byRef = p.isRef || p.isRefMut;
      if (byRef !== e.args[i].passByRef) throw new MlirUnsupported("by-ref arg mismatch");
      const elem = byRef ? vecElem(p.type) : null;
      const ty = elem ?? this.value(p.type, byRef ? "by-ref arg" : "call arg");
      if (sig.paramTypes[i] !== (byRef ? "ptr" : this.cx.llvmType(p.type))) throw new MlirUnsupported("callee signature");
      return elem !== null ? `!milo.vec<${elem}>` : byRef ? `!milo.ref<${ty}>` : ty;
    });
    const ret = callee.retType.tag === "void" ? null : this.value(callee.retType, "call result");
    if (ret !== null ? sig.retType !== this.cx.llvmType(callee.retType) : sig.retType !== "void") throw new MlirUnsupported("callee signature");
    if (ret === null && !stmt) throw new MlirUnsupported("void call as value");
    const refs: { ref: string; mut: boolean; ty: string }[] = [];
    const provenance: (number | null)[] = [];
    const args = e.args.map((a, i) => {
      if (a.passByRef) {
        const ref = this.place(a.expr, paramTys[i], a.refMut);
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
