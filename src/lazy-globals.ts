// Lazy module globals: where the first-use guard goes in front of a read.
//
// A module-level `let`/`var` whose initializer is not a compile-time constant is emitted
// zeroed and filled on first access, exactly once (codegen's `__milo.lazyinit.<G>` runs the
// initializer; `__milo.lazy.<G>` is the guarded entry). This decides WHERE the guard goes:
// in front of each statement that mentions the global, in the innermost statement list that
// holds the mention. So `if c { print(G) }` initializes G only when `c` holds, while
// `c && G.len > 0` initializes it before the statement runs, short-circuit or not.
// Statement granularity is deliberate: by the time the statement starts, no borrow it
// creates is live yet, so an initializer that runs code cannot invalidate one.
//
// The mention test is by name and ignores scoping. A param that shares a global's name
// only costs an unneeded (idempotent) guard; missing a real read would hand out the zeroed
// slot, so over-approximating is the safe side.

import type { Contract, Stmt } from "./ast";

export const LAZY_GUARD_PREFIX = "__milo.lazy.";
export const LAZY_INIT_PREFIX = "__milo.lazyinit.";

const STMT_KINDS = new Set([
  "LetDecl", "VarDecl", "Assign", "Return", "IfStmt", "WhileStmt", "ExprStmt", "MatchStmt", "BreakStmt",
  "ContinueStmt", "IfLetStmt", "IfChainStmt", "LetElseStmt", "UnsafeBlock", "ForInStmt",
]);

// An array whose elements are statements is a statement list, guarded on its own.
function isStmtList(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every(x => x !== null && typeof x === "object" && STMT_KINDS.has((x as { kind?: string }).kind ?? ""));
}

/**
 * The lazy globals `node` mentions outside any statement list nested in it (each of those
 * is guarded where it runs). With `all`, nested lists count too.
 */
export function lazyMentions(node: unknown, lazy: ReadonlySet<string>, out: Set<string> = new Set(), all = false): Set<string> {
  if (lazy.size === 0 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    if (!all && isStmtList(node)) return out;
    for (const x of node) lazyMentions(x, lazy, out, all);
    return out;
  }
  const n = node as Record<string, unknown>;
  if (n.kind === "Ident" && typeof n.name === "string" && lazy.has(n.name)) out.add(n.name);
  for (const k in n) if (k !== "span" && k !== "type" && k !== "retType" && k !== "targetType") lazyMentions(n[k], lazy, out, all);
  return out;
}

/** The guards in front of statement `s`: what it mentions outside its nested lists. */
export function stmtGuards(s: Stmt, lazy: ReadonlySet<string>): string[] {
  return [...lazyMentions(s, lazy)];
}

/**
 * What a function evaluates outside its body (its requires/ensures clauses and their
 * `old(...)` snapshots, at entry) mentions: initialized there.
 */
export function entryGuards(contracts: Contract[] | undefined, lazy: ReadonlySet<string>): string[] {
  return [...lazyMentions((contracts ?? []).filter(c => c.kind === "requires" || c.kind === "ensures").map(c => c.expr), lazy)];
}
