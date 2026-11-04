// Two "say what you mean" warnings that need the finished program, so they run with the
// whole-program passes: `var-never-reassigned` (a `var` nothing writes after its
// initializer) and `unwritten-mut-param` (a `&mut T` param nothing writes through).
//
// Both read the checker's own notion of "this place is written": the sets it fills while it
// enforces mutability (`writtenExprs`, `autoBorrowed`, `explicitMutArgs`, `matchSubjectMut`)
// plus the statement shapes it handles directly (assignment, `for .. in &mut`, `&mut x`,
// closure write-back). A write the checker enforces on a `let` therefore cannot be missed
// here, which is what makes the `var` -> `let` fix leave a program that still checks.
//
// Names are matched per function, not per scope: a write to any `x` in a function keeps
// every `var x` in it. That only ever loses a hit, never invents one.
//
// std is not reported (a user program compiles its imports too, and they are not its to
// fix); MILO_MUTABILITY_STD=1 lifts that, for the corpus census over std itself.
import type { Program, Function, Expr, Span } from "./ast";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";

const WALK_SKIP = new Set(["span", "type", "targetType", "retType", "methodSpan"]);

// Parents an Ident may sit under without handing out the `&mut` itself: reading through it.
// Return is safe because a fn returning `&mut` is skipped up front.
const READ_PARENTS = new Set(["Return", "ExprStmt", "FieldAccess", "IndexAccess", "BinOp", "CastExpr", "IfStmt", "WhileStmt", "IsExpr", "Unwrap"]);

type Node = Record<string, unknown> & { kind?: string; span?: Span };

function walk(n: unknown, visit: (n: Node, parent: Node | null, key: string) => void, parent: Node | null = null, key = ""): void {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { for (const x of n) walk(x, visit, parent, key); return; }
  const node = n as Node;
  if (typeof node.kind === "string") visit(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (WALK_SKIP.has(k)) continue;
    walk(v, visit, typeof node.kind === "string" ? node : parent, k);
  }
}

// The names `body` writes, and (for `watch`) every bare use of the watched name that is not
// a plain read.
function writtenNames(host: ProgramPassHost, view: ProgramView, body: unknown, watch: string | null): { written: Set<string>; escapes: boolean } {
  const m = host.mutation;
  const written = new Set<string>();
  let escapes = false;
  const mark = (e: unknown) => { const r = view.rootOf(e); if (r) written.add(r); };
  walk(body, (n, parent, key) => {
    const e = n as unknown as Expr;
    if (m.written.has(e) || m.autoBorrowed.get(e)?.mutable || m.explicitMutArgs.has(e) || m.matchSubjectMut.has(e)) mark(n);
    switch (n.kind) {
      case "Assign": mark(n.target); break;
      case "ForInStmt": {
        // A struct iterated by value is an iterator: the loop calls its mutating next().
        const t = host.exprTypes.get(n.iterable as Expr);
        const base = t?.tag === "ref" ? t.inner : t;
        if (n.mutRef || base?.tag === "struct" || base?.tag === "enum") mark(n.iterable);
        break;
      }
      case "UnaryOp": if (n.op === "&mut") mark(n.operand); break;
      // A raw address can be written through anywhere.
      case "MethodCall": if (n.method === "addrOf") mark(n.object); break;
      case "Call":
        if (n.func === "swap" || n.func === "replace" || n.func === "take") for (const a of n.args as Expr[]) mark(a);
        break;
      case "Closure":
        for (const c of host.closureCaptures.get(e) ?? []) if (c.mutatedInClosure) written.add(c.name);
        break;
      case "Ident":
        if (watch !== null && n.name === watch && !readsOnly(host, view, n, parent, key)) escapes = true;
        break;
    }
  });
  return { written, escapes };
}

// Whether the Ident `id` under `parent` only reads through the reference. Anything not on
// the list (bound to a name, stored, returned, handed to a callee that takes `&mut`) keeps
// the `&mut`.
function readsOnly(host: ProgramPassHost, view: ProgramView, id: Node, parent: Node | null, key: string): boolean {
  if (!parent) return false;
  const kind = parent.kind!;
  if (kind === "UnaryOp") return parent.op !== "&mut";
  if (kind === "MethodCall") {
    if (key === "object") return true;
    const mangled = view.calleeOf(parent as unknown as Expr);
    const sig = mangled ? host.functions.get(mangled) : undefined;
    const i = (parent.args as unknown[]).indexOf(id);
    const p = sig?.params[i + 1];
    return !!p && !(p.type.tag === "ref" && p.type.mutable);
  }
  if (kind === "Call") {
    const sig = host.functions.get(view.calleeOf(parent as unknown as Expr) ?? "");
    const p = sig?.params[(parent.args as unknown[]).indexOf(id)];
    // An unknown callee is a builtin (print, format, ...): none keeps a `&mut` argument.
    return !p || !(p.type.tag === "ref" && p.type.mutable);
  }
  if (kind === "IfStmt" || kind === "WhileStmt") return key === "cond";
  return READ_PARENTS.has(kind);
}

const spanKey = (s: Span | undefined) => s ? `${s.file ?? ""}:${s.line}:${s.col}` : "";

export function checkMutability(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const lintStd = !!process.env.MILO_MUTABILITY_STD;
  const user = (f: Function) => lintStd || !host.fnDeclaredInStd(f);

  // ── var-never-reassigned ─────────────────────────────────────────────────────────
  // Generic bodies are checked once per instance, each a clone with the same spans: a
  // `var` is reported only when every copy leaves it unwritten.
  const vars = new Map<string, { name: string; span: Span; ok: boolean }>();
  for (const [name, f] of view.fns) {
    if (name.startsWith("<") || f.isExtern || !f.body || f.typeParams.length > 0 || !user(f)) continue;
    const { written } = writtenNames(host, view, f.body, null);
    walk(f.body, n => {
      if (n.kind !== "VarDecl" || !n.span) return;
      const key = spanKey(n.span);
      const seen = vars.get(key) ?? { name: n.name as string, span: n.span, ok: true };
      if (written.has(n.name as string)) seen.ok = false;
      vars.set(key, seen);
    });
  }
  for (const v of vars.values()) {
    if (!v.ok) continue;
    host.warn("var-never-reassigned", `'${v.name}' is never reassigned`, v.span,
      `declare it with 'let': nothing writes to it after its initializer`, 3);
  }

  // ── unwritten-mut-param ──────────────────────────────────────────────────────────
  // Free, non-generic, non-pub fns only. A `pub` signature is API and is left alone (no
  // warning at all, not even a soft one); trait and inherent methods are not in
  // program.functions. Passing the param on as an argument to any `&mut` parameter counts
  // as a write, so a chain of forwarders is peeled one link per `milo fix` round.
  const values = new Set<string>();
  const callSites = new Map<string, Map<string, { span: Span; explicit: boolean; idx: number }>>();
  for (const [name, f] of view.fns) {
    if (name.startsWith("<") || !f.body) continue;
    walk(f.body, n => {
      if (n.kind === "Ident" && typeof n.name === "string") values.add(n.name);
      if (n.kind !== "Call") return;
      const callee = view.calleeOf(n as unknown as Expr);
      if (!callee) return;
      const sites = callSites.get(callee) ?? new Map();
      callSites.set(callee, sites);
      (n.args as Expr[]).forEach((a, idx) => {
        if (a.span) sites.set(spanKey(a.span), { span: a.span, explicit: host.mutation.explicitMutArgs.has(a), idx });
      });
    });
  }
  for (const f of program.functions) {
    if (f.isExtern || !f.body || f.isPub || f.typeParams.length > 0 || f.name === "main" || f.attributes?.length || !user(f)) continue;
    if (f.retType?.isRefMut || values.has(f.name)) continue;
    const sig = host.functions.get(f.name);
    if (!sig) continue;
    const mutIdx = f.params.flatMap((p, i) => p.type?.isRefMut && sig.params[i]?.type.tag === "ref" ? [i] : []);
    if (mutIdx.length === 0) continue;
    const { written } = writtenNames(host, view, f.body, null);
    for (const i of mutIdx) {
      const p = f.params[i]!;
      if (written.has(p.name) || !p.span) continue;
      const only = writtenNames(host, view, f.body, p.name);
      if (only.escapes) continue;
      const sites = [...(callSites.get(f.name)?.values() ?? [])].filter(s => s.idx === i && s.explicit);
      // A call site in another file cannot be rewritten by this file's fix.
      if (sites.some(s => s.span.file !== p.span!.file)) continue;
      const before = host.mutation.diagnostics.length;
      host.warn("unwritten-mut-param", `'${p.name}' is taken as '&mut' but never written through`, p.span,
        `take '&T' instead and drop '&mut' at the call sites: shared borrows are implicit`, p.name.length);
      // Each explicit call site rides along as a note: the fix deletes the marker there.
      if (host.mutation.diagnostics.length > before) {
        host.mutation.diagnostics[before]!.notes = sites.map(s => ({ message: "'&mut' is not needed here", span: s.span }));
      }
    }
  }
}
