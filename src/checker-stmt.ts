// Statement and function-body checking: let/assign/for/while forms, let-clause binding, pattern leaves.
import type { TypeChecker } from "./checker";
import type { Expr, Function, Pattern, Stmt } from "./ast";
import { isReplayHookedFn } from "./replay-externs";
import { declaredType, isNestedPattern, patternLeafNames } from "./ast";
import type { TypeKind } from "./types";
import { rewritten, rewrittenPattern } from "./checker-util";
import { typeEq } from "./types";
import { must } from "./must";
import type { PatternLeaf } from "./checker";

export function checkFunction(c: TypeChecker, fn: Function) {
  // save/restore: monomorphization can re-enter checkFunction mid-expression.
  // currentFnRetType MUST be saved too — resolving/checking a generic in this
  // fn's body (e.g. Channel<string>.new) re-enters checkFunction for that
  // type's methods (some returning void), which would otherwise leave
  // currentFnRetType clobbered and make a later `?` see a void return.
  const savedIsUser = c.currentFnIsUser;
  const savedIsDep = c.currentFnIsDep;
  const savedRetType = c.currentFnRetType;
  const savedScopeFloor = c.fnScopeFloor;
  const savedFnFile = c.currentFnFile;
  const savedReachable = c.reachable;
  const savedFnDecl = c.currentFnDecl;
  c.currentFnDecl = fn;
  // The restore is a `finally` because a `fatal()` anywhere below unwinds past
  // it — leaving currentFnRetType pointing at an abandoned function would make
  // the NEXT function's `return`/`?` check answer against the wrong signature.
  try {
    c.checkFunctionBody(fn);
  } finally {
    c.currentFnIsUser = savedIsUser;
    c.currentFnIsDep = savedIsDep;
    c.currentFnRetType = savedRetType;
    c.fnScopeFloor = savedScopeFloor;
    c.currentFnFile = savedFnFile;
    c.reachable = savedReachable;
    c.currentFnDecl = savedFnDecl;
  }
}

export function checkFunctionBody(chk: TypeChecker, fn: Function) {
  chk.reachable = true;
  chk.currentFnIsUser = chk.fnIsUserCode(fn.name);
  chk.currentFnIsDep = chk.fnIsDependencyCode(fn.name);
  chk.currentFnReplayHooked = isReplayHookedFn(fn);
  // `sourceFile` first: a derived method's spans name the synthetic
  // `<derive Json for S>` unit, but the resolver-style origin is the struct's file,
  // which is where generated code has to count as living for field privacy.
  chk.currentFnFile = fn.sourceFile ?? fn.span?.file;
  chk.pushScope();
  chk.fnScopeFloor = chk.scopes.length - 1;
  const retType = chk.resolve(fn.retType);
  // impl methods and generic instantiations never pass the declaration-level scan
  chk.errorIfRefReturn(fn, retType);
  chk.currentFnRetType = retType;

  for (const p of fn.params) {
    const declared = declaredType(p);
    const pType = chk.resolve(declared);
    const nullableRef = declared.isNullableRef && pType.tag === "ptr"
      ? { inner: pType.inner, mutable: !!declared.isRefMut } : undefined;
    chk.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, borrowed: false, read: false, span: p.span,
      ...(nullableRef && { nullableRef }), ...(pType.tag !== "ref" && { byValueParam: true }) });
  }

  // Check contracts in a nested scope so `result` doesn't shadow body locals
  if (fn.contracts && fn.contracts.length > 0) {
    chk.pushScope();
    const hasEnsures = fn.contracts.some(c => c.kind === "ensures");
    if (hasEnsures && retType.tag !== "void") {
      chk.declare("result", { type: retType, mutable: false, borrowed: false, read: true });
    }
    for (const c of fn.contracts) chk.checkContractClause(c);
    chk.popScope();
  }

  // One boundary per statement: a `fatal()` abandons the statement it fired in,
  // not the function, so a body with three independent errors still reports three.
  for (const stmt of fn.body) chk.recover(() => chk.checkStmt(stmt, retType));
  chk.resolveViewBinds(fn.body);
  chk.scanUnreachable(fn.body);
  if (!fn.isExtern) chk.lintUncheckedFfiContract(fn);
  // `main` keeps its implicit `return 0` (C's rule, and what codegen emits); no
  // other function gets one. Externs have no body to fall off.
  if (!fn.isExtern && fn.name !== "main") {
    // `foo`, not the instance `foo_i64` or the method symbol `Sq$Shape$area`.
    const shown = fn.sourceName ?? fn.name.slice(fn.name.lastIndexOf("$") + 1);
    chk.errorIfFallsOff(`'${shown}'`, fn.body, retType, fn.span);
  }

  // Lint: warn if a non-ref, non-Copy param was never moved — suggest &T
  if (!fn.isExtern) {
    for (const p of fn.params) {
      const info = chk.lookup(p.name);
      if (!info) continue;
      if (info.type.tag === "ref") continue;
      if (chk.isCopyType(info.type)) continue;
      if (!info.everMoved) {
        chk.warn("unused-move",
          `parameter '${p.name}' is never moved — consider taking '&${chk.show(info.type)}' instead`,
          fn.span,
          `passing by reference avoids requiring callers to give up ownership`
        );
      }
    }
  }

  // Lint: unused variables
  const scope = chk.scopes[chk.scopes.length - 1];
  for (const [name, info] of scope) {
    // `self` is the method receiver — never lint it unused (matches Rust). A Drop
    // impl or any method that ignores its receiver shouldn't have to write `_self`.
    if (info.read || name.startsWith("_") || name === "self") continue;
    chk.warn("unused-variable", `unused variable '${name}'`, info.span,
      `prefix with underscore to silence: '_${name}'`);
  }

  chk.popScope();
}

// `valueTail` is set for the tail statement of an if/match arm in value position.
export function checkStmt(c: TypeChecker, stmt: Stmt, fnRetType: TypeKind, valueTail: { expected: TypeKind | null } | null = null) {
  c.checkStmtBody(stmt, fnRetType, valueTail);
  // Lock any flexible const-int binding that was read but not widened during
  // this statement: its width is now fixed at the default. This is what keeps
  // widening sound — a binding can only adopt a wider width at its FIRST read
  // (within one statement), never retroactively after an i32 use committed.
  for (const [vi, name] of c.flexIntVars) {
    if (!vi.flexInt) { c.flexIntVars.delete(vi); continue; }
    if (vi.read && c.scopes.some(s => s.get(name) === vi)) { vi.flexInt = undefined; c.flexIntVars.delete(vi); }
  }
}

// The shared head of `let` and `var`: resolve the annotation, type the initializer
// against it, apply the coercions a declared type allows, and range-check ranged ints.
export function checkBindingInit(c: TypeChecker, stmt: Extract<Stmt, { kind: "LetDecl" | "VarDecl" }>) {
  const sp = stmt.span;
  const hint = stmt.type ? c.resolve(stmt.type, stmt.span) : null;
  // refs in locals OK (second-class — can't escape function via return/struct/collection)
  if (hint && c.nestedRef(hint)) {
    c.error(`'${stmt.name}': references cannot be stored in a collection`, sp, `references are second-class — store owned values instead`);
  }
  const frozenBeforeRhs = c.openBorrowWindow();
  const deferred = !hint ? c.tryDeferVecInfer(stmt.value) : null;
  const valType = deferred ?? c.checkExpr(stmt.value, hint);
  const value = rewritten(c.rewrites, stmt.value);
  if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
    const optInner = c.optionInnerType(hint);
    const isStringToPtr = valType.tag === "string" && hint.tag === "ptr" && hint.inner.tag === "int" && hint.inner.bits === 8;
    if (optInner && typeEq(optInner, valType) && hint.tag === "enum") {
      c.autoWrappedOption.set(value, hint.name);
      c.enforceWrapRange(value);
    } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
      c.arrayToVecCoercions.add(value);
    } else if (!isStringToPtr && !c.tryInterfaceCoercion(value, valType, hint)) {
      c.error(`type mismatch: '${stmt.name}' declared as ${c.show(hint)} but got ${c.show(valType)}`, sp, c.optionUnwrapHint(hint, valType));
    }
  }
  if (hint?.tag === "int") c.enforceRangeInto(value, valType, hint, sp);
  return { hint, valType, frozenBeforeRhs };
}

export function checkStmtBody(chk: TypeChecker, stmt: Stmt, fnRetType: TypeKind, valueTail: { expected: TypeKind | null } | null) {
  const sp = stmt.span;
  switch (stmt.kind) {
    case "LetDecl": {
      const { hint, valType, frozenBeforeRhs } = chk.checkBindingInit(stmt);
      const value = rewritten(chk.rewrites, stmt.value);
      // Borrows the RHS created: a ref binding owns them until its scope pops;
      // any other binding consumed them within the statement (e.g. s[0..n].clone())
      // and must not leak a freeze onto later statements.
      const newlyFrozen = chk.newlyFrozenSince(frozenBeforeRhs);
      const bindingType = hint ?? valType;
      // A void binding gets a storage slot it cannot have: `alloca void`. The value
      // side of "no data" is `Unit`; `void` is only a function return type. Silent once a
      // void generic has been reported: the bindings inside a monomorphized std body are
      // that one mistake propagating, at spans the programmer never wrote.
      if (bindingType.tag === "void" && chk.voidGenericReported.size === 0) {
        chk.error(`'${stmt.name}' cannot have type 'void': 'void' has no runtime representation`, sp,
          `drop the binding and call the function as a statement, or return 'Unit {}' instead of nothing`);
      }
      if (bindingType.tag !== "ref") for (const vi of newlyFrozen) chk.unfreeze(vi);
      else chk.refLets.add(stmt);
      chk.declare(stmt.name, { type: bindingType, mutable: false, borrowed: false, read: false, span: sp, ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
      const letInfo = chk.lookup(stmt.name);
      if (letInfo && bindingType.tag === "string") {
        const c = chk.sqlConstOf(value);
        if (c !== null) letInfo.constStr = c;
      }
      if (bindingType.tag === "ref") chk.attributeBorrows(newlyFrozen, stmt.name, letInfo);
      if (letInfo) chk.bindPointerViews(stmt.name, letInfo, value);
      if (letInfo) chk.noteClosureSources(letInfo, value);
      // An unannotated `let x = <const-int-value>` stays width-adaptable until
      // its first use (see VarInfo.flexInt): its default i32 can widen to an
      // i64 (etc.) context without an `as` cast, since the value is literals.
      if (!hint && valType.tag === "int") {
        const leaves = chk.flexIntLeaves(value);
        if (leaves) {
          const info = chk.lookup(stmt.name);
          if (info) { info.flexInt = { leaves, valueExpr: value }; chk.flexIntVars.set(info, stmt.name); }
        }
      }
      if (bindingType.tag === "array") chk.lintStackArray(stmt.name, bindingType, sp);
      const viewRoot = chk.viewBindRoot(stmt, hint, valType);
      if (viewRoot) chk.viewBindPending.set(stmt, { root: viewRoot, lint: () => chk.lintIndexClone(value, bindingType, sp) });
      else chk.lintIndexClone(value, bindingType, sp);
      const letCarried = chk.pointerBorrowsCarriedBy(value);
      chk.pointerMoveKeepsHolders = letCarried !== null;
      try { chk.tryMove(value); } finally { chk.pointerMoveKeepsHolders = false; }
      if (letCarried) chk.carryPointerBorrows(letCarried, stmt.name);
      break;
    }
    case "VarDecl": {
      const { hint, valType, frozenBeforeRhs } = chk.checkBindingInit(stmt);
      const value = rewritten(chk.rewrites, stmt.value);
      {
        const newlyFrozen = chk.newlyFrozenSince(frozenBeforeRhs);
        const bindingType = hint ?? valType;
        // A void binding gets a storage slot it cannot have: `alloca void`. The value
        // side of "no data" is `Unit`; `void` is only a function return type. Silent once a
        // void generic has been reported: the bindings inside a monomorphized std body are
        // that one mistake propagating, at spans the programmer never wrote.
        if (bindingType.tag === "void" && chk.voidGenericReported.size === 0) {
          chk.error(`'${stmt.name}' cannot have type 'void': 'void' has no runtime representation`, sp,
            `drop the binding and call the function as a statement, or return 'Unit {}' instead of nothing`);
        }
        if (bindingType.tag !== "ref") for (const vi of newlyFrozen) chk.unfreeze(vi);
        else chk.refLets.add(stmt);
        chk.declare(stmt.name, { type: bindingType, mutable: true, borrowed: false, read: false, span: sp, ...(bindingType.tag === "ref" && newlyFrozen.length > 0 && { freezes: newlyFrozen }) });
        const varInfo = chk.lookup(stmt.name);
        if (bindingType.tag === "ref") chk.attributeBorrows(newlyFrozen, stmt.name, varInfo);
        if (varInfo) chk.bindPointerViews(stmt.name, varInfo, value);
        if (varInfo) chk.noteClosureSources(varInfo, value);
        if (bindingType.tag === "array") chk.lintStackArray(stmt.name, bindingType, sp);
        chk.lintIndexClone(value, bindingType, sp);
      }
      const varCarried = chk.pointerBorrowsCarriedBy(value);
      chk.pointerMoveKeepsHolders = varCarried !== null;
      try { chk.tryMove(value); } finally { chk.pointerMoveKeepsHolders = false; }
      if (varCarried) chk.carryPointerBorrows(varCarried, stmt.name);
      break;
    }
    case "Assign": {
      const targetInfo = chk.resolveAssignTarget(stmt.target);
      const target = rewritten(chk.rewrites, stmt.target);
      if (!targetInfo.mutable) {
        // A pattern binding has no declaration to change, so the generic advice would
        // send the reader looking for a `let` that does not exist. Rebuilding the
        // variant is the move that works, and it costs no clone.
        // ident-ok: asks whether the assigned NAME is a pattern binding, to choose a hint; a place has no binding kind
        const tgtInfo = target.kind === "Ident" ? chk.lookup(target.name) : null;
        chk.error(`cannot assign to immutable variable '${chk.describeExpr(target)}'`, sp,
          tgtInfo?.patternBound
            ? `'${chk.describeExpr(target)}' is bound by a pattern of an immutable subject. Match through a '&mut' subject to write the payload in place, or assign a rebuilt value to the matched variable (e.g. 'n = Node.Leaf(v + 1)')`
            : `declare with 'var' instead of 'let' to make it mutable`);
        break;
      }
      // ident-ok: an Ident target replaces the WHOLE variable
      if (target.kind === "Ident") {
        const whole = chk.lookup(target.name);
        if (whole) chk.noteClosureSources(whole, stmt.value);
      }
      chk.markCaptureMutated(target);
      // reject reassignment while a borrow (slice, iteration ref) is live
      // but allow closures to mutate their own captured variables.
      // Whole-place assignment (`x = ...`, `x.f = ...`) drops the old value and frees
      // its buffer, so a live view into it would dangle. An index step is exempt: an
      // in-place element write never reallocates, so views stay valid and see it
      // (tests/fixtures/viewFreezeRelease.milo).
      const assignPath = chk.accessSteps(target);
      // The index/deref exemption above is a VIEW's exemption: writing an element in
      // place never reallocates, so a live slice stays valid and simply observes the
      // write. A `for-in` is the case it does not cover — the loop is handing out that
      // very element, so `for it in v { v[0] = x }` rewrites what `it` names. Without
      // this the rule gave two answers to one question depending on spelling:
      // `v.push(x)` was rejected inside the loop and `v[0] = x` was not.
      const indexQualified = assignPath ? assignPath.steps.some((s) => s === "[]" || s === "*") : false;
      const assignInfo = assignPath ? chk.lookup(assignPath.root) : null;
      if (assignPath && !indexQualified) {
        // A closure assigning to its own capture is exempt from the capture borrows.
        const isCapturedMutation = chk.closureScopeDepth !== null && (chk.currentClosureCaptures !== null && chk.currentClosureCaptures.has(assignPath.root));
        const info = chk.lookup(assignPath.root);
        const site = info && !isCapturedMutation ? chk.captureBorrowAgainst(info, chk.targetFields(target)) : null;
        if (site) {
          chk.reportCaptured(`cannot assign to '${chk.describeExpr(target)}'`, assignPath.root, site, sp);
          break;
        }
      }
      // Slice/index borrows taken to compute the RHS (e.g. `s[0..n].clone()`)
      // are consumed within this statement — no binding outlives it — so they
      // must not leak a freeze onto the next statement. Snapshot which vars are
      // already frozen, then release any newly-frozen by the RHS afterward.
      const frozenBeforeRhs = chk.openBorrowWindow();
      const valType = chk.checkExpr(stmt.value, targetInfo.type);
      chk.lintStringConcatInLoop(target, stmt.value, targetInfo.type, sp);
      if (targetInfo.type.tag === "cfn" && valType.tag !== "unknown"
          && !chk.checkCFnStore(stmt.value, targetInfo.type, valType, `cannot assign to '${chk.describeExpr(target)}'`, sp)) {
        chk.error(`type mismatch: cannot assign ${chk.show(valType)} to ${chk.show(targetInfo.type)}`, sp);
      } else if (targetInfo.type.tag !== "cfn" && !typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
        const optInner = chk.optionInnerType(targetInfo.type);
        const isStringToPtr = valType.tag === "string" && targetInfo.type.tag === "ptr" && targetInfo.type.inner.tag === "int" && targetInfo.type.inner.bits === 8;
        if (optInner && typeEq(optInner, valType) && targetInfo.type.tag === "enum") {
          chk.autoWrappedOption.set(stmt.value, targetInfo.type.name);
          chk.enforceWrapRange(stmt.value);
        } else if (!isStringToPtr) {
          chk.error(`type mismatch: cannot assign ${chk.show(valType)} to ${chk.show(targetInfo.type)}`, sp);
        }
      }
      for (const vi of chk.newlyFrozenSince(frozenBeforeRhs)) chk.unfreeze(vi);
      if (targetInfo.type.tag === "int") chk.enforceRangeInto(stmt.value, valType, targetInfo.type, sp);
      // ident-ok: assigning a whole variable revives it, and a field assignment deliberately must not revive the whole
      if (target.kind === "Ident") {
        const info = chk.lookup(target.name);
        if (info) {
          // `p = w.ptr()` overwrites whatever `p` pointed at, so the borrows the old
          // value held end here; the new ones are bound below. A `var` can never hold a
          // reference, so every freeze on it is a pointer borrow.
          if (info.freezes) { for (const src of info.freezes) chk.releasePointerBorrows(src, info); info.freezes = undefined; }
          info.pointerSourceMoved = undefined;
          chk.errorIfPointerOutlivesSource(target.name, info, stmt.value, sp);
          chk.bindPointerViews(target.name, info, stmt.value);
        }
      } else if (assignPath && assignInfo && chk.pointerViewsIn(stmt.value).length > 0) {
        // `c.buf = v.ptr()` / `ps[0] = v.ptr()`: the pointer now lives inside `c`/`ps`,
        // which holds it for as long as it lives. The old value of the slot is not
        // released (a field write cannot tell which of `c`'s borrows it overwrote), so
        // this can only over-approximate, and the whole-variable arm above is the reset.
        chk.errorIfPointerOutlivesSource(assignPath.root, assignInfo, stmt.value, sp);
        chk.bindPointerViews(assignPath.root, assignInfo, stmt.value);
      }
      chk.tryMove(stmt.value);
      break;
    }
    case "Return": {
      if (!stmt.value) {
        if (fnRetType.tag !== "void") chk.error(`return without value in function returning ${chk.show(fnRetType)}`, sp);
      } else {
        const valType = chk.checkExpr(stmt.value, fnRetType);
        const value = rewritten(chk.rewrites, stmt.value);
        // The signature's reference return was already rejected: a mismatch against it,
        // or a "move out of the borrowed" for handing a view back, is that error again.
        const retRejected = chk.currentFnDecl !== null && chk.refReturnReported.has(chk.currentFnDecl);
        if (!retRejected && !typeEq(fnRetType, valType) && valType.tag !== "unknown" && !(valType.tag === "never" && fnRetType.tag === "void") && fnRetType.tag !== "unknown") {
          const isStringToPtr = valType.tag === "string" && fnRetType.tag === "ptr" && fnRetType.inner.tag === "int" && fnRetType.inner.bits === 8;
          // Coerce a concrete type to an interface at return position
          // (`return Heap(Circle{})` where the fn returns Heap<Shape>), as
          // let-bindings and call args already do.
          if (!isStringToPtr && !chk.tryInterfaceCoercion(value, valType, fnRetType)) {
            chk.error(`return type mismatch: expected ${chk.show(fnRetType)}, got ${chk.show(valType)}`, sp);
          }
        }
        if (fnRetType.tag === "int") chk.enforceRangeInto(value, valType, fnRetType, sp);
        // A returned closure that captures by reference is rejected, not promoted —
        // see checkEscapingClosures for why the promotion that used to live here was
        // itself unsound.
        // A slice return may be legal (a method's slice of self), so each one is checked;
        // any other reference return was already rejected at the signature, and checking
        // the return only attaches the reason to that error.
        if (chk.isViewReturn(fnRetType) || (fnRetType.tag === "ref" && chk.currentFnDecl !== null && chk.refReturnDiags.has(chk.currentFnDecl))) {
          chk.checkViewProvenance(value, sp, fnRetType);
        }
        chk.errorIfReturnedPointerDangles(value, sp);
        // A `return v[i]` allocates exactly like `let m = v[i]` does, and was invisible
        // even with the lint on: the check only ran at a binding. `return b.v[0]` on a
        // borrowed struct is the shape docs/backlog.md #7 is about — the field spelling
        // is a hard error, the index spelling silently deep-copies.
        chk.lintIndexClone(value, valType, sp);
        if (!retRejected) chk.tryMove(value);
      }
      chk.reachable = false;
      break;
    }
    case "IfStmt": {
      const condType = chk.checkExpr(stmt.cond);
      if (condType.tag !== "bool" && condType.tag !== "unknown") {
        chk.error(`if condition must be bool, got ${chk.show(condType)}`, sp);
      }
      // With no else, the false path reaches the join unchanged.
      const preReachable = chk.reachable;
      const checkBody = (body: Stmt[]) => () => {
        chk.pushScope();
        for (const s of body) chk.checkStmt(s, fnRetType);
        chk.popScope();
      };
      const thenPath = chk.checkPath(preReachable, checkBody(stmt.thenBody));
      const elsePath = stmt.elseBody ? chk.checkPath(preReachable, checkBody(stmt.elseBody)) : preReachable;
      chk.joinPaths([thenPath, elsePath]);
      break;
    }
    case "WhileStmt": {
      const condType = chk.checkExpr(stmt.cond);
      if (condType.tag !== "bool" && condType.tag !== "unknown") {
        chk.error(`while condition must be bool, got ${chk.show(condType)}`, sp);
      }
      for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
      chk.beginLoop();
      chk.pushScope();
      chk.loopDepth++;
      for (const s of stmt.body) chk.checkStmt(s, fnRetType);
      chk.loopDepth--;
      chk.popScope();
      chk.endLoop(!(stmt.cond.kind === "BoolLit" && stmt.cond.value));
      break;
    }
    case "ForInStmt": {
      if (stmt.iterable.kind === "RangeExpr") {
        const startType = chk.checkExpr(stmt.iterable.start);
        const endType = chk.checkExpr(stmt.iterable.end);
        if (startType.tag !== "int" && startType.tag !== "unknown") {
          chk.error(`for range start must be an integer, got ${chk.show(startType)}`, sp);
        }
        if (endType.tag !== "int" && endType.tag !== "unknown") {
          chk.error(`for range end must be an integer, got ${chk.show(endType)}`, sp);
        }
        if (stmt.varName2) {
          chk.error("range for loop takes one binding, not two", sp);
        }
        if (stmt.mutRef) {
          chk.error(`'for ${stmt.varName} in &mut' iterates a Vec, array or slice, not a range`, sp,
            `a range yields fresh integers with nothing to write back to; drop the '&mut'`);
        }
        // Widen to the larger int type so 0..vec.len() just works
        let varType: TypeKind;
        if (startType.tag === "int" && endType.tag === "int") {
          varType = startType.bits >= endType.bits ? startType : endType;
        } else {
          varType = startType.tag === "int" ? startType : endType;
        }
        chk.setType(stmt.iterable, varType);
        chk.beginLoop();
        chk.pushScope();
        chk.declare(stmt.varName, { type: varType, mutable: false, borrowed: false, read: false }, stmt.span);
        for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
        chk.noteForInBind(stmt);
        chk.loopDepth++;
        for (const s of stmt.body) chk.checkStmt(s, fnRetType);
        chk.loopDepth--;
        chk.popScope();
        chk.endLoop(true);
      } else {
        // `for line in text.lines()` / `for f in text.splitView(",")` — a text pass that
        // allocates nothing. Handled here and nowhere else: the yielded `&string` views
        // cannot travel through the `next(): Option<T>` iterator protocol, because a
        // reference inside an enum payload is a rejected return (see errorIfRefReturn).
        const viewMode = chk.stringViewIterMode(stmt.iterable);
        if (viewMode && stmt.mutRef) {
          chk.error(`'for ${stmt.varName} in &mut' iterates a Vec, array or slice; '${viewMode === "lines" ? "lines()" : "splitView()"}' yields read-only views`, sp);
        }
        if (viewMode) { chk.checkStringViewForIn(stmt, viewMode, fnRetType); return; }
        let iterType = chk.checkExpr(stmt.iterable);
        if (stmt.mutRef) chk.checkMutForInSource(stmt, iterType, sp);
        // Consuming loop: an owned temporary Vec/array is moved into the loop, which
        // hands each element out by value. Tested on the type BEFORE the ref-deref
        // below, so a slice or `&Vec` result never qualifies.
        const ownsIterable = !stmt.mutRef && !chk.isPlaceIterable(stmt.iterable);
        if (ownsIterable) chk.tryMove(stmt.iterable);
        const consume = ownsIterable &&
          (iterType.tag === "vec" || (iterType.tag === "array" && iterType.size !== null));
        if (consume) chk.consumingForIns.add(stmt);
        // iterating a slice (&[T]) or &Vec: deref — the loop borrows the view, not a copy
        if (iterType.tag === "ref" && (iterType.inner.tag === "array" || iterType.inner.tag === "vec")) {
          iterType = iterType.inner;
        }
        // `@iter` on a field redirects the loop to that field. A newtype over a
        // container (HashSet over HashMap) then iterates exactly as the container
        // does — same bindings, same borrow, no snapshot — instead of needing a
        // `next` method it cannot write (an iterator would have to hold a
        // reference into the wrapper, and references are second-class).
        {
          const structTy = iterType.tag === "ref" && iterType.inner.tag === "struct" ? iterType.inner : iterType;
          if (structTy.tag === "struct") {
            const delegate = chk.structs.get(structTy.name)?.fields.find(f => f.iterDelegate);
            if (delegate) {
              chk.iterDelegates.set(stmt, delegate.name);
              iterType = delegate.type;
            }
          }
        }
        // One freeze for every container shape below (see freezeIterable). A consumed
        // temporary has no root to freeze.
        const iterBorrow = consume ? null : chk.freezeIterable(stmt.iterable, sp);
        if (iterType.tag === "vec") {
          const mutElem = !!stmt.mutRef;
          const elemRef: TypeKind = consume ? iterType.element : { tag: "ref", inner: iterType.element, mutable: mutElem };
          chk.beginLoop();
          chk.pushScope();
          if (stmt.varName2) {
            // enumerate: for i, val in vec
            const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
            chk.declare(stmt.varName, { type: idxType, mutable: false, borrowed: false, read: false }, stmt.span);
            chk.declare(stmt.varName2, { type: elemRef, mutable: mutElem, borrowed: false, read: false }, stmt.span);
          } else {
            chk.declare(stmt.varName, { type: elemRef, mutable: mutElem, borrowed: false, read: false }, stmt.span);
          }
          for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
          chk.noteForInBind(stmt);
          chk.loopDepth++;
          for (const s of stmt.body) chk.checkStmt(s, fnRetType);
          chk.loopDepth--;
          chk.popScope();
          chk.endLoop(true);
        } else if (iterType.tag === "string") {
          const byteType: TypeKind = { tag: "int", bits: 8, signed: false };
          chk.beginLoop();
          chk.pushScope();
          if (stmt.varName2) {
            const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
            chk.declare(stmt.varName, { type: idxType, mutable: false, borrowed: false, read: false }, stmt.span);
            chk.declare(stmt.varName2, { type: byteType, mutable: false, borrowed: false, read: false }, stmt.span);
          } else {
            chk.declare(stmt.varName, { type: byteType, mutable: false, borrowed: false, read: false }, stmt.span);
          }
          for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
          chk.noteForInBind(stmt);
          chk.loopDepth++;
          for (const s of stmt.body) chk.checkStmt(s, fnRetType);
          chk.loopDepth--;
          chk.popScope();
          chk.endLoop(true);
        } else if (iterType.tag === "hashmap") {
          const keyRef: TypeKind = { tag: "ref", inner: iterType.key, mutable: false };
          const valRef: TypeKind = { tag: "ref", inner: iterType.value, mutable: false };
          chk.beginLoop();
          chk.pushScope();
          chk.declare(stmt.varName, { type: keyRef, mutable: false, borrowed: false, read: false }, stmt.span);
          if (stmt.varName2) {
            chk.declare(stmt.varName2, { type: valRef, mutable: false, borrowed: false, read: false }, stmt.span);
          }
          for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
          chk.noteForInBind(stmt);
          chk.loopDepth++;
          for (const s of stmt.body) chk.checkStmt(s, fnRetType);
          chk.loopDepth--;
          chk.popScope();
          chk.endLoop(true);
        } else if (iterType.tag === "array") {
          const mutElem = !!stmt.mutRef;
          const elemRef: TypeKind = consume ? iterType.element : { tag: "ref", inner: iterType.element, mutable: mutElem };
          chk.beginLoop();
          chk.pushScope();
          if (stmt.varName2) {
            const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
            chk.declare(stmt.varName, { type: idxType, mutable: false, borrowed: false, read: false }, stmt.span);
            chk.declare(stmt.varName2, { type: elemRef, mutable: mutElem, borrowed: false, read: false }, stmt.span);
          } else {
            chk.declare(stmt.varName, { type: elemRef, mutable: mutElem, borrowed: false, read: false }, stmt.span);
          }
          for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
          chk.noteForInBind(stmt);
          chk.loopDepth++;
          for (const s of stmt.body) chk.checkStmt(s, fnRetType);
          chk.loopDepth--;
          chk.popScope();
          chk.endLoop(true);
        } else if (iterType.tag === "struct" || iterType.tag === "enum") {
          // iterator protocol: type has next(&mut Self): Option<T>
          const resolved = chk.resolveMethod(iterType.name, "next");
          // A generic type parameter (`for x in it`, `it: I` where `I: Iterator`) is not a
          // registered struct/enum, so `next` can't resolve until this function is
          // monomorphized to a concrete type. Defer: check the body with the element type
          // unknown; the per-instantiation re-check binds the real type and sets up the
          // iteration. A real type that simply lacks `next` still errors.
          if (!resolved && !chk.structs.has(iterType.name) && !chk.enums.has(iterType.name)) {
            chk.pushScope();
            chk.declare(stmt.varName, { type: { tag: "unknown" }, mutable: false, borrowed: false, read: false }, stmt.span);
            for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
            chk.noteForInBind(stmt);
            // The frame only gives this body's break/continue somewhere to count into.
            const loopReachable = chk.reachable;
            chk.loopFrames.push({ breaks: 0, continues: 0, reachable: loopReachable });
            chk.loopDepth++;
            for (const s of stmt.body) chk.checkStmt(s, fnRetType);
            chk.loopDepth--;
            chk.loopFrames.pop();
            chk.reachable = loopReachable;
            chk.popScope();
          } else if (!resolved) {
            chk.error(`cannot iterate over type '${chk.show(iterType)}': no 'next' method found`, sp);
          } else {
            const retType = resolved.sig.ret;
            let elemType: TypeKind | null = null;
            let optionEnumName = "";
            if (retType.tag === "enum") {
              const enumInfo = chk.enums.get(retType.name);
              if (enumInfo && enumInfo.baseName === "Option") {
                const someVariant = enumInfo.variants.get("Some");
                if (someVariant && someVariant.fields.length === 1) {
                  elemType = someVariant.fields[0];
                  optionEnumName = retType.name;
                }
              }
            }
            if (!elemType) {
              chk.error(`iterator 'next' method must return Option<T>, got ${chk.show(retType)}`, sp);
            } else {
              // require iterable to be mutable (next takes &mut Self)
              // Asks the PLACE whether its root is mutable, so an iterator held in a
              // field or reached any other way is checked too. Keyed to a bare `Ident`,
              // this rule simply did not run for `for x in self.cursor`.
              // Only a NAMED root can be immutable. An rvalue iterable (`for x in
              // makeChannel()`) has no root at all: it is materialized into a temp, and
              // a temp is mutable, so demanding `var` of it rejects a legal program.
              const iterRoot = chk.accessPath(stmt.iterable);
              if (iterRoot && !chk.isRootMutable(stmt.iterable)) {
                chk.error(`cannot iterate: '${chk.describeExpr(stmt.iterable)}' must be 'var' (iterator mutates via next())`, sp);
              }
              if (stmt.varName2) {
                chk.error("iterator for loop takes one binding, not two", sp);
              }
              chk.iteratorForIns.set(stmt, { nextMethod: resolved.mangled, elemType, optionEnumName });
              chk.beginLoop();
              chk.pushScope();
              chk.declare(stmt.varName, { type: elemType, mutable: false, borrowed: false, read: false }, stmt.span);
              for (const inv of stmt.invariants ?? []) chk.checkContractClause(inv);
              chk.noteForInBind(stmt);
              chk.loopDepth++;
              for (const s of stmt.body) chk.checkStmt(s, fnRetType);
              chk.loopDepth--;
              chk.popScope();
              chk.endLoop(true);
            }
          }
        } else if (iterType.tag !== "unknown") {
          chk.error(`cannot iterate over type '${chk.show(iterType)}'`, sp);
        }
        // Released once, for whichever arm above ran. Paired with the single
        // freezeIterable before the dispatch — see that function for why the pairing
        // is here and not inside each arm.
        if (iterBorrow) chk.releaseBorrowSite(iterBorrow.info, iterBorrow.site);
      }
      break;
    }
    case "BreakStmt":
      if (chk.loopDepth === 0) chk.error("'break' outside of loop", sp);
      else if (chk.reachable) { const fr = chk.loopFrames[chk.loopFrames.length - 1]; if (fr) fr.breaks++; };
      chk.reachable = false;
      break;
    case "ContinueStmt":
      if (chk.loopDepth === 0) chk.error("'continue' outside of loop", sp);
      else if (chk.reachable) { const fr = chk.loopFrames[chk.loopFrames.length - 1]; if (fr) fr.continues++; };
      chk.reachable = false;
      break;
    case "ExprStmt": {
      // A view produced by a discarded expression (`print(lx.word(0, 5))`) has no
      // binding to outlive the statement, so its freeze must not survive it either —
      // same reasoning as the RHS snapshot in Assign, which this mirrors.
      const frozenBefore = chk.openBorrowWindow();
      const exprType = chk.checkExpr(stmt.expr, valueTail?.expected ?? null);
      for (const vi of chk.newlyFrozenSince(frozenBefore)) chk.unfreeze(vi);
      let warned = valueTail !== null;
      if (!warned && exprType.tag === "enum") {
        const enumInfo = chk.enums.get(exprType.name);
        const base = enumInfo?.baseName;
        if (base === "Result" || base === "Option") {
          warned = true;
          chk.warn("unused-result",
            `unused ${base} value — this may contain an error that should be handled`,
            sp, `use 'let _ = ...' to discard explicitly`);
        }
      }
      // `@mustUse` callee: same warning, for a result whose type does not say it
      // encodes failure. Skipped when the Option/Result branch already fired so one
      // statement never reports twice.
      if (!warned) {
        const callee = chk.mustUseCallee(stmt.expr);
        if (callee) {
          chk.warn("unused-result",
            `unused result of '@mustUse' function '${callee}'`,
            sp, `use 'let _ = ...' to discard explicitly`);
        }
      }
      break;
    }
    case "MatchStmt": {
      chk.checkMatchLike(stmt.subject, stmt.arms, sp, fnRetType, true);
      break;
    }
    case "IfLetStmt": {
      const rawSubjType = chk.checkExpr(stmt.subject);
      // Names first: whether the subject is only inspected depends on which payload
      // positions bind, and `Some(None)` binds nothing once `None` is known to be a variant.
      const rawBound = chk.bindElidedPattern(stmt.pattern, rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType);
      const { subjType, subjBorrows, subjIsMut } = chk.enumSubjectBorrow(stmt.subject, rawSubjType, [rawBound]);
      const pat = chk.bindElidedPattern(rawBound, subjType);
      if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
        chk.error(`if let subject must be an enum, got ${chk.show(subjType)}`, sp);
        break;
      }
      // Same branch rule as IfStmt: a body that always exits does not leak its moves
      // to the code after the if. `if let Some(i) = find(k) { v[i] = value  return }`
      // followed by `insert(value)` used to be "use of moved variable".
      const preReachable = chk.reachable;
      chk.pushScope();
      chk.bindLetClause(pat, stmt.subject, subjType, subjBorrows, subjIsMut);
      for (const s of stmt.thenBody) chk.checkStmt(s, fnRetType);
      chk.popScope();
      const thenPath = chk.reachable;
      const elseBody = stmt.elseBody;
      const elsePath = elseBody
        ? chk.checkPath(preReachable, () => {
          chk.pushScope();
          for (const s of elseBody) chk.checkStmt(s, fnRetType);
          chk.popScope();
        })
        : preReachable;
      chk.joinPaths([thenPath, elsePath]);
      // A borrowed subject is only read, not consumed.
      if (!subjBorrows) chk.tryMove(stmt.subject);
      break;
    }
    case "IfChainStmt": {
      // Clauses open nested scopes left to right, so a `let` clause's bindings reach the
      // later clauses and the then-body. The else is checked once, outside all of them,
      // starting from every state a failing clause can leave: a clause that fails after
      // an earlier `let` destructured an owned subject leaves that subject moved (its
      // payload went to a binding, which is dropped), exactly as in Rust.
      const failPaths: boolean[] = [];
      const consumed: Expr[] = [];
      let opened = 0;
      for (const c of stmt.clauses) {
        if (c.kind === "CondClause") {
          const ct = chk.checkExpr(c.cond);
          if (ct.tag !== "bool" && ct.tag !== "unknown") chk.error(`if condition must be bool, got ${chk.show(ct)}`, c.span ?? sp);
          failPaths.push(chk.reachable);
          continue;
        }
        const rawSubjType = chk.checkExpr(c.subject);
        const rawBound = chk.bindElidedPattern(c.pattern, rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType);
        const { subjType, subjBorrows, subjIsMut } = chk.enumSubjectBorrow(c.subject, rawSubjType, [rawBound]);
        const pat = chk.bindElidedPattern(rawBound, subjType);
        failPaths.push(chk.reachable);
        chk.pushScope();
        opened++;
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          chk.error(`if let subject must be an enum, got ${chk.show(subjType)}`, c.span ?? sp);
          continue;
        }
        chk.bindLetClause(pat, c.subject, subjType, subjBorrows, subjIsMut);
        if (!subjBorrows) consumed.push(c.subject);
      }
      chk.pushScope();
      for (const s of stmt.thenBody) chk.checkStmt(s, fnRetType);
      chk.popScope();
      for (let i = 0; i < opened; i++) chk.popScope();
      const thenPath = chk.reachable;
      chk.joinPaths(failPaths);
      const elseReachable = chk.reachable;
      const elseBody = stmt.elseBody;
      const elsePath = elseBody
        ? chk.checkPath(elseReachable, () => {
          chk.pushScope();
          for (const s of elseBody) chk.checkStmt(s, fnRetType);
          chk.popScope();
        })
        : elseReachable;
      chk.joinPaths([thenPath, elsePath]);
      for (const subj of consumed) chk.tryMove(subj);
      break;
    }
    case "LetElseStmt": {
      if (stmt.bindName !== undefined) { chk.checkNullRefUnwrap(stmt, stmt.bindName, fnRetType, sp); break; }
      const rawSubjType = chk.checkExpr(stmt.value);
      const rawBound = chk.bindElidedPattern(stmt.pattern, rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType);
      const { subjType, subjBorrows, subjIsMut } = chk.enumSubjectBorrow(stmt.value, rawSubjType, [rawBound]);
      const pat = chk.bindElidedPattern(rawBound, subjType);
      if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
        chk.error(`let-else value must be an enum (Option/Result/…), got ${chk.show(subjType)}`, sp);
        break;
      }
      // The else block runs only when the pattern doesn't match, so it must
      // diverge — otherwise the binding below wouldn't be guaranteed live. It's
      // checked (in its own scope) BEFORE the binding is declared, so the
      // binding is not in scope inside it.
      const preElseReachable = chk.reachable;
      chk.pushScope();
      for (const s of stmt.elseBody) chk.checkStmt(s, fnRetType);
      chk.popScope();
      if (!chk.bodyAlwaysReturns(stmt.elseBody)) {
        chk.error(`let-else block must diverge (return/break/continue) — it runs when the pattern doesn't match`, sp);
      }
      chk.reachable = preElseReachable;
      if (subjType.tag === "enum" && pat.kind === "EnumPattern") {
        const enumInfo = must(chk.enums, subjType.name, "enums");
        const ps = pat.span;
        if (pat.enumName !== subjType.name && enumInfo.baseName !== pat.enumName) {
          chk.error(`pattern enum '${pat.enumName}' does not match value type '${subjType.name}'`, ps);
        }
        const variant = enumInfo.variants.get(pat.variant);
        if (!variant) {
          chk.error(`enum '${subjType.name}' has no variant '${pat.variant}'`, ps);
        } else if (pat.bindings.length !== variant.fields.length) {
          chk.error(`variant '${pat.variant}' has ${variant.fields.length} fields, but pattern has ${pat.bindings.length} bindings`, ps);
        }
        if (variant && isNestedPattern(pat)) {
          // Bindings escape into the CURRENT scope (the whole point vs if-let).
          chk.declarePatternLeaves(pat, chk.patternLeaves(pat, subjType, true), stmt.value, subjBorrows, subjIsMut, true);
        } else if (variant) {
          const bindTypes = variant.fields.slice(0, pat.bindings.length).map(t => chk.payloadBindType(t, subjBorrows, subjIsMut));
          chk.patternBindingTypes.set(pat, bindTypes);
          const freezes = chk.freezeSubjectFor(stmt.value, bindTypes);
          // Bindings escape into the CURRENT scope (the whole point vs if-let).
          for (let i = 0; i < Math.min(pat.bindings.length, variant.fields.length); i++) {
            const bindSpan = pat.bindingSpans?.[i] ?? pat.span;
            chk.declare(pat.bindings[i], { type: bindTypes[i], mutable: subjIsMut, borrowed: false, read: false, span: bindSpan, patternBound: true,
              copyBind: chk.isCopyBind(bindTypes[i], chk.isPlaceExpr(stmt.value)), ...(i === 0 && freezes.length > 0 && { freezes }) });
            const bound = chk.lookup(pat.bindings[i]);
            if (i === 0) chk.attributeBorrows(freezes, pat.bindings[0], bound);
            if (bound) chk.noteRefInto(bound, stmt.value, pat.variant, i);
          }
        }
      }
      // A borrowed value is only read, not consumed.
      if (!subjBorrows) chk.tryMove(stmt.value);
      break;
    }
    case "UnsafeBlock": {
      chk.unsafeDepth++;
      chk.unsafeUsedStack.push(false);
      chk.pushScope();
      for (const s of stmt.body) chk.checkStmt(s, fnRetType);
      chk.popScope();
      const used = chk.unsafeUsedStack.pop();
      chk.unsafeDepth--;
      // only lint user code — stdlib has many technically-removable blocks
      if (!used && chk.currentFnIsUser) {
        chk.warn("unused-unsafe", `unnecessary 'unsafe' block: nothing inside requires unsafe`, stmt.span, `remove the 'unsafe' wrapper`, "unsafe".length);
      }
      break;
    }
    default: {
      // A statement kind with no arm is never checked — no type error, no move error, no
      // diagnostic of any kind for anything inside it. This makes the next unhandled kind
      // a compile error instead of a silent pass.
      const _exhaustive: never = stmt;
      void _exhaustive;
    }
  }
}

// T → Option<T> auto-wrapping: returns the monomorphized Option name if param is Option and arg matches inner type
export function optionInnerType(c: TypeChecker, paramType: TypeKind): TypeKind | null {
  if (paramType.tag !== "enum") return null;
  const info = c.enums.get(paramType.name);
  if (!info || info.baseName !== "Option") return null;
  const someVariant = info.variants.get("Some");
  if (!someVariant || someVariant.fields.length !== 1) return null;
  return someVariant.fields[0];
}

export function tryDeferVecInfer(chk: TypeChecker, value: Expr): TypeKind | null {
  // `Vec<T>.new()` spells its element; nothing to defer.
  if (value.kind !== "EnumLit" || value.enumName !== "Vec" || value.typeArgs?.length) return null;
  if (value.variant === "new") {
    if (value.args.length !== 0) chk.error(`'Vec.new' takes no arguments`, value.span);
  } else if (value.variant === "withCapacity") {
    if (value.args.length !== 1) chk.error(`'Vec.withCapacity' expects 1 argument (capacity), got ${value.args.length}`, value.span);
    else {
      const c = chk.checkExpr(value.args[0]);
      if (c.tag !== "int" && c.tag !== "unknown") chk.error(`'Vec.withCapacity': capacity must be an integer, got ${chk.show(c)}`, value.span);
    }
  } else {
    return null;
  }
  return chk.makeDeferredVec(value);
}

export function makeDeferredVec(c: TypeChecker, value: import("./ast").EnumLit): TypeKind {
  const inferId = c.inferred.length;
  c.inferred.push(undefined);
  const elem: TypeKind = { tag: "unknown", inferId };
  const vecTy: TypeKind = { tag: "vec", element: elem };
  if (value.variant === "withCapacity") c.inferVecCtors.set(inferId, value);
  c.pendingInferVecs.push({ elem, span: value.span });
  c.exprTypes.set(value, vecTy);
  return vecTy;
}

// Borrow-detection for if-let/let-else subjects, mirroring checkMatchLike: a
// `&enum` or an enum place (s.field, v[i], *h) is read without being consumed,
// so its non-Copy payload must bind as a borrow, not a move. Resolves the enum
// type behind the ref and registers the subject in matchSubjectRef when it
// borrows (lower reads that to emit subjectIsRef).
// One `if let` clause, in the scope the caller has just opened: validate the pattern
// against the subject's enum, declare its bindings (by borrow or by value, the match-arm
// rule) and consume an owned subject the pattern destructures. While the then-body runs,
// that subject reads as moved.
export function bindLetClause(c: TypeChecker, pattern: Pattern, subject: Expr, subjType: TypeKind, subjBorrows: boolean, subjIsMut: boolean): void {
  if (subjType.tag !== "enum" || pattern.kind !== "EnumPattern") return;
  const enumInfo = must(c.enums, subjType.name, "enums");
  const ps = pattern.span;
  if (pattern.enumName !== subjType.name && enumInfo.baseName !== pattern.enumName) {
    c.error(`pattern enum '${pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
  }
  const variant = enumInfo.variants.get(pattern.variant);
  if (!variant) {
    c.error(`enum '${subjType.name}' has no variant '${pattern.variant}'`, ps);
  } else if (pattern.bindings.length !== variant.fields.length) {
    c.error(`variant '${pattern.variant}' has ${variant.fields.length} fields, but pattern has ${pattern.bindings.length} bindings`, ps);
  }
  if (variant && isNestedPattern(pattern)) {
    c.declarePatternLeaves(pattern, c.patternLeaves(pattern, subjType, true), subject, subjBorrows, subjIsMut, true);
  } else if (variant) {
    const bindTypes = variant.fields.slice(0, pattern.bindings.length).map(t => c.payloadBindType(t, subjBorrows, subjIsMut));
    c.patternBindingTypes.set(pattern, bindTypes);
    const freezes = c.freezeSubjectFor(subject, bindTypes);
    for (let i = 0; i < Math.min(pattern.bindings.length, variant.fields.length); i++) {
      const bindSpan = pattern.bindingSpans?.[i] ?? pattern.span;
      c.declare(pattern.bindings[i], { type: bindTypes[i], mutable: subjIsMut, borrowed: false, read: false, span: bindSpan, patternBound: true,
        copyBind: c.isCopyBind(bindTypes[i], c.isPlaceExpr(subject)), ...(i === 0 && freezes.length > 0 && { freezes }) });
      const bound = c.lookup(pattern.bindings[i]);
      if (i === 0) c.attributeBorrows(freezes, pattern.bindings[0], bound);
      if (bound) c.noteRefInto(bound, subject, pattern.variant, i);
    }
  }
  // Same arm-entry consumption as match: a destructuring then-branch
  // zeroes the payload before its body runs, so the subject is dead
  // there. The else-branch never destructures, so it stays readable.
  if (!subjBorrows && c.armConsumesSubject(pattern, enumInfo, subjType)) {
    c.tryMove(subject);
  }
}

export function bindElidedPattern(c: TypeChecker, pattern: Pattern, subjType: TypeKind): Pattern {
  const cur = rewrittenPattern(c.patternRewrites, pattern);
  const next = c.elidedPatternFor(cur, subjType);
  if (next !== cur) c.patternRewrites.set(cur, next);
  return next;
}

// `pattern` with its blanks filled in, or `pattern` itself when there are none. A changed sub-pattern
// is not recorded on its own: it travels inside the replacement of the pattern that holds it.
export function elidedPatternFor(c: TypeChecker, pattern: Pattern, subjType: TypeKind): Pattern {
  if (pattern.kind !== "EnumPattern" || subjType.tag !== "enum") return pattern;
  const enumName = pattern.enumName === "" ? subjType.name : pattern.enumName;
  const info = c.enums.get(subjType.name);
  const variant = info === undefined ? undefined : info.variants.get(pattern.variant);
  let slotsChanged = false;
  const bindings: string[] = [];
  const args: (Pattern | null)[] = [];
  for (let i = 0; i < pattern.bindings.length; i++) {
    let binding = pattern.bindings[i]!;
    let sub: Pattern | null = pattern.args !== undefined && i < pattern.args.length ? pattern.args[i]! : null;
    const ft = variant === undefined ? undefined : variant.fields[i];
    if (ft !== undefined && sub !== null) {
      const nsub = c.elidedPatternFor(sub, ft);
      if (nsub !== sub) { sub = nsub; slotsChanged = true; }
    } else if (ft !== undefined && ft.tag === "enum" && binding !== "_") {
      const named = c.enums.get(ft.name);
      const bare = named === undefined ? undefined : named.variants.get(binding);
      if (bare !== undefined && bare.fields.length === 0) {
        sub = { kind: "EnumPattern", enumName: ft.name, variant: binding, bindings: [], span: pattern.bindingSpans !== undefined && i < pattern.bindingSpans.length ? pattern.bindingSpans[i] : pattern.span };
        binding = "_";
        slotsChanged = true;
      }
    }
    bindings.push(binding);
    args.push(sub);
  }
  if (enumName === pattern.enumName && !slotsChanged) return pattern;
  return { kind: "EnumPattern", enumName, variant: pattern.variant, bindings, bindingSpans: pattern.bindingSpans, args: slotsChanged ? args : pattern.args, span: pattern.span };
}

// The bindings of an enum pattern matched against `et`, in `patternLeafNames` order. With
// `report`, the sub-patterns are validated as it goes (enum, variant, arity, literal
// kind); the top level is the caller's to validate, since each caller words that error
// for its own construct.
export function patternLeaves(c: TypeChecker, p: Pattern, et: TypeKind, report: boolean, steps: PatternLeaf["steps"] = []): PatternLeaf[] {
  if (p.kind !== "EnumPattern") return [];
  // Under a sub-pattern that cannot match, its bindings are still declared, typed
  // `unknown`, so the one error above is the only one: no "undefined variable" cascade.
  const unknownLeaves = (q: Pattern): PatternLeaf[] =>
    patternLeafNames(q).map(name => ({ name, type: { tag: "unknown" }, span: q.span, steps }));
  if (et.tag !== "enum") return unknownLeaves(p);
  const info = c.enums.get(et.name);
  if (info && steps.length > 0 && p.enumName !== et.name && info.baseName !== p.enumName) {
    if (report) c.error(`pattern enum '${p.enumName}' does not match payload type '${c.show(et)}'`, p.span);
    return unknownLeaves(p);
  }
  const variant = info?.variants.get(p.variant);
  if (!info || !variant) {
    if (report && info && steps.length > 0) c.error(`enum '${c.show(et)}' has no variant '${p.variant}'`, p.span);
    return unknownLeaves(p);
  }
  if (report && steps.length > 0 && p.bindings.length !== variant.fields.length) {
    c.error(`variant '${p.variant}' has ${variant.fields.length} fields, but pattern has ${p.bindings.length} bindings`, p.span);
  }
  const out: PatternLeaf[] = [];
  const n = Math.min(p.bindings.length, variant.fields.length);
  for (let i = 0; i < n; i++) {
    const ft = variant.fields[i]!;
    const at = [...steps, { variant: p.variant, index: i }];
    const sub = p.args?.[i];
    if (!sub) { out.push({ name: p.bindings[i]!, type: ft, span: p.bindingSpans?.[i] ?? p.span, steps: at }); continue; }
    if (sub.kind === "EnumPattern") {
      if (ft.tag !== "enum" && report && ft.tag !== "unknown") {
        c.error(`payload ${i + 1} of '${p.variant}' is ${c.show(ft)}, so it cannot be matched against the variant pattern '${sub.variant}'`, sub.span);
      }
      out.push(...c.patternLeaves(sub, ft, report, at));
    } else if (sub.kind === "LiteralPattern" && report) {
      const ok = ft.tag === "unknown"
        || (ft.tag === "int" && (sub.literalKind === "int" || sub.literalKind === "char"))
        || (ft.tag === "float" && (sub.literalKind === "float" || sub.literalKind === "int"))
        || (ft.tag === "string" && sub.literalKind === "string")
        || (ft.tag === "bool" && sub.literalKind === "bool");
      if (!ok) c.error(`a ${sub.literalKind} literal cannot match payload ${i + 1} of '${p.variant}', which is ${c.show(ft)}`, sub.span);
    }
  }
  return out;
}

// Declares a nested pattern's bindings in the current scope: the flat binding rule
// (`payloadBindType`) applied to every leaf, so the outer subject alone decides between
// by-value and by-borrow, however deep the binding sits.
export function declarePatternLeaves(c: TypeChecker, pattern: Pattern, leaves: PatternLeaf[], subject: Expr, subjBorrows: boolean, subjIsMut: boolean, attribute: boolean): void {
  const bindTypes = leaves.map(l => c.payloadBindType(l.type, subjBorrows, subjIsMut));
  c.patternBindingTypes.set(pattern, bindTypes);
  const freezes = c.freezeSubjectFor(subject, bindTypes);
  leaves.forEach((l, i) => {
    c.declare(l.name, { type: bindTypes[i]!, mutable: subjIsMut, borrowed: false, read: false, span: l.span, patternBound: true,
      copyBind: c.isCopyBind(bindTypes[i]!, c.isPlaceExpr(subject)), ...(i === 0 && freezes.length > 0 && { freezes }) });
    const bound = c.lookup(l.name);
    if (attribute && i === 0) c.attributeBorrows(freezes, l.name, bound);
    if (bound) c.noteRefIntoSteps(bound, subject, l.steps);
  });
}

export function flexIntLeaves(c: TypeChecker, e: Expr): Expr[] | null {
  if (c.isConstIntExpr(e)) return [e];
  if (e.kind === "IfExpr") {
    const t = c.tailFlexLeaves(e.thenBody);
    const el = c.tailFlexLeaves(e.elseBody);
    return t && el ? [...t, ...el] : null;
  }
  if (e.kind === "MatchExpr") {
    const all: Expr[] = [];
    for (const arm of e.arms) {
      const l = c.tailFlexLeaves(arm.body);
      if (!l) return null;
      all.push(...l);
    }
    return all.length > 0 ? all : null;
  }
  return null;
}

export function tailFlexLeaves(c: TypeChecker, body: Stmt[]): Expr[] | null {
  const tail = c.tailExprOf(body);
  return tail ? c.flexIntLeaves(tail) : null;
}
