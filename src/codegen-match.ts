// Match lowering: enum and literal (int/char/bool/float/string) matches, payload bindings, and the arm helpers shared with the fork-ownership logic.

import type { HIRStmt, HIRExpr, HIRPattern, HIRPatStep, HIRPatTest } from "./hir";
import type { TypeKind } from "./types";
import { genStringCmp, type StringCtx } from "./codegen-string";
import { LlvmTextBuilder, Ty, val, type Block, type Val } from "./ir";
import type { ForkSlot, EnumVariant, LocalInfo, DroppableLocal } from "./codegen";
import type { OwnLedger, CopyDecl } from "./codegen-own";
import { must } from "./must";

const STRING = Ty.of("%String");

// Codegen's matching members are public solely to satisfy this, they are not part of its external API.
export interface MatchCtx extends StringCtx {
  own: OwnLedger;
  locals: Map<string, LocalInfo>;
  droppableLocals: DroppableLocal[];
  structuralDropTypes: WeakSet<TypeKind>;
  nextTemp(): string;
  nextLabel(prefix?: string): string;
  localAddr(name: string): string;
  llvmType(t: TypeKind): string;
  needsDropCg(t: TypeKind): boolean;
  isOwnedTempExpr(expr: HIRExpr): boolean;
  genStmt(stmt: HIRStmt): [string[], boolean];
  genStoreInto(lines: string[], destPtr: string, ty: string, expr: HIRExpr, into?: "slot" | "store" | "return"): void;
  loadEnumTag(lines: string[], enumTy: string, addr: string): string;
  enumVariantOf(enumTy: string, variant: EnumVariant | string | number): EnumVariant;
  enumFieldPtr(lines: string[], enumTy: string, addr: string, variant: EnumVariant | string | number, k: number): string;
  zeroStore(ty: string, ptr: string): string;
  valStore(ty: string, val: string, ptr: string, copy: CopyDecl): string;
  registerFieldFlags(sink: string[], addr: string, name: string, type: TypeKind): void;
  emitGuardedDrop(lines: string[], local: DroppableLocal): void;
  emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind): void;
  forkTailIsView(tail: HIRExpr, armLocal: boolean): boolean;
  cloneViewValue(lines: string[], val: string, tk: TypeKind): string;
}

// Int patterns arrive as bigint, chars as their code in a string ("97").
function caseValue(v: bigint | number | string | boolean): bigint {
  return BigInt(v);
}

export function genLiteralMatch(ctx: MatchCtx, stmt: HIRStmt & { kind: "Match" }, resultSlot?: ForkSlot): [string[], boolean] {
  const lines: string[] = [];
  const [subjLines, subjVal, subjTy] = ctx.genExpr(stmt.subject);
  lines.push(...subjLines);
  const b = new LlvmTextBuilder(lines, ctx);
  const subj = val(subjVal, Ty.of(subjTy));

  const endBlock = b.newBlock("match.end");
  let allArmsTerminated = true;

  const literalArms: { block: Block; nextBlock: Block | null; arm: typeof stmt.arms[0] }[] = [];
  let wildcardArm: typeof stmt.arms[0] | null = null;

  for (const arm of stmt.arms) {
    if (arm.pattern.kind === "WildcardPattern") {
      wildcardArm = arm;
    } else {
      literalArms.push({ block: b.newBlock("match.arm"), nextBlock: null, arm });
    }
  }

  // Fast path — an all-integer/char match lowers to a single LLVM `switch`
  // rather than an icmp/br comparison chain. LLVM turns the switch into a jump
  // table (O(1) dispatch instead of a linear scan) and, critically, the CFG
  // stays flat: a 250-arm opcode dispatcher was becoming a 461-branch chain
  // that -O2's superlinear passes choked on (>3 min vs seconds). Requires
  // distinct case values (LLVM rejects duplicates); anything else (string,
  // bool, float, dup values) falls through to the chain below.
  const allIntCharDistinct = (() => {
    if (literalArms.length === 0) return false;
    // An int pattern can also match a float subject (`3 => ...` on an f64), and LLVM has no
    // switch over floats: that case takes the fcmp chain below.
    if (subj.ty.kind !== "int") return false;
    const seen = new Set<string>();
    for (const la of literalArms) {
      const p = la.arm.pattern;
      if (p.kind !== "LiteralPattern" || (p.literalKind !== "int" && p.literalKind !== "char")) return false;
      const key = String(p.value);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  })();

  if (allIntCharDistinct) {
    const defaultBlock = wildcardArm ? b.newBlock("match.wildcard") : b.newBlock("match.default");
    b.switch(subj, defaultBlock, literalArms.map(la => {
      const p = la.arm.pattern as HIRPattern & { kind: "LiteralPattern" };
      return [caseValue(p.value), la.block] as [bigint, Block];
    }));
    for (const la of literalArms) {
      b.position(la.block);
      const armTerminated = emitMatchArmBody(ctx, lines, la.arm.body, resultSlot);
      if (!armTerminated) { b.br(endBlock); allArmsTerminated = false; }
    }
    b.position(defaultBlock);
    if (wildcardArm) {
      const wcTerminated = emitMatchArmBody(ctx, lines, wildcardArm.body, resultSlot);
      if (!wcTerminated) { b.br(endBlock); allArmsTerminated = false; }
    } else {
      b.unreachable();
    }
    b.position(endBlock);
    if (allArmsTerminated) b.unreachable();
    return [lines, allArmsTerminated];
  }

  // chain: compare → arm body or fall through to next comparison
  for (let i = 0; i < literalArms.length; i++) {
    const next = i + 1 < literalArms.length
      ? b.newBlock("match.cmp")
      : wildcardArm
        ? b.newBlock("match.wildcard")
        : b.newBlock("match.default");
    literalArms[i].nextBlock = next;

    const pat = literalArms[i].arm.pattern;
    if (pat.kind !== "LiteralPattern") continue;

    let cmp: Val;
    if (pat.literalKind === "string") {
      ctx.hasStringType = true;
      const litStr = ctx.addString(String(pat.value));
      const lit0 = b.insertvalue(val("undef", STRING), val(litStr.label, Ty.ptr), 0);
      const lit = b.insertvalue(lit0, val(String(litStr.length - 1), Ty.i64), 1);
      const [, cmpResult] = genStringCmp(ctx, lines, subjVal, lit.ref, true);
      cmp = val(cmpResult, Ty.i1);
    } else if (pat.literalKind === "bool") {
      cmp = b.icmp("eq", subj, val(pat.value ? "1" : "0", Ty.i1));
    } else if ((pat.literalKind === "int" || pat.literalKind === "char") && subj.ty.kind === "int") {
      cmp = b.icmp("eq", subj, val(String(pat.value), subj.ty));
    } else {
      // A float pattern, or an int pattern against a float subject (the checker allows
      // `3 => ...` on an f64): compared in floating point.
      const fnum = Number(pat.value);
      const fval = Number.isInteger(fnum) ? fnum.toFixed(1) : String(fnum);
      cmp = b.fcmp("oeq", subj, val(fval, subj.ty));
    }

    b.condBr(cmp, literalArms[i].block, next);

    // arm body
    b.position(literalArms[i].block);
    const armTerminated = emitMatchArmBody(ctx, lines, literalArms[i].arm.body, resultSlot);
    if (!armTerminated) b.br(endBlock);
    if (!armTerminated) allArmsTerminated = false;

    // next comparison block (or wildcard/default)
    if (i + 1 < literalArms.length) {
      b.position(next);
    }
  }

  // wildcard or default
  const lastNext = literalArms.length > 0 ? literalArms[literalArms.length - 1].nextBlock! : b.newBlock("match.wildcard");
  if (wildcardArm) {
    if (literalArms.length === 0) {
      b.br(lastNext);
    }
    b.position(lastNext);
    const wcTerminated = emitMatchArmBody(ctx, lines, wildcardArm.body, resultSlot);
    if (!wcTerminated) b.br(endBlock);
    if (!wcTerminated) allArmsTerminated = false;
  } else {
    if (literalArms.length === 0) {
      b.br(lastNext);
    }
    b.position(lastNext);
    b.unreachable();
  }

  b.position(endBlock);
  if (allArmsTerminated) b.unreachable();
  return [lines, allArmsTerminated];
}

// The value a block produces, when it produces one: a block's value is its tail
// expression, which is how genIfExpr and the match-arm emitter already read it. Anything
// else there (a Return, a loop) leaves no value for this expression to own.
export function armTailExpr(body: HIRStmt[]): HIRExpr | null {
  const last = body[body.length - 1];
  return last && last.kind === "ExprStmt" ? last.expr : null;
}

// The names a match arm declares itself: its pattern's bindings (owned unless the
// subject is matched by reference) and its top-level `let`s.
export function matchArmLocals(arm: { pattern: HIRPattern; body: HIRStmt[] }, subjectIsRef: boolean): Set<string> {
  const out = new Set<string>();
  if (arm.pattern.kind === "EnumPattern" && !subjectIsRef) for (const b of arm.pattern.bindings) out.add(b.name);
  for (const st of arm.body) if (st.kind === "Let") out.add(st.name);
  return out;
}

export function genMatch(ctx: MatchCtx, stmt: HIRStmt & { kind: "Match" }, resultSlot?: ForkSlot): [string[], boolean] {
  // Route by the SUBJECT's type, not just the pattern kinds. genEnumMatch reads a
  // tag/payload out of the scrutinee via GEP, which is only valid for an enum. A
  // scalar matched with only a wildcard (`match x { _ => ... }`) has no literal
  // pattern, but it is NOT an enum — sending it to genEnumMatch emitted an invalid
  // `getelementptr i64` on the scalar. Only an enum subject uses the enum path.
  // `v[i]` counts as an owned temp because a read of it clones, and a match subject is
  // such a read: genStoreInto clones the element into the subject slot, which no one
  // else owns, so it goes through the temp-subject path and is freed at match exit
  // (structurally, see genTempSubjectMatch). The clone exists because an arm may mutate
  // the container (`v[i] = x`, a call that grows a `var` global; the checker allows
  // both) while payload borrows point into the subject. The one exception is a place
  // rooted at an immutable `&` binding, which genEnumMatch matches in place.
  const inPlace = stmt.subjectIsRef && stmt.subject.type.tag === "enum" && placeRootedAtImmutableRef(ctx, stmt.subject);
  if (!inPlace && ctx.isOwnedTempExpr(stmt.subject) && ctx.needsDropCg(stmt.subject.type)) {
    return genTempSubjectMatch(ctx, stmt, resultSlot);
  }
  if (stmt.subject.type.tag === "enum") return genEnumMatch(ctx, stmt, resultSlot);
  return genLiteralMatch(ctx, stmt, resultSlot);
}

// A temporary subject (`match find(k)`, `if let E.V(x) = mk().field`, `match mk().name`)
// has no other owner. It is bound to a hidden droppable local and matched as that
// local: an arm that binds the payload by value takes it and clears the alive flag
// (extractBindings), and every other arm (`_`, a fieldless variant, a literal, a
// borrowing match whose bindings point into the slot) leaves it to be dropped after
// the match, or by the return/break/continue drop glue when the arm leaves early.
// Before this, those arms leaked the subject.
function genTempSubjectMatch(ctx: MatchCtx, stmt: HIRStmt & { kind: "Match" }, resultSlot?: ForkSlot): [string[], boolean] {
  const lines: string[] = [];
  const ty = ctx.llvmType(stmt.subject.type);
  const name = `__matchsubj.${ctx.scopeCounter++}`;
  const addr = `%${name}.addr`;
  ctx.entryAllocas.push(`  ${addr} = alloca ${ty}`);
  // genStoreInto: a big-aggregate subject comes back from genExpr as a pointer.
  ctx.genStoreInto(lines, addr, ty, stmt.subject);
  const aliveFlag = `${addr}.alive`;
  ctx.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
  ctx.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
  ctx.own.setAlive(lines, aliveFlag, addr, "match-subject");
  ctx.locals.set(name, { type: ty, typeKind: stmt.subject.type, mutable: false, isRef: false, addr });
  // A `v[i]` subject is a structural clone of the element, so it is freed structurally:
  // running the element's Drop on it would release a resource the container still owns.
  let dropType = stmt.subject.type;
  if (stmt.subject.kind === "IndexAccess") { dropType = { ...dropType }; ctx.structuralDropTypes.add(dropType); }
  const local = { name, typeKind: dropType, aliveFlag, addr };
  ctx.droppableLocals.push(local);
  const subject: HIRExpr = { kind: "Ident", name, type: stmt.subject.type, isMove: false, span: stmt.subject.span };
  const [ml, terminated] = genMatch(ctx, { ...stmt, subject }, resultSlot);
  lines.push(...ml);
  if (!terminated) ctx.emitGuardedDrop(lines, local);
  return [lines, terminated];
}

// Emit a match arm's body. In statement mode (no resultSlot) every stmt runs
// as-is. In value mode (match-expression) all but the tail run as stmts and
// the tail ExprStmt's value is stored into resultSlot — same shape as IfExpr.
function emitMatchArmBody(ctx: MatchCtx, lines: string[], body: HIRStmt[], resultSlot?: ForkSlot, armDropStart = ctx.droppableLocals.length): boolean {
  if (!resultSlot) {
    for (const s of body) {
      const [sl, t] = ctx.genStmt(s);
      lines.push(...sl);
      if (t) return true;
    }
    return false;
  }
  for (let i = 0; i < body.length - 1; i++) {
    const [sl, t] = ctx.genStmt(body[i]);
    lines.push(...sl);
    if (t) return true;
  }
  if (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === "ExprStmt") {
      const [vl, gv] = ctx.genExpr(last.expr);
      lines.push(...vl);
      // A local the arm itself declared (a pattern binding, an arm `let`) is moved out
      // by the yield below. A place from outside the arm is only read unless the
      // checker moved it (isMove): the place keeps its value and its drop.
      const yieldedIdx = last.expr.kind === "Ident"
        ? ctx.droppableLocals.findIndex(d => d.addr === ctx.localAddr((last.expr as { name: string }).name)) : -1;
      const armLocal = yieldedIdx >= armDropStart;
      const vv = gv !== "void" && resultSlot.cloneViews && ctx.forkTailIsView(last.expr, armLocal)
        ? ctx.cloneViewValue(lines, gv, last.expr.type) : gv;
      if (vv !== "void") lines.push(`  store ${resultSlot.ty} ${vv}, ptr ${resultSlot.addr}`);
      // The non-moving yield below is a move codegen decides on its own (the HIR read
      // was a view): the value, not the view, is what the result slot receives.
      const yieldMoves = ctx.own.on && vv !== "void" && last.expr.kind === "Ident" && !last.expr.isMove && armLocal;
      if (yieldMoves && ctx.own.views.delete(vv)) ctx.own.makeVal(lines, vv, "yield-move");
      if (vv !== "void") ctx.own.intoResult(lines, resultSlot.addr, vv);
      // Yielding a droppable local out of the arm hands its heap data to the
      // result slot — a move, not a copy. Clear the alive flag so the arm's
      // drop does not free what the match's value now owns.
      // Matched on the local's ADDRESS, not its name: a function can hold
      // several droppable locals called the same thing in different scopes,
      // and by-name lookup cleared the first entry's flag — dropping a live
      // value belonging to an unrelated scope.
      if (vv !== "void" && last.expr.kind === "Ident") {
        const yielded = armLocal || (last.expr as { isMove?: boolean }).isMove ? ctx.droppableLocals[yieldedIdx] : undefined;
        // A moving Ident already cleared the flag (and ended the slot's ledger ID) in
        // genExpr; this second clear is then a no-op, not a second move.
        if (yielded && (last.expr as { isMove?: boolean }).isMove) lines.push(`  store i1 0, ptr ${yielded.aliveFlag}`);
        else if (yielded) ctx.own.clearAlive(lines, yielded.aliveFlag, "MOVE");
      }
    } else {
      const [sl, t] = ctx.genStmt(last);
      lines.push(...sl);
      if (t) return true;
    }
  }
  return false;
}

function genEnumMatch(ctx: MatchCtx, stmt: HIRStmt & { kind: "Match" }, resultSlot?: ForkSlot): [string[], boolean] {
  const lines: string[] = [];
  let subjAddr: string;
  let subjTy: string;
  if (stmt.subjectIsRef && stmt.subject.kind === "Ident" && ctx.locals.get(stmt.subject.name)?.isRef) {
    // `match &Enum`: read the tag/payloads through the borrow's pointer
    // directly — nothing is copied or moved. (genExpr would auto-deref the
    // ref to a value; we want the pointer itself.)
    const p = ctx.nextTemp();
    lines.push(`  ${p} = load ptr, ptr ${ctx.localAddr(stmt.subject.name)}`);
    subjAddr = p;
    subjTy = `%${stmt.enumName}`;
  } else if (stmt.subject.kind === "HeapDeref" && stmt.subject.operand.kind === "Ident") {
    const [heapLines, heapVal] = ctx.genExpr(stmt.subject.operand);
    lines.push(...heapLines);
    subjAddr = heapVal;
    subjTy = ctx.llvmType(stmt.subject.type);
  } else if (stmt.subject.kind === "Ident" && ctx.locals.has(stmt.subject.name)) {
    const local = must(ctx.locals, stmt.subject.name, "locals");
    subjAddr = ctx.localAddr(stmt.subject.name);
    subjTy = local.type;
  } else if (stmt.subjectIsRef && placeRootedAtImmutableRef(ctx, stmt.subject)) {
    // Place subject (s.field / v[i]) rooted at an immutable '&' binding:
    // match the slot in place — no clone of the enum (or its heap payloads).
    // Sound only for an immutable root: the checker rejects '&'/'&mut'
    // aliasing in one call and refs are second-class (never stored), so
    // nothing in the arm's call tree can mutate the container while payload
    // borrows are live. A mutable-rooted place keeps the clone-into-temp
    // path (genTempSubjectMatch, which drops the clone at match exit), because
    // the arm body may legally mutate the container (`v[i] = x`, or a call that
    // grows a `var` global) and invalidate the matched slot.
    const [pl, pAddr, pTy] = ctx.genLValue(stmt.subject);
    lines.push(...pl);
    subjAddr = pAddr;
    subjTy = pTy;
  } else {
    // genStoreInto, not genExpr+store: a big-aggregate subject never becomes an
    // SSA value, so genExpr hands back a POINTER for it. Storing that as if it
    // were the aggregate emitted `store %Option_Post %ptr` — invalid IR, caught
    // only by clang. `match replace(x, ...)` on an enum ≥128 bytes hit ctx.
    subjTy = ctx.llvmType(stmt.subject.type);
    subjAddr = ctx.nextTemp();
    lines.push(`  ${subjAddr} = alloca ${subjTy}`);
    ctx.genStoreInto(lines, subjAddr, subjTy, stmt.subject);
  }

  const tag = ctx.loadEnumTag(lines, subjTy, subjAddr);
  if (stmt.arms.some(a => a.pattern.kind === "EnumPattern" && a.pattern.tests)) {
    return genNestedArms(ctx, lines, stmt, subjAddr, tag, resultSlot);
  }

  const layout = must(ctx.enumLayouts, stmt.enumName, "enum layouts");
  const endLabel = ctx.nextLabel("match.end");
  const defaultLabel = ctx.nextLabel("match.default");

  const armLabels: { tag: number; label: string; arm: typeof stmt.arms[0] }[] = [];
  let wildcardArm: typeof stmt.arms[0] | null = null;
  for (const arm of stmt.arms) {
    if (arm.pattern.kind === "WildcardPattern") {
      wildcardArm = arm;
    } else if (arm.pattern.kind === "EnumPattern") {
      const label = ctx.nextLabel(`match.${arm.pattern.variant}`);
      armLabels.push({ tag: arm.pattern.tag, label, arm });
    }
  }

  const cases = armLabels.map(a => `i32 ${a.tag}, label %${a.label}`).join(" ");
  const defaultTarget = wildcardArm ? ctx.nextLabel("match.wildcard") : defaultLabel;
  lines.push(`  switch i32 ${tag}, label %${defaultTarget} [${cases}]`);

  let allArmsTerminated = true;
  for (const { label, arm } of armLabels) {
    lines.push(`${label}:`);
    const armDropStart = ctx.droppableLocals.length;
    if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.length > 0) {
      const variant = must(layout.variants, arm.pattern.variant, "variants");
      extractBindings(ctx, lines, subjAddr, subjTy, variant, arm.pattern, !!stmt.subjectIsRef, !!stmt.subjectIsMut);
    }
    const armTerminated = emitMatchArmBody(ctx, lines, arm.body, resultSlot, armDropStart);
    // Drop the arm's own bindings when it falls through: the alloca is reused
    // on the next visit, so waiting for the function epilogue would drop only
    // the final binding and leak every earlier one (a match inside a loop).
    // emitGuardedDrop clears the alive flag, so the epilogue's drop is a no-op.
    if (!armTerminated) {
      const escaping = new Set<string>();
      if (arm.pattern.kind === "EnumPattern") {
        for (const b of arm.pattern.bindings) if (b.escapes) escaping.add(ctx.localAddr(b.name));
      }
      for (let d = armDropStart; d < ctx.droppableLocals.length; d++) {
        if (escaping.has(ctx.droppableLocals[d].addr)) continue;
        ctx.emitGuardedDrop(lines, ctx.droppableLocals[d]);
      }
    }
    if (!armTerminated) lines.push(`  br label %${endLabel}`);
    if (!armTerminated) allArmsTerminated = false;
  }

  if (wildcardArm) {
    lines.push(`${defaultTarget}:`);
    const wcTerminated = emitMatchArmBody(ctx, lines, wildcardArm.body, resultSlot);
    if (!wcTerminated) lines.push(`  br label %${endLabel}`);
    if (!wcTerminated) allArmsTerminated = false;
  }

  if (!wildcardArm) {
    lines.push(`${defaultLabel}:`);
    lines.push(`  unreachable`);
  }

  lines.push(`${endLabel}:`);
  if (allArmsTerminated) lines.push(`  unreachable`);
  return [lines, allArmsTerminated];
}

// The address of the payload a pattern path names, and its LLVM type. Each step reads
// a payload of a variant the arm's tests have already confirmed, so the per-variant
// offsets enumFieldPtr computes are the right ones.
function patPathPtr(ctx: MatchCtx, lines: string[], subjAddr: string, path: HIRPatStep[]): { ptr: string; llTy: string } {
  let ptr = subjAddr;
  let llTy = "";
  for (const st of path) {
    const enumTy = `%${st.enumName}`;
    const v = ctx.enumVariantOf(enumTy, st.variant);
    ptr = ctx.enumFieldPtr(lines, enumTy, ptr, v, st.index);
    llTy = v.fieldTypes[st.index]!;
  }
  return { ptr, llTy };
}

// One sub-pattern test: does the payload at `t.path` hold that variant / equal that literal?
function genPatTest(ctx: MatchCtx, lines: string[], subjAddr: string, t: HIRPatTest): string {
  const { ptr, llTy } = patPathPtr(ctx, lines, subjAddr, t.path);
  const out = ctx.nextTemp();
  if (t.kind === "tag") {
    const tag = ctx.loadEnumTag(lines, `%${t.enumName}`, ptr);
    lines.push(`  ${out} = icmp eq i32 ${tag}, ${t.tag}`);
    return out;
  }
  const val = ctx.nextTemp();
  lines.push(`  ${val} = load ${llTy}, ptr ${ptr}`);
  if (t.literalKind === "string") {
    ctx.hasStringType = true;
    const litStr = ctx.addString(String(t.value));
    const l1 = ctx.nextTemp();
    lines.push(`  ${l1} = insertvalue %String undef, ptr ${litStr.label}, 0`);
    const l2 = ctx.nextTemp();
    lines.push(`  ${l2} = insertvalue %String ${l1}, i64 ${litStr.length - 1}, 1`);
    return genStringCmp(ctx, lines, val, l2, true)[1];
  }
  if (t.literalKind === "bool") lines.push(`  ${out} = icmp eq i1 ${val}, ${t.value ? 1 : 0}`);
  else if (t.literalKind === "float" || t.type.tag === "float") {
    // Also an int pattern on a float payload (`A(3)` with an f64 field): icmp on a double
    // is invalid IR. Number() because an int pattern's value is a bigint.
    const n = Number(t.value);
    const f = Number.isInteger(n) ? n.toFixed(1) : String(n);
    lines.push(`  ${out} = fcmp oeq ${llTy} ${val}, ${f}`);
  } else lines.push(`  ${out} = icmp eq ${llTy} ${val}, ${t.value}`);
  return out;
}

// A match with a nested arm. Arms are tried in order, each by its top tag and then its
// sub-pattern tests, and the first that passes runs; the checker has proved one does.
// Testing only reads the subject, so a failed test can fall through to the next arm
// with nothing moved. Binding happens after the choice, in the chosen arm's block, with
// the same move/borrow rule a flat arm uses (bindPayloads).
function genNestedArms(
  ctx: MatchCtx, lines: string[], stmt: HIRStmt & { kind: "Match" }, subjAddr: string, tag: string,
  resultSlot?: ForkSlot,
): [string[], boolean] {
  const endLabel = ctx.nextLabel("match.end");
  const bodyLabels = stmt.arms.map(() => ctx.nextLabel("match.arm"));
  let testLabel = ctx.nextLabel("match.test");
  lines.push(`  br label %${testLabel}`);
  stmt.arms.forEach((arm, i) => {
    lines.push(`${testLabel}:`);
    const next = ctx.nextLabel("match.test");
    if (arm.pattern.kind === "EnumPattern") {
      const top = ctx.nextTemp();
      lines.push(`  ${top} = icmp eq i32 ${tag}, ${arm.pattern.tag}`);
      let ok = ctx.nextLabel("match.sub");
      lines.push(`  br i1 ${top}, label %${ok}, label %${next}`);
      for (const t of arm.pattern.tests ?? []) {
        lines.push(`${ok}:`);
        const c = genPatTest(ctx, lines, subjAddr, t);
        ok = ctx.nextLabel("match.sub");
        lines.push(`  br i1 ${c}, label %${ok}, label %${next}`);
      }
      lines.push(`${ok}:`);
    }
    lines.push(`  br label %${bodyLabels[i]}`);
    testLabel = next;
  });
  lines.push(`${testLabel}:`);
  lines.push(`  unreachable`);

  let allArmsTerminated = true;
  stmt.arms.forEach((arm, i) => {
    lines.push(`${bodyLabels[i]}:`);
    const armDropStart = ctx.droppableLocals.length;
    const pat = arm.pattern;
    if (pat.kind === "EnumPattern" && pat.bindings.length > 0) {
      const items = pat.bindings.map((b, k) => {
        const { ptr, llTy } = patPathPtr(ctx, lines, subjAddr, b.path ?? [{ enumName: stmt.enumName, variant: pat.variant, index: k }]);
        return { name: b.name, llTy, fieldKind: b.type, fieldPtr: ptr };
      });
      const ended = bindPayloads(ctx, lines, subjAddr, items, !!stmt.subjectIsRef, !!stmt.subjectIsMut);
      // The subject stops being dropped once a binding takes a payload, and every part
      // of it a binding did not take is a matched literal or a tag. A string literal
      // payload owns its bytes, so it is freed here rather than leaked.
      if (ended) {
        for (const t of pat.tests ?? []) {
          if (t.kind !== "lit" || !ctx.needsDropCg(t.type)) continue;
          ctx.emitDropValue(lines, patPathPtr(ctx, lines, subjAddr, t.path).ptr, t.type);
        }
      }
    }
    const armTerminated = emitMatchArmBody(ctx, lines, arm.body, resultSlot, armDropStart);
    if (!armTerminated) {
      const escaping = new Set<string>();
      if (pat.kind === "EnumPattern") for (const b of pat.bindings) if (b.escapes) escaping.add(ctx.localAddr(b.name));
      for (let d = armDropStart; d < ctx.droppableLocals.length; d++) {
        if (escaping.has(ctx.droppableLocals[d].addr)) continue;
        ctx.emitGuardedDrop(lines, ctx.droppableLocals[d]);
      }
      lines.push(`  br label %${endLabel}`);
      allArmsTerminated = false;
    }
  });
  lines.push(`${endLabel}:`);
  if (allArmsTerminated) lines.push(`  unreachable`);
  return [lines, allArmsTerminated];
}

// True when `e` is a field/index chain whose root is a local bound as an
// immutable reference (a '&T' param or an immutable ref binding). Such a
// place can be matched in place: no writer to the referent can exist while
// the ref is live (see comment at the call site in genEnumMatch).
function placeRootedAtImmutableRef(ctx: MatchCtx, e: HIRExpr): boolean {
  if (e.kind !== "FieldAccess" && e.kind !== "IndexAccess") return false;
  let root: HIRExpr = e;
  while (root.kind === "FieldAccess" || root.kind === "IndexAccess") root = root.object;
  if (root.kind !== "Ident") return false;
  const local = ctx.locals.get(root.name);
  return !!local && local.isRef && !local.mutable;
}

function extractBindings(
  ctx: MatchCtx, lines: string[], subjAddr: string, subjTy: string,
  variant: EnumVariant,
  pattern: HIRPattern & { kind: "EnumPattern" },
  subjectIsRef: boolean,
  subjectIsMut = false,
) {
  if (pattern.bindings.length === 0) return;
  const items = pattern.bindings.map((b, i) => ({
    name: b.name, llTy: variant.fieldTypes[i]!, fieldKind: b.type, fieldPtr: ctx.enumFieldPtr(lines, subjTy, subjAddr, variant, i),
  }));
  bindPayloads(ctx, lines, subjAddr, items, subjectIsRef, subjectIsMut);
}

// Binds each payload at `fieldPtr` to a local named `name`: a view for a borrowing
// match, a move (zeroing the source and ending the subject) for an owning one. Returns
// whether anything was moved out, i.e. whether the subject was ended.
function bindPayloads(
  ctx: MatchCtx, lines: string[], subjAddr: string,
  items: { name: string; llTy: string; fieldKind: TypeKind; fieldPtr: string }[],
  subjectIsRef: boolean,
  subjectIsMut: boolean,
): boolean {
  let subjectEnded = false;
  const bind = (name: string, ty: string, fieldKind: TypeKind, fieldPtr: string) => {
    // Use scopeCounter (not labelCounter) so a match-binding's `%name.N.addr`
    // shares one disambiguation namespace with `let`/for-loop allocas. Two
    // counters could otherwise mint the same SSA name for same-named locals of
    // different types → "multiple definition of local value" at link time.
    const uid = ctx.scopeCounter++;
    // Ref-match of a non-Copy payload: bind a BORROW — the local holds a
    // pointer into the still-owned subject. No load, no zeroing, no drop, so
    // there is no double-free with the subject's real owner. Through a `&mut`
    // subject every payload binds this way, as a `&mut` view, so an assignment
    // to the binding stores into the payload (the checker types it `&mut T`).
    if (subjectIsMut || (subjectIsRef && ctx.needsDropCg(fieldKind))) {
      const addr = `%${name}.${uid}.addr`;
      lines.push(`  ${addr} = alloca ptr`);
      lines.push(`  store ptr ${fieldPtr}, ptr ${addr}`);
      ctx.locals.set(name, { type: ty, typeKind: { tag: "ref", inner: fieldKind, mutable: subjectIsMut }, mutable: subjectIsMut, isRef: true, addr });
      return;
    }
    const val = ctx.nextTemp();
    lines.push(`  ${val} = load ${ty}, ptr ${fieldPtr}`);
    // Owned match consumes (moves) the payload: zero the source so the
    // subject's drop chain doesn't free what the binding now owns. A ref-match
    // of a Copy payload is just a value copy — nothing to zero.
    if (!subjectIsRef && ctx.needsDropCg(fieldKind)) {
      lines.push(ctx.zeroStore(ty, fieldPtr));
      // The binding now owns the payload, so the SUBJECT must stop being dropped.
      // Zeroing the payload is not enough on its own: it makes the subject's glue
      // free a null pointer (a no-op, which is why heap payloads looked fine), but a
      // user `Drop` impl runs regardless and gets a zeroed value. For `Socket { fd:
      // i32 }` in std/http that is `close(0)` — closing stdin — on a socket that was
      // already moved out. Cleared HERE, inside the consuming arm, because an arm
      // that binds nothing leaves the subject intact and must still drop it.
      // For the ledger the subject ends once, at its first moved-out field: the later
      // fields' clears re-store the same 0 and are not further moves of the subject.
      const subjLocal = ctx.droppableLocals.find(d => d.addr === subjAddr);
      if (subjLocal && !subjectEnded) ctx.own.clearAlive(lines, subjLocal.aliveFlag, "MOVE");
      else if (subjLocal) lines.push(`  store i1 0, ptr ${subjLocal.aliveFlag}`);
      subjectEnded = true;
    }
    const addr = `%${name}.${uid}.addr`;
    lines.push(`  ${addr} = alloca ${ty}`);
    lines.push(ctx.valStore(ty, val, addr, { intent: subjectIsRef ? "view" : "move", type: fieldKind }));
    ctx.locals.set(name, { type: ty, typeKind: fieldKind, mutable: false, isRef: false, addr });
    // An owned match binding owns its payload — it was moved out of the subject
    // (the source is zeroed above), so nothing else will free it. Without drop
    // glue, `match f() { Ok(r) => { return r.id } }` leaked r entirely: one
    // SSL_CTX (~1 MB) per HTTPS request in milojs.
    if (ctx.needsDropCg(fieldKind)) {
      const aliveFlag = `${addr}.alive`;
      ctx.entryAllocas.push(`  ${aliveFlag} = alloca i1`);
      ctx.entryAllocas.push(`  store i1 0, ptr ${aliveFlag}`);
      ctx.registerFieldFlags(ctx.entryAllocas, addr, name, fieldKind);
      ctx.own.setAlive(lines, aliveFlag, addr, `match-bind:${name}`);
      ctx.droppableLocals.push({ name, typeKind: fieldKind, aliveFlag, addr });
    }
  };

  for (const it of items) bind(it.name, it.llTy, it.fieldKind, it.fieldPtr);
  return subjectEnded;
}
