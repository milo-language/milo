// Lazy module globals: the HIR pass that puts a first-use guard in front of every read.
//
// A module-level `let`/`var` whose initializer is not a compile-time constant is emitted
// zeroed and filled on first access, exactly once (codegen's `__milo.lazyinit.<G>` runs the
// initializer; `__milo.lazy.<G>` is the guarded entry). This pass decides WHERE the guard
// goes: in front of each statement that mentions the global, in the innermost statement
// list that holds the mention. So `if c { print(G) }` initializes G only when `c` holds,
// while `c && G.len > 0` initializes it before the statement runs, short-circuit or not.
// Statement granularity is deliberate: by the time the statement starts, no borrow it
// creates is live yet, so an initializer that runs code cannot invalidate one.
//
// The mention test is by name and ignores scoping. A param that shares a global's name
// only costs an unneeded (idempotent) guard; missing a real read would hand out the zeroed
// slot, so over-approximating is the safe side.

import type { HIRFunction, HIRStmt } from "./hir";

export const LAZY_GUARD_PREFIX = "__milo.lazy.";
export const LAZY_INIT_PREFIX = "__milo.lazyinit.";

// HIR statement kinds: an array whose elements carry one of these is a statement list,
// which gets its own guards rather than lifting them to the enclosing statement.
const STMT_KINDS = new Set([
  "Let", "Assign", "Return", "If", "While", "Break", "Continue", "ExprStmt", "Match",
  "UnsafeBlock", "Block", "NullRefUnwrap", "ForRange", "ForEach", "ForIterator", "ForStrView",
  "LazyGlobalInit",
]);

function isStmtList(v: unknown): v is HIRStmt[] {
  return Array.isArray(v) && v.length > 0 && v.every(x => x !== null && typeof x === "object" && STMT_KINDS.has((x as { kind?: string }).kind ?? ""));
}

// The lazy globals `node` mentions outside any nested statement list (those are guarded
// on their own). Each nested list found is handed to `inner`.
function mentions(node: unknown, lazy: ReadonlySet<string>, out: Set<string>, inner: (list: HIRStmt[]) => void, skip?: unknown): void {
  if (node === null || typeof node !== "object" || node === skip) return;
  if (Array.isArray(node)) {
    if (isStmtList(node)) { inner(node); return; }
    for (const x of node) mentions(x, lazy, out, inner, skip);
    return;
  }
  const n = node as Record<string, unknown>;
  // A TypeKind (`tag`, no `kind`) holds no expressions, and a recursive type can be cyclic.
  if (typeof n.tag === "string" && n.kind === undefined) return;
  if (n.kind === "Ident" && typeof n.name === "string" && lazy.has(n.name)) out.add(n.name);
  for (const k in n) if (k !== "span") mentions(n[k], lazy, out, inner, skip);
}

function guardList(list: HIRStmt[], lazy: ReadonlySet<string>): void {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.kind === "LazyGlobalInit") continue;
    const found = new Set<string>();
    // The initializer's own `G = value` writes the slot being filled: guarding that target
    // would make every initializer wait on itself.
    const skip = s.kind === "Assign" && s.isInit ? s.target : undefined;
    mentions(s, lazy, found, l => guardList(l, lazy), skip);
    if (found.size === 0) continue;
    const guards: HIRStmt[] = [...found].map(name => ({ kind: "LazyGlobalInit", name, span: s.span }));
    list.splice(i, 0, ...guards);
    i += guards.length;
  }
}

// Guards every function body, plus whatever a function evaluates outside its body: its
// contracts and `old(...)` snapshots run at entry, so their globals are guarded there.
// Returns the globals that got at least one guard: the ones something reads.
export function guardLazyGlobals(fns: HIRFunction[], lazy: ReadonlySet<string>): Set<string> {
  const read = new Set<string>();
  if (lazy.size === 0) return read;
  for (const fn of fns) {
    if (fn.isExtern) continue;
    guardList(fn.body, lazy);
    const atEntry = new Set<string>();
    const noList = () => {};
    mentions(fn.contracts, lazy, atEntry, noList);
    mentions(fn.oldSnapshots, lazy, atEntry, noList);
    if (atEntry.size > 0) fn.entryGuards = [...atEntry];
    for (const g of atEntry) read.add(g);
    collectGuards(fn.body, read);
  }
  return read;
}

function collectGuards(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const x of node) collectGuards(x, out); return; }
  const n = node as Record<string, unknown>;
  if (typeof n.tag === "string" && n.kind === undefined) return;
  if (n.kind === "LazyGlobalInit" && typeof n.name === "string") out.add(n.name);
  for (const k in n) if (k !== "span") collectGuards(n[k], out);
}
