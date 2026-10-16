// Ownership ledger markers (verified and stripped by src/own-ledger.ts). All no-ops unless MILO_OWN_LEDGER=1.

import type { HIRExpr } from "./hir";
import { type TypeKind, typeName } from "./types";
import type { EnumVariant } from "./codegen";
import { OWN_END_KINDS, type OwnEndKind, verifyOwnLedger, stripOwnLedger, formatOwnFinding, type OwnFinding } from "./own-ledger";

// What a byte copy (emitMemcpy, valStore) does to ownership, for the ledger. `move`: the
// source gives the bytes up (its ID ends or its slot is zeroed) and the destination owns
// them; `view`: the destination borrows and must never be dropped; `clone`: the bytes
// are a fresh deep copy the destination owns; `plain`: the type owns nothing (checked).
export type CopyIntent = "move" | "view" | "clone" | "plain";
export interface CopyDecl { intent: CopyIntent; type: TypeKind }

// What the ledger reads from the codegen frame it instruments.
export interface OwnHost {
  needsDropCg(tk: TypeKind): boolean;
  isOwnedTempExpr(e: HIRExpr): boolean;
  local(name: string): { isRef: boolean } | undefined;
  localAddr(name: string): string;
  // The alive flag of the droppable local whose slot is `addr`, if there is one.
  aliveFlagAt(addr: string): string | undefined;
  fieldFlags(addr: string): Map<string, string> | undefined;
}

// Producers of an owning type whose value has nothing to free.
const OWN_STATIC_KINDS = new Set<string>(["StringLit"]);
// Producers of a fresh owned value that isOwnedTempExpr leaves out (it lists only what
// codegen drops when discarded): the value is new, so the copy intent is a make.
const OWN_FRESH_KINDS = new Set<string>(["HashMapNew", "Closure", "HeapCreate", "OptionOp", "ArrayRepeat"]);

export class OwnLedger {
  constructor(private readonly host: OwnHost) {}

  // Off unless MILO_OWN_LEDGER=1. Every marker
  // helper is a no-op when it is off, which is what keeps a normal build's IR
  // byte-identical. IDs are module-unique; the three maps are per function (SSA names and
  // slot names repeat across functions) and are swapped out around nested closure bodies.
  // `vals`: SSA value -> the ID of the owned value it holds. `slots`: slot address ->
  // the ID of the owned value stored there. `flags`: a droppable local's alive flag ->
  // its slot's ID (one ID per slot, re-made each time the slot is re-armed).
  on = process.env.MILO_OWN_LEDGER === "1";
  nextId = 1;
  vals = new Map<string, number>();
  slots = new Map<string, number>();
  flags = new Map<string, number>();
  // `views`: SSA value -> the view ID of bytes it copied out of a place without a move
  // (copy intent `view`). `viewIds` holds every view ID, module-wide.
  views = new Map<string, number>();
  viewIds = new Set<number>();
  // SSA value -> the HIR kind that produced it, only to name an undeclared copy's source.
  producers = new Map<string, string>();
  // SSA values of an owning type that own nothing to free (a string literal points at
  // static bytes with cap 0): a fresh copy, but one with no ID to end.
  statics = new Set<string>();
  srcLine = 0;
  inGuard = false;
  // Result slots of `if`/`match` expressions of an owning type, and whether an arm moved
  // an owned value (one with a ledger ID) into the slot. The arm's ID ends there; when the
  // expression is not itself an isOwnedTempExpr producer, its result is made here instead,
  // so a consumer that never drops it (the shape blockValueOwnsResult refuses) shows up.
  resultSlots = new Map<string, { arms: number; type: TypeKind }>();
  findings: OwnFinding[] = [];

  partIds = new Map<string, number>();
  partId(addr: string, path: string, flag: string | undefined): number {
    if (flag) return this.flagId(flag);
    const key = `${addr}\0${path}`;
    let id = this.partIds.get(key);
    if (!id) { id = this.nextId++; this.partIds.set(key, id); }
    return id;
  }

  make(lines: string[], origin: string): number {
    if (!this.on) return 0;
    const id = this.nextId++;
    lines.push(`  call void @__milo_own_make(i64 ${id}) ; own ${origin.replace(/\s/g, "_")} L${this.srcLine}`);
    return id;
  }

  end(lines: string[], id: number | undefined, kind: OwnEndKind) {
    if (!this.on || !id) return;
    lines.push(`  call void @__milo_own_end(i64 ${id}, i32 ${OWN_END_KINDS.indexOf(kind)})`);
  }

  // A fresh owned value now held in SSA register `val`.
  makeVal(lines: string[], val: string, origin: string) {
    if (!this.on || !val.startsWith("%") || this.vals.has(val)) return;
    this.vals.set(val, this.make(lines, origin));
  }

  // A view is ended too: ending one is exactly the finding (drop-of-view, own-of-view).
  endVal(lines: string[], val: string, kind: OwnEndKind) {
    if (!this.on) return;
    this.end(lines, this.idOf(val), kind);
  }

  // The owned (or viewed) value in register `val` was stored whole into the frame slot
  // `addr`: same runtime value, same ID, now found by address (emitDropValue(addr) ends it).
  valToSlot(val: string, addr: string) {
    if (!this.on) return;
    const id = this.idOf(val);
    if (id) this.slots.set(addr, id);
  }

  // `to` holds the same owned bytes as `from` under a new SSA name (a re-labelling, not a
  // copy): same ID, same intent.
  inherit(from: string, to: string) {
    if (!this.on) return;
    const v = this.views.get(from);
    if (v) { this.views.set(to, v); return; }
    const id = this.vals.get(from);
    if (id) { this.vals.set(to, id); return; }
    if (this.statics.has(from) || !from.startsWith("%")) this.statics.add(to);
  }

  idOf(val: string): number | undefined {
    return this.vals.get(val) ?? this.views.get(val);
  }

  viewMarker(lines: string[], src: number, origin: string): number {
    const id = this.nextId++;
    this.viewIds.add(id);
    lines.push(`  call void @__milo_own_view(i64 ${id}, i64 ${src}) ; own view:${origin.replace(/\s/g, "_")} L${this.srcLine}`);
    return id;
  }

  // The ID a place's bytes belong to in this frame: a droppable local's slot ID (its alive
  // flag's), else whatever ID the slot holds, else 0 (owned outside this frame).
  placeId(addr: string): number {
    if (!this.on) return 0;
    const flag = this.host.aliveFlagAt(addr);
    return flag ? this.flagId(flag) : this.slots.get(addr) ?? 0;
  }

  // Copy intent of an SSA read of a place (genExpr, for any expression that is not an
  // isOwnedTempExpr producer). A moving read (`isMove`, and a `Heap` deref, which always
  // zeroes its source) hands the destination a fresh ID: the generator already ended the
  // source (alive flag cleared) or zeroed it. Any other read is a view.
  declareRead(lines: string[], val: string, expr: HIRExpr) {
    if (this.vals.has(val) || this.views.has(val)) return;
    const moving = (expr.kind === "HeapDeref" && !!expr.isMove) ||
      ((expr.kind === "Ident" || expr.kind === "FieldAccess" || expr.kind === "IndexAccess") && !!expr.isMove);
    if (expr.kind === "Ident") {
      const local = this.host.local(expr.name);
      if (local?.isRef) { this.views.set(val, this.viewMarker(lines, 0, `ref:${expr.name}`)); return; }
      if (moving) { this.makeVal(lines, val, `move:${expr.name}`); return; }
      const src = local ? this.placeId(this.host.localAddr(expr.name)) : 0;
      this.views.set(val, this.viewMarker(lines, src, expr.name));
      return;
    }
    if (expr.kind === "FieldAccess" || expr.kind === "IndexAccess" || expr.kind === "HeapDeref" || expr.kind === "PtrDeref") {
      if (moving) this.makeVal(lines, val, `move:${expr.kind}`);
      else this.views.set(val, this.viewMarker(lines, 0, expr.kind));
      return;
    }
    // `opt!`/`res?` over a place that is not zeroed (unwrapMovesPayload): the place keeps
    // the payload, so the result borrows it. Over any other operand (a combinator's
    // result) the ok path ends the operand's ID and the payload moves out with it.
    if (expr.kind === "Unwrap" || expr.kind === "Propagate") {
      const place = ["Ident", "FieldAccess", "IndexAccess", "PtrDeref", "HeapDeref"].includes(expr.operand.kind);
      if (place) this.views.set(val, this.viewMarker(lines, 0, expr.kind));
      else this.makeVal(lines, val, `${expr.kind}-payload`);
      return;
    }
    if (OWN_FRESH_KINDS.has(expr.kind)) { this.makeVal(lines, val, expr.kind); return; }
    if (OWN_STATIC_KINDS.has(expr.kind)) this.statics.add(val);
  }


  // The copy intent of storing SSA value `val` of type `tk`. In ledger mode an owned value
  // that no generator declared (made, moved or viewed) is a codegen error: a new path that
  // copies owned bytes has to say which of the three it is.
  valIntent(val: string, tk: TypeKind): CopyDecl {
    if (!this.host.needsDropCg(tk)) return { intent: "plain", type: tk };
    if (!this.on || !val.startsWith("%")) return { intent: "move", type: tk };
    if (this.views.has(val)) return { intent: "view", type: tk };
    if (this.vals.has(val)) return { intent: "move", type: tk };
    if (this.statics.has(val)) return { intent: "clone", type: tk };
    throw new Error(`own-ledger: undeclared copy of owned ${typeName(tk)} value ${val} from ${this.producers.get(val) ?? "?"} (no make, move or view declared for it)\n${this.callSite()}`);
  }

  checkCopy(copy: CopyDecl, what: string) {
    if (this.on && copy.intent === "plain" && this.host.needsDropCg(copy.type)) {
      throw new Error(`own-ledger: byte copy of owned ${typeName(copy.type)} (${what}) declared plain; say move, view or clone\n${this.callSite()}`);
    }
  }

  callSite(): string {
    return (new Error().stack ?? "").split("\n").slice(3, 7).join("\n");
  }

  // An assignment stored the owned value `id` at `target`. A droppable local's slot takes
  // it over (rearmAssignedLocal re-makes the slot right after); any other place (a field,
  // an element, a global) takes it off this frame's books.
  assigned(lines: string[], target: string, id: number | undefined) {
    if (!this.on || !id) return;
    if (this.host.aliveFlagAt(target)) this.slots.set(target, id);
    else this.end(lines, id, "STORE");
  }

  // One branch of a Result combinator consumed the receiver at `addr`: the side without a
  // callback forwards its payload (a move); the callback side passes the payload by value
  // (an argument) or lends it (`&T`), and codegen drops a lent owning payload after the
  // call (dropLentPayload in genOptionOp; `lentDropped` says whether this branch did).
  // A receiver the op only views (a named one the checker did not move in) is ended only
  // where the branch really disposes of an owning payload, so each such end is a finding.
  endResultRecv(lines: string[], addr: string, callbackSide: boolean, variant: EnumVariant, paramIsRef: boolean, lentDropped: boolean) {
    if (!this.on) return;
    const id = this.slots.get(addr);
    if (!id) return;
    const payload = variant.fieldTypeKinds[0];
    const owning = !!payload && this.host.needsDropCg(payload);
    if (this.viewIds.has(id) && !owning) return;
    if (!callbackSide || !owning) this.end(lines, id, "MOVE");
    else if (!paramIsRef) this.end(lines, id, "ARG");
    else if (lentDropped) this.end(lines, id, "DROP");
  }

  // An arm's tail value stored into an if/match result slot: bit 1 an owned value (its ID
  // ends here and the result is made below), bit 2 a view (the result is then a view), bit
  // 4 a value that owns nothing. The store is a copy like any other, so it must be declared.
  intoResult(lines: string[], slot: string, val: string) {
    if (!this.on || !this.resultSlots.has(slot)) return;
    const rs = this.resultSlots.get(slot)!;
    const intent = this.valIntent(val, rs.type).intent;
    if (intent === "move" && this.vals.has(val)) {
      this.endVal(lines, val, "MOVE");
      rs.arms |= 1;
    } else if (intent === "view") {
      rs.arms |= 2;
    } else {
      rs.arms |= 4;
    }
  }

  resultMade(lines: string[], slot: string, result: string, expr: HIRExpr) {
    if (!this.on) return;
    const arms = this.resultSlots.get(slot)?.arms ?? 0;
    if (arms & 1) {
      if (!this.host.isOwnedTempExpr(expr)) this.makeVal(lines, result, `${expr.kind}-moved-arm`);
    } else if (arms & 2) {
      this.views.set(result, this.viewMarker(lines, 0, `${expr.kind}-viewed-arm`));
    } else {
      this.statics.add(result);
    }
  }

  // A value copied whole from one frame slot to another (a spill through a scratch slot).
  moveSlot(from: string, to: string) {
    if (!this.on) return;
    const id = this.slots.get(from);
    if (id) { this.slots.delete(from); this.slots.set(to, id); }
  }

  flagIds = new Set<number>();
  flagId(flag: string): number {
    let id = this.flags.get(flag);
    if (!id) { id = this.nextId++; this.flags.set(flag, id); this.flagIds.add(id); }
    return id;
  }

  // `store i1 1` into a droppable local's alive flag: the slot owns a value again. A value
  // that reached `addr` with its own ID (a call result, a moved element) hands over to the
  // slot's ID here, so the slot's guarded drop is what must end it.
  setAlive(lines: string[], flag: string, addr: string, origin: string) {
    lines.push(`  store i1 1, ptr ${flag}`);
    const fieldFlags = this.host.fieldFlags(addr);
    if (fieldFlags) for (const f of fieldFlags.values()) lines.push(`  store i1 1, ptr ${f}`);
    if (!this.on) return;
    const id = this.flagId(flag);
    const prev = this.slots.get(addr);
    if (prev && prev !== id) this.end(lines, prev, "MOVE");
    this.slots.set(addr, id);
    lines.push(`  call void @__milo_own_make(i64 ${id}) ; own ${origin.replace(/\s/g, "_")} L${this.srcLine}`);
  }

  // `store i1 0` into an alive flag outside a drop: the value left the slot.
  clearAlive(lines: string[], flag: string, kind: OwnEndKind) {
    lines.push(`  store i1 0, ptr ${flag}`);
    if (!this.on) return;
    this.end(lines, this.flagId(flag), kind);
  }

  // Swap in fresh per-function ledger maps (a nested closure body, a synthesized helper);
  // the returned thunk restores the enclosing function's.
  // The first function entered while ownKeyExtractor is set is the sortByKey extractor
  // closure itself; one nested inside it gets the flag cleared.
  enterFn(): () => void {
    const saved = [this.vals, this.slots, this.flags, this.views, this.statics, this.srcLine, this.returnsView] as const;
    this.vals = new Map(); this.slots = new Map(); this.flags = new Map(); this.views = new Map(); this.statics = new Set();
    this.returnsView = this.keyExtractor;
    this.keyExtractor = false;
    return () => { [this.vals, this.slots, this.flags, this.views, this.statics, this.srcLine, this.returnsView] = saved; };
  }
  // Set while a sortByKey's callback is generated / inside its extractor's body.
  keyExtractor = false;
  returnsView = false;

  // Verify the finished module's markers, keep the findings, and strip them so clang sees
  // the same IR a normal build would. MILO_OWN_LEDGER_KEEP=1 keeps them (declared) for
  // reading the IR the findings' line numbers point into.
  finish(output: string[]): string[] {
    if (!this.on) return output;
    const flat = output.join("\n").split("\n");
    this.findings = verifyOwnLedger(flat);
    for (const f of this.findings) console.error(`own-ledger: ${formatOwnFinding(f)}`);
    if (process.env.MILO_OWN_LEDGER_KEEP === "1") {
      flat.push("declare void @__milo_own_make(i64)", "declare void @__milo_own_end(i64, i32)", "declare void @__milo_own_guard(i64, i1)", "declare void @__milo_own_view(i64, i64)");
      return flat;
    }
    return stripOwnLedger(flat);
  }
}
