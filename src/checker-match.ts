// Match and pattern checking: arm typing, exhaustiveness space, lints, payload bindings.
import type { TypeChecker } from "./checker";
import type { TypeKind } from "./types";
import { NEVER_TYPE, typeEq } from "./types";
import { joinRanges, unranged } from "./checker-util";
import type { Expr, MatchArm, Pattern, Span, Stmt, MatchExpr } from "./ast";
import { isNestedPattern } from "./ast";
import type { Pat, SpaceEnv } from "./match-usefulness";
import { armAfterWildcard, showPat, useful } from "./match-usefulness";
import { must } from "./must";

export function checkMatchExprExpr(c: TypeChecker, expr: MatchExpr, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  const want = expected;
  const armTypes = c.checkMatchLike(expr.subject, expr.arms, sp, c.currentFnRetType, false, want);
  // Unify arm value types. Coerce const-int arms to an int target (the
  // outer hint, else the first concrete non-literal arm) so
  // `match x { A => 1, B => 2 }` in an i64 slot doesn't stall at i32 —
  // same const-int retype path as if-expression arms.
  const armTails = expr.arms.map(a => c.tailExprOf(a.body));
  let target: TypeKind | null = want?.tag === "int" ? want : null;
  if (!target) {
    for (let i = 0; i < armTypes.length; i++) {
      const tail = armTails[i];
      if (armTypes[i].tag === "int" && !(tail && c.isConstIntExpr(tail))) { target = armTypes[i]; break; }
    }
  }
  const finalTypes: TypeKind[] = [];
  for (let i = 0; i < armTypes.length; i++) {
    let t = armTypes[i];
    const tail = armTails[i];
    if (target && t.tag === "int" && !typeEq(t, target) && tail && c.isConstIntExpr(tail)) {
      const width = unranged(target);
      c.retypeConstInt(tail, width); t = width;
    }
    finalTypes.push(t);
  }
  // Result is the first concrete (non-unknown) arm type; report a mismatch
  // if a later concrete arm disagrees.
  let result: TypeKind = { tag: "unknown" };
  for (const t of finalTypes) {
    if (t.tag === "unknown" || t.tag === "void" || t.tag === "never") continue;
    if (result.tag === "unknown") { result = t; continue; }
    if (!typeEq(result, t)) {
      c.error(`match arms have mismatched types: '${c.show(result)}' vs '${c.show(t)}'`, sp);
    } else {
      result = joinRanges(result, t);
    }
  }
  if (result.tag === "unknown" && finalTypes.some(t => t.tag === "void" || t.tag === "never")) result = { tag: "void" };
  return c.setType(expr, result);
}

export function bindsOnlyCopy(c: TypeChecker, subjType: TypeKind, patterns: (Pattern | undefined)[]): boolean {
  if (subjType.tag !== "enum") return false;
  const einfo = c.enums.get(subjType.name);
  if (!einfo) return false;
  return patterns.every(pattern => {
    if (!pattern || pattern.kind !== "EnumPattern") return true;
    if (isNestedPattern(pattern)) {
      return c.patternLeaves(pattern, subjType, false).every(l => l.name === "_" || c.isCopyType(l.type));
    }
    const v = einfo.variants.get(pattern.variant);
    if (!v) return true;
    return pattern.bindings.every((b, i) =>
      b === "_" || i >= v.fields.length ||
      c.isCopyType(v.fields[i]));
  });
}

// `let g = p else { … }` over a `?&mut T` / `?&T` parameter: the nullable extern
// reference's only legal reader.
//
// The subject is deliberately NOT run through checkExpr. Naming a nullable extern
// reference anywhere else is an error (checkIdentExpr), and routing this through the
// same path would need an exemption that the next construct to read an Ident would
// silently inherit. There is no enum here and no `Option<&mut T>` is ever built: the
// parameter is a `*T`, this is the null test, and `g` is an ordinary second-class ref
// from here on, subject to every rule any other `&mut T` obeys.
export function checkNullRefUnwrap(c: TypeChecker, stmt: import("./ast").LetElseStmt, name: string, fnRetType: TypeKind, sp?: Span): void {
  // ident-ok: a nullable extern reference can only ever BE a parameter binding
  const info = stmt.value.kind === "Ident" ? c.lookup(stmt.value.name) : null;
  if (!info?.nullableRef) {
    const what = stmt.value.kind === "Ident" ? `'${stmt.value.name}'` : "this value";
    c.error(`${what} is not a nullable extern reference, so 'let ${name} = … else { … }' has nothing to unwrap`, sp,
      `that form is for a '?&mut T' parameter of an 'extern' / '@externalLinkage' fn. To unwrap an enum, name the variant: 'let Option.Some(${name}) = … else { … }'`);
    return;
  }
  // A second live unwrap of a `?&mut T` would hand the body two `&mut T` to one object,
  // which is the aliasing the one rule exists to prevent. Scoped, not function-wide: the
  // borrow is released when the first binding's scope pops, so unwrapping once per arm of
  // an `if` is fine. A shared `?&T` has nothing to exclude, so it is not restricted.
  if (info.nullableRef.mutable && info.borrowed) {
    c.error(`'${(stmt.value as { name: string }).name}' is already unwrapped here — a second '&mut ${c.show(info.nullableRef.inner)}' to the same object would alias the first`, sp,
      `use the binding you already have, or let the first one's scope end before unwrapping again`);
    return;
  }
  info.read = true;
  c.setType(stmt.value, info.type);
  c.nullRefUnwraps.set(stmt, info.nullableRef);
  // The else block runs when C passed null, so it must diverge — otherwise control
  // reaches code where the binding does not exist. Checked in its own scope BEFORE the
  // binding is declared, so the binding is not in scope inside it. Same rule, and the
  // same reason, as the enum let-else above.
  const preElseReachable = c.reachable;
  c.pushScope();
  for (const st of stmt.elseBody) c.checkStmt(st, fnRetType);
  c.popScope();
  c.reachable = preElseReachable;
  if (!c.bodyAlwaysReturns(stmt.elseBody)) {
    c.error(`the else block of 'let ${name} = ${stmt.value.kind === "Ident" ? stmt.value.name : "…"} else { … }' must diverge (return/break/continue) — it runs when C passed null`, sp);
  }
  const refType: TypeKind = { tag: "ref", inner: info.nullableRef.inner, mutable: info.nullableRef.mutable };
  // Keyed on the placeholder pattern, which is unique per statement: this is the map the
  // LSP already reads for a let-else binding's hover, so the unwrap gets one for free.
  c.patternBindingTypes.set(stmt.pattern, [refType]);
  if (refType.mutable) { c.noteBorrowChange(); info.borrowed = true; }
  c.declare(name, { type: refType, mutable: refType.mutable, borrowed: false, read: false, span: sp,
    ...(refType.mutable && { freezes: [info] }) });
}

export function isCopyBind(c: TypeChecker, bt: TypeKind, subjectIsPlace: boolean): boolean {
  if (!subjectIsPlace) return false;
  if (bt.tag === "ref") return false;
  return c.isCopyType(bt);
}

// Through a `&mut` subject every payload binds as a `&mut` view (see checkMatchLike).
export function payloadBindType(c: TypeChecker, bt: TypeKind, subjBorrows: boolean, subjIsMut = false): TypeKind {
  if (subjIsMut) return { tag: "ref", inner: bt, mutable: true };
  if (subjBorrows && !c.isCopyType(bt)) {
    return { tag: "ref", inner: bt, mutable: false };
  }
  return bt;
}

// The type space the usefulness check walks: an enum's inhabited variants, bool's two
// values, and nothing enumerable for anything else.
export function patternSpace(c: TypeChecker): SpaceEnv<TypeKind> {
  return {
    ctors: (ty) => {
      if (ty.tag === "bool") return [{ name: "true", fields: [] }, { name: "false", fields: [] }];
      if (ty.tag !== "enum") return null;
      const info = c.enums.get(ty.name);
      if (!info) return null;
      return [...info.variants].filter(([, v]) => !v.fields.some(f => c.isUninhabited(f, new Set())))
        .map(([name, v]) => ({ name, fields: v.fields }));
    },
  };
}

export function toSpacePat(c: TypeChecker, p: Pattern, ty: TypeKind): Pat {
  if (p.kind === "WildcardPattern") return { k: "wild" };
  if (p.kind === "LiteralPattern") {
    if (p.literalKind === "bool") return { k: "ctor", name: String(p.value), args: [] };
    const text = p.literalKind === "string" ? JSON.stringify(p.value) : p.literalKind === "char" ? `'${p.value}'` : String(p.value);
    return { k: "lit", key: `${p.literalKind}:${p.value}`, text };
  }
  const fields = ty.tag === "enum" ? c.enums.get(ty.name)?.variants.get(p.variant)?.fields ?? [] : [];
  return {
    k: "ctor", name: p.variant,
    args: p.bindings.map((_b, i) => {
      const sub = p.args?.[i];
      return sub ? c.toSpacePat(sub, fields[i] ?? { tag: "unknown" }) : { k: "wild" };
    }),
  };
}

export function showPattern(c: TypeChecker, p: Pattern): string {
  if (p.kind === "WildcardPattern") return "_";
  if (p.kind === "LiteralPattern") return p.literalKind === "string" ? JSON.stringify(p.value) : String(p.value);
  if (p.bindings.length === 0) return p.variant;
  return `${p.variant}(${p.bindings.map((b, i) => { const sub = p.args?.[i]; return sub ? c.showPattern(sub) : b; }).join(", ")})`;
}

// Exhaustiveness and dead arms for a match with a nested arm, where "each variant has an
// arm" stops being the question. Missing cases are reported one per top-level variant,
// as the flat rule does, naming the first uncovered shape inside it (`Ok(None)`).
export function checkNestedCoverage(chk: TypeChecker, arms: MatchArm[], subjType: TypeKind & { tag: "enum" }, sp: Span | undefined): void {
  const env = chk.patternSpace();
  const rows: Pat[][] = [];
  for (const arm of arms) {
    const ap = chk.rewrittenPat(arm.pattern);
    const pat = chk.toSpacePat(ap, subjType);
    // An arm after full coverage is only flagged when it is not a wildcard: a trailing
    // `_` after every variant is accepted by the flat rule, and stays accepted here.
    if (ap.kind !== "WildcardPattern" && useful(env, rows, [pat], [subjType]) === null) {
      chk.error(`unreachable match arm: '${chk.showPattern(ap)}' is already covered by the arms above it`, ap.span ?? sp);
    }
    rows.push([pat]);
  }
  for (const c of env.ctors(subjType) ?? []) {
    const w = useful(env, rows, [{ k: "ctor", name: c.name, args: c.fields.map(() => ({ k: "wild" }) as Pat) }], [subjType]);
    if (!w) continue;
    const top = w[0]!;
    // "Missing variant" only when no arm names it; `Some(0)` alone leaves `Some(_)`.
    const named = arms.some(a => { const p = chk.rewrittenPat(a.pattern); return p.kind === "EnumPattern" && p.variant === c.name; });
    const allWild = top.k === "ctor" && top.args.every(a => a.k === "wild");
    if (allWild && !named) chk.error(`non-exhaustive match: missing variant '${c.name}'`, sp);
    else chk.error(`non-exhaustive match: missing case '${showPat(top)}'`, sp,
      allWild ? `a literal or variant inside '${c.name}(…)' covers only itself; add an arm for the rest of '${c.name}'` : undefined);
    chk.nonExhaustiveMatches.add(arms);
  }
}

// `match opt { Some(x) => { x } None => { d } }` is `opt ?? d`. Both arms have to be a
// single statement of the same shape, the Some arm has to hand back its binding
// untouched, and the subject has to be an owned Option — a `&Option` or a place
// subject binds the payload as a borrow, where `??` would not be the same program.
// `??` is short-circuit like the match, so a default with side effects stays correct.
export function lintManualOptionDefault(c: TypeChecker, arms: MatchArm[], subjType: TypeKind, sp: Span | undefined): void {
  if (arms.length !== 2 || arms.some(a => isNestedPattern(a.pattern))) return;
  if (subjType.tag !== "enum" || c.optionInnerType(subjType) === null) return;
  const armFor = (v: string) => arms.find(a => a.pattern.kind === "EnumPattern" && a.pattern.variant === v);
  const some = armFor("Some");
  const none = armFor("None") ?? arms.find(a => a.pattern.kind === "WildcardPattern");
  if (!some || !none || some === none) return;
  const binding = some.pattern.kind === "EnumPattern" ? some.pattern.bindings[0] : undefined;
  if (!binding || some.body.length !== 1 || none.body.length !== 1) return;
  const shape = (st: Stmt) => st.kind === "Return" ? { via: "return", e: st.value }
    : st.kind === "ExprStmt" ? { via: "value", e: st.expr } : null;
  const s1 = shape(some.body[0]!);
  const s2 = shape(none.body[0]!);
  if (!s1 || !s2 || s1.via !== s2.via) return;
  if (!s1.e || !s2.e) return;
  if (s1.e.kind !== "Ident" || s1.e.name !== binding) return;
  c.warn("manual-option-default",
    `this match only supplies a default for None`,
    sp,
    s1.via === "return"
      ? "write 'return <option> ?? <default>' instead"
      : "write '<option> ?? <default>' instead");
}

// `match x { A(v) => { … } B => {} }` is `if let A(v) = x { … }`. Every arm but one is
// empty, so the match exists only to name the variant it cares about, and the other arms
// are there to satisfy exhaustiveness rather than to do anything.
//
// Safe as a mechanical rewrite because if-let is not a separate rule: `IfLetStmt` runs the
// same `enumSubjectBorrow` / `payloadBindType` / `armConsumesSubject` path as a match arm,
// so the payload binds by borrow or by value identically and the subject is consumed at
// the same point. Statement position only, since a match in value position cannot have an
// empty arm and still type-check, so the shape never appears there.
export function lintSingleVariantMatch(c: TypeChecker, subject: Expr, arms: MatchArm[], subjType: TypeKind, sp: Span | undefined): void {
  if (arms.length < 2) return;
  const base = subjType.tag === "ref" ? subjType.inner : subjType;
  if (base.tag !== "enum") return;
  const live = arms.filter(a => a.body.length > 0);
  if (live.length !== 1) return;
  const kept = live[0]!;
  // A wildcard arm is the one that would become the `else`, and `if let A(..) = x {} else`
  // with an empty then-branch is worse than the match it replaces.
  if (kept.pattern.kind !== "EnumPattern") return;
  const pat = kept.pattern;
  // The rewrite it prints spells the bindings flat; a nested arm has no flat spelling.
  if (arms.some(a => isNestedPattern(a.pattern))) return;
  const name = pat.enumName ? `${pat.enumName}.${pat.variant}` : pat.variant;
  const spelled = pat.bindings.length > 0 ? `${name}(${pat.bindings.join(", ")})` : name;
  // `describeExpr` only spells places; for a call subject it returns `<expr>`, and an
  // ellipsis reads as "your subject here" where a literal `<expr>` reads like a type.
  const subjText = c.describeExpr(subject);
  c.warn("single-variant-match",
    `this match only acts on one variant; the other ${arms.length === 2 ? "arm is" : "arms are"} empty`,
    sp,
    `write 'if let ${spelled} = ${subjText === "<expr>" ? "…" : subjText} { … }' instead`,
    "match".length);
}

export function checkMatchLike(c: TypeChecker, subject: Expr, arms: MatchArm[], sp: Span | undefined, fnRetType: TypeKind, isStmt = false, expected: TypeKind | null = null): TypeKind[] {
  const armTypes: TypeKind[] = [];
  const rawSubjType = c.checkExpr(subject);
  // Both match lints are advisory rewrites, so a hit inside std/ or a dependency is not
  // actionable by the person reading the build (dapweb warned on std/env's own getEnvOr).
  // Same scoping as unused-unsafe and index-clone.
  if (c.currentFnIsUser) {
    if (rawSubjType.tag !== "ref" && subject.kind !== "FieldAccess" && subject.kind !== "IndexAccess") {
      c.lintManualOptionDefault(arms, rawSubjType, sp);
    }
    if (isStmt) c.lintSingleVariantMatch(subject, arms, rawSubjType, sp);
  }
  {
    const t = rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
    for (const arm of arms) c.bindElidedPattern(arm.pattern, t);
  }
  const dead = armAfterWildcard(arms.map(a => ({ pattern: c.rewrittenPat(a.pattern) })));
  if (dead >= 0) c.error(`unreachable match arm: '${c.showPattern(c.rewrittenPat(arms[dead]!.pattern))}' comes after a '_' arm, which matches everything`, c.rewrittenPat(arms[dead]!.pattern).span ?? sp);
  // Matching on a borrowed enum (`&Enum`) reads the pointee without moving
  // it. Payload bindings become borrows (see below), so nothing is consumed.
  // Reading a ref Ident auto-derefs, so also consult its declared type.
  let subjIsRef = rawSubjType.tag === "ref" && rawSubjType.inner.tag === "enum";
  let subjType = subjIsRef && rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
  // A `&mut Enum` subject lends its payloads mutably: bindings are `&mut` views and
  // `Node.Leaf(v) => { v = v + 1 }` writes the payload in place. Before this the only
  // in-place update was replace-rebuild-assign with a sentinel variant.
  let subjIsMut = subjIsRef && rawSubjType.tag === "ref" && rawSubjType.mutable;
  // ident-ok: asks whether the subject BINDING was declared `&E`, a property of the declaration
  if (!subjIsRef && subject.kind === "Ident") {
    const info = c.lookup(subject.name);
    if (info && info.type.tag === "ref" && info.type.inner.tag === "enum") {
      subjIsRef = true;
      subjIsMut = info.type.mutable;
      subjType = info.type.inner;
    }
  }
  if (subjIsMut) c.matchSubjectMut.add(subject);
  // Matching on a place (s.field, v[i], *heapBox) also borrows: the
  // container keeps ownership, so consuming the subject would zero data
  // the checker cannot track (a second `match v[i].f` read a zeroed enum;
  // `match *h` through a &Heap zeroed the pointee in place — both silent).
  // Bindings become borrows below.
  const subjIsPlace = !subjIsRef && subjType.tag === "enum" && c.isBorrowedMatchPlace(subject);
  // Matching an OWNED enum local to inspect its shape shouldn't consume it when no
  // arm actually moves a non-Copy payload out — i.e. every non-Copy payload is
  // ignored (`_`). Then the match only reads, so borrow it (like the place case)
  // instead of moving, and it stays usable afterward. This is purely additive: it
  // never changes a binding's type (there are no named non-Copy bindings in this
  // case — Copy bindings stay by-value either way), so a match that legitimately
  // destructures owned data still consumes exactly as before.
  let subjIsOwnedInspect = false;
  if (!subjIsRef && !subjIsPlace) {
    subjIsOwnedInspect = c.ownedInspectOnly(subject, subjType, arms.map(a => c.rewrittenPat(a.pattern)));
  }
  const subjBorrows = subjIsRef || subjIsPlace || subjIsOwnedInspect;
  c.refuseDropEnumMoveOut(subject, subjType, subjBorrows, arms.map(a => a.pattern));
  if (subjBorrows) c.matchSubjectRef.add(subject);
  const isEnum = subjType.tag === "enum";
  const isLiteralType = subjType.tag === "int" || subjType.tag === "float" || subjType.tag === "string" || subjType.tag === "bool";
  if (!isEnum && !isLiteralType && subjType.tag !== "unknown") {
    c.error(`match subject must be an enum, integer, float, string, or bool, got ${c.show(subjType)}`, sp);
    return armTypes;
  }
  if (isLiteralType) {
    let hasWildcard = false;
    const preReachable = c.reachable;
    const armPaths: boolean[] = [];
    for (const arm of arms) {
      const pat = c.rewrittenPat(arm.pattern);
      if (pat.kind === "WildcardPattern") {
        hasWildcard = true;
      } else if (pat.kind === "LiteralPattern") {
        const ps = pat.span;
        if (subjType.tag === "int" && pat.literalKind !== "int" && pat.literalKind !== "char") {
          // char literals are integer-valued (u8); allow them against any int subject
          c.error(`expected integer literal in match arm`, ps);
        } else if (subjType.tag === "float" && pat.literalKind !== "float" && pat.literalKind !== "int") {
          c.error(`expected numeric literal in match arm`, ps);
        } else if (subjType.tag === "string" && pat.literalKind !== "string") {
          c.error(`expected string literal in match arm`, ps);
        } else if (subjType.tag === "bool" && pat.literalKind !== "bool") {
          c.error(`expected bool literal in match arm`, ps);
        }
      } else if (pat.kind === "EnumPattern") {
        c.error(`cannot use enum pattern when matching on ${c.show(subjType)}`, pat.span);
      }
      c.reachable = preReachable;
      c.pushScope();
      if (isStmt) for (const s of arm.body) c.checkStmt(s, fnRetType);
      else c.checkValueBody(arm.body, fnRetType, expected);
      armTypes.push(c.reachable ? c.blockExprType(arm.body) : NEVER_TYPE);
      c.popScope();
      armPaths.push(c.reachable);
    }
    c.joinPaths(armPaths);
    if (!hasWildcard && subjType.tag === "bool") {
      const hasTrueArm = arms.some(a => { const p = c.rewrittenPat(a.pattern); return p.kind === "LiteralPattern" && p.value === true; });
      const hasFalseArm = arms.some(a => { const p = c.rewrittenPat(a.pattern); return p.kind === "LiteralPattern" && p.value === false; });
      if (!hasTrueArm || !hasFalseArm) {
        c.error(`non-exhaustive match on bool`, sp);
        c.nonExhaustiveMatches.add(arms);
      }
    } else if (!hasWildcard) {
      c.error(`match on ${c.show(subjType)} requires a wildcard '_' arm`, sp);
      c.nonExhaustiveMatches.add(arms);
    }
  } else if (isEnum && subjType.tag === "enum") {
    // The tag test is redundant — `subjType` is not reassigned after `isEnum` is
    // computed — but it is what narrows `subjType` for the enum accesses below.
    const enumInfo = must(c.enums, subjType.name, "enums");
    const covered = new Set<string>();
    const anyNested = arms.some(a => isNestedPattern(c.rewrittenPat(a.pattern)));
    let hasWildcard = false;
    const preReachable = c.reachable;
    const armPaths: boolean[] = [];
    for (const arm of arms) {
      const pat = c.rewrittenPat(arm.pattern);
      if (pat.kind === "WildcardPattern") {
        hasWildcard = true;
      } else if (pat.kind === "EnumPattern") {
        const ps = pat.span;
        if (pat.enumName !== subjType.name && enumInfo.baseName !== pat.enumName) {
          c.error(`pattern enum '${pat.enumName}' does not match subject type '${subjType.name}'`, ps);
        }
        const variant = enumInfo.variants.get(pat.variant);
        if (!variant) {
          c.error(`enum '${subjType.name}' has no variant '${pat.variant}'`, ps);
          continue;
        }
        // With a nested arm, two arms may share a variant (`Ok(Some(v))`, `Ok(None)`):
        // checkNestedCoverage decides which arms are dead instead.
        if (covered.has(pat.variant) && !anyNested) {
          c.error(`duplicate match arm for '${pat.variant}'`, ps);
        }
        covered.add(pat.variant);
        if (pat.bindings.length !== variant.fields.length) {
          c.error(`variant '${pat.variant}' has ${variant.fields.length} fields, but pattern has ${pat.bindings.length} bindings`, ps);
        }
      } else if (pat.kind === "LiteralPattern") {
        c.error(`cannot use literal pattern when matching on enum`, pat.span);
      }
      c.reachable = preReachable;
      c.pushScope();
      if (pat.kind === "EnumPattern" && isNestedPattern(pat)) {
        if (enumInfo.variants.has(pat.variant)) {
          c.declarePatternLeaves(pat, c.patternLeaves(pat, subjType, true), subject, subjBorrows, subjIsMut, false);
        }
      } else if (pat.kind === "EnumPattern") {
        const variant = enumInfo.variants.get(pat.variant);
        if (variant) {
          const bindTypes: TypeKind[] = [];
          for (let i = 0; i < Math.min(pat.bindings.length, variant.fields.length); i++) {
            let bt = variant.fields[i];
            // Ref- or place-match: a non-Copy payload binds as a borrow
            // (`&T`) — a view into the still-owned subject, so it can't be
            // moved out or dropped. Copy payloads bind by value, except through a
            // `&mut` subject, where every payload is a `&mut` view so the arm can
            // assign to it (the same shape a `&mut T` parameter has).
            if (subjIsMut) {
              bt = { tag: "ref", inner: bt, mutable: true };
            } else if (subjBorrows && !c.isCopyType(bt)) {
              bt = { tag: "ref", inner: bt, mutable: false };
            }
            bindTypes.push(bt);
          }
          const freezes = c.freezeSubjectFor(subject, bindTypes);
          for (let i = 0; i < bindTypes.length; i++) {
            const bindSpan = pat.bindingSpans?.[i] ?? pat.span;
            c.declare(pat.bindings[i], { type: bindTypes[i], mutable: subjIsMut, borrowed: false, read: false, span: bindSpan, patternBound: true,
              copyBind: c.isCopyBind(bindTypes[i], c.isPlaceExpr(subject)), ...(i === 0 && freezes.length > 0 && { freezes }) });
            const bound = c.lookup(pat.bindings[i]);
            if (bound) c.noteRefInto(bound, subject, pat.variant, i);
          }
          c.patternBindingTypes.set(pat, bindTypes);
        }
      }
      // Consume BEFORE the body, not after the whole match: a destructuring arm
      // zeroes the payload at arm entry, so a read of the subject inside that
      // arm is a use-after-move. Deferring the move to the end of the match let
      // those reads through silently and they saw zeroed data.
      const armConsumes = !subjBorrows && c.armConsumesSubject(pat, enumInfo, subjType);
      if (armConsumes) c.tryMove(subject);
      if (isStmt) for (const s of arm.body) c.checkStmt(s, fnRetType);
      else c.checkValueBody(arm.body, fnRetType, expected);
      armTypes.push(c.reachable ? c.blockExprType(arm.body) : NEVER_TYPE);
      c.popScope();
      armPaths.push(c.reachable);
    }
    c.joinPaths(armPaths);
    if (anyNested) {
      c.checkNestedCoverage(arms, subjType, sp);
    } else if (!hasWildcard) {
      for (const [name, v] of enumInfo.variants) {
        // A variant carrying an uninhabited payload has no values, so demanding an arm
        // for it asks the reader to handle a case the checker can prove cannot occur —
        // `Result<T, Never>` from infallible generic code was unusable without the
        // `match e { }` incantation. The empty match stays legal and stays the way to
        // discharge one explicitly; this only stops it from being mandatory.
        if (!covered.has(name) && !v.fields.some(f => c.isUninhabited(f, new Set()))) {
          c.error(`non-exhaustive match: missing variant '${name}'`, sp);
          c.nonExhaustiveMatches.add(arms);
        }
      }
    }
  }
  // A ref- or place-match borrows the subject (payload bindings are
  // borrows); it is not consumed, so don't move it. A literal match only compares, so
  // it borrows too: moving an owned string into it left nothing to drop it, one leak
  // per `match s { "lit" => ... }`.
  if (!subjBorrows && !isLiteralType) c.tryMove(subject);
  return armTypes;
}
