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
import type { HIRModule, HIRFunction, HIRExpr } from "./hir";
import type { Span } from "./ast";

export function specializeTrackCaller(mod: HIRModule): void {
  const tracked = new Map(mod.functions.filter(f => f.trackCaller).map(f => [f.name, f]));
  if (tracked.size === 0) return;
  const copies = new Map<string, HIRFunction>();
  const work: HIRFunction[] = [...mod.functions];
  const spanKey = (s: Span | undefined) => `${s?.file ?? ""}:${s?.line ?? 0}:${s?.col ?? 0}`;

  const visit = (node: unknown, stamp: Span | undefined): void => {
    if (Array.isArray(node)) { for (const n of node) visit(n, stamp); return; }
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.kind === "Call" && typeof n.func === "string" && tracked.has(n.func)) {
      const call = n as unknown as HIRExpr & { kind: "Call" };
      const at = stamp ?? call.span;
      const key = `${call.func}@${spanKey(at)}`;
      let copy = copies.get(key);
      if (!copy) {
        const original = tracked.get(call.func)!;
        copy = { ...structuredClone(original), name: `${original.name}$at${copies.size}`, trackedCaller: at ?? { line: 0, col: 0 } };
        delete copy.trackCaller;
        copies.set(key, copy);
        work.push(copy);
      }
      call.func = copy.name;
    }
    for (const k in n) {
      if (k === "type" || k === "span") continue;
      visit(n[k], stamp);
    }
  };

  for (let i = 0; i < work.length; i++) {
    const fn = work[i]!;
    // An uncopied tracked fn still exists for indirect uses; its calls are stamped by
    // their own spans, so it reports its own lines, as before the attribute.
    visit(fn.body, fn.trackedCaller);
  }
  mod.functions.push(...copies.values());
}
