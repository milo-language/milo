// A `move` closure that captures anything owns a heap environment. A plain `(T) => R` is
// Copy and owns nothing, so a closure stored or returned under that type has no owner and
// its environment is never freed [MILO-O-returnedPlainClosure]. Rejected here instead of
// leaking: the slot's declared type has to say `move (T) => R`, and `milo fix` writes it
// (src/fixes.ts, code `plain-closure-env`).
//
// Closures that capture nothing, or are not `move`, are not owning (checkClosureExpr) and
// pass straight through; a plain parameter only LENDS its argument and is not a slot.
//
// A walk over the finished program, like checkEscapingClosures: the slots that keep a
// value are a return, a struct field, an assignment, an annotated `let`/`var` and the
// collection-storing builtin methods.

import type { Program, Expr, MiloType } from "./ast";
import type { TypeKind } from "./types";
import { RETAINING_MEMBERS } from "./builtin-members";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";

const BLOCK_SKIP = new Set(["span", "type"]);

const ownsEnv = (t: TypeKind | undefined): boolean => t?.tag === "fn" && t.owning === true;
const plainAst = (t: MiloType | null | undefined): t is MiloType => !!t && !!t.isFn && !t.isMoveFn && !t.isCFn;

// A slot: where the value goes, and the declared type to rewrite when the source has one.
interface Slot { what: string; ast?: MiloType; plainTy?: boolean }

export function checkPlainClosureEnv(host: ProgramPassHost, program: Program, _view: ProgramView): void {
  const seen = new Set<string>();
  const structs = new Map(program.structs.map(s => [s.name, s]));
  const report = (value: Expr, slot: Slot) => {
    const at = slot.ast?.span ?? value.span;
    const key = `${at?.file ?? ""}:${at?.line ?? 0}:${at?.col ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    const msg = `this closure owns its captures, so ${slot.what} cannot be a plain function type: its environment would never be freed`;
    const hint = "declare the type as 'move (T) => R' so the value owns the closure and drops it";
    // Only a declared type has one place to rewrite; the rest are hint-only.
    if (slot.ast) host.errorCode("plain-closure-env", msg, at, `${hint}; run 'milo fix <file>' to rewrite it`);
    else host.error(msg, at, hint);
  };
  const sink = (value: Expr | null | undefined, slot: Slot | null) => {
    if (!value || !slot) return;
    if (ownsEnv(host.exprTypes.get(value))) report(value, slot);
  };
  const fieldSlot = (structName: string, field: string, what: string): Slot | null => {
    const f = structs.get(structName)?.fields.find(x => x.name === field);
    return plainAst(f?.type) ? { what, ast: f!.type } : null;
  };
  const retSlot = (ast: MiloType | null | undefined, inferred: TypeKind | undefined): Slot | null => {
    if (plainAst(ast)) return { what: "the return value", ast };
    if (!ast && inferred?.tag === "fn" && !inferred.owning) return { what: "the return value" };
    return null;
  };

  const visit = (node: unknown, ret: Slot | null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) visit(n, ret); return; }
    const n = node as Record<string, unknown> & { kind?: string };
    switch (n.kind) {
      case "Closure":
        ret = retSlot(n.retType as MiloType | null, (host.exprTypes.get(n as unknown as Expr) as { ret?: TypeKind } | undefined)?.ret);
        break;
      case "Return": sink(n.value as Expr | null, ret); break;
      case "LetDecl": case "VarDecl":
        if (plainAst(n.type as MiloType | null)) sink(n.value as Expr, { what: `'${n.name}'`, ast: n.type as MiloType });
        break;
      case "StructLit":
        for (const f of n.fields as { name: string; value: Expr }[]) sink(f.value, fieldSlot(n.name as string, f.name, `field '${f.name}'`));
        break;
      case "Assign": {
        const t = n.target as Expr;
        if (t.kind === "FieldAccess") {
          const ot = host.exprTypes.get(t.object);
          const base = ot?.tag === "ref" ? ot.inner : ot;
          sink(n.value as Expr, base?.tag === "struct" ? fieldSlot(base.name, t.field, `field '${t.field}'`) : null);
        } else if (t.kind === "Ident") {
          const tt = host.exprTypes.get(t);
          if (tt?.tag === "fn" && !tt.owning) sink(n.value as Expr, { what: `'${t.name}'` });
        }
        break;
      }
      case "MethodCall": {
        if (!RETAINING_MEMBERS.has(n.method as string)) break;
        const rt = host.exprTypes.get(n.object as Expr);
        const base = rt?.tag === "ref" ? rt.inner : rt;
        const elem = base?.tag === "vec" ? base.element : base?.tag === "hashmap" ? base.value : undefined;
        if (elem?.tag === "fn" && !elem.owning) for (const a of n.args as Expr[]) sink(a, { what: "an element of this collection" });
        break;
      }
      default: break; // every other kind only has children to visit (below)
    }
    for (const k of Object.keys(n)) if (!BLOCK_SKIP.has(k)) visit(n[k], ret);
  };
  for (const fn of [...program.functions, ...host.monomorphizedFns]) {
    // A generic instance carries whatever closure type the caller picked for T (Vec<(i64) => i64>.push
    // stores `x: T` into its buffer); the caller's own slot is what gets checked.
    if (fn.isExtern || !fn.body || host.isGenericInstance(fn)) continue;
    visit(fn.body, plainAst(fn.retType) ? { what: "the return value", ast: fn.retType } : null);
  }
}
