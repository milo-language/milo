// Expression checking: the checkExpr dispatcher and the per-form checkers (ident, field, index, cast, binop, closure, if/is, propagate).
import type { TypeChecker } from "./checker";
import type { Expr, Span, Stmt, ArrayLit, ArrayRepeat, BinOp, CastExpr, ClosureExpr, FieldAccess, Ident, IfExpr, IndexAccess, IsExpr, Propagate, UnaryOp, Unwrap } from "./ast";
import type { TypeKind } from "./types";
import { isFieldChain, joinRanges, rewritten, unranged } from "./checker-util";
import { NEVER_TYPE, isNumeric, typeEq, typeName } from "./types";
import { floatNamespaceConst, isNestedPattern } from "./ast";
import { resolve as resolvePath } from "path";
import { memberHint } from "./suggest";
import type { CaptureInfo, PropagateBoxing, VarInfo } from "./checker";

// An integer expression composed entirely of literals (and arithmetic on
// them) — its width is unconstrained and can adopt a context type.
// The float mirror of isConstIntExpr/retypeConstInt. A float literal defaults to
// f64, so `1.0 - someF32` used to be a hard type error with no way to write the
// literal as f32 — you needed a named f32 constant. A constant-float subtree now
// adopts the other operand's width, exactly like the integer case.
export function isConstFloatExpr(c: TypeChecker, e: Expr): boolean {
  if (e.kind === "FloatLit") return true;
  if (e.kind === "BinOp") return c.isConstFloatExpr(e.left) && c.isConstFloatExpr(e.right);
  if (e.kind === "UnaryOp") return c.isConstFloatExpr(e.operand);
  return false;
}

export function retypeConstFloat(c: TypeChecker, e: Expr, t: TypeKind) {
  if (e.kind === "FloatLit") { c.exprTypes.set(e, t); return; }
  if (e.kind === "BinOp") {
    c.retypeConstFloat(e.left, t); c.retypeConstFloat(e.right, t); c.exprTypes.set(e, t); return;
  }
  if (e.kind === "UnaryOp") { c.retypeConstFloat(e.operand, t); c.exprTypes.set(e, t); return; }
}

export function isConstIntExpr(c: TypeChecker, e: Expr): boolean {
  if (e.kind === "IntLit" || e.kind === "CharLit") return true;
  if (e.kind === "BinOp") return c.isConstIntExpr(e.left) && c.isConstIntExpr(e.right);
  if (e.kind === "UnaryOp") return c.isConstIntExpr(e.operand);
  return false;
}

// Retype a constant-int subtree to `t`. Leaves go through checkExpr
// so per-literal range/overflow checks still fire against the target type.
export function retypeConstInt(c: TypeChecker, e: Expr, target: TypeKind) {
  if (e.kind === "IntLit" || e.kind === "CharLit") { c.checkExpr(e, target); return; }
  // An operator node gets the width, never the range: its folded value is checked
  // against a range by enforceRangeInto, which folds the whole constant.
  const t = unranged(target);
  if (e.kind === "BinOp") {
    c.retypeConstInt(e.left, t); c.retypeConstInt(e.right, t); c.exprTypes.set(e, t);
    // Re-check overflow against the (possibly narrower) target: the folded result can exceed
    // t even when each leaf fits it (`let x: i32 = 2147483647 + 1`). checkExpr already ran this
    // against the i64 literal default, so a coercion down to a hint needs its own check.
    if (t.tag === "int" && e.left.kind === "IntLit" && e.right.kind === "IntLit") {
      c.checkConstOverflow(e.left.value, e.right.value, e.op, t, e.span);
    }
    return;
  }
  if (e.kind === "UnaryOp") {
    // `-<literal>` at exactly signed INT_MIN (e.g. -2147483648 for i32) is valid even though
    // the bare magnitude overflows the type; range-check the negated value, not the leaf, so
    // the per-literal check below doesn't reject the magnitude in isolation.
    if (e.op === "-" && e.operand.kind === "IntLit" && t.tag === "int" && t.signed) {
      const min = -(2n ** BigInt(t.bits - 1));
      const max = 2n ** BigInt(t.bits - 1) - 1n;
      const neg = -e.operand.value;
      if (neg < min || neg > max) {
        c.error(`integer literal ${e.op}${e.operand.value} overflows i${t.bits} (range ${min}..${max})`, e.span);
      }
      c.exprTypes.set(e.operand, t); c.exprTypes.set(e, t); return;
    }
    c.retypeConstInt(e.operand, t); c.exprTypes.set(e, t); return;
  }
}

export function nameIsDefined(c: TypeChecker, name: string): boolean {
  return c.scopes.some(s => s.has(name)) || c.functions.has(name) || c.genericFns.has(name)
    || c.structs.has(name) || c.genericStructs.has(name) || c.enums.has(name)
    || c.genericEnums.has(name) || c.typeAliases.has(name) || c.cSigs.has(name);
}

// Bidirectional checking: `expected` is the type the context wants this expression to
// have (a binding's annotation, a parameter, a return type, a sibling operand), or null
// when nothing constrains it. It is a parameter rather than checker state so that a
// child checked with plain `checkExpr(child)` cannot see a hint meant for an ancestor.
// A hint is a request, not a check: callers still compare the result against what
// they wanted and report the mismatch in their own words.
export function checkExpr(chk: TypeChecker, node: Expr, expected: TypeKind | null = null): TypeKind {
  // A node the checker already replaced is checked as its replacement; every fact is filed under that.
  let expr = chk.canonicalizePreludeVariant(rewritten(chk.rewrites, node));
  let hint = expected && chk.hintFor(expr, expected);
  if (expr.kind === "EnumLit" && expr.typeArgs?.length && (expr.enumName === "Vec" || expr.enumName === "HashMap")) {
    const spelled = chk.spelledBuiltinStatic(expr);
    if (spelled === null) return chk.setType(expr, { tag: "unknown" });
    // The spelled instance is the type, as an annotation would give it; a context that
    // wants another type reports the mismatch in its own words.
    if (spelled !== "rewritten") hint = spelled;
    else expr = rewritten(chk.rewrites, expr);
  }
  if (hint && (expr.kind === "IntLit" || expr.kind === "CharLit") && hint.tag === "int") {
    if (expr.kind === "IntLit") {
      const v = expr.value;
      const { bits, signed } = hint;
      const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
      const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
      if (v < min || v > max) {
        chk.error(`integer literal ${v} overflows ${signed ? "i" : "u"}${bits} (range ${min}..${max})`, expr.span);
      }
      // A literal outside a ranged hint gets only the width; the flow it sits in then
      // rejects it. Typed as the ranged hint, it would pass as proven in-range.
      if (hint.min !== undefined && hint.max !== undefined && (v < BigInt(hint.min) || v > BigInt(hint.max))) {
        return chk.setType(expr, unranged(hint));
      }
    }
    if (expr.kind === "CharLit" && hint.min !== undefined) return chk.setType(expr, unranged(hint));
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (hint && expr.kind === "FloatLit" && hint.tag === "float") {
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "new" && hint?.tag === "vec") {
    if (expr.args.length !== 0) { chk.error(`'Vec.new' takes no arguments`, expr.span); }
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "withCapacity" && hint?.tag === "vec") {
    if (expr.args.length !== 1) { chk.error(`'Vec.withCapacity' expects 1 argument (capacity), got ${expr.args.length}`, expr.span); }
    else {
      const c = chk.checkExpr(expr.args[0]);
      if (c.tag !== "int" && c.tag !== "unknown") chk.error(`'Vec.withCapacity': capacity must be an integer, got ${chk.show(c)}`, expr.span);
    }
    chk.bindVecConstructor(expr, hint);
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (expr.kind === "EnumLit" && expr.enumName === "Vec" && expr.variant === "filled" && hint?.tag === "vec") {
    if (expr.args.length !== 2) { chk.error(`'Vec.filled' expects 2 arguments (count, value), got ${expr.args.length}`, expr.span); }
    else {
      const c = chk.checkExpr(expr.args[0]);
      if (c.tag !== "int" && c.tag !== "unknown") chk.error(`'Vec.filled': count must be an integer, got ${chk.show(c)}`, expr.span);
      // Same discard as the array literals: the fill value was hint-checked and the
      // answer dropped, so `Vec<i64> = Vec.filled(3, "a")` reached clang as `%String`
      // where an `i64` was expected.
      const fillType = chk.checkExpr(expr.args[1], hint.element);
      if (!chk.elementFits(fillType, hint.element, expr.args[1])) {
        chk.error(`'Vec.filled' value has type ${chk.show(fillType)}, but the Vec is declared ${chk.show(hint)}`, expr.args[1].span);
      }
      // The value is copied into every slot, so it must be Copy — otherwise
      // N slots would alias one heap buffer and free it N times.
      if (!chk.isCopyType(hint.element)) {
        chk.error(`'Vec.filled' requires a Copy element type (got ${chk.show(hint.element)}) — the fill value is duplicated into every slot; build a non-Copy Vec with a push loop`, expr.span);
      } else {
        chk.bindVecConstructor(expr, hint);
      }
    }
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (expr.kind === "EnumLit" && expr.enumName === "HashMap" && expr.variant === "new" && hint?.tag === "hashmap") {
    if (expr.args.length !== 0) { chk.error(`'HashMap.new' takes no arguments`, expr.span); }
    chk.bindMapConstructor(expr, hint);
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (expr.kind === "EnumLit" && expr.enumName === "HashMap" && expr.variant === "withCapacity" && hint?.tag === "hashmap") {
    if (expr.args.length !== 1) { chk.error(`'HashMap.withCapacity' expects 1 argument (capacity), got ${expr.args.length}`, expr.span); }
    else {
      const c = chk.checkExpr(expr.args[0]);
      if (c.tag !== "int" && c.tag !== "unknown") chk.error(`'HashMap.withCapacity': capacity must be an integer, got ${chk.show(c)}`, expr.span);
    }
    chk.bindMapConstructor(expr, hint);
    chk.exprTypes.set(expr, hint);
    return hint;
  }
  if (hint && expr.kind === "ArrayLit" && hint.tag === "array") {
    for (const elem of expr.elements) {
      const et = chk.checkExpr(elem, hint.element);
      if (!chk.elementFits(et, hint.element, elem)) {
        chk.error(`array element has type ${chk.show(et)}, but the array is declared ${chk.show(hint)}`, elem.span);
      }
      // The literal owns its elements: without this, `f([p, q])` against a `[T; n]`
      // param left p and q live, and both the callee and the caller dropped them.
      chk.tryMove(elem);
    }
    const result: TypeKind = { tag: "array", element: hint.element, size: expr.elements.length };
    return chk.setType(expr, result);
  }
  // Vec literal: `let v: Vec<T> = [a, b, c]` lowers to Vec.new() + N pushes in codegen.
  if (hint && expr.kind === "ArrayLit" && hint.tag === "vec") {
    for (const elem of expr.elements) {
      const et = chk.checkExpr(elem, hint.element);
      if (!chk.elementFits(et, hint.element, elem)) {
        chk.error(`Vec element has type ${chk.show(et)}, but the Vec is declared ${chk.show(hint)}`, elem.span);
      }
      chk.tryMove(elem);
    }
    return chk.setType(expr, hint);
  }
  if (hint && expr.kind === "ArrayRepeat" && hint.tag === "array") {
    const rt = chk.checkExpr(expr.value, hint.element);
    if (!chk.elementFits(rt, hint.element, expr.value)) {
      chk.error(`repeated element has type ${chk.show(rt)}, but the array is declared ${chk.show(hint)}`, expr.value.span);
    }
    const result: TypeKind = { tag: "array", element: hint.element, size: expr.count };
    return chk.setType(expr, result);
  }
  if (expr.kind === "EnumLit" && hint?.tag === "enum") {
    const sp = expr.span;
    const hintEnum = chk.enums.get(hint.name);
    if (hintEnum && (hintEnum.baseName === expr.enumName || hint.name === expr.enumName)) {
      const variant = hintEnum.variants.get(expr.variant);
      if (!variant) { chk.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return { tag: "unknown" }; }
      if (expr.args.length !== variant.fields.length) {
        chk.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
      }
      for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
        let argType = chk.checkExpr(expr.args[i], variant.fields[i]);
        // Coerce a constant-int operand to the field's int width, as fn args do.
        if (variant.fields[i].tag === "int" && argType.tag === "int" && !typeEq(variant.fields[i], argType) && chk.isConstIntExpr(expr.args[i])) {
          chk.retypeConstInt(expr.args[i], variant.fields[i]);
          argType = variant.fields[i];
        }
        if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
          chk.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${chk.show(variant.fields[i])}, got ${chk.show(argType)}`, sp);
        }
        if (variant.fields[i].tag === "int") chk.enforceRangeInto(expr.args[i], argType, variant.fields[i], expr.args[i].span);
        chk.tryMove(expr.args[i]);
      }
      chk.rewrittenEnums.set(expr, hint.name);
      chk.exprTypes.set(expr, hint);
      return hint;
    }
  }
  // Generic struct literal with a monomorphized hint — use hint to resolve type params.
  // A literal that spells its own type arguments ignores the hint: they are the
  // instance, and a disagreeing annotation is reported against the binding.
  if (hint && hint.tag === "struct" && expr.kind === "StructLit" && !expr.typeArgs?.length) {
    const genericInfo = chk.genericStructs.get(expr.name);
    const hintInfo = chk.structs.get(hint.name);
    if (genericInfo && hintInfo && hintInfo.baseName === expr.name) {
      return chk.checkStructLitAsInstance(expr, hint);
    }
  }
  const result = chk.checkExprKind(expr, hint);
  if (result.tag === "never") chk.reachable = false;
  // Coerce a constant-int subtree (`-1`, `a + 1` where every leaf is a literal)
  // to an int hint — the bare-literal branch above only catches a lone `IntLit`,
  // so a UnaryOp/BinOp wrapper (`return -1`, `let x: i64 = -1`) would otherwise
  // fail to widen. Call args, struct fields and enum payloads already do this.
  if (hint?.tag === "int" && result.tag === "int" && !typeEq(hint, result) &&
      (expr.kind === "UnaryOp" || expr.kind === "BinOp") && chk.isConstIntExpr(expr)) {
    chk.retypeConstInt(expr, hint);
    return hint;
  }
  if (hint?.tag === "float" && result.tag === "float" && !typeEq(hint, result) &&
      (expr.kind === "UnaryOp" || expr.kind === "BinOp") && chk.isConstFloatExpr(expr)) {
    chk.retypeConstFloat(expr, hint);
    return hint;
  }
  return result;
}

// Dispatch only. Every arm with a body of its own lives in a `check<Kind>Expr` method
// below, because the alternative was one 2,500-line scope in which twenty-five arms
// shared a set of locals and nothing said which arm was allowed to touch what. The
// ownership arms are the reason it matters: they are the ones that have to be readable
// in isolation to be reviewable at all. Arms that are a single `return` stay inline —
// extracting those buys no isolation and costs a jump.
// `expected` goes only to the arms that consume it; see checkExpr.
export function checkExprKind(c: TypeChecker, expr: Expr, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  switch (expr.kind) {
    case "IntLit":
      // Context-free int literals default to i64 (decision 2026-07-13): this codebase is
      // i64-dominant (arithmetic, indices, loop counters); i32 is the annotated exception.
      // Literals WITH a target-type hint still coerce via checkExpr's hint path (let x: i32 = 5).
      return c.setType(expr, { tag: "int", bits: 64, signed: true });
    case "FloatLit":
      return c.setType(expr, { tag: "float", bits: 64 });
    case "BoolLit":
      return c.setType(expr, { tag: "bool" });
    case "CharLit":
      return c.setType(expr, { tag: "int", bits: 8, signed: false });
    case "StringLit":
      c.checkMissingInterpolation(expr);
      return c.setType(expr, { tag: "string" });
    case "Ident":
      return c.checkIdentExpr(expr);
    case "BinOp":
      return c.checkBinOpExpr(expr);
    case "UnaryOp":
      return c.checkUnaryOpExpr(expr, expected);
    case "Call":
      return c.checkCallExpr(expr, expected);
    case "StructLit":
      return c.checkStructLitExpr(expr);
    case "FieldAccess":
      return c.checkFieldAccessExpr(expr);
    case "ArrayLit":
      return c.checkArrayLitExpr(expr);
    case "ArrayRepeat":
      return c.checkArrayRepeatExpr(expr);
    case "IndexAccess":
      return c.checkIndexAccessExpr(expr);
    case "EnumLit":
      return c.checkEnumLitExpr(expr, expected);
    case "Unwrap":
      return c.checkUnwrapExpr(expr);
    case "Propagate":
      return c.checkPropagateExpr(expr);
    case "DefaultValue":
      return c.checkDefaultValueExpr(expr);
    case "CastExpr":
      return c.checkCastExprExpr(expr, expected);
    case "Closure":
      return c.checkClosureExpr(expr, expected);
    case "MethodCall":
      return c.checkMethodCallExpr(expr, expected);
    case "RangeExpr":
      c.error("range expressions can only be used in 'for' loops", sp);
      return c.setType(expr, { tag: "unknown" });
    case "IsExpr":
      return c.checkIsExprExpr(expr);
    case "IfExpr":
      return c.checkIfExprExpr(expr, expected);
    case "MatchExpr":
      return c.checkMatchExprExpr(expr, expected);
  }
  // A missing arm here is a SILENT skip: the walker simply does not descend, and every
  // analysis built on it stops seeing that subtree with no error to say so. Binding the
  // scrutinee to `never` makes the next unhandled expression kind a compile error.
  const _exhaustive: never = expr;
  throw new Error(`checkExpr: unhandled expression kind '${(_exhaustive as { kind: string }).kind}'`);
}

export function checkIdentExpr(c: TypeChecker, expr: Ident): TypeKind {
  const sp = expr.span;
  const info = c.lookup(expr.name);
  if (!info) {
    // named function used as a value (function pointer)
    const fnSig = c.functions.get(expr.name);
    if (fnSig) {
      const fnType: TypeKind = { tag: "fn", params: fnSig.params.map(p => p.type), ret: fnSig.ret };
      return c.setType(expr, fnType);
    }
    const unimported = c.unimportedRenamed(expr.name, "values", sp);
    if (unimported) c.diagnostics.push({ severity: "error", span: sp, ...unimported, code: "unimported" });
    else c.error(`undefined variable '${expr.name}'`, sp, c.nameHint(expr.name));
    return c.setType(expr, { tag: "unknown" });
  }
  // A nullable extern reference is not a value. Every way of naming it — passing it on,
  // storing it, a field access, wrapping it in an `Option` — arrives here, so one gate
  // covers them all; the `let … else` unwrap is the only reader that does not, because
  // it never calls checkExpr on its subject.
  if (info.nullableRef) {
    // Marked read even though the use is rejected: the name WAS mentioned, and leaving
    // it unread stacks a bogus "unused variable" warning on top of every one of these.
    info.read = true;
    const ref = `&${info.nullableRef.mutable ? "mut " : ""}${c.show(info.nullableRef.inner)}`;
    c.error(`'${expr.name}' is a nullable extern reference and must be unwrapped before use`, sp,
      `write 'let x = ${expr.name} else { … }' — the else block runs when C passed null and must diverge; 'x' is then an ordinary '${ref}'`);
    return c.setType(expr, { tag: "unknown" });
  }
  info.read = true;
  c.identBinding.set(expr, info);
  if (info.closureSources && info.type.tag === "fn") c.checkClosureValueWrites(expr.name, info, sp);
  if (c.pendingUseNotes.size > 0) c.noteStillUsed(info, sp);
  // `unsafe` admits the read: the new owner is then the programmer's claim to make
  // (giflib's CStore keeps every buffer alive until the C caller is done with it).
  if (info.pointerSourceMoved) {
    const m = info.pointerSourceMoved;
    c.requireUnsafe(`'${expr.name}' used after its source '${m.root}' was moved (from '${m.call}' on line ${m.line})`, sp,
      `use 'forget(${m.root})' to hand the buffer to the pointer's new owner, or take the pointer after the move`);
    return c.setType(expr, c.deref(info.type));
  }
  // A use of the whole value reads every place under it (move-flow reads readPaths).
  if (c.placeBaseDepth === 0) c.eachCaptureOf(expr.name, cap => { (cap.readPaths ??= new Set()).add(""); });
  return c.setType(expr, c.deref(info.type));
}

export function checkBinOpExpr(c: TypeChecker, expr: BinOp): TypeKind {
  const sp = expr.span;
  if (expr.op === "==>" && c.contractScope === null && !c.inAssertCond) {
    c.error("`==>` is a contract operator; use `if` or `!a || b` in code", sp);
  }
  if (expr.op === "&&" || expr.op === "||" || expr.op === "==>") {
    const lt = c.checkExpr(expr.left);
    const rt = c.checkExpr(expr.right);
    if (lt.tag !== "bool" && lt.tag !== "unknown") c.error(`operator '${expr.op}' requires bool, got ${c.show(lt)}`, sp);
    if (rt.tag !== "bool" && rt.tag !== "unknown") c.error(`operator '${expr.op}' requires bool, got ${c.show(rt)}`, sp);
    return c.setType(expr, { tag: "bool" });
  }
  // An operand that takes its type from context (an if/match whose arms are literals,
  // `Option.None`) gets the other operand's type as its expected type: synthesise one
  // side, check the other against it. Left to right as evaluation runs, except an
  // argument-less enum literal on the left, which has no effects to order, or one
  // facing a plain place, whose read has none either (`Some(x) == a`).
  // A bare prelude variant (`None`, `Some(x)`) is an Ident or Call until checkExpr
  // rewrites it, which would be too late for it to count as context-typed here.
  const left = c.canonicalizePreludeVariant(rewritten(c.rewrites, expr.left));
  const right = c.canonicalizePreludeVariant(rewritten(c.rewrites, expr.right));
  const contextTyped = (e: Expr) => e.kind === "IfExpr" || e.kind === "MatchExpr" || e.kind === "EnumLit";
  const sibling = (t: TypeKind) => t.tag === "unknown" ? null : t;
  let lt: TypeKind, rt: TypeKind;
  if (left.kind === "EnumLit" && !contextTyped(right)
      && (left.args.length === 0 || isFieldChain(right))) {
    rt = c.checkExpr(right);
    lt = c.checkExpr(left, sibling(rt));
  } else {
    lt = c.checkExpr(left);
    rt = c.checkExpr(right, contextTyped(right) ? sibling(lt) : null);
  }
  // `x == f64.NAN` / `!=` is a dead comparison: NaN equals nothing, itself included,
  // so the branch is unreachable (==) or always taken (!=). Steer to isNan.
  if (expr.op === "==" || expr.op === "!=") {
    const nanSide = [left, right].some(
      e => e.kind === "FieldAccess" && floatNamespaceConst(e)?.value !== undefined && Number.isNaN(floatNamespaceConst(e)!.value));
    if (nanSide) c.warn("nan-comparison",
      `comparison with NaN is always ${expr.op === "==" ? "false" : "true"}`, sp,
      "NaN is never equal to any value; use isNan(x) from std/math");
  }
  // Integer constant coercion: a constant-int operand (a literal, or an
  // all-literal subexpression like `1 << 5` or `(a + 1)`) defaults to i32
  // but should adopt the other operand's int width. Retype the constant
  // subtree to match, so `i64var + 1 * 2` type-checks without an `as i64`.
  if (lt.tag === "int" && rt.tag === "int" && !typeEq(lt, rt)) {
    // A constant adopts the other side's WIDTH. Adopting its range too would claim
    // `r - 2147483647` has an operand in `0..2147483646`, and range propagation would
    // then prove a result range the value can leave.
    const adopt = (e: Expr, other: TypeKind & { tag: "int" }): TypeKind => {
      const base: TypeKind = { tag: "int", bits: other.bits, signed: other.signed };
      c.retypeConstInt(e, base);
      const v = other.min !== undefined ? c.constIntValue(e) : null;
      return v !== null && Number.isSafeInteger(Number(v)) ? { ...base, min: Number(v), max: Number(v) } : base;
    };
    if (c.isConstIntExpr(right)) {
      rt = adopt(right, lt);
    } else if (c.isConstIntExpr(left)) {
      lt = adopt(left, rt);
    } else {
      // A flexible const-int binding (`let m = if.. { const arms }`) used
      // against a concrete int of another width adopts that width here —
      // this is its first read, so nothing was committed at the default.
      const rInfo = c.flexIntBinding(right);
      const lInfo = c.flexIntBinding(left);
      if (rInfo && c.resolveFlexInt(rInfo, lt, right)) rt = lt;
      else if (lInfo && c.resolveFlexInt(lInfo, rt, left)) lt = rt;
    }
  }
  // Same treatment for float widths: `1.0 - f32val` retypes the literal to
  // f32 rather than demanding an annotated constant.
  if (lt.tag === "float" && rt.tag === "float" && !typeEq(lt, rt)) {
    if (c.isConstFloatExpr(right)) {
      c.retypeConstFloat(right, lt);
      rt = lt;
    } else if (c.isConstFloatExpr(left)) {
      c.retypeConstFloat(left, rt);
      lt = rt;
    }
  }
  const arithOps = ["+", "-", "*", "/", "%"];
  const cmpOps = ["==", "!=", "<", ">", "<=", ">="];
  const bitOps = ["&", "|", "^", "<<", ">>"];
  if (expr.op === "+" && lt.tag === "string" && rt.tag === "string") {
    return c.setType(expr, { tag: "string" });
  }
  if ((expr.op === "==" || expr.op === "!=") && lt.tag === "string" && rt.tag === "string") {
    return c.setType(expr, { tag: "bool" });
  }
  if (arithOps.includes(expr.op)) {
    // operator overloading for struct types
    if (lt.tag === "struct" && rt.tag === "struct" && typeEq(lt, rt)) {
      const opTraitMap: Record<string, string> = { "+": "Add", "-": "Sub", "*": "Mul", "/": "Div" };
      const traitName = opTraitMap[expr.op];
      if (traitName && c.typeImplementsTrait(lt.name, traitName)) {
        const methodName = traitName.toLowerCase();
        const mangled = `${lt.name}$${traitName}$${methodName}`;
        c.resolvedOperators.set(expr, mangled);
        c.autoBorrow(left, { mutable: false });
        c.autoBorrow(right, { mutable: false });
        return c.setType(expr, lt);
      }
    }
    if (!isNumeric(lt) && lt.tag !== "unknown") c.error(`operator '${expr.op}' requires numeric type, got ${c.show(lt)}`, sp);
    if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") c.error(`type mismatch in '${expr.op}': ${c.show(lt)} vs ${c.show(rt)}`, sp);
    if (lt.tag === "int" && left.kind === "IntLit" && right.kind === "IntLit") {
      c.checkConstOverflow(left.value, right.value, expr.op, lt, sp);
    }
    // range propagation: compute output range from operand ranges
    if (lt.tag === "int" && rt.tag === "int" && lt.min !== undefined && lt.max !== undefined && rt.min !== undefined && rt.max !== undefined) {
      const propagated = c.propagateRange(lt, rt, expr.op);
      if (propagated) return c.setType(expr, propagated);
    }
    return c.setType(expr, unranged(lt));
  }
  if (bitOps.includes(expr.op)) {
    if (lt.tag !== "int" && lt.tag !== "unknown") c.error(`operator '${expr.op}' requires integer type, got ${c.show(lt)}`, sp);
    if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") c.error(`type mismatch in '${expr.op}': ${c.show(lt)} vs ${c.show(rt)}`, sp);
    return c.setType(expr, unranged(lt));
  }
  if (cmpOps.includes(expr.op)) {
    if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") c.error(`type mismatch in '${expr.op}': ${c.show(lt)} vs ${c.show(rt)}`, sp);
    if (expr.op === "==" || expr.op === "!=") {
      if (lt.tag === "enum") {
        const info = c.enums.get(lt.name);
        if (info) {
          let hasPayload = false;
          for (const [, v] of info.variants) {
            if (v.fields.length > 0) { hasPayload = true; break; }
          }
          // Against a payload-free variant literal (`o == Option.None`) equality is
          // the tag test `o is Option.None`, which needs no payload comparison.
          const variantSide = (e: Expr) => {
            if (e.kind !== "EnumLit" || e.args.length !== 0 || c.staticCalls.has(e)) return null;
            const v = info.variants.get(e.variant);
            return v && v.fields.length === 0 ? v : null;
          };
          const rv = variantSide(right), lv = rv ? null : variantSide(left);
          if (hasPayload && typeEq(lt, rt) && (rv || lv)) {
            c.variantTagCompares.set(expr, { operand: rv ? left : right, tag: (rv ?? lv)!.tag });
          } else if (hasPayload) {
            c.error(`cannot use '${expr.op}' on enum '${lt.name}' with payload-bearing variants`, sp, `use 'match' to compare`);
          }
        }
      } else if (lt.tag === "struct") {
        if (c.typeImplementsTrait(lt.name, "Eq")) {
          const mangled = `${lt.name}$Eq$eq`;
          c.resolvedOperators.set(expr, mangled);
          c.autoBorrow(left, { mutable: false });
          c.autoBorrow(right, { mutable: false });
        } else {
          c.error(`cannot use '${expr.op}' on ${c.show(lt)}`, sp, `implement Eq trait or compare individual fields`);
        }
      } else if (lt.tag === "vec" || lt.tag === "hashmap" || lt.tag === "heap" || lt.tag === "array") {
        c.error(`cannot use '${expr.op}' on ${c.show(lt)}`, sp, `compare individual fields or implement an eq method`);
      }
    } else {
      // ordering ops: numeric or string
      if (!isNumeric(lt) && lt.tag !== "string" && lt.tag !== "unknown") c.error(`operator '${expr.op}' requires numeric or string type, got ${c.show(lt)}`, sp);
    }
    return c.setType(expr, { tag: "bool" });
  }
  c.error(`unknown operator '${expr.op}'`, sp);
  return c.setType(expr, { tag: "unknown" });
}

export function checkUnaryOpExpr(c: TypeChecker, expr: UnaryOp, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  // `-1 as i64` parses as `-(1 as i64)`; the cast is the operand, and in a signed slot
  // negating it changes nothing about its type, so it sees the expected type (for the
  // redundant-cast lint). Nothing else under a unary op does: that would retype it.
  const castHint = expr.op === "-" && expr.operand.kind === "CastExpr"
    && (expected?.tag === "float" || (expected?.tag === "int" && expected.signed)) ? expected : null;
  const ot = c.checkExpr(expr.operand, castHint);
  if (expr.op === "*") {
    if (ot.tag === "ref") return c.setType(expr, ot.inner);
    if (ot.tag === "heap") return c.setType(expr, ot.inner);
    if (ot.tag === "ptr") {
      c.requireUnsafe(`pointer dereference requires 'unsafe' block`, sp);
      return c.setType(expr, ot.inner);
    }
    if (ot.tag !== "unknown") c.error(`cannot dereference type '${c.show(ot)}' (expected &T, *T or Heap<T>)`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  if (expr.op === "-") {
    if (!isNumeric(ot) && ot.tag !== "unknown") c.error(`unary '-' requires numeric type, got ${c.show(ot)}`, sp);
    if (ot.tag === "int" && expr.operand.kind === "IntLit") {
      const result = -expr.operand.value;
      const { bits, signed } = ot;
      const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
      const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
      if (result < min || result > max) {
        c.error(`negation of ${expr.operand.value} overflows ${signed ? "i" : "u"}${bits} (range ${min}..${max})`, sp);
      }
    }
    return c.setType(expr, unranged(ot));
  }
  if (expr.op === "!") {
    if (ot.tag !== "bool" && ot.tag !== "unknown") c.error(`unary '!' requires bool, got ${c.show(ot)}`, sp);
    return c.setType(expr, { tag: "bool" });
  }
  if (expr.op === "~") {
    if (ot.tag !== "int" && ot.tag !== "unknown") c.error(`unary '~' requires integer type, got ${c.show(ot)}`, sp);
    return c.setType(expr, unranged(ot));
  }
  if (expr.op === "&mut") {
    // Reached only when takeExplicitMutArgs did not strip it, i.e. the marker is not
    // a call argument at all (a `let`, an operand, a return value, a receiver).
    c.error(`'&mut' marks an argument to a '&mut' parameter; it is not a value`, sp,
      `'&mut' is written only on a call argument: 'f(&mut x)'. A method receiver borrows implicitly: 'v.push(1)'`);
    return c.setType(expr, ot);
  }
  if (expr.op === "&") {
    // `&` is a borrow marker that appears only in a TYPE (`&T` = a borrowed
    // param). It is not an expression operator. Shared borrows are implicit (pass
    // the value bare); only `&mut` is spelled at a call site, and a raw pointer
    // comes from `v.ptr()` / `x.addrOf()`.
    c.error(`'&x' is not an expression: shared borrows are implicit (pass 'x' bare). Only a '&mut' argument is spelled out: 'f(&mut x)'. For a raw pointer use 'v.ptr()' or 'x.addrOf()'.`, sp);
    return c.setType(expr, { tag: "ptr", inner: ot });
  }
  return c.setType(expr, { tag: "unknown" });
}

export function absFile(c: TypeChecker, file: string): string {
  let abs = c.absFileCache.get(file);
  if (abs === undefined) { abs = file.startsWith("<") ? file : resolvePath(file); c.absFileCache.set(file, abs); }
  return abs;
}

export function checkFieldAccessExpr(c: TypeChecker, expr: FieldAccess): TypeKind {
  const sp = expr.span;
  // Float namespace constants resolve before the object is checked: `f64` is a type,
  // not a variable, so checkExpr(object) would report it undefined.
  const fnc = floatNamespaceConst(expr);
  if (fnc) return c.setType(expr, { tag: "float", bits: fnc.bits });
  c.placeBaseDepth++;
  let objType = c.checkExpr(expr.object);
  c.placeBaseDepth--;
  c.consumeMixedResourceFork(expr.object);
  // A field of a value whose type already failed is not a new mistake (see isPoisoned).
  if (c.isPoisoned(objType)) return c.setType(expr, { tag: "unknown" });
  // auto-deref through references for field access
  if (objType.tag === "ref") objType = objType.inner;
  // auto-deref through pointers for field access (requires unsafe)
  if (objType.tag === "ptr" && objType.inner.tag === "struct") {
    c.requireUnsafe(`pointer field access requires 'unsafe' block`, sp);
    objType = objType.inner;
  }
  if (objType.tag === "struct") {
    const info = c.structs.get(objType.name);
    if (!info) { c.error(`unknown struct '${objType.name}'`, sp); return c.setType(expr, { tag: "unknown" }); }
    const field = info.fields.find(f => f.name === expr.field);
    if (!field) { c.error(`struct '${objType.name}' has no field '${expr.field}'`, sp, memberHint(expr.field, c.fieldCandidates(objType))); return c.setType(expr, { tag: "unknown" }); }
    c.checkFieldPrivacy(objType.name, expr.field, sp);
    c.setType(expr, field.type);
    if (field.type.tag === "cfn") c.strandedCFnReads.set(expr, { struct: objType.name, field: expr.field, span: sp });
    // `setType` first: `staticFieldPath` reads the recorded types to walk the place, so the
    // answer depends on this node having one.
    const place = c.staticFieldPath(expr);
    if (place && c.lookup(place.root)) c.eachCaptureOf(place.root, cap => { (cap.readPaths ??= new Set()).add(place.path); });
    return field.type;
  }
  if (objType.tag === "enum") {
    c.error(`cannot access field on enum '${objType.name}' — use match to extract values`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  if (objType.tag === "array" && expr.field === "len") {
    // i64 for fixed arrays too (a compile-time constant), so `0..a.len` and index
    // math mix with Vec, slice and string lengths without a cast
    return c.setType(expr, { tag: "int", bits: 64, signed: true });
  }
  if (objType.tag === "string" && expr.field === "len") {
    return c.setType(expr, { tag: "int", bits: 64, signed: true });
  }
  if (objType.tag === "vec" && expr.field === "len") {
    return c.setType(expr, { tag: "int", bits: 64, signed: true });
  }
  if (objType.tag === "hashmap" && expr.field === "len") {
    return c.setType(expr, { tag: "int", bits: 64, signed: true });
  }
  c.error(`cannot access field '${expr.field}' on type ${c.show(objType)}`, sp,
    memberHint(expr.field, c.fieldCandidates(objType)));
  return c.setType(expr, { tag: "unknown" });
}

export function checkArrayLitExpr(c: TypeChecker, expr: ArrayLit): TypeKind {
  const sp = expr.span;
  if (expr.elements.length === 0) {
    c.error("cannot infer type of empty array literal", sp);
    return c.setType(expr, { tag: "unknown" });
  }
  // The literal owns its elements exactly as the hinted (`let a: [T; n] = [...]`) path
  // already records; without this, `[s]` left `s` usable after it was handed over, and
  // `[v[0]]` copied a Drop element out of `v` unchecked. Each element moves before the
  // next is checked, so `[k, k.clone()]` is a use after move, not a clone of an empty `k`.
  const elemType = c.checkExpr(expr.elements[0]);
  c.tryMove(expr.elements[0]);
  for (let i = 1; i < expr.elements.length; i++) {
    const t = c.checkExpr(expr.elements[i]);
    if (!typeEq(elemType, t) && t.tag !== "unknown") {
      c.error(`array element ${i}: expected ${c.show(elemType)}, got ${c.show(t)}`, expr.elements[i].span);
    }
    c.tryMove(expr.elements[i]);
  }
  return c.setType(expr, { tag: "array", element: elemType, size: expr.elements.length });
}

// `[v; N]` consumes `v` like any by-value use (`[v]`, `let a = v`): a non-Copy value
// moves into the last slot and the other N-1 slots get copies. A copy runs the type's
// Clone when it has one, so a user Clone (and its side effects) runs exactly N-1 times.
// A resource type (Drop, @noCopy, a raw pointer field) with no Clone cannot be copied
// at all: the copies used to be memberwise, and each one ran Drop again, so `[f; 3]`
// of a file handle closed it four times. The same rule the index read follows
// (errorIfResourceIndexRead).
export function checkArrayRepeatExpr(c: TypeChecker, expr: ArrayRepeat): TypeKind {
  const elemType = c.checkExpr(expr.value, null);
  c.tryMove(expr.value);
  if (expr.count >= 2 && !c.isCopyType(elemType)) {
    const clone = (elemType.tag === "struct" || elemType.tag === "enum") ? c.resolveMethod(elemType.name, "clone") : null;
    const res = c.resourceKind(elemType);
    if (res && (res.kind === "@noCopy" || !clone)) {
      const via = typeEq(res.via, elemType) ? "" : ` (through '${c.show(res.via)}')`;
      c.error(`cannot repeat '${c.show(elemType)}' in '[v; ${expr.count}]': it carries ${res.kind}${via}${res.kind === "@noCopy" ? "" : " and has no Clone"}`,
        expr.value.span ?? expr.span,
        res.kind === "@noCopy"
          ? `a @noCopy value has exactly one owner, so it cannot fill ${expr.count} slots. Build each element separately ('[mk(), mk()]') or use a Vec`
          : `each slot would be a memberwise copy that releases the resource again on drop. Implement Clone for '${c.show(res.via)}', or build each element separately ('[mk(), mk()]')`);
    } else if (clone) {
      c.arrayRepeatClones.set(expr, clone.mangled);
    }
  }
  return c.setType(expr, { tag: "array", element: elemType, size: expr.count });
}

export function checkIndexAccessExpr(c: TypeChecker, expr: IndexAccess): TypeKind {
  const sp = expr.span;
  c.placeBaseDepth++;
  const rawObjType = c.checkExpr(expr.object);
  c.placeBaseDepth--;
  const objType = rawObjType.tag === "ref" ? rawObjType.inner : rawObjType;
  if (objType.tag === "struct" && (objType.name === "Json" || objType.name === "JsonCur")) {
    const t = c.rewriteJsonIndex(expr, objType.name);
    if (t) return t;
  }
  const idxType = c.checkExpr(expr.index);
  if (idxType.tag !== "int" && idxType.tag !== "unknown") {
    c.error(`array index must be integer, got ${c.show(idxType)}`, sp);
  }
  if (objType.tag === "array") return c.setType(expr, objType.element);
  if (objType.tag === "vec") return c.setType(expr, objType.element);
  if (objType.tag === "string") return c.setType(expr, { tag: "int", bits: 8, signed: false });
  if (objType.tag === "ptr") {
    c.requireUnsafe(`pointer indexing requires 'unsafe' block`, sp);
    return c.setType(expr, objType.inner);
  }
  c.error(`cannot index type ${c.show(objType)}`, sp);
  return c.setType(expr, { tag: "unknown" });
}

export function checkUnwrapExpr(c: TypeChecker, expr: Unwrap): TypeKind {
  const sp = expr.span;
  const operandType = c.checkExpr(expr.operand);
  const inner = c.unwrapableInner(operandType);
  if (!inner) {
    c.error(`'!' requires Option or Result type, got ${c.show(operandType)}`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  // `!` moves the payload out and codegen zeros the source slot; mark the
  // operand moved so a later use is a compile error, not a silent read of
  // the zeroed value. tryMove no-ops on Copy operands.
  c.tryMove(expr.operand);
  return c.setType(expr, inner);
}

export function checkPropagateExpr(c: TypeChecker, expr: Propagate): TypeKind {
  const sp = expr.span;
  const operandType = c.checkExpr(expr.operand);
  const inner = c.unwrapableInner(operandType);
  if (!inner) {
    c.error(`'?' requires Option or Result type, got ${c.show(operandType)}`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  // `?` consumes the operand (Err returns it, Ok extracts the payload and
  // codegen zeros the slot); mark it moved so a later use errors instead of
  // silently reading the zeroed value. tryMove no-ops on Copy operands.
  c.tryMove(expr.operand);
  const retInner = c.unwrapableInner(c.currentFnRetType);
  if (!retInner) {
    c.error(`'?' requires function to return Option or Result, but returns ${c.show(c.currentFnRetType)}`, sp);
    return c.setType(expr, inner);
  }
  // Option ? in Option fn, or Result ? in Result fn — match error side only
  const operandIsOption = c.isOptionLike(operandType);
  const retIsOption = c.isOptionLike(c.currentFnRetType);
  if (operandIsOption !== retIsOption) {
    c.error(`'?' on ${operandIsOption ? "Option" : "Result"} requires function to return ${operandIsOption ? "Option" : "Result"}, but returns ${c.show(c.currentFnRetType)}`, sp);
  } else if (!operandIsOption) {
    // both Result-like: Err types must match, or From conversion must exist
    const operandErr = c.unwrapableErr(operandType);
    const retErr = c.unwrapableErr(c.currentFnRetType);
    if (operandErr && retErr && !typeEq(operandErr, retErr)) {
      const boxing = c.findPropagateBoxing(operandErr, retErr, sp);
      const conversion = boxing === null ? c.findFromConversion(operandErr, retErr) : null;
      if (boxing === "reported") {
        // findPropagateBoxing already said why
      } else if (boxing) {
        c.propagateBoxings.set(expr, boxing);
      } else if (conversion) {
        c.propagateConversions.set(expr, conversion);
      } else if (retErr.tag === "string" && (operandErr.tag === "struct" || operandErr.tag === "enum")
        && c.typeSatisfiesInterface(typeName(operandErr), "Error")) {
        c.propagateMessages.set(expr, { name: typeName(operandErr), errType: operandErr });
      } else {
        c.error(`'?' error type mismatch: '${c.show(operandErr)}' cannot convert to '${c.show(retErr)}' (no wrapping variant found)`, sp);
      }
    }
  }
  return c.setType(expr, inner);
}

export function checkCastExprExpr(c: TypeChecker, expr: CastExpr, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  const fromType = c.checkExpr(expr.operand);
  const toType = c.resolve(expr.targetType);
  c.lintRedundantCast(expr, toType, expected);
  // A repr'd (C-like) enum casts to its integer value — always defined, since every
  // variant has a discriminant. Only to an integer type: `Kind.tryFrom` is the reverse.
  const fromReprEnum = fromType.tag === "enum" && !!c.enums.get(fromType.name)?.reprType;
  if (fromReprEnum && toType.tag !== "int") {
    c.error(`enum '${fromType.name}' casts only to an integer type, not ${c.show(toType)}`, sp);
  }
  const fromOk = isNumeric(fromType) || fromType.tag === "bool" || fromType.tag === "ptr" || fromType.tag === "array" || fromType.tag === "fn" || fromType.tag === "cfn" || fromType.tag === "string" || fromType.tag === "unknown" || fromReprEnum;
  // ptr -> cfn is how a dlsym result becomes callable; cfn -> ptr passes one back out
  const toOk = isNumeric(toType) || toType.tag === "ptr" || toType.tag === "cfn";
  if (!fromOk) {
    c.error(`cannot cast from ${c.show(fromType)}`, sp);
  }
  if (!toOk) {
    c.error(`cannot cast to ${c.show(toType)}`, sp);
  }
  // An array, string, closure or C fn casts to a POINTER (its data, its code); to an
  // integer it has no meaning, and codegen emitted `add [16 x i8]` for `arr as i64`
  // and clang rejected the module far from the line that wrote it.
  if ((fromType.tag === "array" || fromType.tag === "string" || fromType.tag === "fn" || fromType.tag === "cfn") && toType.tag !== "ptr" && toType.tag !== "cfn") {
    c.error(`cannot cast ${c.show(fromType)} to ${c.show(toType)}: only to a pointer`, sp,
      `cast to '*u8' first, then to an integer: '(x as *u8) as i64'`);
  }
  // To an `extern` fn type only from a pointer (a dlsym result) or another C fn
  // pointer. An integer or a Milo fn passed the checker and then failed in clang:
  // a Milo fn's calling convention is not C's, and an integer has to be a pointer first.
  if (toType.tag === "cfn" && fromType.tag !== "ptr" && fromType.tag !== "cfn" && fromType.tag !== "unknown") {
    c.error(`cannot cast ${c.show(fromType)} to ${c.show(toType)}: only a pointer casts to an extern fn type`, sp,
      fromType.tag === "fn"
        ? `hand a top-level fn to C as 'f as *u8', and declare the C side's signature there`
        : `cast to a pointer first: '(x as *u8) as ${c.show(toType)}'`);
  }
  // Calling the result jumps to whatever address it holds, so making one is unsafe,
  // as a cast to a pointer type is.
  else if (toType.tag === "cfn" && fromType.tag !== "unknown") {
    c.requireUnsafe(`cast to an extern fn type requires 'unsafe' block`, sp);
  }
  const isNullPtrConst = toType.tag === "ptr" && expr.operand.kind === "IntLit" && expr.operand.value === 0n;
  if (toType.tag === "ptr" && !isNullPtrConst) {
    c.requireUnsafe(`cast to pointer type requires 'unsafe' block`, sp);
  }
  // `x as i32(0..9)` is a checked conversion: the cast converts to the base width and
  // the result is range-checked like any flow into the type. Unchecked, the cast was a
  // safe way to mint an out-of-range value, which a niche Option would read as None.
  if (toType.tag === "int" && toType.min !== undefined) {
    const viaBase: TypeKind = isNumeric(fromType) && fromType.tag === "int" && fromType.bits <= toType.bits ? fromType : { tag: "int", bits: toType.bits, signed: toType.signed };
    c.enforceRangeInto(expr, viaBase, toType, sp);
  }
  return c.setType(expr, toType);
}

export function lintRedundantCast(c: TypeChecker, expr: CastExpr, toType: TypeKind, expected: TypeKind | null) {
  const neg = expr.operand.kind === "UnaryOp" && expr.operand.op === "-";
  const lit = neg && expr.operand.kind === "UnaryOp" ? expr.operand.operand : expr.operand;
  if (lit.kind !== "IntLit" && lit.kind !== "FloatLit") return;
  if (c.currentFnIsDep) return; // as extern-call: a dependency is not the reader's to edit; std is held to zero
  if (!expected) { c.castsCheckedBare.add(expr); return; }
  if (c.castsCheckedBare.has(expr) || c.instanceNodes.has(expr) || !typeEq(expected, toType)) return;
  if (expected.tag === "int" && expected.min !== undefined) return; // a range type checks the literal; the cast skips that
  if (lit.kind === "FloatLit" ? toType.tag !== "float" : toType.tag !== "int") return;
  if (lit.kind === "IntLit" && toType.tag === "int") {
    // `300 as u8` truncates; only a value the type holds is unchanged by the cast.
    const v = neg ? -lit.value : lit.value;
    const min = toType.signed ? -(2n ** BigInt(toType.bits - 1)) : 0n;
    const max = toType.signed ? 2n ** BigInt(toType.bits - 1) - 1n : 2n ** BigInt(toType.bits) - 1n;
    if (v < min || v > max) return;
  }
  const t = c.show(toType);
  c.warn("redundant-cast", `redundant cast: this literal is already '${t}' here`, expr.span,
    `the expected type makes it '${t}'; drop ' as ${t}' (and its parentheses)`);
}

// A closure literal passed to a `move` parameter becomes a move closure: the callee may
// keep it, so it must own its captures. One passed to a plain parameter stays
// by-reference, since the callee cannot keep it (checkNonEscapingParams), and that is
// what lets it borrow locals and `self`. `keepsWriteBack` names the captures that need
// write-back to the original, which a move would drop; such a literal stays
// by-reference and checkEscapingClosures rejects it at a `move` parameter. `always` is
// for a call through a fn value, whose parameter types cannot say what the target does.
// `move` as written, or promoted by the checker (recorded in moveClosures; applyRewrites sets the flag).
export function isMoveClosure(c: TypeChecker, e: Expr): boolean {
  return c.moveClosures.has(e) || !!(e as { isMove?: boolean }).isMove;
}

// A move closure's env is storage that outlives the frame, and references are
// second-class: `let s = v[0..2]; return move () => s[0]` read freed memory. A
// by-reference closure may capture one, since it cannot leave the borrow's scope.
export function errorOnRefCaptures(c: TypeChecker, expr: Expr, captures: CaptureInfo[], why: string) {
  for (const cap of captures) {
    if (cap.type.tag !== "ref") continue;
    c.error(`cannot capture '${cap.name}' in a 'move' closure`, expr.span,
      `'${cap.name}' is a reference, and ${why} and may outlive what '${cap.name}' points into; capture an owned value (.clone() it) instead`);
  }
}

export function checkClosureExpr(chk: TypeChecker, expr: ClosureExpr, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  const paramHints = expected?.tag === "fn" ? expected.params : null;
  const retHint = expected?.tag === "fn" ? expected.ret : null;
  chk.pushScope();
  const frame = { depth: chk.scopes.length - 1, captures: new Map<string, CaptureInfo>() };
  chk.closureFrames.push(frame);
  const paramTypes: TypeKind[] = [];
  for (let i = 0; i < expr.params.length; i++) {
    const p = expr.params[i];
    let pType: TypeKind;
    if (p.type) {
      pType = chk.resolve(p.type);
    } else if (paramHints && i < paramHints.length) {
      pType = paramHints[i];
    } else {
      chk.error(`cannot infer type for parameter '${p.name}'; add a type annotation`, sp);
      pType = { tag: "unknown" };
    }
    paramTypes.push(pType);
    chk.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, borrowed: false, read: false, span: p.span,
      ...(pType.tag !== "ref" && { byValueParam: true }) });
  }
  // An explicit annotation always wins; otherwise take the caller's expected return
  // type so literals in the body get coerced against it (`() => 0` against an
  // Option<i32> is i32, not i64). Falls back to inferring from the body, which is
  // what a hint of `unknown` (e.g. Vec.map, whose U is whatever you return) leaves.
  let inferredRet: TypeKind = expr.retType
    ? chk.resolve(expr.retType)
    : (retHint && retHint.tag !== "unknown" ? retHint : { tag: "unknown" });
  const savedRetType = chk.currentFnRetType;
  chk.currentFnRetType = inferredRet;
  // A closure body is a fresh function body: its `return` returns from the CLOSURE,
  // and any loop enclosing the closure literal is not a loop around these statements.
  // Leaving the enclosing loop state visible here let a move inside the body be
  // credited as "moved only on a path that returns", which the loop-move check then
  // excuses AND resets — so `while … { spawn(move () => f(s)) }` compiled clean and
  // handed every iteration after the first an empty `s`. Wrong values, no diagnostic.
  // The direct spelling (`s.len` rather than `f(s)`) was rejected, which is the
  // give-away: one operation, two spellings, two answers.
  const savedLoopDepth = chk.loopDepth;
  const savedReachable = chk.reachable;
  chk.loopDepth = 0;
  chk.reachable = true;
  for (const s of expr.body) chk.checkStmt(s, inferredRet);
  chk.loopDepth = savedLoopDepth;
  chk.reachable = savedReachable;
  if (inferredRet.tag === "unknown" && expr.body.length > 0) {
    const lastStmt = expr.body[expr.body.length - 1];
    if (lastStmt.kind === "Return" && lastStmt.value) {
      inferredRet = chk.exprTypes.get(rewritten(chk.rewrites, lastStmt.value)) ?? { tag: "void" };
      if (inferredRet.tag === "never") inferredRet = { tag: "void" };
    } else if (lastStmt.kind === "ExprStmt") {
      inferredRet = { tag: "void" };
    } else {
      inferredRet = { tag: "void" };
    }
  }
  chk.errorIfFallsOff("closure", expr.body, inferredRet, expr.span);
  chk.currentFnRetType = savedRetType;
  chk.popScope();
  const captures = Array.from(frame.captures.values());
  chk.closureCaptures.set(expr, captures);
  // A closure that moves a capture out has to own it: through a by-reference slot the
  // move would empty the caller's variable behind its back, and the caller's own drop
  // then freed it a second time. So such a literal is a move closure (call-once), like
  // one written `move`; one that also writes another capture back cannot be either.
  const consumed = captures.find(c => c.consumedInClosure);
  if (consumed && !chk.isMoveClosure(expr)) {
    const written = captures.find(c => c.mutatedInClosure);
    if (written) {
      chk.error(`closure moves '${consumed.name}' out and also assigns to '${written.name}'`, expr.span,
        `moving a capture out needs a 'move' closure, which owns copies of its captures, so the write to '${written.name}' would be lost; return the new value instead, or clone '${consumed.name}' before moving it`);
    } else {
      chk.moveClosures.add(expr);
      chk.errorOnRefCaptures(expr, captures, `this closure moves '${consumed.name}' out, so it owns its captures`);
    }
  } else if (chk.isMoveClosure(expr)) {
    chk.errorOnRefCaptures(expr, captures, "a 'move' closure owns its captures");
  }
  for (const cap of captures) {
    for (let i = chk.scopes.length - 1; i >= 0; i--) {
      const info = chk.scopes[i].get(cap.name);
      if (info) {
        // The capture was recorded (in lookup) at the binding's FIRST read inside the
        // body, before that read could resolve a flexInt binding: `let n = 2` is i64
        // until `x + n` against an i32 narrows it. Re-read the type now so the env
        // slot matches the width every use in the body was checked against.
        cap.type = info.type;
        cap.info = info;
        chk.freeze(info, null, "capture", null, { span: expr.span, via: "capture" });
        break;
      }
    }
  }
  chk.closureFrames.pop();
  // Owning only when it MOVED something in. `move` with no captures lowers to a null
  // environment and owns nothing, so typing it as owning would make it non-Copy for no
  // reason; a by-reference closure's environment is a stack slot in the frame that built
  // it, which that frame already owns. Only a move closure with captures holds heap.
  const owning = chk.isMoveClosure(expr) && captures.length > 0;
  return chk.setType(expr, owning
    ? { tag: "fn", params: paramTypes, ret: inferredRet, owning: true }
    : { tag: "fn", params: paramTypes, ret: inferredRet });
}

// `doc[k]` on a Json place, or `chain[k]` on a chain that started at one, becomes
// `doc.idxKey(start, k)` / `idxPos` / `idxCur` and is re-checked as that call. The
// root is re-borrowed at every step instead of carried in a value because references
// are second-class: nothing could hold `&Json` between steps. Returns null to let a
// non-chain `JsonCur` fall through to the ordinary "cannot index" error.
export function rewriteJsonIndex(c: TypeChecker, expr: IndexAccess, objName: string): TypeKind | null {
  let root: Expr;
  let start: Expr;
  if (objName === "Json") {
    if (!c.isJsonRootPlace(expr.object)) {
      c.error(`index a Json held in a variable: bind it first ('let doc = ...' then 'doc[...]')`, expr.span);
      return c.setType(expr, { tag: "unknown" });
    }
    root = expr.object;
    start = { kind: "MethodCall", object: structuredClone(root), method: "idxRoot", args: [], span: expr.span } as Expr;
  } else {
    const r = c.jsonChains.get(rewritten(c.rewrites, expr.object));
    if (!r) return null;
    root = r;
    start = rewritten(c.rewrites, expr.object);
  }
  const idxType = c.checkExpr(expr.index);
  const idxT = idxType.tag === "ref" ? idxType.inner : idxType;
  const method = idxT.tag === "string" ? "idxKey" : idxT.tag === "int" ? "idxPos"
    : idxT.tag === "struct" && idxT.name === "JsonCur" ? "idxCur" : null;
  if (!method) {
    if (idxT.tag !== "unknown") c.error(`a Json index is a string key, an integer position or a JsonCur, got ${c.show(idxType)}`, expr.span);
    return c.setType(expr, { tag: "unknown" });
  }
  const next: Expr = {
    kind: "MethodCall", object: structuredClone(root), span: expr.span, method,
    args: method === "idxCur" ? [expr.index] : [start, expr.index],
  };
  c.rewrites.set(expr, next);
  c.jsonChains.set(next, root);
  return c.checkExpr(next, null);
}

// A root the chain can re-borrow at every step: a name or a field path on one.
export function isJsonRootPlace(c: TypeChecker, e: Expr): boolean {
  if (e.kind === "Ident") return true;
  if (e.kind === "FieldAccess") return c.isJsonRootPlace(e.object);
  return false;
}

export function checkIsExprExpr(c: TypeChecker, expr: IsExpr): TypeKind {
  const sp = expr.span;
  const opType = c.checkExpr(expr.operand);
  const pat = c.bindElidedPattern(expr.pattern, opType.tag === "ref" ? opType.inner : opType);
  if (isNestedPattern(pat)) {
    c.error(`'is' tests one variant, not a nested pattern`, sp, `use 'if let' (or a let-chain) to test a nested shape`);
  }
  if (pat.kind === "EnumPattern") {
    if (opType.tag !== "enum" && opType.tag !== "unknown") {
      c.error(`'is' pattern requires an enum type, got ${c.show(opType)}`, sp);
    }
  }
  return c.setType(expr, { tag: "bool" });
}

export function checkIfExprExpr(c: TypeChecker, expr: IfExpr, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  const condType = c.checkExpr(expr.cond);
  if (condType.tag !== "bool" && condType.tag !== "unknown") {
    c.error(`if condition must be bool, got ${c.show(condType)}`, sp);
  }
  const fnRetType = c.currentFnRetType;
  const preReachable = c.reachable;
  const want = expected;

  // An arm whose end is unreachable (`return`, `exit(1)`) has type `never`, which
  // takes the other arm's type.
  let thenType: TypeKind = NEVER_TYPE, elseType: TypeKind = NEVER_TYPE;
  const thenPath = c.checkPath(preReachable, () => {
    c.pushScope();
    c.checkValueBody(expr.thenBody, fnRetType, want);
    c.popScope();
    if (c.reachable) thenType = c.blockExprType(expr.thenBody);
  });
  const elsePath = c.checkPath(preReachable, () => {
    c.pushScope();
    c.checkValueBody(expr.elseBody, fnRetType, want);
    c.popScope();
    if (c.reachable) elseType = c.blockExprType(expr.elseBody);
  });
  c.joinPaths([thenPath, elsePath]);
  // Both arms diverging leaves the if `void`, as before: nothing can observe it.
  if (thenType.tag === "never" && elseType.tag === "never") thenType = elseType = { tag: "void" };
  else if (thenType.tag === "never") thenType = elseType;
  else if (elseType.tag === "never") elseType = thenType;

  // As-a-value if: coerce a const-int arm to the expected width so
  // `let h: i64 = if c { 16 } else { 8 }` doesn't leave both arms at the
  // i32 literal default and then error on the binding. Target is the outer
  // int hint if present, else the concrete non-literal arm's type (so
  // `if c { u8var } else { 0 }` unifies with no annotation). Same const-int
  // retype machinery as enum payloads / struct fields / return.
  const [thenTail, elseTail] = [c.tailExprOf(expr.thenBody), c.tailExprOf(expr.elseBody)];
  let target: TypeKind | null = want?.tag === "int" ? want : null;
  if (!target && thenType.tag === "int" && elseType.tag === "int" && !typeEq(thenType, elseType)) {
    if (thenTail && c.isConstIntExpr(thenTail) && !(elseTail && c.isConstIntExpr(elseTail))) target = elseType;
    else if (elseTail && c.isConstIntExpr(elseTail) && !(thenTail && c.isConstIntExpr(thenTail))) target = thenType;
  }
  let finalThen = thenType, finalElse = elseType;
  if (target) {
    // A constant arm takes the target's width; its range is the constant's own business.
    const width = unranged(target);
    if (thenTail && thenType.tag === "int" && !typeEq(thenType, target) && c.isConstIntExpr(thenTail)) {
      c.retypeConstInt(thenTail, width); finalThen = width;
    }
    if (elseTail && elseType.tag === "int" && !typeEq(elseType, target) && c.isConstIntExpr(elseTail)) {
      c.retypeConstInt(elseTail, width); finalElse = width;
    }
  }

  if (finalThen.tag !== "unknown" && finalElse.tag !== "unknown" && !typeEq(finalThen, finalElse)) {
    c.error(`if-else branches have mismatched types: '${c.show(finalThen)}' vs '${c.show(finalElse)}'`, sp);
  }
  if (finalThen.tag === "unknown") return c.setType(expr, finalElse);
  return c.setType(expr, finalElse.tag === "unknown" ? finalThen : joinRanges(finalThen, finalElse));
}

// Would a write through this binding be thrown away where someone could SEE it?
// Three things must line up:
//  - the binding is by value (a ref writes through to the enum), and
//  - the payload is Copy (a non-Copy payload is MOVED, so the binding owns it), and
//  - the subject is a PLACE that outlives the arm.
// That last one is what keeps `match Child.spawn(...) { Ok(child) => child.close() }`
// legal: the subject is a temporary, so the binding is the only owner and its write is
// the real one. Only `var b = ...; match b { ... }` can observe the discard.
// Does an element of a literal fit the annotated element type?
//
// Both array-literal paths used to call `checkExpr(elem, hint.element)` and throw
// the answer away, so nothing ever compared them: `var x: [i64; 2] = ["a", "b"]` and
// `var v: Vec<i64> = ["a"]` type-checked, and the mismatch surfaced as an LLVM error
// about `%String` where an `i64` was expected — a type error escaping to clang, reported
// in a language the user does not write.
//
// Mirrors the binding rule rather than inventing one: an unknown is already an error
// reported elsewhere, an Option auto-wraps, and an interface coerces.
export function elementFits(c: TypeChecker, elemType: TypeKind, want: TypeKind, elem: Expr): boolean {
  if (want.tag === "int") c.enforceRangeInto(elem, elemType, want, elem.span);
  if (typeEq(want, elemType) || elemType.tag === "unknown") return true;
  const optInner = c.optionInnerType(want);
  if (optInner && typeEq(optInner, elemType) && want.tag === "enum") {
    if (optInner.tag === "int") c.enforceRangeInto(elem, elemType, optInner, elem.span);
    return true;
  }
  return c.tryInterfaceCoercion(elem, elemType, want);
}

export function blockExprType(c: TypeChecker, body: Stmt[]): TypeKind {
  if (body.length === 0) return { tag: "void" };
  const last = body[body.length - 1];
  if (last.kind === "ExprStmt") return c.exprTypes.get(rewritten(c.rewrites, last.expr)) ?? { tag: "void" };
  return { tag: "void" };
}

// Tail (value) expression of a block, or null if it doesn't end in one.
export function tailExprOf(_c: TypeChecker, body: Stmt[]): Expr | null {
  if (body.length === 0) return null;
  const last = body[body.length - 1];
  return last.kind === "ExprStmt" ? last.expr : null;
}

// The tail of an `if`/`match` arm in value position is the arm's value, not a
// discarded statement: it is checked against the if/match's expected type, and
// `let next = if fwd { n.next } else { n.prev }` must not warn "unused Option value"
// on each arm (it did, and pushed people back to the statement form).
export function checkValueBody(c: TypeChecker, body: Stmt[], fnRetType: TypeKind, expected: TypeKind | null): void {
  const tail = c.tailExprOf(body);
  for (const s of body) c.checkStmt(s, fnRetType, s.kind === "ExprStmt" && s.expr === tail ? { expected } : null);
}

// Widen a still-flexible const-int binding to `target` (a wider int) at its
// first use. Retypes every literal leaf and the initializer's node type, so
// codegen emits the binding's slot and all leaves at the new width — no
// runtime sext/zext, because the value is entirely literals.
export function resolveFlexInt(c: TypeChecker, info: VarInfo, target: TypeKind, useExpr: Expr): boolean {
  if (!info.flexInt || target.tag !== "int") return false;
  for (const leaf of info.flexInt.leaves) c.retypeConstInt(leaf, target);
  c.setType(info.flexInt.valueExpr, target);
  info.type = target;
  info.flexInt = undefined;
  c.setType(useExpr, target);
  return true;
}

// If `e` is an identifier bound to a still-flexible const-int `let`, return
// its VarInfo (so a use site can widen it); otherwise null.
export function flexIntBinding(c: TypeChecker, e: Expr): VarInfo | null {
  // ident-ok: asks whether a NAME is bound to a still-flexible const-int literal, which is a property of the binding rather than of storage
  if (e.kind !== "Ident") return null;
  const info = c.lookup(e.name);
  return info?.flexInt ? info : null;
}

// A key type is hashable iff it is a scalar/string, or a struct whose every field is
// hashable. Structural hashing derives from the same field recursion as structural
// equality, so eq–hash coherence (a == b ⟹ hash(a) == hash(b)) holds by construction.
export function isHashable(c: TypeChecker, t: TypeKind, seen: Set<string> = new Set()): boolean {
  if (t.tag === "int" || t.tag === "bool" || t.tag === "string") return true;
  if (t.tag === "struct") {
    if (seen.has(t.name)) return true; // cycle guard (structs can't nest by value anyway)
    seen.add(t.name);
    const info = c.structs.get(t.name);
    if (!info) return false;
    return info.fields.every(f => c.isHashable(f.type, seen));
  }
  return false;
}

// true if enum is Option-like (Some(T)/None)
export function isOptionLike(c: TypeChecker, t: TypeKind): boolean {
  if (t.tag !== "enum") return false;
  const info = c.enums.get(t.name);
  if (!info) return false;
  const some = info.variants.get("Some");
  const none = info.variants.get("None");
  return !!(some && none && some.fields.length === 1 && none.fields.length === 0);
}

// compiler-magic From: find a variant in targetErr that wraps sourceErr
// `?` into a fn returning Result<T, Heap<Iface>>: a struct or enum error that satisfies
// the interface is boxed and coerced; a `string` error becomes the prelude's `ErrorMessage`
// when the interface is the prelude `Error`. Reports and returns null when the target
// is a boxed interface the source cannot satisfy ("reported"), so the caller does not
// fall through to the enum-variant search with a misleading second message.
export function findPropagateBoxing(c: TypeChecker, sourceErr: TypeKind, targetErr: TypeKind, sp?: Span, what = "'?'"): PropagateBoxing | "reported" | null {
  if (targetErr.tag !== "heap" || targetErr.inner.tag !== "interface") return null;
  const ifaceName = targetErr.inner.name;
  if (sourceErr.tag === "string" && ifaceName === "Error" && c.structs.has("ErrorMessage")) {
    return { fromType: "ErrorMessage", ifaceName, viaMessage: true, errType: sourceErr };
  }
  if (sourceErr.tag === "struct" || sourceErr.tag === "enum") {
    const srcName = typeName(sourceErr);
    if (c.typeSatisfiesInterface(srcName, ifaceName)) {
      return { fromType: srcName, ifaceName, viaMessage: false, errType: sourceErr };
    }
  }
  const iface = c.interfaces.get(ifaceName);
  const wants = iface ? [...iface.methods.keys()].map(m => `${m}(self: &Self)`).join(", ") : "";
  c.error(`${what} error type mismatch: '${c.show(sourceErr)}' cannot be boxed as '${c.show(targetErr)}' because it does not satisfy interface '${ifaceName}'${wants ? ` (needs ${wants})` : ""}`, sp);
  return "reported";
}

export function findFromConversion(c: TypeChecker, sourceErr: TypeKind, targetErr: TypeKind): { targetEnumName: string; wrapVariant: string; wrapTag: number } | null {
  if (targetErr.tag !== "enum") return null;
  const info = c.enums.get(targetErr.name);
  if (!info) return null;
  // also allow string source → any variant with string payload
  let matches: { name: string; tag: number }[] = [];
  for (const [vName, vInfo] of info.variants) {
    if (vInfo.fields.length === 1 && typeEq(vInfo.fields[0], sourceErr)) {
      matches.push({ name: vName, tag: vInfo.tag });
    }
  }
  if (matches.length === 1) {
    return { targetEnumName: targetErr.name, wrapVariant: matches[0].name, wrapTag: matches[0].tag };
  }
  if (matches.length > 1) {
    c.error(`ambiguous From conversion: '${c.show(sourceErr)}' matches multiple variants in '${c.show(targetErr)}': ${matches.map(m => m.name).join(", ")}`);
  }
  return null;
}
