// Borrow and place tracking: scopes, borrow windows, pointer borrows, places, freezing, mutability roots.
import type { TypeChecker } from "./checker";
import type { BorrowKind, BorrowSite, PatternLeaf, Place, PlaceStep, PointerHolder, VarInfo } from "./checker";
import { DEREF, INDEX, OPAQUE, PAYLOAD, VALUE, rewritten, spanKey, stepKey, stepsEq } from "./checker-util";
import type { Expr, Span, Stmt, ForInStmt } from "./ast";
import { typeName } from "./types";
import type { TypeKind } from "./types";
import type { Pattern } from "./ast";

// A binding leaves scope: its borrow of `src` ends. A view binding was the first to freeze `src`
// (see newlyFrozen in checker-stmt), so everything but pointers goes; a pointer holder owns only its
// pointer borrow, and dropping the rest would end a loop's iteration borrow or another binding's view.
function releaseFreeze(c: TypeChecker, src: VarInfo, holder: VarInfo) {
  let pointerOnly = false;
  for (const p of holder.pointerFreezes ?? []) if (p === src) pointerOnly = true;
  if (!pointerOnly) c.unfreeze(src);
  c.releasePointerBorrows(src, holder);
}

// `holder` now holds a pointer borrow of `src`. Unless it already froze `src` as a view binding
// (which owns the view borrows), that is all it owns, see `releaseFreeze`.
function addPointerFreeze(holder: VarInfo, src: VarInfo) {
  let had = false;
  for (const f of holder.freezes ?? []) if (f === src) had = true;
  if (!had) (holder.pointerFreezes ??= []).push(src);
  (holder.freezes ??= []).push(src);
}

export function popScope(c: TypeChecker) {
  const scope = c.scopes.pop();
  if (scope) {
    for (const [, vi] of scope) {
      if (vi.freezes) for (const src of vi.freezes) releaseFreeze(c, src, vi);
    }
  }
}

// `condCanExit` is false for `while true` (and `while let`, which desugars to it), whose
// only way out is a break. A loop nothing leaves (`while true` with no reachable
// `break`) leaves the code after it unreachable.
export function endLoop(c: TypeChecker, condCanExit: boolean) {
  const frame = c.loopFrames.pop()!;
  const exits = frame.breaks + (condCanExit ? 1 : 0);
  c.reachable = frame.reachable && exits > 0;
}

// Check one path of a branch construct from `preReachable`, and return whether it ended reachable.
export function checkPath(c: TypeChecker, preReachable: boolean, check: () => void): boolean {
  c.reachable = preReachable;
  check();
  return c.reachable;
}

// `span` is the binding site to point diagnostics at; VarInfo carries one for every
// binding form now (params, pattern bindings, `let`/`var`, for-in), so `span` here is
// just an override for callers that want to point somewhere else.
export function declare(c: TypeChecker, name: string, info: VarInfo, span?: Span) {
  const at = span ?? info.span;
  const scope = c.scopes[c.scopes.length - 1];
  // `_` is a discard, not a name: `let _ = f()` twice in one scope is the
  // conventional way to ignore two results, so each one rebinds rather than
  // colliding. Everything else still gets the shadowing error.
  if (name !== "_" && scope.has(name)) {
    const prior = scope.get(name);
    const hint = prior?.span ? `'${name}' was first declared at line ${prior.span.line}` : undefined;
    c.error(`variable '${name}' already declared in this scope`, at, hint);
    // Bind the new declaration anyway: later lines were written against it, and
    // resolving them to the first one turned every use into a type error of its own.
    // The first binding leaves scope here, so its freezes go with it as in popScope.
    if (prior?.freezes) for (const src of prior.freezes) releaseFreeze(c, src, prior);
    if (scope === c.globalScope) c.globalScopeInfos.add(info);
    scope.set(name, info);
    return;
  }
  // Shadowing an ENCLOSING binding is rejected too, not just a same-scope
  // redeclaration. Rust allows it; Milo does not, because the reader of
  // `for row in nums` a screen below `let row = 5` has no way to tell which
  // `row` a later line means, and codegen leaked the inner binding past its
  // scope for exactly as long as nothing tested it.
  // Scan only down to the current function's own scope: monomorphization
  // re-enters checkFunction mid-expression, so the CALLER's locals are still
  // on the stack while a generic callee's params are declared. Without the
  // floor, `std/arena`'s `h`/`val` params collided with every local named
  // `h` at the call site.
  // `_name` is the established "I am not reading this" marker (the unused-variable
  // lint keys off it), and the readability argument for banning shadowing —
  // which binding does a later line mean? — does not apply to a name nothing
  // reads. Two match arms both binding `_e` stay legal.
  if (name !== "_" && !name.startsWith("_")) {
    for (let i = c.scopes.length - 2; i >= c.fnScopeFloor; i--) {
      const outer = c.scopes[i].get(name);
      if (outer) {
        const hint = outer.span ? `outer '${name}' is declared at line ${outer.span.line}` : undefined;
        c.error(`'${name}' shadows an outer binding — pick a different name`, at, hint);
        break;
      }
    }
  }
  if (scope === c.globalScope) c.globalScopeInfos.add(info);
  scope.set(name, info);
}

// The one writer of the parallel borrow arrays, so they stay the same length.
export function pushBorrow(c: TypeChecker, info: VarInfo, path: string[] | null, kind: BorrowKind, holder: PointerHolder | null, site: BorrowSite | null) {
  c.noteBorrowChange();
  info.borrowed = true;
  (info.borrowedPaths ??= []).push(path);
  (info.borrowKinds ??= []).push(kind);
  (info.borrowHolders ??= []).push(holder);
  (info.borrowSites ??= []).push(site);
}

// A binding now owns the borrows its initializer or pattern took: stamp it on the
// unattributed view sites of each source so a later conflict can name it.
export function attributeBorrows(srcs: VarInfo[], name: string, holderInfo: VarInfo | null) {
  if (!holderInfo) return;
  for (const src of srcs) {
    src.borrowSites?.forEach((site, i) => {
      if (site && !site.holder && !site.via && src.borrowKinds?.[i] === "view") site.holder = { name, info: holderInfo };
    });
  }
}

// The exact field prefix of a borrowed place, stopping at the first step that is not a
// field. An index makes it imprecise about WHICH element, so everything below the index
// conflicts — but the path ABOVE it is still exact, and that is what keeps a borrow of
// `self.items[i].ids` from freezing `self.log` as well. `accessPath` answers `null`
// (conflicts with everything) for the same expression, which is sound but so blunt it
// rejects the disjoint sibling; see tests/fixtures/borrowIndexFieldPrecision.milo.
// A place with no single named root stays `null` — unknown must keep meaning "any".
export function borrowPrefix(c: TypeChecker, place: Expr): string[] | null {
  const p = c.soloPath(place);
  if (!p) return null;
  const fields: string[] = [];
  for (const s of p.steps) {
    if (s.tag !== "field") break;
    fields.push(s.name);
  }
  return fields;
}

// Release the view/iteration/capture borrows of `info`. Every caller is the code that
// took one of those and knows it is over (a loop ended, a statement's temporaries
// died). A pointer borrow is owned by a BINDING and outlives all of them, so it is
// kept here and released only through `releasePointerBorrows` by its holder; otherwise
// `let p = v.ptr(); for x in v {}; v.push(0)` would drop `p`'s borrow with the loop's.
export function openBorrowWindow(c: TypeChecker): { before: Set<VarInfo> | null } {
  const w = { before: null };
  c.borrowWindows.push(w);
  return w;
}

// Called before any write to a `borrowed` flag: every open window that has not yet
// recorded its before-set records it now, while it still matches the window's start.
export function noteBorrowChange(c: TypeChecker) {
  for (const w of c.borrowWindows) {
    if (w.before) continue;
    const before = new Set<VarInfo>();
    for (const scope of c.scopes) for (const [, vi] of scope) if (vi.borrowed) before.add(vi);
    w.before = before;
  }
}

// Bindings in scope frozen now that were not when `w` opened, in scope order. Closes `w`.
export function newlyFrozenSince(c: TypeChecker, w: { before: Set<VarInfo> | null }): VarInfo[] {
  const at = c.borrowWindows.lastIndexOf(w);
  if (at >= 0) c.borrowWindows.length = at;
  const out: VarInfo[] = [];
  if (!w.before) return out;
  for (const scope of c.scopes) for (const [, vi] of scope) if (vi.borrowed && !w.before.has(vi)) out.push(vi);
  return out;
}

export function retainBorrows(c: TypeChecker, info: VarInfo, keep: (holder: PointerHolder | null, i: number) => boolean) {
  const holders = info.borrowHolders ?? [];
  const idx: number[] = [];
  for (let i = 0; i < (info.borrowedPaths?.length ?? 0); i++) if (keep(holders[i] ?? null, i)) idx.push(i);
  if (idx.length === 0) {
    c.noteBorrowChange();
    info.borrowed = false;
    info.borrowedPaths = undefined;
    info.borrowKinds = undefined;
    info.borrowHolders = undefined;
    info.borrowSites = undefined;
    return;
  }
  const sites = info.borrowSites ?? [];
  info.borrowedPaths = idx.map(i => info.borrowedPaths![i]);
  info.borrowKinds = idx.map(i => info.borrowKinds![i]);
  info.borrowHolders = idx.map(i => holders[i] ?? null);
  info.borrowSites = idx.map(i => sites[i] ?? null);
}

export function pointerBorrowAgainstFields(c: TypeChecker, info: VarInfo, mutFields: string[] | null): PointerHolder | null {
  if (!info.borrowed) return null;
  const holders = info.borrowHolders;
  if (!holders) return null;
  const paths = info.borrowedPaths;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    if (h && c.borrowCollides(paths?.[i], mutFields)) return h;
  }
  return null;
}

// Whether a borrow of field prefix `p` and a mutation of field prefix `mutFields` can
// alias: two chains off one root diverge only at a named field, and an unknown path on
// either side (an index or deref step, or a place with no single root) is a collision.
export function borrowCollides(p: string[] | null | undefined, mutFields: string[] | null): boolean {
  if (p === null || p === undefined || mutFields === null) return true;
  const n = Math.min(p.length, mutFields.length);
  for (let j = 0; j < n; j++) if (p[j] !== mutFields[j]) return false;
  return true;
}

// Whether every live borrow of `info` is a pointer borrow. A move of such a source is
// allowed (see `tryMoveLeaf`), where any other borrow kind forbids it.
export function onlyPointerBorrows(info: VarInfo): boolean {
  const kinds = info.borrowKinds;
  return !!info.borrowed && !!kinds && kinds.length > 0 && kinds.every(k => k === "pointer");
}

// The `*T`-producing calls whose result is an element view of the receiver, reached
// through the casts and struct literals a binding's initializer may wrap them in.
// `let base = s.cstr() as i64` still points into `s`; `let c = Cfg { buf: v.ptr() }`
// holds the pointer for as long as `c` does, and so does `let ps: Vec<*u8> = [v.ptr()]`
// or `Some(v.ptr())`. Anything else (a call result, an arithmetic value, a bare pointer
// variable) carries no provenance this can see.
export function pointerViewsIn(c: TypeChecker, slot: Expr, out: { source: Expr; call: string; line: number }[] = []): { source: Expr; call: string; line: number }[] {
  const e = rewritten(c.rewrites, slot);
  switch (e.kind) {
    case "CastExpr":
      return c.pointerViewsIn(e.operand, out);
    case "StructLit":
      for (const f of e.fields) c.pointerViewsIn(f.value, out);
      if (e.base) c.pointerViewsIn(e.base, out);
      return out;
    case "ArrayLit":
      for (const el of e.elements) c.pointerViewsIn(el, out);
      return out;
    case "EnumLit":
      for (const a of e.args) c.pointerViewsIn(a, out);
      return out;
    case "Call": {
      // A call whose result carries a pointer inherits the views of its pointer
      // arguments: `let q = keep(v.ptr())` with `fn keep(p: *u8): *u8` makes `q` a
      // holder of `v` just as `let q = v.ptr()` would (backlog #43, the returned-param
      // half). Conservative on purpose: a fn that takes a view and returns an unrelated
      // pointer ties the two, and the corpus has none.
      const t = c.exprTypes.get(e);
      if (!t || !c.carriesRawPointer(t)) return out;
      for (const a of e.args) c.pointerViewsIn(a, out);
      return out;
    }
    case "MethodCall": {
      if (e.args.length !== 0) {
        const rt = c.exprTypes.get(e);
        if (rt && c.carriesRawPointer(rt)) for (const a of e.args) c.pointerViewsIn(a, out);
        return out;
      }
      const t = c.exprTypes.get(e);
      if (!t || t.tag !== "ptr") return out;
      const recv = c.exprTypes.get(e.object);
      const bare = recv?.tag === "ref" ? recv.inner : recv;
      // A user `ptr` on T wins over the `Heap<T>` give leg (heapPtrUserMethodWins.milo);
      // `heapMethodReceivers` is the record of that dispatch.
      const isView = (e.method === "ptr" && (bare?.tag === "vec" || (bare?.tag === "heap" && !c.heapMethodReceivers.has(e))))
        || (e.method === "cstr" && bare?.tag === "string")
        // `CStr.ptr()` (std/cstr.milo) returns its own backing pointer; same hazard.
        || (e.method === "ptr" && bare?.tag === "struct" && bare.name === "CStr");
      if (isView) out.push({ source: e.object, call: `${c.describeExpr(e.object)}.${e.method}()`, line: e.span?.line ?? 0 });
      return out;
    }
    default:
      return out;
  }
}

// Bind the pointer views in `value` to the binding `name`: each source is frozen with
// a `pointer` borrow until `name`'s scope pops (the same lexical release a `&[T]`
// binding gets through `freezes`). Only a BINDING creates the borrow: an inline
// `strlen(v.ptr())` has nothing that could outlive the statement, so it stays legal.
export function bindPointerViews(c: TypeChecker, name: string, holderInfo: VarInfo, value: Expr): void {
  for (const pv of c.pointerViewsIn(value)) {
    const ap = c.accessPath(pv.source);
    if (!ap) continue;
    const src = c.lookup(ap.root);
    if (!src || src === holderInfo) continue;
    c.freeze(src, pv.source, "pointer", { name, info: holderInfo, root: ap.root, call: pv.call, line: pv.line });
    addPointerFreeze(holderInfo, src);
  }
}

// `ps.push(v.ptr())` / `m.insert(k, v.ptr())`: the container now holds the pointer, so
// it is the holder and `v` stays frozen for as long as `ps` lives. Without this the
// pointer escaped through an inline argument with no binding of `*T` anywhere in the
// program text, and `v.push(..); strlen(ps[0])` read a freed buffer (h4-ptr-in-vec).
export function holdPointerArgsIn(c: TypeChecker, container: Expr, args: Expr[]): void {
  const ap = c.accessPath(container);
  const info = ap ? c.lookup(ap.root) : null;
  if (!ap || !info) return;
  for (const a of args) c.bindPointerViews(ap.root, info, a);
}

// The scope index a binding lives in, or -1 when it is not in scope (a global is 0).
export function scopeIndexOf(c: TypeChecker, info: VarInfo): number {
  for (let i = c.scopes.length - 1; i >= 0; i--) for (const [, vi] of c.scopes[i]) if (vi === info) return i;
  return -1;
}

// `p = v.ptr()` where `v` was declared in an inner block: `v` is freed when that
// block ends and `p` is still in scope. The `let` form cannot hit this (the binding is
// never older than its initializer's sources), so only assignment checks it.
export function errorIfPointerOutlivesSource(c: TypeChecker, name: string, holder: VarInfo, value: Expr, sp?: Span): void {
  const holderDepth = c.scopeIndexOf(holder);
  for (const pv of c.pointerViewsIn(value)) {
    const ap = c.accessPath(pv.source);
    const src = ap ? c.lookup(ap.root) : null;
    if (!src || src.type.tag === "ref") continue;
    if (c.scopeIndexOf(src) > holderDepth) {
      c.error(`'${ap!.root}' goes out of scope before '${name}', which would still point into its buffer (from '${pv.call}' on line ${pv.line})`, sp,
        `declare '${ap!.root}' in the same block as '${name}' or an enclosing one`);
      return;
    }
  }
}

// `return v.ptr()` (or a struct carrying it, or a binding still holding it) where `v`
// dies with this frame hands the caller a pointer into freed memory. A `&T` param, a
// global, or a source given away with `forget(v)` is fine: the buffer outlives the
// call. (Any other move of the source already ended the holder, and the `return p`
// is rejected as a read of it.) The same rule `errorIfRefReturn` states for `&T`.
export function errorIfReturnedPointerDangles(c: TypeChecker, value: Expr, sp?: Span): void {
  for (const pv of c.pointerViewsIn(value)) {
    const ap = c.accessPath(pv.source);
    const src = ap ? c.lookup(ap.root) : null;
    if (src && c.frameOwned(src)) {
      c.error(`cannot return '${pv.call}': '${ap!.root}' is freed when this function returns, so the pointer would dangle`, sp,
        `return the ${typeName(src.type)} itself, or 'forget' it first if the caller takes ownership of the buffer`);
      return;
    }
  }
  // ident-ok: a pointer holder is a NAME by construction (`let p = v.ptr()`); the
  // holder-of-a-place case is the `pointerViewsIn` loop above.
  if (value.kind === "Ident") {
    const holder = c.lookup(value.name);
    for (const src of holder?.freezes ?? []) {
      const ph = src.borrowHolders?.find(h => h?.info === holder);
      if (ph && src.borrowed && c.frameOwned(src)) {
        c.error(`cannot return '${value.name}': '${ph.root}' is freed when this function returns, so the pointer would dangle (from '${ph.call}' on line ${ph.line})`, sp,
          `return the buffer itself, or 'forget' it first if the caller takes ownership of it`);
        return;
      }
    }
  }
}

// A move keeps the heap buffer where it is, so a pointer borrow of the source is not
// invalidated by `let w = v`, but its obligation now belongs to `w`. Snapshot the
// pointer borrows a whole-variable initializer carries BEFORE `tryMove` releases them
// from the source; `carryPointerBorrows` re-attaches them to the new binding.
export function pointerBorrowsCarriedBy(c: TypeChecker, value: Expr): { from: VarInfo; paths: (string[] | null)[]; holders: PointerHolder[]; field?: boolean } | null {
  // A non-Copy field of an owned root moves its buffer to the new binding just as a whole
  // variable does, so the pointer borrows on that field path follow it (`let w = h.items`).
  if (value.kind === "FieldAccess") {
    const ft = c.exprTypes.get(value);
    const ap = c.accessPath(value);
    const root = ap ? c.lookup(ap.root) : null;
    if (!ft || c.isCopyType(ft) || !ap || ap.fields === null || !root || !root.borrowed || root.type.tag === "ref" || c.borrowBasePath(value) !== null) return null;
    const holders: PointerHolder[] = [];
    const paths: (string[] | null)[] = [];
    const fields = ap.fields;
    (root.borrowHolders ?? []).forEach((h, i) => {
      if (!h || root.borrowKinds?.[i] !== "pointer" || !c.borrowCollides(root.borrowedPaths?.[i], fields)) return;
      const p = root.borrowedPaths?.[i];
      holders.push(h);
      paths.push(p === null || p === undefined ? null : p.slice(fields.length));
    });
    return holders.length > 0 ? { from: root, paths, holders, field: true } : null;
  }
  // ident-ok: a whole-variable move (`let w = v`) carries the borrows; an element move
  // leaves the source's buffer, and its holders, where they are.
  if (value.kind !== "Ident") return null;
  const info = c.lookup(value.name);
  if (!info || !c.onlyPointerBorrows(info) || !info.borrowHolders || !info.borrowedPaths) return null;
  const holders: PointerHolder[] = [];
  const paths: (string[] | null)[] = [];
  info.borrowHolders.forEach((h, i) => { if (h) { holders.push(h); paths.push(info.borrowedPaths![i]); } });
  return holders.length > 0 ? { from: info, paths, holders } : null;
}

export function carryPointerBorrows(c: TypeChecker, carried: { from: VarInfo; paths: (string[] | null)[]; holders: PointerHolder[]; field?: boolean }, toName: string): void {
  const to = c.lookup(toName);
  // Only a binding that actually took ownership carries the borrow: a Copy source is
  // still the owner, `tryMoveLeaf` left its borrows in place, and there is nothing to carry.
  if (!to || (!carried.from.everMoved && !carried.field)) return;
  carried.holders.forEach((h, i) => {
    c.pushBorrow(to, carried.paths[i], "pointer", h, null);
    addPointerFreeze(h.info, to);
  });
}

export function lookup(c: TypeChecker, name: string): VarInfo | null {
  for (let i = c.scopes.length - 1; i >= 0; i--) {
    const info = c.scopes[i].get(name);
    if (info) {
      // globals are accessible directly in closures, so they are never captured
      if (!c._globalTypes.has(name)) {
        // Every closure between the binding's scope and the use captures it; the walk
        // stops at the first closure the binding lives inside, since nothing enclosing
        // that one needs a slot for it.
        for (let f = c.closureFrames.length - 1; f >= 0; f--) {
          const frame = c.closureFrames[f];
          if (i >= frame.depth) break;
          if (!frame.captures.has(name)) {
            frame.captures.set(name, { name, type: info.type, mutable: info.mutable });
          }
        }
      }
      return info;
    }
  }
  return null;
}

// ── Places ────────────────────────────────────────────────────────────────
//
// A *place* is storage an expression evaluates to. `d.a` is the `a` field of
// whatever `d` names. `n + 1` is not a place at all — it is a fresh value that
// aliases nothing.
//
// Every aliasing rule in this checker asks the same question ("what storage
// does this expression reach, and through whose binding"), and each one used
// to ask it with its own walker: accessSteps, accessPath, borrowBasePath,
// isRootMutable, errorIfFrozen, freezeViewSource, plus two more inside the
// view-provenance code. Eight walkers, eight different sets of node kinds, and
// every kind none of them listed was a silent hole — `return d.a` was rejected
// as a move out of a borrow while `return if c { d.a } else { d.b }` compiled
// and double-freed, because no walker knew what an IfExpr was.
//
// So `placesOf` is TOTAL over the expression grammar and fails CLOSED. The
// switch has no `default`: the `never` assignment at the end makes a newly
// added Expr kind a compile error here until someone classifies it, and the
// conservative classification (`opaque` — "storage I cannot name") is the one
// that rejects rather than the one that lets code through.
//
// An expression yields a SET of places because control flow forks: the tails
// of an if- or match-expression are each a candidate result. Callers must
// satisfy their rule for *every* place in the set, never just the first.
export function placesOf(c: TypeChecker, slot: Expr): Place[] {
  const e = rewritten(c.rewrites, slot);
  switch (e.kind) {
    // Fresh values. Own themselves, reach no binding's storage.
    case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
    case "ArrayLit": case "ArrayRepeat": case "StructLit": case "EnumLit":
    case "RangeExpr": case "IsExpr": case "Closure":
      return [VALUE];

    // `o ?? d` is a fork like an if-expression: the result is either o's
    // payload — which lives in o's storage — or the default.
    case "DefaultValue":
      return [...c.stepInto(e.operand, PAYLOAD), ...c.placesOf(e.default)];

    // Arithmetic, comparison and concatenation all build a new value. `&x` is
    // not an expression in this language, so no BinOp/UnaryOp yields a borrow.
    case "BinOp":
      return [VALUE];
    case "UnaryOp":
      return e.op === "*" ? c.stepInto(e.operand, DEREF) : [VALUE];

    case "Ident":
      return [{ tag: "path", root: e.name, steps: [] }];
    case "FieldAccess":
      return c.stepInto(e.object, { tag: "field", name: e.field });
    case "IndexAccess":
      return c.stepInto(e.object, INDEX);

    // The payload of `o!` / `o?` lives inside `o`'s storage, so unwrapping a
    // borrowed Option reaches through the borrow exactly as a field access does.
    case "Unwrap": case "Propagate":
      return c.stepInto(e.operand, PAYLOAD);

    // A cast reinterprets its operand in place — `p as *u8` keeps pointing at
    // the same storage. Forwarding can only over-report (a cast of a non-Copy
    // value is not expressible), and over-reporting is the safe direction.
    case "CastExpr":
      return c.placesOf(e.operand);

    // A method returning a view (`v[a..b]`, which desugars to `.slice(a, b)`,
    // or a user method returning `&[T]`/`&string`) points into its receiver's
    // storage; provenance is enforced at the definition by checkViewProvenance,
    // so the receiver is the root. Any other method returns an owned value.
    // A missing type is not a licence to assume the safe answer.
    case "MethodCall": {
      const t = c.exprTypes.get(e);
      if (!t) return [OPAQUE];
      return t.tag === "ref" ? c.stepInto(e.object, INDEX) : [VALUE];
    }

    // Free functions cannot return a view (errorIfRefReturn rejects a `&T`
    // return without a self receiver), so a call's result is owned. If one
    // ever slips through as a ref, name it unknown rather than fresh.
    case "Call": {
      const t = c.exprTypes.get(e);
      return t && t.tag === "ref" ? [OPAQUE] : [VALUE];
    }

    // Control-flow forks: the result is one of the branch tails. A branch with
    // no value tail either diverges (contributes no place) or ends in a form
    // tailExprOf does not model — indistinguishable here, so both are OPAQUE.
    case "IfExpr":
      return c.tailPlaces([e.thenBody, e.elseBody]);
    case "MatchExpr":
      return c.tailPlaces(e.arms.map(a => a.body));
  }
  // No `default:` on purpose. If this line stops compiling, a new Expr kind was
  // added — classify it above. Reaching it at runtime means the parser produced
  // a node the type says cannot exist, so fail closed rather than guess.
  const _exhaustive: never = e;
  void _exhaustive;
  return [OPAQUE];
}

// Freeze the storage a `for-in` iterates, for the whole loop.
//
// Taken ONCE, before the per-container dispatch, so every iteration shape inherits it
// — vec, hashmap, array, string, user iterator, and whatever is added next. It used to
// be re-derived inside four separate arms, each keyed to `iterable.kind === "Ident"`,
// so `for x in v` was frozen and `for x in b.items` was frozen by nobody: pushing to
// that field inside its own loop reallocated the buffer the loop reads. Vec and
// HashMap were both heap-use-after-free in safe code (ASan, 2026-08-16).
//
// The root is resolved through the place walker rather than matched as a node kind,
// which is the whole point: a new way to SPELL the iterable inherits the rule instead
// of escaping it. The recorded path is what keeps this from over-rejecting — mutating
// a different field of the same struct does not collide with the borrow.
// `for x in &mut v`: the source must be a Vec, array or slice the code may write,
// and the body must not name it at all. The freeze taken for every for-in already
// rejects push/pop/clear on `v`; a `&mut` element view additionally rules out any
// second access (`v[0]`, `v.len`, `f(v)`, a closure capture), since that would be a
// second path to the element `x` points at. The scan is syntactic, which is exact
// here because a binding cannot shadow an outer name.
export function checkMutForInSource(c: TypeChecker, stmt: ForInStmt, rawType: TypeKind, sp?: Span) {
  const loopVar = stmt.varName2 ?? stmt.varName;
  const inner = rawType.tag === "ref" ? rawType.inner : rawType;
  if (inner.tag !== "vec" && inner.tag !== "array" && inner.tag !== "unknown") {
    c.error(`'for ${loopVar} in &mut' iterates a Vec, array or slice, not '${c.show(rawType)}'`, sp);
    return;
  }
  const target = c.syntacticPlace(stmt.iterable);
  if (!target) {
    c.error(`'for ${loopVar} in &mut' needs a named place to iterate`, sp,
      `bind the value first ('var v = ...') and iterate '&mut v'`);
    return;
  }
  const writable = rawType.tag === "ref" ? rawType.mutable : c.isRootMutable(stmt.iterable);
  if (!writable) {
    c.error(`cannot iterate '${target.text}' with '&mut': it is not mutable`, sp,
      rawType.tag === "ref" ? `it is a '&' reference; take it as '&mut' to write through it` : `declare it with 'var'`);
  }
  const overlaps = (a: string[], b: string[]) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    const n = node as Record<string, unknown> & { kind?: string; span?: Span };
    if (n.kind === "Ident" || n.kind === "FieldAccess" || n.kind === "IndexAccess") {
      const place = c.syntacticPlace(n as unknown as Expr, visit);
      if (place) {
        if (place.root === target.root && overlaps(place.fields, target.fields)) {
          const at = n.span ?? sp;
          c.error(`cannot use '${place.text}' inside 'for ${loopVar} in &mut ${target.text}': the loop holds a '&mut' to its elements`, at,
            `reach the element through '${loopVar}', or loop by index if the body needs the whole collection`);
          if (at) c.mutForInUses.set(spanKey(at), c.diagnostics[c.diagnostics.length - 1]);
        }
        return;
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "span") continue;
      visit(v);
    }
  };
  visit(stmt.body);
  visit(stmt.invariants);
}

// Root name and field chain of a place, read off the syntax. Fields stop at the first
// index (`a.b[i].c` is `a.b`), which over-approximates the place: the safe direction
// for an overlap test. `onSub` is handed each index expression (not part of the place,
// but it may name one itself) and a non-name base, so a caller's walk misses neither.
export function syntacticPlace(e: Expr, onSub?: (e: Expr) => void): { root: string; fields: string[]; text: string } | null {
  const steps: string[] = [];
  let cur: Expr = e;
  for (;;) {
    if (cur.kind === "FieldAccess") { steps.unshift(cur.field); cur = cur.object; continue; }
    if (cur.kind === "IndexAccess") { onSub?.(cur.index); steps.unshift("[]"); cur = cur.object; continue; }
    break;
  }
  if (cur.kind !== "Ident") {
    onSub?.(cur);
    return null;
  }
  const cut = steps.indexOf("[]");
  const fields = cut >= 0 ? steps.slice(0, cut) : steps;
  return { root: cur.name, fields, text: [cur.name, ...fields].join(".") };
}

export function noteForInBind(c: TypeChecker, stmt: ForInStmt) {
  const names = stmt.varName2 ? [stmt.varName, stmt.varName2] : [stmt.varName];
  c.forInBindingTypes.set(stmt, names.map(n => c.lookup(n)?.type ?? { tag: "unknown" }));
}

// A for-in iterable is either a place (local, global, field, index, `*h`), which the
// loop borrows, so `for x in v` never empties `v`, or a value, which the loop owns
// exactly as `let __tmp = <iterable>` would: the checker moves it with the same
// tryMove a let initializer makes, so a fork's place tails (`if c { v } else { w }`)
// end up moved or maybe-moved just as they would there, and a Vec/array value is then
// consumed. A field of an rvalue (`mk().items`) stays on the place side: codegen owns
// its whole temporary.
export function isPlaceIterable(c: TypeChecker, slot: Expr): boolean {
  const e = rewritten(c.rewrites, slot);
  return e.kind === "Ident" || e.kind === "FieldAccess" || e.kind === "IndexAccess" ||
    (e.kind === "UnaryOp" && e.op === "*");
}

export function freezeRootOf(c: TypeChecker, place: Expr, kind: BorrowKind = "view", site?: BorrowSite): VarInfo | null {
  const ap = c.accessPath(place);
  if (!ap) return null;
  const info = c.lookup(ap.root);
  if (!info) return null;
  c.freeze(info, place, kind, null, site);
  return info;
}

// Extend every place the base expression reaches by one step. A step off a
// fresh value stays fresh (`makeDoc().a` is a field of a temporary, which owns
// itself); a step off unnamed storage stays unnamed.
export function stepInto(c: TypeChecker, base: Expr, step: PlaceStep): Place[] {
  return c.placesOf(base).map(p =>
    p.tag === "path" ? { tag: "path", root: p.root, steps: [...p.steps, step] } as Place : p);
}

export function tailPlaces(c: TypeChecker, bodies: Stmt[][]): Place[] {
  const out: Place[] = [];
  for (const body of bodies) {
    const tail = c.tailExprOf(body);
    if (!tail) { out.push(OPAQUE); continue; }
    out.push(...c.placesOf(tail));
  }
  return out;
}

// The single-place view the older callers want: a place set collapses to one
// path only when every member agrees on it. A set containing a value, unnamed
// storage, or two different roots has no single answer, and `null` here means
// "no single named place" — callers that must fail closed check the full set.
export function soloPath(c: TypeChecker, e: Expr): { root: string; steps: PlaceStep[] } | null {
  const places = c.placesOf(e);
  if (places.length === 0) return null;
  const first = places[0];
  if (first.tag !== "path") return null;
  for (const p of places.slice(1)) {
    if (p.tag !== "path" || p.root !== first.root || !stepsEq(p.steps, first.steps)) return null;
  }
  return { root: first.root, steps: first.steps };
}

// A field-only path off a named binding — the only shape whose move state can be
// decided at compile time. Any index/deref/payload step means the storage the
// expression names depends on a runtime value, so there is no place to mark.
export function staticFieldPath(c: TypeChecker, e: Expr): { root: string; path: string } | null {
  const p = c.soloPath(e);
  if (!p || p.steps.length === 0) return null;
  if (p.steps.some(s => s.tag !== "field")) return null;
  return { root: p.root, path: p.steps.map(stepKey).join("") };
}

// Rust's E0509: the type a field is being moved out of implements Drop. Returns the
// offending type name, checking every base in the chain — moving `p.i.t` leaves both
// `p.i` and `p` incomplete, so a Drop on either is a problem.
//
// Milo's answer before this check was worse than either alternative: codegen sees a
// partially moved local and skips its drop glue entirely, so `drop` never runs at all
// and whatever it was going to release — a file, a GL name, a lock — leaks with no
// diagnostic. Running it instead would hand the destructor a zeroed field, which is
// the silent-wrong-data outcome. A `Drop` impl is written against the whole value, so
// the honest answer is that the value cannot be taken apart.
export function dropTypeInPath(c: TypeChecker, e: Expr): string | null {
  let cur: Expr = e;
  // ident-ok: inspects the TYPE at each step, not just the root, so it needs the walk itself; a root-only resolver would lose the intermediate types this rule is about
  while (cur.kind === "FieldAccess" || cur.kind === "IndexAccess") {
    cur = cur.object;
    const t = c.exprTypes.get(cur);
    const bare = t && t.tag === "ref" ? t.inner : t;
    if (bare && bare.tag === "struct" && c.dropImpls.has(bare.name)) return bare.name;
  }
  return null;
}

export function shareMovedExpr(c: TypeChecker, e: Expr) {
  c.movedExprs.delete(e);
  c.sharedStringExprs.add(e);
}

// A string argument still moved at a call where another argument uses the same place: a
// string at a move position can always be shared instead.
export function shareStringArg(c: TypeChecker, arg: Expr): boolean {
  if (c.exprTypes.get(arg)?.tag !== "string" || !c.movedExprs.has(arg)) return false;
  c.shareMovedExpr(arg);
  return true;
}

// Index-aware access path: each step is a field name (".f") or an opaque index
// ("[]"). Unlike accessPath (which collapses to fields=null at the first index),
// this preserves depth so an ancestor/descendant relationship survives an index.
export function accessSteps(c: TypeChecker, e: Expr): { root: string; steps: string[] } | null {
  const p = c.soloPath(e);
  return p ? { root: p.root, steps: p.steps.map(stepKey) } : null;
}

// True when the two step chains (same root) are in a containment relation that
// makes aliasing them mutably unsafe: one is a proper prefix of the other (an
// ancestor container and a descendant), or they are identical with no index step
// (provably the same concrete place). Two chains that diverge, or are equal but
// pass through an index (siblings that may be distinct elements), are not flagged.
export function aliasesByContainment(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; // diverge → disjoint
  if (a.length !== b.length) return true;                      // proper prefix → ancestor/descendant
  return !a.includes("[]");                                    // identical: same place unless index-qualified
}

// Access path for exclusivity: root variable + chain of field names. `fields` is
// null when the access goes through an index, deref or payload, where offsets are
// dynamic and disjointness can't be proven — callers treat null as "may alias".
export function accessPath(c: TypeChecker, e: Expr): { root: string; fields: string[] | null } | null {
  const p = c.soloPath(e);
  if (!p) return null;
  const fields: string[] = [];
  for (const s of p.steps) {
    if (s.tag !== "field") return { root: p.root, fields: null };
    fields.push(s.name);
  }
  return { root: p.root, fields };
}

// The place an argument names for the exclusivity check, with a ref binding resolved to
// the storage it points into. `inner` from `match s { Full(inner) => … }` over a
// `s: &mut Slot` is a view of `s`'s payload under another name, so `f(&mut inner, s)`
// passes two parameters over one place; resolved, it collides with `s` like a field.
// `root` is the root's VarInfo (identity survives shadowing), or its name when unbound.
export function exclusivityPlace(c: TypeChecker, e: Expr): { root: unknown; name: string; fields: string[] | null; steps: string[] } | null {
  const p = c.soloPath(e);
  if (!p) return null;
  let root: unknown = p.root, name = p.root;
  let steps = p.steps;
  const into = c.lookup(p.root)?.refInto;
  if (into) { root = into.root; name = into.name; steps = [...into.steps, ...steps]; }
  else root = c.lookup(p.root) ?? p.root;
  const fields = steps.every(s => s.tag === "field") ? steps.map(s => (s as { name: string }).name) : null;
  return { root, name, fields, steps: steps.map(stepKey) };
}

// A by-value argument that moves a named place (non-Copy, so the callee becomes its
// owner). A Copy value or a closure is not exclusive: the callee gets its own copy, or
// a non-owning view checked when the closure was formed.
export function isMovedPlaceArg(c: TypeChecker, arg: Expr): boolean {
  const t = c.exprTypes.get(arg);
  if (!t || t.tag === "ref" || t.tag === "fn" || t.tag === "ptr" || c.isCopyType(t)) return false;
  return c.soloPath(arg) !== null;
}

// Record that pattern binding `info` (binding `index` of `variant`) is a ref into the
// match subject, for exclusivityPlace. The binding step is a pseudo-field, so two
// bindings of one pattern stay disjoint while either still overlaps the subject.
export function noteRefIntoSteps(c: TypeChecker, info: VarInfo, subject: Expr, path: PatternLeaf["steps"]) {
  if (info.type.tag !== "ref") return;
  const p = c.soloPath(subject);
  if (!p) return;
  const base = c.lookup(p.root);
  const steps: PlaceStep[] = path.map(st => ({ tag: "field", name: `$${st.variant}.${st.index}` }));
  info.refInto = base?.refInto
    ? { root: base.refInto.root, name: base.refInto.name, steps: [...base.refInto.steps, ...p.steps, ...steps] }
    : { root: base ?? p.root, name: p.root, steps: [...p.steps, ...steps] };
}

export function noteRefInto(c: TypeChecker, info: VarInfo, subject: Expr, variant: string, index: number) {
  if (info.type.tag !== "ref") return;
  const p = c.soloPath(subject);
  if (!p) return;
  const base = c.lookup(p.root);
  const step: PlaceStep = { tag: "field", name: `$${variant}.${index}` };
  info.refInto = base?.refInto
    ? { root: base.refInto.root, name: base.refInto.name, steps: [...base.refInto.steps, ...p.steps, step] }
    : { root: base ?? p.root, name: p.root, steps: [...p.steps, step] };
}

// Marks the written place once, at its full path: the recursion below walks to the
// root, and marking there too would record every write as a write of the whole capture.
export function isRootMutable(c: TypeChecker, expr: Expr): boolean {
  c.markCaptureMutated(expr);
  return c.rootMutable(expr);
}

// An assignment target `x.f` / `x[i]`: whether its root is writable, marking the
// capture written at the target's own path rather than at its object's.
export function writtenPlaceMutable(c: TypeChecker, target: Expr & { object: Expr }): boolean {
  c.markCaptureMutated(target);
  return c.rootMutable(target.object);
}

export function rootMutable(c: TypeChecker, slot: Expr): boolean {
  const expr = rewritten(c.rewrites, slot);
  // ident-ok: the Ident base case of isRootMutable, which IS the mutability walk over places
  if (expr.kind === "Ident") {
    const info = c.lookup(expr.name);
    return info?.mutable ?? false;
  }
  if (expr.kind === "FieldAccess") return c.rootMutable(expr.object);
  if (expr.kind === "IndexAccess") return c.rootMutable(expr.object);
  // raw pointer and box derefs are always mutable (unsafe required separately)
  if (expr.kind === "UnaryOp" && (expr.op === "*")) return true;
  return false;
}

export function frozenAgainstFields(c: TypeChecker, info: VarInfo, mutFields: string[] | null, ignore?: BorrowKind): boolean {
  if (!info.borrowed) return false;
  const paths = info.borrowedPaths;
  if (!paths || paths.length === 0) return true;
  return paths.some((p, i) => (ignore === undefined || info.borrowKinds?.[i] !== ignore) && c.borrowCollides(p, mutFields));
}

// The capture borrow of `info` that a write of `mutFields` collides with: a closure literal that captured it and may still run.
// Every other conflict (views, loops, callbacks, pointers) is src/borrow-flow.ts's.
export function captureBorrowAgainst(c: TypeChecker, info: VarInfo, mutFields: string[] | null): BorrowSite | null {
  const paths = info.borrowedPaths ?? [];
  for (let i = 0; i < paths.length; i++) {
    if (info.borrowKinds?.[i] === "capture" && c.borrowCollides(paths[i], mutFields)) return info.borrowSites?.[i] ?? { span: undefined };
  }
  return null;
}

// `prefix` is the rejected operation with its place ("cannot call 'push' on 'xs'").
export function reportCaptured(c: TypeChecker, prefix: string, root: string, site: BorrowSite, sp: Span | undefined) {
  const it = prefix.endsWith(`'${root}'`) ? "it" : `'${root}'`;
  c.errorWithNotes(`${prefix} while a closure captures ${it}`, sp,
    `the closure may still run and read '${root}': make the change before the closure is created, or after its last call`,
    [{ message: `this closure captures '${root}'`, span: site.span }]);
}

export function errorIfFrozen(c: TypeChecker, obj: Expr, action: string, sp?: Span) {
  c.writtenExprs.add(obj);
  for (const place of c.placesOf(obj)) {
    if (place.tag !== "path") continue;
    const info = c.lookup(place.root);
    const site = info ? c.captureBorrowAgainst(info, c.targetFields(obj)) : null;
    if (site) {
      c.reportCaptured(`cannot ${action} '${place.root}'`, place.root, site, sp);
      return;
    }
  }
}

// The place argument of `replace`/`swap`, written as a `&mut` argument writes it: a
// live loop, view, scope borrow or pointer into it forbids the write (errorIfFrozen),
// and inside a by-reference closure it is a write of the capture, which a caller
// looping over that capture must see.
export function checkPlaceArgWrite(c: TypeChecker, place: Expr, action: string, sp?: Span) {
  c.markCaptureMutated(place);
  c.errorIfFrozen(place, action, sp);
}

// Explicit `&mut` on call arguments.
// Runs on the raw argument list before any argument is type-checked. Where the
// parameter is `&mut T` the `&mut` wrapper is stripped in place, so every later pass
// (freeze and exclusivity checks, lowering, codegen) sees the argument it always did
// and the marker changes nothing downstream. Anywhere else the wrapper is an error.
// `paramAt(i)` is the parameter the argument binds to; undefined when the arity is
// already wrong (that error is reported by the caller, so the wrapper is dropped
// silently rather than adding a second one). Runs before the arity check would
// return, so a misplaced `&mut` is diagnosed alongside it.
export function takeExplicitMutArgs(c: TypeChecker, args: Expr[], callee: string, paramAt: (i: number) => { name: string; mut: boolean; show: () => string } | undefined) {
  for (let i = 0; i < args.length; i++) {
    const arg = rewritten(c.rewrites, args[i]!);
    const param = paramAt(i);
    if (arg.kind === "UnaryOp" && arg.op === "&mut") {
      args[i] = arg.operand;
      c.explicitMutArgs.add(arg.operand);
      if (param && !param.mut) {
        c.error(`'&mut' on an argument to a '${param.show()}' parameter of '${callee}'; only a '&mut' parameter takes '&mut'`, arg.span);
      }
      continue;
    }
    if (param?.mut && !c.explicitMutArgs.has(arg)) c.noteImplicitMut(arg, callee, param.name);
  }
}

export function noteImplicitMut(c: TypeChecker, arg: Expr, callee: string, param: string) {
  const at = arg.span;
  // A span-less argument cannot be deduplicated by position, so it is always reported.
  const key = at ? `${at.file ?? ""}:${at.line}:${at.col}` : `${callee}:${param}:${c.implicitMutSeen.size}`;
  if (c.implicitMutSeen.has(key)) return;
  c.implicitMutSeen.add(key);
  const text = c.describeExpr(arg);
  // A dependency's symbols reach here as `<pkg>$name` (src/mangle.ts); the hint has
  // to print the call as the package's own source spells it, or it names a symbol
  // nobody can write.
  const sep = callee.indexOf("$");
  const shown = sep > 0 && (c._packageNames !== undefined && c._packageNames.has(callee.slice(0, sep))) ? callee.slice(sep + 1) : callee;
  // A hard error, not a warning-table entry: no --allow reaches it. The code stays so
  // tooling (scripts/explicit-mut.ts, the LSP) can match the diagnostic.
  c.diagnostics.push({
    severity: "error", span: at, code: "implicit-mut-borrow",
    message: `argument '${text}' is passed to a '&mut' parameter without '&mut'`,
    hint: `write '${shown}(... &mut ${text} ...)'; run 'milo fix <file>' to rewrite the file`,
  });
}

// Auto-borrow a call argument; passing a frozen var by mutable ref is the same
// hazard as calling a mutating method on it (the callee may realloc/free it).
export function setAutoBorrowChecked(c: TypeChecker, arg: Expr, mutable: boolean, sp?: Span) {
  // Cross-check for takeExplicitMutArgs: a `&mut` binding no call site routed through
  // it (a builtin, say) still gets counted, under a callee the count marks unknown.
  if (mutable && !c.explicitMutArgs.has(arg)) c.noteImplicitMut(arg, "?", "?");
  if (mutable) {
    // Builtin calls never reach checkCallSiteExclusivity, which marks the rest.
    c.markCaptureMutated(arg);
    // Only for a value being *turned into* a borrow. An argument that is already
    // a reference — a slice like `v[0..2]` — is not competing with the freeze, it
    // IS one, and whether two of them may coexist is checkCallSiteExclusivity's
    // call: it compares access paths and knows `v[0..2]` and `v[2..4]` are
    // disjoint, which this check cannot see (any index collapses its path to
    // "may alias"). Asking both means the blunt one always wins and
    // `fill(v[0..2], v[2..4])` — a supported disjoint split — stops compiling.
    if (c.exprTypes.get(arg)?.tag !== "ref") c.errorIfFrozen(arg, "pass", sp);
    // Passing an immutable binding to a '&mut' param mutates it through the
    // call — the same hazard method receivers already reject ("cannot push to
    // immutable Vec"). A 'let' claims immutability *and* SSA-register storage;
    // taking its address for '&mut' forces a spill and silently breaks both.
    // Free-function '&mut' args were the one path that skipped this check.
    // Every binding the argument could name has to be mutable: a fork reaches
    // more than one, and it is the immutable arm that would be written through.
    const bad = c.unwritableMutTarget(arg);
    if (bad?.shared) {
      c.error(`cannot pass '${c.describeExpr(arg)}', a shared '&' reference, as a '&mut' argument`, sp,
        `take '&mut ${c.show(bad.shared)}' in this function's signature if it needs to mutate`);
    } else if (bad) {
      c.error(`cannot pass immutable '${c.describeExpr(arg)}' as a '&mut' argument`, sp,
        `declare with 'var' to make it mutable`);
    }
  }
  c.autoBorrow(arg, { mutable });
}

// Whether a `&mut` borrow of `expr` would write through a binding that is not writable:
// a `let` (`shared` unset) or a shared `&T` (`shared` is T). Every binding the place
// could name has to be writable: a fork reaches more than one, and it is the immutable
// arm that would be written through. A temporary names no binding and passes.
export function unwritableMutTarget(c: TypeChecker, expr: Expr): { shared?: TypeKind } | null {
  for (const place of c.placesOf(expr)) {
    if (place.tag !== "path") continue;
    const info = c.lookup(place.root);
    if (info && !info.mutable && info.type.tag !== "ref") return {};
    // A shared '&T' binding is no more writable than a 'let': forwarding it to a
    // '&mut' parameter let a callee mutate the caller's value through a borrow
    // the caller had handed out as read-only (found in milojs, 2026-09-22).
    if (info && info.type.tag === "ref" && !info.type.mutable) return { shared: info.type.inner };
  }
  return null;
}

// Freeze the receiver while checking a callback that iterates it — the callback
// mutating its own iteration source (v.each(fn(x){ v.push(x) })) is the same
// realloc hazard as for-in. Returns the VarInfo to release afterward, or null
// if an outer borrow already owns the freeze.
export function borrowDuringCallback(c: TypeChecker, obj: Expr, call: { method: string; span?: Span }): VarInfo | null {
  const cbRoot = c.rootNameOf(obj);
  if (cbRoot === null) return null;
  const info = c.lookup(cbRoot);
  if (!info || info.borrowed) return null;
  c.freeze(info, obj, "view", null, { span: call.span, via: "callback", what: call.method });
  return info;
}

export function describeExpr(c: TypeChecker, slot: Expr): string {
  const expr = rewritten(c.rewrites, slot);
  // The hidden local a destructuring `let { a } = f()` reads from (parser.ts
  // parseDestructure); nobody wrote its name, so a diagnostic shows the pattern.
  if (expr.kind === "Ident") return expr.name.startsWith("_destructure") ? "{ … }" : expr.name;
  if (expr.kind === "IntLit") return expr.value.toString();
  if (expr.kind === "UnaryOp" && expr.op === "*") return `*${c.describeExpr(expr.operand)}`;
  if (expr.kind === "FieldAccess") return `${c.describeExpr(expr.object)}.${expr.field}`;
  if (expr.kind === "IndexAccess") return `${c.describeExpr(expr.object)}[...]`;
  if (expr.kind === "Unwrap") return `${c.describeExpr(expr.operand)}!`;
  if (expr.kind === "Propagate") return `${c.describeExpr(expr.operand)}?`;
  // `v[a..b]` parses as a `slice` call.
  if (expr.kind === "MethodCall") return expr.method === "slice" ? `${c.describeExpr(expr.object)}[..]` : `${c.describeExpr(expr.object)}.${expr.method}(...)`;
  return "<expr>";
}

// Freeze `info` for a borrow of `place`. The path is recorded so a later mutation of a
// provably different field isn't rejected; pass null when the borrowed place is unknown.
export function freeze(c: TypeChecker, info: VarInfo, place: Expr | null, kind: BorrowKind = "view", holder: PointerHolder | null = null, site?: BorrowSite) {
  c.pushBorrow(info, place ? c.borrowPrefix(place) : null, kind, holder, site ?? { span: place?.span });
}

export function unfreeze(c: TypeChecker, info: VarInfo) {
  c.retainBorrows(info, (_, i) => info.borrowKinds?.[i] === "pointer");
}

// Loop frames carry reachability only: how many reachable `break`s and `continue`s the
// body has, and whether the loop itself was reachable.
export function beginLoop(c: TypeChecker) {
  c.loopFrames.push({ breaks: 0, continues: 0, reachable: c.reachable });
}

// The join after a branch construct: the code after it is reachable when any path is.
export function joinPaths(c: TypeChecker, reachables: boolean[]) {
  c.reachable = reachables.some(r => r);
}

export function releasePointerBorrows(c: TypeChecker, info: VarInfo, holder: VarInfo) {
  c.retainBorrows(info, (h) => !(h && h.info === holder));
}

// The field chain a mutation of `target` writes under its root; null (the whole
// variable, conservatively) when there is no target or a step is not a field.
export function targetFields(c: TypeChecker, target: Expr | null): string[] | null {
  return target ? c.accessPath(target)?.fields ?? null : null;
}

// Storage this frame owns and frees on exit: a local or by-value param. A `&T` param
// and a global outlive the call, so a pointer into them is the caller's business.
export function frameOwned(c: TypeChecker, info: VarInfo): boolean {
  return info.type.tag !== "ref" && c.scopeIndexOf(info) >= c.fnScopeFloor;
}

// Returns the frozen root with the exact site the loop took, so the loop can release only its own
// borrow (`releaseBorrowSite`) and leave every other view of the same Vec alone.
export function freezeIterable(c: TypeChecker, iterable: Expr, loopSpan?: Span): { info: VarInfo; site: BorrowSite } | null {
  const site: BorrowSite = { span: loopSpan ?? iterable.span, via: "loop" };
  const info = c.freezeRootOf(iterable, "iteration", site);
  return info ? { info, site } : null;
}

// End the one borrow that was recorded with `site`. Unlike `unfreeze` this keeps every other
// borrow of `info` (views, pointers, other loops), which are owned by other bindings.
export function releaseBorrowSite(c: TypeChecker, info: VarInfo, site: BorrowSite) {
  const sites = info.borrowSites ?? [];
  c.retainBorrows(info, (_, i) => sites[i] !== site);
}

// Freeze the root of any borrowed place, resolved through the place walker.
//
// This replaces three hand-rolled copies of the same loop — `while (root.kind ===
// "FieldAccess" || root.kind === "IndexAccess") root = root.object` then match `Ident`
// — which lived in the string-view for-in, the slice-view expression and the
// string-view expression. Each knew exactly two ways to step toward a root, so a place
// spelled any other way (an unwrap, a cast, the tail of a fork) resolved to no root and
// was silently not frozen. That is the same shape as the for-in freeze that was keyed
// to a bare `Ident` and turned out to be a use-after-free; these three had two steps
// instead of one, which makes them narrower holes rather than different ones.
//
// `accessPath` goes through `soloPath`/`placesOf`, which is total over the expression
// grammar and fails closed, so a new `Expr` kind inherits this rule instead of escaping
// it. Returns null when the place has no single named root, which is the honest answer
// and leaves the caller no worse off than the hand-rolled walk did.
// The root binding a place is reached from, resolved through the place walker. Replaces
// the hand-rolled `while (kind === "FieldAccess" || kind === "IndexAccess")` loops, each
// of which knew exactly two ways to step toward a root and silently answered "no root"
// for anything spelled otherwise.
export function rootNameOf(c: TypeChecker, e: Expr): string | null {
  return c.accessPath(e)?.root ?? null;
}

export function isPlaceExpr(c: TypeChecker, e: Expr): boolean {
  return c.rootNameOf(e) !== null;
}

// A ref binding into the subject (a `&`/`&mut` payload view) keeps the subject's root
// frozen for as long as the binding lives: assigning the subject would drop the
// payload the view points into (`n = Node.Empty; print(s)` read freed memory). The
// freeze rides on the binding's `freezes`, which the scope pop releases.
export function freezeSubjectFor(c: TypeChecker, subject: Expr, bindTypes: TypeKind[]): VarInfo[] {
  if (!bindTypes.some(t => t.tag === "ref")) return [];
  const root = c.freezeRootOf(subject);
  return root ? [root] : [];
}

// A match/if-let subject that names storage someone else keeps owning, so its non-Copy
// payloads bind as borrows instead of moving out. An immutable global is one: nothing
// owns it and nothing can rewrite it, so matching on it can only borrow. A `var` global
// is left out on purpose: an arm may call a function that reassigns it, and no rule
// tracks a payload borrow across that call (the same hole `match G.field` has today),
// so it stays a move, which tryMoveLeaf rejects with a hint to clone.
export function isBorrowedMatchPlace(c: TypeChecker, subject: Expr): boolean {
  if (subject.kind === "FieldAccess" || subject.kind === "IndexAccess") return true;
  if (subject.kind === "UnaryOp" && subject.op === "*") return true;
  // ident-ok: a global is a property of the declaration the name resolves to
  if (subject.kind !== "Ident") return false;
  const info = c.lookup(subject.name);
  return info?.isGlobal === true && !info.mutable;
}

export function enumSubjectBorrow(c: TypeChecker, subject: Expr, rawSubjType: TypeKind, patterns: (Pattern | undefined)[] = []): { subjType: TypeKind; subjBorrows: boolean; subjIsMut: boolean } {
  let subjIsRef = rawSubjType.tag === "ref" && rawSubjType.inner.tag === "enum";
  let subjType: TypeKind = subjIsRef && rawSubjType.tag === "ref" ? rawSubjType.inner : rawSubjType;
  let subjIsMut = subjIsRef && rawSubjType.tag === "ref" && rawSubjType.mutable;
  // ident-ok: asks whether the subject BINDING was declared `&E`, a property of the declaration
  if (!subjIsRef && subject.kind === "Ident") {
    const info = c.lookup(subject.name);
    if (info && info.type.tag === "ref" && info.type.inner.tag === "enum") { subjIsRef = true; subjIsMut = info.type.mutable; subjType = info.type.inner; }
  }
  if (subjIsMut) c.matchSubjectMut.add(subject);
  const subjIsPlace = !subjIsRef && subjType.tag === "enum" && c.isBorrowedMatchPlace(subject);
  const subjBorrows = subjIsRef || subjIsPlace ||
    (!subjIsRef && c.ownedInspectOnly(subject, subjType, patterns));
  c.refuseDropEnumMoveOut(subject, subjType, subjBorrows, patterns);
  if (subjBorrows) c.matchSubjectRef.add(subject);
  return { subjType, subjBorrows, subjIsMut };
}

// An OWNED enum in a local, inspected by patterns that bind nothing but `_` and Copy
// payloads, is read rather than consumed: nothing escapes the arm, so the subject is
// still usable afterwards. checkMatchLike has always applied this; if-let and let-else
// did not, which made `if let A(n) = v { }` MOVE `v` where the identical `match` left it
// alone. The two spellings have to agree, or the lint that rewrites one into the other
// (single-variant-match) turns compiling code into a use-after-move error.
export function ownedInspectOnly(c: TypeChecker, subject: Expr, subjType: TypeKind, patterns: (Pattern | undefined)[]): boolean {
  // ident-ok: the rule is about a NAMED owned local, not any expression of enum type
  if (subject.kind !== "Ident" || subjType.tag !== "enum") return false;
  // A Drop impl runs against the whole value, so a match never takes one apart (Rust's
  // E0509): the subject is borrowed and its non-Copy payloads bind as views. Consuming
  // it instead left the binary skipping the drop and the interpreter dropping a value
  // whose payload had been moved out.
  if (c.dropImpls.has(subjType.name)) return true;
  return c.bindsOnlyCopy(subjType, patterns);
}

// An rvalue subject has no place to borrow from, so moving a payload out of a Drop
// enum there is refused rather than leaving the drop to see an emptied value.
export function refuseDropEnumMoveOut(c: TypeChecker, subject: Expr, subjType: TypeKind, subjBorrows: boolean, patterns: (Pattern | undefined)[]): void {
  if (subjBorrows || subjType.tag !== "enum" || !c.dropImpls.has(subjType.name)) return;
  if (c.bindsOnlyCopy(subjType, patterns)) return;
  c.error(`cannot move a payload out of '${subjType.name}', which implements Drop`, subject.span,
    `a Drop impl runs against the whole value; bind it first (\`let t = ...\`) and match on \`t\`, whose payloads bind as views`);
}

// A by-value parameter that does not take the argument: a `&T` param, an array decaying
// to a pointer, or an owning closure lent to a plain closure parameter.
export function argIsBorrowed(c: TypeChecker, slot: Expr, paramType: TypeKind): boolean {
  const arg = rewritten(c.rewrites, slot);
  return paramType.tag === "ref" || c.decaysToPtr(arg, paramType) || c.lendsOwningClosure(arg, paramType);
}

// A plain `(T) => R` parameter cannot keep what it is given (checkNonEscapingParams),
// so a `move` closure passed to one is lent, not given: the caller still owns and drops
// it, and the callee may call it any number of times. Moving it instead made a capture
// passed on this way consume the enclosing `move` closure (call-once trap) and left
// nobody to drop the environment. A fn value's plain parameter is equally binding,
// since typeEq keeps a `move` parameter from being passed off as a plain one.
export function lendsOwningClosure(c: TypeChecker, arg: Expr, paramType: TypeKind | undefined): boolean {
  if (paramType?.tag !== "fn" || paramType.owning) return false;
  const argType = c.exprTypes.get(arg);
  return argType?.tag === "fn" && argType.owning === true;
}
