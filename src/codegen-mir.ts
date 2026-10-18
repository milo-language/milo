// MIR -> LLVM text through the typed builder (docs/plans/codegen-ir-2026-10.md, phase 2).
//
// Every local is an entry-block stack slot: a read is a load, an assignment a store, and
// LLVM's mem2reg turns the slots into SSA. The arithmetic itself goes through the same
// Codegen helpers HIR codegen uses, so a function lowered either way traps identically.

import type { TypeKind } from "./types";
import type { HIRFunction } from "./hir";
import { appendFileSync } from "fs";
import { lowerToMir, Unsupported } from "./mir-build";
import type { Span } from "./ast";
import type { Gen } from "./codegen";
import { LlvmTextBuilder, Ty, val, type Block, type NameSource, type Val } from "./ir";
import type { MirBody, Operand, Place } from "./mir";

// MILO_MIR=1 routes each function the MIR lowering supports through it; the rest take the HIR
// path. MILO_MIR_LOG=<file> appends one line per function, "ok" or the reason it fell back,
// which is where scripts/mir-same.ts gets the coverage number.
export const MIR_MODE = process.env.MILO_MIR === "1";
const MIR_LOG = process.env.MILO_MIR_LOG;

// Codegen's matching members are public solely to satisfy this, they are not part of its external API.
export interface MirEmitCtx extends NameSource {
  emitDebug: boolean;
  trapOnOverflow: boolean;
  currentFnWrapping: boolean;
  sretFns: Set<string>;
  exportedFnNames: Set<string>;
  fnSigs: Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>;
  isBuiltinName(name: string): boolean;
  llvmType(t: TypeKind): string;
  formatFloatBits(v: number, llvmTy?: string): string;
  emitScalarBinOp(lines: string[], op: string, leftType: TypeKind, llt: string, lv: string, rv: string, span: Span | undefined): Gen;
  emitScalarUnOp(lines: string[], op: string, operandType: TypeKind, ot: string, ov: string, span: Span | undefined): Gen;
  emitScalarCast(lines: string[], fromKind: TypeKind, toKind: TypeKind, fromTy: string, toTy: string, ov: string): Gen;
}

/**
 * `fn` through MIR, or null to take the HIR path. main (argc/argv, global init, the green
 * wrapper), sret returns and -g builds are not handled by the MIR emitter yet.
 */
export function tryMir(cx: MirEmitCtx, fn: HIRFunction): string[] | null {
  let mir: ReturnType<typeof lowerToMir>;
  if (fn.name === "main") mir = new Unsupported("main");
  else if (cx.emitDebug) mir = new Unsupported("debug info");
  else if (cx.sretFns.has(fn.name)) mir = new Unsupported("sret return");
  else mir = lowerToMir(fn, { checked: cx.trapOnOverflow && !cx.currentFnWrapping, calleeOk: (n, a, r) => calleeOk(cx, n, a, r) });
  if (MIR_LOG) appendFileSync(MIR_LOG, `${fn.name}\t${mir instanceof Unsupported ? mir.reason : "ok"}\n`);
  if (mir instanceof Unsupported) return null;
  return emitMirFn(cx, mir, !cx.exportedFnNames.has(fn.name));
}

// A call MIR can emit as a bare `call`: a declared, non-builtin, non-variadic, non-sret
// function whose LLVM signature is exactly the argument and result types.
function calleeOk(cx: MirEmitCtx, name: string, argTypes: TypeKind[], retType: TypeKind): boolean {
  if (cx.isBuiltinName(name)) return false;
  const sig = cx.fnSigs.get(name);
  if (!sig || sig.variadic || cx.sretFns.has(name) || sig.paramTypes.length !== argTypes.length) return false;
  if (sig.retType !== cx.llvmType(retType)) return false;
  return argTypes.every((t, i) => sig.paramTypes[i] === cx.llvmType(t));
}

/** The function's full text, `define` through `}`. `internal` as genFunction decides it. */
export function emitMirFn(cx: MirEmitCtx, body: MirBody, internal: boolean): string[] {
  const lines: string[] = [];
  const b = new LlvmTextBuilder(lines, cx);
  const tyOf = (t: TypeKind) => Ty.of(cx.llvmType(t));
  // `.` cannot appear in a Milo identifier, so these never collide with a parameter's `%name`.
  const slots: Val[] = body.locals.map(l => val(`%mir.${l.id}`, Ty.ptr));
  const params = b.defineFn({
    name: body.name,
    ret: tyOf(body.retTy),
    params: body.params.map(id => ({ name: body.locals[id].name!, ty: tyOf(body.locals[id].ty) })),
    internal,
  });
  for (const l of body.locals) b.alloca(tyOf(l.ty), slots[l.id].ref);
  body.params.forEach((id, i) => b.store(params[i], slots[id]));

  const read = (o: Operand): Val => {
    if (o.kind === "const") {
      const c = o.value;
      if (c.kind === "bool") return val(c.value ? "1" : "0", Ty.i1);
      const ty = tyOf(c.ty);
      return val(c.kind === "int" ? c.value.toString() : cx.formatFloatBits(c.value, ty.ll), ty);
    }
    return b.load(tyOf(body.locals[o.place.local].ty), slots[o.place.local]);
  };
  const write = (p: Place, v: Val) => b.store(v, slots[p.local]);

  // bb0 continues the entry block; every other block gets a label, drawn up front so the
  // numbering follows block order.
  const labels: (Block | null)[] = body.blocks.map(bb => bb.id === 0 ? null : b.newBlock("mir"));
  const target = (id: number): Block => {
    const l = labels[id];
    if (!l) throw new Error(`mir ${body.name}: jump back into the entry block`);
    return l;
  };

  for (const bb of body.blocks) {
    if (bb.id !== 0) b.position(labels[bb.id]!);
    for (const s of bb.stmts) {
      const r = s.rvalue;
      const destTy = tyOf(body.locals[s.place.local].ty);
      let out: Val;
      if (r.kind === "use") out = read(r.op);
      else if (r.kind === "binop") {
        const l = read(r.left), rr = read(r.right);
        out = val(cx.emitScalarBinOp(lines, r.op, r.ty, l.ty.ll, l.ref, rr.ref, r.span)[1], destTy);
      } else if (r.kind === "unop") {
        const o = read(r.operand);
        out = val(cx.emitScalarUnOp(lines, r.op, r.ty, o.ty.ll, o.ref, r.span)[1], destTy);
      } else {
        const o = read(r.operand);
        out = val(cx.emitScalarCast(lines, r.from, r.to, o.ty.ll, destTy.ll, o.ref)[1], destTy);
      }
      write(s.place, out);
    }
    const t = bb.term!;
    switch (t.kind) {
      case "goto": b.br(target(t.target)); break;
      case "if": b.condBr(read(t.cond), target(t.then), target(t.else)); break;
      case "return":
        if (body.ret === null) b.ret();
        else b.ret(read({ kind: "copy", place: { local: body.ret } }));
        break;
      case "unreachable":
        // A trap rather than bare `unreachable`, as genFunction does: a shape the checker
        // misses aborts instead of running past the end of the function.
        b.callDiscard(Ty.void, "@llvm.trap", []);
        b.unreachable();
        break;
      case "call": {
        const args = t.args.map(read);
        if (t.dest) write(t.dest, b.call(tyOf(t.retTy), `@${t.fn}`, args));
        else b.callDiscard(tyOf(t.retTy), `@${t.fn}`, args);
        b.br(target(t.next));
        break;
      }
    }
  }
  b.endFn();
  return lines;
}
