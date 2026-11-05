// The four analyses behind `milo harden` (src/harden.ts): each reads the checked program
// and returns candidate rewrites as text edits. Nothing here writes a file or changes the
// checker; a candidate is only a claim, and src/harden.ts keeps it only if the hardened
// program still type-checks and behaves the same.
//
// Edits are computed from tokens, not from spans alone: an AST span is a node's first
// character, so every extent (`v[i]`, a `match` block, `.clone()`) is found by walking the
// token stream from that start and confirming the exact shape. A shape that is not exactly
// the expected tokens, or that would drop a comment, gets no candidate.
import type { Program, Expr, Span, Function } from "./ast";
import { patternLeafNames } from "./ast";
import { Lexer } from "./lexer";
import type { Token } from "./tokens";
import type { TextEdit } from "./fixes";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import { writtenNames } from "./checker-mutability-host";

export type RewriteName = "index-loop" | "match-to-try" | "if-let" | "last-use-clone";
export const REWRITES: RewriteName[] = ["index-loop", "match-to-try", "if-let", "last-use-clone"];

export interface Site { rewrite: RewriteName; line: number; col: number; edits: TextEdit[] }

type Node = Record<string, unknown> & { kind?: string; span?: Span };
const SKIP = new Set(["span", "type", "targetType", "retType", "methodSpan", "bindingSpans"]);

// Visits every node (anything with a string `kind`) with its nearest node ancestor and the
// property it hangs off. `ancestors` is the chain of enclosing nodes, outermost first.
function walk(n: unknown, visit: (n: Node, parent: Node | null, key: string, ancestors: Node[]) => void, parent: Node | null = null, key = "", ancestors: Node[] = []): void {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { for (const x of n) walk(x, visit, parent, key, ancestors); return; }
  const node = n as Node;
  const isNode = typeof node.kind === "string";
  if (isNode) visit(node, parent, key, ancestors);
  const chain = isNode ? [...ancestors, node] : ancestors;
  for (const [k, v] of Object.entries(node)) {
    if (SKIP.has(k)) continue;
    walk(v, visit, isNode ? node : parent, k, chain);
  }
}

const posLess = (a: Span, b: Span) => a.line < b.line || (a.line === b.line && a.col < b.col);

// A place spelled `a` or `a.b.c`: the only receivers the rewrites accept, because two
// spellings of one are comparable by text.
function placePath(e: unknown): string[] | null {
  const n = e as Node;
  if (n?.kind === "Ident") return [n.name as string];
  if (n?.kind === "FieldAccess") {
    const inner = placePath(n.object);
    return inner ? [...inner, n.field as string] : null;
  }
  return null;
}

class Src {
  readonly toks: Token[];
  readonly starts: number[] = [];
  private lineStart: number[] = [0];
  private byOffset = new Map<number, number>();
  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStart.push(i + 1);
    this.toks = new Lexer(text).tokenize();
    this.toks.forEach((t, i) => {
      const o = this.off(t.line, t.col);
      this.starts.push(o);
      this.byOffset.set(o, i);
    });
  }
  off(line: number, col: number): number { return (this.lineStart[line - 1] ?? 0) + col - 1; }
  tokAt(s: Span | undefined): number { return s ? this.byOffset.get(this.off(s.line, s.col)) ?? -1 : -1; }
  end(i: number): number { return this.starts[i]! + this.toks[i]!.value.length; }
  // Punctuation and keywords carry their own text as the token kind; literals and idents do not.
  is(i: number, v: string): boolean { return this.toks[i]?.kind === v; }
  id(i: number, name: string): boolean { const t = this.toks[i]; return t?.kind === "IDENT" && t.value === name; }
  int(i: number, v: string): boolean { const t = this.toks[i]; return t?.kind === "INT" && t.value === v; }
  // A comment between tokens i..j (inclusive of i's trailing comment and j's leading one)
  // would be deleted or moved by an edit covering them: the caller declines.
  commentIn(i: number, j: number): boolean {
    for (let k = i; k <= j; k++) {
      if (k > i && this.toks[k]!.leadingTrivia?.some(t => t.kind === "comment")) return true;
      if (k < j && this.toks[k]!.trailingTrivia?.length) return true;
    }
    return false;
  }
  // Index of the token closing the bracket opened at `open`, or -1.
  close(open: number): number {
    const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
    const want = pairs[this.toks[open]!.kind as string];
    if (!want) return -1;
    let depth = 0;
    for (let k = open; k < this.toks.length; k++) {
      const v = this.toks[k]!.kind as string;
      if (v === this.toks[open]!.kind) depth++;
      else if (v === want && --depth === 0) return k;
    }
    return -1;
  }
}

// Tokens of the place `path` starting at token i: `a . b . c`. Returns the index after it.
function matchPath(src: Src, i: number, path: string[]): number {
  let k = i;
  for (let p = 0; p < path.length; p++) {
    if (p > 0) { if (!src.is(k, ".")) return -1; k++; }
    if (!src.id(k, path[p]!)) return -1;
    k++;
  }
  return k;
}

// Names a fresh binding must not take: everything declared or mentioned in the function,
// plus top-level names. Conservative on purpose: `x shadows an outer binding` is an error.
function usedNames(f: Function, program: Program): Set<string> {
  const used = new Set<string>(f.params.map(p => p.name));
  for (const g of program.globals) used.add(g.name);
  for (const fn of program.functions) used.add(fn.name);
  walk(f.body, n => {
    for (const k of ["name", "varName", "varName2"]) if (typeof n[k] === "string") used.add(n[k] as string);
    if (Array.isArray(n.bindings)) for (const b of n.bindings as string[]) used.add(b);
    if (Array.isArray(n.params)) for (const p of n.params as { name: string }[]) used.add(p.name);
  });
  return used;
}

function fresh(used: Set<string>, ...bases: string[]): string {
  for (const b of bases) if (!used.has(b)) { used.add(b); return b; }
  for (let i = 2; ; i++) { const c = `${bases[bases.length - 1]}${i}`; if (!used.has(c)) { used.add(c); return c; } }
}

// `Result<i64, string>` -> ["i64", "string"], by top-level commas.
function typeArgsOf(shown: string): string[] {
  const lt = shown.indexOf("<");
  if (lt < 0 || !shown.endsWith(">")) return [];
  const inner = shown.slice(lt + 1, -1);
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "<" || ch === "(") depth++;
    if (ch === ">" || ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function findSites(program: Program, host: ProgramPassHost, view: ProgramView, file: string, source: string): Site[] {
  const src = new Src(source);
  // key -> site, with every monomorphized copy of the body needing to agree on it.
  const found = new Map<string, { site: Site; ok: boolean; sig: string }>();
  const offer = (rewrite: RewriteName, at: Span, ok: boolean, edits: TextEdit[]) => {
    const key = `${rewrite}:${at.line}:${at.col}`;
    const sig = JSON.stringify(edits);
    const prev = found.get(key);
    if (!prev) found.set(key, { site: { rewrite, line: at.line, col: at.col, edits }, ok, sig });
    else if (!ok || !prev.ok || prev.sig !== sig) prev.ok = false;
  };
  const inFile = (s: Span | undefined): s is Span => !!s && s.file === file;
  const typeOf = (e: unknown) => host.exprTypes.get(e as Expr);
  const deref = (t: ReturnType<typeof typeOf>) => (t && t.tag === "ref" ? t.inner : t);
  const scalarOrReadThrough = (x: Node, parent: Node | null, key: string): boolean => {
    const t = typeOf(x);
    if (t && (t.tag === "int" || t.tag === "float" || t.tag === "bool")) return true;
    return !!parent && key === "object" && (parent.kind === "FieldAccess" || parent.kind === "MethodCall" || parent.kind === "IndexAccess");
  };

  for (const [name, f] of view.fns) {
    // Generic bodies are only checked at the instantiations of this one program; another
    // program instantiating them with other types could reject what these accept.
    if (name.startsWith("<") || f.isExtern || !f.body || f.typeParams.length > 0 || host.isGenericInstance(f)) continue;
    const globalNames = new Set(program.globals.map(g => g.name));
    const used = usedNames(f, program);

    // Declarations of each local name: params, lets, vars, loop variables, pattern
    // bindings, closure params. `last-use-clone` needs exactly one.
    // `owned` is what the declaration says, not what the checker's expression type says:
    // the checker types a use of a `&T` binding as the `T` behind it. Loop variables,
    // pattern bindings and closure params borrow, so they are never owned.
    interface Decl { span: Span; owned: boolean }
    const decls = new Map<string, Decl[]>();
    const declare = (n: string, s: Span | undefined, owned: boolean) => { const a = decls.get(n) ?? []; a.push({ span: s ?? { line: 0, col: 0 }, owned }); decls.set(n, a); };
    const refType = (t: { isRef: boolean; isRefMut: boolean; isPtr: boolean } | null | undefined) => !!t && (t.isRef || t.isRefMut || t.isPtr);
    for (const p of f.params) declare(p.name, f.span, p.name !== "self" && !refType(p.type));
    walk(f.body, n => {
      if ((n.kind === "LetDecl" || n.kind === "VarDecl") && typeof n.name === "string") {
        const vt = typeOf(n.value);
        declare(n.name, n.span, !refType(n.type as never) && !!vt && vt.tag !== "ref" && vt.tag !== "ptr");
      }
      if (n.kind === "ForInStmt") { declare(n.varName as string, n.span, false); if (n.varName2) declare(n.varName2 as string, n.span, false); }
      if (n.kind === "Closure") for (const p of n.params as { name: string }[]) declare(p.name, n.span, false);
      if (n.kind === "EnumPattern") for (const b of patternLeafNames(n as never)) declare(b, n.span, false);
    });

    // Every Ident, in source order, with its chain.
    const idents: { n: Node; parent: Node | null; key: string; anc: Node[] }[] = [];
    walk(f.body, (n, parent, key, anc) => { if (n.kind === "Ident") idents.push({ n, parent, key, anc }); });

    walk(f.body, (n, parent, key, anc) => {
      if (!inFile(n.span)) return;

      // ── 1. index loop -> for-in ──────────────────────────────────────────────────
      if (n.kind === "ForInStmt") {
        const it = n.iterable as Node;
        const ok = (() => {
          if (n.varName2 || n.mutRef || (n.invariants as unknown[]).length > 0) return null;
          if (it.kind !== "RangeExpr") return null;
          const start = it.start as Node, end = it.end as Node;
          if (start.kind !== "IntLit" || String(start.value).replace(/n$/, "") !== "0") return null;
          if (end.kind !== "FieldAccess" || end.field !== "len") return null;
          const path = placePath(end.object);
          if (!path) return null;
          const ct = deref(typeOf(end.object));
          if (!ct || (ct.tag !== "vec" && ct.tag !== "array")) return null;
          if (globalNames.has(path[0]!)) return null;
          if (writtenNames(host, view, n.body, null).written.has(path[0]!)) return null;
          const I = n.varName as string;
          let uses = 0;
          let fine = true;
          const accesses: Node[] = [];
          const parentOf = new Map<Node, { p: Node | null; k: string }>();
          walk(n.body, (x, p, k) => {
            parentOf.set(x, { p, k });
            if (x.kind === "Ident" && x.name === I) {
              const same = p?.kind === "IndexAccess" && k === "index" && JSON.stringify(placePath(p.object)) === JSON.stringify(path);
              if (same) { uses++; accesses.push(p!); } else fine = false;
            }
          });
          if (!fine || uses === 0) return null;
          // The loop variable is a `&T`: the element must be a scalar or only read through.
          for (const a of accesses) {
            const pk = parentOf.get(a);
            if (!pk || !scalarOrReadThrough(a, pk.p, pk.k)) return null;
          }
          return { path, I, accesses };
        })();
        if (!ok) { offer("index-loop", n.span, false, []); return; }
        const { path, I, accesses } = ok;
        const forTok = src.tokAt(n.span);
        // for I in 0 .. <path> . len {
        let k = forTok + 1;
        const bad = () => offer("index-loop", n.span!, false, []);
        if (forTok < 0 || !src.is(forTok, "for") || !src.id(k, I) || !src.id(k + 1, "in") || !src.int(k + 2, "0") || !src.is(k + 3, "..")) return bad();
        const pStart = k + 4;
        const pEnd = matchPath(src, pStart, path);
        if (pEnd < 0 || !src.is(pEnd, ".") || !src.id(pEnd + 1, "len") || !src.is(pEnd + 2, "{")) return bad();
        if (src.commentIn(k, pEnd + 1)) return bad();
        const x = fresh(used, "x", "item", "elem");
        const pathText = source.slice(src.starts[pStart]!, src.starts[pEnd]!);
        const edits: TextEdit[] = [{ offset: src.starts[k]!, len: src.end(pEnd + 1) - src.starts[k]!, newText: `${x} in ${pathText}` }];
        for (const a of accesses) {
          const s = src.tokAt(a.span);
          const e = matchPath(src, s, path);
          if (s < 0 || e < 0 || !src.is(e, "[") || !src.id(e + 1, I) || !src.is(e + 2, "]")) return bad();
          if (src.commentIn(s, e + 2)) return bad();
          edits.push({ offset: src.starts[s]!, len: src.end(e + 2) - src.starts[s]!, newText: x });
        }
        offer("index-loop", n.span, true, edits);
        return;
      }

      // ── 2. match that only re-wraps the failure -> `?` ───────────────────────────
      if (n.kind === "MatchExpr" && !anc.some(a => a.kind === "Closure")) {
        const arms = n.arms as { pattern: Node; body: Node[] }[];
        const subject = n.subject as Node;
        const st = typeOf(subject);
        const sig = host.functions.get(name);
        if (arms.length !== 2 || !st || !sig) return;
        const shown = host.show(st), retShown = host.show(sig.ret);
        const isResult = shown.startsWith("Result<"), isOption = shown.startsWith("Option<");
        if (!isResult && !isOption) return;
        const goodVariant = isResult ? "Ok" : "Some", badVariant = isResult ? "Err" : "None";
        const good = arms.find(a => a.pattern.kind === "EnumPattern" && a.pattern.variant === goodVariant);
        const bad = arms.find(a => a.pattern.kind === "EnumPattern" && a.pattern.variant === badVariant);
        if (!good || !bad) return;
        const gb = (good.pattern.bindings as string[]);
        if (gb.length !== 1 || (good.pattern.args as unknown[] | undefined)?.some(Boolean)) return;
        if (good.body.length !== 1 || good.body[0]!.kind !== "ExprStmt") return;
        const gv = good.body[0]!.expr as Node;
        if (gv.kind !== "Ident" || gv.name !== gb[0]) return;
        if (bad.body.length !== 1 || bad.body[0]!.kind !== "Return") return;
        const rv = bad.body[0]!.value as Node | null;
        if (!rv || rv.kind !== "EnumLit" || String(rv.enumName).split("$")[0] !== (isResult ? "Result" : "Option") || rv.variant !== badVariant) return;
        if (isResult) {
          const bb = bad.pattern.bindings as string[];
          const args = rv.args as Node[];
          if (bb.length !== 1 || args.length !== 1 || args[0]!.kind !== "Ident" || args[0]!.name !== bb[0]) return;
          if (!retShown.startsWith("Result<")) return;
          const et = typeOf(args[0]);
          if (!et || host.show(et) !== typeArgsOf(retShown)[1]) return;
        } else if (!retShown.startsWith("Option<") || (rv.args as unknown[]).length !== 0) return;
        if (!["Ident", "Call", "MethodCall", "FieldAccess", "IndexAccess", "Unwrap", "Propagate"].includes(subject.kind!)) return;
        const m = src.tokAt(n.span);
        if (m < 0 || !src.is(m, "match")) { offer("match-to-try", n.span, false, []); return; }
        let open = m + 1;
        while (open < src.toks.length && !src.is(open, "{")) open++;
        const close = src.close(open);
        if (close < 0 || open === m + 1 || src.commentIn(m, close)) { offer("match-to-try", n.span, false, []); return; }
        const subjText = source.slice(src.starts[m + 1]!, src.starts[open]!).trim();
        offer("match-to-try", n.span, true, [{ offset: src.starts[m]!, len: src.end(close) - src.starts[m]!, newText: `${subjText}?` }]);
        return;
      }

      // ── 3. if o.isSome() { o! } -> if let ────────────────────────────────────────
      if (n.kind === "IfStmt") {
        const cond = n.cond as Node;
        if (cond.kind !== "MethodCall" || cond.method !== "isSome" || (cond.args as unknown[]).length !== 0) return;
        const path = placePath(cond.object);
        const ot = deref(typeOf(cond.object));
        if (!path || !ot || ot.tag !== "enum" || !host.show(ot).startsWith("Option<")) return;
        const then = n.thenBody as Node[];
        let unwraps: Node[] = [];
        let fine = true;
        const samePath = (e: unknown) => JSON.stringify(placePath(e)) === JSON.stringify(path);
        walk(then, (x, p, k) => {
          // Any mention of the whole place that is not `place!` keeps the Option alive.
          if ((x.kind === "Ident" || x.kind === "FieldAccess") && samePath(x)) {
            const isOperand = p?.kind === "Unwrap" && k === "operand";
            if (isOperand) { if (!unwraps.includes(p!)) unwraps.push(p!); }
            else if (!(p && (p.kind === "FieldAccess") && k === "object" && samePath(p))) fine = false;
          }
        });
        if (!fine || unwraps.length === 0) return;
        if (writtenNames(host, view, then, null).written.has(path[0]!)) return;
        if (globalNames.has(path[0]!)) return;
        // The payload is a `&T` in the `if let` body: scalars and read-through uses only.
        const parentOf = new Map<Node, { p: Node | null; k: string }>();
        walk(then, (x, p, k) => { parentOf.set(x, { p, k }); });
        for (const u of unwraps) {
          const pk = parentOf.get(u)!;
          if (!scalarOrReadThrough(u, pk.p, pk.k)) return;
        }
        const i = src.tokAt(n.span);
        const pS = i + 1;
        const pE = matchPath(src, pS, path);
        if (i < 0 || !src.is(i, "if") || pE < 0 || !src.is(pE, ".") || !src.id(pE + 1, "isSome") || !src.is(pE + 2, "(") || !src.is(pE + 3, ")") || !src.is(pE + 4, "{")) { offer("if-let", n.span, false, []); return; }
        if (src.commentIn(i, pE + 4)) { offer("if-let", n.span, false, []); return; }
        const nm = fresh(used, `${path[path.length - 1]}Val`);
        const pathText = source.slice(src.starts[pS]!, src.starts[pE]!);
        const edits: TextEdit[] = [{ offset: src.starts[pS]!, len: src.end(pE + 3) - src.starts[pS]!, newText: `let Option.Some(${nm}) = ${pathText}` }];
        for (const u of unwraps) {
          const s = src.tokAt(u.span);
          const e = s < 0 ? -1 : matchPath(src, s, path);
          if (e < 0 || !src.is(e, "!")) { offer("if-let", n.span, false, []); return; }
          edits.push({ offset: src.starts[s]!, len: src.end(e) - src.starts[s]!, newText: nm });
        }
        offer("if-let", n.span, true, edits);
        return;
      }

      // ── 4. clone on the last use of an owned value -> move ───────────────────────
      if (n.kind === "MethodCall" && n.method === "clone" && (n.args as unknown[]).length === 0) {
        const obj = n.object as Node;
        if (obj.kind !== "Ident" || !inFile(obj.span) || !parent) return;
        const x = obj.name as string;
        const xt = typeOf(obj);
        if (!xt || !["vec", "string", "struct", "enum", "hashmap", "heap"].includes(xt.tag)) return;
        if (host.dropTypesIn(xt).size > 0) return;
        if (!movePosition(parent, key, n, host, view)) return;
        const mine = decls.get(x);
        if (!mine || mine.length !== 1 || globalNames.has(x)) return;
        if (!mine[0]!.owned) return;
        const declAt = mine[0]!.span;
        // Loops and closures between the use and the declaration: a second iteration (or a
        // second call) would find the value gone.
        for (const a of anc) {
          if (a.kind === "Closure") { offer("last-use-clone", n.span, false, []); return; }
          if ((a.kind === "WhileStmt" || a.kind === "ForInStmt") && a.span && (declAt.line === 0 || !posLess(a.span, declAt) )) {
            offer("last-use-clone", n.span, false, []); return;
          }
        }
        for (const o of idents) {
          if (o.n === obj || o.n.name !== x) continue;
          if (!o.n.span || !posLess(o.n.span, obj.span!)) { offer("last-use-clone", n.span, false, []); return; }
        }
        const s = src.tokAt(obj.span);
        if (s < 0 || !src.is(s + 1, ".") || !src.id(s + 2, "clone") || !src.is(s + 3, "(") || !src.is(s + 4, ")")) { offer("last-use-clone", n.span, false, []); return; }
        if (src.commentIn(s, s + 4)) { offer("last-use-clone", n.span, false, []); return; }
        offer("last-use-clone", obj.span!, true, [{ offset: src.starts[s + 1]!, len: src.end(s + 4) - src.starts[s + 1]!, newText: "" }]);
      }
    });
  }

  // Sites that are sound in every copy of their body, with edits that do not overlap an
  // earlier site's (the later one is found again on the next round, against the new text).
  const sites = [...found.values()].filter(f => f.ok && f.site.edits.length > 0).map(f => f.site);
  sites.sort((a, b) => a.edits[0]!.offset - b.edits[0]!.offset);
  const kept: Site[] = [];
  const taken: [number, number][] = [];
  for (const s of sites) {
    const spans = s.edits.map(e => [e.offset, e.offset + Math.max(e.len, 1)] as [number, number]);
    if (spans.some(([a, b]) => taken.some(([c, d]) => a < d && c < b))) continue;
    taken.push(...spans);
    kept.push(s);
  }
  return kept;
}

// Whether `node` (the clone call) sits where its value is handed on by value: bound,
// assigned, returned, stored in a literal, or passed to a call whose parameter is owned.
function movePosition(parent: Node, key: string, node: Node, host: ProgramPassHost, view: ProgramView): boolean {
  switch (parent.kind) {
    case "LetDecl": case "VarDecl": return key === "value";
    case "Assign": return key === "value";
    case "Return": return key === "value";
    case "StructLit": case "EnumLit": case "ArrayLit": return true;
    case "Call": {
      const sig = host.functions.get(view.calleeOf(parent as unknown as Expr) ?? "");
      const idx = (parent.args as Node[]).indexOf(node);
      const p = sig?.params[idx];
      return !!p && p.type.tag !== "ref" && p.type.tag !== "ptr" && p.type.tag !== "unknown";
    }
    case "MethodCall": return key === "args" && (parent.method === "push" || parent.method === "insert");
    default: return false;
  }
}
