// Move tracking and call-site exclusivity: tryMove, assignment targets, closure capture writes (pairs with checker-borrows.ts).
import type { TypeChecker } from "./checker";
import type { ArgUse, CaptureInfo, NestedWrite, PlaceStep, VarInfo } from "./checker";
import { isNestedPattern, patternLeafNames } from "./ast";
import type { Expr, Pattern, Span, Stmt, FieldAccess, UnaryOp } from "./ast";
import type { TypeKind } from "./types";
import { memberHint } from "./suggest";
import { pathsOverlap, rewritten, rewrittenPattern, stepKey, stepLabel } from "./checker-util";

// An arm that binds a non-Copy payload by value consumes the subject at ARM
// ENTRY — codegen zeroes the payload slot there (see extractBindings) — so
// reading the subject inside that arm sees zeroed data. Arms with no bindings,
// or only Copy ones, leave the subject intact and may still read it.
export function armConsumesSubject(c: TypeChecker, pattern: Pattern, enumInfo: { variants: Map<string, { fields: TypeKind[] }> }, subjType: TypeKind): boolean {
  if (pattern.kind !== "EnumPattern" || pattern.bindings.length === 0) return false;
  const variant = enumInfo.variants.get(pattern.variant);
  if (!variant) return false;
  // Nested: any binding that takes a non-Copy payload, at whatever depth.
  if (isNestedPattern(pattern)) return c.patternLeaves(pattern, subjType, false).some(l => !c.isCopyType(l.type));
  const n = Math.min(pattern.bindings.length, variant.fields.length);
  for (let i = 0; i < n; i++) {
    if (!c.isCopyType(variant.fields[i])) return true;
  }
  return false;
}

// A combinator that copies one variant's payload straight into its result leaves that
// payload owned twice over. Consuming the receiver keeps a single owner. Only needed
// when the forwarded payload is non-Copy — a Copy payload is safe to duplicate, and
// staying non-consuming there keeps the common `Result<i64, i64>` case ergonomic
// (same Copy gate as unwrapOr).
// What a sortByKey extractor's string key is: "borrowed" when every return is a place
// rooted at its parameter (`p.name`), "owned" when none is (a fn value, `p.name + "!"`),
// "mixed" otherwise. Nested closures are not this one's returns.
export function extractorKeys(c: TypeChecker, arg: Expr): "borrowed" | "owned" | "mixed" {
  const { values, rooted } = c.extractorReturns(arg);
  const borrowed = values.filter(rooted).length;
  return borrowed === 0 ? "owned" : borrowed === values.length ? "borrowed" : "mixed";
}

// The extractor's returned expressions (nested closures excluded) and whether one is a
// place rooted at its parameter.
export function extractorReturns(arg: Expr): { values: Expr[]; rooted: (e: Expr) => boolean } {
  if (arg.kind !== "Closure" || arg.params.length !== 1) return { values: [], rooted: () => false };
  const param = arg.params[0]!.name;
  const rooted = (e: Expr): boolean =>
    e.kind === "Ident" ? e.name === param : e.kind === "FieldAccess" ? rooted(e.object) : false;
  const values: Expr[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const o = n as { kind?: string; value?: Expr | null };
    if (o.kind === "Closure") return;
    if (o.kind === "Return" && o.value) values.push(o.value);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(arg.body);
  // An expression-bodied closure's value is its last statement.
  const last = arg.body[arg.body.length - 1];
  if (last?.kind === "ExprStmt") values.push(last.expr);
  return { values, rooted };
}

export function consumeForwardedPayload(c: TypeChecker, receiver: Expr, forwarded: TypeKind) {
  if (c.isCopyType(forwarded)) return;
  c.tryMove(receiver);
}

// Where a move actually lands. An if- or match-expression owns nothing itself:
// it evaluates to one of its tails, so consuming it consumes whichever tail ran,
// and the move rule has to be applied to each of them. Before this existed no
// branch of `tryMoveLeaf` matched a fork at all, so `return if c { d.a } else
// { d.b }` moved nothing and checked nothing — it compiled and double-freed,
// while the identical `return d.a` was a compile error. Same for `??`, `!`, `?`
// and a cast wrapping the same access.
//
// Total, with no `default:` — a new Expr kind is a compile error here until it
// is classified, which is the whole point. See `placesOf` for the same argument.
export function moveTargets(c: TypeChecker, expr: Expr): Expr[] {
  switch (expr.kind) {
    // Handled directly: these are the forms that name storage (or, for a move
    // closure, capture it).
    case "Ident": case "FieldAccess": case "IndexAccess": case "Closure":
      return [expr];

    // Forks: exactly one tail is consumed, but which one is a runtime fact. Move
    // every candidate — a binding consumed on either path is unusable after, and
    // codegen only zeroes the slot the taken branch actually moved.
    case "IfExpr":
      return c.tailTargets([expr.thenBody, expr.elseBody]);
    case "MatchExpr":
      return c.tailTargets(expr.arms.map(a => a.body));
    case "DefaultValue":
      return [expr.operand, expr.default];

    // Pass-throughs: the value comes out of the operand's storage.
    case "Unwrap": case "Propagate":
      return [expr.operand];

    // A cast reinterprets, it does not consume: `s as *u8` on a `&string` takes
    // the buffer's address (unsafe, FFI seam) and leaves `s` exactly as owned as
    // it was. This is where moveTargets and placesOf legitimately disagree —
    // placesOf DOES forward through a cast, because the resulting pointer aliases
    // the operand's storage and the aliasing rules have to see that.
    case "CastExpr":
      return [];

    // `*h` names the storage inside a box (tryMoveOutOfHeap); `-x`, `!b`, `~n` are fresh.
    case "UnaryOp":
      return expr.op === "*" ? [expr] : [];

    // Fresh values. Their own operands are moved where those are checked — a
    // struct literal's fields, a call's arguments — not through the result.
    case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
    case "BinOp": case "Call": case "MethodCall": case "StructLit":
    case "ArrayLit": case "ArrayRepeat": case "EnumLit": case "RangeExpr": case "IsExpr":
      return [];
  }
  const _exhaustive: never = expr;
  void _exhaustive;
  return [];
}

export function tailTargets(c: TypeChecker, bodies: Stmt[][]): Expr[] {
  const out: Expr[] = [];
  for (const body of bodies) {
    // No value tail means the arm diverges (`return`, `break`, an abort) and
    // consumes nothing on that path — there is no place to move.
    const tail = c.tailExprOf(body);
    if (tail) out.push(tail);
  }
  return out;
}

// A value fed to a `&T` parameter or a by-reference receiver. A fork there whose arms
// mix an owned value with a named place (`(if c { r } else { mk() }).get()`) has to
// own its value whichever arm ran, so codegen drops it after the call; the place arm
// is cloned for that (codegen's blockValueOwnsResult). A resource type cannot be
// cloned structurally (its Drop would run twice), so for one the fork consumes its
// places, exactly as `let x = if c { r } else { mk() }` does.
export function autoBorrow(c: TypeChecker, slot: Expr, how: { mutable: boolean }) {
  const expr = rewritten(c.rewrites, slot);
  c.autoBorrowed.set(expr, how);
  c.consumeMixedResourceFork(expr);
}

// Also reached from a field read (`(if c { r } else { mk() }).name`).
export function consumeMixedResourceFork(c: TypeChecker, slot: Expr) {
  const expr = rewritten(c.rewrites, slot);
  if (expr.kind !== "IfExpr" && expr.kind !== "MatchExpr") return;
  const ty = c.exprTypes.get(expr);
  if (ty && c.resourceKind(ty) && c.forkHasOwnedTail(expr)) c.tryMove(expr);
}

// Whether some arm of a fork yields an owned value rather than a place: a call, a
// literal of an owning type, a binding the match arm made. A string literal owns
// nothing and does not count.
export function forkHasOwnedTail(c: TypeChecker, e: Expr): boolean {
  const arms = e.kind === "IfExpr" ? [{ body: e.thenBody, bound: new Set<string>() }, { body: e.elseBody, bound: new Set<string>() }]
    : e.kind === "MatchExpr" ? e.arms.map(a => ({ body: a.body, bound: new Set(patternLeafNames(rewrittenPattern(c.patternRewrites, a.pattern))) }))
    : [];
  return arms.some(({ body, bound }) => {
    const t = c.tailExprOf(body);
    return !!t && c.tailIsOwnedValue(t, bound);
  });
}

export function tailIsOwnedValue(c: TypeChecker, t: Expr, bound: Set<string>): boolean {
  switch (t.kind) {
    case "Ident": return bound.has(t.name);
    case "FieldAccess": case "IndexAccess": case "StringLit": return false;
    case "UnaryOp": return t.op !== "*" || !(t.operand.kind === "Ident" || t.operand.kind === "FieldAccess" || t.operand.kind === "IndexAccess");
    case "Unwrap": case "Propagate": return c.tailIsOwnedValue(t.operand, bound);
    case "IfExpr": case "MatchExpr": return c.forkHasOwnedTail(t);
    default: return true;
  }
}

export function tryMove(c: TypeChecker, slot: Expr) {
  const expr = rewritten(c.rewrites, slot);
  c.moveRequested.add(expr);
  const targets = c.moveTargets(expr);
  // A fork forwards to its tails; anything else is either itself the target or
  // owns nothing. `targets[0] === expr` is the leaf case — recursing on it would
  // not terminate.
  if (targets.length === 1 && targets[0] === expr) { c.tryMoveLeaf(expr); return; }
  for (const t of targets) c.tryMove(t);
}

export function tryMoveLeaf(c: TypeChecker, expr: Expr) {
  if (expr.kind === "UnaryOp" && expr.op === "*") { c.tryMoveOutOfHeap(expr); return; }
  // ident-ok: asks whether the BINDING was declared `&T`, which is a property of the declaration, not of storage
  if (expr.kind === "Ident") {
    const live = c.lookup(expr.name);
    const resolved = c.identBinding.get(expr);
    // The binding's scope has closed (a fork tail, see identBinding): the binding is
    // dead, so only the borrowed-move rule below applies; nothing else should be marked.
    const scopeClosed = !!resolved && resolved !== live;
    const info = scopeClosed ? resolved : live;
    // Moving in an owned position through a borrow (`&T`, T non-Copy) would
    // shallow-copy the pointee — e.g. a String's heap buffer — aliasing it
    // with the real owner and double-freeing on drop. Reject; clone to own.
    // Not in a sortByKey extractor: the sort never drops its keys, so a shared copy
    // would leak its count (see the FieldAccess note below).
    if (info && info.type.tag === "ref" && info.type.inner.tag === "string" && !c.isExtractorKey(expr)) {
      c.sharedStringExprs.add(expr);
      return;
    }
    if (info && info.type.tag === "ref" &&
        !c.isCopyType(info.type.inner)) {
      c.error(`cannot move the borrowed value out of '${expr.name}'`, expr.span,
        `'${expr.name}' is a reference — call .clone() to take an owned copy`);
      return;
    }
    if (scopeClosed) return;
    if (info && c.isPoisoned(info.type)) return;
    if (info?.isGlobal && info.type.tag === "string") {
      c.sharedStringExprs.add(expr);
      return;
    }
    if (info?.isGlobal && !c.isCopyType(info.type)) {
      c.errorMoveOutOfGlobal(expr, expr.name, expr.name);
      return;
    }
    // An owned string binding: a move (move-flow decides later whether it becomes a share). Borrowed (a live view,
    // a closure capture), read from inside a closure that captured it (moving it out of
    // the environment would make the closure call-once), or already turned into a share
    // by an earlier pass over this code: it shares now. Not in a sortByKey extractor.
    if (info && info.type.tag === "string" && !c.isExtractorKey(expr) && !c.forgetting) {
      let captured = false;
      c.eachCaptureOf(expr.name, () => { captured = true; });
      if (info.borrowed || captured || c.sharedStringExprs.has(expr)) { c.shareMovedExpr(expr); return; }
      info.everMoved = true;
      c.movedExprs.add(expr);
      return;
    }
    if (info && !c.isCopyType(info.type)) {
      // A pointer borrow does not forbid the move (the header moves, the buffer stays),
      // but the new owner may free that buffer at any time the checker cannot see, so
      // every holder of the pointer is dead from here: `let p = v.ptr(); take(v);
      // strlen(p)` was a heap-use-after-free (h4-ptr-then-move). Two moves keep the
      // holders alive, and set `pointerMoveKeepsHolders`: `forget(v)` (the explicit "the
      // pointer's owner has the buffer now" spelling of the FFI give leg) and a plain
      // `let w = v`, where `carryPointerBorrows` re-attaches the borrow to `w`. The
      // borrow is released from the source either way, so a later revive
      // (`v = Vec.new()`) is not mistaken for a reassignment under `p`.
      if (info.borrowed && c.onlyPointerBorrows(info)) {
        if (!c.pointerMoveKeepsHolders) {
          for (const h of info.borrowHolders ?? []) {
            if (h && !h.info.pointerSourceMoved) h.info.pointerSourceMoved = { root: h.root, call: h.call, line: h.line };
          }
        }
        c.retainBorrows(info, () => false);
      }
      if (info.borrowed) {
        // `borrowed` covers closure capture *and* a live slice/view/iteration borrow —
        // naming only closures misdiagnosed `let s = b.view(); consume(b)`.
        c.reportBorrowed(`cannot move '${expr.name}'`, expr.name, c.conflictingBorrow(info, null), expr.span,
          `cannot move '${expr.name}' because it is borrowed`,
          `a closure capture, or a live slice, reference or loop over this variable, still points into it: moving it would leave that borrow dangling`);
        return;
      }
      info.everMoved = true;
      c.movedExprs.add(expr);
      // Moving a capture out of a `move` closure empties the environment slot it
      // lives in, so the closure cannot run a second time. Record it on the capture
      // and the literal is typed call-once below.
      c.eachCaptureOf(expr.name, cap => { cap.consumedInClosure = true; });
    }
  }
  // Move closure: captures are moved out of the enclosing scope
  if (expr.kind === "Closure" && c.isMoveClosure(expr)) {
    const caps = c.closureCaptures.get(expr);
    if (caps) {
      for (const cap of caps) {
        if (c.isCopyType(cap.type)) continue;
        const info = c.lookup(cap.name);
        // A string capture moves, or shares right away when the binding is borrowed or an
        // earlier pass already made it one.
        if (info && cap.type.tag === "string" && info.type.tag === "string") {
          const shareCap = () => {
            let names = c.sharedStringCaptures.get(expr);
            if (!names) c.sharedStringCaptures.set(expr, names = new Set());
            names.add(cap.name);
          };
          if (info.borrowed || c.sharedStringCaptures.get(expr)?.has(cap.name)) { shareCap(); continue; }
        }
        if (info) {
          info.everMoved = true;
          c.unfreeze(info);
        }
        // The move reaches the binding through every enclosing closure that captured it,
        // exactly as a `consume(x)` written in the nested body would. Without this an
        // outer by-reference closure (a scoped task, a Task.scope body) looked like a
        // mere reader of `x` while it handed `x` to a `move` closure that frees it, and
        // checkTaskScopes let a sibling task keep borrowing it.
        c.eachCaptureOf(cap.name, ch => { ch.consumedInClosure = true; });
      }
    }
  }
  // Mark `v[i]` as a move-out when consumed in a move position. Codegen uses this
  // flag to zero the Vec slot so the slot's drop doesn't double-free.
  // But don't move out of borrowed Vecs — mark as borrowed instead.
  if (expr.kind === "IndexAccess") {
    const elemType = c.exprTypes.get(expr);
    if (elemType && !c.isCopyType(elemType)) {
      // The "clone" that stands in for the move duplicates a resource; reject before
      // recording anything (see errorIfResourceIndexRead).
      if (elemType.tag !== "ref" && c.errorIfResourceIndexRead(expr, elemType)) return;
      let objectIsRef = false;
      // ident-ok: asks whether the receiver BINDING was declared `&T`, same reason as tryMoveLeaf above
      if (expr.object.kind === "Ident") {
        const info = c.lookup(expr.object.name);
        if (info && info.type.tag === "ref") objectIsRef = true;
      }
      if (objectIsRef) {
        c.borrowedExprs.add(expr);
      } else {
        c.movedExprs.add(expr);
      }
    }
  }
  // Mark `s.field` as a move-out when a non-Copy field is consumed in a move
  // position. Codegen zeroes the source field so the struct's own drop glue
  // doesn't free a buffer now owned by the moved value (double-free).
  //
  // Behind a `&T` neither half of that is available: zeroing would mutate
  // through a shared borrow, and *not* zeroing hands the caller a second owner
  // of the same heap buffer. `fn describe(d: &Doc): string { return d.text }`
  // used to compile and hand back a String aliasing a pointee the caller was
  // about to drop — printing freed bytes, then double-freeing. It is the same
  // hazard `tryMove` already rejects for a whole `&T` binding, so it gets the
  // same answer: clone to own.
  //
  // `sortByKey`'s key extractor is the sole exemption; see the note below.
  if (expr.kind === "FieldAccess") {
    const fieldType = c.exprTypes.get(expr);
    if (fieldType && !c.isCopyType(fieldType) && !c.isPoisoned(fieldType)) {
      const base = c.borrowBasePath(expr);
      // A string field the code does not own outright (behind a borrow, in a global, in
      // an element that stays in its container) is shared, never moved or refused. An
      // owned root keeps the move: that is free and leaves nothing to count.
      if (fieldType.tag === "string" && !c.isExtractorKey(expr) && (base !== null || c.globalRootOf(expr) !== null || c.fieldIsInElement(expr))) {
        c.sharedStringExprs.add(expr);
        return;
      }
      if (base === null) {
        const globalRoot = c.globalRootOf(expr);
        if (globalRoot !== null) {
          c.errorMoveOutOfGlobal(expr, c.describeExpr(expr), globalRoot);
          return;
        }
        const dropTy = c.dropTypeInPath(expr);
        // A string field leaving a Drop type shares instead: the value stays whole.
        if (dropTy && fieldType.tag === "string" && !c.isExtractorKey(expr)) { c.shareMovedExpr(expr); return; }
        if (dropTy) {
          c.error(`cannot move '${c.describeExpr(expr)}' out of '${dropTy}', which implements Drop`, expr.span,
            `a Drop impl runs against the whole value, so taking a field out of it would leave the destructor reading an empty one — clone the field, or consume the '${dropTy}' whole`);
          return;
        }
        // Owned root: the field really is handed over; reading it again is move-flow's
        // business, not this walk's.
        const place = c.staticFieldPath(expr);
        if (place) {
          const strField = fieldType.tag === "string" && !c.isExtractorKey(expr);
          if (strField && c.sharedStringExprs.has(expr)) { c.shareMovedExpr(expr); return; }
        } else if (c.errorIfFieldMovedOutOfElement(expr)) {
          return;
        }
        // The field's buffer changes hands, so a live view of that field (or of a part of
        // it, or of the whole root) would dangle, exactly as for a whole-variable move.
        // A view of a sibling field does not collide (`borrowCollides`). Pointer borrows
        // are exempt as for a whole move: the header moves, the buffer stays.
        const ap = c.accessPath(expr);
        const rinfo = ap ? c.lookup(ap.root) : null;
        if (ap && rinfo && rinfo.borrowed && c.frozenAgainstFields(rinfo, ap.fields, "pointer")) {
          const site = c.conflictingBorrowFields(rinfo, ap.fields, "pointer");
          c.reportBorrowed(`cannot move '${c.describeExpr(expr)}'`, ap.root, site, expr.span,
            `cannot move '${c.describeExpr(expr)}' because it is borrowed`,
            `a closure capture, or a live slice, reference or loop over this variable, still points into it: moving it would leave that borrow dangling`);
          return;
        }
        c.movedExprs.add(expr);
      } else if (!c.isExtractorKey(expr)) {
        // `replace` is only offered for `&mut`: it swaps something in, which needs write
        // access. Through a shared `&` the only honest answer is to clone.
        const swap = base.mutable
          ? `, or 'replace(${base.root}${base.path}, ...)' to take the field and leave something in its place`
          : "";
        c.error(`cannot move '${base.root}${base.path}' out of the borrowed '${base.root}'`, expr.span,
          `'${base.root}' is a reference — call .clone() to take an owned copy${swap}`);
      }
      // Inside a sortByKey extractor: neither error nor move-mark. Not marking it moved
      // matters as much as not erroring — marking it makes codegen zero the source field,
      // and that field lives in the container being sorted, which silently emptied every
      // name (tests/fixtures/sortByKeyString.milo).
      //
      // The exemption is the returned key expression of a sortByKey extractor, nothing else in its body, and fail-closed: a new
      // combinator is subject to the rule until someone proves it does not retain the
      // value. Exempting *closures* generally was unsound — `map` retains what its closure
      // returns, so `users.map((u: &User) => u.name)` built a Vec<string> aliasing the
      // users' buffers and double-freed on drop (a live abort, exit 133).
    }
  }
}

// `*h` by value moves the T out of the box: codegen loads it and zeroes the box's
// contents, so the box's own drop frees only the allocation. Nothing recorded that, so
// a second `*h` read the zeroed T (an empty string, or a null inner Heap that the next
// deref crashed on), and `*h` through a `&Heap<T>` emptied the caller's box behind its
// back. The move is checked and recorded as a move of the box (the operand place), so
// a later use of `h` is the ordinary use-after-move error and a borrowed, global or
// in-container box gets the same refusal moving the box itself would. The operand is
// then taken back out of movedExprs: `h` still owns the allocation and must free it.
export function tryMoveOutOfHeap(c: TypeChecker, expr: UnaryOp) {
  const operandTy = c.exprTypes.get(expr.operand);
  if (operandTy?.tag !== "heap") return;
  const t = c.exprTypes.get(expr);
  if (!t || c.isCopyType(t) || c.isPoisoned(t)) return;
  // A box inside a container element: the element stays put, so there is no binding
  // or field to mark, and the next `*v[i]` would read the zeroed contents.
  const inElement = c.placesOf(expr.operand).some(p =>
    p.tag === "path" && p.steps.some(s => s.tag === "index") && c.lookup(p.root) !== null);
  if (inElement) {
    const what = c.describeExpr(expr);
    c.error(`cannot move '${what}' out of a box that stays in its container`, expr.span,
      `clone it ('(${what}).clone()'), or take the element out first ('remove(i)', 'pop()' or 'replace')`);
    return;
  }
  const wasMoved = c.movedExprs.has(expr.operand);
  c.tryMoveLeaf(expr.operand);
  if (!wasMoved) c.movedExprs.delete(expr.operand);
  // The deref itself is what moves: codegen zeroes the box only for a recorded move, so
  // a read (`print(*h)`, a `&T` argument) leaves the payload in place.
  c.movedExprs.add(expr);
}

// Moving out of a global used to compile and zero the global's slot, so the next
// reader (another function, or the same function's next call) silently saw an empty
// value. Nothing owns a global, so there is no moment at which the move is sound.
export function errorMoveOutOfGlobal(c: TypeChecker, expr: Expr, what: string, global: string): void {
  // A match subject reaches tryMove once per consuming arm; a local is marked moved the
  // first time so later passes are quiet, but a global is never marked, so dedupe here.
  // Against the diagnostics already on file, not a seen-set: a speculative pass that
  // truncates `diagnostics` must not suppress the report its re-check makes.
  const span = expr.span;
  const message = `cannot move out of global '${global}'`;
  if (c.diagnostics.some(d => d.message === message && d.span === span)) return;
  // `replace` writes, so it is only offered where a write is legal: a `var` global.
  const take = c.lookup(global)?.mutable
    ? `, or 'replace(${what}, ...)' to take it and leave something in its place`
    : "";
  c.error(message, span,
    `clone it ('${what}.clone()'), or borrow it by passing it to a '&T' parameter${take}`);
}

// The global a field access reaches into, when any place it names is rooted at one.
// Checked over the whole place set (not `soloPath`) so a fork like
// `(if c { G } else { l }).name` cannot hide the global half. A deref step leaves the
// global: a field read through a `*T` held in one moves out of the pointee, not the global.
export function globalRootOf(c: TypeChecker, expr: Expr): string | null {
  for (const p of c.placesOf(expr)) {
    if (p.tag === "path" && !p.steps.some(s => s.tag === "deref") && c.lookup(p.root)?.isGlobal) return p.root;
  }
  return null;
}

// Walks `a.b.c` and `v[i].f` down to the variable the read ultimately comes
// out of, and reports it when that variable is a `&T`/`&mut T` binding. The old
// check only looked one level up (`expr.object.kind === "Ident"`), so a nested
// `d.inner.text` slipped past it entirely.
//
// Returns the whole accessor path too, so the diagnostic can say which field is being
// moved rather than only which variable it came from. An index becomes `[…]` — the
// subscript is not re-evaluated for the message, and naming the exact element would
// imply a precision the check does not have.
// The borrow a place reaches through, if any: the root binding is a `&T`/`&mut T`
// and `path` spells the steps taken through it, for the diagnostic.
export function borrowBaseOfPlace(c: TypeChecker, p: { root: string; steps: PlaceStep[] }): { root: string; path: string; mutable: boolean } | null {
  const info = c.lookup(p.root);
  if (!info || info.type.tag !== "ref") return null;
  return { root: p.root, path: p.steps.map(stepLabel).join(""), mutable: info.type.mutable };
}

export function borrowBasePath(c: TypeChecker, expr: Expr): { root: string; path: string; mutable: boolean } | null {
  const p = c.soloPath(expr);
  return p ? c.borrowBaseOfPlace(p) : null;
}

// `let name = toks[0].text` used to compile: codegen zeroed `toks[0].text` while `toks`
// kept the element, so the next read of it handed back an empty string, and for an enum
// payload the tag outlived the zeroing, so a later `match` entered the arm on empty data.
// The element's owner is a live binding, so nothing has changed hands and there is no
// sound thing to zero; the field has to be cloned or the element taken out first. A
// temporary root (`f().name`, `makeVec()[0].name`) is consumed whole, so it keeps the
// move. A `&T` root never reaches here (the borrowed branch of `tryMoveLeaf` owns it).
export function fieldIsInElement(c: TypeChecker, expr: FieldAccess): boolean {
  return c.placesOf(expr).some(p =>
    p.tag === "path" && p.steps.some(s => s.tag === "index") && c.lookup(p.root) !== null);
}

export function errorIfFieldMovedOutOfElement(c: TypeChecker, expr: FieldAccess): boolean {
  if (!c.fieldIsInElement(expr)) return false;
  const path = c.describeExpr(expr);
  const container = c.describeExpr(c.indexedContainerOf(expr) ?? expr.object);
  c.error(`cannot move '${path}' out of '${container}': the element stays in the container, so the move would leave a zeroed '${expr.field}' behind`, expr.span,
    `clone it ('${path}.clone()'), or take the element out first ('${container}.remove(i)', '${container}.pop()', or 'replace(${path}, ...)')`);
  return true;
}

// The container the nearest index step of a field chain reads from: `toks` for
// `toks[i].name`, `a[...].b` for `a[i].b[j].c`. A view-returning method call is an
// index step too (see `placesOf`), so its receiver counts as the container.
export function indexedContainerOf(e: Expr): Expr | null {
  let cur: Expr = e;
  for (;;) {
    switch (cur.kind) {
      case "IndexAccess": case "MethodCall": return cur.object;
      case "FieldAccess": cur = cur.object; break;
      case "Unwrap": case "Propagate": case "CastExpr": cur = cur.operand; break;
      case "UnaryOp": if (cur.op !== "*") return null; cur = cur.operand; break;
      default: return null;
    }
  }
}

// Never returns null: every failure path is `fatal()`, because there is no such
// thing as a half-resolved assignment target — the callers that used to null-check
// had nothing to do with the answer but bail, and one that forgot would assign
// through a place the diagnostic had just said does not exist.
// Mark the variable a place expression is rooted at as read. Used where an operation
// takes the old value out of a place (`replace`), which the plain assignment path does
// not count as a use.
export function markPlaceRead(c: TypeChecker, expr: Expr) {
  // Root resolved through the place walker rather than by stepping over the two node
  // kinds this loop used to know. Reading `o!.field` marks `o` read; the old walk saw an
  // Unwrap, gave up, and left the binding looking unused.
  const ap = c.accessPath(expr);
  if (!ap) return;
  const info = c.lookup(ap.root);
  if (info) info.read = true;
}

export function resolveAssignTarget(c: TypeChecker, slot: Expr): { type: TypeKind; mutable: boolean } {
  const expr = rewritten(c.rewrites, slot);
  const sp = expr.span;
  // ident-ok: the Ident base case of a walk that recurses through FieldAccess/IndexAccess itself
  if (expr.kind === "Ident") {
    const info = c.lookup(expr.name);
    if (!info) c.fatal(`undefined variable '${expr.name}'`, sp, c.nameHint(expr.name));
    if (info.type.tag === "ref" && info.type.mutable) {
      // Writing THROUGH a `&mut` is what one is for, so it counts as a use. Without
      // this a parameter whose whole job is to be written — `fn bump(n: &mut E)` that
      // only assigns to `n` — was reported as an unused variable, and the suggested
      // fix (rename to `_n`) would have broken the code that writes it.
      info.read = true;
      c.setType(expr, info.type.inner);
      return { type: info.type.inner, mutable: true };
    }
    // For ref locals (e.g. `var view: &string`), reassignment replaces the
    // slice, not the underlying data — keep the ref type intact.
    if (info.type.tag === "ref" && info.mutable) {
      c.setType(expr, info.type);
      return { type: info.type, mutable: true };
    }
    const t = c.deref(info.type);
    c.setType(expr, t);
    return { type: t, mutable: info.mutable };
  }
  if (expr.kind === "FieldAccess") {
    c.placeBaseDepth++;
    let objType = c.checkExpr(expr.object);
    c.placeBaseDepth--;
    // auto-deref *Struct for field assignment (always mutable through ptr)
    let throughPtr = false;
    if (objType.tag === "ptr" && objType.inner.tag === "struct") {
      objType = objType.inner;
      throughPtr = true;
    }
    if (objType.tag === "struct") {
      const info = c.structs.get(objType.name);
      if (!info) c.fatal(`unknown struct '${objType.name}'`, sp);
      const field = info.fields.find(f => f.name === expr.field);
      if (!field) c.fatal(`struct '${objType.name}' has no field '${expr.field}'`, sp, memberHint(expr.field, c.fieldCandidates(objType)));
      c.checkFieldPrivacy(objType.name, expr.field, sp);
      c.setType(expr, field.type);
      const mutable = throughPtr ? true : c.writtenPlaceMutable(expr);
      return { type: field.type, mutable };
    }
    c.fatal(`cannot access field on non-struct type ${c.show(objType)}`, sp);
  }
  if (expr.kind === "IndexAccess") {
    const objType = c.checkExpr(expr.object);
    c.checkExpr(expr.index);
    if (objType.tag === "array") {
      c.setType(expr, objType.element);
      const rootMut = c.writtenPlaceMutable(expr);
      return { type: objType.element, mutable: rootMut };
    }
    if (objType.tag === "vec") {
      c.setType(expr, objType.element);
      const rootMut = c.writtenPlaceMutable(expr);
      return { type: objType.element, mutable: rootMut };
    }
    if (objType.tag === "ptr") {
      c.setType(expr, objType.inner);
      return { type: objType.inner, mutable: true };
    }
    c.fatal(`cannot index non-array type ${c.show(objType)}`, sp);
  }
  if (expr.kind === "UnaryOp" && expr.op === "*") {
    const ot = c.checkExpr(expr.operand);
    if (ot.tag === "ptr") {
      c.setType(expr, ot.inner);
      return { type: ot.inner, mutable: true };
    }
    if (ot.tag === "heap") {
      c.setType(expr, ot.inner);
      return { type: ot.inner, mutable: true };
    }
    c.fatal(`cannot dereference type '${c.show(ot)}' for assignment`, sp);
  }
  // `STORE.field = x` where STORE is a capitalized *variable* (typically a
  // module-level `var`) parses as an EnumLit — the parser can't know STORE
  // isn't a type. checkExpr already recovers this for reads; without the same
  // recovery here, a mutable global struct was writable field-by-field
  // nowhere, which reads as "Milo has no mutable globals".
  if (expr.kind === "EnumLit") {
    const next = c.rewriteStaticToMember(expr);
    if (next !== null) return c.resolveAssignTarget(next);
  }
  c.fatal("invalid assignment target", sp);
}

// Walk to the root identifier of an lvalue; if it is a closure capture being
// mutated in place, record that so the value isn't move-captured out from
// under the caller (which still needs to see the mutation / drop it).
//
// Reached from assignments and builtin mutators (isRootMutable), and from every
// mutable borrow a call takes: a `&mut` argument, a `&mut self` receiver. Those are
// writes too, and a capture written only through a user fn (`wipe(&mut v)`,
// `s.wipe()`, `arenaClear(&mut a)`) once went unrecorded, so calling the closure
// inside a loop over `v` freed the element the loop was reading.
export function markCaptureMutated(c: TypeChecker, expr: Expr) {
  const ap = c.accessPath(expr);
  if (!ap) return;
  const key = ap.fields?.join(".");
  c.eachCaptureOf(ap.root, cap => {
    cap.mutatedInClosure = true;
    const fs = (cap.mutatedFields ??= []);
    if (!fs.some(f => f?.join(".") === key)) fs.push(ap.fields);
  });
}

// Apply fn to `name`'s capture in every open closure that holds one. A nested closure
// that consumes or mutates a capture does so through each enclosing closure's slot,
// so those are marked the same way.
export function eachCaptureOf(c: TypeChecker, name: string, fn: (cap: CaptureInfo) => void) {
  for (const frame of c.closureFrames) {
    const cap = frame.captures.get(name);
    if (cap) fn(cap);
  }
}

// Phase 3a (call-site exclusivity): a variable must not appear at one call as
// both a `&var`/`&mut` argument and the root of a `&` argument. A mutation
// through the mutable borrow could invalidate the shared reference (e.g.
// `push` reallocates), leaving it dangling. Pure argument-origin check.
// `sp` is the call's own span, used only as a fallback when an argument has
// none; both may be undefined, and the diagnostic then carries no source context.
//
// Every user call form runs it (plain, generic, static, method with its receiver as the
// first argument, interface, closure). Codegen's `noalias` on `&mut` parameters relies
// on it being total: a call form that skipped it was a call where two parameters could
// name the same storage. A non-Copy place passed by value is a MOVE and counts as an
// exclusive use too (`f(&mut b.v[0], b)` hands the callee the owner of what it is also
// writing through); `movesExclusive: false` is for extern calls, where a `string`
// argument to a `*u8` parameter is a borrow of its bytes, not a move.
export function checkCallSiteExclusivity(c: TypeChecker, args: Expr[], sp: Span | undefined, movesExclusive = true) {
  if (args.length > 0) c.siteCheckedFirstArgs.add(args[0]);
  // `arg` is the index of the argument a place came from, so two places off one
  // argument (a closure's captures) are never compared with each other.
  type Use = { arg: number; root: unknown; name: string; fields: string[] | null; steps: string[]; span: Span | undefined; moved: boolean; via?: string; captured?: boolean };
  const muts: Use[] = [];
  const shared: Use[] = [];
  args.forEach((slot, i) => {
    const arg = rewritten(c.rewrites, slot);
    // A closure argument reaches what it captures for as long as the callee may run
    // it: a capture the body writes is a `&mut` of that place, one it only reads a `&`,
    // and a non-Copy capture of a `move` closure moves the place into the environment.
    for (const ch of c.closureArgCaptures(arg)) {
      const use = { arg: i, ...c.capturePlace(ch.cap), span: arg.span ?? sp, moved: false, captured: true };
      if (ch.isMove) { if (!c.isCopyType(ch.cap.type)) muts.push({ ...use, moved: true }); }
      else (ch.cap.mutatedInClosure ? muts : shared).push(use);
    }
    const borrow = c.borrowModeOf(arg);
    // A string argument already turned into a share is a value of its own, not a use.
    const moved = !borrow && movesExclusive && c.moveRequested.has(arg) && c.isMovedPlaceArg(arg) && !c.sharedStringExprs.has(arg);
    const ab = borrow ?? (moved ? { mutable: true } : null);
    if (!ab) {
      // An inline `v.ptr()` / `s.cstr()` argument is a shared borrow of its source for
      // the duration of the call: `growRead(v.ptr(), v)` with `v: &mut Vec<u8>` pushed
      // through the reference and then read the stale pointer (h4-inline-alias).
      for (const pv of c.pointerViewsIn(arg)) {
        const p = c.exclusivityPlace(pv.source);
        if (p) shared.push({ arg: i, ...p, span: arg.span ?? sp, moved: false, via: pv.call });
      }
      return;
    }
    // A `&mut` argument or receiver writes its place; inside a closure body that is a
    // write of the capture (the type of an already-`&mut` binding is not consulted, so
    // forwarding one to a `&` parameter is no write).
    if (!moved && (c.autoBorrowed.get(arg)?.mutable || c.explicitMutArgs.has(arg))) c.markCaptureMutated(arg);
    const p = c.exclusivityPlace(arg);
    if (!p) return;
    (ab.mutable ? muts : shared).push({ arg: i, ...p, span: arg.span ?? sp, moved });
  });
  // Two accesses off the same root can alias only if their field paths overlap —
  // one a prefix of the other. Divergence at distinct field names (e.g. self.pos vs
  // self.src) is provably disjoint, so a &mut into one can't invalidate a & into the
  // other. An index/deref anywhere (fields === null) is imprecise → treated as overlap.
  const overlaps = (a: string[] | null, b: string[] | null): boolean => {
    if (a === null || b === null) return true;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const captured = (a: Use, b: Use, name: string): boolean => {
    if (!a.captured && !b.captured) return false;
    c.error(`'${name}' is captured by a closure argument and borrowed in the same call`, a.captured ? a.span : b.span,
      `the callee may run the closure while it holds the other argument into '${name}', so one place has two live paths and at least one writes; pass what the closure needs as a parameter, or split the call into two statements`);
    return true;
  };
  for (const m of muts) {
    for (const s of shared) {
      if (m.arg !== s.arg && m.root === s.root && overlaps(m.fields, s.fields)) {
        if (m.moved && c.shareStringArg(args[m.arg])) continue;
        if (m.moved) { c.error(`'${m.name}' is moved and borrowed in the same call`, m.span, `the callee owns the moved value and may drop or change it while reading through the '&' argument into it; clone one of them or split the call into two statements`); continue; }
        if (captured(m, s, m.name)) continue;
        c.error(`'${m.name}' is borrowed mutably and shared in the same call`, m.span,
          s.via
            ? `a mutation through the '&var'/'&mut' argument could reallocate '${m.name}' under '${s.via}', which points into its buffer: take the pointer after the call, or split the call into two statements`
            : `a mutation through the '&var'/'&mut' argument could invalidate the '&' argument into '${m.name}' — clone the shared argument inline (e.g. 'x.clone()') or split the call into two statements`);
      }
    }
  }
  // A write made while a later argument is evaluated (a closure call, a nested call's
  // `&mut` argument or mutating receiver, an assignment in an if/match arm) runs after
  // every earlier argument was taken. An earlier argument that points into a buffer
  // (through an index, a deref or an enum payload) or was moved out of the place is
  // left dangling by it: `show(v[0], clr())` with `clr` reassigning `v` freed the string
  // `show` then read. A borrow of a binding's own slot survives, since writing the
  // binding cannot move the slot, which is what keeps `ctx.emit(ctx.fresh())` legal.
  // A write in an EARLIER argument is finished before the later borrow is taken.
  c.reportLaterArgWrites([...muts, ...shared].filter(b => !b.captured), args, sp);
  // Two `&mut` arguments where one place is an ancestor of the other (a container
  // and something derived from it, e.g. `v` and `v[0]`) are UB: mutating through
  // the container arg (a `push` that reallocs) frees the storage the descendant
  // arg points into — a use-after-free the muts×shared check above misses because
  // both sides are mutable. Index-aware steps distinguish an ancestor/descendant
  // pair (flagged) from two siblings like `v[i]`/`v[j]` (a legitimate two-element
  // borrow, not flagged). Identical non-indexed places (`v` twice) are two `&mut`
  // to the same object and are flagged as well.
  for (let i = 0; i < muts.length; i++) {
    for (let j = i + 1; j < muts.length; j++) {
      const a = muts[i], b = muts[j];
      if (a.arg === b.arg || a.root !== b.root) continue;
      const sp = a.span ?? b.span;
      const ra = a.captured || b.captured ? null : c.constSliceRange(args[a.arg]);
      const rb = ra ? c.constSliceRange(args[b.arg]) : null;
      if (ra && rb && a.steps.length === b.steps.length) {
        // Two `&mut` windows into one buffer with literal bounds: disjointness is
        // decidable right here, so overlap is a rejectable aliasing violation rather
        // than the "may be distinct elements" case aliasesByContainment lets pass.
        // Non-literal bounds stay permissive — that split needs the prover.
        if (ra.lo < rb.hi && rb.lo < ra.hi) {
          c.error(`'${a.name}' is borrowed mutably twice in the same call`, sp,
            `the ranges ${ra.lo}..${ra.hi} and ${rb.lo}..${rb.hi} overlap, so both arguments are '&mut' slices of the same elements: make the windows disjoint or split the call into two statements`);
        }
        continue;
      }
      if (c.aliasesByContainment(a.steps, b.steps)) {
        if ((a.moved && c.shareStringArg(args[a.arg])) || (b.moved && c.shareStringArg(args[b.arg]))) continue;
        if (a.moved || b.moved) {
          c.error(`'${a.name}' is moved and borrowed in the same call`, sp,
            `the callee owns the moved value and may drop it (freeing what the other argument points into) while still writing through that argument; clone one of them or split the call into two statements`);
          continue;
        }
        if (captured(a, b, a.name)) continue;
        c.error(`'${a.name}' is borrowed mutably twice in the same call`, sp,
          `one argument is a container and the other borrows into it (or they are the same place) — a mutation through one (e.g. a 'push' that reallocates) could invalidate the other; split the call into two statements or clone one argument`);
      }
    }
  }
}

// The nested-write half of checkCallSiteExclusivity: `uses` are the places the
// arguments borrow or move, `arg` indexing into `args`.
//
// A MOVE in a later argument (a nested call's by-value argument, a `move` closure
// literal) is a write that also hands the place to a new owner, who may free it before
// the call: `show(v[0], consume(v))` read the freed string. So against a move even a
// borrow of the binding's own slot conflicts, since the slot is emptied and what it
// owned is gone: `show2(v, consume(v))` passed a zeroed Vec off as the real one.
// A move path is pure fields, so comparing index-aware steps keeps `h.a[0]` clear of a
// move of `h.b`, which `fields` (null past an index) could not.
export function reportLaterArgWrites(c: TypeChecker, uses: ArgUse[], args: Expr[], sp: Span | undefined) {
  const intoBuffer = (u: ArgUse) => u.moved || u.via !== undefined || u.steps.some(s => !s.startsWith(".") || s.startsWith(".$"));
  const conflicts = (w: NestedWrite, b: ArgUse) => w.root === b.root
    && (w.moved ? pathsOverlap(w.steps!, b.steps) : intoBuffer(b) && (w.fields === null || b.fields === null || pathsOverlap(w.fields, b.fields)));
  for (let j = 1; j < args.length; j++) {
    // A later argument moving a string an earlier one uses shares it instead.
    const ws = c.nestedWrites(args[j]).filter(w =>
      !(w.moved && w.expr && uses.some(b => b.arg < j && conflicts(w, b)) && c.shareStringArg(w.expr)));
    if (ws.length === 0) continue;
    const hit = uses.find(b => b.arg < j && ws.some(w => conflicts(w, b)));
    if (!hit) continue;
    const w = ws.find(w => conflicts(w, hit))!;
    c.error(w.moved
      ? `'${hit.name}' is ${hit.moved ? "moved" : "borrowed"} by one argument and moved out by a later one (${w.what})`
      : `'${hit.name}' is ${hit.moved ? "moved" : "borrowed"} by one argument and changed by ${w.what} in a later one`, args[j].span ?? sp,
      `the later argument runs after the earlier one is taken and before the call, so the change can free what the call is handed: compute it into a local before the call`);
  }
}

// The captures a call argument carries into the callee: a closure literal's own, or
// those of every literal a closure binding was bound or assigned from
// (VarInfo.closureSources). A captured closure binding passes on its own captures, since
// running the outer closure may run it. A closure held in a field or element is not
// tracked: a by-reference one cannot be stored there.
export function closureArgCaptures(c: TypeChecker, slot: Expr): { cap: CaptureInfo; isMove: boolean }[] {
  const arg = rewritten(c.rewrites, slot);
  // ident-ok: a closure binding is a whole variable, not a place with steps
  const sources = arg.kind === "Closure" ? [arg] : arg.kind === "Ident" ? c.lookup(arg.name)?.closureSources ?? [] : [];
  return c.capturesOfClosures(sources);
}

export function capturesOfClosures(c: TypeChecker, sources: Expr[]): { cap: CaptureInfo; isMove: boolean }[] {
  const out: { cap: CaptureInfo; isMove: boolean }[] = [];
  const seen = new Set<Expr>();
  const walk = (src: Expr) => {
    if (seen.has(src)) return;
    seen.add(src);
    for (const cap of c.closureCaptures.get(src) ?? []) {
      if (!cap.info) continue;
      out.push({ cap, isMove: c.isMoveClosure(src) });
      for (const inner of cap.info.closureSources ?? []) walk(inner);
    }
  };
  for (const src of sources) walk(src);
  return out;
}

// The writes evaluating `arg` makes, see the nested-write check in
// checkCallSiteExclusivity. The walk is reflective over the node's fields rather than a
// list of Expr kinds, so a kind added later is walked rather than silently skipped. A
// closure value found inside the argument counts as running: a nested call may run it
// while the argument is evaluated. The argument node itself is not a nested write (a
// `&mut` argument is the exclusivity check's own `muts`), except a closure call.
export function nestedWrites(c: TypeChecker, arg: Expr): NestedWrite[] {
  const out: NestedWrite[] = [];
  const seen = new Set<object>();
  const atPlace = (e: Expr, what: string, moved = false, expr?: Expr) => {
    const p = c.exclusivityPlace(e);
    if (p) out.push({ root: p.root, fields: p.fields, what, ...(moved ? { moved, steps: p.steps, expr } : {}) });
  };
  const capWrites = (cap: CaptureInfo, what: string) => {
    const base = c.capturePlace(cap);
    for (const f of cap.mutatedFields ?? [null]) {
      out.push({ root: base.root, fields: base.fields && f ? [...base.fields, ...f] : null, what });
    }
  };
  const visit = (n: unknown, top: boolean): void => {
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { for (const x of n) visit(x, false); return; }
    // A child the checker replaced is walked as its replacement.
    const e = rewritten(c.rewrites, n as Expr);
    const kind = (e as { kind?: unknown }).kind;
    if (typeof kind !== "string") return;
    // ident-ok: a closure binding is a whole variable; its literals carry the captures
    if (!top && (e.kind === "Closure" || (e.kind === "Ident" && c.exprTypes.get(e)?.tag === "fn"))) {
      const name = e.kind === "Ident" ? `'${e.name}'` : "a closure";
      for (const ch of c.closureArgCaptures(e)) if (!ch.isMove && ch.cap.mutatedInClosure) capWrites(ch.cap, `running ${name}`);
      // A `move` literal takes its non-Copy captures into the environment right here,
      // as it is built, whether or not anything runs it.
      if (e.kind === "Closure" && c.isMoveClosure(e)) {
        for (const cap of c.closureCaptures.get(e) ?? []) {
          if (!cap.info || c.isCopyType(cap.type)) continue;
          const p = c.capturePlace(cap);
          out.push({ root: p.root, fields: p.fields, steps: p.steps, moved: true, what: `moving '${cap.name}' into a closure` });
        }
      }
      return;
    }
    // A literal's body runs later, not while the argument is evaluated.
    if (e.kind === "Closure") return;
    for (const cap of c.closureCallWrites.get(e) ?? []) capWrites(cap, `calling '${(e as { func?: string }).func ?? "a closure"}'`);
    if (!top && (c.writtenExprs.has(e) || c.autoBorrowed.get(e)?.mutable)) atPlace(e, `a mutation of '${c.describeExpr(e)}'`);
    // A move out of a binding or a field. Moving an element is a clone, so it is no write.
    // ident-ok: movedExprs holds the moved place nodes; the kind only filters out elements
    if (!top && (e.kind === "Ident" || e.kind === "FieldAccess") && c.movedExprs.has(e)) atPlace(e, `a move of '${c.describeExpr(e)}'`, true, e);
    if (kind === "Assign") {
      const t = (e as unknown as { target: Expr }).target;
      atPlace(t, `an assignment to '${c.describeExpr(t)}'`);
    }
    for (const [k, v] of Object.entries(e)) if (k !== "span") visit(v, false);
  };
  visit(arg, true);
  return out;
}

// Calling a by-reference closure reads and writes its captures through the caller's own
// slots, so the call is a use of each captured binding at this point in the caller. A
// capture moved since the closure was built would be read zeroed, and a capture the
// body writes is written here, which a live loop, view or pointer over that binding
// forbids exactly as a direct write would. Closures reached through its own captures
// run too, so their captures count (capturesOfClosures walks them). A `move` closure
// owns copies taken when it was built, so none of this applies to it.
export function checkClosureCallCaptures(c: TypeChecker, call: Expr, fname: string, info: VarInfo, sp: Span | undefined) {
  const writes: CaptureInfo[] = [];
  for (const { cap, isMove } of c.capturesOfClosures(info.closureSources ?? [])) {
    if (isMove || !cap.info) continue;
    if (!cap.mutatedInClosure) continue;
    writes.push(cap);
    for (const fields of cap.mutatedFields ?? [null]) {
      if (c.reportClosureWrite(cap.info, cap.name, fields, fname, sp)) break;
    }
  }
  if (writes.length > 0) c.closureCallWrites.set(call, writes);
}

// A by-reference closure named as a value (`run(clr)`, `show(s, clr)`, `v.each(clr)`,
// `let g = clr`) may be run by whatever receives it, before this statement ends or
// through the alias later. So naming it counts as running it here: each capture it
// writes, through the closures it captures as well, is checked against the borrows
// open at this point like a direct call. Fail-closed by design: whether the callee
// really calls it is not known here. A call of the alias is checked again at the call.
export function checkClosureValueWrites(c: TypeChecker, name: string, info: VarInfo, sp: Span | undefined) {
  for (const { cap, isMove } of c.capturesOfClosures(info.closureSources ?? [])) {
    if (isMove || !cap.info || !cap.mutatedInClosure) continue;
    for (const fields of cap.mutatedFields ?? [null]) {
      if (c.reportClosureWrite(cap.info, cap.name, fields, name, sp, "passing")) break;
    }
  }
}

// A closure call's write of `fields` under capture `name`, checked like a direct write.
// Capture borrows are skipped: one still open in this statement belongs to a closure
// literal passed as a call argument, and checkCallSiteExclusivity judges those.
export function reportClosureWrite(c: TypeChecker, info: VarInfo, name: string, fields: string[] | null, fname: string, sp: Span | undefined, how = "calling"): boolean {
  const ph = c.pointerBorrowAgainstFields(info, fields);
  if (ph) {
    c.requireUnsafe(`'${name}' is written by ${how} '${fname}' while '${ph.name}' still points into its buffer (from '${ph.call}' on line ${ph.line})`, sp,
      c.pointerHint(ph));
    return true;
  }
  if (!c.frozenAgainstFields(info, fields, "capture")) return false;
  c.reportBorrowed(`cannot write to '${name}' by ${how} '${fname}'`, name, c.conflictingBorrowFields(info, fields, "capture"), sp,
    `cannot write to '${name}' by ${how} '${fname}' because '${name}' is borrowed`,
    `a slice or loop iteration over '${name}' is still live, and the closure's write could move memory it points into`);
  return true;
}

// Record the closure literals `value` may evaluate to as sources of `info`. Assignment
// adds to them rather than replacing, since a branch may or may not have run.
export function noteClosureSources(c: TypeChecker, info: VarInfo, value: Expr | undefined) {
  if (!value) return;
  // ident-ok: copying a closure binding copies the literals it may hold
  const from = value.kind === "Closure" ? [value] : value.kind === "Ident" ? c.lookup(value.name)?.closureSources : undefined;
  if (from?.length) info.closureSources = [...(info.closureSources ?? []), ...from];
}

// A capture is of the whole binding, so its place is the binding itself, or for a ref
// binding the storage it points into (see exclusivityPlace).
export function capturePlace(cap: CaptureInfo): { root: unknown; name: string; fields: string[] | null; steps: string[] } {
  const info = cap.info!;
  const into = info.refInto;
  if (!into) return { root: info, name: cap.name, fields: [], steps: [] };
  const fields = into.steps.every(s => s.tag === "field") ? into.steps.map(s => (s as { name: string }).name) : null;
  return { root: into.root, name: into.name, fields, steps: into.steps.map(stepKey) };
}

// The literal bounds of `v[lo..hi]` (which parses as `v.slice(lo, hi)`), or null when
// either bound is anything but an integer literal. Only the literal case is decidable
// without the prover, and only equal `hi`/`lo` ordering is assumed — a reversed range
// is a runtime bounds error, not this check's business.
export function constSliceRange(e: Expr): { lo: bigint; hi: bigint } | null {
  if (e.kind !== "MethodCall" || e.method !== "slice" || e.args.length !== 2) return null;
  const [lo, hi] = e.args;
  if (lo.kind !== "IntLit" || hi.kind !== "IntLit") return null;
  return { lo: lo.value, hi: hi.value };
}

// How a call argument borrows its root, for the exclusivity checks. Most args are
// auto-borrowed (bare value → `&T`/`&mut T` param), but a slice expression is ALREADY
// a reference — `f(v, v[0..2])` never enters `autoBorrowed`, so before this the
// container arg and a view into it slipped past both checks and the callee's `push`
// freed the storage the view pointed into (use-after-free in safe code). Any arg whose
// checked type is a ref counts as a borrow of its access path, whatever produced it.
export function borrowModeOf(c: TypeChecker, arg: Expr): { mutable: boolean } | null {
  const ab = c.autoBorrowed.get(arg);
  if (ab) return ab;
  const t = c.exprTypes.get(arg);
  return t?.tag === "ref" ? { mutable: t.mutable } : null;
}
