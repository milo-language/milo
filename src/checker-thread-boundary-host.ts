// The boundary between the checker and the portable thread-boundary pass
// (src/checker-thread-boundary.ts). The checker keys call resolution, expression types, closure
// captures and the Send rules by object; this file numbers every node of each function body, global
// initializer and closure literal body in the walker's pre-order and restates what the pass needs
// as plain data keyed by that id. Which fns are `@thread` entries or `@synchronized` critical
// sections, what each node writes and which Drop fns a node may run are scope-free checker facts
// and are computed here; what a name holds at a call site is the pass's (ImplicitModel's) job.
import type { Program, Expr, Span } from "./ast";
import { collectStmts, collectExpr, type AnyNode } from "./ast-nodes";
import {
  implicitCalls, mutatesReceiver, sayCallee,
  type ProgramPassHost, type ProgramView,
} from "./checker-program-passes";
import type { FnFact, NodeFact, ArgFact } from "./checker-implicit-calls";
import {
  threadBoundaryFindings,
  type BodyTask, type EntryFact, type SayFact, type SendFact, type ThreadInput,
} from "./checker-thread-boundary";
import type { TypeKind } from "./types";

// Test hook (scripts/ts2milo-thread-boundary-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: ThreadInput) => void) | undefined;
export function setThreadBoundaryCapture(f: ((input: ThreadInput) => void) | undefined): void { captureInput = f; }

const isFnType = (t: TypeKind | undefined): boolean =>
  !!t && (t.tag === "fn" || t.tag === "cfn" || ((t.tag === "ref" || t.tag === "ptr") && isFnType(t.inner)));

// Which functions hand a closure to a real OS thread? They say so themselves, with
// `@thread` on the declaration in std. The two hardcoded copies this replaced had already
// drifted apart: the `Thread` tier was deleted and its arm stayed behind guarding a type
// that no longer exists, while `spawnOsThreadDetached`, added after both, never got an arm,
// so the *same* fixture that errors on `Promise.blocking` compiled clean and shipped a
// pointer into a dead frame to another thread. A list the declarations own cannot drift
// from the declarations.
//
// A `var` global is unsynchronized shared memory, and `Sync` is the wrong question to ask
// about it: `i64` is perfectly Sync while the hazard is the *write*. The synchronized way to
// hold shared mutable state is a `let` global of a cell that mutates through `&self`
// (AtomicI64, Channel, Once), so `var` plus a thread is always the bug. `@synchronized` marks
// a method whose closure argument is a critical section: the primitive provides the mutual
// exclusion and the happens-before edge, so a global written in there is not racing.
export function checkThreadBoundary(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const { fns, rootOf, calleeOf: target } = view;
  const hasAttr = (t: string | undefined, a: string) => !!t && !!fns.get(t)?.attributes?.some(x => x.name === a);
  if (![...fns.values()].some(f => f.attributes?.some(a => a.name === "thread"))) return;

  const mutableGlobals: string[] = [];
  for (const g of program.globals) if (g.mutable && !g.threadLocal) mutableGlobals.push(g.name);
  const stdGlobals = program.globals.filter(g => g.span?.file?.includes("/std/")).map(g => g.name);
  const implicit = implicitCalls(host, program, view);

  const ifaceMethods = new Set([...host.interfaceMethodCalls.values()].map(i => i.methodName));
  const fnFacts: FnFact[] = [];
  for (const [name, f] of fns) {
    const sig = host.functions.get(name);
    const external = !!f.attributes?.some(a => a.name === "externalLinkage");
    fnFacts.push({
      name, sourceName: f.sourceName ?? "", params: f.params.map(p => p.name),
      paramFnTyped: f.params.map((_, j) => isFnType(sig?.params[j]?.type)),
      opaque: external || f.implTrait !== undefined || [...ifaceMethods].some(m => name.endsWith(`$${m}`)),
      root: !host.isGenericInstance(f) || f.implTrait !== undefined || external,
    });
  }

  // Number every node: fn bodies, then global initializers, then each closure body at the id
  // right after its literal (a closure's children are its body, so the ids line up).
  type Owner = { nodes: AnyNode[]; base: number };
  const owners: Owner[] = [];
  const tasks: BodyTask[] = [];
  let total = 0;
  const addOwner = (nodes: AnyNode[]) => { owners.push({ nodes, base: total }); total += nodes.length; };
  for (const [name, f] of fns) {
    if (f.isExtern || !f.body) continue;
    const nodes: AnyNode[] = [];
    collectStmts(f.body, nodes);
    tasks.push({ kind: 0, body: f.body, value: [], base: total, name, nodeId: -1, params: f.params.map(p => p.name) });
    addOwner(nodes);
  }
  for (const g of program.globals) {
    const nodes: AnyNode[] = [];
    if (g.value) collectExpr(g.value, nodes);
    tasks.push({ kind: 1, body: [], value: g.value ? [g.value] : [], base: total, name: "", nodeId: -1, params: [] });
    addOwner(nodes);
  }
  const idOf = new Map<object, number>();
  const closures: { id: number; lit: Extract<Expr, { kind: "Closure" }> }[] = [];
  for (const { nodes, base } of owners) {
    nodes.forEach((n, i) => {
      idOf.set(n, base + i);
      if (n.kind === "Closure") closures.push({ id: base + i, lit: n });
    });
  }
  for (const { id, lit } of closures) {
    tasks.push({ kind: 2, body: lit.body, value: [], base: id + 1, name: "", nodeId: id, params: lit.params.map(p => p.name) });
  }

  // A closure handed straight to a critical section runs only inside it.
  const critArgs = new Set<object>();
  for (const { nodes } of owners) for (const n of nodes) {
    if ((n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall") && hasAttr(target(n), "synchronized")) {
      for (const a of n.args) if (a.kind === "Closure") critArgs.add(a);
    }
  }

  // The globals a node writes: an assignment's root, a mutating method's receiver, and an
  // argument passed to a `&mut` parameter (the `&mut` marker is already stripped, so the
  // argument roots directly). A method's receiver is params[0], so its args shift by one when
  // the signature has one more param than the call has args.
  const writeRoots = (n: AnyNode): string[] => {
    const out: (string | undefined)[] = [];
    if (n.kind === "Assign") out.push(rootOf(n.target));
    if (n.kind === "MethodCall" && mutatesReceiver(host, n)) out.push(rootOf(n.object));
    if (n.kind === "Call" || n.kind === "MethodCall") {
      const t = target(n);
      const params = t ? host.functions.get(t)?.params : undefined;
      if (params) {
        const shift = n.kind === "MethodCall" && params.length === n.args.length + 1 ? 1 : 0;
        n.args.forEach((a, i) => {
          const p = params[i + shift]?.type;
          if (p?.tag === "ref" && p.mutable) out.push(rootOf(a));
        });
      }
    }
    return out.filter((r): r is string => r !== undefined);
  };
  const binds = (n: AnyNode): string[] => {
    switch (n.kind) {
      case "LetDecl": case "VarDecl": return [n.name];
      case "ForInStmt": return n.varName2 ? [n.varName, n.varName2] : [n.varName];
      case "LetElseStmt": return n.bindName ? [n.bindName] : [];
      case "EnumPattern": return [...n.bindings];
      case "Closure": return n.params.map(p => p.name);
      case "Assign": return n.target.kind === "Ident" ? [n.target.name] : [];
      default: return [];
    }
  };

  const facts: NodeFact[] = [];
  const says = new Map<string, string>();
  for (const name of fns.keys()) says.set(name, sayCallee(view, name, implicit));
  const noScope = () => ({ shadow: new Set<string>() });
  for (const { nodes, base } of owners) {
    nodes.forEach((n, i) => {
      const expr = n as Expr;
      const callish = n.kind === "Call" || n.kind === "EnumLit" || n.kind === "MethodCall";
      const ty = host.exprTypes.get(expr);
      const f: NodeFact = {
        id: base + i, span: (n as { span?: Span }).span, binds: binds(n),
        declares: n.kind === "LetDecl" || n.kind === "VarDecl" ? n.name : "",
        closure: n.kind === "Closure", callish, indirectMode: 0,
        cfn: (n.kind === "Call" && host.cfnCalls.has(n)) || (n.kind === "MethodCall" && host.cfnFieldCalls.has(n)),
        fnTyped: isFnType(ty), ident: n.kind === "Ident" ? n.name : "", func: n.kind === "Call" ? n.func : "",
        callee: callish ? target(n) ?? "" : "", iface: host.interfaceMethodCalls.get(expr)?.methodName ?? "",
        lazyInit: n.kind === "Ident" ? view.lazyInits.get(n.name) ?? "" : "",
        critical: callish && hasAttr(target(n), "synchronized"), critArg: critArgs.has(n),
        entry: (n.kind === "Call" || n.kind === "EnumLit") && hasAttr(target(n), "thread") ? target(n)! : "",
        drops: ty ? implicit.dropFnsOf(ty) : [],
        ownDrops: n.kind === "Closure" ? implicit.implicitTargets(n, noScope()) : [],
        writes: writeRoots(n),
        args: callish ? n.args.map((a): ArgFact => ({
          id: idOf.get(a) ?? -1, closure: a.kind === "Closure", ident: a.kind === "Ident" ? a.name : "",
          fnTyped: isFnType(host.exprTypes.get(a)),
        })) : [],
      };
      if (callish && implicit.isIndirect(n)) {
        f.indirectMode = n.kind === "Call" && (host.closureCalls.has(n) || host.cfnCalls.has(n)) ? 1
          : n.kind === "MethodCall" && (host.fnFieldCalls.has(n) || host.cfnFieldCalls.has(n)) ? 2 : 3;
      }
      if (f.lazyInit !== "" && !says.has(f.lazyInit)) says.set(f.lazyInit, sayCallee(view, f.lazyInit, implicit));
      // A node with nothing to say is left out; the pass treats a missing fact as an empty one.
      if (f.binds.length || f.declares || f.closure || f.callish || f.ident || f.drops.length || f.writes.length) facts.push(f);
    });
  }

  // The closure literals handed to a thread entry: Send errors for what they capture, and the
  // replay warning for memory shared through a raw pointer or an `unsafe` block.
  const lits = new Map<number, Extract<Expr, { kind: "Closure" }>>();
  const entries: EntryFact[] = [];
  const closureOf = new Map(closures.map(c => [c.id, c.lit]));
  for (const f of facts) {
    if (f.entry === "") continue;
    for (const a of f.args) {
      const lit = closureOf.get(a.id);
      if (!a.closure || !lit) continue;
      const sends: SendFact[] = [];
      for (const cap of host.closureCaptures.get(lit) ?? []) {
        if (host.isSend(cap.type)) continue;
        sends.push({
          message: `cannot send '${cap.name}' of type '${host.show(cap.type)}' across threads — type does not implement Send`,
          hint: host.whyNotSend(cap.type), span: lit.span,
        });
      }
      let rawMessage = "";
      let rawHint = "";
      if (lit.span?.file && !lit.span.file.includes("/std/")) {
        const raw = (host.closureCaptures.get(lit) ?? []).find(c => host.userRawPointerType(c.type));
        if (raw || hasUnsafeBlock(lit.body)) {
          const why = raw ? `it captures '${raw.name}', which carries a raw pointer` : `its body has an 'unsafe' block`;
          rawMessage = `this closure runs on an OS thread and ${why}: memory shared that way is not ordered under record/replay`;
          rawHint = `share state between threads through std/sync (Channel, AtomicI64, WaitGroup, Once), which record/replay orders`;
        }
      }
      lits.set(a.id, lit);
      entries.push({ id: a.id, span: lit.span, sends, rawMessage, rawHint });
    }
  }

  const sayList: SayFact[] = [...says].map(([name, text]) => ({ name, text }));
  const input: ThreadInput = { tasks, fns: fnFacts, facts, entries, says: sayList, globals: mutableGlobals, stdGlobals };
  if (captureInput) captureInput(input);
  for (const f of threadBoundaryFindings(input)) {
    if (f.level === 0) host.error(f.message, f.span, f.hint);
    else {
      host.warn(f.code, f.message, f.span, f.hint);
      const lit = lits.get(f.ref);
      if (lit) host.replayRawShares.set(lit, host.replaySiteOf(lit.span));
    }
  }
}

function hasUnsafeBlock(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasUnsafeBlock);
  if ((node as { kind?: string }).kind === "UnsafeBlock") return true;
  for (const [k, v] of Object.entries(node)) if (k !== "span" && hasUnsafeBlock(v)) return true;
  return false;
}
