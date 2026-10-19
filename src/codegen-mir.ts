// MIR -> LLVM text through the typed builder (docs/plans/codegen-ir-2026-10.md, phase 2).
//
// A MIR body replaces only the statement loop of genFunction: the prologue (parameter spill,
// main's argc/argv and global init, contracts) and every return's epilogue (ensures, drop glue)
// stay HIR codegen's, and so do opaque statements. Every local is a stack slot: a read is a
// load, an assignment a store, and LLVM's mem2reg turns the slots into SSA. The arithmetic goes
// through the same Codegen helpers HIR codegen uses, so a function lowered either way traps
// identically.

import type { TypeKind } from "./types";
import type { HIRExpr, HIRFunction, HIRStmt } from "./hir";
import { appendFileSync } from "fs";
import { lowerToMir, mirLocalName, Unsupported } from "./mir-build";
import type { Span } from "./ast";
import type { Gen, LocalInfo } from "./codegen";
import { LlvmTextBuilder, Ty, val, type Block, type NameSource, type Val } from "./ir";
import type { Binding, MirBody, Operand, Place } from "./mir";

// MILO_MIR=1 routes each function the MIR lowering supports through it; the rest take the HIR
// path. MILO_MIR_LOG=<file> appends one line per function: its name, "ok" or the reason it fell
// back, and for "ok" the count of MIR-lowered statements and terminators and the reason for
// each opaque one. scripts/mir-same.ts turns these into the coverage numbers.
export const MIR_MODE = process.env.MILO_MIR === "1";
const MIR_LOG = process.env.MILO_MIR_LOG;

// Codegen's matching members are public solely to satisfy this, they are not part of its external API.
export interface MirEmitCtx extends NameSource {
  emitDebug: boolean;
  trapOnOverflow: boolean;
  currentFnWrapping: boolean;
  sretFns: Set<string>;
  locals: Map<string, LocalInfo>;
  genStmt(stmt: HIRStmt): [string[], boolean];
  fnSigs: Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>;
  isBuiltinName(name: string): boolean;
  llvmType(t: TypeKind): string;
  formatFloatBits(v: number, llvmTy?: string): string;
  emitScalarBinOp(lines: string[], op: string, leftType: TypeKind, llt: string, lv: string, rv: string, span: Span | undefined): Gen;
  emitScalarUnOp(lines: string[], op: string, operandType: TypeKind, ot: string, ov: string, span: Span | undefined): Gen;
  emitScalarCast(lines: string[], fromKind: TypeKind, toKind: TypeKind, fromTy: string, toTy: string, ov: string): Gen;
}

/**
 * The MIR body for `fn`, or null to run HIR codegen's statement loop. -g builds are not
 * handled yet: opaque statements would carry locations and MIR's own instructions none.
 */
export function tryMirBody(cx: MirEmitCtx, fn: HIRFunction): MirBody | null {
  const mir = cx.emitDebug
    ? new Unsupported("debug info")
    : lowerToMir(fn, { checked: cx.trapOnOverflow && !cx.currentFnWrapping, calleeOk: (n, a, r) => calleeOk(cx, n, a, r) });
  if (MIR_LOG) {
    const detail = mir instanceof Unsupported ? mir.reason
      : `ok\t${mir.blocks.reduce((n, bb) => n + 1 + bb.stmts.filter(s => s.kind !== "opaque").length, 0)}\t${mir.opaqueReasons.join("|")}`;
    appendFileSync(MIR_LOG, `${fn.name}\t${detail}\n`);
  }
  return mir instanceof Unsupported ? null : mir;
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

/**
 * Emit `body` into `lines`, after genFunction's prologue and in place of its statement loop.
 * Every path ends in a terminator, so the caller adds no fall-off return.
 */
export function emitMirBody(cx: MirEmitCtx, body: MirBody, lines: string[]): void {
  const b = new LlvmTextBuilder(lines, cx);
  const tyOf = (t: TypeKind) => Ty.of(cx.llvmType(t));
  // A parameter lives in the `%name.addr` slot the prologue spilled it to; every other local
  // gets its own. `.` cannot appear in a Milo identifier, so `%mir.N` never collides.
  const slots: Val[] = body.locals.map(l => val(body.params.includes(l.id) ? `%${l.name}.addr` : `%${mirLocalName(l.id)}`, Ty.ptr));
  for (const l of body.locals) if (!body.params.includes(l.id)) b.alloca(tyOf(l.ty), slots[l.id].ref);

  // HIR codegen resolves a name through `cx.locals`. Before each opaque statement it is reset
  // to what the prologue registered, plus that statement's own view of the scope, so a name
  // MIR shadowed or let go out of scope resolves as it would in HIR codegen.
  const base = new Map(cx.locals);
  const opaqueLets = new Map<string, LocalInfo>();
  const enter = (scope: Binding[]) => {
    cx.locals.clear();
    for (const [k, v] of base) cx.locals.set(k, v);
    for (const bd of scope) {
      if ("local" in bd) {
        const l = body.locals[bd.local];
        cx.locals.set(bd.name, { type: cx.llvmType(l.ty), typeKind: l.ty, mutable: true, isRef: false, addr: slots[bd.local].ref });
      } else {
        const info = opaqueLets.get(`${bd.cg}:${bd.name}`);
        if (info) cx.locals.set(bd.name, info);
      }
    }
  };
  const hir = (stmt: HIRStmt, scope: Binding[]): boolean => {
    enter(scope);
    const [sl, terminated] = cx.genStmt(stmt);
    lines.push(...sl);
    return terminated;
  };

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
      if (s.kind === "opaque") {
        // A statement that diverges (a match whose arms all return) leaves the block ended;
        // whatever MIR placed after it is dead, so it goes in a fresh unreachable block.
        if (hir(s.hir, s.scope)) b.position(b.newBlock("mir.dead"));
        for (const name of s.names ?? []) {
          const info = cx.locals.get(name);
          if (!info) throw new Error(`mir ${body.name}: opaque ${s.hir.kind} did not bind ${name}`);
          opaqueLets.set(`${s.binds}:${name}`, info);
        }
        continue;
      }
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
      case "return": {
        // HIR codegen's own return, for ensures checks, drop glue and main's `ret i32 0`.
        const name = body.ret === null ? null : mirLocalName(body.ret);
        const value: HIRExpr | null = name === null ? null : { kind: "Ident", name, type: body.retTy };
        hir({ kind: "Return", value, retType: body.retTy }, name === null ? [] : [{ name, local: body.ret! }]);
        break;
      }
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
}
