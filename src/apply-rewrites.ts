// The one place the checker's recorded rewrites reach the AST. The checker records `old -> new` in
// `rewrites` (and `patternRewrites`) and never writes a node; `applyRewrites` then makes the tree hold
// the new shape in the old objects, so every later reader (the whole-program passes, the emitter, the
// interpreter, the LSP) sees the tree as if the checker had edited it, with no `rewritten` lookups.
// Not translated to Milo: it writes AST nodes, which is exactly what the checker files must not do.
import { applyWindow } from "./ast-oracle";

type Table = Map<object, unknown> | Set<object>;

// `old` -> the nodes of its chain `old -> a -> b` after it (oldest first).
function chains(rewrites: Map<object, object>): Map<object, object[]> {
  const out = new Map<object, object[]>();
  for (const [t, first] of rewrites) {
    const path: object[] = [];
    let cur: object | undefined = first;
    while (cur !== undefined && !path.includes(cur)) { path.push(cur); cur = rewrites.get(cur); }
    out.set(t, path);
  }
  return out;
}

// A fact filed under a replacement is also filed under the node the tree holds. When both have one, the
// replacement's wins (later in the chain overrides). The replacement's own entry stays.
function refile(table: Table, chain: Map<object, object[]>): void {
  for (const [t, path] of chain) {
    for (const n of path) {
      if (table instanceof Set) { if (table.has(n)) table.add(t); }
      else if (table.has(n)) table.set(t, table.get(n));
    }
  }
}

function eachTable(owner: Record<string, unknown>, skip: Set<unknown>, visit: (t: Table) => void): void {
  for (const v of Object.values(owner)) {
    if (skip.has(v) || !(v instanceof Map || v instanceof Set)) continue;
    visit(v as Table);
    // A table of tables (per-function maps): one level down.
    if (v instanceof Map) for (const inner of v.values()) if (inner instanceof Map || inner instanceof Set) visit(inner as Table);
  }
}

function replaceInPlace(target: object, next: object): void {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) delete t[k];
  // An absent optional field stays absent: `typeArgs: undefined` is dropped.
  for (const [k, v] of Object.entries(next)) if (v !== undefined) t[k] = v;
}

export function applyRewrites(checker: object): void {
  const owner = checker as Record<string, unknown>;
  const exprRewrites = owner.rewrites as Map<object, object> | undefined;
  const patternRewrites = owner.patternRewrites as Map<object, object> | undefined;
  const pending = [exprRewrites, patternRewrites].filter((m): m is Map<object, object> => m !== undefined && m.size > 0);
  if (pending.length === 0) return;
  applyWindow(() => {
    const skip = new Set<unknown>([exprRewrites, patternRewrites]);
    for (const rw of pending) {
      const chain = chains(rw);
      eachTable(owner, skip, (t) => refile(t, chain));
      for (const [t, path] of chain) replaceInPlace(t, path[path.length - 1]!);
      rw.clear();
    }
  });
}
