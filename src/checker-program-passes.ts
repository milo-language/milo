// Whole-program passes that run after every function body is checked and read only the
// recorded results. Escaping closures, `@pure`, the thread boundary, global borrow
// invalidation, pointer-parameter escape, and the `&mut` bundle census all live here:
// they need the finished call-resolution maps and the full set of
// monomorphized instances, which is why they cannot run per function, and they reach
// the checker only through `ProgramPassHost` (its recorded maps and diagnostics) plus
// the `ProgramView` it builds once for all of them (design pass 2026-09, F5).
import type { Program, Function, Expr, Span } from "./ast";
import type { TypeKind } from "./types";
import type { CaptureInfo, FnSig } from "./checker";
import { MUTATING_COLLECTION_METHODS } from "./builtin-members";

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
  // Globals whose initializer runs code, by name, to the synthetic fn in `fns` whose body
  // is that initializer. Such a global is initialized on its first read (src/lazy-globals.ts),
  // so a read may run the initializer: the passes treat it as a call.
  lazyInits: Map<string, string>;
}

// The name of the synthetic fn standing for a lazy global's initializer.
export const LAZY_INIT_FN_PREFIX = "<init of ";
export const lazyInitFnName = (global: string) => `${LAZY_INIT_FN_PREFIX}${global}>`;

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
  errorCode(code: string, msg: string, span?: Span, hint?: string): void;
  warn(code: string, msg: string, span?: Span, hint?: string, len?: number): void;
  show(t: TypeKind): string;
  isSend(ty: TypeKind): boolean;
  whyNotSend(ty: TypeKind): string;
  pointerViewsIn(e: Expr): { source: Expr; call: string; line: number }[];
  // Whether a value of this type holds a raw pointer anywhere inside it (`*T`, a struct
  // or enum with a pointer field, `Vec<*T>`, ...). `@copy` does not exempt: a non-owning
  // view is exactly what must not outlive its buffer.
  carriesRawPointer(ty: TypeKind): boolean;
  // The types with a user Drop impl that destroying a `ty` may run, plus the markers
  // "<closure-env>" / "<interface>" where the type hides what it owns.
  dropTypesIn(ty: TypeKind): Set<string>;
  // Whether `f` exists only because some type arguments instantiated a generic (a
  // generic fn, a generic struct's or enum's method, a method's own type parameter):
  // such an instance runs only if something calls it.
  isGenericInstance(f: Function): boolean;
  fnDeclaredInStd(f: Function): boolean;
  // A type that carries a raw pointer and was declared outside std: sharing one with an
  // OS thread is memory record/replay cannot order.
  userRawPointerType(ty: TypeKind): boolean;
  // Thread closures that share unsafe memory, with the `file:line` a run reports.
  replayRawShares: Map<Expr, string>;
  replaySiteOf(span: Span | undefined): string;
  // What the checker recorded as written (src/checker-mutability.ts reads it); `diagnostics` is the live list.
  mutation: { written: WeakSet<Expr>; autoBorrowed: Map<Expr, { mutable: boolean }>; explicitMutArgs: Set<Expr>; matchSubjectMut: Set<Expr>; diagnostics: import("./diagnostics").Diagnostic[] };
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

// The escaping-closure check lives in src/checker-escaping-closures-host.ts; re-exported so the
// checker keeps importing it from here.
export { checkEscapingClosures } from "./checker-escaping-closures-host";

// A plain closure-typed parameter `f: (A) => R` is NON-ESCAPING (Swift's rule): the
// callee may call it and pass it on to another plain closure parameter, and nothing
// else. That promise is what lets a caller hand it a closure that borrows locals and
// `self` (checkClosureExpr allows reference captures in a by-reference closure, and the
// call site keeps such a literal by-reference). A parameter the callee keeps (stores,
// returns, spawns, captures in a `move` closure) has to say so: `f: move (A) => R`.
// Checked here, in the callee, so the signature alone tells a caller what happens to
// its closure.
export function isNonEscapingFnParam(t: TypeKind | undefined): boolean {
  return t?.tag === "fn" && !t.owning;
}

// The Task.scope check lives in src/checker-task-scopes-host.ts; re-exported so the checker and
// the emitter keep importing it, and the mangled name of `spawn`, from here.
export { checkTaskScopes, SCOPED_SPAWN_FN } from "./checker-task-scopes-host";

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
  const implicit = implicitCalls(host, program, view);
  // A closure handed straight to a critical section runs only inside it, so a call
  // through a value elsewhere cannot be what runs it unsynchronized.
  const criticalArgs = new Set<Expr>();
  const findCritical = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) findCritical(n); return; }
    const n = node as Record<string, unknown> & { kind?: string };
    if ((n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") && isCriticalSection(target(n as unknown as Expr))) {
      for (const a of (n.args as Expr[] | undefined) ?? []) if (a.kind === "Closure") criticalArgs.add(a);
    }
    for (const k of Object.keys(n)) if (k !== "span") findCritical(n[k]);
  };
  for (const f of fns.values()) findCritical(f.body);
  for (const g of program.globals) findCritical(g.value);

  // The globals a node writes: an assignment's root, a mutating method's receiver, and
  // an argument passed to a `&mut` parameter (the `&mut` marker is already stripped, so
  // the argument roots directly). A method's receiver is params[0], so its args shift by
  // one when the signature has one more param than the call has args.
  const writeRoots = (n: Record<string, unknown> & { kind?: string }): (string | undefined)[] => {
    const out: (string | undefined)[] = [];
    if (n.kind === "Assign") out.push(rootOf(n.target));
    if (n.kind === "MethodCall" && mutatesReceiver(host, n as unknown as Expr)) out.push(rootOf(n.object));
    if (n.kind === "Call" || n.kind === "MethodCall") {
      const t = target(n as unknown as Expr);
      const params = t ? host.functions.get(t)?.params : undefined;
      const args = (n.args as Expr[] | undefined) ?? [];
      if (params) {
        const shift = n.kind === "MethodCall" && params.length === args.length + 1 ? 1 : 0;
        args.forEach((a, i) => {
          const p = params[i + shift]?.type;
          if (p?.tag === "ref" && p.mutable) out.push(rootOf(a));
        });
      }
    }
    return out;
  };

  // Every mutable global some live code writes outside a critical section, on any thread
  // (main included). A thread's READ of such a global races with that write; a global
  // written only by its initializer is effectively immutable and stays readable. Writes
  // inside a `@synchronized` closure (`Once.run`) are excluded: the primitive publishes
  // them, which is the existing reason a read after `Once.run` is not flagged. This does
  // not order main's writes before the thread start (a spawn is a happens-before edge),
  // on purpose: "filled at startup, read on threads" is what an initialized `let` global
  // says without the checker having to prove the order.
  //
  // std's own globals are left to the write rule alone. Its runtime state (rrMode,
  // rrHeapOn, the scheduler's config) is written at boot, before any thread exists, then
  // only read; that order is real but invisible to this pass, and std's cross-thread
  // state is audited by hand (atomics, ReplayLock). User code cannot write std's globals.
  const stdGlobals = new Set(program.globals.filter(g => g.span?.file?.includes("/std/")).map(g => g.name));
  // Global -> the first write found, named in the read-only diagnostic.
  const writtenAnywhere = new Map<string, Span | undefined>();
  const noteWrites = (node: unknown, bound: Set<string>) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) noteWrites(x, bound); return; }
    const n = node as Record<string, unknown> & { kind?: string; name?: unknown };
    if (n.kind === "Closure" && criticalArgs.has(n as unknown as Expr)) return;
    if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);
    // Flat scoping as in `scan`: a closure param shadowing a global hides it for the
    // rest of the enclosing body too, which can only miss a write, never invent one.
    if (n.kind === "Closure") for (const p of (n as unknown as ClosureLit).params) bound.add(p.name);
    for (const r of writeRoots(n)) {
      if (r && mutableGlobals.has(r) && !stdGlobals.has(r) && !bound.has(r) && !writtenAnywhere.has(r)) writtenAnywhere.set(r, n.span as Span | undefined);
    }
    for (const k of Object.keys(n)) if (k !== "span") noteWrites(n[k], bound);
  };
  const live = implicit.reachable();
  for (const f of fns.values()) if (f.body && live.has(f.name)) noteWrites(f.body, new Set(f.params.map(p => p.name)));
  for (const g of program.globals) noteWrites(g.value, new Set());

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
    // Keyed by callee AND the fn values its parameters hold: `runOnce(f)` inside the
    // Promise.blocking wrapper runs only what that wrapper was handed, while the same
    // instance under Promise.run runs green-task closures that never reach a thread.
    const envKey = (env: Map<string, Values> | undefined) =>
      env ? [...env].map(([k, v]) => `${k}=${v === null ? "*" : [...v].sort().join(",")}`).join(";") : "";
    const follow = (t: string, chain: string[], env?: Map<string, Values>) => {
      const key = `${t}|${envKey(env)}`;
      if (done.has(key)) return;
      done.add(key);
      const f = fns.get(t);
      if (f && !f.isExtern && f.body) walk(f.body, new Set(f.params.map(p => p.name)), [...chain, t], { fn: t, env, shadow: new Set() });
    };
    const runClosure = (id: string, chain: string[]) => {
      const c = implicit.closureById.get(id);
      if (!c || done.has(id) || criticalArgs.has(c)) return;
      done.add(id);
      walk(c.body, new Set(c.params.map(p => p.name)), [...chain, id], implicit.closureScope(c));
    };
    const walk = (node: unknown, bound: Set<string>, chain: string[], scope: Scope) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n, bound, chain, scope); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: unknown; span?: unknown };
      const span = (n.span as Span | undefined) ?? closure.span;
      if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);
      implicit.enter(n, scope);

      const hit = (name: string | undefined, write: boolean) => {
        if (!name || !mutableGlobals.has(name) || bound.has(name)) return;
        touches.push({ name, span, chain, write });
      };
      // `G.push(x)` is a write that never appears as an Assign. A `&self` method is not
      // — `gOnce.run(...)` is the Once synchronizing itself, and `Sync` is the wrong
      // question to ask here anyway: `Vec<i64>` is perfectly Sync and `push` still
      // reallocs it.
      for (const r of writeRoots(n)) hit(r, true);
      if (n.kind === "Ident" && typeof n.name === "string") hit(n.name, false);

      // A call through a value (closure, fn-typed param, C function pointer) has no static
      // target. The walk below follows it fail closed (see implicitCalls); this opt-in
      // warning still names the opacity itself, for code that wants a named callee on
      // every thread. Skipped entirely when the program has no mutable globals, since
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
            walk(n[k], bound, chain, scope);
          }
          for (const a of (n.args as Expr[] | undefined) ?? []) if (a.kind !== "Closure") walk(a, bound, chain, scope);
          return;
        }
        if (t && !implicit.isIndirect(n)) follow(t, chain, implicit.envFor(t, n, scope));
      }
      // Calls the source never spells (see implicitCalls): a call through a value runs
      // what the value may hold (any closure or fn value when unbounded), and a dying
      // value runs its Drop.
      for (const t of implicit.implicitTargets(n, scope)) {
        if (implicit.closureById.has(t)) { runClosure(t, chain); continue; }
        if (t !== INDIRECT) { follow(t, chain); continue; }
        if (done.has(INDIRECT)) continue;
        done.add(INDIRECT);
        const via = [...chain, INDIRECT];
        for (const id of implicit.closureById.keys()) runClosure(id, via);
        for (const fv of implicit.fnValues) follow(fv, via);
      }
      // A nested closure body runs on the same thread, so the generic descent walks in.
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k], bound, chain, scope);
    };
    const lit = closure as ClosureLit;
    walk(lit.body, new Set(), [], implicit.closureIds.has(lit) ? implicit.closureScope(lit) : { shadow: new Set() });

    // A read races with a write on any thread, so a global the program writes anywhere
    // (outside a critical section) is racy here even when this thread only reads it.
    const racy = new Set(touches.filter(t => t.write || writtenAnywhere.has(t.name)).map(t => t.name));
    const at = (t: Touch) => `${t.name}@${t.span?.file ?? ""}:${t.span?.line ?? 0}:${t.span?.col ?? 0}`;
    for (const t of touches) {
      if (!racy.has(t.name)) continue;
      // One report per global per thread entry: `g = g + 1` is a read and a write of
      // the same mistake, and repeating it per mention buries the fix.
      const key = `${entry}|${t.name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      // And none for an entry that reaches a touch another entry already reported:
      // Promise.blocking's caller and the wrapper closure it hands
      // spawnOsThreadDetached both reach the same user code.
      const mine = touches.filter(u => u.name === t.name);
      const seen = mine.some(u => reported.has(at(u)));
      for (const u of mine) reported.add(at(u));
      if (seen) continue;
      const where = t.chain.length ? ` (via ${t.chain.map(c => sayCallee(view, c, implicit)).join(" → ")})` : "";
      const readOnly = !mine.some(u => u.write);
      const w = writtenAnywhere.get(t.name);
      host.error(
        `'${t.name}' is a mutable global, and this code runs on a real OS thread${where}`,
        t.span,
        readOnly
          ? `this thread only reads '${t.name}', but the program writes it` +
            `${w ? ` (${w.file?.split("/").pop() ?? ""}:${w.line})` : ""}, and a read racing a write is a ` +
            `data race (a push can realloc the buffer under the reader). If it is filled once, make it ` +
            `'let ${t.name}' with an initializer that builds it (a non-constant initializer runs on ` +
            `first read, exactly once); otherwise pass the value into the closure, use an atomic from ` +
            `'std/sync', or do every write inside one 'Once.run' that the thread also calls first`
          : `two threads touching one unsynchronized global is a data race — make '${t.name}' an ` +
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
      noteRawShare(arg);
    }
  };

  // Record/replay orders what threads share through std/sync. Memory a thread reaches
  // through `unsafe` (a raw pointer captured inside a user type that vouched for itself
  // with `unsafe impl Send`, or an `unsafe` block in the thread's own body) is not
  // ordered, so it is a replay hole: listed under `--replay-holes`, and reported by the
  // run when the thread starts (lower.ts prepends the report to the closure body).
  const noteRawShare = (closure: Expr) => {
    if (!closure.span?.file || closure.span.file.includes("/std/")) return;
    const raw = (host.closureCaptures.get(closure) ?? []).find(c => host.userRawPointerType(c.type));
    let unsafeBlock = false;
    const look = (node: unknown) => {
      if (unsafeBlock || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) look(n); return; }
      if ((node as { kind?: string }).kind === "UnsafeBlock") { unsafeBlock = true; return; }
      for (const [k, v] of Object.entries(node)) if (k !== "span") look(v);
    };
    look((closure as Extract<Expr, { kind: "Closure" }>).body);
    if (!raw && !unsafeBlock) return;
    const why = raw ? `it captures '${raw.name}', which carries a raw pointer` : `its body has an 'unsafe' block`;
    host.warn("replay-hole", `this closure runs on an OS thread and ${why}: memory shared that way is not ordered under record/replay`, closure.span,
      `share state between threads through std/sync (Channel, AtomicI64, WaitGroup, Once), which record/replay orders`);
    host.replayRawShares.set(closure, host.replaySiteOf(closure.span));
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
  // Only fns that can run: an unused generic instance spawns nothing (see `live`).
  for (const f of fns.values()) if (f.body && live.has(f.name)) findCalls(f.body);
  for (const g of program.globals) findCalls(g.value);
}

// A `@concurrent` fn runs its closure argument on several threads at once, all sharing
// one environment, so a capture written (or moved out) in the body is a data race with no
// park involved; checkGlobalBorrowInvalidation's park rule cannot see it. Rust spells
// this `Fn + Sync`; here the closure must visibly not write: a named fn, or a literal
// whose captures are only read. A closure value is rejected, since its body is not
// at the call.
export function checkConcurrentClosureArgs(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const { fns, calleeOf } = view;
  const isConcurrent = (t: string | undefined) => !!t && !!fns.get(t)?.attributes?.some(a => a.name === "concurrent");
  if (![...fns.values()].some(f => f.attributes?.some(a => a.name === "concurrent"))) return;
  const named = new Set<string>([...program.functions.map(f => f.name), ...fns.keys()]);
  const visit = (node: unknown, bound: Set<string>) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) visit(n, bound); return; }
    const n = node as Record<string, unknown> & { kind?: string; span?: Span };
    if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);
    if ((n.kind === "Call" || n.kind === "MethodCall" || n.kind === "EnumLit") && isConcurrent(calleeOf(n as unknown as Expr))) {
      const who = view.pretty(calleeOf(n as unknown as Expr)!);
      for (const a of (n.args as Expr[] | undefined) ?? []) {
        if (host.exprTypes.get(a)?.tag !== "fn") continue;
        if (a.kind === "Closure") {
          const bad = (host.closureCaptures.get(a) ?? []).find(c => c.mutatedInClosure || c.consumedInClosure);
          if (bad) {
            host.error(`'${who}' runs this closure on several threads at once, and it ${bad.consumedInClosure && !bad.mutatedInClosure ? "moves" : "writes"} its capture '${bad.name}'`, a.span ?? n.span,
              `every worker shares one environment, so the writes race: give each worker its own state through parallelMapWith's states, or a std/sync atomic`);
          }
          continue;
        }
        if (a.kind === "Ident" && named.has(a.name) && !bound.has(a.name)) continue;
        host.error(`'${who}' runs its closure argument on several threads at once, and the checker cannot see whether this one writes its captures`, a.span ?? n.span,
          `pass a named fn or write the closure literal at the call`);
      }
    }
    for (const k of Object.keys(n)) if (k !== "span") visit(n[k], bound);
  };
  for (const f of fns.values()) if (f.body) visit(f.body, new Set(f.params.map(p => p.name)));
}

// Which globals does each function transitively write? The aliasing model is keyed to
// locals, params and self, so a `var` global mutated inside a callee is invisible to it
// and three heap-use-after-frees fell straight through: `for x in G { grow() }` where
// grow() pushes to G, the same with `G = Vec.new()`, and plain `use(G[0])` where use()
// reallocs G. No threads involved — this is single-threaded aliasing, a different axis
// from checkThreadBoundary, but it needs the same summary, so both read this one.
// Does this method call mutate its receiver? Built-in collection mutators are a fixed
// list; a user method declares it by taking `&mut self`.
export function mutatesReceiver(host: ProgramPassHost, call: Expr): boolean {
  const m = (call as Extract<Expr, { kind: "MethodCall" }>).method;
  if (MUTATING_COLLECTION_METHODS.has(m)) return true;
  const t = host.resolvedMethods.get(call) ?? host.rewrittenCalls.get(call);
  const self = t ? host.functions.get(t)?.params?.[0]?.type : undefined;
  return !!self && self.tag === "ref" && self.mutable;
}

// `parks` rides the same call graph: a fn may park the current green task if it carries
// `@parks` or calls one that may. Stops at the declared boundary, so the scheduler's
// internals are never modelled here.
// `seed` gives a closure node writes it makes on every call whatever its body says: the
// closure's own written captures, which checkGlobalBorrowInvalidation models as globals.
export function globalWriteSummary(host: ProgramPassHost, program: Program, view: ProgramView, mutableGlobals: Set<string>, seed?: Map<string, Set<string>>): { writes: Map<string, Set<string>>; parks: Set<string> } {
  const { fns, rootOf, calleeOf: target } = view;
  const implicit = implicitCalls(host, program, view);

  const writes = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  // What an unbounded call through a value may run: every named fn used as a value,
  // and every closure literal (each its own `<closure#k>` node).
  const indirect = new Set<string>([...implicit.fnValues, ...implicit.closureIds.values()]);
  const summarize = (name: string, body: unknown, bound: Set<string>, scope: Scope, entryCallees: Iterable<string>) => {
    // A closure body's effects land on the closure's own node AND on every enclosing fn
    // and closure: the enclosing code may run it inline (a builtin, a direct call of a
    // local), so dropping them there would lose writes the summary had before.
    const sinks = [{ w: new Set<string>(), c: new Set<string>(entryCallees) }];
    writes.set(name, sinks[0].w);
    callees.set(name, sinks[0].c);
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: unknown };
      if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") bound.add(n.name);
      implicit.enter(n, scope);
      const note = (r: string | undefined) => { if (r && mutableGlobals.has(r) && !bound.has(r)) for (const s of sinks) s.w.add(r); };
      const call = (t: string) => { for (const s of sinks) s.c.add(t); };
      if (n.kind === "Assign") note(rootOf(n.target));
      if (n.kind === "MethodCall" && mutatesReceiver(host, n as unknown as Expr)) {
        // `G.push(x)` never appears as an Assign but reallocs G's buffer.
        note(rootOf(n.object));
      }
      if (n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") {
        const t = implicit.isIndirect(n) ? undefined : target(n as unknown as Expr);
        if (t) call(t);
      }
      for (const t of implicit.implicitTargets(n, scope)) call(t);
      const id = n.kind === "Closure" ? implicit.closureIds.get(n as unknown as ClosureLit) : undefined;
      if (id) {
        // Its by-value parameters die inside the body, whoever passed them.
        const ty = host.exprTypes.get(n as unknown as Expr);
        const own = { w: new Set<string>(seed?.get(id) ?? []), c: new Set<string>(ty?.tag === "fn" ? ty.params.flatMap(p => implicit.dropFnsOf(p)) : []) };
        writes.set(id, own.w);
        callees.set(id, own.c);
        sinks.push(own);
        for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
        sinks.pop();
        return;
      }
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
    };
    walk(body);
  };
  for (const [name, f] of fns) {
    // Parameters are dropped by the callee when it does not move them on.
    const paramDrops = implicit.paramDropsOf(name);
    const reentry = implicit.reentersMilo(f) ? [FOREIGN] : [];
    summarize(name, f.body, new Set<string>(f.params.map(p => p.name)), { fn: name, shadow: new Set() }, [...paramDrops, ...reentry]);
  }
  // Global initializers run no user loop, but a closure stored in one is reachable from
  // any call through a value, so its body still needs a node.
  for (const g of program.globals) summarize("<global-init>", g.value, new Set(), { shadow: new Set() }, []);
  writes.set(INDIRECT, new Set());
  writes.set(FOREIGN, new Set());
  callees.set(FOREIGN, new Set([...fns.values()].filter(f => f.attributes?.some(a => a.name === "externalLinkage")).map(f => f.name)));
  callees.set(INDIRECT, indirect);
  const parks = new Set<string>();
  for (const [name, f] of fns) if (f.attributes?.some(a => a.name === "parks")) parks.add(name);
  // Least fixpoint over the call graph, INDIRECT and the closure nodes included (a
  // closure body can itself call through a value). Recursion just stops adding on the
  // round where nothing new propagates, so no explicit cycle guard is needed.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, cs] of callees) {
      const w = writes.get(name)!;
      for (const t of cs) {
        for (const g of writes.get(t) ?? []) if (!w.has(g)) { w.add(g); changed = true; }
        if (parks.has(t) && !parks.has(name)) { parks.add(name); changed = true; }
      }
    }
  }
  return { writes, parks };
}

// ── Calls the source never spells ──────────────────────────────────────────────
//
// Both global-write consumers (the aliasing walk and the thread boundary) follow the
// call graph `calleeOf` gives, which only knows direct calls. Two kinds of call were
// missing from it, and each let a program free a global's buffer under a live borrow
// with no `unsafe` (ASan-confirmed):
//
//   - a call through a value: a closure parameter or local, a fn-pointer field, a
//     builtin or C routine handed a fn value. Fail closed, the callee is the one
//     pseudo-node INDIRECT, which may run ANY closure literal in the program or ANY
//     named fn used as a value. The single narrowing is a call of a fn-typed
//     PARAMETER: it runs what the fn's direct call sites pass there (a literal, a
//     named fn, or the caller's own parameter, followed transitively), because the
//     language gives no other way for a value to reach a parameter. Anything not
//     provably one of those (a local, a field, a reassigned or shadowed name, a fn
//     that may be called from somewhere no site records) is INDIRECT again; see
//     `opaque` and `enter`. Without it the std wrapper `runOnce(f)` reached every
//     closure in the program. An interface method call edges to every fn with that
//     method name.
//   - a Drop impl run when a value dies (scope end, reassignment, overwrite, a
//     container dropping an element). The rule: a node whose checked type CONTAINS a
//     Drop type `T` (field, enum payload, Vec/Heap/HashMap element, transitively) may
//     run `T`'s drop, and so may a fn taking a by-value param of such a type. Sound
//     because every value a fn destroys is a param of it or was produced by an
//     expression in it (a literal, a call result, a binding's initializer, an assigned
//     value, the container a method empties), and each of those expressions carries the
//     value's type. Over-approximate in the other direction: merely naming such a value
//     counts as dropping it. A closure value or interface value hides what it owns, so
//     it counts as dropping whatever any `move` closure captures (narrowed to the literals it can
//     be, where those are known), or any Drop type at all.
const INDIRECT = "<indirect>";
// Foreign code may call back into any `@externalLinkage` fn while it runs.
export const FOREIGN = "<foreign>";
export const isDropFn = (t: string) => t.endsWith("$Drop$drop");
export type ClosureLit = Extract<Expr, { kind: "Closure" }>;
// A callee as a diagnostic names it, pseudo-callees included.
export function sayCallee(view: ProgramView, t: string, implicit: ImplicitCalls): string {
  if (t === INDIRECT) return "a call through a function value";
  if (t.startsWith(LAZY_INIT_FN_PREFIX)) return `the first read of '${view.pretty(t.slice(LAZY_INIT_FN_PREFIX.length, -1))}' (it runs that global's initializer)`;
  if (t === FOREIGN) return "a call into foreign code";
  const c = implicit.closureById.get(t);
  if (c) return `the closure on line ${c.span?.line ?? "?"}`;
  if (isDropFn(t)) return `the implicit '${view.pretty(t.slice(0, -"$Drop$drop".length))}.drop'`;
  return `'${view.pretty(t)}'`;
}

// What a fn-typed value may be: a set of closure ids and fn names, or null when nothing
// bounds it (it may be ANY closure or fn value: INDIRECT).
type Values = Set<string> | null;
// Where a name is looked up. `fn` owns the parameters; `env`, when present, replaces the
// owner's context-insensitive parameter sets with the ones one call site passed; `shadow`
// holds every name a binder introduced (flat, never popped: a name shadowed anywhere
// earlier resolves to unknown, the fail-closed direction).
export interface Scope { fn?: string; env?: Map<string, Values>; shadow: Set<string> }

export interface ImplicitCalls {
  // The callees `n` runs that `calleeOf` does not report: what a call through a value
  // may run (INDIRECT when unbounded), an interface method's possible impls, and the
  // Drop fns of what `n` may destroy.
  implicitTargets(n: object, scope: Scope): string[];
  // Whether `n` is a call through a value. Its `calleeOf` is then meaningless (a
  // closure call reports the bare variable name, which may collide with a fn).
  isIndirect(n: object): boolean;
  // Records the names a binder node introduces; every walk calls it on every node.
  enter(n: object, scope: Scope): void;
  dropFnsOf(ty: TypeKind): string[];
  // What a fn's by-value parameters may drop, narrowed for fn-typed ones.
  paramDropsOf(name: string): string[];
  // The parameter env a direct call passes its callee, or undefined when the arguments
  // do not line up with the parameters (the callee's own sets then apply).
  envFor(callee: string, call: object, scope: Scope): Map<string, Values> | undefined;
  // Named fns used as values and every closure literal: what INDIRECT may run.
  fnValues: Set<string>;
  closureIds: Map<ClosureLit, string>;
  closureById: Map<string, ClosureLit>;
  // The scope a closure body was written in, for walking it from a call through a value.
  closureScope(c: ClosureLit): Scope;
  // Whether calling extern `f` can run an `@externalLinkage` fn before it returns.
  reentersMilo(f: Function): boolean;
  // Fns that can run: everything not a generic instance, plus the instances reachable
  // from those through direct and implicit calls.
  reachable(): Set<string>;
}

const implicitCache = new WeakMap<ProgramView, ImplicitCalls>();
export function implicitCalls(host: ProgramPassHost, program: Program, view: ProgramView): ImplicitCalls {
  const cached = implicitCache.get(view);
  if (cached) return cached;
  const { fns, calleeOf } = view;
  const byType = new Map<string, string>();
  for (const name of fns.keys()) if (isDropFn(name)) byType.set(name.slice(0, -"$Drop$drop".length), name);
  const instances = new Map<string, string[]>();
  for (const [name, f] of fns) for (const key of new Set([name, f.sourceName ?? name])) {
    (instances.get(key) ?? instances.set(key, []).get(key)!).push(name);
  }

  // Only a `move` closure owns its captures: a by-reference closure's environment holds
  // pointers into the building frame, so dropping it runs no capture's Drop.
  const ownedDropTypes = (clo: Expr): string[] => {
    if (!(clo as { isMove?: boolean }).isMove) return [];
    return (host.closureCaptures.get(clo) ?? []).flatMap(c => [...host.dropTypesIn(c.type)].filter(t => !t.startsWith("<")));
  };
  const captured = new Set<string>();
  for (const clo of host.closureCaptures.keys()) for (const t of ownedDropTypes(clo)) captured.add(t);
  const memo = new WeakMap<TypeKind, string[]>();
  const dropFnsOf = (ty: TypeKind): string[] => {
    const hit = memo.get(ty);
    if (hit) return hit;
    const types = new Set<string>();
    for (const t of host.dropTypesIn(ty)) {
      if (t === "<closure-env>") for (const c of captured) types.add(c);
      else if (t === "<interface>") for (const c of byType.keys()) types.add(c);
      else types.add(t);
    }
    const out = [...types].flatMap(t => byType.has(t) ? [byType.get(t)!] : []);
    memo.set(ty, out);
    return out;
  };
  const isFnType = (t: TypeKind | undefined): boolean =>
    !!t && (t.tag === "fn" || t.tag === "cfn" || ((t.tag === "ref" || t.tag === "ptr") && isFnType(t.inner)));
  const isFnTyped = (e: Expr) => isFnType(host.exprTypes.get(e));

  // The Drop fns a closure VALUE may run when it dies, when we know which literals it can
  // be: only what those literals own. Named fns own nothing. Without this, every closure
  // in a program "dropped" whatever any move closure anywhere captured, which rejected
  // `readFile` on a worker thread in dapweb because std's signal pump captures a SignalPipe.
  const closureDrops = (ids: Iterable<string>): string[] => {
    const types = new Set<string>();
    for (const id of ids) { const c = closureById.get(id); if (c) for (const t of ownedDropTypes(c)) types.add(t); }
    return [...types].flatMap(t => byType.has(t) ? [byType.get(t)!] : []);
  };

  const enter = (node: object, scope: Scope) => {
    const n = node as Record<string, unknown> & { kind?: string };
    const s = scope.shadow;
    switch (n.kind) {
      case "LetDecl": case "VarDecl": s.add(n.name as string); break;
      case "ForInStmt": s.add(n.varName as string); if (n.varName2) s.add(n.varName2 as string); break;
      case "LetElseStmt": if (n.bindName) s.add(n.bindName as string); break;
      case "EnumPattern": for (const b of n.bindings as string[]) s.add(b); break;
      case "Closure": for (const p of n.params as { name: string }[]) s.add(p.name); break;
      // A parameter reassigned in the body no longer holds only what callers passed.
      case "Assign": if ((n.target as Expr).kind === "Ident") s.add((n.target as { name: string }).name); break;
      // Every other node binds nothing. A binder missing above would let a local pass
      // as the parameter it shadows, so a new binding form in ast.ts must be added here.
      default: break;
    }
  };

  const closureIds = new Map<ClosureLit, string>();
  const closureById = new Map<string, ClosureLit>();
  const closureScopes = new Map<ClosureLit, Scope>();
  const fnValues = new Set<string>();
  // Context-insensitive parameter sets, aligned to `f.params`; filled by the fixpoint below.
  const paramValues = new Map<string, Values[]>();
  const sites: { call: Expr; callee: string; scope: Scope }[] = [];

  const resolve = (name: string, scope: Scope): Values | undefined => {
    if (scope.shadow.has(name)) return null;
    if (scope.env?.has(name)) return scope.env.get(name)!;
    if (scope.env) return undefined;
    const f = scope.fn !== undefined ? fns.get(scope.fn) : undefined;
    const i = f ? f.params.findIndex(p => p.name === name) : -1;
    return i >= 0 ? paramValues.get(f!.name)?.[i] ?? null : undefined;
  };
  const union = (sets: Values[]): Values => {
    const out = new Set<string>();
    for (const s of sets) { if (s === null) return null; for (const v of s) out.add(v); }
    return out;
  };
  const valuesOf = (e: Expr, scope: Scope): Values => {
    if (e.kind === "Closure") { const id = closureIds.get(e); return id ? new Set([id]) : null; }
    if (e.kind === "Ident") {
      const r = resolve(e.name, scope);
      if (r !== undefined) return r;
      const named = instances.get(e.name);
      return named ? new Set(named) : null;
    }
    return null;
  };
  const isIndirect = (node: object): boolean => {
    const n = node as Expr;
    if (n.kind === "Call") { if (host.closureCalls.has(n) || host.cfnCalls.has(n)) return true; }
    else if (n.kind === "MethodCall") { if (host.fnFieldCalls.has(n) || host.cfnFieldCalls.has(n)) return true; }
    else if (n.kind !== "EnumLit") return false;
    // A builtin or extern handed a fn value calls it where no walk can follow. A
    // closure literal argument is exempt: its body is walked in place.
    const t = calleeOf(n);
    if (t && fns.get(t)?.body) return false;
    return ((n as { args?: Expr[] }).args ?? []).some(a => a.kind !== "Closure" && isFnTyped(a));
  };
  // What a call through a value may run: the call's own variable resolved through the
  // scope, or the fn values a builtin was handed.
  const indirectTargets = (n: Expr, scope: Scope): string[] => {
    let v: Values;
    if (n.kind === "Call" && (host.closureCalls.has(n) || host.cfnCalls.has(n))) v = resolve(n.func, scope) ?? null;
    else if (n.kind === "MethodCall" && (host.fnFieldCalls.has(n) || host.cfnFieldCalls.has(n))) v = null;
    else v = union(((n as { args?: Expr[] }).args ?? []).filter(a => a.kind !== "Closure" && isFnTyped(a)).map(a => valuesOf(a, scope)));
    return v === null ? [INDIRECT] : [...v];
  };
  const implicitTargets = (node: object, scope: Scope): string[] => {
    const n = node as Expr;
    const out: string[] = [];
    if (isIndirect(n)) out.push(...indirectTargets(n, scope));
    if ((n.kind === "Call" && host.cfnCalls.has(n)) || (n.kind === "MethodCall" && host.cfnFieldCalls.has(n))) out.push(FOREIGN);
    const iface = host.interfaceMethodCalls.get(n);
    // Any type's method of that name may sit behind the itable: no per-interface impl
    // list is needed to stay closed.
    if (iface) for (const name of fns.keys()) if (name.endsWith(`$${iface.methodName}`)) out.push(name);
    // A lazy global's first read runs its initializer, wherever that read happens.
    if (n.kind === "Ident" && resolve(n.name, scope) === undefined) {
      const init = view.lazyInits.get(n.name);
      if (init) out.push(init);
    }
    const ty = host.exprTypes.get(n);
    if (n.kind === "Closure") { const id = closureIds.get(n); out.push(...(id ? closureDrops([id]) : ty ? dropFnsOf(ty) : [])); }
    else if (n.kind === "Ident" && ty && isFnType(ty)) { const v = valuesOf(n, scope); out.push(...(v === null ? dropFnsOf(ty) : closureDrops(v))); }
    else if (ty) out.push(...dropFnsOf(ty));
    return out;
  };
  // What a fn's by-value parameters may drop when they die in its body. A fn-typed
  // parameter holds only what its call sites pass, when that set is known.
  const paramDropsOf = (name: string): string[] => {
    const params = host.functions.get(name)?.params ?? [];
    const vals = paramValues.get(name);
    return params.flatMap((p, j) => {
      const v = vals?.[j];
      return isFnType(p.type) && v ? closureDrops(v) : dropFnsOf(p.type);
    });
  };
  // Argument i of a direct call lines up with parameter i, or i+1 for a method call
  // whose receiver is params[0]; anything else is -1 and stays fail closed.
  const offsetFor = (callee: string, call: Expr): number => {
    const f = fns.get(callee);
    const args = (call as { args?: Expr[] }).args ?? [];
    if (!f) return -1;
    return f.params.length === args.length ? 0 : f.params.length === args.length + 1 ? 1 : -1;
  };
  const envFor = (callee: string, call: object, scope: Scope): Map<string, Values> | undefined => {
    const f = fns.get(callee);
    const off = offsetFor(callee, call as Expr);
    if (!f || off < 0) return undefined;
    const args = (call as { args?: Expr[] }).args ?? [];
    const env = new Map<string, Values>();
    f.params.forEach((p, j) => env.set(p.name, j - off >= 0 && isFnTyped(args[j - off]) ? valuesOf(args[j - off], scope) : null));
    return env;
  };

  const collect = (node: unknown, scope: Scope) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) collect(n, scope); return; }
    const n = node as Record<string, unknown> & { kind?: string; name?: unknown };
    if (n.kind === "Closure") {
      const c = n as unknown as ClosureLit;
      const id = `<closure#${closureIds.size}>`;
      closureIds.set(c, id);
      closureById.set(id, c);
      enter(n, scope);
      closureScopes.set(c, { fn: scope.fn, shadow: new Set(scope.shadow) });
    } else enter(n, scope);
    // `Call.func` is a string, so an Ident naming a fn is never the callee position.
    if (n.kind === "Ident" && typeof n.name === "string" && isFnTyped(n as unknown as Expr) && resolve(n.name, scope) === undefined) {
      for (const i of instances.get(n.name) ?? []) fnValues.add(i);
    }
    if ((n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") && !isIndirect(n)) {
      const t = calleeOf(n as unknown as Expr);
      if (t && fns.has(t) && ((n.args as Expr[] | undefined) ?? []).some(isFnTyped)) {
        sites.push({ call: n as unknown as Expr, callee: t, scope: { fn: scope.fn, shadow: new Set(scope.shadow) } });
      }
    }
    for (const k of Object.keys(n)) if (k !== "span") collect(n[k], scope);
  };
  for (const [name, f] of fns) collect(f.body, { fn: name, shadow: new Set() });
  for (const g of program.globals) collect(g.value, { shadow: new Set() });

  // Parameter sets: a fn-typed parameter holds what its direct call sites pass, unless
  // the fn can be called from somewhere no site records. Those get null for every
  // parameter: a fn used as a value, a C entry point, a trait impl method (operators,
  // for-in and Drop call them implicitly), an interface method target.
  const ifaceMethods = new Set([...host.interfaceMethodCalls.values()].map(i => i.methodName));
  const opaque = (name: string, f: Function) =>
    fnValues.has(name) || !!f.attributes?.some(a => a.name === "externalLinkage")
    || f.implTrait !== undefined || [...ifaceMethods].some(m => name.endsWith(`$${m}`));
  for (const [name, f] of fns) {
    const sig = host.functions.get(name);
    paramValues.set(name, f.params.map((_, j) => !opaque(name, f) && isFnType(sig?.params[j]?.type) ? new Set<string>() : null));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const { call, callee, scope } of sites) {
      const slots = paramValues.get(callee)!;
      const off = offsetFor(callee, call);
      const args = (call as { args?: Expr[] }).args ?? [];
      slots.forEach((slot, j) => {
        if (slot === null) return;
        const v = off < 0 ? null : j - off >= 0 && args[j - off] ? valuesOf(args[j - off], scope) : new Set<string>();
        if (v === null) { slots[j] = null; changed = true; return; }
        for (const x of v) if (!slot.has(x)) { slot.add(x); changed = true; }
      });
    }
  }

  const closureScope = (c: ClosureLit): Scope => {
    const s = closureScopes.get(c)!;
    return { fn: s.fn, shadow: new Set(s.shadow) };
  };
  // An unused generic instance (Promise<Res>.blocking, created because Promise<Res> was)
  // still has a body that spawns a thread, and scanning it reported races in code that
  // never runs. Roots are every fn a program can run without a visible call: anything
  // not a generic instance, plus trait impl methods (operators, for-in and Drop call
  // them implicitly) and C entry points.
  let reach: Set<string> | undefined;
  const reachable = (): Set<string> => {
    if (reach) return reach;
    reach = new Set<string>();
    const queue: string[] = [];
    const add = (t: string) => { if (fns.has(t) && !reach!.has(t)) { reach!.add(t); queue.push(t); } };
    const scan = (node: unknown, scope: Scope) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) scan(n, scope); return; }
      const n = node as Record<string, unknown> & { kind?: string };
      enter(n, scope);
      if ((n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") && !isIndirect(n)) {
        const t = calleeOf(n as unknown as Expr);
        if (t) add(t);
      }
      for (const t of implicitTargets(n, scope)) {
        if (t === INDIRECT) for (const v of fnValues) add(v);
        else add(t);
      }
      // A fn named as a value may be called by whoever receives it.
      if (n.kind === "Ident" && typeof n.name === "string" && isFnTyped(n as unknown as Expr)) for (const i of instances.get(n.name) ?? []) add(i);
      for (const k of Object.keys(n)) if (k !== "span") scan(n[k], scope);
    };
    for (const [name, f] of fns) {
      if (!host.isGenericInstance(f) || f.implTrait !== undefined
          || f.attributes?.some(a => a.name === "externalLinkage")) add(name);
    }
    for (const g of program.globals) scan(g.value, { shadow: new Set() });
    while (queue.length) { const t = queue.pop()!; scan(fns.get(t)!.body, { fn: t, shadow: new Set() }); }
    return reach;
  };
  // FFI re-entry. Foreign code can call any `@externalLinkage` fn while it runs, and
  // nothing here can see which routine reaches which entry, so a user-declared extern
  // and a call through a C fn pointer (an addon's function from dlsym) run them all.
  // std's externs are libc, pthread and OS calls that re-enter Milo only through a fn
  // value they are handed, which is already a call through a value; dlopen and dlclose
  // are the exception, since a library's constructors and destructors run inside them.
  // The old rule applied this to EVERY extern for parking only, which was harmless
  // while no entry could park; once a napi entry could, `pthread_mutex_destroy` parked.
  const reentersMilo = (f: Function) =>
    !!f.isExtern && (!host.fnDeclaredInStd(f) || (f.linkName ?? f.name) === "dlopen" || (f.linkName ?? f.name) === "dlclose");
  const model = { implicitTargets, isIndirect, enter, dropFnsOf, paramDropsOf, envFor, fnValues, closureIds, closureById, closureScope, reachable, reentersMilo };
  implicitCache.set(view, model);
  return model;
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
// Which reference parameters may a fn still be looking into when it parks? A `&Vec<T>`
// parameter is only a header pointer, which no realloc moves, but a callee that loops
// over it (or binds a view into it) and parks dangles if the argument was shared and
// another task pushed meanwhile. The caller cannot see that, so this summary answers it:
// fn name -> indices into `params` (receiver included) held across a park, directly or by
// handing the parameter on to a callee that does. Calls through a value that may park
// count as holding every reference argument, since their params are unknowable here.
// fn -> reference parameter index -> where that fn (or a callee it passes the parameter on to)
// holds a view into it across a park, so the caller's error can point at the hazard itself.
export function paramViewsAcrossPark(host: ProgramPassHost, view: ProgramView, parks: Set<string>): Map<string, Map<number, string>> {
  const { fns, rootOf, calleeOf } = view;
  const isRefParam = (t: { isRef: boolean; isRefMut: boolean } | null | undefined) => !!t && (t.isRef || t.isRefMut);
  const held = new Map<string, Map<number, string>>();
  const at = (sp: unknown, what: string) => { const v = sp as Span | undefined; return v ? `${v.file ?? ""}:${v.line}:${v.col}: ${what}` : what; };
  const edges: { from: string; idx: number; to: string; toIdx: number }[] = [];
  // Building an enum value (`JSValue.Number(x)`) never parks; a call in its payload is walked
  // as its own node. Counting it as an indirect call marked milojs's interpreter parameter
  // as held across a park at every `JSValue.Number(st.x)`.
  const mayPark = (n: Record<string, unknown> & { kind?: string }): boolean => {
    if (n.kind !== "Call" && n.kind !== "MethodCall") return false;
    const t = calleeOf(n as unknown as Expr);
    if (t) return parks.has(t);
    return parks.has(INDIRECT);
  };
  const containsPark = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(containsPark);
    const n = node as Record<string, unknown> & { kind?: string };
    if (mayPark(n)) return true;
    for (const k of Object.keys(n)) if (k !== "span" && containsPark(n[k])) return true;
    return false;
  };
  for (const [name, f] of fns) {
    if (!f.body) continue;
    const idxOf = new Map<string, number>();
    f.params.forEach((p, i) => { if (isRefParam(p.type)) idxOf.set(p.name, i); });
    if (idxOf.size === 0) continue;
    const mark = new Map<number, string>();
    held.set(name, mark);
    const hold = (p: number, sp: unknown, what: string) => { if (!mark.has(p)) mark.set(p, at(sp, what)); };
    const pIdx = (e: unknown) => { const r = rootOf(e); return r !== undefined ? idxOf.get(r) : undefined; };
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        // A view binding rooted at a parameter stays live to the end of its block.
        node.forEach((s, i) => {
          walk(s);
          const d = s as Record<string, unknown> & { kind?: string };
          if ((d?.kind === "LetDecl" || d?.kind === "VarDecl") && d.value && host.exprTypes.get(d.value as Expr)?.tag === "ref") {
            const v = d.value as Expr;
            const p = pIdx(v.kind === "MethodCall" ? v.object : v);
            if (p !== undefined && containsPark(node.slice(i + 1))) hold(p, d.span, "a view bound here lives across a park");
          }
        });
        return;
      }
      const n = node as Record<string, unknown> & { kind?: string };
      if (n.kind === "ForInStmt") {
        const p = pIdx(n.iterable);
        if (p !== undefined && containsPark(n.body)) hold(p, n.span, "a for-in over it parks inside the loop");
      }
      if (n.kind === "Call" || n.kind === "MethodCall" || n.kind === "EnumLit") {
        const args = (n.args as Expr[] | undefined) ?? [];
        const t = calleeOf(n as unknown as Expr);
        const callee = t ? fns.get(t) : undefined;
        const off = !callee ? -1 : callee.params.length === args.length ? 0 : callee.params.length === args.length + 1 ? 1 : -1;
        const pairs: [number, unknown][] = args.map((a, i) => [i + off, a]);
        if (n.kind === "MethodCall" && off === 1) pairs.unshift([0, n.object]);
        for (const [j, a] of pairs) {
          const p = pIdx(a);
          if (p === undefined) continue;
          if (callee && off >= 0) {
            if (isRefParam(callee.params[j]?.type)) edges.push({ from: name, idx: p, to: t!, toIdx: j });
          } else if (mayPark(n)) hold(p, n.span, "passed to a call that may park");
        }
      }
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
    };
    walk(f.body);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const e of edges) {
      const origin = held.get(e.to)?.get(e.toIdx);
      if (origin === undefined) continue;
      const m = held.get(e.from)!;
      if (!m.has(e.idx)) { m.set(e.idx, origin); changed = true; }
    }
  }
  return held;
}

// The global borrow invalidation check lives in src/checker-global-borrow-host.ts; re-exported so
// the checker keeps importing it from here.
export { checkGlobalBorrowInvalidation } from "./checker-global-borrow-host";
