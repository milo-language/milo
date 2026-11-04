// `noalias` on `&mut` parameters, decided on the HIR.
//
// `noalias` on a `&mut` parameter promises LLVM that, for the whole call, the pointee is
// reached only through that parameter. The checker's call-site exclusivity check (every
// call form, receivers and moved arguments included) plus the runtime alias guards rule out
// a second PARAMETER naming the storage. Two routes remain in safe code, and the attribute
// is withheld wherever either can occur:
//   - a mutable global G: `f(&mut G)` where f, or anything it may call, also reads or
//     writes G by name. A by-ref argument "reaches G" when its place is rooted at G, or at
//     a by-ref parameter that reaches G; reach flows from call arguments into callee
//     params. A place rooted at a binding that may be a reference into another place (a
//     for-in or match binding, a closure capture) reaches every mutable global. A place
//     that reaches G and is handed to code that may keep it (an indirect call, a C call
//     that retains pointers or calls back) makes G reach every param in the module.
//   - a closure body: its environment points at the creator's locals, so it can write what
//     a `&mut` argument points at (`f(&mut n, () => { n = n + 1 })`). A function that may
//     run one (directly or through an indirect call) gets no noalias at all.
// "May call" follows direct calls (and the drop glue's calls of user Drop impls), and sends
// an indirect call to every address-taken fn. A C call goes there too (C can only call back
// what it was handed, or an exported symbol) unless it is a libc/OS function std declares
// and that is not in CALLBACK_LIBC. An extern the PROGRAM declares may be any C library and
// is assumed to call back. Raw pointers built in unsafe code are not tracked: an aliasing
// `*T` is the user's responsibility, as it is everywhere else.
import { resolve } from "path";
import type { HIRArg, HIRExpr, HIRFunction } from "./hir";
import type { TypeKind } from "./types";
import { STDLIB_DIR } from "./stdlibBundle";

const CALLBACK_LIBC = new Set([
  "pthread_create", "pthread_once", "makecontext", "swapcontext", "setcontext", "atexit",
  "on_exit", "exit", "signal", "sigaction", "raise", "kill", "qsort", "bsearch", "dlopen",
  "dlclose", "fork",
]);
// libc/OS calls std makes that hold on to a pointer argument past the call (a stdio buffer,
// an event's udata, a thread or context argument, a handler). Any other std libc call only
// uses its pointers while it runs.
export const RETAINING_LIBC: ReadonlySet<string> = new Set([
  "setvbuf", "setbuf", "kevent", "kevent64", "epoll_ctl", "pthread_create", "makecontext",
  "sigaction", "signal", "atexit", "on_exit", "aio_read", "aio_write", "io_uring_enter",
]);
// Option/Result ops whose operand is a closure the op calls.
const CALLBACK_OPS = new Set(["map", "optionAndThen", "optionOrElse", "resultMap", "resultMapErr", "unwrapOrElse", "resultAndThen", "resultOrElse", "resultUnwrapOrElse", "resultContext"]);
const INDIRECT_KINDS = new Set(["ClosureCall", "InterfaceMethodCall", "CFnCall"]);
// Places a by-ref argument can be rooted at, outermost first.
const PLACE_KINDS = new Set(["FieldAccess", "IndexAccess", "HeapDeref", "Cast"]);

// `--no-noalias` (main.ts) sets MILO_NOALIAS=0 to rule it out when chasing a miscompile. An
// environment variable so the flag reaches every compile path (`milo run`/`test`, separately
// compiled modules) without threading through each signature.
export const noaliasEnabled = (): boolean => process.env.MILO_NOALIAS !== "0";

export interface NoaliasInput {
  /** Every compiled function, init functions included. */
  functions: HIRFunction[];
  externs: ReadonlyMap<string, HIRFunction>;
  mutableGlobals: ReadonlySet<string>;
  exported: ReadonlySet<string>;
  /** Globals a replay-engine function touches on entry and exit (emit-mlir milo.replay.*). */
  replayGlobals: readonly string[];
  /** Whether a type's drop runs a user Drop impl, and whether it can run arbitrary code (an interface's or a closure's). */
  dropRuns(t: TypeKind): { user: boolean; unknown: boolean };
}

type Node = {
  byRefClosure: boolean;
  callees: Set<string>;
  sites: { callee: string; args: HIRArg[]; extern: boolean }[];
  indirect: boolean;
  callsC: boolean;
  touches: Set<string>;
  params: Map<string, number>;
  // Bindings whose place is fresh storage of this body: a by-value param, a let/var.
  fresh: Set<string>;
  paramReach: Set<string>[];
};

/** For each fn, the indices of its params in `candidates` that may be noalias. */
export function noaliasGrants(input: NoaliasInput, candidates: ReadonlyMap<string, number[]>): Map<string, Set<number>> {
  const granted = new Map<string, Set<number>>();
  if (!noaliasEnabled() || candidates.size === 0) return granted;
  const fns = new Map(input.functions.map(f => [f.name, f]));
  const stdPrefix = resolve(STDLIB_DIR, "std") + "/";
  const callsBack = (name: string): boolean => {
    const f = input.externs.get(name);
    const sym = f?.linkName ?? name;
    if (CALLBACK_LIBC.has(sym)) return true;
    return !!f && !(f.sourceFile ?? "").startsWith(stdPrefix);
  };
  const keepsPointers = (name: string) => RETAINING_LIBC.has(input.externs.get(name)?.linkName ?? name) || callsBack(name);
  const dropFns = input.functions.filter(f => f.name.endsWith("$Drop$drop")).map(f => f.name);
  const allGlobals = new Set(input.mutableGlobals);

  const nodes = new Map<string, Node>();
  const addrTaken = new Set<string>(input.exported);
  const hookTargets = new Set<string>();
  let hookOpaque = false;
  let closures = 0;

  const build = (name: string, params: { name: string; isRef?: boolean; isRefMut?: boolean }[], body: unknown, byRefClosure: boolean, replay: boolean) => {
    const n: Node = {
      byRefClosure, callees: new Set(), sites: [], indirect: false, callsC: false, touches: new Set(),
      params: new Map(), fresh: new Set(), paramReach: params.map(() => new Set()),
    };
    params.forEach((p, i) => { if (p.isRef || p.isRefMut) n.params.set(p.name, i); else n.fresh.add(p.name); });
    if (replay) for (const g of input.replayGlobals) if (input.mutableGlobals.has(g)) n.touches.add(g);
    nodes.set(name, n);
    const seenTypes = new WeakSet<object>();
    const walk = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      const o = v as Record<string, unknown> & { kind?: string };
      // A TypeKind: the drops of a value of it may run user code.
      if (typeof o.tag === "string" && o.kind === undefined) {
        if (seenTypes.has(o)) return;
        seenTypes.add(o);
        const d = input.dropRuns(o as unknown as TypeKind);
        if (d.unknown) n.indirect = true;
        if (d.user) for (const f of dropFns) n.callees.add(f);
        return;
      }
      if (o.kind === "Closure") {
        const c = o as unknown as HIRExpr & { kind: "Closure" };
        const cname = `${name}#closure${closures++}`;
        addrTaken.add(cname);
        build(cname, c.params, c.body, !c.isMove, false);
        if (c.type) walk(c.type);
        return;
      }
      if (o.kind === "Let" && typeof o.name === "string") n.fresh.add(o.name);
      if (o.kind === "Ident" && typeof o.name === "string") {
        if (input.mutableGlobals.has(o.name)) n.touches.add(o.name);
        if (fns.has(o.name)) addrTaken.add(o.name);
      }
      if (o.kind && INDIRECT_KINDS.has(o.kind)) n.indirect = true;
      if (o.kind === "OptionOp" && CALLBACK_OPS.has(o.op as string)) n.indirect = true;
      if (o.kind === "LazyGlobalInit" && typeof o.name === "string") n.callees.add(`__milo.lazyinit.${o.name}`);
      if (o.kind === "Call" && typeof o.func === "string") {
        const args = (o.args ?? []) as HIRArg[];
        if (o.func === "_callClosureVoid") n.indirect = true;
        else if (o.func === "_panicHookSet") {
          let e: HIRExpr | undefined = args[0]?.expr;
          while (e?.kind === "Cast") e = e.operand;
          if (e?.kind === "Ident" && fns.has(e.name)) hookTargets.add(e.name);
          else hookOpaque = true;
        } else if (fns.has(o.func)) {
          n.callees.add(o.func);
          n.sites.push({ callee: o.func, args, extern: false });
        } else if (input.externs.has(o.func)) {
          if (callsBack(o.func)) n.callsC = true;
          n.sites.push({ callee: o.func, args, extern: true });
        }
      }
      for (const [k, x] of Object.entries(o)) {
        if (k === "span") continue;
        // A helper the lowering calls by name (`messageFn`, `cloneFn`): a direct call.
        if (typeof x === "string" && k !== "name" && k !== "func" && fns.has(x)) n.callees.add(x);
        else walk(x);
      }
    };
    walk(body);
  };
  for (const f of input.functions) build(f.name, f.params, [f.body, f.contracts, f.oldSnapshots], false, !!f.replayEngine);
  // A param's drop at the function's exit runs its type's glue.
  for (const f of input.functions) {
    const n = nodes.get(f.name)!;
    for (const p of f.params) {
      if (p.isRef || p.isRefMut) continue;
      const d = input.dropRuns(p.type);
      if (d.unknown) n.indirect = true;
      if (d.user) for (const df of dropFns) n.callees.add(df);
    }
  }

  // Panic sites call through the panic hook: every fn may call what _panicHookSet stored.
  for (const n of nodes.values()) {
    if (hookOpaque) n.indirect = true;
    else for (const t of hookTargets) n.callees.add(t);
  }

  // Reach: which mutable globals a by-ref argument's place may be part of.
  const wild = new Set<string>();
  const rootOf = (e: HIRExpr): HIRExpr => {
    let cur = e;
    for (;;) {
      if (!PLACE_KINDS.has(cur.kind)) return cur;
      const c = cur as HIRExpr & { object?: HIRExpr; operand?: HIRExpr };
      const next = c.object ?? c.operand;
      if (!next) return cur;
      cur = next;
    }
  };
  const reachOf = (n: Node, a: HIRArg): Set<string> => {
    if (!a.passByRef) return new Set();
    const root = rootOf(a.expr);
    if (root.kind !== "Ident") return new Set();
    if (input.mutableGlobals.has(root.name) && !n.params.has(root.name) && !n.fresh.has(root.name)) return new Set([root.name]);
    const p = n.params.get(root.name);
    if (p !== undefined) return n.paramReach[p];
    return n.fresh.has(root.name) ? new Set() : allGlobals;
  };
  const queue = [...nodes.keys()];
  const queued = new Set(queue);
  while (queue.length) {
    const name = queue.shift()!;
    queued.delete(name);
    const n = nodes.get(name)!;
    for (const s of n.sites) {
      s.args.forEach((a, i) => {
        const r = reachOf(n, a);
        if (r.size === 0) return;
        if (s.extern) {
          if (keepsPointers(s.callee)) for (const g of r) wild.add(g);
          return;
        }
        const c = nodes.get(s.callee)!;
        if (i >= c.paramReach.length) return;
        let grew = false;
        for (const g of r) if (!c.paramReach[i].has(g)) { c.paramReach[i].add(g); grew = true; }
        if (grew && !queued.has(s.callee)) { queued.add(s.callee); queue.push(s.callee); }
      });
    }
  }
  // An indirect call can be handed any reachable place: those globals go wild.
  for (const n of nodes.values()) {
    if (!n.indirect) continue;
    for (const r of n.paramReach) for (const g of r) wild.add(g);
  }

  const byRef = new Set([...nodes].filter(([, n]) => n.byRefClosure).map(([k]) => k));
  for (const n of nodes.values()) {
    if (n.indirect) for (const t of addrTaken) n.callees.add(t);
    else if (n.callsC) for (const t of addrTaken) if (!byRef.has(t)) n.callees.add(t);
  }
  const opaque = new Set(byRef);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, n] of nodes) {
      for (const c of n.callees) {
        const cn = nodes.get(c);
        if (!cn) continue;
        if (!opaque.has(name) && opaque.has(c)) { opaque.add(name); changed = true; }
        for (const g of cn.touches) if (!n.touches.has(g)) { n.touches.add(g); changed = true; }
      }
    }
  }
  const debug = !!process.env.MILO_NOALIAS_DEBUG;
  for (const [name, params] of candidates) {
    const n = nodes.get(name);
    if (!n) continue;
    const ok = new Set<number>();
    for (const k of params) {
      const clash = [...n.paramReach[k] ?? []].filter(g => n.touches.has(g));
      const why = opaque.has(name) ? "may run a closure or unknown code"
        : wild.size ? `address of ${[...wild].slice(0, 3).join(",")} escapes untracked`
        : clash.length ? `reaches and touches ${clash.slice(0, 3).join(",")}` : "";
      if (debug) console.error(`noalias ${name} #${k}: ${why ? `withheld (${why})` : "applied"}`);
      if (!why) ok.add(k);
    }
    if (ok.size) granted.set(name, ok);
  }
  return granted;
}
