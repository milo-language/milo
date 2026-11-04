// Reference interpreter: runs the merged AST directly, using only the checker's facts
// (CheckResult: expression types, resolved callees, borrow and move marks), never src/lower.ts
// or the HIR. One function per rule of docs/semantics/milo.md; comments cite the rule
// ID. It is small and slow on purpose: no caching, no fast paths. A difference from a compiled
// binary is a compiler bug or a wrong rule; a program no rule applies to is InterpStuck,
// named after the rule it broke. Library behaviour (strings, Vec, printing) is in
// src/interp-natives.ts.
//
// Generics: values carry their runtime shape and every rule here is dynamic. The one use of the
// checker's instantiation is callee resolution: a call to `foo<T>` runs the body the checker
// resolved it to (CheckResult.rewrittenCalls / resolvedMethods), which is its callee lookup, not a
// monomorphization of this interpreter.
import type { Contract, Expr, Function as AstFn, Pattern, Program, Stmt } from "./ast";
import { relative } from "path";
import { declaredType, floatNamespaceConst, patternLeafNames } from "./ast";
import type { CheckResult } from "./checker";
import type { TypeKind } from "./types";
import {
  ExitProgram, InterpStuck, type MapV, InterpUnsupported, MOVED, NeedTasks, Panic, staticStr,
  type ClosureV, type EnumV, type Place, type Ref, type Slot, type Step, type Str, type Struct, type Value, type VecBuf, type VecV,
} from "./interp-values";
import { Mem, isPtr, memSlot } from "./interp-mem";
import { callExtern, type Sys, type SysOptions } from "./interp-sys";
import { BUILTIN_FNS, builtinCall, concat, methodNative, nativeFor, sliceView, type Native } from "./interp-natives";

export type Completion = undefined | { k: "return"; v: Value } | { k: "break" } | { k: "continue" };
// Control flow raised from expression position (`?`, a diverging if/match arm): caught by the
// statement that contains the expression and turned back into a Completion.
export class Unwind { constructor(public c: NonNullable<Completion>) {} }
export interface Frame { scopes: { name: string; slot: Slot }[][]; fn: AstFn | null; ret: TypeKind; olds?: Map<Expr, Value> }
export type ChainStep = { ran: boolean; c: Completion };
export type Scope = { name: string; slot: Slot }[];
export type CallE = Expr & { kind: "Call" };
export type MethodE = Expr & { kind: "MethodCall" };

export const strip = (t: TypeKind | undefined): TypeKind => (!t ? { tag: "unknown" } : t.tag === "ref" ? strip(t.inner) : t);

export interface RunResult { stdout: Uint8Array; stderr: string; code: number; live: number | null }

export class Interp {
  fns = new Map<string, AstFn>();
  globals = new Map<string, { decl: Program["globals"][number]; slot: Slot | null }>();
  frames: Frame[] = [];
  temps: Slot[] = [];
  blocks = new Set<number>();
  nextId = 1;
  out: number[] = [];
  err: number[] = [];
  aborted = false; // a panic or exit does not unwind: no drops run, no live count
  depth = 0;
  dropImpls: Set<string>;
  mem = new Mem(this);
  clock = 0; // R-TIME: virtual milliseconds the task scheduler has slept (src/interp-co.ts); the wall clock adds it (R-SYS-CLOCK)
  sysOptions: SysOptions = {};
  sys?: Sys; // the C functions std calls (src/interp-sys.ts), made on the first extern call

  constructor(public prog: Program, public cr: CheckResult) {
    for (const f of prog.functions) this.fns.set(f.name, f);
    for (const f of cr.monomorphizedFns) this.fns.set(f.name, f);
    for (const g of prog.globals) this.globals.set(g.name, { decl: g, slot: null });
    this.dropImpls = cr.dropImpls;
  }

  // ── runner ──
  // S-PANIC-ABORT
  run(): RunResult {
    let code = 0, panicked = false;
    try {
      const main = this.fns.get("main");
      if (!main || main.isExtern) throw new InterpUnsupported("no main");
      const mentioned = new Set<string>();
      const walk = (n: unknown): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) { for (const x of n) walk(x); return; }
        const o = n as { kind?: string; name?: string };
        if (o.kind === "Ident" && o.name) mentioned.add(o.name);
        for (const [k, v] of Object.entries(n)) if (k !== "span") walk(v);
      };
      for (const f of this.fns.values()) walk(f.body);
      for (const g of this.prog.globals) if (this.cr.nonConstGlobals.includes(g.name) && !mentioned.has(g.name)) this.globalSlot(g.name);
      const r = this.runMain(main);
      if (typeof r === "bigint") code = Number(BigInt.asUintN(8, r));
    } catch (e) {
      this.aborted = true;
      if (e instanceof ExitProgram) { code = e.code; panicked = e.killed; }
      else if (e instanceof Panic) { this.err.push(...new TextEncoder().encode(e.message + "\n")); code = 134; panicked = true; }
      else if (e instanceof RangeError && /call stack/i.test(e.message)) throw new InterpUnsupported("host stack exhausted (very deep recursion)");
      else throw e;
    }
    return { stdout: Uint8Array.from(this.out), stderr: new TextDecoder().decode(Uint8Array.from(this.err)), code, live: panicked ? null : this.blocks.size };
  }

  // The program's entry. The task interpreter (src/interp-co.ts) overrides it to run main as the first task.
  runMain(main: AstFn): Value { return this.callFn(main, []); }
  // S-PANIC-ABORT: the compiled program dies of SIGSEGV (139) on a stack overflow, printing nothing.
  stackOverflow(): never { this.aborted = true; throw new ExitProgram(139, true); }
  panic(msg: string): never { this.aborted = true; throw new Panic(msg); }
  // T-STUCK
  stuck(rule: string, detail: string): never {
    const e = new InterpStuck(rule, detail);
    e.where = this.frames.slice(-5).reverse().map(f => f.fn?.name ?? "?").join(" < ");
    throw e;
  }
  unsupported(what: string): never {
    const e = new InterpUnsupported(what);
    e.where = this.frames.slice(-5).reverse().map(f => f.fn?.name ?? "?").join(" < ");
    throw e;
  }
  T(e: Expr): TypeKind { const t = this.cr.exprTypes.get(e); return t?.tag === "never" ? { tag: "void" } : strip(t); }
  rawT(e: Expr): TypeKind | undefined { return this.cr.exprTypes.get(e); }
  displayName(n: string): string { return this.prog.displayNames?.get(n) ?? n; }

  // ── heap ──
  alloc(): number { const id = this.nextId++; this.blocks.add(id); return id; }
  // E-VEC
  free(id: number): void {
    if (!this.blocks.delete(id)) this.stuck("heap", `block ${id} freed twice or never allocated`);
  }
  newBuf(cap: number): VecBuf { return { id: this.alloc(), elems: new Array(cap).fill(undefined) }; }
  // E-STRING-SHARE
  newStr(bytes: number[]): Str {
    const id = bytes.length ? this.alloc() : -1; // an empty string owns no buffer
    return { k: "str", b: { bytes, rc: 1, id } };
  }
  // E-VEC
  newVec(xs: Value[]): VecV {
    const buf = xs.length ? this.newBuf(xs.length) : null;
    if (buf) buf.elems = xs;
    return { k: "vec", buf, start: 0, len: xs.length, cap: xs.length, view: false };
  }
  structFields(name: string): { name: string; type: TypeKind }[] {
    const s = this.cr.structs.get(name);
    if (!s) this.unsupported(`struct ${name} has no body`);
    return s.fields;
  }
  mkEnum(en: string, variant: string, a: Value[]): EnumV {
    const v = this.cr.enums.get(en)?.variants.get(variant);
    if (!v) this.stuck("E-STUCK", `no variant ${en}.${variant}`);
    return { k: "enum", en, variant, tag: v.tag, a };
  }

  // ── scopes and slots ──
  get frame(): Frame { return this.frames[this.frames.length - 1]!; }
  // S-LET S-VAR T-LET
  declare(name: string, v: Value, scope?: Scope): Slot {
    const slot: Slot = { v };
    (scope ?? this.frame.scopes[this.frame.scopes.length - 1]!).push({ name, slot });
    return slot;
  }
  // E-STUCK
  lookup(name: string): Slot | undefined {
    const f = this.frame;
    for (let i = f.scopes.length - 1; i >= 0; i--) {
      const sc = f.scopes[i]!;
      for (let j = sc.length - 1; j >= 0; j--) if (sc[j]!.name === name) return sc[j]!.slot;
    }
    return this.globals.has(name) ? this.globalSlot(name) : undefined;
  }
  // E-GLOBAL
  globalSlot(name: string): Slot {
    const g = this.globals.get(name)!;
    if (!g.slot) {
      g.slot = { v: MOVED };
      this.frames.push({ scopes: [[]], fn: null, ret: { tag: "void" } });
      try { g.slot.v = this.ev(g.decl.value); } finally { this.frames.pop(); }
    }
    return g.slot;
  }

  // [S-SCOPE-END] drop a scope's variables in reverse declaration order; moved slots and
  // place references own nothing.
  dropScope(scope: Scope): void {
    if (this.aborted) return;
    for (let i = scope.length - 1; i >= 0; i--) {
      const s = scope[i]!.slot;
      if (!isRef(s.v)) this.dropValue(s.v);
      s.dead = true;
    }
  }
  // [S-TEMP] a temporary lives until the end of the statement that made it.
  tempOwn(v: Value, stmt = false): Slot { const s: Slot = { v, stmt }; this.temps.push(s); return s; }
  // atCall: the end of a call, which keeps the temporaries that belong to the whole statement
  // S-TEMP-CALL
  dropTemps(mark: number, atCall = false): void {
    if (this.aborted) { this.temps.length = mark; return; }
    const keep: Slot[] = [];
    while (this.temps.length > mark) {
      const s = this.temps.pop()!;
      if (atCall && s.stmt) { keep.unshift(s); continue; }
      this.dropValue(s.v); s.dead = true;
    }
    this.temps.push(...keep);
  }

  // ── drops ──
  // drop(v): user Drop first, then fields last-first (spec §2 Drops).
  // E-ARRAY-DROP E-HASHMAP
  dropValue(v: Value): void {
    if (v === undefined || typeof v !== "object" || v === MOVED) return;
    if ((v.k === "struct" || v.k === "enum" || v.k === "box" || v.k === "handle") && v.ghost) return;
    switch (v.k) {
      case "str": if (v.b.id >= 0 && --v.b.rc === 0) this.free(v.b.id); return;
      case "struct": {
        if (this.dropImpls.has(v.name)) this.userDrop(v.name, v);
        const names = Object.keys(v.f);
        for (let i = names.length - 1; i >= 0; i--) this.dropValue(v.f[names[i]!]!);
        return;
      }
      case "enum": {
        if (this.dropImpls.has(v.en)) this.userDrop(v.en, v);
        for (let i = v.a.length - 1; i >= 0; i--) this.dropValue(v.a[i]!);
        return;
      }
      case "arr": for (const x of v.e) this.dropValue(x); return;
      case "vec":
        if (v.view || !v.buf) return;
        for (let i = 0; i < v.len; i++) this.dropValue(v.buf.elems[v.start + i]!);
        this.free(v.buf.id);
        return;
      case "box": this.dropValue(v.cell.v); this.free(v.id); return;
      case "iface": this.dropValue(v.inner); return;
      case "map":
        if (v.view) return;
        for (const e of v.m.values()) { this.dropValue(e.key.v); this.dropValue(e.val.v); }
        if (v.buf !== null) this.free(v.buf);
        return;
      case "closure": if (v.owning) for (const c of v.env) if (!isRef(c.slot.v)) this.dropValue(c.slot.v); return;
      case "handle": v.o.release(this); return;
      default: return;
    }
  }
  userDrop(typeName: string, v: Struct | EnumV): void {
    const fn = this.fns.get(this.concreteMethodFn(typeName, "drop"));
    if (!fn) this.stuck("T-STUCK", `no drop for ${typeName}`);
    this.callFn(fn, [{ k: "mut", slot: { v }, path: [] }]);
  }

  // ── places ──
  // A place is a slot plus a path of field / index steps. Reading or writing goes through
  // the slot, so a reference to a place keeps meaning after the value inside is replaced.
  resolveIdent(name: string): Place {
    const slot = this.lookup(name);
    if (!slot) this.stuck("E-STUCK", `unbound variable ${name}`);
    const v = slot.v;
    if (isRef(v)) return { slot: v.slot, path: [...v.path], ro: v.k === "ref", viaRef: true };
    return { slot, path: [], ro: false, viaRef: false };
  }
  isLen(e: Expr): boolean {
    if (e.kind !== "FieldAccess" || e.field !== "len") return false;
    const t = this.T(e.object).tag;
    return t === "vec" || t === "string" || t === "array" || t === "hashmap";
  }
  isPlaceExpr(e: Expr): boolean {
    switch (e.kind) {
      case "Ident": return this.lookup(e.name) !== undefined;
      case "FieldAccess": return !this.isLen(e) && !floatNamespaceConst(e);
      case "IndexAccess": { const t = this.T(e.object).tag; return t !== "string" && t !== "hashmap"; }
      case "UnaryOp": return e.op === "*";
    }
    return false;
  }
  // T-STUCK
  resolve(e: Expr): Place {
    if (this.isPlaceExpr(e)) {
      switch (e.kind) {
        case "Ident": return this.resolveIdent(e.name);
        case "FieldAccess": {
          const fo = this.T(e.object);
          if (fo.tag === "ptr") return { ...this.memPlace(this.peek(e.object), fo.inner), path: [e.field] }; // p.f on a `*S`: the field of the struct at p
          const b = this.resolve(e.object);
          return { ...b, path: [...b.path, e.field] };
        }
        case "IndexAccess": {
          const ot = this.T(e.object);
          if (ot.tag === "ptr") return this.memPlace(this.mem.advance(this.peek(e.object), Number(this.ev(e.index) as bigint) * this.mem.sizeOf(ot.inner)), ot.inner);
          const b = this.resolve(e.object);
          const i = this.ev(e.index) as bigint;
          const n = this.seqLen(this.getPlace(b));
          if (i < 0n || i >= BigInt(n)) this.panic(`array index out of bounds: ${i}/${n}`);
          return { ...b, path: [...b.path, Number(i)] };
        }
        case "UnaryOp": {
          const pt = this.T(e.operand);
          if (pt.tag === "ptr") return this.memPlace(this.peek(e.operand), pt.inner);
          const b = this.resolve(e.operand); return { ...b, path: [...b.path, "*"] }; }
      }
    }
    return { slot: this.tempOwn(this.ev(e)), path: [], ro: false, viaRef: false };
  }
  // R-MEM-LOAD / R-MEM-STORE: the place a raw pointer names; reading it loads, assigning it stores
  memPlace(p: Value, ty: TypeKind): Place { return { slot: memSlot(this.mem, p, ty), path: [], ro: false, viaRef: false }; }
  seqLen(v: Value): number {
    if (v && typeof v === "object" && v !== MOVED) {
      if (v.k === "vec") return v.len;
      if (v.k === "arr") return v.e.length;
    }
    return this.stuck("T-STUCK", "index into something that is not a Vec or array");
  }
  child(cur: Value, step: Step): { get(): Value; set(v: Value): void } {
    if (cur === MOVED) this.stuck("E-STUCK", "read through a moved value");
    if (cur && typeof cur === "object") {
      if (cur.k === "struct") return { get: () => cur.f[step as string]!, set: v => { cur.f[step as string] = v; } };
      if (cur.k === "arr") return { get: () => cur.e[step as number]!, set: v => { cur.e[step as number] = v; } };
      if (cur.k === "enum") return { get: () => cur.a[step as number]!, set: v => { cur.a[step as number] = v; } };
      if (cur.k === "vec" && cur.buf) { const b = cur.buf, i = cur.start + (step as number); return { get: () => b.elems[i]!, set: v => { b.elems[i] = v; } }; }
      if (cur.k === "box") {
        if (step === "*") return { get: () => cur.cell.v, set: v => { cur.cell.v = v; } };
        return this.child(cur.cell.v, step); // `h.field` on a Heap<S> goes through the box
      }
      if (cur.k === "iface") return { get: () => cur.inner, set: v => { cur.inner = v; } };
    }
    return this.stuck("T-STUCK", `no step ${String(step)} into ${describe(cur)}`);
  }
  getPlace(p: Place): Value {
    if (p.slot.dead) this.stuck("T-REF-PARAM", "a reference outlived the frame it names");
    let cur = p.slot.v;
    for (const s of p.path) cur = this.child(cur, s).get();
    return cur;
  }
  // T-ASSIGN-MOVED-OK
  setPlace(p: Place, v: Value): void {
    if (p.slot.dead) this.stuck("T-REF-PARAM", "a reference outlived the frame it names");
    if (p.path.length === 0) { p.slot.v = v; return; }
    const root = p.slot.v;
    let cur = root;
    for (const s of p.path.slice(0, -1)) cur = this.child(cur, s).get();
    this.child(cur, p.path[p.path.length - 1]!).set(v);
    if (p.slot.mem) p.slot.v = root; // raw memory: the slot hands out a decoded copy, so store the changed copy back
  }
  refTo(p: Place, mut: boolean): Ref { return { k: mut ? "mut" : "ref", slot: p.slot, path: [...p.path] }; }
  deref(r: Value): Value { return this.getPlace({ slot: (r as Ref).slot, path: (r as Ref).path, ro: false, viaRef: true }); }
  derefPlace(r: Value): Place { return { slot: (r as Ref).slot, path: [...(r as Ref).path], ro: (r as Ref).k === "ref", viaRef: true }; }

  // Look at a value without taking it: a place is read in place, anything else becomes a
  // temporary that [S-TEMP] drops at the end of the statement.
  peek(e: Expr): Value {
    if (e.kind === "Ident" && !this.lookup(e.name) && this.fns.has(e.name)) return { k: "fn", name: e.name };
    if (this.isPlaceExpr(e) && !this.tempRooted(e)) {
      const v = this.getPlace(this.resolve(e));
      if (v === MOVED) this.stuck("E-STUCK", `${describeExpr(e)} was moved`);
      return v;
    }
    const v = this.ev(e);
    this.tempOwn(v);
    return v;
  }
  // a field / deref chain: its root expression and the steps from the root down to e
  chain(e: Expr): { root: Expr; steps: Step[] } {
    const steps: Step[] = [];
    let x = e;
    for (;;) {
      if (x.kind === "FieldAccess" && !this.isLen(x) && !floatNamespaceConst(x)) { steps.unshift(x.field); x = x.object; }
      else if (x.kind === "UnaryOp" && x.op === "*" && this.T(x.operand).tag !== "ptr") { steps.unshift("*"); x = x.operand; }
      else return { root: x, steps };
    }
  }
  // S-TEMP-FIELD
  tempRooted(e: Expr): boolean {
    const c = this.chain(e);
    return c.steps.length > 0 && !this.isPlaceExpr(c.root);
  }
  // [S-TEMP-FIELD] a field (or box payload) read out of a temporary moves out, and the rest of the temporary dies at once
  readTempRooted(e: Expr): Value {
    const { root, steps } = this.chain(e);
    const slot: Slot = { v: this.ev(root) };
    const rv = slot.v;
    // a temporary with its own Drop keeps every field for the destructor: the read is a clone, then the whole temporary drops
    const ownDrop = !!rv && typeof rv === "object" && ((rv.k === "struct" && this.dropImpls.has(rv.name)) || (rv.k === "enum" && this.dropImpls.has(rv.en)));
    const pl = { slot, path: steps, ro: false, viaRef: false };
    const v = ownDrop ? this.deepClone(this.getPlace(pl)) : this.readPlace(pl, true, describeExpr(e));
    this.dropValue(slot.v);
    return v;
  }

  // [E-COPY] / [E-MOVE] / [E-FIELD-MOVE]
  readPlace(p: Place, isMove: boolean, what: string): Value {
    const v = this.getPlace(p);
    if (v === MOVED) this.stuck("E-STUCK", `${what} was moved`);
    if (isMove && !p.viaRef && !this.copyable(v)) {
      if (p.ro) this.stuck("T-NO-MOVE-OUT", `${what} moved out of a shared place`);
      this.setPlace(p, MOVED);
      return v;
    }
    return this.share(v, what, isMove && p.viaRef);
  }
  // E-COPY
  copyable(v: Value): boolean {
    if (v === undefined || typeof v !== "object") return true;
    switch (v.k) {
      case "struct": return !this.dropImpls.has(v.name) && Object.values(v.f).every(x => this.copyable(x));
      case "enum": return !this.dropImpls.has(v.en) && v.a.every(x => this.copyable(x));
      case "arr": return v.e.every(x => this.copyable(x));
      case "fn": case "ptr": return true;
      case "closure": return !v.owning;
      case "vec": return v.view;
      default: return false;
    }
  }
  // A copy of a value read without moving: Copy data duplicated, a string's buffer shared.
  // E-STRING-SHARE
  share(v: Value, what: string, viaRef = false): Value {
    if (v === undefined || typeof v !== "object") return v;
    switch (v.k) {
      case "moved": return this.stuck("E-STUCK", `${what} holds a moved part`);
      case "str": if (v.b.id >= 0) v.b.rc++; return { k: "str", b: v.b };
      case "struct": {
        if (this.dropImpls.has(v.name)) break;
        const f: Record<string, Value> = {};
        for (const n of Object.keys(v.f)) f[n] = this.share(v.f[n]!, what);
        return { k: "struct", name: v.name, f };
      }
      case "enum": if (this.dropImpls.has(v.en)) break; return { ...v, a: v.a.map(x => this.share(x, what)) };
      case "arr": return { k: "arr", e: v.e.map(x => this.share(x, what)) };
      case "vec": if (v.view) return { ...v }; break;
      case "fn": case "ptr": return v;
      case "closure": return v.owning ? { ...v, owning: false } : v;
      case "ref": case "mut": return v;
    }
    return viaRef
      ? this.stuck("T-NO-MOVE-OUT", `${what}: an owned ${describe(v)} cannot be moved out through a reference`)
      : this.stuck("E-COPY", `${what}: read of an owned ${describe(v)} that the checker did not mark as a move`);
  }

  // A value that borrows what `v` owns: dropping it does nothing, reading it needs no move.
  // E-FORK-VIEW
  viewOf(v: Value): Value {
    if (v === undefined || typeof v !== "object" || v === MOVED) return v;
    switch (v.k) {
      case "str": return { k: "str", b: { bytes: v.b.bytes, rc: 1, id: -1 } };
      case "vec": return { ...v, view: true };
      case "struct": { const f: Record<string, Value> = {}; for (const n of Object.keys(v.f)) f[n] = this.viewOf(v.f[n]!); return { k: "struct", name: v.name, f, ghost: true }; }
      case "enum": return { ...v, a: v.a.map(x => this.viewOf(x)), ghost: true };
      case "arr": return { k: "arr", e: v.e.map(x => this.viewOf(x)) };
      case "box": return { ...v, ghost: true };
      case "map": return { ...v, view: true };
      case "handle": return { ...v, ghost: true };
      default: return v;
    }
  }
  // HashMap keys compare by value: a canonical text of the key
  // E-HASHMAP
  keyOf(v: Value): string {
    if (v === undefined || typeof v !== "object") return typeof v + String(v);
    switch (v.k) {
      case "str": return "s" + new TextDecoder().decode(Uint8Array.from(v.b.bytes));
      case "struct": return "{" + Object.keys(v.f).map(n => n + ":" + this.keyOf(v.f[n]!)).join(",") + "}";
      case "enum": return v.variant + "(" + v.a.map(x => this.keyOf(x)).join(",") + ")";
      case "arr": return "[" + v.e.map(x => this.keyOf(x)).join(",") + "]";
      default: return this.unsupported(`hashmap key of ${v.k}`);
    }
  }
  // E-HASHMAP
  mapPut(m: MapV, key: Value, val: Value): void {
    const k = this.keyOf(key), old = m.m.get(k);
    if (old) { this.dropValue(key); this.dropValue(old.val.v); old.val.v = val; return; }
    if (m.buf === null) m.buf = this.alloc();
    m.m.set(k, { key: { v: key }, val: { v: val } });
  }
  // An independent owned copy (no user Clone is run): what `[x; n]` makes of the repeated element.
  // E-INDEX-COPY
  deepClone(v: Value): Value {
    if (v === undefined || typeof v !== "object" || v === MOVED) return v;
    switch (v.k) {
      case "str": return v.b.id < 0 ? { k: "str", b: v.b } : this.newStr([...v.b.bytes]);
      case "vec": return v.view ? { ...v } : this.newVec(v.buf ? v.buf.elems.slice(v.start, v.start + v.len).map(x => this.deepClone(x)) : []);
      case "struct": { const f: Record<string, Value> = {}; for (const n of Object.keys(v.f)) f[n] = this.deepClone(v.f[n]!); return { k: "struct", name: v.name, f }; }
      case "enum": return { ...v, a: v.a.map(x => this.deepClone(x)) };
      case "arr": return { k: "arr", e: v.e.map(x => this.deepClone(x)) };
      case "box": return { k: "box", id: this.alloc(), cell: { v: this.deepClone(v.cell.v) } };
      case "map": {
        const c: MapV = { k: "map", buf: null, m: new Map() };
        for (const e of v.m.values()) this.mapPut(c, this.deepClone(e.key.v), this.deepClone(e.val.v));
        return c;
      }
      default: return v;
    }
  }

  // ── calls ──
  // E-CALL
  paramFlags(fn: AstFn): { name: string; isRef: boolean; isRefMut: boolean; ptrParam: boolean }[] {
    return fn.params.map(p => { const t = declaredType(p); return { name: p.name, isRef: t.isRef && !t.isNullableRef, isRefMut: t.isRefMut && !t.isNullableRef, ptrParam: !!t.isPtr }; });
  }
  // [E-CALL] steps 2 and 3: push a frame, run the body, drop the frame's variables, pop.
  callFn(fn: AstFn, args: Value[]): Value {
    if (fn.isExtern) return callExtern(this, fn, args);
    if (++this.depth > 3000) this.stackOverflow();
    this.frames.push({ scopes: [[]], fn, ret: this.cr.functions.get(fn.name)?.ret ?? { tag: "void" } });
    try {
      const sig = fn.params.some(p => p.type?.isPtr) ? this.cr.functions.get(fn.name) : undefined; // R-MEM-CSTR
      const held: Value[] = []; // strings given by value to a `*T` parameter: owned until the call returns
      fn.params.forEach((p, i) => this.declare(p.name, sig ? this.mem.decay(args[i]!, sig.params[i]?.type, held) : args[i]!));
      held.forEach((h, i) => this.declare(`$held${i}`, h));
      const checked = this.contractChecks && !!fn.contracts?.length;
      if (checked) this.enterContracts(fn);
      const c = this.runStmts(fn.body);
      const v = c && c.k === "return" ? c.v : undefined;
      if (checked) this.exitContracts(fn, v);
      return v;
    } finally {
      this.depth--;
      const f = this.frames.pop()!;
      for (let i = f.scopes.length - 1; i >= 0; i--) this.dropScope(f.scopes[i]!);
    }
  }
  // R-CONTRACT-ENTRY: the old(...) snapshots of the ensures clauses, then every requires clause, before the body runs.
  enterContracts(fn: AstFn): void {
    const calls: (Expr & { kind: "Call" })[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) walk(x); return; }
      const o = n as { kind?: string; func?: string; args?: Expr[] };
      if (o.kind === "Call" && o.func === "old" && o.args?.length === 1) calls.push(n as Expr & { kind: "Call" });
      for (const [k, v] of Object.entries(n)) if (k !== "span") walk(v);
    };
    for (const c of fn.contracts) if (c.kind === "ensures") walk(c.expr);
    const olds = new Map<Expr, Value>();
    for (const o of calls) olds.set(o, this.share(this.ev(o.args[0]!), "old"));
    this.frame.olds = olds;
    for (const c of fn.contracts) if (c.kind === "requires") this.checkClause(c);
  }
  // R-CONTRACT-EXIT: at every return, with `result` naming the value being returned, before the frame's variables drop.
  exitContracts(fn: AstFn, v: Value): void {
    const scope: Scope = [];
    this.frame.scopes.push(scope);
    try {
      if (v !== undefined) this.declare("result", this.viewOf(v), scope);
      for (const c of fn.contracts) if (c.kind === "ensures") this.checkClause(c);
    } finally { this.frame.scopes.pop(); }
  }
  // R-CONTRACT-LOOP: a while loop's invariants are checked before its condition each time (so on exit too); a for loop's at the top of each iteration.
  checkInvariants(invs: Contract[] | undefined): void {
    if (!this.contractChecks) return;
    for (const c of invs ?? []) if (c.kind === "invariant") this.checkClause(c);
  }
  // R-CONTRACT-FAIL
  checkClause(c: Contract): void {
    const mark = this.temps.length;
    const holds = this.peek(c.expr) === true;
    this.dropTemps(mark);
    if (holds) return;
    const file = c.span?.file ?? this.entryFile;
    const shown = file && !file.startsWith("/") ? file : relative(process.cwd(), file);
    this.panic(`runtime error: ${c.kind} clause violated at ${shown.startsWith("..") ? file : shown}:${c.span?.line ?? 0}`);
  }
  // E-CLOSURE
  callClosure(c: ClosureV, args: Value[]): Value {
    if (++this.depth > 3000) this.stackOverflow();
    this.frames.push({ scopes: [[]], fn: this.frames.length ? this.frame.fn : null, ret: c.ret });
    const envScope = this.frame.scopes[0]!;
    try {
      // env slots belong to the closure, not to this call: they are not dropped here
      for (const e of c.env) envScope.push({ name: e.name, slot: e.slot });
      const n = envScope.length;
      c.params.forEach((p, i) => this.declare(p, args[i]!));
      try { return this.blockValue(c.body as Stmt[]); }
      catch (u) { if (u instanceof Unwind && u.c.k === "return") return u.c.v; throw u; }
      finally { envScope.splice(0, n); }
    } finally {
      this.depth--;
      const f = this.frames.pop()!;
      for (let i = f.scopes.length - 1; i >= 0; i--) this.dropScope(f.scopes[i]!);
    }
  }
  callValue(callee: Value, args: Value[]): Value {
    if (callee && typeof callee === "object" && callee.k === "closure") return this.callClosure(callee, args);
    if (callee && typeof callee === "object" && callee.k === "fn") return this.callNamed(callee.name, args);
    return this.stuck("E-CALL", `call of ${describe(callee)}`);
  }
  // E-CALL
  callNamed(name: string, args: Value[]): Value {
    const fn = this.fns.get(name);
    if (!fn) this.unsupported(`call of unknown function ${name}`);
    return this.callFn(fn, args);
  }

  // [E-CALL] step 1: arguments left to right. by value: E-COPY / E-MOVE; &p: ref; &mut p: mut.
  // `borrow(i)` says how argument i is passed: the checker's autoBorrowed mark, or the
  // parameter's own reference type.
  evalArgs(args: Expr[], flags?: { isRef: boolean; isRefMut: boolean; ptrParam?: boolean }[], offset = 0): Value[] {
    const places: { slot: Slot; path: Step[]; mut: boolean }[] = [];
    const pm = this.pend.length;
    const out: Value[] = [];
    for (let i = 0; i < args.length; i++) out.push(this.evalArg(args[i]!, i, flags, offset, places));
    this.settle(pm);
    // [T-EXCL] a place passed &mut overlaps no other reference argument
    for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) {
      const a = places[i]!, b = places[j]!;
      if ((a.mut || b.mut) && a.slot === b.slot && prefixOf(a.path, b.path)) this.stuck("T-EXCL", "a &mut argument overlaps another argument");
    }
    return out;
  }
  evalArg(raw: Expr, i: number, flags: { isRef: boolean; isRefMut: boolean; ptrParam?: boolean }[] | undefined, offset: number, places: { slot: Slot; path: Step[]; mut: boolean }[]): Value {
    {
      const a = raw.kind === "UnaryOp" && raw.op === "&mut" ? raw.operand : raw; // a call-site marker only
      const f = flags?.[i + offset];
      const mark = this.cr.autoBorrowed.get(raw);
      const byRef = !!mark || !!f?.isRef || !!f?.isRefMut;
      if (!byRef) {
        // R-MEM-CSTR: a string or array place given to a `*T` parameter is lent, so the pointer reaches the place itself and not a copy
        if (f?.ptrParam && this.isPlaceExpr(a) && (this.T(a).tag === "array" || this.T(a).tag === "string")) return this.refTo(this.resolve(a), true);
        return this.pending(this.ev(a));
      }
      const mut = mark?.mutable ?? !!f?.isRefMut;
      if (!this.isPlaceExpr(a) && !mark) {
        // a value given to a reference parameter (a slice view, a computed value): it lives in a temp
        return { k: "ref", slot: this.tempOwn(this.ev(a)), path: [] } as Ref;
      }
      if (this.tempRooted(a)) return { k: "ref", slot: this.tempOwn(this.readTempRooted(a)), path: [] } as Ref; // S-TEMP-FIELD
      const pl = this.resolve(a);
      if (mut && pl.ro) this.stuck("T-SHARED-READONLY", `&mut of ${describeExpr(a)}, which is behind a shared reference`);
      places.push({ slot: pl.slot, path: pl.path, mut });
      const co = this.cr.interfaceCoercions.get(raw);
      if (co) { // `&T` given to `&Interface`: a view pair that borrows the place
        const view: Value = { k: "iface", concrete: co.fromType, inner: this.refTo(pl, mut) };
        return { k: "ref", slot: this.tempOwn(view), path: [] } as Ref;
      }
      return this.refTo(pl, mut);
    }
  }

  // [S-PENDING] an owned operand evaluated before its siblings is held as a temporary until the op
  // takes all of them (settle); a return/break/`?` out of a later operand drops it, last first.
  pending(v: Value): Value { this.pend.push(this.tempOwn(v)); return v; }
  pend: Slot[] = [];
  settle(mark: number): void { while (this.pend.length > mark) this.pend.pop()!.v = MOVED; }

  // ── expressions ──
  // E-COPY E-MOVE T-MOVED
  ev(e: Expr): Value {
    const optName = this.cr.autoWrappedOption.get(e); // T -> Option<T>
    if (optName) return this.mkEnum(optName, "Some", [this.checked(e, this.evRaw(e))]);
    const co = this.cr.interfaceCoercions.get(e);
    if (co) return { k: "iface", concrete: co.fromType, inner: this.evRaw(e) };
    if (this.cr.arraySliceArgs.has(e)) { // a fixed array given to a slice parameter: a view of it
      const a = this.isPlaceExpr(e) ? this.peek(e) : (v => (this.tempOwn(v, true), v))(this.evRaw(e));
      if (a && typeof a === "object" && a.k === "arr") return sliceView(this, a, 0n, BigInt(a.e.length));
    }
    return this.checked(e, this.evRaw(e));
  }
  // S-PANIC-ABORT
  checked(e: Expr, v: Value): Value {
    const rc = this.cr.rangeCheckedExprs.get(e);
    if (rc && typeof v === "bigint" && (v < BigInt(rc.min) || v > BigInt(rc.max))) this.panic(`${rc.typeName} out of range`);
    return v;
  }
  // E-COPY E-MOVE
  evRaw(e: Expr): Value {
    if (this.cr.sharedStringExprs.has(e) && this.isPlaceExpr(e)) { // a second handle to a counted buffer
      return this.share(this.peek(e), describeExpr(e));
    }
    switch (e.kind) {
      case "IntLit": return this.T(e).tag === "float" ? Number(e.value) : e.value;
      case "FloatLit": { const t = this.T(e); return t.tag === "float" && t.bits === 32 ? Math.fround(e.value) : e.value; }
      case "BoolLit": return e.value;
      case "CharLit": return BigInt(e.value);
      case "StringLit": return staticStr(e.value);
      case "Ident": {
        if (!this.lookup(e.name) && this.fns.has(e.name)) return { k: "fn", name: e.name };
        return this.readPlace(this.resolveIdent(e.name), this.cr.movedExprs.has(e), e.name);
      }
      case "FieldAccess": return this.fieldAccess(e);
      case "IndexAccess": return this.index(e);
      case "BinOp": return this.binop(e);
      case "UnaryOp": return this.unop(e);
      case "Call": return this.callExpr(e);
      case "MethodCall": return this.methodCall(e);
      case "StructLit": return this.structLit(e);
      case "ArrayLit": return this.arrayLit(e);
      case "ArrayRepeat": return this.arrayRepeat(e);
      case "EnumLit": return this.enumLit(e);
      case "Unwrap": return this.unwrap(e);
      case "Propagate": return this.propagate(e);
      case "DefaultValue": return this.defaultValue(e);
      case "CastExpr": return this.cast(this.peek(e.operand), this.T(e.operand), this.T(e));
      case "Closure": return this.closure(e);
      case "IsExpr": return this.patternMatches(e.pattern, this.peek(e.operand));
      case "IfExpr": return this.ifExpr(e);
      case "MatchExpr": { const owns = this.forkOwns(e.arms.map(a => a.body)); return this.matchCore(e.subject, e.arms.map(a => ({ pattern: a.pattern, run: () => this.blockValue(a.body, owns) }))); }
      case "RangeExpr": return this.unsupported("range outside a for-in");
    }
  }

  // E-FIELD-MOVE
  fieldAccess(e: Expr & { kind: "FieldAccess" }): Value {
    const fnc = floatNamespaceConst(e);
    if (fnc) return fnc.value;
    if (this.isLen(e)) {
      const v = this.peek(e.object);
      if (v && typeof v === "object" && v.k === "str") return BigInt(v.b.bytes.length);
      if (v && typeof v === "object" && v.k === "map") return BigInt(v.m.size);
      return BigInt(this.seqLen(v));
    }
    if (this.tempRooted(e)) return this.readTempRooted(e);
    return this.readPlace(this.resolve(e), this.cr.movedExprs.has(e), describeExpr(e));
  }
  index(e: Expr & { kind: "IndexAccess" }): Value {
    const ot = this.T(e.object);
    if (ot.tag === "ptr") return this.getPlace(this.resolve(e)); // R-MEM-LOAD: a raw load is a bitwise copy
    if (ot.tag === "string") { // a byte of a string
      const s = this.peek(e.object) as Str, i = this.ev(e.index) as bigint;
      if (i < 0n || i >= BigInt(s.b.bytes.length)) this.panic(`index out of bounds: ${i}`);
      return BigInt(s.b.bytes[Number(i)]!);
    }
    if (ot.tag === "hashmap") { // m[k]: a copy of the value, or a panic when the key is absent
      const m = this.peek(e.object) as MapV, ent = m.m.get(this.keyOf(this.peek(e.index)));
      if (!ent) this.panic("key not found");
      return this.copyable(ent.val.v) || isStr(ent.val.v) ? this.share(ent.val.v, "m[k]") : this.deepClone(ent.val.v);
    }
    const pl = this.resolve(e);
    const v = this.getPlace(pl);
    if (v === MOVED) this.stuck("E-STUCK", `${describeExpr(e)} was moved`);
    if (this.copyable(v) || isStr(v)) return this.share(v, describeExpr(e));
    return this.deepClone(v);
  }

  structLit(e: Expr & { kind: "StructLit" }): Value {
    const name = this.cr.rewrittenStructLits.get(e) ?? e.name;
    const given = new Map<string, Value>();
    const pm = this.pend.length;
    for (const f of e.fields) given.set(f.name, this.pending(this.ev(f.value)));
    this.settle(pm);
    const base = e.base ? (this.ev(e.base) as Struct) : null; // struct update: listed fields drop, the rest move
    const f: Record<string, Value> = {};
    for (const d of this.structFields(name)) {
      if (given.has(d.name)) { f[d.name] = given.get(d.name)!; if (base) this.dropValue(base.f[d.name]!); }
      else if (base) f[d.name] = base.f[d.name]!;
      else this.stuck("T-STUCK", `${name}.${d.name} not given`);
    }
    return { k: "struct", name, f };
  }
  // S-PENDING
  arrayLit(e: Expr & { kind: "ArrayLit" }): Value {
    const pm = this.pend.length;
    const xs: Value[] = [];
    for (const x of e.elements) xs.push(this.pending(this.ev(x)));
    this.settle(pm);
    const t = this.T(e);
    if (t.tag === "array" && !this.cr.arrayToVecCoercions.has(e)) return { k: "arr", e: xs };
    return this.newVec(xs);
  }
  // E-INDEX-COPY
  arrayRepeat(e: Expr & { kind: "ArrayRepeat" }): Value {
    const first = this.ev(e.value);
    const xs: Value[] = [first];
    const clone = this.cr.arrayRepeatClones.get(e);
    // the n-1 copies are made first and the original moves into the last slot
    xs.length = 0;
    for (let i = 1; i < e.count; i++) xs.push(clone ? this.callNamed(clone, [this.refTo({ slot: { v: first }, path: [], ro: true, viaRef: false }, false)]) : this.deepClone(first));
    if (e.count === 0) this.dropValue(first); else xs.push(first);
    return this.T(e).tag === "array" ? { k: "arr", e: e.count ? xs : [] } : this.newVec(e.count ? xs : []);
  }
  // S-PENDING
  enumLit(e: Expr & { kind: "EnumLit" }): Value {
    const type = this.T(e);
    if (e.enumName === "Vec" && e.variant === "new" && type.tag === "vec") return this.newVec([]);
    const ctor = this.cr.staticCalls.get(e) ?? this.cr.rewrittenCalls.get(e);
    if (ctor && (e.variant === "withCapacity" || e.variant === "filled") && (e.enumName === "Vec" || e.enumName === "String")) {
      const n = this.peek(e.args[0]!) as bigint;
      if (n < 0n) this.panic(`negative ${e.variant === "filled" ? "length" : "capacity"}`);
    }
    if (ctor) {
      const sig = this.cr.functions.get(ctor);
      return this.callResolved(ctor, e.args, e, sig);
    }
    const reprInfo = this.cr.enums.get(e.enumName);
    if (e.variant === "tryFrom" && reprInfo?.reprType && type.tag === "enum") {
      const v = this.ev(e.args[0]!) as bigint;
      const found = [...reprInfo.variants].find(([, x]) => BigInt(x.tag) === v);
      return found ? this.mkEnum(type.name, "Some", [this.mkEnum(e.enumName, found[0], [])]) : this.mkEnum(type.name, "None", []);
    }
    const enumName = this.cr.rewrittenEnums.get(e) ?? e.enumName;
    const pm = this.pend.length;
    const args: Value[] = [];
    for (const a of e.args) args.push(this.pending(this.ev(a)));
    this.settle(pm);
    return this.mkEnum(enumName, e.variant, args);
  }

  // ── operators ──
  // S-PANIC-ABORT
  binop(e: Expr & { kind: "BinOp" }): Value {
    const tc = this.cr.variantTagCompares.get(e);
    if (tc) { const is = (this.peek(tc.operand) as EnumV).tag === tc.tag; return e.op === "!=" ? !is : is; }
    const op = this.cr.resolvedOperators.get(e);
    if (op) {
      const r = this.callResolved(op, [e.left, e.right], undefined, this.cr.functions.get(op));
      return e.op === "!=" ? r === false : r;
    }
    if (e.op === "&&") return this.peek(e.left) === true && this.peek(e.right) === true;
    if (e.op === "||") return this.peek(e.left) === true || this.peek(e.right) === true;
    const a = this.peek(e.left), b = this.peek(e.right);
    return this.binValues(e.op, a, b, this.T(e.left), this.T(e));
  }
  binValues(op: string, a: Value, b: Value, lt: TypeKind, rt: TypeKind): Value {
    if (a === MOVED || b === MOVED) this.stuck("E-STUCK", "operand was moved");
    if (isPtr(a) || isPtr(b)) { a = this.mem.addr(a); b = this.mem.addr(b); } // R-MEM-ADDR: a pointer compares as its address
    switch (op) {
      case "==": return this.equal(a, b);
      case "!=": return !this.equal(a, b);
    }
    if (typeof a === "bigint" && typeof b === "bigint") return this.intOp(op, a, b, lt.tag === "int" ? lt : (rt.tag === "int" ? rt : null));
    if (typeof a === "number" && typeof b === "number") return this.floatOp(op, a, b, lt);
    if (typeof a === "boolean" && typeof b === "boolean") {
      switch (op) { case "&": return a && b; case "|": return a || b; case "^": return a !== b; case "<": return !a && b; case ">": return a && !b; case "<=": return !a || b; case ">=": return a || !b; }
    }
    if (isStr(a) && isStr(b)) {
      if (op === "+") return concat(this, a, b);
      const c = cmpBytes(a.b.bytes, b.b.bytes);
      switch (op) { case "<": return c < 0; case ">": return c > 0; case "<=": return c <= 0; case ">=": return c >= 0; }
    }
    return this.unsupported(`binary ${op} on ${describe(a)} and ${describe(b)}`);
  }
  equal(a: Value, b: Value): boolean {
    if (a === b) return true;
    if (isStr(a) && isStr(b)) return cmpBytes(a.b.bytes, b.b.bytes) === 0;
    if (a && b && typeof a === "object" && typeof b === "object") {
      if (a.k === "enum" && b.k === "enum") return a.tag === b.tag && a.a.length === b.a.length && a.a.every((x, i) => this.equal(x, b.a[i]!));
      if (a.k === "struct" && b.k === "struct") return Object.keys(a.f).every(n => this.equal(a.f[n]!, b.f[n]!));
      if (a.k === "arr" && b.k === "arr") return a.e.length === b.e.length && a.e.every((x, i) => this.equal(x, b.e[i]!));
    }
    return false;
  }
  // S-PANIC-ABORT
  intOp(op: string, a: bigint, b: bigint, t: (TypeKind & { tag: "int" }) | null): Value {
    switch (op) {
      case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b;
    }
    const wrapping = this.isWrapping();
    let r: bigint;
    switch (op) {
      case "+": r = a + b; break;
      case "-": r = a - b; break;
      case "*": r = a * b; break;
      case "/": if (b === 0n) this.panic("division by zero"); r = a / b; break;
      case "%": if (b === 0n) this.panic("division by zero"); r = a % b; break;
      case "&": r = a & b; break;
      case "|": r = a | b; break;
      case "^": r = a ^ b; break;
      case "<<": case ">>": {
        const bits = t ? BigInt(t.bits) : 64n;
        if (b < 0n || b >= bits) { if (!wrapping) this.panic("shift amount out of range"); b &= bits - 1n; }
        r = op === "<<" ? a << b : a >> b;
        return t ? (op === "<<" ? wrapInt(r, t) : r) : r; // shl discards high bits, as a machine shift does
      }
      default: return this.unsupported(`int operator ${op}`);
    }
    if (!t) return r;
    if (wrapping || op === "&" || op === "|" || op === "^") return wrapInt(r, t);
    if (wrapInt(r, t) !== r) this.panic("integer overflow");
    return r;
  }
  // S-PANIC-ABORT
  isWrapping(): boolean {
    const f = this.frame.fn;
    return !!f && (!!f.fromWrappingModule || !!f.attributes?.some(a => a.name === "wrapping"));
  }
  floatOp(op: string, a: number, b: number, t: TypeKind): Value {
    const f = (x: number) => (t.tag === "float" && t.bits === 32 ? Math.fround(x) : x);
    switch (op) {
      case "+": return f(a + b); case "-": return f(a - b); case "*": return f(a * b); case "/": return f(a / b); case "%": return f(a % b);
      case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b;
    }
    return this.unsupported(`float operator ${op}`);
  }
  unop(e: Expr & { kind: "UnaryOp" }): Value {
    if (e.op === "&mut") return this.ev(e.operand);
    if (e.op === "*") {
      if (this.T(e.operand).tag === "ptr") return this.getPlace(this.resolve(e)); // R-MEM-LOAD: a raw load is a bitwise copy
      if (this.tempRooted(e)) return this.readTempRooted(e);
      return this.readPlace(this.resolve(e), this.cr.movedExprs.has(e), "*box");
    }
    const v = this.peek(e.operand);
    const t = this.T(e);
    switch (e.op) {
      case "-": if (typeof v === "number") return -v; if (typeof v === "bigint" && t.tag === "int") { const r = -v; if (wrapInt(r, t) !== r && !this.isWrapping()) this.panic("integer overflow"); return wrapInt(r, t); } break;
      case "!": if (typeof v === "boolean") return !v; break;
      case "~": if (typeof v === "bigint" && t.tag === "int") return wrapInt(~v, t); break;
    }
    return this.unsupported(`unary ${e.op}`);
  }
  cast(v: Value, from: TypeKind, to: TypeKind): Value {
    to = strip(to);
    if (to.tag === "int") {
      if (typeof v === "bigint") return wrapInt(v, to);
      if (typeof v === "number") {
        if (Number.isNaN(v)) return 0n;
        const lo = to.signed ? -(1n << BigInt(to.bits - 1)) : 0n, hi = to.signed ? (1n << BigInt(to.bits - 1)) - 1n : (1n << BigInt(to.bits)) - 1n;
        if (!Number.isFinite(v)) return v < 0 ? lo : hi;
        const x = BigInt(Math.trunc(v));
        return x < lo ? lo : x > hi ? hi : x;
      }
      if (typeof v === "boolean") return v ? 1n : 0n;
      if (isPtr(v)) return wrapInt(this.mem.addr(v), to);
      if (v && typeof v === "object" && v.k === "enum") return wrapInt(BigInt(v.tag), to);
    }
    if (to.tag === "float") {
      const x = typeof v === "bigint" ? Number(v) : v;
      if (typeof x === "number") return to.bits === 32 ? Math.fround(x) : x;
    }
    if (to.tag === "bool" && typeof v === "boolean") return v;
    // R-MEM-ADDR: a raw pointer is a place reference (what `x.addrOf()` gives) or the integer 0 (null); casts between pointer types keep it
    if (to.tag === "ptr") return this.mem.castToPtr(v, from, to);
    if (to.tag === "string" && isStr(v)) return this.share(v, "cast");
    return this.unsupported(`cast ${from.tag} -> ${to.tag} of ${describe(v)}`);
  }

  // ── Option / Result ──
  // S-PANIC-ABORT
  unwrap(e: Expr & { kind: "Unwrap" }): Value {
    const v = this.ev(e.operand) as EnumV;
    if (v.variant === "Some" || v.variant === "Ok") { const p = v.a[0]; v.a[0] = MOVED; this.dropValue(v); return p; }
    this.dropValue(v);
    return this.panic(v.variant === "None" ? "unwrap called on None" : "unwrap called on Err");
  }
  // `?`: forward the payload, or return the failure from the enclosing function.
  // E-PROPAGATE
  propagate(e: Expr & { kind: "Propagate" }): Value {
    if (this.cr.propagateBoxings.has(e) || this.cr.propagateMessages.has(e)) this.unsupported("? with boxing or message conversion");
    const v = this.ev(e.operand) as EnumV;
    if (v.variant === "Some" || v.variant === "Ok") { const p = v.a[0]; v.a[0] = MOVED; this.dropValue(v); return p; }
    const rt = this.frame.ret as TypeKind & { name: string };
    let ret: EnumV;
    if (v.variant === "None") ret = this.mkEnum(rt.name, "None", []);
    else {
      const c = this.cr.propagateConversions.get(e);
      ret = c ? this.mkEnum(rt.name, "Err", [this.mkEnum(c.targetEnumName, c.wrapVariant, v.a)]) : this.mkEnum(rt.name, "Err", v.a);
    }
    throw new Unwind({ k: "return", v: ret });
  }
  // E-MOVE
  defaultValue(e: Expr & { kind: "DefaultValue" }): Value {
    const v = this.ev(e.operand) as EnumV;
    if (v.variant === "Some" || v.variant === "Ok") { const p = v.a[0]; v.a[0] = MOVED; this.dropValue(v); return p; }
    this.dropValue(v);
    return this.ev(e.default);
  }
  memReplace(placeE: Expr, nv: Value): Value {
    const pl = this.resolve(placeE);
    if (pl.ro) this.stuck("T-SHARED-READONLY", "replace through a shared reference");
    const old = this.getPlace(pl);
    this.setPlace(pl, nv);
    return old;
  }
  memSwap(a: Expr, b: Expr): Value {
    const pa = this.resolve(a), pb = this.resolve(b);
    if (pa.ro || pb.ro) this.stuck("T-SHARED-READONLY", "swap through a shared reference");
    const va = this.getPlace(pa), vb = this.getPlace(pb);
    this.setPlace(pa, vb); this.setPlace(pb, va);
    return undefined;
  }

  // ── if / match / closures ──
  // E-FORK-VIEW E-FORK-OWN
  ifExpr(e: Expr & { kind: "IfExpr" }): Value {
    const mark = this.temps.length;
    const c = this.peek(e.cond) === true;
    this.dropTemps(mark);
    return this.blockValue(c ? e.thenBody : e.elseBody, this.forkOwns([e.thenBody, e.elseBody]));
  }
  // [MILO-O-forkOwnership] a fork owns its result iff some arm yields an owned value
  // E-FORK-OWN
  forkOwns(bodies: Stmt[][]): boolean {
    return bodies.some(b => {
      const last = b[b.length - 1];
      return last?.kind === "ExprStmt" && !(this.isPlaceExpr(last.expr) && !this.cr.movedExprs.has(last.expr)) && !(last.expr.kind === "Ident" && this.fns.has(last.expr.name));
    });
  }
  // the value of a block: its last expression, moved out before the block's variables drop
  blockValue(stmts: Stmt[], owns = false): Value {
    const scope: Scope = [];
    this.frame.scopes.push(scope);
    try {
      for (let i = 0; i < stmts.length - 1; i++) { const c = this.runStmt(stmts[i]!); if (c) throw new Unwind(c); }
      const last = stmts[stmts.length - 1];
      if (!last) return undefined;
      if (last.kind === "ExprStmt") {
        // a fork arm that names a place without moving it lends the value: the fork yields a view of it
        const x = last.expr;
        if (this.isPlaceExpr(x) && !this.cr.movedExprs.has(x) && !this.cr.sharedStringExprs.has(x)) {
          const pl = this.resolve(x);
          const v = this.getPlace(pl);
          if (v && typeof v === "object" && v !== MOVED && !isStr(v) && !this.copyable(v) && v.k !== "ref" && v.k !== "mut") {
            if (!owns) return this.viewOf(v);
            // E-FORK-OWN: a Drop type's place arm is consumed by the fork, any other type's is cloned
            const drops = (v.k === "struct" && this.dropImpls.has(v.name)) || (v.k === "enum" && this.dropImpls.has(v.en));
            if (drops && !pl.viaRef && !pl.ro) { this.setPlace(pl, MOVED); return v; }
            return this.deepClone(v);
          }
        }
        return this.ev(x);
      }
      const c = this.runStmt(last);
      if (c) throw new Unwind(c);
      return undefined;
    } finally { this.frame.scopes.pop(); this.dropScope(scope); }
  }

  // Subject: a moved owned value is taken into a holder the match owns, and bindings move
  // their payloads out of it; a borrowed subject (or a place that is not moved) binds refs.
  // `escape` arms (let-else) declare their bindings in the scope enclosing the match.
  matchCore<R>(subject: Expr, arms: { pattern: Pattern; run: () => R; escape?: boolean }[]): R {
    const holder: Scope = [];
    this.frame.scopes.push(holder);
    try {
      // E-MATCH-INDEX: an element of a container is matched as a clone, so an arm may overwrite the element
      const cloned = subject.kind === "IndexAccess" && this.isPlaceExpr(subject) && !this.cr.matchSubjectMut.has(subject);
      const borrowed = !cloned && (this.cr.matchSubjectRef.has(subject) || (this.isPlaceExpr(subject) && !this.cr.movedExprs.has(subject)));
      const mut = this.cr.matchSubjectMut.has(subject);
      let pl: Place;
      if (cloned) {
        const slot = this.declare("<match subject>", this.viewOf(this.getPlace(this.resolve(subject))), holder);
        pl = { slot, path: [], ro: false, viaRef: false };
      } else if (borrowed) pl = this.isPlaceExpr(subject) ? this.resolve(subject) : { slot: this.tempOwn(this.ev(subject)), path: [], ro: false, viaRef: false };
      else {
        const slot = this.declare("<match subject>", this.ev(subject), holder);
        pl = { slot, path: [], ro: false, viaRef: false };
      }
      for (const arm of arms) {
        const sv = this.getPlace(pl);
        if (sv === MOVED) this.stuck("E-STUCK", "match on a moved value");
        if (!this.patternMatches(arm.pattern, sv)) continue;
        const scope: Scope = [];
        const target = arm.escape ? this.frame.scopes[this.frame.scopes.length - 2]! : scope;
        this.frame.scopes.push(scope);
        try {
          this.bindPattern(arm.pattern, pl, borrowed, mut && !pl.ro, target);
          return arm.run();
        } finally { this.frame.scopes.pop(); this.dropScope(scope); }
      }
      return this.stuck("E-MATCH", "no arm matched");
    } finally { this.frame.scopes.pop(); this.dropScope(holder); }
  }
  // E-MATCH
  patternMatches(p: Pattern, v: Value): boolean {
    if (p.kind === "WildcardPattern") return true;
    if (p.kind === "LiteralPattern") return litEq(p.value, p.literalKind, v);
    if (!v || typeof v !== "object" || v.k !== "enum" || v.variant !== p.variant) return false;
    return (p.args ?? []).every((sub, i) => !sub || this.patternMatches(sub, v.a[i]!));
  }
  // bindings in leaf order (patternLeafNames): payload i of the subject, nested ones by path
  // E-MATCH
  bindPattern(p: Pattern, at: Place, borrowed: boolean, mut: boolean, scope: Scope): void {
    if (p.kind !== "EnumPattern") return;
    p.bindings.forEach((name, i) => {
      const sub = p.args?.[i];
      const bp: Place = { slot: at.slot, path: [...at.path, i], ro: at.ro, viaRef: at.viaRef };
      if (sub) { this.bindPattern(sub, bp, borrowed, mut, scope); return; }
      if (name === "_") return;
      let v: Value;
      if (borrowed) v = this.refTo(bp, mut);
      else { const x = this.getPlace(bp); v = this.copyable(x) ? this.share(x, name) : (this.setPlace(bp, MOVED), x); }
      this.declare(name, v, scope);
    });
  }

  // E-CLOSURE
  closure(e: Expr & { kind: "Closure" }): Value {
    const caps = this.cr.closureCaptures.get(e) ?? [];
    const shared = this.cr.sharedStringCaptures.get(e);
    const owning = !!e.isMove || caps.some(c => c.consumedInClosure);
    const env = caps.map(c => {
      const outer = this.resolveIdent(c.name);
      if (e.isMove || c.consumedInClosure || shared?.has(c.name)) {
        const v = this.readPlace(outer, !shared?.has(c.name), c.name);
        return { name: c.name, slot: { v } as Slot };
      }
      return { name: c.name, slot: { v: this.refTo(outer, c.mutable) } as Slot };
    });
    const ft = this.rawT(e);
    const ret = ft?.tag === "fn" ? ft.ret : { tag: "void" as const };
    return { k: "closure", params: e.params.map(p => p.name), paramRefs: e.params.map((_, i) => ft?.tag === "fn" && ft.params[i]?.tag === "ref"), body: e.body, env, owning, ret };
  }

  // ── calls from source ──
  // builtins that are not source functions: allocation intrinsics, memory moves, ...
  callExpr(e: CallE): Value {
    const shadow = (n: string) => { const f = this.fns.get(n); return (!!f && !f.isExtern) || this.cr.genericFnNames.has(n); };
    switch (e.func) {
      case "Heap": if (!shadow("Heap")) return { k: "box", id: this.alloc(), cell: { v: this.ev(e.args[0]!) } }; break;
      case "forget": if (!shadow("forget")) { this.ev(e.args[0]!); return undefined; } break; // the move is recorded on the operand
      case "replace": if (!shadow("replace")) return this.memReplace(e.args[0]!, this.ev(e.args[1]!)); break;
      case "swap": if (!shadow("swap")) return this.memSwap(e.args[0]!, e.args[1]!); break;
      case "_vecCopyOut": if (!shadow("_vecCopyOut")) return this.deepClone(this.peek(e.args[0]!)); break; // the structural copy std/vec's clone and filter use; capacity = length
      case "old": if (!shadow("old") && this.frame.olds?.has(e)) return this.share(this.frame.olds.get(e)!, "old"); break;
      case "targetOs": return staticStr(process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : "darwin");
      case "targetArch": return staticStr(process.arch === "x64" ? "x86_64" : "aarch64");
      case "sizeOf": case "offsetOf": case "zeroed": if (!shadow(e.func)) return this.mem.layoutBuiltin(e); break;
      case "embedFile": case "jsonStringify": return this.unsupported(`builtin ${e.func}`);
    }
    if (this.cr.cfnCalls.has(e)) return this.unsupported("call through a C function pointer");
    if (this.cr.closureCalls.has(e)) {
      const mark = this.temps.length;
      const r = this.callValue(this.peek({ kind: "Ident", name: e.func } as Expr), this.evalArgs(e.args));
      this.dropTemps(mark);
      return r;
    }
    // R-REPLAY-OFF: a replay wrapper site (cr.replaySites) is the direct extern call while record/replay is off

    const name = this.cr.rewrittenCalls.get(e) ?? e.func;
    if (BUILTIN_FNS.has(name) && !shadow(name)) return builtinCall(this, e);
    return this.callResolved(name, e.args, e);
  }
  // call the function the checker resolved `name` to; `recv` is a method receiver passed first
  // E-CALL
  callResolved(name: string, args: Expr[], e?: Expr, _sig?: unknown, recv?: Expr): Value {
    const fn = this.fns.get(name);
    const all = recv ? [recv, ...args] : args;
    const nat = this.lookupNative(normName(name));
    const flags = fn ? this.paramFlags(fn) : undefined;
    if (!nat && !fn) return this.unsupported(`call of ${name}`);
    const mark = this.temps.length;
    const argv = this.evalArgs(all, flags);
    const r = nat ? this.runNative(nat, argv, e) : this.callFn(fn!, argv);
    this.dropTemps(mark, true);
    return r;
  }
  lookupNative(name: string): Native | undefined { return nativeFor(name); }
  // The one place a native runs. A task operation (nat.co, src/interp-co-natives.ts) is a
  // generator that yields to the scheduler; only the task interpreter can run one.
  // E-CALL
  runNative(nat: Native, args: Value[], e?: Expr): Value {
    if (!nat.co) return nat(this, args, e);
    // a task operation needs the scheduler: from the plain interpreter, ask for a rerun with tasks
    if (!this.coMode) throw new NeedTasks();
    // Reached from plain code (a global's initializer, a closure a library call runs): it can run only
    // as far as it goes without parking.
    const r = nat(this, args, e) as Value | Generator<unknown, Value, unknown>;
    if (!r || typeof r !== "object" || typeof (r as { next?: unknown }).next !== "function") return r as Value;
    const step = (r as Generator<unknown, Value, unknown>).next();
    if (!step.done) return this.unsupported("a task parking inside a global initializer or a library callback");
    return step.value;
  }
  coMode = false;
  // R-CONTRACT-ENTRY: requires / ensures / loop invariants are checked only when asked, as a debug build checks them
  contractChecks = false;
  entryFile = "";

  methodCall(e: MethodE): Value {
    const ot0 = this.rawT(e.object);
    const ot = strip(ot0);
    const m = e.method;
    const special = methodNative(this, e, ot);
    if (special !== NOT_NATIVE) return special;
    const ifc = this.cr.interfaceMethodCalls.get(e);
    if (ifc) {
      let obj: Value = this.peek(e.object);
      if (obj && typeof obj === "object" && obj.k === "box") obj = obj.cell.v; // Heap<Interface>
      if (!obj || typeof obj !== "object" || obj.k !== "iface") this.stuck("E-IFACE", "method call on a non-interface value");
      const fnName = this.concreteMethodFn(obj.concrete, ifc.methodName);
      const pl = this.resolve(e.object);
      const self: Ref = isRef(obj.inner) ? obj.inner : { k: "mut", slot: pl.slot, path: [...pl.path, "iface"] as Step[] };
      return this.callNamed(fnName, [self, ...this.evalArgs(e.args)]);
    }
    const resolved = this.cr.resolvedMethods.get(e);
    if (resolved) {
      let recv: Expr = e.object;
      if (this.cr.heapMethodReceivers.has(e)) recv = { kind: "UnaryOp", op: "*", operand: e.object } as Expr; // h.m() means (*h).m()
      return this.callResolved(resolved, e.args, e, undefined, recv);
    }
    if (this.cr.fnFieldCalls.has(e)) {
      const callee = this.peek({ kind: "FieldAccess", object: e.object, field: m } as Expr);
      return this.callValue(callee, this.evalArgs(e.args));
    }
    if (m === "clone" && e.args.length === 0) return this.ev(e.object);
    return this.unsupported(`method ${m} on ${ot.tag}`);
  }
  // E-IFACE
  concreteMethodFn(typeName: string, method: string): string {
    if (this.fns.has(`${typeName}$${method}`)) return `${typeName}$${method}`;
    for (const n of this.fns.keys()) if (n.startsWith(`${typeName}$`) && n.endsWith(`$${method}`)) return n;
    return `${typeName}$${method}`;
  }

  // ── statements ──
  // S-SCOPE-END
  runStmts(stmts: Stmt[]): Completion {
    for (const s of stmts) { const c = this.runStmt(s); if (c) return c; }
    return undefined;
  }
  // a block is a scope: [S-SCOPE-END] runs when it is left by any path
  runBlock(stmts: Stmt[]): Completion {
    const scope: Scope = [];
    this.frame.scopes.push(scope);
    try { return this.runStmts(stmts); }
    finally { this.frame.scopes.pop(); this.dropScope(scope); }
  }
  // S-SCOPE-END
  runBlockIf(stmts: Stmt[] | null | undefined): Completion {
    return stmts ? this.runBlock(stmts) : undefined;
  }
  // S-TEMP
  runStmt(s: Stmt): Completion {
    const mark = this.temps.length;
    try { return this.exec(s); }
    catch (u) { if (u instanceof Unwind) return u.c; throw u; }
    finally { this.dropTemps(mark); }
  }
  // S-TEMP
  cond(e: Expr): boolean {
    const mark = this.temps.length;
    const c = this.peek(e) === true;
    this.dropTemps(mark);
    return c;
  }
  // S-LET S-VAR S-ASSIGN
  exec(s: Stmt): Completion {
    switch (s.kind) {
      case "LetDecl": case "VarDecl": return this.letStmt(s);
      case "Assign": return this.assign(s);
      case "Return": return { k: "return", v: s.value ? this.ev(s.value) : undefined };
      case "IfStmt": return this.cond(s.cond) ? this.runBlock(s.thenBody) : s.elseBody ? this.runBlock(s.elseBody) : undefined;
      case "WhileStmt": return this.whileStmt(s);
      case "BreakStmt": return { k: "break" };
      case "ContinueStmt": return { k: "continue" };
      case "ExprStmt": { const v = this.ev(s.expr); this.dropValue(v); return undefined; }
      case "MatchStmt": return this.matchCore(s.subject, s.arms.map(a => ({ pattern: a.pattern, run: () => this.runBlock(a.body) })));
      case "IfLetStmt": return this.matchCore<Completion>(s.subject, [
        { pattern: s.pattern, run: () => this.runBlock(s.thenBody) },
        { pattern: { kind: "WildcardPattern" }, run: () => this.runBlockIf(s.elseBody) },
      ]);
      case "IfChainStmt": return this.ifChain(s);
      case "LetElseStmt": {
        if (this.cr.nullRefUnwraps.has(s)) return this.unsupported("nullable extern reference unwrap");
        return this.matchCore<Completion>(s.value, [
          { pattern: s.pattern, run: () => undefined, escape: true },
          { pattern: { kind: "WildcardPattern" }, run: () => this.runBlock(s.elseBody) },
        ]);
      }
      case "UnsafeBlock": return this.runBlock(s.body);
      case "ForInStmt": return this.forIn(s);
    }
  }

  // [S-LET] / [S-VAR]
  letStmt(s: Stmt & { kind: "LetDecl" | "VarDecl" }): Completion {
    const t = this.rawT(s.value);
    if ((this.cr.viewLets.has(s) || t?.tag === "ref") && this.isPlaceExpr(s.value)) {
      const pl = this.resolve(s.value);
      this.declare(s.name, this.refTo(pl, t?.tag === "ref" && t.mutable && !pl.ro));
      return undefined;
    }
    this.declare(s.name, this.ev(s.value));
    return undefined;
  }
  // [S-ASSIGN] / [S-ASSIGN-REF]: evaluate, then drop what the place held (unless moved out)
  assign(s: Stmt & { kind: "Assign" }): Completion {
    const v = this.ev(s.value);
    const t = s.target;
    if (t.kind === "IndexAccess" && this.T(t.object).tag === "hashmap") { // m[k] = v: insert or replace
      this.mapPut(this.peek(t.object) as MapV, this.ev(t.index), v);
      return undefined;
    }
    const pl = this.resolve(t);
    if (pl.ro) this.stuck("S-ASSIGN-REF", `write to ${describeExpr(t)} through a shared reference`);
    // R-MEM-STORE: a store through a raw pointer drops nothing, since the old bytes are not an owned value
    const old = pl.slot.mem ? MOVED : this.getPlace(pl);
    this.setPlace(pl, v);
    if (old !== MOVED) this.dropValue(old);
    return undefined;
  }
  // R-CONTRACT-LOOP S-SCOPE-END
  whileStmt(s: Stmt & { kind: "WhileStmt" }): Completion {
    for (;;) {
      this.checkInvariants(s.invariants);
      if (!this.cond(s.cond)) break;
      const r = this.runBlock(s.body);
      if (r?.k === "break") return undefined;
      if (r?.k === "return") return r;
    }
    return undefined;
  }
  // `if let P = a && cond && let Q = b { then } else { else }`: clauses nest left to right, each
  // inside the scope of the ones before it; the else runs once, after every clause scope is gone.
  // S-SCOPE-END
  ifChain(s: Stmt & { kind: "IfChainStmt" }): Completion {
    const r = this.ifChainFrom(s, 0);
    if (r.ran) return r.c;
    return s.elseBody ? this.runBlock(s.elseBody) : undefined;
  }
  // S-SCOPE-END
  ifChainFrom(s: Stmt & { kind: "IfChainStmt" }, i: number): ChainStep {
    if (i === s.clauses.length) return { ran: true, c: this.runBlock(s.thenBody) };
    const cl = s.clauses[i]!;
    if (cl.kind === "CondClause") return this.cond(cl.cond) ? this.ifChainFrom(s, i + 1) : { ran: false, c: undefined };
    return this.matchCore<ChainStep>(cl.subject, [
      { pattern: cl.pattern, run: () => this.ifChainFrom(s, i + 1) },
      { pattern: { kind: "WildcardPattern" }, run: () => ({ ran: false, c: undefined }) },
    ]);
  }

  // S-SCOPE-END
  loopBody(s: Stmt & { kind: "ForInStmt" }, bind: (scope: Scope) => void): Completion | "next" {
    const scope: Scope = [];
    this.frame.scopes.push(scope);
    try {
      bind(scope);
      this.checkInvariants(s.invariants);
      const r = this.runBlock(s.body);
      if (r?.k === "break") return { k: "break" };
      if (r?.k === "return") return r;
      return "next";
    } finally { this.frame.scopes.pop(); this.dropScope(scope); }
  }
  // for-in: the loop variable is a reference to the element, or (consuming) the element moved out
  // E-NEW-ITER
  forIn(s: Stmt & { kind: "ForInStmt" }): Completion {
    const fin = (r: Completion | "next"): Completion | "next" => (r === "next" ? "next" : r?.k === "break" ? undefined : r);
    if (s.iterable.kind === "RangeExpr") {
      const lo = this.ev(s.iterable.start) as bigint, hi = this.ev(s.iterable.end) as bigint;
      for (let i = lo; i < hi; i++) {
        const r = fin(this.loopBody(s, sc => this.declare(s.varName, i, sc)));
        if (r !== "next") return r;
      }
      return undefined;
    }
    const holder: Scope = [];
    this.frame.scopes.push(holder);
    try {
      const view = this.cr.stringViewForIns.get(s);
      if (view && s.iterable.kind === "MethodCall") return this.unsupported("lines()/splitView() for-in");
      const iter = this.cr.iteratorForIns.get(s);
      if (iter) {
        // an rvalue iterator dies once, when the scope around the loop ends
        const pl = this.isPlaceExpr(s.iterable) ? this.resolve(s.iterable) : { slot: this.declare("<iterator>", this.ev(s.iterable), this.frame.scopes[this.frame.scopes.length - 2]!), path: [], ro: false, viaRef: false };
        for (;;) {
          const nx = this.callNamed(iter.nextMethod, [this.refTo(pl, true)]) as EnumV;
          if (nx.variant !== "Some") return undefined;
          const r = fin(this.loopBody(s, sc => this.declare(s.varName, nx.a[0]!, sc)));
          if (r !== "next") return r;
        }
      }
      const delegate = this.cr.iterDelegates.get(s);
      let iterE: Expr = s.iterable;
      if (delegate) iterE = { kind: "FieldAccess", object: s.iterable, field: delegate } as Expr;
      // a synthesized delegate access has no recorded type: read it off the struct
      const st = this.T(s.iterable);
      const it = delegate && st.tag === "struct" ? strip(this.cr.structs.get(st.name)?.fields.find(f => f.name === delegate)?.type) : this.T(iterE);
      if (it.tag === "hashmap") {
        const mv = (this.isPlaceExpr(iterE) ? this.peek(iterE) : this.declare("<iterable>", this.ev(iterE), holder).v) as MapV;
        for (const ent of [...mv.m.values()]) {
          const r = fin(this.loopBody(s, sc => {
            this.declare(s.varName, { k: "ref", slot: ent.key, path: [] }, sc);
            if (s.varName2) this.declare(s.varName2, { k: s.mutRef ? "mut" : "ref", slot: ent.val, path: [] }, sc);
          }));
          if (r !== "next") return r;
        }
        return undefined;
      }
      const consume = this.cr.consumingForIns.has(s) && (it.tag === "vec" || it.tag === "array");
      let pl: Place;
      if (consume || !this.isPlaceExpr(iterE)) pl = { slot: this.declare("<iterable>", this.ev(iterE), holder), path: [], ro: false, viaRef: false };
      else pl = this.resolve(iterE);
      const whole = this.getPlace(pl);
      const strIter = it.tag === "string";
      const n = strIter ? (whole as Str).b.bytes.length : this.seqLen(whole);
      for (let i = 0; i < n; i++) {
        const r = fin(this.loopBody(s, sc => {
          const ep: Place = { slot: pl.slot, path: [...pl.path, i], ro: pl.ro, viaRef: pl.viaRef };
          if (s.varName2) this.declare(s.varName, BigInt(i), sc);
          const el: Value = strIter ? BigInt((whole as Str).b.bytes[i]!)
            : consume ? this.takeOut(ep)
            : this.refTo(ep, !!s.mutRef && !pl.ro);
          this.declare(s.varName2 ?? s.varName, el, sc);
        }));
        if (r !== "next") return r;
      }
      return undefined;
    } finally { this.frame.scopes.pop(); this.dropScope(holder); }
  }
  takeOut(p: Place): Value { const v = this.getPlace(p); this.setPlace(p, MOVED); return v; }
}

// ── helpers ──
export const NOT_NATIVE = Symbol("not native");
export const isRef = (v: Value): v is Ref => !!v && typeof v === "object" && (v.k === "ref" || v.k === "mut");
export const isStr = (v: Value): v is Str => !!v && typeof v === "object" && v.k === "str";
export const prefixOf = (a: Step[], b: Step[]) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
export function wrapInt(v: bigint, t: TypeKind & { tag: "int" }): bigint { return t.signed ? BigInt.asIntN(t.bits, v) : BigInt.asUintN(t.bits, v); }
export function cmpBytes(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
export const normName = (n: string) => n.replace(/\$at\d+$/, "");
function litEq(lit: bigint | number | string | boolean, kind: string, v: Value): boolean {
  if (kind === "string") return isStr(v) && cmpBytes(v.b.bytes, [...new TextEncoder().encode(lit as string)]) === 0;
  if (kind === "int" || kind === "char") {
    if (typeof v === "number") return v === Number(lit); // an int pattern on a float subject
    return typeof v === "bigint" && v === BigInt(lit as number | bigint);
  }
  return v === lit;
}
export function describe(v: Value): string {
  if (v === undefined) return "unit";
  if (typeof v !== "object") return typeof v;
  return v.k === "struct" ? `struct ${v.name}` : v.k === "enum" ? `enum ${v.en}.${v.variant}` : v.k;
}
export function describeExpr(e: Expr): string {
  switch (e.kind) {
    case "Ident": return e.name;
    case "FieldAccess": return `${describeExpr(e.object)}.${e.field}`;
    case "IndexAccess": return `${describeExpr(e.object)}[..]`;
    case "UnaryOp": return `${e.op}${describeExpr(e.operand)}`;
    case "MethodCall": return `${describeExpr(e.object)}.${e.method}()`;
    default: return e.kind;
  }
}
export { patternLeafNames };
