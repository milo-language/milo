// MIR: a control-flow-graph IR between HIR and the LLVM builder (docs/plans/codegen-ir-2026-10.md,
// phase 2). A function is a list of locals plus basic blocks of statements, each block ending
// in exactly one terminator.
//
// Not SSA: every intermediate value is a named local that is assigned, and LLVM's mem2reg
// builds SSA from the stack slots. That keeps lowering simple and lets drop elaboration ask
// one question ("is this local initialized here?") instead of classifying HIR shapes.
//
// Every value-producing HIR expression lowers to an assignment into a fresh local, so a
// void-typed result is simply no local at all (the `alloca void` class of bug cannot be
// written).

import type { TypeKind } from "./types";
import type { Span } from "./ast";
import type { HIRStmt } from "./hir";

export type LocalId = number;
export type BlockId = number;

export interface Local {
  id: LocalId;
  ty: TypeKind;
  /** Source name for a user binding or parameter; temporaries have none. */
  name?: string;
  mutable: boolean;
  span?: Span;
}

/** A memory location. Projections land as later node groups need them. */
export interface Place { local: LocalId }

export type Const =
  | { kind: "int"; value: bigint; ty: TypeKind }
  | { kind: "float"; value: number; ty: TypeKind }
  | { kind: "bool"; value: boolean };

export type Operand =
  | { kind: "copy"; place: Place }
  | { kind: "move"; place: Place }
  | { kind: "const"; value: Const };

/** Integer and float arithmetic, comparisons and bitwise ops, as the source spells them. */
export type MirBinOp = "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>" | "==" | "!=" | "<" | "<=" | ">" | ">=";
export type MirUnOp = "-" | "!" | "~";

export type Rvalue =
  | { kind: "use"; op: Operand }
  // `checked`: the op traps on overflow (milo's default); false under @wrapping or
  // --no-overflow-checks, where it wraps. Division and shifts check their own preconditions.
  | { kind: "binop"; op: MirBinOp; left: Operand; right: Operand; ty: TypeKind; checked: boolean; span?: Span }
  | { kind: "unop"; op: MirUnOp; operand: Operand; ty: TypeKind; checked: boolean; span?: Span }
  | { kind: "cast"; operand: Operand; from: TypeKind; to: TypeKind; span?: Span };

/**
 * A name an opaque statement can see: a MIR local, or a local that an earlier opaque `let`
 * declared (`cg` is that statement's `binds` key; HIR codegen owns its slot and drop).
 */
export type Binding = { name: string; local: LocalId } | { name: string; cg: number };

export type Stmt =
  | { kind: "assign"; place: Place; rvalue: Rvalue; span?: Span }
  // A HIR statement MIR does not lower yet, emitted in place by HIR codegen. `scope` is every
  // binding visible to it; `binds` keys the `names` it binds for the statements after it.
  | { kind: "opaque"; hir: HIRStmt; scope: Binding[]; binds?: number; names?: string[]; span?: Span };

export type Term =
  | { kind: "goto"; target: BlockId }
  | { kind: "if"; cond: Operand; then: BlockId; else: BlockId }
  | { kind: "return" }
  // `dest` is null for a call whose result is void or unused.
  | { kind: "call"; fn: string; args: Operand[]; dest: Place | null; retTy: TypeKind; next: BlockId; span?: Span }
  | { kind: "unreachable" };

export interface BasicBlock {
  id: BlockId;
  stmts: Stmt[];
  /** Null only while the builder is still filling the block. */
  term: Term | null;
}

export interface MirBody {
  name: string;
  /** Parameter locals, in signature order; also listed in `locals`. */
  params: LocalId[];
  /** The return slot, or null for a void function. Written before each `return`. */
  ret: LocalId | null;
  retTy: TypeKind;
  locals: Local[];
  blocks: BasicBlock[];
  /** Why each opaque statement is opaque: the coverage report's to-do list. */
  opaqueReasons: string[];
}

// ── Construction ──

export interface Mark { cur: BlockId; stmts: number; blocks: number; locals: number }

export class MirBuilder {
  readonly body: MirBody;
  cur: BlockId;

  constructor(name: string, retTy: TypeKind) {
    this.body = { name, params: [], ret: null, retTy, locals: [], blocks: [], opaqueReasons: [] };
    this.cur = this.newBlock();
  }

  local(ty: TypeKind, name?: string, mutable = false, span?: Span): LocalId {
    if (ty.tag === "void" || ty.tag === "never") throw new Error(`mir: local of type ${ty.tag}`);
    const id = this.body.locals.length;
    this.body.locals.push({ id, ty, name, mutable, span });
    return id;
  }

  newBlock(): BlockId {
    const id = this.body.blocks.length;
    this.body.blocks.push({ id, stmts: [], term: null });
    return id;
  }

  /** True when the current block already ended (after return/break/continue); code here is dead. */
  get terminated(): boolean { return this.body.blocks[this.cur].term !== null; }

  assign(place: Place, rvalue: Rvalue, span?: Span): void {
    this.push({ kind: "assign", place, rvalue, span });
  }

  push(stmt: Stmt): void {
    const b = this.body.blocks[this.cur];
    if (b.term) throw new Error(`mir: ${stmt.kind} after terminator in bb${b.id}`);
    b.stmts.push(stmt);
  }

  /** A point to roll back to when lowering a statement or expression turns out unsupported. */
  mark(): Mark {
    const b = this.body.blocks[this.cur];
    return { cur: this.cur, stmts: b.stmts.length, blocks: this.body.blocks.length, locals: this.body.locals.length };
  }

  /** Undo everything since `m`: lowering only appends blocks and locals and ends the current block. */
  rollback(m: Mark): void {
    this.body.blocks.length = m.blocks;
    this.body.locals.length = m.locals;
    this.cur = m.cur;
    const b = this.body.blocks[m.cur];
    b.stmts.length = m.stmts;
    b.term = null;
  }

  terminate(term: Term): void {
    const b = this.body.blocks[this.cur];
    if (b.term) throw new Error(`mir: second terminator in bb${b.id}`);
    b.term = term;
  }

  switchTo(id: BlockId): void { this.cur = id; }
}

// ── Checks ──

/** Structural invariants; throws naming the first violation. Run after every lowering. */
export function validateMir(body: MirBody): void {
  const nLocals = body.locals.length, nBlocks = body.blocks.length;
  const where = (b: BasicBlock) => `${body.name} bb${b.id}`;
  const place = (p: Place, b: BasicBlock) => {
    if (p.local < 0 || p.local >= nLocals) throw new Error(`mir ${where(b)}: unknown local _${p.local}`);
  };
  const operand = (o: Operand, b: BasicBlock) => { if (o.kind !== "const") place(o.place, b); };
  const target = (t: BlockId, b: BasicBlock) => {
    if (t < 0 || t >= nBlocks) throw new Error(`mir ${where(b)}: jump to unknown bb${t}`);
  };
  for (const b of body.blocks) {
    if (!b.term) throw new Error(`mir ${where(b)}: block has no terminator`);
    for (const s of b.stmts) {
      if (s.kind === "opaque") {
        for (const bd of s.scope) if ("local" in bd && (bd.local < 0 || bd.local >= nLocals)) throw new Error(`mir ${where(b)}: opaque sees unknown local _${bd.local}`);
        continue;
      }
      place(s.place, b);
      const r = s.rvalue;
      if (r.kind === "use") operand(r.op, b);
      else if (r.kind === "binop") { operand(r.left, b); operand(r.right, b); }
      else operand(r.operand, b);
    }
    const t = b.term;
    if (t.kind === "goto") target(t.target, b);
    else if (t.kind === "if") { operand(t.cond, b); target(t.then, b); target(t.else, b); }
    else if (t.kind === "call") { t.args.forEach(a => operand(a, b)); if (t.dest) place(t.dest, b); target(t.next, b); }
  }
}

// ── Printing (debug dump, `milo emit-mir`) ──

function tyStr(t: TypeKind): string {
  switch (t.tag) {
    case "int": return `${t.signed ? "i" : "u"}${t.bits}`;
    case "float": return `f${t.bits}`;
    default: return t.tag;
  }
}

function opStr(o: Operand): string {
  if (o.kind === "const") {
    const c = o.value;
    return c.kind === "bool" ? `const ${c.value}` : `const ${c.value}_${tyStr(c.ty)}`;
  }
  return `${o.kind} _${o.place.local}`;
}

export function printMir(body: MirBody): string {
  const out: string[] = [];
  const params = body.params.map(p => `_${p}: ${tyStr(body.locals[p].ty)}`).join(", ");
  out.push(`fn ${body.name}(${params}) -> ${tyStr(body.retTy)} {`);
  for (const l of body.locals) {
    if (body.params.includes(l.id)) continue;
    const tag = l.id === body.ret ? " // return" : l.name ? ` // ${l.name}` : "";
    out.push(`  let ${l.mutable ? "mut " : ""}_${l.id}: ${tyStr(l.ty)};${tag}`);
  }
  for (const b of body.blocks) {
    out.push(`  bb${b.id}: {`);
    for (const s of b.stmts) {
      if (s.kind === "opaque") {
        out.push(`    opaque ${s.hir.kind}${s.names?.length ? ` binds ${s.names.join(", ")}` : ""};`);
        continue;
      }
      const r = s.rvalue;
      let rv: string;
      if (r.kind === "use") rv = opStr(r.op);
      else if (r.kind === "binop") rv = `${r.checked ? "Checked" : ""}BinOp(${r.op}, ${opStr(r.left)}, ${opStr(r.right)})`;
      else if (r.kind === "unop") rv = `${r.checked ? "Checked" : ""}UnOp(${r.op}, ${opStr(r.operand)})`;
      else rv = `${opStr(r.operand)} as ${tyStr(r.to)}`;
      out.push(`    _${s.place.local} = ${rv};`);
    }
    const t = b.term!;
    let ts: string;
    switch (t.kind) {
      case "goto": ts = `goto bb${t.target}`; break;
      case "if": ts = `if ${opStr(t.cond)} -> [true: bb${t.then}, false: bb${t.else}]`; break;
      case "return": ts = "return"; break;
      case "unreachable": ts = "unreachable"; break;
      case "call": ts = `${t.dest ? `_${t.dest.local} = ` : ""}call ${t.fn}(${t.args.map(opStr).join(", ")}) -> bb${t.next}`; break;
    }
    out.push(`    ${ts};`);
    out.push("  }");
  }
  out.push("}");
  return out.join("\n");
}
