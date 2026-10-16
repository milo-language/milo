// Typed IR builder: codegen describes instructions as typed values, and a backend prints them.
//
// `Builder` is the backend interface (the shape of rustc_codegen_ssa's BuilderMethods), so
// lowering written against it does not care whether the output is LLVM text, an in-process
// LLVM, or a fast debug backend. `LlvmTextBuilder` is the only backend today and prints
// EXACTLY the text the string-pushing codegen printed: migration is gated on byte-identical
// IR (scripts/ir-same.ts), so spacing, operand order and naming here are a compatibility
// contract, not style. See docs/plans/codegen-ir-2026-10.md, phase 1.
//
// The builder appends to a caller-owned `lines` array that unmigrated helpers also push to,
// and takes temp and label names from Codegen's own counters, so a migrated function can sit
// in the middle of string-emitting code and leave the numbering of everything around it
// unchanged.

import type { Gen } from "./codegen";

export type TyKind = "void" | "int" | "float" | "ptr" | "agg";
export interface Ty { readonly ll: string; readonly kind: TyKind; readonly bits?: number }

const intTys = new Map<number, Ty>();
export const Ty = {
  void: { ll: "void", kind: "void" } as Ty,
  ptr: { ll: "ptr", kind: "ptr" } as Ty,
  int(bits: number): Ty {
    let t = intTys.get(bits);
    if (!t) intTys.set(bits, t = { ll: `i${bits}`, kind: "int", bits });
    return t;
  },
  get i1(): Ty { return Ty.int(1); },
  get i8(): Ty { return Ty.int(8); },
  get i32(): Ty { return Ty.int(32); },
  get i64(): Ty { return Ty.int(64); },
  /** Classify a type string as Codegen.llvmType prints it. */
  of(ll: string): Ty {
    if (ll === "void") return Ty.void;
    if (ll === "ptr") return Ty.ptr;
    const m = /^i(\d+)$/.exec(ll);
    if (m) return Ty.int(Number(m[1]));
    if (ll === "half" || ll === "float" || ll === "double" || ll === "fp128") return { ll, kind: "float" };
    return { ll, kind: "agg" };
  },
};

/** A typed operand: a register (`%t.12`), global (`@g`), or constant (`42`, `null`, `undef`). */
export interface Val { readonly ref: string; readonly ty: Ty }
export function val(ref: string, ty: Ty): Val { return { ref, ty }; }

export interface Block { readonly name: string }

/** `attrs` prints verbatim between type and name, leading space included (` noalias`). */
export interface Param { readonly name: string; readonly ty: Ty; readonly attrs?: string }

export interface FnSig {
  /** Printed after `@` as given, so a name that needs quoting arrives quoted. */
  readonly name: string;
  readonly ret: Ty;
  readonly params: readonly Param[];
  readonly internal?: boolean;
  /** DISubprogram id. Printed before the `{`, which is where DwarfEmitter finds function boundaries. */
  readonly dbg?: number;
}

/** Codegen's name counters. Injected so builder-made names interleave with string-made ones. */
export interface NameSource {
  nextTemp(): string;
  nextLabel(prefix?: string): string;
  /**
   * The current function's entry-block preamble, which Codegen splices in after the body
   * is generated. Optional so a builder can exist outside a function body; `entryAlloca`
   * throws without it.
   */
  entryAllocas?: string[];
}

export type BinOp = "add" | "sub" | "mul" | "udiv" | "sdiv" | "urem" | "srem" | "and" | "or" | "xor" | "shl" | "lshr" | "ashr";
export type ICmpPred = "eq" | "ne" | "ult" | "ule" | "ugt" | "uge" | "slt" | "sle" | "sgt" | "sge";
export type FCmpPred = "oeq" | "one" | "olt" | "ole" | "ogt" | "oge";
export type CastOp = "zext" | "sext" | "trunc" | "ptrtoint" | "inttoptr" | "bitcast";

export interface Builder {
  /**
   * `define ... {` and the `entry.bb:` label; returns the params as values. Once per
   * builder: a builder's checks (reserved temps, the open function) are per function.
   */
  defineFn(sig: FnSig): Val[];
  /** The closing `}`. Fails unless the last block ends in a terminator. */
  endFn(): void;
  // Inline at the current position, as today's codegen emits it; hoisting to the entry
  // block would change the text, so it waits for a commit that is allowed to.
  alloca(ty: Ty): Val;
  /**
   * Inline alloca with a caller-chosen slot name (`%x.3.addr`) instead of a temp, for locals
   * that other code addresses by name. Draws no temp. The name must be a named local.
   */
  alloca(ty: Ty, name: string): Val;
  /**
   * A named stack slot in the function's entry block, the form codegen uses for locals
   * and loop state so LLVM folds them into the fixed frame. `init`, if given, is stored
   * there too, so the slot holds it before any body code runs.
   */
  entryAlloca(name: string, ty: Ty, init?: Val): Val;
  /** `align`, if given, prints as a trailing `, align N`. */
  load(ty: Ty, ptr: Val, align?: number): Val;
  /** `load atomic T, ptr P acquire, align N`: reads a refcount that another thread may release. */
  loadAcquire(ty: Ty, ptr: Val, align: number): Val;
  store(v: Val, ptr: Val): void;
  gep(base: Ty, ptr: Val, idx: Val[]): Val;
  binop(op: BinOp, a: Val, b: Val): Val;
  /** `dest`, if given, is a `reserveTemp` name to define (see `select`). */
  icmp(pred: ICmpPred, a: Val, b: Val, dest?: Val): Val;
  fcmp(pred: FCmpPred, a: Val, b: Val, dest?: Val): Val;
  cast(op: CastOp, v: Val, to: Ty): Val;
  /** The builder knows no aggregate layouts, so the caller names the element type. */
  extractvalue(agg: Val, idx: number, elt: Ty): Val;
  insertvalue(agg: Val, elt: Val, idx: number): Val;
  /** `padded` prints `[ v, %b ]`, the spelling a few older sites used; same IR to LLVM. */
  phi(ty: Ty, incoming: [Val, Block][], padded?: boolean): Val;
  select(cond: Val, a: Val, b: Val, dest?: Val): Val;
  /**
   * Draw a temp name now and define it later with `select(..., dest)`. Exists only because
   * old string codegen drew a result temp before the temps of the operands that feed it,
   * and temp numbering is part of the byte-identical contract.
   */
  reserveTemp(ty: Ty): Val;
  /** A call whose result is used; `ret` must not be void. */
  call(ret: Ty, callee: string, args: Val[]): Val;
  /** A call printed with no result name: void, or a result nobody reads. */
  callDiscard(ret: Ty, callee: string, args: Val[]): void;
  newBlock(prefix: string): Block;
  /** Start emitting into `b` (prints its label). */
  position(b: Block): void;
  br(dest: Block): void;
  condBr(cond: Val, t: Block, f: Block): void;
  unreachable(): void;
  /**
   * `switch T v, label %dflt [ T c, label %b ... ]`. `multiline` puts each case on its own
   * line and the `]` on the next, the spelling the drop/clone helpers used.
   */
  switch(v: Val, dflt: Block, cases: [number | bigint, Block][], multiline?: boolean): void;
  /** `ret void` with no operand, else `ret T v`. */
  ret(v?: Val): void;
  /** Escape hatch for text the builder cannot express yet. Bypasses every check. */
  raw(line: string): void;
}

// Terminators as they open a line, plus the `]` that closes a multi-line switch.
const TERMINATOR = /^\s+(br|ret|switch|unreachable|resume|indirectbr)\b|^\s+\]$/;

export class LlvmTextBuilder implements Builder {
  // Temps drawn by reserveTemp and not yet defined. Per builder, and a builder lives for one
  // function body, so a reservation cannot leak into another function.
  private readonly reserved = new Set<string>();
  private fn: "none" | "open" | "closed" = "none";

  constructor(readonly lines: string[], private readonly names: NameSource) {}

  defineFn(sig: FnSig): Val[] {
    if (this.fn !== "none") this.fail(`defineFn @${sig.name}: this builder already ${this.fn === "open" ? "has an open function" : "closed its function"}`);
    const seen = new Set<string>();
    for (const p of sig.params) {
      if (p.ty.kind === "void") this.fail(`defineFn @${sig.name}: param %${p.name} is void`);
      if (seen.has(p.name)) this.fail(`defineFn @${sig.name}: param %${p.name} appears twice`);
      seen.add(p.name);
    }
    this.fn = "open";
    const params = sig.params.map(p => `${p.ty.ll}${p.attrs ?? ""} %${p.name}`).join(", ");
    const dbg = sig.dbg === undefined ? "" : ` !dbg !${sig.dbg}`;
    this.lines.push(`define ${sig.internal ? "internal " : ""}${sig.ret.ll} @${sig.name}(${params})${dbg} {`);
    // Dotted, not bare `entry`: block labels and values share one LLVM namespace, params
    // print as `%<name>`, and `.` cannot appear in a Milo identifier.
    this.lines.push("entry.bb:");
    return sig.params.map(p => ({ ref: `%${p.name}`, ty: p.ty }));
  }

  endFn(): void {
    if (this.fn !== "open") this.fail("endFn with no open function");
    // llc would reject an unterminated block too, but far from the codegen that left it.
    const last = this.lastInstruction();
    if (last === undefined || !TERMINATOR.test(last)) this.fail(`endFn: last block does not end in a terminator (last line '${last?.trim()}')`);
    this.fn = "closed";
    this.lines.push("}");
  }

  alloca(ty: Ty, name?: string): Val {
    if (ty.kind === "void") this.fail("alloca of void");
    if (name === undefined) return this.def(`alloca ${ty.ll}`, Ty.ptr);
    if (!/^%[A-Za-z_.$][\w.$-]*$/.test(name) || /^%t\.\d+$/.test(name)) this.fail(`alloca name ${name} is not a named local`);
    this.emit(`${name} = alloca ${ty.ll}`);
    return { ref: name, ty: Ty.ptr };
  }

  entryAlloca(name: string, ty: Ty, init?: Val): Val {
    const entry = this.names.entryAllocas;
    if (!entry) this.fail(`entryAlloca ${name} with no function entry block`);
    if (ty.kind === "void") this.fail(`entryAlloca ${name} of void`);
    // Named, never a temp: a numbered temp defined in the entry block would break the
    // body's numbering order, which LLVM requires to be ascending.
    if (!/^%[A-Za-z_.$][\w.$-]*$/.test(name) || /^%t\.\d+$/.test(name)) this.fail(`entryAlloca name ${name} is not a named local`);
    const def = `  ${name} = alloca `;
    // LLVM rejects a redefinition only at llc time, far from the codegen that caused it.
    if (entry.some(l => l.startsWith(def))) this.fail(`entryAlloca ${name} already defined in this function`);
    if (init && init.ty.ll !== ty.ll) this.fail(`entryAlloca ${name} (${ty.ll}) initialized with ${init.ref} (${init.ty.ll})`);
    entry.push(`${def}${ty.ll}`);
    if (init) entry.push(`  store ${init.ty.ll} ${init.ref}, ptr ${name}`);
    return { ref: name, ty: Ty.ptr };
  }

  load(ty: Ty, ptr: Val, align?: number): Val {
    if (ty.kind === "void") this.fail("load of void");
    this.wantPtr("load", ptr);
    if (align !== undefined) this.wantAlign("load", align);
    return this.def(`load ${ty.ll}, ptr ${ptr.ref}${align === undefined ? "" : `, align ${align}`}`, ty);
  }

  loadAcquire(ty: Ty, ptr: Val, align: number): Val {
    // LLVM allows atomic loads of integers, pointers and floats, not of aggregates.
    if (ty.kind === "void" || ty.kind === "agg") this.fail(`atomic load of ${ty.ll}`);
    this.wantPtr("atomic load", ptr);
    this.wantAlign("atomic load", align);
    return this.def(`load atomic ${ty.ll}, ptr ${ptr.ref} acquire, align ${align}`, ty);
  }

  store(v: Val, ptr: Val): void {
    if (v.ty.kind === "void") this.fail(`store of void value ${v.ref}`);
    this.wantPtr("store", ptr);
    this.emit(`store ${v.ty.ll} ${v.ref}, ptr ${ptr.ref}`);
  }

  gep(base: Ty, ptr: Val, idx: Val[]): Val {
    if (base.kind === "void") this.fail("getelementptr over void");
    this.wantPtr("getelementptr", ptr);
    for (const i of idx) if (i.ty.kind !== "int") this.fail(`getelementptr index ${i.ref} is ${i.ty.ll}, not an integer`);
    return this.def(`getelementptr ${base.ll}, ptr ${ptr.ref}, ${idx.map(i => `${i.ty.ll} ${i.ref}`).join(", ")}`, Ty.ptr);
  }

  binop(op: BinOp, a: Val, b: Val): Val {
    this.sameTy(op, a, b);
    return this.def(`${op} ${a.ty.ll} ${a.ref}, ${b.ref}`, a.ty);
  }

  icmp(pred: ICmpPred, a: Val, b: Val, dest?: Val): Val {
    this.sameTy(`icmp ${pred}`, a, b);
    return this.defOrDest(`icmp ${pred} ${a.ty.ll} ${a.ref}, ${b.ref}`, Ty.i1, dest);
  }

  fcmp(pred: FCmpPred, a: Val, b: Val, dest?: Val): Val {
    this.sameTy(`fcmp ${pred}`, a, b);
    if (a.ty.kind !== "float") this.fail(`fcmp ${pred} on non-float ${a.ref} (${a.ty.ll})`);
    return this.defOrDest(`fcmp ${pred} ${a.ty.ll} ${a.ref}, ${b.ref}`, Ty.i1, dest);
  }

  cast(op: CastOp, v: Val, to: Ty): Val {
    if (v.ty.kind === "void" || to.kind === "void") this.fail(`${op} involving void`);
    return this.def(`${op} ${v.ty.ll} ${v.ref} to ${to.ll}`, to);
  }

  extractvalue(agg: Val, idx: number, elt: Ty): Val {
    if (agg.ty.kind !== "agg") this.fail(`extractvalue from non-aggregate ${agg.ty.ll}`);
    return this.def(`extractvalue ${agg.ty.ll} ${agg.ref}, ${idx}`, elt);
  }

  insertvalue(agg: Val, elt: Val, idx: number): Val {
    if (agg.ty.kind !== "agg") this.fail(`insertvalue into non-aggregate ${agg.ty.ll}`);
    return this.def(`insertvalue ${agg.ty.ll} ${agg.ref}, ${elt.ty.ll} ${elt.ref}, ${idx}`, agg.ty);
  }

  phi(ty: Ty, incoming: [Val, Block][], padded = false): Val {
    if (ty.kind === "void") this.fail("phi of void");
    for (const [v] of incoming) if (v.ty.ll !== ty.ll) this.fail(`phi ${ty.ll} incoming ${v.ref} is ${v.ty.ll}`);
    const pad = padded ? " " : "";
    return this.def(`phi ${ty.ll} ${incoming.map(([v, b]) => `[${pad}${v.ref}, %${b.name}${pad}]`).join(", ")}`, ty);
  }

  select(cond: Val, a: Val, b: Val, dest?: Val): Val {
    if (cond.ty.ll !== "i1") this.fail(`select condition ${cond.ref} is ${cond.ty.ll}, not i1`);
    this.sameTy("select", a, b);
    if (a.ty.kind === "void") this.fail("select of void");
    const text = `select i1 ${cond.ref}, ${a.ty.ll} ${a.ref}, ${b.ty.ll} ${b.ref}`;
    if (!dest) return this.def(text, a.ty);
    if (!this.reserved.has(dest.ref)) this.fail(`select into ${dest.ref}, which is not a reserved temp`);
    if (dest.ty.ll !== a.ty.ll) this.fail(`select into ${dest.ref} (${dest.ty.ll}) but operands are ${a.ty.ll}`);
    this.reserved.delete(dest.ref);
    this.emit(`${dest.ref} = ${text}`);
    return dest;
  }

  reserveTemp(ty: Ty): Val {
    if (ty.kind === "void") this.fail("reserveTemp of void");
    const ref = this.names.nextTemp();
    this.reserved.add(ref);
    return { ref, ty };
  }

  call(ret: Ty, callee: string, args: Val[]): Val {
    if (ret.kind === "void") this.fail(`call ${callee} returns void; use callDiscard`);
    return this.def(callText(ret, callee, args), ret);
  }

  callDiscard(ret: Ty, callee: string, args: Val[]): void {
    this.emit(callText(ret, callee, args));
  }

  newBlock(prefix: string): Block {
    return { name: this.names.nextLabel(prefix) };
  }

  position(b: Block): void {
    this.lines.push(`${b.name}:`);
  }

  br(dest: Block): void {
    this.emit(`br label %${dest.name}`);
  }

  condBr(cond: Val, t: Block, f: Block): void {
    if (cond.ty.ll !== "i1") this.fail(`br condition ${cond.ref} is ${cond.ty.ll}, not i1`);
    this.emit(`br i1 ${cond.ref}, label %${t.name}, label %${f.name}`);
  }

  unreachable(): void {
    this.emit("unreachable");
  }

  switch(v: Val, dflt: Block, cases: [number | bigint, Block][], multiline = false): void {
    if (v.ty.kind !== "int") this.fail(`switch on non-integer ${v.ref} (${v.ty.ll})`);
    // LLVM rejects a duplicate case value, but only at llc time, far from the codegen at fault.
    // bigint for values past 2^53, which a number would round. Keyed by decimal text so 1
    // and 1n count as the same case.
    const seen = new Set<string>();
    for (const [c] of cases) {
      if (typeof c === "number" && !Number.isInteger(c)) this.fail(`switch case ${c} is not an integer`);
      if (seen.has(String(c))) this.fail(`switch case ${c} appears twice`);
      seen.add(String(c));
    }
    const head = `switch ${v.ty.ll} ${v.ref}, label %${dflt.name} [`;
    const arms = cases.map(([c, b]) => `${v.ty.ll} ${c}, label %${b.name}`);
    if (!multiline) { this.emit(`${head}${arms.join(" ")}]`); return; }
    this.emit(head);
    // Continuation lines of one instruction: pushed raw, since emit() would see the `[`
    // line as a terminator already ended.
    for (const a of arms) this.lines.push(`    ${a}`);
    this.lines.push("  ]");
  }

  ret(v?: Val): void {
    if (v === undefined) { this.emit("ret void"); return; }
    if (v.ty.kind === "void") this.fail(`ret of void value ${v.ref}; use ret()`);
    this.emit(`ret ${v.ty.ll} ${v.ref}`);
  }

  raw(line: string): void {
    this.lines.push(line);
  }

  // The temp is drawn before the line is checked and pushed, matching the order the
  // string code used (`const t = nextTemp(); lines.push(...)`).
  private def(rhs: string, ty: Ty): Val {
    const ref = this.names.nextTemp();
    this.emit(`${ref} = ${rhs}`);
    return { ref, ty };
  }

  // Like def, but into a reserveTemp name when `dest` is given (same checks as select).
  private defOrDest(rhs: string, ty: Ty, dest?: Val): Val {
    if (!dest) return this.def(rhs, ty);
    if (!this.reserved.has(dest.ref)) this.fail(`${rhs.split(" ")[0]} into ${dest.ref}, which is not a reserved temp`);
    if (dest.ty.ll !== ty.ll) this.fail(`${rhs.split(" ")[0]} into ${dest.ref} (${dest.ty.ll}) but the result is ${ty.ll}`);
    this.reserved.delete(dest.ref);
    this.emit(`${dest.ref} = ${rhs}`);
    return dest;
  }

  private emit(inst: string): void {
    // Read from the text, not tracked in a flag: unmigrated helpers push labels and
    // branches into the same array, so only the array knows where the block ends.
    const last = this.lastInstruction();
    if (last !== undefined && TERMINATOR.test(last)) this.fail(`'${inst.trim()}' appended after terminator '${last.trim()}' with no label between`);
    this.lines.push(`  ${inst}`);
  }

  private lastInstruction(): string | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      const t = l.trim();
      if (t === "" || t.startsWith(";")) continue;
      return l;
    }
    return undefined;
  }

  private wantPtr(what: string, p: Val): void {
    if (p.ty.kind !== "ptr") this.fail(`${what} through non-pointer ${p.ref} (${p.ty.ll})`);
  }

  private wantAlign(what: string, align: number): void {
    if (!Number.isInteger(align) || align <= 0 || (align & (align - 1)) !== 0) this.fail(`${what} align ${align} is not a power of two`);
  }

  private sameTy(what: string, a: Val, b: Val): void {
    if (a.ty.ll !== b.ty.ll) this.fail(`${what} operand types differ: ${a.ref} is ${a.ty.ll}, ${b.ref} is ${b.ty.ll}`);
  }

  private fail(msg: string): never {
    throw new Error(`ir: ${msg}`);
  }
}

function callText(ret: Ty, callee: string, args: Val[]): string {
  return `call ${ret.ll} ${callee}(${args.map(a => `${a.ty.ll} ${a.ref}`).join(", ")})`;
}

/** Shim for unmigrated callers that still expect the `Gen` tuple. */
export function asGen(lines: string[], v: Val): Gen {
  return [lines, v.ref, v.ty.ll];
}
