// The boundary between the checker and the portable non-escaping parameter pass
// (src/checker-nonescaping.ts). The checker keys call resolution, closure captures and
// expression types by object; this file numbers every node of each function body in the
// walker's pre-order and restates what the pass needs as plain data keyed by that id.
import type { Program, Expr } from "./ast";
import type { TypeKind } from "./types";
import { RETAINING_MEMBERS } from "./builtin-members";
import { collectStmts, type AnyNode } from "./ast-nodes";
import { nonEscapingFindings, type BodyTask, type CallFact, type CaptureFact } from "./checker-nonescaping";
import { SCOPED_SPAWN_FN, isNonEscapingFnParam, type ProgramPassHost, type ProgramView } from "./checker-program-passes";

export function checkNonEscapingParams(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const tasks: BodyTask[] = [];
  const calls: CallFact[] = [];
  const captures: CaptureFact[] = [];
  let total = 0;

  // The callee parameter an argument lands in, or null when it cannot be resolved (a
  // builtin free function, an enum variant constructor, a call through a fn value).
  // Unresolved means "may keep it", the same fail-closed rule as `retainsParam`.
  const targetParam = (call: Expr, i: number): TypeKind | null | "builtin-member" => {
    const callee = view.calleeOf(call);
    const sig = callee ? host.functions.get(callee) : undefined;
    if (!sig) {
      if (call.kind === "MethodCall") return RETAINING_MEMBERS.has(call.method) ? null : "builtin-member";
      return null;
    }
    // A method's signature carries `self` first; the call's argument list does not.
    const off = call.kind !== "Call" && sig.params[0]?.name === "self" ? 1 : 0;
    return sig.params[i + off]?.type ?? null;
  };

  for (const fn of [...program.functions, ...host.monomorphizedFns]) {
    if (fn.isExtern || !fn.body || fn.typeParams.length > 0) continue;
    // The one callee that keeps a plain closure param: checkTaskScopes holds its callers.
    const sig = fn.name === SCOPED_SPAWN_FN ? undefined : host.functions.get(fn.name);
    const fnParams = sig ? sig.params.filter(p => isNonEscapingFnParam(p.type)).map(p => p.name) : [];

    const nodes: AnyNode[] = [];
    collectStmts(fn.body, nodes);
    const base = total;
    total += nodes.length;
    const idOf = new Map<AnyNode, number>();
    nodes.forEach((n, i) => idOf.set(n, base + i));

    // A closure literal's plain closure parameter is held to the same rule: a call through
    // a fn value lends an owning closure exactly as a direct call does (checker
    // `lendsOwningClosure`), and the literal is one of the targets that call can reach.
    const names = new Set<string>(fnParams);
    const closureTasks: BodyTask[] = [];
    for (const node of nodes) {
      if (node.kind !== "Closure") continue;
      const ty = host.exprTypes.get(node);
      const params = ty?.tag === "fn" ? node.params.filter((_, i) => isNonEscapingFnParam(ty.params[i])).map(p => p.name) : [];
      if (params.length === 0 || node.body.length === 0) continue;
      for (const p of params) names.add(p);
      closureTasks.push({ body: node.body, base: idOf.get(node.body[0]!)!, params, who: "the closure" });
    }
    if (names.size === 0) continue;

    for (const node of nodes) {
      const id = idOf.get(node)!;
      if (node.kind === "Closure") {
        for (const c of host.closureCaptures.get(node) ?? []) captures.push({ id, name: c.name });
      } else if (node.kind === "Call" || node.kind === "MethodCall" || node.kind === "EnumLit") {
        const callee = node.kind === "Call" ? node.func : node.kind === "EnumLit" ? `${node.enumName}.${node.variant}` : node.method;
        const keeps = node.args.map((a, i) => {
          if (a.kind !== "Ident" || !names.has(a.name)) return false;
          const t = targetParam(node, i);
          return !(t === "builtin-member" || isNonEscapingFnParam(t ?? undefined));
        });
        calls.push({ id, callee, span: node.span, keeps });
      }
    }

    tasks.push(...closureTasks);
    if (fnParams.length > 0) tasks.push({ body: fn.body, base, params: fnParams, who: `'${view.pretty(fn.name)}'` });
  }

  for (const f of nonEscapingFindings({ tasks, calls, captures })) host.error(f.message, f.span, f.hint);
}
