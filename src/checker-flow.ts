// View provenance, fall-off and reachability analysis, copy-ness queries.
import { TypeChecker } from "./checker";
import type { Expr, Function, Pattern, Span, Stmt, ForInStmt } from "./ast";
import { typeName } from "./types";
import type { TypeKind } from "./types";
import { rewritten } from "./checker-util";

// `s.lines()` / `s.splitView(sep)` are loop forms, not expressions: the receiver type has
// to be known *before* the call is checked as an expression, because checking it that way
// reports the misuse error. Only paths (`text`, `self.src`) are recognized — any other
// receiver falls through to the normal path and gets that error, which is the right
// answer anyway for a temporary the view would outlive.
export function stringViewIterMode(c: TypeChecker, iterable: Expr): "lines" | "split" | null {
  if (iterable.kind !== "MethodCall") return null;
  const mode = iterable.method === "lines" ? "lines" : iterable.method === "splitView" ? "split" : null;
  if (!mode) return null;
  let t = c.peekPathType(iterable.object);
  if (t?.tag === "ref") t = t.inner;
  return t?.tag === "string" ? mode : null;
}

// Side-effect-free type of a variable/field path. Deliberately partial: a null answer
// means "ask the real checker", never "no type".
export function peekPathType(c: TypeChecker, e: Expr): TypeKind | null {
  // A literal's bytes are a module constant, so views of it outlive any loop
  if (e.kind === "StringLit") return { tag: "string" };
  // ident-ok: asks what type a NAME has, and is the base case of a walk that handles the other steps itself
  if (e.kind === "Ident") return c.lookup(e.name)?.type ?? c._globalTypes.get(e.name) ?? null;
  if (e.kind === "FieldAccess") {
    let base = c.peekPathType(e.object);
    if (base?.tag === "ref" || base?.tag === "heap") base = base.inner;
    if (base?.tag !== "struct") return null;
    return c.structs.get(base.name)?.fields.find(f => f.name === e.field)?.type ?? null;
  }
  // `rows[i].lines()` — an element read, so the freeze on the root container still covers
  // the storage the pieces point into
  if (e.kind === "IndexAccess") {
    let base = c.peekPathType(e.object);
    if (base?.tag === "ref" || base?.tag === "heap") base = base.inner;
    if (base?.tag === "vec" || base?.tag === "array") return base.element;
    if (base?.tag === "hashmap") return base.value;
    return null;
  }
  return null;
}

export function checkStringViewForIn(c: TypeChecker, stmt: ForInStmt, mode: "lines" | "split", fnRetType: TypeKind) {
  const call = stmt.iterable as import("./ast").MethodCall;
  const sp = stmt.span;
  c.checkExpr(call.object);
  if (mode === "split") {
    if (call.args.length !== 1) {
      c.error(`'splitView' expects 1 argument, got ${call.args.length}`, sp);
    } else {
      const sepType = c.checkExpr(call.args[0]);
      if (sepType.tag !== "string" && sepType.tag !== "unknown") {
        c.error(`'splitView': expected string, got ${c.show(sepType)}`, sp);
      }
    }
  } else if (call.args.length !== 0) {
    c.error(`'lines' takes no arguments`, sp);
  }
  // Same freeze a slice takes: every piece points into the receiver's buffer, so it must
  // not be mutated, moved or reallocated for the whole loop.
  const rootInfo = c.freezeRootOf(call.object);
  c.borrowedExprs.add(call.object);
  c.stringViewForIns.set(stmt, { mode });

  const viewType: TypeKind = { tag: "ref", inner: { tag: "string" }, mutable: false };
  c.beginLoop();
  c.pushScope();
  if (stmt.varName2) {
    // enumerate: `for i, line in text.lines()`
    c.declare(stmt.varName, { type: { tag: "int", bits: 64, signed: true }, mutable: false, borrowed: false, read: false }, stmt.span);
    c.declare(stmt.varName2, { type: viewType, mutable: false, borrowed: false, read: false }, stmt.span);
  } else {
    c.declare(stmt.varName, { type: viewType, mutable: false, borrowed: false, read: false }, stmt.span);
  }
  for (const inv of stmt.invariants ?? []) c.checkContractClause(inv);
  c.noteForInBind(stmt);
  c.loopDepth++;
  for (const s of stmt.body) c.checkStmt(s, fnRetType);
  c.loopDepth--;
  c.popScope();
  if (rootInfo) c.unfreeze(rootInfo);
  c.endLoop(true);
}

export function recordViewProvenance(c: TypeChecker, fn: Function) {
  const ret = fn.retType ? c.resolve(fn.retType) : null;
  if (!ret || !c.isViewReturn(ret) || !c.hasSelfReceiver(fn)) return;
  // Walks the AST directly rather than through accessSteps: this runs before any body
  // is checked, so expression types aren't known yet and a `.slice(a, b)` call can't be
  // recognized as a view by its type.
  const chain = (e: Expr): string[] | null => {
    if (e.kind === "Ident") return e.name === "self" ? [] : null;
    if (e.kind === "FieldAccess") { const b = chain(e.object); return b && [...b, e.field]; }
    if (e.kind === "IndexAccess" || e.kind === "MethodCall") return chain(e.object);
    return null;
  };
  let fields: string[] | null = null;
  for (const stmt of fn.body ?? []) {
    if (stmt.kind !== "Return" || !stmt.value) continue;
    const named = chain(stmt.value);
    if (!named) return;
    if (fields !== null && (fields.length !== named.length || fields.some((f, i) => f !== named[i]))) return;
    fields = named;
  }
  if (fields !== null) c.viewReturnFields.set(fn.name, fields);
}

// The owned type a rejected reference return should become: what `.clone()` on the
// returned slice or reference produces.
export function ownedReturnType(c: TypeChecker, ret: TypeKind): string {
  if (ret.tag !== "ref") return c.show(ret);
  const inner = ret.inner;
  if (inner.tag === "array" && inner.size === null) return `Vec<${c.show(inner.element)}>`;
  return c.show(inner);
}

// What a returned reference is called in a diagnostic, one word per concept across the
// checker: "slice" for a range of a string/Vec/array, "reference" for a `&T` value
// passed through, "borrow" for anything else that reaches into storage.
export function returnedRefKind(c: TypeChecker, value: Expr, ret: TypeKind): string {
  if (value.kind === "IndexAccess" && value.index.kind === "RangeExpr") return "slice";
  if (value.kind === "MethodCall" && c.isViewReturn(ret)) return "slice";
  if (value.kind === "Ident" || value.kind === "FieldAccess") return "reference";
  return "borrow";
}

// Source spelling of a short returned expression, for a fix-it hint. Only shapes that
// print back unambiguously; anything else is null and the hint stays generic.
export function shortExprText(e: Expr): string | null {
  const atom = (x: Expr): string | null =>
    x.kind === "Ident" ? x.name : x.kind === "IntLit" ? String(x.value) : null;
  const go = (x: Expr): string | null => {
    switch (x.kind) {
      case "Ident": case "IntLit": return atom(x);
      case "FieldAccess": { const o = go(x.object); return o && `${o}.${x.field}`; }
      case "BinOp": { const l = atom(x.left), r = atom(x.right); return l && r && `${l} ${x.op} ${r}`; }
      case "IndexAccess": {
        const o = go(x.object);
        if (!o) return null;
        if (x.index.kind === "RangeExpr") {
          const a = go(x.index.start), b = go(x.index.end);
          return a && b && `${o}[${a}..${b}]`;
        }
        const i = go(x.index);
        return i && `${o}[${i}]`;
      }
      case "MethodCall": {
        const o = go(x.object);
        const args = x.args.map(go);
        if (!o || !args.every(a => a !== null)) return null;
        // The parser desugars `v[a..b]` to `.slice(a, b)`; print it back the way it was written.
        return x.method === "slice" && args.length === 2 ? `${o}[${args[0]}..${args[1]}]` : `${o}.${x.method}(${args.join(", ")})`;
      }
      default: return null;
    }
  };
  const s = go(e);
  return s && s.length <= 40 ? s : null;
}

// Why a reference into `root` cannot outlive the function, judged from what `root` is:
// a local or by-value parameter is dropped at the return; a `&` parameter or a global
// outlives the call, but nothing at the call site keeps it alive and unmoved while the
// result is in use (only a method's receiver is frozen there).
export function danglingRoot(c: TypeChecker, root: string, fn: Function): { what: "local" | "param" | "refParam" | "global"; span?: Span } {
  const info = c.lookup(root);
  const param = fn.params.find(p => p.name === root);
  // Span identity, not the name: a `let` may shadow the parameter.
  if (param && info && info.span === param.span) return { what: info.type.tag === "ref" ? "refParam" : "param", span: param.span };
  if (info?.isGlobal) return { what: "global", span: info.span };
  return { what: "local", span: info?.span };
}

export function checkViewProvenance(c: TypeChecker, value: Expr, sp: Span | undefined, ret: TypeKind) {
  // Every place the returned slice could point into must be the receiver's own
  // storage: a fork returns one of several, and one bad arm is enough to dangle.
  const places = c.placesOf(value);
  const offending = places.find(p => p.tag === "path" && p.root !== "self");
  if (!offending || offending.tag !== "path" || !c.currentFnDecl) return; // all self, or no named place
  const fn = c.currentFnDecl;
  const name = c.shownFnName(fn);
  const root = offending.root;
  const kind = c.returnedRefKind(value, ret);
  const isMethod = c.hasSelfReceiver(fn);
  const { what, span: rootSpan } = c.danglingRoot(root, fn);
  const text = c.shortExprText(value);
  const sig = `fn ${name}(${fn.params.length > 0 ? "..." : ""}): ${c.ownedReturnType(ret)}`;
  const owned = text ? `return an owned copy ('${sig}' with '${text}.clone()')` : `return an owned copy ('${sig}', cloning the returned value)`;
  const inCaller = kind === "slice" ? "take the slice in the caller" : "borrow it in the caller";
  // The receiver rule is only news to someone writing a method or reaching for a
  // parameter; for a slice of a local the fix is just the owned copy.
  const receiverRule = isMethod
    ? `; a method may only return a ${kind} of its own receiver ('self...')`
    : (what === "param" || what === "refParam") && c.isViewReturn(ret) ? `, or make '${name}' a method and return a slice of 'self'` : "";
  const hint = `${owned}, or ${inCaller}${receiverRule}`;

  // A free function's reference return already got "cannot return a reference" on its
  // signature; this return is the same mistake, so it is a note on that error, and the
  // first such note replaces the signature's generic hint with a fix for this expression.
  const sigError = c.refReturnDiags.get(fn);
  if (sigError) {
    const outlives = isMethod
      ? `but a method may only return a slice ('&string' or '&[T]') of its own receiver`
      : `but a free function cannot return a reference at all: only a method can, and only a slice of its own receiver`;
    const reason =
      what === "local" ? `the returned ${kind} points into '${root}', which is freed when '${name}' returns`
      : what === "param" ? `the returned ${kind} points into '${root}', a parameter dropped when '${name}' returns`
      : `the returned ${kind} borrows from ${what === "global" ? "global" : "parameter"} '${root}', ${outlives}`;
    if (!sigError.notes?.length) sigError.hint = hint;
    (sigError.notes ??= []).push({ message: reason, span: value.span ?? sp });
    return;
  }
  const reason =
    what === "local" ? `'${root}' is a local, freed when '${name}' returns`
    : what === "param" ? `'${root}' is a parameter dropped when '${name}' returns`
    : `the call site freezes only the receiver, so ${what === "global" ? "global" : "parameter"} '${root}' could be freed or reallocated while the ${kind} is alive`;
  // No span when the root is a method parameter: impl registration copies params
  // without one, and pointing the note back at the return would only repeat the caret.
  c.errorWithNotes(`'${name}' cannot return a ${kind} of '${root}'`, value.span ?? sp, hint,
    [{ message: reason, span: rootSpan }]);
}

export function errorIfRefReturn(c: TypeChecker, fn: Function, ret: TypeKind) {
  if (ret.tag !== "ref" && c.nestedRef(ret) && !c.refReturnReported.has(fn)) {
    // `Option<&[T]>` hands the slice back inside storage, where it outlives the freeze
    // the call site took for it: the second-class rule has to hold through a payload.
    c.refReturnReported.add(fn);
    const outer = ret.tag === "enum" ? (c.enums.get(ret.name)?.baseName ?? ret.name) : typeName(ret);
    c.error(`'${c.shownFnName(fn)}' cannot return a reference stored inside '${outer}'`, fn.retType.span ?? fn.span,
      `references are second-class: return an owned value, or return the reference directly and let the caller match on emptiness another way`);
    return;
  }
  if (ret.tag !== "ref" || c.refReturnReported.has(fn)) return;
  if (c.isViewReturn(ret) && c.hasSelfReceiver(fn)) return;
  c.refReturnReported.add(fn);
  // Generic until a return statement is checked: checkViewProvenance swaps in a fix for
  // the actual returned expression.
  c.refReturnDiags.set(fn, c.errorWithNotes(`'${c.shownFnName(fn)}' cannot return a reference`, fn.retType.span ?? fn.span,
    c.isViewReturn(ret)
      ? `return an owned value ('${c.ownedReturnType(ret)}'), or take the slice in the caller; only a method can return a slice, and only of its own receiver`
      : `references are second-class: return an owned value ('${c.ownedReturnType(ret)}') instead`, []));
}

// Does this body unconditionally exit (return/break/continue) on every path?
// Syntactic, for the unreachable-code diagnostic and the let-else "must diverge" rule.
// Move tracking does not use it: it follows `this.reachable`, which also knows `exit`.
export function bodyAlwaysReturns(c: TypeChecker, body: Stmt[]): boolean {
  for (const s of body) {
    if (s.kind === "Return") return true;
    if (s.kind === "BreakStmt" || s.kind === "ContinueStmt") return true;
    if (s.kind === "IfStmt" && s.elseBody && c.bodyAlwaysReturns(s.thenBody) && c.bodyAlwaysReturns(s.elseBody)) return true;
    if (s.kind === "MatchStmt") {
      // exhaustive matches where every arm always returns
      let allReturn = true;
      for (const arm of s.arms) {
        if (!c.bodyAlwaysReturns(arm.body)) { allReturn = false; break; }
      }
      if (allReturn && s.arms.length > 0) return true;
    }
  }
  return false;
}

export function lintUncheckedFfiContract(c: TypeChecker, fn: Function) {
  const requires = (fn.contracts ?? []).filter(ch => ch.kind === "requires");
  if (requires.length === 0 || !c.bodyEntersUnsafe(fn.body)) return;
  // Once per source function: a generic is checked per instantiation.
  const key = `${fn.span?.file}:${fn.span?.line}:${fn.span?.col}`;
  if (c.ffiContractReported.has(key)) return;
  c.ffiContractReported.add(key);
  const params = new Set(fn.params.map(p => p.name));
  const guards: Set<string>[] = [];
  c.collectGuardNames(fn.body, params, guards);
  for (const ch of requires) {
    const names = new Set<string>();
    c.collectIdents(ch.expr, params, names);
    if (names.size === 0) continue;
    if (guards.some(g => [...names].every(n => g.has(n)))) continue;
    const shown = fn.sourceName ?? fn.name.slice(fn.name.lastIndexOf("$") + 1);
    c.warn("unchecked-ffi-contract",
      `'${shown}' enters 'unsafe' with only 'requires' guarding ${[...names].map(n => `'${n}'`).join(", ")}`,
      ch.expr.span ?? fn.span,
      `a contract is checked at --debug and dropped at -O2, so this is the last guard before C. Check it in the body too (return an Err, or assert) or pass --allow=unchecked-ffi-contract`);
  }
}

export function bodyEntersUnsafe(c: TypeChecker, node: unknown): boolean {
  if (Array.isArray(node)) return node.some(n => c.bodyEntersUnsafe(n));
  if (node === null || typeof node !== "object") return false;
  const kind = (node as { kind?: string }).kind;
  if (kind === "UnsafeBlock") return true;
  if (kind === "Closure") return false;
  return Object.values(node).some(v => c.bodyEntersUnsafe(v));
}

// Every `if` condition, `assert` argument and let-else in the body, as the set of
// parameter names it mentions.
export function collectGuardNames(c: TypeChecker, node: unknown, params: Set<string>, out: Set<string>[]) {
  if (Array.isArray(node)) { for (const n of node) c.collectGuardNames(n, params, out); return; }
  if (node === null || typeof node !== "object") return;
  const n = node as { kind?: string; cond?: Expr; func?: string; args?: Expr[] };
  if ((n.kind === "IfStmt" || n.kind === "WhileStmt") && n.cond) {
    const names = new Set<string>(); c.collectIdents(n.cond, params, names); if (names.size) out.push(names);
  }
  if (n.kind === "Call" && n.func === "assert" && n.args?.[0]) {
    const names = new Set<string>(); c.collectIdents(n.args[0], params, names); if (names.size) out.push(names);
  }
  for (const v of Object.values(node)) c.collectGuardNames(v, params, out);
}

export function collectIdents(c: TypeChecker, node: unknown, params: Set<string>, out: Set<string>) {
  if (Array.isArray(node)) { for (const n of node) c.collectIdents(n, params, out); return; }
  if (node === null || typeof node !== "object") return;
  const n = node as { kind?: string; name?: string };
  if (n.kind === "Ident" && n.name && params.has(n.name)) out.add(n.name);
  for (const v of Object.values(node)) c.collectIdents(v, params, out);
}

// Does control ever fall off the end of a function body? Stricter shapes than
// bodyAlwaysReturns, which also feeds the unreachable scan:
// adding `while true` there would make the `return 0` that most servers keep after
// their accept loop an "unreachable code" error, so this predicate is only asked
// at a fn or closure end. Codegen has no answer for a non-void fn that falls off:
// an `i32` fn silently returned 0, a closure returned a zero of its type (a null
// string pointer), and anything else was an LLVM "block must end with a terminator".
export function bodyNeverFallsOff(c: TypeChecker, body: Stmt[]): boolean {
  for (const s of body) {
    switch (s.kind) {
      case "Return": case "BreakStmt": case "ContinueStmt": return true;
      case "ExprStmt":
        // `todo()` aborts, so a body that is only a todo returns on every path.
        { const e = rewritten(c.rewrites, s.expr); if (e.kind === "Call" && e.func === "todo") return true; }
        break;
      case "IfStmt": case "IfLetStmt": case "IfChainStmt":
        if (s.elseBody && c.bodyNeverFallsOff(s.thenBody) && c.bodyNeverFallsOff(s.elseBody)) return true;
        break;
      case "MatchStmt":
        // A match already reported as non-exhaustive counts as diverging: the
        // uncovered variant IS the falling-off path, and that error names it.
        if (s.arms.length > 0 && (c.nonExhaustiveMatches.has(s.arms) || s.arms.every(a => c.bodyNeverFallsOff(a.body)))) return true;
        break;
      case "UnsafeBlock":
        if (c.bodyNeverFallsOff(s.body)) return true;
        break;
      case "WhileStmt":
        // `while true` leaves only through a `break` aimed at it (or a return).
        if (s.cond.kind === "BoolLit" && s.cond.value && !c.bodyBreaksOut(s.body)) return true;
        break;
      default:
        // let/var/assign/expr/for-in/let-else: control always continues past them.
        break;
    }
  }
  return false;
}

// Is there a `break` in this loop body that targets THIS loop? Structural over every
// node, because a `break` can sit in expression position too (a `match` or `if` arm
// used as a value); nested loops own their breaks and a closure body is another fn.
export function bodyBreaksOut(c: TypeChecker, node: unknown): boolean {
  if (Array.isArray(node)) return node.some(n => c.bodyBreaksOut(n));
  if (node === null || typeof node !== "object") return false;
  const kind = (node as { kind?: string }).kind;
  if (kind === "BreakStmt") return true;
  if (kind === "WhileStmt" || kind === "ForInStmt" || kind === "Closure") return false;
  return Object.values(node).some(v => c.bodyBreaksOut(v));
}

export function errorIfFallsOff(c: TypeChecker, what: string, body: Stmt[], retType: TypeKind, span?: Span) {
  if (retType.tag === "void" || retType.tag === "unknown") return;
  if (c.bodyNeverFallsOff(body)) return;
  const key = `${span?.file}:${span?.line}:${span?.col}`;
  if (c.fallOffReported.has(key)) return;
  c.fallOffReported.add(key);
  c.error(`${what} returns ${c.show(retType)} but can reach the end of its body without a 'return'`, span,
    `every path must end in 'return <value>' (or an if/else, match, or 'while true' whose every exit returns)`);
}

// A statement following one that always exits can never run. It has to be an error
// here rather than dead weight in codegen: emitting it appends instructions to an
// already-terminated LLVM block, which clang rejects outright.
//
// The walk is structural — any array of Stmt nodes, wherever it sits — instead of a
// hand-written per-node visitor. Statement lists hide inside expressions too (closure
// bodies, `if`/`match` in value position), and a visitor that misses one silently
// reopens the hole for that shape.
export function scanUnreachable(c: TypeChecker, node: unknown) {
  if (Array.isArray(node)) {
    if (node.length > 1 && node.every(n => n !== null && typeof n === "object" && TypeChecker.STMT_KINDS.has(rewritten(c.rewrites, n).kind))) {
      const stmts = node as Stmt[];
      for (let i = 0; i + 1 < stmts.length; i++) {
        const stmt = stmts[i]!;
        if (stmt.kind === "MatchStmt" && c.nonExhaustiveMatches.has(stmt.arms)) continue;
        if (!c.bodyAlwaysReturns([stmt])) continue;
        // One report per block: everything after the first dead statement is dead too.
        c.error("unreachable code", stmts[i + 1]!.span,
          "the statement above always exits, so nothing after it in this block can run");
        break;
      }
    }
    for (const child of node) c.scanUnreachable(child);
    return;
  }
  if (node !== null && typeof node === "object") {
    // A pattern the checker replaced is walked through its replacement too.
    const cur = c.rewrittenPat(rewritten(c.rewrites, node as Expr) as unknown as Pattern);
    for (const value of Object.values(cur)) c.scanUnreachable(value);
  }
}

export function isAllCopyEnum(c: TypeChecker, name: string): boolean {
  // Before the cache, as in isAllCopyStruct: Drop impls register after the first
  // copy-ness query may have cached `true`, and a Drop type is never Copy.
  if (c.dropImpls.has(name)) return false;
  const cached = c.allCopyEnumCache.get(name);
  if (cached !== undefined) return cached;
  const info = c.enums.get(name);
  if (!info) { c.allCopyEnumCache.set(name, false); return false; }
  // A raw pointer payload makes the enum move-tracked unless `@copy`, as a pointer
  // field does a struct (see isAllCopyStruct).
  if (info.pointerVariant) { c.allCopyEnumCache.set(name, false); return false; }
  c.allCopyEnumCache.set(name, false);
  const result = [...info.variants.values()].every(v =>
    v.fields.every(f => c.isCopyType(f))
  );
  c.allCopyEnumCache.set(name, result);
  return result;
}

export function isAllCopyStruct(c: TypeChecker, name: string): boolean {
  // Checked before the cache: Drop impls are registered while checking impl
  // blocks, which can be after a first copy-ness query has already cached
  // `true` for this struct.
  //
  // A type with a Drop impl is never Copy, however plain its fields are.
  // Treating it as Copy meant passing it recorded no move, so the source kept
  // its drop glue and the value was dropped once per copy — TcpStream and
  // TlsStream are exactly this shape (integer fds + a Drop that closes them),
  // so an accepted connection could be closed while still in use.
  if (c.dropImpls.has(name)) return false;
  const cached = c.allCopyCache.get(name);
  if (cached !== undefined) return cached;
  const info = c.structs.get(name);
  if (!info) { c.allCopyCache.set(name, false); return false; }
  // `@noCopy`. A resource handle is an integer — a GL texture name, an fd, an index
  // into someone else's table — so the all-fields-Copy rule above says it is Copy, and
  // move checking never engages for exactly the type most likely to be used after it is
  // released. Drop already forces non-Copy, but a handle whose cleanup has an ordering
  // requirement the compiler can't see (glDeleteTextures needs the context still
  // current) can't take a Drop. This is that case: move-tracked, no destructor.
  if (info.noCopy) { c.allCopyCache.set(name, false); return false; }
  // A raw pointer is Copy as a scalar, so a struct of pointers used to be Copy too, and
  // every owning handle (`Database`, `Lib`, a GL window) was silently duplicable unless
  // its author remembered `@noCopy`. The default is now the safe one: a pointer field
  // makes the struct move-tracked, and `@copy` is the explicit claim that the struct
  // does not own the pointee (a C record, a view into someone else's buffer).
  if (info.pointerField) { c.allCopyCache.set(name, false); return false; }
  // guard against cycles
  c.allCopyCache.set(name, false);
  const result = info.fields.every(f =>
    c.isCopyType(f.type)
  );
  c.allCopyCache.set(name, result);
  return result;
}
