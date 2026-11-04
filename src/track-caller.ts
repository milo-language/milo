// @trackCaller: a panic inside the attributed fn reports its caller's file:line, like
// Rust's #[track_caller]. Done by specializing on the call site: each direct call of a
// tracked fn gets its own copy, stamped with that call's span, and codegen's panicAt uses
// the stamp instead of the panicking expression's own span. A call inside a copy passes
// the copy's stamp on, so tracking composes through tracked helpers.
//
// Specialized rather than threaded as a hidden location argument because every panic
// message bakes its location into a constant string; an argument would have meant a
// runtime-formatted location at each of those sites. The attribute is std-collection-only
// and its users are `@inline`, which already copies the body into every caller, so the
// extra copies cost what inlining costs.
//
// A copy is the same AST body emitted again under its own name: what differs is its stamp
// and the callee each of its direct calls names (`callees`, per emitted function name).
import type { Expr, Span } from "./ast";
import type { FnDecl } from "./backend-program";
import { type Facts, directCallee, walkAst } from "./emit-forms";

export function trackCallerInstances(fns: FnDecl[], fx: Facts): { copies: FnDecl[]; callees: Map<string, Map<Expr, string>> } {
  const tracked = new Map(fns.filter(f => f.trackCaller).map(f => [f.name, f]));
  const callees = new Map<string, Map<Expr, string>>();
  if (tracked.size === 0) return { copies: [], callees };
  const copies = new Map<string, FnDecl>();
  const work: FnDecl[] = [...fns];
  const spanKey = (s: Span | undefined) => `${s?.file ?? ""}:${s?.line ?? 0}:${s?.col ?? 0}`;
  for (let i = 0; i < work.length; i++) {
    const fn = work[i]!;
    if (!fn.ast) continue;
    // An uncopied tracked fn still exists for indirect uses; its calls are stamped by their
    // own spans, so it reports its own lines, as before the attribute.
    const stamp = fn.trackedCaller;
    const mine = new Map<Expr, string>();
    walkAst(fn.ast.body, n => {
      const e = n as Expr;
      const callee = directCallee(fx, e, { ret: fn.retType });
      if (callee === null || !tracked.has(callee)) return;
      const at = stamp ?? e.span;
      const key = `${callee}@${spanKey(at)}`;
      let copy = copies.get(key);
      if (!copy) {
        const original = tracked.get(callee)!;
        copy = { ...original, name: `${original.name}$at${copies.size}`, trackedCaller: at ?? { line: 0, col: 0 } };
        delete copy.trackCaller;
        copies.set(key, copy);
        work.push(copy);
      }
      mine.set(e, copy.name);
    });
    if (mine.size) callees.set(fn.name, mine);
  }
  return { copies: [...copies.values()], callees };
}
