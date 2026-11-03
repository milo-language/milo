// Match lowering: enum and literal (int/char/bool/float/string) matches, payload bindings, and the arm helpers shared with the fork-ownership logic.

import type { HIRStmt, HIRExpr, HIRPattern } from "./hir";

export function armTailExpr(body: HIRStmt[]): HIRExpr | null {
  const last = body[body.length - 1];
  return last && last.kind === "ExprStmt" ? last.expr : null;
}

// The names a match arm declares itself: its pattern's bindings (owned unless the
// subject is matched by reference) and its top-level `let`s.
export function matchArmLocals(arm: { pattern: HIRPattern; body: HIRStmt[] }, subjectIsRef: boolean): Set<string> {
  const out = new Set<string>();
  if (arm.pattern.kind === "EnumPattern" && !subjectIsRef) for (const b of arm.pattern.bindings) out.add(b.name);
  for (const st of arm.body) if (st.kind === "Let") out.add(st.name);
  return out;
}
