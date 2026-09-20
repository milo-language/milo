// Whole-program passes that run after every function body is checked and read only the
// recorded results: escaping closures, `@pure`, the thread boundary, and global borrow
// invalidation. They need the finished call-resolution maps and the full set of
// monomorphized instances, which is why they cannot run per function, and they reach
// the checker only through `ProgramPassHost` (its recorded maps and diagnostics) plus
// the `ProgramView` it builds once for all of them (design pass 2026-09, F5).
import type { Program, Function, Stmt, Expr, Span } from "./ast";
import type { TypeKind } from "./types";
import type { CaptureInfo, FnSig } from "./checker";
import { RETAINING_MEMBERS, MUTATING_COLLECTION_METHODS } from "./builtin-members";

// What a whole-program pass may ask of the finished program. Built once by
// `TypeChecker.programView` after every body is checked; see that method for why.
export interface ProgramView {
  // Every function with a body the passes can walk, by mangled name: free fns plus the
  // monomorphized instances (impl methods, generic instantiations).
  fns: Map<string, Function>;
  // The mangled callee a Call / EnumLit / MethodCall resolved to, or the bare name for a
  // Call nothing rewrote. Undefined for enum construction and for calls through values.
  calleeOf(e: Expr): string | undefined;
  // The binding a place expression roots at (`G`, `G.f`, `G[i]`, `G!.f` all give `G`),
  // or undefined for a non-expression or a place with no single named root.
  rootOf(e: unknown): string | undefined;
  // A mangled name as the user wrote it, for diagnostics.
  pretty(name: string): string;
}

// The slice of the checker these passes read. Every member is a per-body result that is
// complete by the time `checkProgram` runs them; the passes write nothing back except
// diagnostics. Measured, not designed: it is exactly the set the five methods used when
// they lived in `TypeChecker`, and `checkProgram` hands over the checker itself.
export interface ProgramPassHost {
  exprTypes: Map<Expr, TypeKind>;
  functions: Map<string, FnSig>;
  monomorphizedFns: Function[];
  closureCaptures: Map<Expr, CaptureInfo[]>;
  // The call-resolution maps, keyed by disjoint node kinds (see `programView`). The
  // passes read them directly where they need one specific map rather than the union.
  rewrittenCalls: Map<Expr, string>;
  staticCalls: Map<Expr, string>;
  resolvedMethods: Map<Expr, string>;
  // The four "call through a value" classifications `@pure` and the thread boundary
  // treat as opaque.
  closureCalls: Map<Expr, TypeKind>;
  cfnCalls: Map<Expr, TypeKind>;
  fnFieldCalls: Set<Expr>;
  cfnFieldCalls: Set<Expr>;
  interfaceMethodCalls: Map<Expr, { ifaceName: string; methodName: string; methodIndex: number }>;
  error(msg: string, span?: Span, hint?: string): void;
  warn(code: string, msg: string, span?: Span, hint?: string, len?: number): void;
  show(t: TypeKind): string;
  isSend(ty: TypeKind): boolean;
  whyNotSend(ty: TypeKind): string;
  pointerViewsIn(e: Expr): { source: Expr; call: string; line: number }[];
}


// ── @pure ──────────────────────────────────────────────────────────────────────
//
// `@pure` narrows a function's effects to the ones its signature already shows: it
// reads and writes its parameters and its own locals, and nothing else. It is not a
// totality claim — a pure function can still trap (overflow, bounds, a failed
// contract) or loop forever, the same way a bounds check can. What it rules out is
// *ambient* effect: I/O, mutable module state, raw memory, and any call that could
// reach one of those.
//
// Run as a post-pass rather than inside type checking because it needs the finished
// call-resolution maps (`staticCalls`, `resolvedMethods`, the monomorphized
// instances) to know what a given call site actually targets.

// Built-in free functions with no ambient effect. An allowlist, not a denylist: a new
// intrinsic has to be judged pure deliberately rather than inheriting it by default.
// `assert` is here because trapping is not an effect under this definition.
const PURE_BUILTINS = new Set(["format", "max", "min", "assert"]);

// Does `fnName` KEEP its idx-th argument past the call? A fn-typed parameter that is
// only ever CALLED is consumed during the call and is safe to hand a borrowing closure;
// one that is stored, returned, or forwarded to something that stores it is not. The
// distinction falls out of the AST for free: `g(1)` parses as `Call{func:"g"}` and
// contributes no `Ident` node at all, so "appears as an Ident anywhere in the body" is
// exactly "used as a value rather than called".
//
// This is the *property* the `sortByKey` carve-out approximates with a name (see
// `keyExtractorDepth`) — computed here instead of annotated, which is why a user's own
// non-retaining combinator gets the same treatment std's does.
//
// Every unknown answers YES: no body, an extern, a variadic slot past the declared
// params, or a cycle in the forwarding graph. A wrong NO is a use-after-free.
function retainsParam(host: ProgramPassHost, fns: Map<string, Function>, fnName: string, idx: number, seen: Set<string>): boolean {
  const key = `${fnName}#${idx}`;
  if (seen.has(key)) return true;
  seen.add(key);
  const fn = fns.get(fnName);
  if (!fn || fn.isExtern || !fn.body) return true;
  const param = fn.params[idx];
  if (!param) return true;
  let retained = false;
  const walk = (node: unknown): void => {
    if (retained || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    const n = node as Record<string, unknown> & { kind?: string };
    if (n.kind === "Ident" && n.name === param.name) { retained = true; return; }
    // A closure that CAPTURES the parameter keeps it, and the walk above cannot see
    // that: the body spells the use `f(3)`, a `Call` with a string callee and no `Ident`
    // node anywhere. So `fn wrap(f) { return move (): i64 => f(3) }` answered "not
    // retained", the call site handed it a borrowing closure, and the returned `move`
    // closure carried a pointer into the dead frame — printed -1 for 8.
    if (n.kind === "Closure") {
      const caps = host.closureCaptures.get(n as unknown as Expr);
      if (caps?.some(c => c.name === param.name)) { retained = true; return; }
    }
    // Forwarding: `fn outer(g) { each(g) }` keeps `g` only if `each` does. Without this
    // a one-line wrapper would be indistinguishable from a store.
    if (n.kind === "Call" && Array.isArray(n.args)) {
      const args = n.args as Expr[];
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.kind === "Ident" && a.name === param.name) {
          if (retainsParam(host, fns, n.func as string, i, seen)) { retained = true; return; }
        } else walk(a);
      }
      return;
    }
    // The same forwarding through a METHOD call. Without this arm a MethodCall fell to
    // the structural walk below, which saw the bare `Ident` and marked the parameter
    // retained — so `fn w(f) { a.modify(h, f) }` was rejected while the identical
    // `fn w(f) { arenaModify(a, h, f) }` was accepted. That is over-rejection, not
    // unsoundness, but it walls off every wrapper around a std higher-order method.
    if (n.kind === "MethodCall" && Array.isArray(n.args)) {
      const args = n.args as Expr[];
      walk(n.object);
      // The builtins that store a fn value, the same set the call-site check reads.
      const storesIt = RETAINING_MEMBERS.has(n.method as string);
      const recv = host.exprTypes.get(n.object as Expr);
      const base = recv?.tag === "ref" ? recv.inner : recv;
      const owner = base && (base.tag === "struct" || base.tag === "enum") ? base.name : null;
      const mangled = owner ? `${owner}$${n.method}` : null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.kind === "Ident" && a.name === param.name) {
          if (storesIt) { retained = true; return; }
          // +1: the mangled method carries `self` as its first parameter.
          if (mangled && fns.has(mangled) && retainsParam(host, fns, mangled, i + 1, seen)) { retained = true; return; }
          // An unresolved receiver is waved through on the same reasoning the call
          // site uses: no builtin outside the `retainsArg` rows retains a fn value.
        } else walk(a);
      }
      return;
    }
    for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") walk(n[k]); }
  };
  walk(fn.body);
  return retained;
}

// A closure that captures by reference is a pointer into the frame it was written in.
// It is safe to CALL and unsafe to KEEP, so this pass rejects every route by which one
// can outlive that frame. All five were live use-after-frees in safe code — silent
// garbage at -O0, a hang or a SIGKILL at -O2, and invisible to ASan because the capture
// lives on the stack:
//
//     Box { f: g }         store into an aggregate       (closed 2026-07-31)
//     b.f = g              assign into a place
//     wrap(g)              hand to a fn that keeps it
//     wrap((x) => x + n)   the same, when the capture is a `var` — the call-site
//                          auto-`move` declines there because move-capturing would
//                          drop the write-back, so the literal escaped unpromoted
//     return g             hand to the caller
//
// The last one used to be PROMOTED rather than rejected: the Return path flipped the
// closure to `move` so its captures became heap-owned. That was unsound in a way the
// reject is not, because the promotion happened at the `return` — after the move
// checker had already walked the body. `let s = "…"; let f = () => s.len(); print(s);
// return f` moved `s` into the closure's env at the LITERAL and printed an empty line
// for `print(s)`, with no diagnostic. Rejecting needs no such retroactive edit.
//
// Rejecting needs no escape analysis either, which is the point: we cannot tell whether
// an aggregate escapes, so we assume it does. `move` is the escape hatch — it works
// even for a `var` capture, at the cost of dropping the write-back — and it is what
// every diagnostic here names.

export function checkEscapingClosures(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const seen = new Set<string>();
  const { fns } = view;
  const globals = new Set(program.globals.map(g => g.name));
  // Approximate scoping on purpose: one flat map per body, so a closure bound by
  // `let f = …` is still recognized when `f` is stored later. Shadowing can only make
  // this reject something it would otherwise allow, never the reverse.
  // Which frame-pointing captures does escaping `c` expose? For a borrowing closure that
  // is its own capture list. For a `move` closure it is normally EMPTY — owning the
  // captures is the whole point — but not when a capture is itself a borrowing closure:
  // moving a `{fn, env}` pair copies the pointer, and the env keeps pointing at the frame
  // the inner closure was written in. `let f = (x) => x + n; return move () => f(3)`
  // printed -1 for 8 through exactly that hole, so resolve through move captures until we
  // reach a borrowing closure or run out of bindings. A capture we cannot resolve here is
  // a fn-typed *parameter*; those are caught one frame up by `retainsParam`, which counts
  // a capture as retention.
  const borrowedCaps = (c: Expr, bound: Map<string, Expr>, visited: Set<Expr>): CaptureInfo[] => {
    if (visited.has(c)) return [];
    visited.add(c);
    const caps = host.closureCaptures.get(c) ?? [];
    if (!(c as Extract<Expr, { kind: "Closure" }>).isMove) return caps;
    const out: CaptureInfo[] = [];
    for (const cap of caps) {
      const inner = bound.get(cap.name);
      if (inner) out.push(...borrowedCaps(inner, bound, visited));
    }
    return out;
  };
  const check = (value: Expr, bound: Map<string, Expr>, message: (names: string) => string, holder: string) => {
    let c: Expr | null = null;
    if (value.kind === "Closure") c = value;
    else if (value.kind === "Ident") c = bound.get(value.name) ?? null;
    if (!c) return;
    const caps = borrowedCaps(c, bound, new Set());
    if (caps.length === 0) return;
    const span = value.span ?? c.span;
    const key = `${span?.line ?? 0}:${span?.col ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    const names = caps.map(c => `'${c.name}'`).join(", ");
    const hint = (c as Extract<Expr, { kind: "Closure" }>).isMove
      ? `this closure is 'move', but it captures another closure that points at locals in the current frame — 'move' on the outer one copies that pointer, it does not own what it points at. Write the inner closure 'move (…) => …' too`
      : `this closure points at locals in the current frame, and ${holder} can outlive them — write 'move (…) => …' so the closure owns its captures instead`;
    host.error(message(names), span, hint);
  };
  const cannotStore = (names: string) => `cannot store a closure that captures ${names} by reference`;
  // Structural walk rather than a per-node switch: a missing arm here would silently
  // skip a whole subtree, which is exactly the class of bug this pass exists to close.
  const visit = (node: unknown, bound: Map<string, Expr>) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) visit(n, bound); return; }
    const n = node as Record<string, unknown> & { kind?: string };
    switch (n.kind) {
      case "LetDecl": case "VarDecl": {
        const v = n.value as Expr | undefined;
        if (v?.kind === "Closure") bound.set(n.name as string, v);
        // `let g = f` aliases the same closure. Without this the alias launders a
        // borrowing closure past every check below — `let g = f; return g` printed
        // garbage for exactly that reason.
        else if (v?.kind === "Ident" && bound.has(v.name)) bound.set(n.name as string, bound.get(v.name)!);
        break;
      }
      case "StructLit":
        for (const f of n.fields as { name: string; value: Expr }[]) check(f.value, bound, cannotStore, "the struct holding it");
        break;
      case "ArrayLit":
        for (const el of n.elements as Expr[]) check(el, bound, cannotStore, "the array holding it");
        break;
      case "ArrayRepeat":
        check(n.value as Expr, bound, cannotStore, "the array holding it");
        break;
      case "Return":
        if (n.value) check(n.value as Expr, bound,
          names => `cannot return a closure that captures ${names} by reference`, "the caller");
        break;
      case "Assign": {
        // Assigning to a bare local is fine — the local dies with the same frame the
        // captures live in. A field, an element, or a global is a place that outlives it.
        const t = n.target as Expr;
        const where = t.kind === "FieldAccess" ? "the struct holding it"
          : t.kind === "IndexAccess" ? "the collection holding it"
          : t.kind === "Ident" && globals.has(t.name) ? "a global"
          : null;
        if (where) check(n.value as Expr, bound, cannotStore, where);
        break;
      }
      case "Call": {
        const args = n.args as Expr[];
        for (let i = 0; i < args.length; i++) {
          if (!retainsParam(host, fns, n.func as string, i, new Set())) continue;
          check(args[i]!, bound, names => `cannot pass a closure that captures ${names} by reference to '${n.func}', which keeps it`,
            `'${n.func}'`);
        }
        break;
      }
      case "EnumLit": {
        // `Promise.blocking(...)`, `Task.spawn(...)`, and every other `Type.method(...)`
        // parse as EnumLit, not Call/MethodCall, so the two arms below never saw them and
        // a borrowing closure crossed a real OS thread as a raw pointer into the frame
        // that wrote it. `var n = 41; Promise.blocking(() => { n = n + 1; return n })`
        // returned 8421921353 from a dead stack.
        const args = n.args as Expr[];
        if (args.length === 0) break;
        const who = `${n.enumName}.${n.variant}`;
        const mangled = host.staticCalls.get(node as Expr);
        for (let i = 0; i < args.length; i++) {
          // No resolved target means an enum VARIANT constructor (which stores its
          // payload) or a builtin: treated as retaining, on retainsParam's own rule that
          // every unknown answers YES because a wrong NO is a use-after-free. The only
          // args this can reject are closures, so fail-closed costs nothing else.
          if (mangled && fns.has(mangled) && !retainsParam(host, fns, mangled, i, new Set())) continue;
          check(args[i]!, bound, names => `cannot pass a closure that captures ${names} by reference to '${who}', which keeps it`,
            `'${who}'`);
        }
        break;
      }
      case "MethodCall": {
        // The collection-storing methods. A closure passed to `map`/`each`/`sortBy` is
        // called and dropped within the call, so those stay legal — that is the common
        // case and rejecting it would gut the combinators. No builtin outside the
        // `retainsArg` rows retains a fn value, which is what makes the unresolved case
        // below safe to wave through; a builtin that starts retaining one gets the flag.
        if (RETAINING_MEMBERS.has(n.method as string)) {
          for (const a of n.args as Expr[]) check(a, bound, cannotStore, "the collection holding it");
          break;
        }
        // A user-defined method resolves to the mangled `Type$method` and gets the same
        // retention analysis a free function does.
        const recv = host.exprTypes.get(n.object as Expr);
        const base = recv?.tag === "ref" ? recv.inner : recv;
        const owner = base && (base.tag === "struct" || base.tag === "enum") ? base.name : null;
        if (!owner) break;
        const mangled = `${owner}$${n.method}`;
        if (!fns.has(mangled)) break;
        const args = n.args as Expr[];
        for (let i = 0; i < args.length; i++) {
          // +1: the mangled method carries `self` as its first parameter.
          if (!retainsParam(host, fns, mangled, i + 1, new Set())) continue;
          check(args[i]!, bound, names => `cannot pass a closure that captures ${names} by reference to '${owner}.${n.method}', which keeps it`,
            `'${owner}.${n.method}'`);
        }
        break;
      }
      default:
        // Deliberately partial, and safe because of the line below: this switch only
        // ADDS knowledge for the few node kinds that can let a closure escape. Every
        // other kind is still descended into structurally, so nothing is skipped.
        break;
    }
    for (const k of Object.keys(n)) { if (k !== "span" && k !== "type") visit(n[k], bound); }
  };
  for (const fn of [...program.functions, ...host.monomorphizedFns]) {
    if (fn.isExtern || !fn.body) continue;
    visit(fn.body, new Map<string, Expr>());
  }
}

export function checkPurity(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const pureNames = new Set<string>();
  const bodies: Function[] = [];
  // A generic declaration is registered as pure but not walked — its instances are what
  // call sites resolved to, and they are the copies whose expressions carry resolution
  // data.
  for (const f of view.fns.values()) {
    if (!f.attributes?.some(a => a.name === "pure")) continue;
    pureNames.add(f.name);
    if (!f.isExtern && f.typeParams.length === 0) bodies.push(f);
  }
  if (bodies.length === 0) return;

  const mutableGlobals = new Set(program.globals.filter(g => g.mutable).map(g => g.name));
  // Every instance of a pure generic walks the same source span, so the same violation
  // would be reported once per instantiation.
  const seen = new Set<string>();
  const { pretty } = view;

  for (const fn of bodies) {
    const who = fn.sourceName ?? pretty(fn.name);
    const fail = (msg: string, span: Span | undefined, hint: string, key?: string) => {
      const k = key ?? `${span?.line ?? 0}:${span?.col ?? 0}:${msg}`;
      if (seen.has(k)) return;
      seen.add(k);
      host.error(msg, span, hint);
    };

    const checkCall = (target: string, span: Span | undefined) => {
      if (pureNames.has(target) || PURE_BUILTINS.has(target)) return;
      const sig = host.functions.get(target);
      if (!sig) {
        // No registered signature: a compiler builtin (`Vec.new`, `v.len()`). Those act
        // only on the data handed to them, so they are pure by construction — the ones
        // that are not (`print`, `exit`, the `_milo*`/`_atomic*` intrinsics) do have a
        // registered signature and fall through to the impure branch below.
        return;
      }
      if (sig.isExtern) {
        fail(`'${who}' is @pure but calls extern fn '${pretty(target)}'`, span,
          `an extern's body is compiled elsewhere, so nothing here can check it — write '@pure extern fn ${target}(...)' to assert it has no effects, or drop '@pure' from '${who}'`);
        return;
      }
      fail(`'${who}' is @pure but calls '${pretty(target)}', which is not`, span,
        `purity is transitive — mark '${pretty(target)}' '@pure' too, or drop '@pure' from '${who}'`);
    };

    const ex = (e: Expr | null | undefined, bound: Set<string>): void => {
      if (!e) return;
      switch (e.kind) {
        case "Ident":
          if (mutableGlobals.has(e.name) && !bound.has(e.name)) {
            // One report per global per function: `g = g + 1` is a read and a write of
            // the same mistake, and repeating it per mention buries the fix.
            fail(`'${who}' is @pure but touches the mutable global '${e.name}'`, e.span,
              `a @pure fn reads and writes only its parameters and its own locals — pass '${e.name}' in as a parameter, or make it a 'let'`,
              `${fn.name}|global|${e.name}`);
          }
          break;
        case "Call":
          // A call through a value (closure, fn-typed param, C function pointer) has no
          // static target, and purity is not part of a fn type yet.
          if (host.closureCalls.has(e) || host.cfnCalls.has(e)) {
            fail(`'${who}' is @pure but calls the function value '${e.func}'`, e.span,
              `purity is not part of a fn type, so the compiler cannot see what this call does — call a named @pure fn instead`);
          } else {
            checkCall(view.calleeOf(e) ?? e.func, e.span);
          }
          e.args.forEach(a => ex(a, bound));
          break;
        case "EnumLit": {
          // Static method calls (`Math.sqrt(x)`) parse as EnumLit and are resolved into
          // staticCalls; without an entry this is ordinary enum construction.
          const target = view.calleeOf(e);
          if (target) checkCall(target, e.span);
          e.args.forEach(a => ex(a, bound));
          break;
        }
        case "MethodCall": {
          const iface = host.interfaceMethodCalls.get(e);
          if (iface) {
            fail(`'${who}' is @pure but calls '${e.method}' through the interface '${iface.ifaceName}'`, e.span,
              `dynamic dispatch hides which body runs, and purity is not part of an interface method's signature`);
          } else if (host.fnFieldCalls.has(e) || host.cfnFieldCalls.has(e)) {
            fail(`'${who}' is @pure but calls the fn-typed field '${e.method}'`, e.span,
              `purity is not part of a fn type, so the compiler cannot see what this call does`);
          } else {
            const target = view.calleeOf(e);
            if (target) checkCall(target, e.span);
          }
          ex(e.object, bound);
          e.args.forEach(a => ex(a, bound));
          break;
        }
        case "BinOp": ex(e.left, bound); ex(e.right, bound); break;
        case "UnaryOp": ex(e.operand, bound); break;
        case "FieldAccess": ex(e.object, bound); break;
        case "IndexAccess": ex(e.object, bound); ex(e.index, bound); break;
        case "StructLit": e.fields.forEach(f => ex(f.value, bound)); break;
        case "ArrayLit": e.elements.forEach(el => ex(el, bound)); break;
        case "ArrayRepeat": ex(e.value, bound); break;
        case "Unwrap": case "Propagate": ex(e.operand, bound); break;
        case "DefaultValue": ex(e.operand, bound); ex(e.default, bound); break;
        case "CastExpr": ex(e.operand, bound); break;
        case "Closure": {
          // The body runs inside this fn, so its effects are this fn's effects.
          const inner = new Set(bound);
          for (const p of e.params) inner.add(p.name);
          st(e.body, inner);
          break;
        }
        case "RangeExpr": ex(e.start, bound); ex(e.end, bound); break;
        case "IsExpr": ex(e.operand, bound); break;
        case "IfExpr": ex(e.cond, bound); st(e.thenBody, new Set(bound)); st(e.elseBody, new Set(bound)); break;
        case "MatchExpr": ex(e.subject, bound); e.arms.forEach(a => st(a.body, bindPattern(a.pattern, bound))); break;
        case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
          break;
        default: {
          // A missing arm would silently skip a whole subtree — the same failure mode
          // that let the safety walker report "pass" on code it never looked at.
          const _exhaustive: never = e;
          void _exhaustive;
        }
      }
    };

    const bindPattern = (p: import("./ast").Pattern, bound: Set<string>): Set<string> => {
      const inner = new Set(bound);
      if (p.kind === "EnumPattern") for (const b of p.bindings) inner.add(b);
      return inner;
    };

    const st = (list: Stmt[], outer: Set<string>): void => {
      const bound = new Set(outer);
      for (const s of list) {
        switch (s.kind) {
          // Walk the initializer before binding the name: in `let x = x + 1` the
          // right-hand `x` is still whatever `x` meant outside.
          case "LetDecl": case "VarDecl": ex(s.value, bound); bound.add(s.name); break;
          case "Assign": ex(s.target, bound); ex(s.value, bound); break;
          case "Return": ex(s.value, bound); break;
          case "ExprStmt": ex(s.expr, bound); break;
          case "IfStmt": ex(s.cond, bound); st(s.thenBody, bound); if (s.elseBody) st(s.elseBody, bound); break;
          case "WhileStmt": ex(s.cond, bound); st(s.body, bound); break;
          case "ForInStmt": {
            ex(s.iterable, bound);
            const inner = new Set(bound);
            inner.add(s.varName);
            if (s.varName2) inner.add(s.varName2);
            st(s.body, inner);
            break;
          }
          case "MatchStmt": ex(s.subject, bound); s.arms.forEach(a => st(a.body, bindPattern(a.pattern, bound))); break;
          case "IfLetStmt":
            ex(s.subject, bound);
            st(s.thenBody, bindPattern(s.pattern, bound));
            if (s.elseBody) st(s.elseBody, bound);
            break;
          case "LetElseStmt":
            ex(s.value, bound);
            st(s.elseBody, bound);
            // The bind escapes into the enclosing scope — that is the point of let-else.
            if (s.pattern.kind === "EnumPattern") for (const b of s.pattern.bindings) bound.add(b);
            break;
          case "UnsafeBlock":
            fail(`'${who}' is @pure but contains an 'unsafe' block`, s.span,
              `raw memory access is exactly the ambient effect '@pure' rules out`);
            st(s.body, bound);
            break;
          case "BreakStmt": case "ContinueStmt": break;
          default: {
            const _exhaustive: never = s;
            void _exhaustive;
          }
        }
      }
    };

    st(fn.body, new Set(fn.params.map(p => p.name)));
  }
}

// Which functions hand a closure to a real OS thread? They say so themselves, with
// `@thread` on the declaration in std. The two hardcoded copies this replaces had
// already drifted apart: the `Thread` tier was deleted and its arm stayed behind
// guarding a type that no longer exists, while `spawnOsThreadDetached` — added after
// both — never got an arm, so the *same* fixture that errors on `Promise.blocking`
// compiled clean and shipped a pointer into a dead frame to another thread. A list the
// declarations own cannot drift from the declarations.
export function checkThreadBoundary(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const { fns, rootOf, calleeOf: target } = view;
  const isEntry = (target: string | undefined) =>
    !!target && !!fns.get(target)?.attributes?.some(a => a.name === "thread");
  if (![...fns.values()].some(f => f.attributes?.some(a => a.name === "thread"))) return;

  // A `var` global is unsynchronized shared memory, and `Sync` is the wrong question to
  // ask about it: `i64` is perfectly Sync — sharing `&i64` is safe — while the hazard
  // here is the *write*, which Sync says nothing about. The synchronized way to hold
  // shared mutable state is already a `let` global of a cell that mutates through
  // `&self` (AtomicI64, Channel, Once), so `var` plus a thread is always the bug, and
  // the optimizer makes it worse than it looks: a whole loop of `g = g + 1` gets hoisted
  // into a single load/store pair, losing every update but the last rather than a few.
  const mutableGlobals = new Set<string>();
  for (const g of program.globals) if (g.mutable && !g.threadLocal) mutableGlobals.add(g.name);
  // `@synchronized` marks a method whose closure argument is a critical section — the
  // primitive itself provides the mutual exclusion and the happens-before edge, so a
  // global written in there is not racing. Without this the canonical `Once.run(...)`
  // one-shot-init pattern reports as a race, which is the reverse of the truth: it is
  // the *fix* for one. The scan below stops at the boundary rather than reasoning about
  // the primitive, so a new one only has to declare itself.
  const isCriticalSection = (target: string | undefined) =>
    !!target && !!fns.get(target)?.attributes?.some(a => a.name === "synchronized");

  const reported = new Set<string>();

  // Reports every unsynchronized global reachable from `closure`, following static calls
  // so a touch three helpers deep still names the thread it escaped to. Approximate
  // scoping on purpose, same as checkEscapingClosures: one flat bound-name set per body,
  // which can only make this miss a shadowed global, never invent one.

  // Two phases over one reachable set, because reads and writes are not equally guilty.
  // A *write* reached without crossing a critical section races on its own. A *read*
  // only races if some write is also unsynchronized: `Once.run` publishes `gValue`, and
  // every later read of it is ordered by that publication, so flagging the read would
  // reject the very pattern that fixes the race.
  type Touch = { name: string; span: Span | undefined; chain: string[]; write: boolean };
  const scan = (closure: Expr, entry: string) => {
    const touches: Touch[] = [];
    const done = new Set<string>();
    const walk = (node: unknown, bound: Set<string>, chain: string[]) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n, bound, chain); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: unknown; span?: unknown };
      const span = (n.span as Span | undefined) ?? closure.span;
      if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);

      const hit = (name: string | undefined, write: boolean) => {
        if (!name || !mutableGlobals.has(name) || bound.has(name)) return;
        touches.push({ name, span, chain, write });
      };
      if (n.kind === "Assign") hit(rootOf(n.target), true);
      // `G.push(x)` is a write that never appears as an Assign. A `&self` method is not
      // — `gOnce.run(...)` is the Once synchronizing itself, and `Sync` is the wrong
      // question to ask here anyway: `Vec<i64>` is perfectly Sync and `push` still
      // reallocs it.
      if (n.kind === "MethodCall") hit(rootOf(n.object), mutatesReceiver(host, n as unknown as Expr));
      if (n.kind === "Ident" && typeof n.name === "string") hit(n.name, false);

      // A call through a value (closure, fn-typed param, C function pointer) has no static
      // target, so the walk cannot see whether it touches a global: the check below is
      // incomplete exactly here. The @pure walker errors in this situation, but doing that
      // rejected `rg.milo` and the Once fixture (a callback that touches nothing), so this
      // is an off-by-default warning until fn values with a statically known target are
      // resolved through. Skipped entirely when the program has no mutable globals, since
      // then an opaque call cannot reach one.
      if (mutableGlobals.size > 0 && n.kind === "Call"
          && (host.closureCalls.has(n as unknown as Expr) || host.cfnCalls.has(n as unknown as Expr))) {
        const key = `${entry}|indirect|${span?.line ?? 0}:${span?.col ?? 0}`;
        if (!reported.has(key)) {
          reported.add(key);
          host.warn("opaque-call-on-thread",
            `cannot tell whether this call touches a mutable global, and it runs on a real OS thread`,
            span,
            `a call through a function value has no static target, so nothing here can see what it does. ` +
            `Call a named function instead, or make the globals it may touch atomics from 'std/sync'`,
          );
        }
      }
      if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
        const t = target(n as unknown as Expr);
        if (isCriticalSection(t)) {
          // Stop at the boundary: everything the closure argument does is serialized by
          // the primitive. Its receiver and non-closure args are still ordinary code.
          for (const k of Object.keys(n)) {
            if (k === "span" || k === "args") continue;
            walk(n[k], bound, chain);
          }
          for (const a of (n.args as Expr[] | undefined) ?? []) if (a.kind !== "Closure") walk(a, bound, chain);
          return;
        }
        if (t && !done.has(t)) {
          done.add(t);
          const f = fns.get(t);
          if (f && !f.isExtern && f.body) walk(f.body, new Set(f.params.map(p => p.name)), [...chain, t]);
        }
      }
      // A nested closure body runs on the same thread, so the generic descent walks in.
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k], bound, chain);
    };
    walk((closure as Extract<Expr, { kind: "Closure" }>).body, new Set(), []);

    const racy = new Set(touches.filter(t => t.write).map(t => t.name));
    for (const t of touches) {
      if (!racy.has(t.name)) continue;
      // One report per global per thread entry: `g = g + 1` is a read and a write of
      // the same mistake, and repeating it per mention buries the fix.
      const key = `${entry}|${t.name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const where = t.chain.length ? ` (via ${t.chain.map(c => `'${c.replace(/\$/g, ".")}'`).join(" → ")})` : "";
      host.error(
        `'${t.name}' is a mutable global, and this code runs on a real OS thread${where}`,
        t.span,
        `two threads touching one unsynchronized global is a data race — make '${t.name}' an ` +
        `atomic from 'std/sync' (AtomicI64/AtomicBool/AtomicI32/AtomicU64), do the mutation inside ` +
        `'Once.run', or write 'thread_local var ${t.name}' if each thread should get its own copy`,
      );
    }
  };


  const atEntry = (call: Expr, entry: string) => {
    for (const arg of (call as { args?: Expr[] }).args ?? []) {
      if (arg.kind !== "Closure") continue;
      for (const cap of host.closureCaptures.get(arg) ?? []) {
        if (host.isSend(cap.type)) continue;
        host.error(
          `cannot send '${cap.name}' of type '${host.show(cap.type)}' across threads — type does not implement Send`,
          arg.span, host.whyNotSend(cap.type));
      }
      scan(arg, entry);
    }
  };

  const findCalls = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) findCalls(n); return; }
    const n = node as Record<string, unknown> & { kind?: string };
    if (n.kind === "Call" || n.kind === "EnumLit") {
      const t = target(n as unknown as Expr);
      if (isEntry(t)) atEntry(n as unknown as Expr, t!);
    }
    for (const k of Object.keys(n)) if (k !== "span") findCalls(n[k]);
  };
  for (const f of fns.values()) if (f.body) findCalls(f.body);
  for (const g of program.globals) findCalls(g.value);
}

// Which globals does each function transitively write? The aliasing model is keyed to
// locals, params and self, so a `var` global mutated inside a callee is invisible to it
// and three heap-use-after-frees fell straight through: `for x in G { grow() }` where
// grow() pushes to G, the same with `G = Vec.new()`, and plain `use(G[0])` where use()
// reallocs G. No threads involved — this is single-threaded aliasing, a different axis
// from checkThreadBoundary, but it needs the same summary, so both read this one.
// Does this method call mutate its receiver? Built-in collection mutators are a fixed
// list; a user method declares it by taking `&mut self`.
function mutatesReceiver(host: ProgramPassHost, call: Expr): boolean {
  const m = (call as Extract<Expr, { kind: "MethodCall" }>).method;
  if (MUTATING_COLLECTION_METHODS.has(m)) return true;
  const t = host.resolvedMethods.get(call) ?? host.rewrittenCalls.get(call);
  const self = t ? host.functions.get(t)?.params?.[0]?.type : undefined;
  return !!self && self.tag === "ref" && self.mutable;
}

// `parks` rides the same call graph: a fn may park the current green task if it carries
// `@parks` or calls one that may. Stops at the declared boundary, so the scheduler's
// internals are never modelled here.
function globalWriteSummary(host: ProgramPassHost, view: ProgramView, mutableGlobals: Set<string>): { writes: Map<string, Set<string>>; parks: Set<string> } {
  const { fns, rootOf, calleeOf: target } = view;

  const writes = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  for (const [name, f] of fns) {
    const w = new Set<string>();
    const c = new Set<string>();
    const bound = new Set<string>(f.params.map(p => p.name));
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: unknown };
      if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);
      const note = (r: string | undefined) => { if (r && mutableGlobals.has(r) && !bound.has(r)) w.add(r); };
      if (n.kind === "Assign") note(rootOf(n.target));
      if (n.kind === "MethodCall" && mutatesReceiver(host, n as unknown as Expr)) {
        // `G.push(x)` never appears as an Assign but reallocs G's buffer.
        note(rootOf(n.object));
      }
      if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
        const t = target(n as unknown as Expr);
        if (t) c.add(t);
      }
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
    };
    if (f.body) walk(f.body);
    writes.set(name, w);
    callees.set(name, c);
  }
  const parks = new Set<string>();
  for (const [name, f] of fns) if (f.attributes?.some(a => a.name === "parks")) parks.add(name);
  // Least fixpoint over the call graph. Recursion just stops adding on the round where
  // nothing new propagates, so no explicit cycle guard is needed.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, cs] of callees) {
      const w = writes.get(name)!;
      for (const t of cs) {
        for (const g of writes.get(t) ?? []) if (!w.has(g)) { w.add(g); changed = true; }
        if (parks.has(t) && !parks.has(name)) { parks.add(name); changed = true; }
      }
    }
    // FFI re-entry: C code can call back into any `@externalLinkage` fn, so once one
    // of those may park, every extern call may park too (the walk cannot see which C
    // routine reaches which callback). Coarse on purpose; today no such fn parks.
    if (!changed && [...fns.values()].some(f => parks.has(f.name) && f.attributes?.some(a => a.name === "externalLinkage"))) {
      for (const [name, f] of fns) if (f.isExtern && !parks.has(name)) { parks.add(name); changed = true; }
    }
  }
  return { writes, parks };
}

// Rejects a call that writes a global while a borrow into that same global is live.
// Two shapes, both heap-use-after-free before this: iterating a global while a callee
// reallocs or replaces it, and passing a place rooted at a global to a function that
// reallocs that global under the reference it was just handed.
//
// The same walk applies the cross-task rule: an element view of a mutable global may
// not be live across a call that may park the current green task. The callee need not
// write anything itself; while the task is parked ANY other task can push to the global
// and free the buffer the view points into. `for x in g { schedulerYield() }` printed
// freed memory before host. Element views are the for-in binding, a slice binding, and
// a `&`/`&[T]` argument into the global; a `&mut` to the global's header itself is not
// one (the header outlives a realloc, the buffer does not) and stays legal.
export function checkGlobalBorrowInvalidation(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const mutableGlobals = new Set<string>();
  for (const g of program.globals) if (g.mutable) mutableGlobals.add(g.name);
  if (mutableGlobals.size === 0) return;
  const { fns, rootOf, calleeOf: target, pretty } = view;
  const { writes, parks } = globalWriteSummary(host, view, mutableGlobals);
  const reported = new Set<string>();
  const report = (msg: string, span: Span | undefined, hint: string) => {
    const key = `${span?.line ?? 0}:${span?.col ?? 0}:${msg}`;
    if (reported.has(key)) return;
    reported.add(key);
    host.error(msg, span, hint);
  };

  // A `&[T]` parameter is a fat pointer into the argument's buffer, so even the bare
  // global is an element view there; only `&Vec<T>`/`&mut Vec<T>` name the header.
  const isSliceParam = (t: { isRef: boolean; isRefMut: boolean; isArray: boolean; arraySize: number | null } | undefined) =>
    !!t && (t.isRef || t.isRefMut) && t.isArray && t.arraySize === null;
  const parkHint = (g: string) =>
    `iterate by index ('while i < ${g}.len'), snapshot first ('${g}.clone()'), or move the global into a value the task owns`;

  for (const f of fns.values()) {
    if (!f.body) continue;
    const bound = new Set<string>(f.params.map(p => p.name));
    // Globals whose storage is borrowed by an enclosing for-in. A loop iterand is a
    // reference into the container's buffer, so anything that reallocs or replaces the
    // container leaves it dangling for the rest of the iteration.
    //
    // `views` are element views into a global held by a binding that stays live to the
    // end of its block: a reference binding (`let s = g[a..b]`, or a method returning
    // `&[T]` from a receiver rooted at g) or a raw pointer binding (`let p = g.ptr()`,
    // `let c = Cfg { buf: g.cstr() }`; `pointerViewsIn` is the same recognizer the
    // freeze machinery uses, so this walk and `bindPointerViews` agree on what a pointer
    // view is). A statement list is walked in order and each such binding extends the
    // context for the statements after it. Decided by the binding's checked type, not
    // its spelling, so every way of producing a view counts (`g[a..b]` itself parses as
    // `g.slice(a, b)`). `via` names the pointer call for the diagnostic; a ref view has none.
    type View = { name: string; global: string; via?: string };
    const viewsOf = (n: Record<string, unknown> & { kind?: string; name?: unknown }): View[] => {
      if ((n.kind !== "LetDecl" && n.kind !== "VarDecl") || typeof n.name !== "string") return [];
      const v = n.value as Expr | undefined;
      if (!v) return [];
      const name = n.name;
      const isGlobal = (g: string | undefined): g is string => !!g && mutableGlobals.has(g) && !bound.has(g);
      if (host.exprTypes.get(v)?.tag === "ref") {
        const g = rootOf(v.kind === "MethodCall" ? v.object : v);
        return isGlobal(g) ? [{ name, global: g }] : [];
      }
      const out: View[] = [];
      for (const pv of host.pointerViewsIn(v)) {
        const g = rootOf(pv.source);
        if (isGlobal(g)) out.push({ name, global: g, via: `${pv.call}' on line ${pv.line}` });
      }
      return out;
    };
    const describeView = (v: View) => v.via
      ? `'${v.name}' still points into '${v.global}'s buffer (from '${v.via})`
      : `'${v.name}' is a view into '${v.global}'s buffer`;
    const walk = (node: unknown, iterated: string[], views: View[]) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        let live = views;
        for (const n of node) {
          walk(n, iterated, live);
          const vs = viewsOf(n as Record<string, unknown> & { kind?: string; name?: unknown });
          if (vs.length > 0) live = [...live, ...vs];
        }
        return;
      }
      const n = node as Record<string, unknown> & { kind?: string; name?: unknown; span?: unknown };
      const span = n.span as Span | undefined;
      if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);

      if (n.kind === "ForInStmt") {
        const g = rootOf(n.iterable);
        const next = g && mutableGlobals.has(g) && !bound.has(g) ? [...iterated, g] : iterated;
        walk(n.iterable, iterated, views);
        walk(n.body, next, views);
        return;
      }

      if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
        const t = target(n as unknown as Expr);
        const callArgs = (n.args as Expr[] | undefined) ?? [];
        const callee = t ? fns.get(t) : undefined;
        // A method call carries its receiver as params[0]; anything that does not
        // line up leaves paramOffset -1 and the check stays fail-closed.
        const paramOffset = !callee ? -1
          : callee.params.length === callArgs.length ? 0
          : callee.params.length === callArgs.length + 1 ? 1
          : -1;
        if (t && parks.has(t)) {
          for (const g of iterated) {
            report(
              `'${pretty(t)}' can park this task while the loop variable is a reference into '${g}'s buffer; another task may push to '${g}' before it resumes`,
              span,
              parkHint(g),
            );
          }
          for (const v of views) {
            if (iterated.includes(v.global)) continue;
            report(
              `'${pretty(t)}' can park this task while ${describeView(v)}; another task may push to '${v.global}' before it resumes`,
              span,
              parkHint(v.global),
            );
          }
          // `use(g[0])` / `sum(g)` into a `&[T]`: the argument is a view into g's buffer
          // for as long as the callee runs, and the callee parks.
          for (const [argIdx, a] of callArgs.entries()) {
            // A slice expression is already a reference whatever the parameter says;
            // it roots at its receiver (`g[a..b]` parses as `g.slice(a, b)`). An inline
            // `g.ptr()` is a view for the duration of the call in the same way.
            const ptrView = host.pointerViewsIn(a)[0];
            const isViewArg = host.exprTypes.get(a)?.tag === "ref" || ptrView !== undefined;
            const g = ptrView ? rootOf(ptrView.source) : rootOf(isViewArg && a.kind === "MethodCall" ? a.object : a);
            if (!g || !mutableGlobals.has(g) || bound.has(g)) continue;
            if (iterated.includes(g) || views.some(v => v.global === g)) continue;
            const prm = paramOffset >= 0 ? callee!.params[argIdx + paramOffset] : undefined;
            const isElement = ((): boolean => {
              let cur = a as unknown as Record<string, unknown> & { kind?: string };
              while (cur && typeof cur === "object") {
                if (cur.kind === "IndexAccess") return true;
                if (cur.kind === "FieldAccess") { cur = cur.object as typeof cur; continue; }
                return false;
              }
              return false;
            })();
            if (!isViewArg) {
              if (prm?.type) {
                if (!isSliceParam(prm.type) && !(isElement && (prm.type.isRef || prm.type.isRefMut))) continue;
              } else if (!isElement) continue;
            }
            report(
              `'${pretty(t)}' can park this task while it holds a reference into '${g}'s buffer; another task may push to '${g}' before it resumes`,
              (a.span as Span | undefined) ?? span,
              parkHint(g),
            );
          }
        }
        const w = t ? writes.get(t) : undefined;
        if (t && w) {
          for (const g of iterated) {
            if (!w.has(g)) continue;
            report(
              `'${pretty(t)}' writes the global '${g}', which is being iterated here`,
              span,
              `the loop variable is a reference into '${g}'s buffer — pushing to it, clearing it, or ` +
              `reassigning it from inside the loop frees that buffer and leaves the reference dangling. ` +
              `Iterate a copy ('for x in ${g}.clone()'), or collect the changes and apply them after the loop`,
            );
          }
          // `let p = g.ptr(); writer()` (or a slice binding) where `writer` pushes to g:
          // the callee frees the buffer the binding points into (h4-global-callee-push).
          // The main pass cannot see a write made inside another function, and this
          // walk is the one place that knows both the live views and the write summary.
          for (const v of views) {
            if (!w.has(v.global) || iterated.includes(v.global)) continue;
            report(
              `'${pretty(t)}' writes the global '${v.global}' while ${describeView(v)}`,
              span,
              `pushing to, clearing or reassigning '${v.global}' frees the buffer '${v.name}' points into: ` +
              `take '${v.name}' after the call, or end its block before it`,
            );
          }
          for (const a of callArgs) {
            for (const pv of host.pointerViewsIn(a)) {
              const g = rootOf(pv.source);
              if (!g || !mutableGlobals.has(g) || bound.has(g) || !w.has(g)) continue;
              if (iterated.includes(g) || views.some(v => v.global === g)) continue;
              report(
                `'${pretty(t)}' writes the global '${g}', and is passed '${pv.call}' here`,
                (a.span as Span | undefined) ?? span,
                `the pointer is into '${g}'s buffer, and '${pretty(t)}' can realloc or replace '${g}' while it holds it: take the pointer inside '${pretty(t)}', or have it not write '${g}'`,
              );
            }
          }
          // `use(G[0])` — the argument is a reference into G's storage and the callee
          // reallocs G, so the reference dies before the callee is done with it.
          //
          // Two things have to be true for that to dangle, and checking only that the
          // argument MENTIONS the global rejected two safe shapes that a real program
          // (milojs) is built out of:
          //
          //   - the path has to reach the global's HEAP interior. `G` and `G.field`
          //     name storage at the global's own fixed address, which no realloc moves
          //     and which reassigning G overwrites in place; only an index step reaches
          //     a buffer that can be freed under the reference.
          //   - the PARAMETER has to be a reference. A by-value parameter materialises
          //     its argument before the callee runs, so nothing of the global's is
          //     still borrowed while the callee writes.
          const reachesHeapInterior = (e: unknown): boolean => {
            let cur = e as Record<string, unknown> & { kind?: string };
            while (cur && typeof cur === "object") {
              if (cur.kind === "IndexAccess") return true;
              if (cur.kind === "FieldAccess") { cur = cur.object as typeof cur; continue; }
              return false;
            }
            return false;
          };
          for (const [argIdx, a] of callArgs.entries()) {
            const g = rootOf(a);
            if (!g || !mutableGlobals.has(g) || bound.has(g) || !w.has(g)) continue;
            if (iterated.includes(g)) continue;
            if (!reachesHeapInterior(a)) continue;
            if (paramOffset >= 0) {
              const prm = callee!.params[argIdx + paramOffset];
              if (prm && prm.type && !prm.type.isRef && !prm.type.isRefMut) continue;
            }
            report(
              `'${pretty(t)}' writes the global '${g}', and is passed a reference into '${g}' here`,
              (a.span as Span | undefined) ?? span,
              `the argument borrows '${g}'s storage, and '${pretty(t)}' can realloc or replace '${g}' ` +
              `while that borrow is live — pass a copy, or have '${pretty(t)}' take '${g}' by value`,
            );
          }
        }
      }
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k], iterated, views);
    };
    walk(f.body, [], []);
  }
}
