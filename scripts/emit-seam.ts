// Seam measurement for src/emit-mlir.ts (docs/plans/emit-mlir-split.md, plan A).
//   bun scripts/emit-seam.ts . [--json out.json] [--members] [--top] [--dom] [--greedy N] [--cluster a,b,c]
// Uses the TypeScript checker for symbol resolution, so `inner.callees` on another FnEmitter
// counts as a member reference just like `this.callees`.
import { join } from "path";
import { writeFileSync } from "fs";

const root = process.argv[2];
const argv = process.argv.slice(3);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ts: typeof import("typescript") = require(join(root, "node_modules/typescript"));
const FILE = join(root, "src/emit-mlir.ts");
const CTX = join(root, "src/mlir-ctx.ts");

const program = ts.createProgram([FILE], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: true, types: ["bun-types"], allowImportingTsExtensions: true });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(FILE)!;
const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

type Decl = { name: string; kind: string; exported: boolean; start: number; end: number; lines: number; vis?: string; node: import("typescript").Node };
const tops: Decl[] = [];
const members: Decl[] = [];
let cls: import("typescript").ClassDeclaration | undefined;
const startOf = (n: import("typescript").Node) => line(n.getStart(sf, true)); // with leading JSDoc
const leadStart = (n: import("typescript").Node) => {
  // Leading `//` comment lines belong to the declaration they describe: they move with it.
  const ranges = ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? [];
  return ranges.length ? line(ranges[0].pos) : startOf(n);
};
const mk = (name: string, kind: string, n: import("typescript").Node, exported: boolean, vis?: string): Decl => {
  const start = leadStart(n), end = line(n.getEnd());
  return { name, kind, exported, start, end, lines: end - start + 1, vis, node: n };
};
const isExported = (n: import("typescript").Node) => !!(ts.getCombinedModifierFlags(n as any) & ts.ModifierFlags.Export);
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st)) continue;
  if (ts.isVariableStatement(st)) {
    const names = st.declarationList.declarations.map(d => d.name.getText(sf));
    for (const d of st.declarationList.declarations) tops.push({ ...mk(d.name.getText(sf), "const", st, isExported(st)), node: d });
    if (names.length > 1) for (const t of tops.slice(-names.length)) t.lines = Math.ceil(t.lines / names.length);
  } else if (ts.isClassDeclaration(st) && st.name?.text === "FnEmitter") {
    cls = st;
    tops.push(mk("FnEmitter", "class", st, isExported(st)));
  } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
    tops.push(mk(st.name.text, ts.SyntaxKind[st.kind].replace("Declaration", "").toLowerCase(), st, isExported(st)));
  }
}
if (!cls) throw new Error("FnEmitter not found");
for (const m of cls.members) {
  const vis = (ts.getCombinedModifierFlags(m as any) & ts.ModifierFlags.Private) ? "private" : "public";
  if (ts.isConstructorDeclaration(m)) {
    members.push(mk("constructor", "ctor", m, false, "public"));
    for (const p of m.parameters) if (p.modifiers?.length) members.push({ ...mk(p.name.getText(sf), "field", p, false, (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Private) ? "private" : "public"), lines: 0 });
  } else if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
    const name = m.name.getText(sf);
    const prev = members.find(x => x.name === name && x.kind === "method");
    if (prev && !m.body) continue;
    if (prev) { prev.end = line(m.getEnd()); prev.lines = prev.end - prev.start + 1; prev.node = m; continue; } // overload signatures then the body
    members.push(mk(name, "method", m, false, vis));
  } else if (ts.isPropertyDeclaration(m)) {
    const fnInit = m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer));
    members.push(mk(m.name.getText(sf), fnInit ? "method" : "field", m, false, vis));
  }
}

// Which declaration a symbol belongs to.
const topByNode = new Map<import("typescript").Node, Decl>();
for (const t of tops) topByNode.set(t.node, t);
const memberByName = new Map(members.map(m => [m.name, m]));
const declOwner = (d: import("typescript").Node): { where: "top" | "member" | "ctx" | "import" | "other"; name: string } => {
  const f = d.getSourceFile();
  if (f === sf) {
    for (let n: import("typescript").Node | undefined = d; n; n = n.parent) {
      if (n.parent === cls) {
        const nm = ts.isConstructorDeclaration(n) ? "constructor" : (n as any).name?.getText(sf);
        // A member declared by a constructor parameter property.
        return { where: "member", name: nm };
      }
      if (ts.isParameter(n) && n.parent && ts.isConstructorDeclaration(n.parent) && n.parent.parent === cls && n.modifiers?.length && n === d) return { where: "member", name: n.name.getText(sf) };
      if (topByNode.has(n)) return { where: "top", name: topByNode.get(n)!.name };
      if (ts.isVariableStatement(n) && n.parent === sf) break;
    }
    return { where: "other", name: "" };
  }
  if (f.fileName === CTX) {
    for (let n: import("typescript").Node | undefined = d; n; n = n.parent) if (ts.isClassDeclaration(n) && n.name?.text === "ModuleCtx") return { where: "ctx", name: (d as any).name?.getText(f) ?? "?" };
  }
  if (f.fileName.startsWith(join(root, "src"))) return { where: "import", name: `${f.fileName.slice(root.length + 5).replace(/\.ts$/, "")}:${(d as any).name?.getText?.(f) ?? "?"}` };
  return { where: "other", name: "" };
};

type Use = { r: number; w: number; call: number };
type Info = { top: Map<string, number>; mem: Map<string, Use>; ctx: Map<string, Use>; imp: Map<string, number> };
const info = new Map<string, Info>(); // key: "T:name" for a top-level decl, "M:name" for a member
const get = (k: string) => { let i = info.get(k); if (!i) info.set(k, i = { top: new Map(), mem: new Map(), ctx: new Map(), imp: new Map() }); return i; };
const MUTATORS = new Set(["push", "pop", "set", "add", "delete", "clear", "splice", "shift", "unshift", "sort", "fill", "reverse"]);
const access = (id: import("typescript").Identifier): keyof Use => {
  let n: import("typescript").Node = id;
  if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === id) n = n.parent;
  const p = n.parent;
  if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return "w";
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return "w";
  if (ts.isCallExpression(p) && p.expression === n) return "call";
  if (ts.isPropertyAccessExpression(p) && p.expression === n) {
    if (ts.isCallExpression(p.parent) && p.parent.expression === p && MUTATORS.has(p.name.text)) return "w";
    if (p.name.text === "length" && ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return "w";
    // `this.x.next++`, `this.x.f = v`
    const pp = p.parent;
    if (ts.isBinaryExpression(pp) && pp.left === p && pp.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && pp.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return "w";
    if ((ts.isPrefixUnaryExpression(pp) || ts.isPostfixUnaryExpression(pp)) && (pp.operator === ts.SyntaxKind.PlusPlusToken || pp.operator === ts.SyntaxKind.MinusMinusToken)) return "w";
  }
  if (ts.isElementAccessExpression(p) && p.expression === n && ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return "w";
  return "r";
};
const bump = (m: Map<string, Use>, k: string, a: keyof Use) => { const u = m.get(k) ?? { r: 0, w: 0, call: 0 }; u[a]++; m.set(k, u); };

const visit = (owner: string, n: import("typescript").Node) => {
  if (ts.isIdentifier(n)) {
    // Skip the name of the declaration itself.
    const par = n.parent as any;
    if (par && par.name === n && !ts.isPropertyAccessExpression(par) && !ts.isQualifiedName(par) && !ts.isShorthandPropertyAssignment(par)) return;
    let sym = ts.isShorthandPropertyAssignment(par) ? checker.getShorthandAssignmentValueSymbol(par) : checker.getSymbolAtLocation(n);
    if (sym && (sym.flags & ts.SymbolFlags.Alias)) sym = checker.getAliasedSymbol(sym);
    const d = sym?.declarations?.[0];
    if (!d) return;
    const o = declOwner(d);
    const i = get(owner);
    if (o.where === "top") { if (`T:${o.name}` !== owner) i.top.set(o.name, (i.top.get(o.name) ?? 0) + 1); }
    else if (o.where === "member") { if (`M:${o.name}` !== owner || memberByName.get(o.name)?.kind === "method") bump(i.mem, o.name, access(n)); }
    else if (o.where === "ctx") bump(i.ctx, o.name, access(n));
    else if (o.where === "import") i.imp.set(o.name, (i.imp.get(o.name) ?? 0) + 1);
    return;
  }
  ts.forEachChild(n, c => visit(owner, c));
};
for (const t of tops) if (t.kind !== "class" || t.name !== "FnEmitter") visit(`T:${t.name}`, t.node);
for (const m of cls.members) {
  const name = ts.isConstructorDeclaration(m) ? "constructor" : (m as any).name?.getText(sf);
  if (!name) continue;
  visit(`M:${name}`, m);
}
// `this.cx.x` resolves to the MlirEmitCtx interface member (a top-level decl here), not ModuleCtx:
// count those as ctx uses by member name.
{
  const iface = sf.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text === "MlirEmitCtx") as import("typescript").InterfaceDeclaration;
  const names = new Set(iface.members.map(m => (m.name as any)?.getText(sf)));
  const scan = (owner: string, n: import("typescript").Node) => {
    if (ts.isPropertyAccessExpression(n) && names.has(n.name.text)) {
      const t = checker.getTypeAtLocation(n.expression);
      if (t.symbol?.name === "MlirEmitCtx" || t.symbol?.name === "ModuleCtx") bump(get(owner).ctx, n.name.text, access(n.name as any));
    }
    ts.forEachChild(n, c => scan(owner, c));
  };
  for (const t of tops) if (t.name !== "FnEmitter" && t.name !== "MlirEmitCtx") scan(`T:${t.name}`, t.node);
  for (const m of cls.members) { const name = ts.isConstructorDeclaration(m) ? "constructor" : (m as any).name?.getText(sf); if (name) scan(`M:${name}`, m); }
}

const methods = members.filter(m => m.kind === "method" || m.kind === "ctor");
const fields = members.filter(m => m.kind === "field");
const fieldSet = new Set(fields.map(f => f.name));
const classLines = tops.find(t => t.name === "FnEmitter")!;

// Who references each top-level symbol: other top-levels, class members.
const topUsers = new Map<string, { tops: Set<string>; mems: Set<string> }>();
for (const t of tops) topUsers.set(t.name, { tops: new Set(), mems: new Set() });
for (const [k, i] of info) for (const name of i.top.keys()) {
  const u = topUsers.get(name); if (!u) continue;
  (k.startsWith("T:") ? u.tops : u.mems).add(k.slice(2));
}

if (flag("--top")) {
  console.log("# top-level declarations: start-end lines kind exported name | used by top-levels / members | uses top-levels | ctx members");
  for (const t of tops) {
    const u = topUsers.get(t.name)!; const i = info.get(`T:${t.name}`);
    console.log(`${t.start}-${t.end}\t${t.lines}\t${t.kind}\t${t.exported ? "export" : "-"}\t${t.name}\tby ${u.tops.size}T/${u.mems.size}M\tuses [${[...(i?.top.keys() ?? [])].join(",")}]\tctx [${[...(i?.ctx.keys() ?? [])].join(",")}]`);
  }
}
if (flag("--members")) {
  console.log(`# FnEmitter ${classLines.start}-${classLines.end}: ${methods.length} methods, ${fields.length} fields`);
  for (const f of fields) {
    const rs = new Set<string>(), ws = new Set<string>();
    for (const [k, i] of info) if (k.startsWith("M:")) { const u = i.mem.get(f.name); if (u) { if (u.w) ws.add(k.slice(2)); if (u.r || u.call) rs.add(k.slice(2)); } }
    console.log(`field\t${f.start}\t${f.vis}\t${f.name}\treaders ${rs.size}\twriters ${ws.size}${ws.size && ws.size <= 6 ? ` [${[...ws].join(",")}]` : ""}`);
  }
  for (const m of methods) {
    const i = get(`M:${m.name}`);
    const fr = [...i.mem].filter(([k, u]) => fieldSet.has(k) && (u.r || u.call)).map(([k]) => k);
    const fw = [...i.mem].filter(([k, u]) => fieldSet.has(k) && u.w).map(([k]) => k);
    const calls = [...i.mem.keys()].filter(k => !fieldSet.has(k));
    console.log(`method\t${m.start}-${m.end}\t${m.lines}\t${m.vis}\t${m.name}\treads [${fr.join(",")}]\twrites [${fw.join(",")}]\tcx [${[...i.ctx.keys()].join(",")}]\tcalls ${calls.length}\ttop [${[...i.top.keys()].join(",")}]`);
  }
}

// ---- dominator subtrees over the member call graph
const mnames = methods.map(m => m.name);
const succ = new Map<string, string[]>();
for (const m of mnames) succ.set(m, [...get(`M:${m}`).mem.keys()].filter(k => !fieldSet.has(k) && k !== m && memberByName.has(k)));
// Roots: members used from outside the class, plus the constructor.
const extRoots = new Set<string>(["constructor"]);
for (const [k, i] of info) if (k.startsWith("T:")) for (const name of i.mem.keys()) if (!fieldSet.has(name)) extRoots.add(name);
// Property-initializer fields call methods too (rare); treat their callees as roots.
for (const f of fields) for (const k of get(`M:${f.name}`).mem.keys()) if (!fieldSet.has(k)) extRoots.add(k);
const ROOT = "<root>";
succ.set(ROOT, [...extRoots]);
const order: string[] = []; const seen = new Set<string>();
const dfs = (n: string) => { if (seen.has(n)) return; seen.add(n); for (const s of succ.get(n) ?? []) dfs(s); order.push(n); };
dfs(ROOT);
const rpo = order.slice().reverse(); const idx = new Map(rpo.map((n, i) => [n, i]));
const preds = new Map<string, string[]>();
for (const [a, ss] of succ) for (const b of ss) { if (!preds.has(b)) preds.set(b, []); preds.get(b)!.push(a); }
const idom = new Map<string, string>([[ROOT, ROOT]]);
const intersect = (a: string, b: string) => { while (a !== b) { while (idx.get(a)! > idx.get(b)!) a = idom.get(a)!; while (idx.get(b)! > idx.get(a)!) b = idom.get(b)!; } return a; };
for (let changed = true; changed;) {
  changed = false;
  for (const n of rpo) {
    if (n === ROOT) continue;
    let nd: string | undefined;
    for (const p of preds.get(n) ?? []) if (idom.has(p)) nd = nd === undefined ? p : intersect(p, nd);
    if (nd !== undefined && idom.get(n) !== nd) { idom.set(n, nd); changed = true; }
  }
}
const kids = new Map<string, string[]>();
for (const [n, d] of idom) if (n !== ROOT) { if (!kids.has(d)) kids.set(d, []); kids.get(d)!.push(n); }
const subtree = (n: string): string[] => [n, ...(kids.get(n) ?? []).flatMap(subtree)];
const unreachable = mnames.filter(m => !seen.has(m));

// Cost of moving a set of methods out of the class into another module.
const privateTopOnlyUsedBy = (S: Set<string>) => tops.filter(t => t.name !== "FnEmitter" && !t.exported && (() => { const u = topUsers.get(t.name)!; return u.tops.size === 0 && u.mems.size > 0 && [...u.mems].every(m => S.has(m)); })());
const cost = (list: string[], opened: Set<string>) => {
  const S = new Set(list);
  const lines = list.reduce((a, m) => a + memberByName.get(m)!.lines, 0);
  const hostMethods = new Set<string>(), hostFields = new Set<string>(), fieldWrites = new Set<string>(), topNeeded = new Set<string>(), ctx = new Set<string>();
  for (const m of list) {
    const i = get(`M:${m}`);
    for (const [k, u] of i.mem) { if (S.has(k)) continue; if (fieldSet.has(k)) { hostFields.add(k); if (u.w) fieldWrites.add(k); } else hostMethods.add(k); }
    for (const k of i.top.keys()) topNeeded.add(k);
    for (const k of i.ctx.keys()) ctx.add(k);
  }
  // Fields only this cluster touches move with it (the cluster owns that state).
  const ownedFields = [...hostFields].filter(f => [...info].every(([k, i]) => !k.startsWith("M:") || S.has(k.slice(2)) || k === `M:${f}` || !i.mem.has(f)));
  for (const f of ownedFields) hostFields.delete(f);
  const movesAlong = new Set(privateTopOnlyUsedBy(S).map(t => t.name));
  const topExports = [...topNeeded].filter(t => !tops.find(x => x.name === t)!.exported && !movesAlong.has(t));
  const entries = list.filter(m => (preds.get(m) ?? []).some(p => !S.has(p)));
  const hostPrivate = [...hostMethods, ...hostFields].filter(k => memberByName.get(k)!.vis === "private");
  const newOpen = hostPrivate.filter(k => !opened.has(k));
  const newTop = topExports.filter(k => !opened.has(`T:${k}`));
  const alongLines = [...movesAlong].reduce((a, t) => a + tops.find(x => x.name === t)!.lines, 0);
  return { lines: lines + alongLines, methodLines: lines, entries, hostMethods: [...hostMethods], hostFields: [...hostFields], fieldWrites: [...fieldWrites], ownedFields, topExports, movesAlong: [...movesAlong], ctx: [...ctx], newOpen, newTop, exports: entries.length + newOpen.length + newTop.length };
};

if (flag("--dom")) {
  console.log(`# roots (used from outside the class): ${[...extRoots].join(", ")}`);
  console.log(`# unreachable methods: ${unreachable.join(", ") || "none"}`);
  const rows = mnames.filter(m => seen.has(m)).map(m => ({ m, list: subtree(m) })).filter(r => r.list.length > 1).map(r => ({ ...r, c: cost(r.list, new Set()) })).filter(r => r.c.lines >= 80);
  rows.sort((a, b) => a.c.exports / a.c.lines - b.c.exports / b.c.lines);
  console.log("# dominator subtrees >= 80 lines, cold cost (nothing opened yet): head lines methods exports(entries+host+top) per100");
  for (const r of rows.slice(0, 60)) console.log(`${r.m}\t${memberByName.get(r.m)!.start}\t${r.c.lines}\t${r.list.length}\t${r.c.exports} (${r.c.entries.length}+${r.c.newOpen.length}+${r.c.newTop.length})\t${(100 * r.c.exports / r.c.lines).toFixed(2)}\tidom=${idom.get(r.m)}`);
}

const show = (label: string, list: string[], opened: Set<string>) => {
  const c = cost(list, opened);
  const spans = list.map(m => memberByName.get(m)!).sort((a, b) => a.start - b.start);
  console.log(`## ${label}: ${c.lines} lines (${c.methodLines} in ${list.length} methods + ${c.lines - c.methodLines} top-level that moves along), new exports ${c.exports} = ${c.entries.length} entry + ${c.newOpen.length} host members opened + ${c.newTop.length} top-level exported; ${(100 * c.exports / c.lines).toFixed(2)} per 100 lines`);
  console.log(`  methods: ${spans.map(s => `${s.name}@${s.start}-${s.end}`).join(" ")}`);
  console.log(`  entries: ${c.entries.join(", ")}`);
  console.log(`  host methods used: ${c.hostMethods.join(", ")}`);
  console.log(`  host fields used: ${c.hostFields.join(", ")} (written: ${c.fieldWrites.filter(f => c.hostFields.includes(f)).join(", ") || "none"})`);
  console.log(`  fields only this cluster touches: ${c.ownedFields.join(", ") || "none"}`);
  console.log(`  newly opened host members: ${c.newOpen.join(", ") || "none"}`);
  console.log(`  top-level moved along: ${c.movesAlong.join(", ") || "none"}; top-level newly exported: ${c.newTop.join(", ") || "none"}`);
  console.log(`  ctx members: ${c.ctx.join(", ")}`);
  return c;
};

if (opt("--greedy")) {
  const N = Number(opt("--greedy")), min = Number(opt("--min") ?? 150), max = Number(opt("--max") ?? 1400);
  // --opened: members already non-private and (as T:name) top-level names already exported.
  // --gone: methods an earlier extraction already took out of the class.
  const opened = new Set<string>((opt("--opened") ?? "").split(",").filter(Boolean)), gone = new Set<string>((opt("--gone") ?? "").split(",").filter(Boolean).flatMap(n => n.endsWith("*") ? subtree(n.slice(0, -1)) : [n]));
  for (let k = 0; k < N; k++) {
    let best: { m: string; list: string[]; score: number } | null = null;
    for (const m of mnames) {
      if (!seen.has(m) || gone.has(m)) continue;
      const list = subtree(m).filter(x => !gone.has(x));
      const c = cost(list, opened);
      if (c.lines < min || c.lines > max) continue;
      const score = c.exports / c.lines;
      if (!best || score < best.score) best = { m, list, score };
    }
    if (!best) break;
    const c = show(`pick ${k + 1}: subtree of ${best.m}`, best.list, opened);
    for (const x of c.newOpen) opened.add(x);
    // An extracted cluster's entry points are exported functions from then on: a later cluster
    // calling one pays nothing more.
    for (const x of c.entries) opened.add(x);
    for (const x of c.newTop) opened.add(`T:${x}`);
    for (const x of best.list) gone.add(x);
  }
}
if (opt("--cluster")) for (const spec of opt("--cluster")!.split(";")) {
  const list = spec.split(",").flatMap(n => n.endsWith("*") ? subtree(n.slice(0, -1)) : [n]);
  show(`cluster ${spec}`, [...new Set(list)], new Set((opt("--opened") ?? "").split(",").filter(Boolean)));
}
// A run of top-level declarations by line range: what must be exported if it moves to its own file.
if (opt("--topcluster")) for (const spec of opt("--topcluster")!.split(";")) {
  const ranges = spec.split(",").map(r => r.split("-").map(Number));
  const T = tops.filter(t => t.name !== "FnEmitter" && ranges.some(([a, b]) => t.start >= a && t.end <= b));
  const names = new Set(T.map(t => t.name));
  const usedOutside = T.filter(t => { const u = topUsers.get(t.name)!; return u.mems.size > 0 || [...u.tops].some(x => !names.has(x)); });
  const back = new Set<string>();
  for (const t of T) for (const k of get(`T:${t.name}`).top.keys()) if (!names.has(k)) back.add(k);
  const ctx = new Set<string>(); for (const t of T) for (const k of get(`T:${t.name}`).ctx.keys()) ctx.add(k);
  const imps = new Set<string>(); for (const t of T) for (const k of get(`T:${t.name}`).imp.keys()) imps.add(k.split(":")[0]);
  const lines = ranges.reduce((s, [a, b]) => s + b - a + 1, 0);
  const fresh = usedOutside.filter(t => !t.exported);
  console.log(`## top-level ${spec}: ${T.length} declarations, ${lines} lines; used outside the run: ${usedOutside.length} (${fresh.length} not exported today); ${(100 * fresh.length / lines).toFixed(2)} new exports per 100 lines`);
  console.log(`  new exports: ${fresh.map(t => t.name).join(", ")}`);
  console.log(`  already exported, used outside: ${usedOutside.filter(t => t.exported).map(t => t.name).join(", ") || "none"}`);
  console.log(`  stays private in the new file: ${T.filter(t => !usedOutside.includes(t)).map(t => t.name).join(", ")}`);
  console.log(`  refers back to declarations outside the run: ${[...back].join(", ") || "none"}`);
  console.log(`  ctx members: ${[...ctx].join(", ")}; imports from: ${[...imps].join(", ")}`);
}
// Methods that never touch per-function emitter state: their transitive closure reads only the
// fields in --pure (default cx,fn,fns,fx) and writes none. These can be free functions.
if (flag("--pure") || opt("--pure")) {
  const allowed = new Set((opt("--pure") && !opt("--pure")!.startsWith("--") ? opt("--pure")! : "cx,fn,fns,fx").split(","));
  const memo = new Map<string, { fields: Set<string>; writes: Set<string> }>();
  for (const m of mnames) {
    const out = { fields: new Set<string>(), writes: new Set<string>() };
    for (const [k, u] of get(`M:${m}`).mem) if (fieldSet.has(k)) { out.fields.add(k); if (u.w) out.writes.add(k); }
    memo.set(m, out);
  }
  // Plain fixpoint over the call graph: a method's set is its own plus every callee's.
  for (let changed = true; changed;) {
    changed = false;
    for (const m of mnames) {
      const out = memo.get(m)!;
      for (const k of succ.get(m) ?? []) {
        const r = memo.get(k); if (!r) continue;
        for (const f of r.fields) if (!out.fields.has(f)) { out.fields.add(f); changed = true; }
        for (const f of r.writes) if (!out.writes.has(f)) { out.writes.add(f); changed = true; }
      }
    }
  }
  const pure = mnames.filter(m => m !== "constructor" && [...memo.get(m)!.fields].every(f => allowed.has(f)) && memo.get(m)!.writes.size === 0);
  const P = new Set(pure);
  const lines = pure.reduce((a, m) => a + memberByName.get(m)!.lines, 0);
  const entries = pure.filter(m => (preds.get(m) ?? []).some(q => !P.has(q)));
  const c = cost(pure, new Set());
  console.log(`## pure over {${[...allowed].join(",")}}: ${pure.length} methods, ${lines} lines, ${entries.length} called from the rest of the class, top-level it needs exported: ${c.topExports.length}`);
  for (const m of pure) { const d = memberByName.get(m)!; const i = get(`M:${m}`); console.log(`  ${d.start}-${d.end}\t${d.lines}\t${m}\tfields [${[...memo.get(m)!.fields].join(",")}]\tcx [${[...i.ctx.keys()].join(",")}]\ttop [${[...i.top.keys()].join(",")}]\tcallers ${(preds.get(m) ?? []).filter(q => !P.has(q)).length}`); }
}
if (opt("--json")) {
  const ser = (m: Map<string, any>) => Object.fromEntries(m);
  writeFileSync(opt("--json")!, JSON.stringify({
    tops: tops.map(({ node, ...t }) => t), members: members.map(({ node, ...m }) => m),
    refs: Object.fromEntries([...info].map(([k, i]) => [k, { top: ser(i.top), mem: ser(i.mem), ctx: ser(i.ctx), imp: ser(i.imp) }])),
    idom: ser(idom),
  }, null, 1));
}
console.log(`# ${sf.fileName.slice(root.length + 1)}: ${sf.getLineAndCharacterOfPosition(sf.getEnd()).line} lines, ${tops.length} top-level declarations, ${methods.length} methods, ${fields.length} fields`);
