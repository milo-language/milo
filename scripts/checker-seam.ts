// Seam measurement for src/checker.ts: every top-level declaration and TypeChecker member with
// its line span, the reference graph among them, and the cost of cutting a cluster out.
//
//   bun scripts/checker-seam.ts . members            every member: span, lines, fan-in/out
//   bun scripts/checker-seam.ts . member <name>      one member's edges in full
//   bun scripts/checker-seam.ts . dom [minLines]     dominator subtrees (single-entry clusters)
//   bun scripts/checker-seam.ts . prefix             name-prefix groups
//   bun scripts/checker-seam.ts . clusters <file>    the table for clusters named in a JSON file
//   bun scripts/checker-seam.ts . cluster <file> <name>   one cluster in full (the brief's inputs)
//
// A cluster file is { "<name>": { "seeds": ["methodA", "/^lint/"], "exclude": ["x"], "noGrow": false } }.
// A cluster grows from its seeds by pulling in every private member (method or field) and every
// unexported top-level declaration whose referrers are all already inside it: those move for free.
// What is left on the border is the cost:
//   out methods   checker methods the cluster calls and does not own  -> host accessors
//   out fields    checker fields it reads / writes and does not own   -> host accessors
//   entries       cluster methods the rest of the checker calls       -> exports of the new file
//   top exports   unexported top-level decls shared with the checker  -> new `export` in checker.ts
// "new exports" is the sum of the four.
import type tsNs from "typescript";
import { join, resolve } from "path";
import { readFileSync } from "fs";

const ROOT = resolve(process.argv[2] ?? ".");
const cmd = process.argv[3] ?? "members";
const FILE = join(ROOT, "src/checker.ts");
// The repo's own TypeScript, so symbols agree with the subset rules loaded from it.
const ts: typeof tsNs = (await import(join(ROOT, "node_modules/typescript/lib/typescript.js"))).default;
const { makeProgram, violationsOf } = await import(join(ROOT, "scripts/ts2milo/subset.ts"));

const program: tsNs.Program = makeProgram(ROOT, [FILE]);
const tc = program.getTypeChecker();
const sf = program.getSourceFile(FILE)!;
const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

type Kind = "method" | "field" | "accessor" | "ctor" | "top-fn" | "top-const" | "top-type" | "top-class";
interface Node {
  id: string;            // member name, or "::name" for a top-level declaration
  kind: Kind;
  start: number; end: number; lines: number;   // lines include the leading comment block
  priv: boolean;         // private member / unexported top-level
  section: string;
  calls: Set<string>;    // methods referenced via this.m
  reads: Set<string>;    // fields read via this.f
  writes: Set<string>;   // fields assigned (this.f = ..., this.f++, ...)
  mutates: Set<string>;  // fields changed in place (this.f.set(...), this.f[i] = ..., this.f.x = ...)
  tops: Set<string>;     // top-level declarations of checker.ts referenced
  topsTypeOnly: Set<string>;
  imports: Set<string>;  // imported names referenced
  violations: number;    // constructs outside the ts2milo subset
  nodeKeyed: boolean;    // field whose type is a Map/Set/WeakMap keyed by an AST node
  occ: Map<string, number>; // how many times each member / top-level name is mentioned
  aliasMut: Set<string>; // types of objects changed in place that are not a `this.f` and not built in the method
}

const nodes = new Map<string, Node>();
const mk = (id: string, kind: Kind, n: tsNs.Node, priv: boolean, section: string): Node => {
  const full = sf.text.slice(n.getFullStart(), n.getStart(sf));
  // The leading comment block moves with the declaration: count from its first line.
  const firstComment = full.search(/\/\/|\/\*/);
  const startPos = firstComment >= 0 ? n.getFullStart() + firstComment : n.getStart(sf);
  const start = lineOf(startPos), end = lineOf(n.getEnd());
  const node: Node = { id, kind, start, end, lines: end - start + 1, priv, section, calls: new Set(), reads: new Set(), writes: new Set(), mutates: new Set(), tops: new Set(), topsTypeOnly: new Set(), imports: new Set(), violations: 0, nodeKeyed: false, aliasMut: new Set(), occ: new Map() };
  // Overloads / duplicate names: keep the first id, widen the span.
  const prev = nodes.get(id);
  if (prev) { prev.end = Math.max(prev.end, end); prev.lines += node.lines; return prev; }
  nodes.set(id, node);
  return node;
};

const MUTATORS = new Set(["set", "add", "push", "delete", "clear", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill"]);
const hasMod = (n: tsNs.Node, k: tsNs.SyntaxKind) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some(m => m.kind === k));

let cls: tsNs.ClassDeclaration | undefined;
const topDecl = new Map<tsNs.Node, string>();   // declaration node -> "::name"
const topNodes: [tsNs.Node, Node][] = [];
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st)) continue;
  const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
  if (ts.isClassDeclaration(st) && st.name?.text === "TypeChecker") { cls = st; continue; }
  if (ts.isFunctionDeclaration(st) && st.name) { const n = mk("::" + st.name.text, "top-fn", st, !exported, ""); topDecl.set(st, n.id); topNodes.push([st, n]); }
  else if (ts.isClassDeclaration(st) && st.name) { const n = mk("::" + st.name.text, "top-class", st, !exported, ""); topDecl.set(st, n.id); topNodes.push([st, n]); }
  else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) { const n = mk("::" + st.name.text, "top-type", st, !exported, ""); topDecl.set(st, n.id); topNodes.push([st, n]); }
  else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) {
      const n = mk("::" + d.name.text, "top-const", st, !exported, ""); topDecl.set(d, n.id); topNodes.push([st, n]);
    }
  }
}
if (!cls) throw new Error("no TypeChecker class");

const memberNodes: [tsNs.Node, Node][] = [];
const memberNames = new Set<string>();
let section = "";
for (const m of cls.members) {
  // A section banner is a comment line of box-drawing or '=' / '-' runs before the member.
  const lead = sf.text.slice(m.getFullStart(), m.getStart(sf));
  const banner = /\/\/\s*(?:──|==+|--+)\s*([^─=\-\n]+?)\s*(?:─|=|-)*\s*$/m.exec(lead);
  if (banner) section = banner[1].trim();
  const priv = hasMod(m, ts.SyntaxKind.PrivateKeyword);
  if (ts.isConstructorDeclaration(m)) { memberNodes.push([m, mk("constructor", "ctor", m, false, section)]); continue; }
  const name = m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name)) ? m.name.text : undefined;
  if (!name) continue;
  memberNames.add(name);
  const kind: Kind = ts.isMethodDeclaration(m) ? "method" : ts.isPropertyDeclaration(m) ? (m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)) ? "method" : "field") : "accessor";
  const node = mk(name, kind, m, priv, section);
  if (ts.isPropertyDeclaration(m) && kind === "field") {
    const t = tc.typeToString(tc.getTypeAtLocation(m), m, ts.TypeFormatFlags.NoTruncation);
    node.nodeKeyed = /^(Map|Set|WeakMap|WeakSet)<(Expr|Stmt|Function|Pattern|MiloType|StructDecl|EnumDecl|ImplDecl|GlobalDecl|MatchArm|Param|object|unknown|import\()/.test(t) || /^(Map|Set|WeakMap|WeakSet)<\{/.test(t);
  }
  memberNodes.push([m, node]);
}
// Constructor parameter properties are fields too.
for (const m of cls.members) if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) {
  if (ts.canHaveModifiers(p) && ts.getModifiers(p)?.length && ts.isIdentifier(p.name)) {
    memberNames.add(p.name.text);
    const n = mk(p.name.text, "field", p, hasMod(p, ts.SyntaxKind.PrivateKeyword), "");
    n.lines = 0;
  }
}

const FRESH_CALLS = new Set(["map", "filter", "slice", "concat", "split", "from", "entries", "keys", "values", "flatMap", "flat", "toSorted"]);
const shortType = (e: tsNs.Node) => tc.typeToString(tc.getTypeAtLocation(e)).replace(/\s+/g, " ").slice(0, 40);
// Where the object an expression denotes came from: a checker field, something shared (a
// parameter, a call result, a loop element of unknown source), or built right here.
function originOf(e: tsNs.Expression, depth: number): { field?: string; shared?: string } {
  if (depth > 8) return { shared: shortType(e) };
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) {
    if (e.expression.kind === ts.SyntaxKind.ThisKeyword && memberNames.has(e.name.text) && nodes.get(e.name.text)!.kind !== "method") return { field: e.name.text };
    return originOf(e.expression, depth + 1);
  }
  if (ts.isElementAccessExpression(e)) return originOf(e.expression, depth + 1);
  if (ts.isCallExpression(e)) {
    if (ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (FRESH_CALLS.has(m)) return {};
      // `this.scopes.get(k)`, `this.lookup(x)`: the result lives in checker state.
      if (m === "get" || m === "at") return originOf(e.expression.expression, depth + 1);
      return { shared: shortType(e) };
    }
    return { shared: shortType(e) };
  }
  if (ts.isNewExpression(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return {};
  if (ts.isConditionalExpression(e)) { const a = originOf(e.whenTrue, depth + 1); return a.field || a.shared ? a : originOf(e.whenFalse, depth + 1); }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { const a = originOf(e.left, depth + 1); return a.field || a.shared ? a : originOf(e.right, depth + 1); }
  if (ts.isIdentifier(e)) {
    const d = tc.getSymbolAtLocation(e)?.declarations?.[0];
    if (!d) return { shared: shortType(e) };
    if (ts.isParameter(d)) return { shared: shortType(e) };
    let decl: tsNs.Node = d;
    while (ts.isBindingElement(decl) || ts.isObjectBindingPattern(decl) || ts.isArrayBindingPattern(decl)) decl = decl.parent;
    if (ts.isParameter(decl)) return { shared: shortType(e) };
    if (ts.isVariableDeclaration(decl)) {
      const list = decl.parent;
      if (ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent)) return originOf(list.parent.expression, depth + 1);
      if (decl.initializer) return originOf(decl.initializer, depth + 1);
      return {};
    }
    return { shared: shortType(e) };
  }
  return {};
}
function scan(root: tsNs.Node, node: Node): void {
  const visit = (n: tsNs.Node): void => {
    if (ts.isPropertyAccessExpression(n) && (n.expression.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "TypeChecker")) && memberNames.has(n.name.text)) {
      const name = n.name.text;
      const target = nodes.get(name)!;
      node.occ.set(name, (node.occ.get(name) ?? 0) + 1);
      if (target.kind === "method") node.calls.add(name);
      else {
        const p = n.parent;
        let wrote = false;
        if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) { node.writes.add(name); wrote = p.operatorToken.kind === ts.SyntaxKind.EqualsToken; }
        else if ((ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) node.writes.add(name);
        else if (ts.isPropertyAccessExpression(p) && p.expression === n) {
          const gp = p.parent;
          if (ts.isCallExpression(gp) && gp.expression === p && MUTATORS.has(p.name.text)) node.mutates.add(name);
          else if (ts.isBinaryExpression(gp) && gp.left === p && gp.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && gp.operatorToken.kind <= ts.SyntaxKind.LastAssignment) node.mutates.add(name);
          else if ((ts.isPostfixUnaryExpression(gp) || ts.isPrefixUnaryExpression(gp)) && (gp.operator === ts.SyntaxKind.PlusPlusToken || gp.operator === ts.SyntaxKind.MinusMinusToken)) node.mutates.add(name);
        } else if (ts.isElementAccessExpression(p) && p.expression === n) {
          const gp = p.parent;
          if (ts.isBinaryExpression(gp) && gp.left === p && gp.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && gp.operatorToken.kind <= ts.SyntaxKind.LastAssignment) node.mutates.add(name);
        }
        if (!wrote) node.reads.add(name);
      }
    } else if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
      const sym = tc.getSymbolAtLocation(n);
      const resolved = sym && (sym.flags & ts.SymbolFlags.Alias) ? tc.getAliasedSymbol(sym) : sym;
      for (const d of sym?.declarations ?? []) {
        const id = topDecl.get(d);
        if (id && id !== node.id) {
          node.occ.set(id, (node.occ.get(id) ?? 0) + 1);
          const typePos = ts.isTypeReferenceNode(n.parent) || ts.isExpressionWithTypeArguments(n.parent) || ts.isTypeQueryNode(n.parent) || (ts.isQualifiedName(n.parent));
          if (typePos && !node.tops.has(id)) node.topsTypeOnly.add(id); else { node.tops.add(id); node.topsTypeOnly.delete(id); }
        }
        if (ts.isImportSpecifier(d) || ts.isImportClause(d)) node.imports.add(n.text);
      }
      void resolved;
    }
    // A change made through a local or a parameter: follow the receiver back to where it came from.
    let target: tsNs.Expression | undefined;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) target = n.left.expression;
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text)) target = n.expression.expression;
    else if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && (ts.isPropertyAccessExpression(n.operand) || ts.isElementAccessExpression(n.operand))) target = n.operand.expression;
    if (target) {
      const r = originOf(target, 0);
      if (r.field) { if (!(ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword)) node.mutates.add(r.field); }
      else if (r.shared) node.aliasMut.add(r.shared);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
}
for (const [m, node] of memberNodes) scan(m, node);
const seenTop = new Set<tsNs.Node>();
for (const [st, node] of topNodes) { if (seenTop.has(st) && false) continue; seenTop.add(st); scan(st, node); }

// Portability: constructs outside the ts2milo subset, attributed to the member holding the line.
const spans = [...nodes.values()].filter(n => n.lines > 0).sort((a, b) => a.start - b.start);
for (const v of violationsOf(program, tc, sf) as { line: number }[]) {
  const owner = spans.find(n => v.line >= n.start && v.line <= n.end);
  if (owner) owner.violations++;
}

// Reverse edges. A referrer of X is any node naming X in any role.
const refsOf = (n: Node): Set<string> => new Set([...n.calls, ...n.reads, ...n.writes, ...n.mutates, ...n.tops, ...n.topsTypeOnly]);
const referrers = new Map<string, Set<string>>();
for (const n of nodes.values()) for (const r of refsOf(n)) { if (!referrers.has(r)) referrers.set(r, new Set()); referrers.get(r)!.add(n.id); }
const fanIn = (id: string) => referrers.get(id)?.size ?? 0;

// Fields a method writes through everything it can reach: what "calling it" can change.
const transWrites = new Map<string, Set<string>>();
{
  for (const n of nodes.values()) transWrites.set(n.id, new Set([...n.writes, ...n.mutates]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      const mine = transWrites.get(n.id)!;
      for (const c of [...n.calls, ...n.tops]) for (const w of transWrites.get(c) ?? []) if (!mine.has(w)) { mine.add(w); changed = true; }
    }
  }
}

interface Spec { seeds: string[]; exclude?: string[]; noGrow?: boolean; target?: string; note?: string }
function expand(spec: Spec): Set<string> {
  const set = new Set<string>();
  const excl = new Set(spec.exclude ?? []);
  for (const s of spec.seeds) {
    if (s.startsWith("/")) { const re = new RegExp(s.slice(1, s.lastIndexOf("/"))); for (const n of nodes.values()) if (n.kind === "method" && re.test(n.id) && !excl.has(n.id)) set.add(n.id); }
    else if (s.startsWith("T/")) { const re = new RegExp(s.slice(2, s.lastIndexOf("/"))); for (const n of nodes.values()) if (n.id.startsWith("::") && re.test(n.id.slice(2)) && !excl.has(n.id)) set.add(n.id); }
    else if (s === "kind:top-type") { for (const n of nodes.values()) if (n.kind === "top-type" && !excl.has(n.id)) set.add(n.id); }
    else if (/^\d+-\d+$/.test(s)) { const [a, b] = s.split("-").map(Number); for (const n of nodes.values()) if (!n.id.startsWith("::") && n.kind !== "field" && n.kind !== "ctor" && n.start >= a && n.end <= b && !excl.has(n.id)) set.add(n.id); }
    else if (nodes.has(s)) set.add(s);
    else console.error(`unknown seed ${s}`);
  }
  if (spec.noGrow) return set;
  // Pull in what only the cluster uses. Public members stay: something outside the file may call them.
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      if (set.has(n.id) || excl.has(n.id) || !n.priv || n.kind === "ctor") continue;
      const rs = referrers.get(n.id);
      if (!rs || rs.size === 0) continue;
      if ([...rs].every(r => set.has(r) || r === n.id)) { set.add(n.id); changed = true; }
    }
  }
  return set;
}

interface Cost {
  name: string; members: Set<string>; lines: number; methods: number; ownedFields: string[]; movedTops: string[];
  outMethods: string[]; outReads: string[]; outWrites: string[]; entries: string[]; topExports: string[]; topTypeExports: string[];
  already: string[]; sites: number; violations: number; nodeKeyed: string[]; transWrites: string[]; newExports: number;
}
function cost(name: string, set: Set<string>): Cost {
  const ms = [...set].map(id => nodes.get(id)!);
  const outMethods = new Set<string>(), outReads = new Set<string>(), outWrites = new Set<string>(), tops = new Set<string>(), topTypes = new Set<string>(), already = new Set<string>();
  for (const n of ms) {
    for (const c of n.calls) if (!set.has(c)) outMethods.add(c);
    for (const f of n.reads) if (!set.has(f)) outReads.add(f);
    for (const f of [...n.writes, ...n.mutates]) if (!set.has(f)) outWrites.add(f);
    for (const t of n.tops) if (!set.has(t)) (nodes.get(t)!.priv ? tops : already).add(t);
    for (const t of n.topsTypeOnly) if (!set.has(t)) (nodes.get(t)!.priv ? topTypes : already).add(t);
  }
  for (const w of outWrites) outReads.delete(w);
  for (const t of tops) topTypes.delete(t);
  const usedOutside = (n: Node) => [...(referrers.get(n.id) ?? [])].some(r => !set.has(r));
  const entries = ms.filter(n => (n.kind === "method" && (!n.priv || usedOutside(n))) || (n.id.startsWith("::") && n.priv && usedOutside(n))).map(n => n.id);
  const tw = new Set<string>();
  for (const n of ms) for (const w of transWrites.get(n.id)!) if (!set.has(w)) tw.add(w);
  for (const c of outMethods) for (const w of transWrites.get(c)!) if (!set.has(w)) tw.add(w);
  const fieldsTouched = new Set([...outReads, ...outWrites, ...ms.filter(n => n.kind === "field").map(n => n.id)]);
  return {
    name, members: set, lines: ms.reduce((a, n) => a + n.lines, 0), methods: ms.filter(n => n.kind === "method" || n.kind === "accessor").length,
    ownedFields: ms.filter(n => n.kind === "field").map(n => n.id), movedTops: ms.filter(n => n.id.startsWith("::")).map(n => n.id.slice(2)),
    outMethods: [...outMethods].sort(), outReads: [...outReads].sort(), outWrites: [...outWrites].sort(), entries: entries.sort(),
    topExports: [...tops].map(t => t.slice(2)).sort(), topTypeExports: [...topTypes].map(t => t.slice(2)).sort(), already: [...already].map(t => t.slice(2)).sort(),
    sites: [...nodes.values()].filter(n => !set.has(n.id)).reduce((a, n) => a + [...n.occ].filter(([k]) => set.has(k)).reduce((x, [, v]) => x + v, 0), 0),
    violations: ms.reduce((a, n) => a + n.violations, 0), nodeKeyed: [...fieldsTouched].filter(f => nodes.get(f)!.nodeKeyed).sort(), transWrites: [...tw].sort(),
    newExports: outMethods.size + outReads.size + outWrites.size + entries.length + tops.size + topTypes.size,
  };
}

const classMembers = [...nodes.values()].filter(n => !n.id.startsWith("::"));
const DIAG = new Set(["diagnostics", "firedWarnings"]);
// Fields a method reads through everything it can reach.
const transReads = new Map<string, Set<string>>();
{
  for (const n of nodes.values()) transReads.set(n.id, new Set(n.reads));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      const mine = transReads.get(n.id)!;
      for (const c of n.calls) for (const w of transReads.get(c) ?? []) if (!mine.has(w)) { mine.add(w); changed = true; }
    }
  }
}
// Who assigns a field (`this.f = ...`) after construction: such a field cannot be handed to a
// host struct by reference, it needs a getter.
const transAlias = new Map<string, Set<string>>();
{
  for (const n of nodes.values()) transAlias.set(n.id, new Set(n.aliasMut));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      const mine = transAlias.get(n.id)!;
      for (const c of [...n.calls, ...n.tops]) for (const w of transAlias.get(c) ?? []) if (!mine.has(w)) { mine.add(w); changed = true; }
    }
  }
}
const reassignedBy = (f: string) => [...nodes.values()].filter(n => n.kind !== "field" && n.kind !== "ctor" && n.writes.has(f)).map(n => n.id);

if (cmd === "members") {
  console.log(`# checker.ts: ${sf.getLineAndCharacterOfPosition(sf.getEnd()).line} lines; class members ${classMembers.length} (methods ${classMembers.filter(n => n.kind === "method").length}, fields ${classMembers.filter(n => n.kind === "field").length}); top-level decls ${nodes.size - classMembers.length}`);
  console.log("start-end\tlines\tkind\tvis\tin\tcalls\trd\twr\tviol\tname\tsection");
  for (const n of [...nodes.values()].sort((a, b) => a.start - b.start)) {
    console.log(`${n.start}-${n.end}\t${n.lines}\t${n.kind}\t${n.priv ? "priv" : "pub"}\t${fanIn(n.id)}\t${n.calls.size}\t${n.reads.size}\t${n.writes.size + n.mutates.size}\t${n.violations}\t${n.id}\t${n.section}`);
  }
} else if (cmd === "member") {
  for (const name of process.argv.slice(4)) {
  const n = nodes.get(name);
  if (!n) { console.log("no such member " + name); continue; }
  console.log(`${n.id} ${n.kind} ${n.start}-${n.end} (${n.lines} lines) ${n.priv ? "private" : "public"} viol=${n.violations}`);
  console.log(`calls: ${[...n.calls].join(" ")}`); console.log(`reads: ${[...n.reads].join(" ")}`); console.log(`writes: ${[...n.writes].join(" ")}`);
  console.log(`mutates: ${[...n.mutates].join(" ")}`); console.log(`changes in place (not a field): ${[...n.aliasMut].join(" ; ")}`); console.log(`tops: ${[...n.tops].join(" ")}`); console.log(`types: ${[...n.topsTypeOnly].join(" ")}`);
  console.log(`imports: ${[...n.imports].join(" ")}`); console.log(`referrers: ${[...(referrers.get(n.id) ?? [])].join(" ")}`);
  console.log(`transitive writes: ${[...transWrites.get(n.id)!].join(" ")}`);
  console.log(`transitive reads: ${[...transReads.get(n.id)!].join(" ")}`);
  console.log("");
  }
} else if (cmd === "dom") {
  // Dominator tree over methods, rooted at everything callable from outside (public members,
  // the constructor, field initializers). A subtree is a cluster with one entry point.
  const minLines = Number(process.argv[4] ?? 150);
  const methods = classMembers.filter(n => n.kind === "method" || n.kind === "ctor" || n.kind === "accessor");
  const ROOTID = "<root>";
  const succ = new Map<string, string[]>();
  succ.set(ROOTID, [...methods.filter(n => !n.priv).map(n => n.id), ...classMembers.filter(n => n.kind === "field").flatMap(n => [...n.calls])]);
  for (const n of methods) succ.set(n.id, [...n.calls]);
  const order: string[] = []; const seen = new Set<string>();
  const dfs = (v: string) => { const stack: [string, number][] = [[v, 0]]; seen.add(v); while (stack.length) { const top = stack[stack.length - 1]; const ss = succ.get(top[0]) ?? []; if (top[1] < ss.length) { const w = ss[top[1]++]; if (!seen.has(w)) { seen.add(w); stack.push([w, 0]); } } else { order.push(top[0]); stack.pop(); } } };
  dfs(ROOTID);
  const rpo = order.reverse(); const idx = new Map(rpo.map((v, i) => [v, i]));
  const preds = new Map<string, string[]>();
  for (const [v, ss] of succ) if (idx.has(v)) for (const w of ss) { if (!preds.has(w)) preds.set(w, []); preds.get(w)!.push(v); }
  const idom = new Map<string, string>(); idom.set(ROOTID, ROOTID);
  const inter = (a: string, b: string) => { while (a !== b) { while (idx.get(a)! > idx.get(b)!) a = idom.get(a)!; while (idx.get(b)! > idx.get(a)!) b = idom.get(b)!; } return a; };
  let ch = true;
  while (ch) { ch = false; for (const v of rpo) { if (v === ROOTID) continue; let nd: string | undefined; for (const p of preds.get(v) ?? []) if (idom.has(p)) nd = nd === undefined ? p : inter(p, nd); if (nd !== undefined && idom.get(v) !== nd) { idom.set(v, nd); ch = true; } } }
  const kids = new Map<string, string[]>();
  for (const [v, d] of idom) if (v !== d) { if (!kids.has(d)) kids.set(d, []); kids.get(d)!.push(v); }
  const sub = (v: string): string[] => [v, ...(kids.get(v) ?? []).flatMap(sub)];
  const rows: { c: Cost; root: string }[] = [];
  for (const n of methods) {
    if (!idom.has(n.id)) continue;
    const set = expand({ seeds: sub(n.id) });
    const c = cost(n.id, set);
    if (c.lines >= minLines) rows.push({ c, root: n.id });
  }
  rows.sort((a, b) => a.c.newExports / a.c.lines - b.c.newExports / b.c.lines);
  console.log("exp/100L\tlines\tmeth\tnewExp\toutM\toutR\toutW\tentries\ttops\tviol\troot (idom)");
  for (const { c, root } of rows) console.log(`${(100 * c.newExports / c.lines).toFixed(1)}\t${c.lines}\t${c.methods}\t${c.newExports}\t${c.outMethods.length}\t${c.outReads.length}\t${c.outWrites.length}\t${c.entries.length}\t${c.topExports.length + c.topTypeExports.length}\t${c.violations}\t${root} (${idom.get(root)})`);
  console.log(`unreachable methods: ${methods.filter(n => !idom.has(n.id)).map(n => n.id).join(" ")}`);
} else if (cmd === "free") {
  // Tiers of methods by what calling them can touch, transitively.
  const methods = classMembers.filter(n => n.kind === "method").sort((a, b) => a.start - b.start);
  const tier = (n: Node) => {
    const w = transWrites.get(n.id)!, r = transReads.get(n.id)!;
    const al = transAlias.get(n.id)!.size > 0;
    if (w.size === 0 && r.size === 0) return al ? "A*" : "A"; // touches no checker state: a free function (* changes an argument in place)
    if (w.size === 0) return al ? "B*" : "B";                 // reads only
    if ([...w].every(x => DIAG.has(x))) return "C";           // reads, and reports diagnostics
    return "D";
  };
  const sums: Record<string, [number, number]> = { A: [0, 0], "A*": [0, 0], B: [0, 0], "B*": [0, 0], C: [0, 0], D: [0, 0] };
  for (const n of methods) {
    const t = tier(n); sums[t][0]++; sums[t][1] += n.lines;
    if (t !== "D") console.log(`${t}\t${n.start}-${n.end}\t${n.lines}\tin${fanIn(n.id)}\tv${n.violations}\t${n.id}\t${[...transReads.get(n.id)!].filter(x => !DIAG.has(x)).join(",")}\t${[...transAlias.get(n.id)!].join(";")}`);
  }
  console.log(`tiers (methods, lines): A free ${sums.A} | A* free, changes an argument in place ${sums["A*"]} | B read-only ${sums.B} | B* reads fields, changes a shared record in place ${sums["B*"]} | C diagnostics only ${sums.C} | D writes checker fields ${sums.D}`);
} else if (cmd === "fields") {
  console.log("line\tname\tvis\tnodeKeyed\treaders\twriters\treassignedBy");
  for (const n of classMembers.filter(n => n.kind === "field").sort((a, b) => a.start - b.start)) {
    const readers = [...nodes.values()].filter(m => m.reads.has(n.id)).length;
    const writers = [...nodes.values()].filter(m => m.writes.has(n.id) || m.mutates.has(n.id)).map(m => m.id);
    console.log(`${n.start}\t${n.id}\t${n.priv ? "priv" : "pub"}\t${n.nodeKeyed ? "node" : ""}\t${readers}\t${writers.length}:${writers.slice(0, 6).join(",")}\t${reassignedBy(n.id).join(",")}`);
  }
} else if (cmd === "prefix") {
  const groups = new Map<string, string[]>();
  for (const n of classMembers) if (n.kind === "method") { const p = /^_?[a-z]+/.exec(n.id)?.[0] ?? n.id; if (!groups.has(p)) groups.set(p, []); groups.get(p)!.push(n.id); }
  console.log("prefix\tn\tlines");
  for (const [p, ids] of [...groups].sort((a, b) => b[1].reduce((s, i) => s + nodes.get(i)!.lines, 0) - a[1].reduce((s, i) => s + nodes.get(i)!.lines, 0))) console.log(`${p}\t${ids.length}\t${ids.reduce((s, i) => s + nodes.get(i)!.lines, 0)}`);
} else if (cmd === "clusters" || cmd === "cluster") {
  const specs = JSON.parse(readFileSync(process.argv[4]!, "utf-8")) as Record<string, Spec>;
  const costs = Object.entries(specs).filter(([k]) => cmd === "clusters" || process.argv.length <= 5 || process.argv.slice(5).includes(k)).map(([k, s]) => ({ c: cost(k, expand(s)), s }));
  if (cmd === "clusters") {
    // A member claimed by two clusters would be double counted in the plan.
    const owner = new Map<string, string>();
    for (const { c } of costs) for (const m of c.members) { if (owner.has(m)) console.error(`overlap: ${m} in ${owner.get(m)} and ${c.name}`); else owner.set(m, c.name); }
    costs.sort((a, b) => a.c.newExports / a.c.lines - b.c.newExports / b.c.lines);
    console.log("| cluster | lines | methods | owned fields | host methods | fields read | fields written | entries | top-level exports | new exports | exports / 100 lines | writes reachable (non-diagnostic) | ts2milo violations | pure pass |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    let total = 0;
    for (const { c, s } of costs) {
      total += c.lines;
      const tw = c.transWrites.filter(w => !DIAG.has(w));
      const pure = c.outWrites.filter(w => !DIAG.has(w)).length === 0 && tw.length === 0 ? "yes" : c.outWrites.filter(w => !DIAG.has(w)).length === 0 ? `reads only, host calls write ${tw.length}` : "no";
      console.log(`| ${c.name} | ${c.lines} | ${c.methods} | ${c.ownedFields.length} | ${c.outMethods.length} | ${c.outReads.length} | ${c.outWrites.length} | ${c.entries.length} | ${c.topExports.length + c.topTypeExports.length} | ${c.newExports} | ${(100 * c.newExports / c.lines).toFixed(1)} | ${tw.length} | ${c.violations} | ${s.note ?? pure} |`);
    }
    console.log(`\nclustered lines: ${total} of ${sf.getLineAndCharacterOfPosition(sf.getEnd()).line}`);
  } else {
    for (const { c } of costs) {
      console.log(`## ${c.name}: ${c.lines} lines, ${c.methods} methods, new exports ${c.newExports}, violations ${c.violations}, mentions to rewrite in checker.ts ${c.sites}`);
      const ms = [...c.members].map(id => nodes.get(id)!).sort((a, b) => a.start - b.start);
      console.log("members (start-end lines name):");
      for (const n of ms) console.log(`  ${n.start}-${n.end}\t${n.lines}\t${n.kind}\t${n.id}`);
      console.log(`entries (called from the rest of checker.ts): ${c.entries.map(e => `${e}[${[...nodes.values()].filter(n => !c.members.has(n.id)).reduce((a, n) => a + (n.occ.get(e) ?? 0), 0)}]`).join(" ")}`);
      console.log(`host methods: ${c.outMethods.join(" ")}`);
      const fld = (f: string) => { const r = reassignedBy(f); return r.length ? `${f}(getter: reassigned by ${r.slice(0, 3).join(",")}${r.length > 3 ? ",..." : ""})` : f; };
      console.log(`host fields read: ${c.outReads.map(fld).join(" ")}`);
      console.log(`host fields written/mutated: ${c.outWrites.map(f => { const ms2 = [...c.members].map(id => nodes.get(id)!); const assigned = ms2.some(n => n.writes.has(f)); return (assigned ? f + "(assigned)" : fld(f)); }).join(" ")}`);
      console.log(`host methods with fan-in: ${c.outMethods.map(m => `${m}[${fanIn(m)}${[...transWrites.get(m)!].every(w => DIAG.has(w)) ? "" : ",W"}]`).join(" ")}`);
      console.log(`owned fields (move with it): ${c.ownedFields.join(" ")}`);
      console.log(`top-level moved with it: ${c.movedTops.join(" ")}`);
      console.log(`top-level to export (value): ${c.topExports.join(" ")}`);
      console.log(`top-level to export (type only): ${c.topTypeExports.join(" ")}`);
      console.log(`top-level already exported, import from ./checker: ${c.already.join(" ")}`);
      console.log(`node-keyed collections touched: ${c.nodeKeyed.join(" ")}`);
      console.log(`fields reachable writes (through host calls too): ${c.transWrites.join(" ")}`);
      const imps = new Set<string>(); for (const n of ms) for (const i of n.imports) imps.add(i);
      console.log(`imports used: ${[...imps].sort().join(" ")}`);
    }
  }
}
