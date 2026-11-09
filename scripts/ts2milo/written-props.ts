// Proof that a data type is never mutated around a copy: no translated code that can run while the copy lives
// writes any property reachable from it. A copy (clone) of such a value is indistinguishable from the shared
// TypeScript reference, so it needs no read-only-destination proof.
// Soundness: a write is seen through both aliases only if it runs after the copy, i.e. inside the copy site's
// function, a transitive callee, or the continuation of a transitive caller. So the written set is the union over
// reach(F) = forward call-graph closure of ({F} + all transitive callers of F). The graph over-approximates: every
// reference to a function is an edge, an unresolved call (function-typed property or parameter, interface method)
// may reach any address-taken function of a fitting type, a class reference reaches its constructors, and module-level
// code (it runs once at load) is in reach only for a site in it. A write in a phase no caller connects to F is not counted.
// A temporary borrowed for one call (a variant wrapped as its union to be passed as `&Union`) dies when the call ends,
// so its reach is the call expression's own writes and callees, with no caller continuation (regionReach).
// A copy can be stored and outlive the entry call that made it, so code the driver runs LATER counts too. The driver
// lives outside the translated files; the one thing assumed of it is that it calls translated functions in
// non-decreasing phase order of their files (PHASES: lex, parse, resolve, check, emit). So a site whose earliest
// possible entry is in phase p also gets every write reachable from a function of phase >= p, and from every function
// in a file with no phase (ast.ts, types.ts: callable at any time). Only writes of strictly earlier phases are dropped:
// the parser filling in a node cannot be seen through a copy the checker makes afterwards.
// A write `o.p = v` to a fresh local object (isConstruction) is no write: no alias of o exists yet.
import ts from "typescript";

// Not scanned: `delete x.f` and `Object.assign(x, ..)` are write forms ts2milo refuses (tests/ts2milo.test.ts pins it), so a
// function using one is stubbed and the write never happens in the generated program.
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);
const MODULE = "<module>";
// Driver order of the frontend's files. A file matching none can run in any phase.
const PHASES = [/^(tokens|lexer)$/, /^parser(-.*)?$/, /^resolver$/, /^(checker(-.*)?|mutability-scan)$/, /^(backend-program|emit-.*|mlir-.*|scaffold)$/];
// The phase of a function key ("<file>.ts:<pos>" or "class:<file>.ts:<pos>"); undefined = any phase.
function phaseOfKey(k: string): number | undefined {
  const m = /([^/]+)\.ts:\d+$/.exec(k);
  if (!m) return undefined;
  const i = PHASES.findIndex((re) => re.test(m[1]));
  return i < 0 ? undefined : i;
}

type Writes = { decls: Set<ts.Declaration>; opaque: boolean };

export function buildImmutability(program: ts.Program, checker: ts.TypeChecker, files: string[]): (t: ts.Type, site: ts.Node, region?: ts.Node) => boolean {
  const writesOf = new Map<string, Writes>();
  let cur: Writes = { decls: new Set(), opaque: false }; // writes of the function being scanned; opaque = a write the scan cannot attribute to a property (a spread or method member on an assignment target)
  const fileSet = new Set(files.map((f) => program.getSourceFile(f)?.fileName).filter((f): f is string => !!f));
  // The unit of reachability is the outermost function-like around a node: closures belong to their enclosing function.
  const keyOf = (n: ts.Node): string => {
    let r: ts.Node | undefined;
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (ts.isFunctionLike(p) && !ts.isFunctionTypeNode(p) && !ts.isMethodSignature(p) && !ts.isCallSignatureDeclaration(p)) r = p;
    if (r) return `${r.getSourceFile().fileName}:${r.pos}`;
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (ts.isPropertyDeclaration(p) && ts.isClassLike(p.parent)) return classKey(p.parent);
    return MODULE;
  };
  // Field initializers run when an instance is constructed.
  const classKey = (c: ts.Node): string => `class:${c.getSourceFile().fileName}:${c.pos}`;
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => { let s = edges.get(from); if (!s) edges.set(from, (s = new Set())); s.add(to); };
  // Functions referenced other than as a callee, with their nodes; an unresolved call reaches those whose type fits the callee type.
  const addressTaken = new Map<string, Set<ts.Node>>();
  const unresolved: { from: string; type: ts.Type }[] = [];
  const methodsByName = new Map<string, Set<string>>();
  const bySignatureName: { from: string; name: string }[] = [];

  const collectEdges = (n: ts.Node, from: string): void => {
    if (!ts.isIdentifier(n)) return;
    const p = n.parent;
    // A declaration name or an import/export specifier names a function without using it.
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isMethodDeclaration(p) || ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p) || ts.isMethodSignature(p) || ts.isPropertySignature(p)) && p.name === n)) return;
    let sym = checker.getSymbolAtLocation(n);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const isCall = (ts.isCallExpression(p) && p.expression === n) || (ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p) || (ts.isNewExpression(p) && p.expression === n);
    for (const d of sym?.declarations ?? []) {
      const body = ts.isFunctionLike(d) && !ts.isMethodSignature(d) ? d
        : (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) && d.initializer && ts.isFunctionLike(d.initializer) ? d.initializer : undefined;
      if (body) {
        if (!fileSet.has(body.getSourceFile().fileName)) continue;
        addEdge(from, keyOf(body));
        // A call through a base type may run a same-named override.
        if (ts.isMethodDeclaration(body)) bySignatureName.push({ from, name: body.name.getText() });
        if (!isCall) { const k = keyOf(body); let s = addressTaken.get(k); if (!s) addressTaken.set(k, (s = new Set())); s.add(body); }
      } else if (ts.isClassDeclaration(d)) {
        addEdge(from, classKey(d));
        for (const m of d.members) if (ts.isConstructorDeclaration(m)) addEdge(from, keyOf(m));
      } else if (!fileSet.has(d.getSourceFile().fileName)) {
        // A library member (JSON.parse) runs no translated code.
      } else if (ts.isMethodSignature(d) || (isCall && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isParameter(d) || ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)))) {
        if (ts.isMethodSignature(d)) bySignatureName.push({ from, name: d.name.getText() });
        else unresolved.push({ from, type: checker.getTypeAtLocation(n) });
      }
    }
  };

  // The expression a value was cast from: `const node = expr as unknown as Record<string, unknown>` is still the Expr.
  const origin = (e: ts.Expression): ts.Expression => {
    for (let x = e, hops = 0; hops < 8; hops++) {
      if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) { x = x.expression; continue; }
      const d = ts.isIdentifier(x) ? checker.getSymbolAtLocation(x)?.valueDeclaration : undefined;
      if (d && ts.isVariableDeclaration(d) && d.initializer && (d.parent.flags & ts.NodeFlags.Const)) { x = d.initializer; continue; }
      return x;
    }
    return e;
  };
  // Writing a computed key (`delete o[k]`, `Object.assign(o, ..)`) may change any property of o's type.
  const writeAllProps = (e: ts.Expression): boolean => {
    let named = false;
    const props = (ty: ts.Type): void => {
      if (ty.isUnion()) { ty.types.forEach(props); return; }
      for (const p of checker.getPropertiesOfType(ty)) { named = true; for (const d of p.declarations ?? []) cur.decls.add(d); }
    };
    props(checker.getTypeAtLocation(origin(e)));
    return named;
  };
  // Every property along the access chain of a write target is changed by it: `a.inner.x = v` changes a.inner too.
  // `const o = { .. }; o.p = v` before o is used as a value: nothing else can reach o yet, so no alias can see the write
  // (the parser builds nodes this way). Same function, no loop around the write that does not also hold the declaration.
  // A function is fresh-returning when every return is an object literal, a call of a fresh-returning function, or a
  // local of one of those that is only read property-wise before the return (a use on a path that returns elsewhere is
  // harmless). Optimistic fixpoint: recursion (`parseType` calling itself) counts as fresh until a return disproves it.
  const freshFns = new Map<ts.Node, boolean>();
  const unwrap = (e: ts.Expression): ts.Expression => { while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression; return e; };
  const exitsBlockWithout = (use: ts.Node, ret: ts.Node): boolean => {
    for (let b: ts.Node | undefined = use.parent; b && !ts.isFunctionLike(b); b = b.parent) {
      if (ts.isBlock(b) && b.statements.length && (ts.isReturnStatement(b.statements[b.statements.length - 1]) || ts.isThrowStatement(b.statements[b.statements.length - 1])) && !(ret.pos >= b.pos && ret.end <= b.end)) return true;
    }
    return false;
  };
  const isFreshExpr = (e0: ts.Expression): boolean => {
    const e = unwrap(e0);
    if (ts.isObjectLiteralExpression(e)) return true;
    if (ts.isCallExpression(e)) {
      const d = checker.getResolvedSignature(e)?.declaration;
      return !!d && !ts.isFunctionTypeNode(d) && freshFn(d);
    }
    return false;
  };
  let freshDepth = 0;
  const freshTrial: ts.Node[] = [];
  const freshFn = (d: ts.Node): boolean => {
    const known = freshFns.get(d);
    if (known !== undefined) return known;
    if (!(ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)) || !d.body || !fileSet.has(d.getSourceFile().fileName)) return false;
    freshFns.set(d, true);
    freshTrial.push(d);
    freshDepth++;
    let ok = true;
    const visit = (n: ts.Node): void => {
      if (!ok || (ts.isFunctionLike(n) && n !== d)) return;
      if (ts.isReturnStatement(n)) {
        if (!n.expression) return;
        const r = unwrap(n.expression);
        if (ts.isIdentifier(r)) {
          const sym = checker.getSymbolAtLocation(r);
          const vd = sym?.valueDeclaration;
          if (!vd || !ts.isVariableDeclaration(vd) || !vd.initializer || !isFreshExpr(vd.initializer) || ts.findAncestor(vd, ts.isFunctionLike) !== d) { ok = false; return; }
          const bad = (u: ts.Node): boolean => {
            if (ts.isIdentifier(u) && u.pos >= vd.end && u !== r && checker.getSymbolAtLocation(u) === sym && !(ts.isPropertyAccessExpression(u.parent) && u.parent.expression === u) && !exitsBlockWithout(u, n)) return true;
            return !!ts.forEachChild(u, (c) => bad(c) || undefined);
          };
          if (bad(d.body!)) ok = false;
        } else if (!isFreshExpr(r)) ok = false;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(d.body);
    freshDepth--;
    freshFns.set(d, ok);
    // A nested function judged fresh may have leaned on an outer one still assumed fresh: when the outermost fails, forget the trial verdicts.
    if (freshDepth === 0) { if (!ok) for (const t of freshTrial) if (freshFns.get(t)) freshFns.delete(t); freshTrial.length = 0; }
    return ok;
  };
  const isConstruction = (w: ts.PropertyAccessExpression): boolean => {
    if (!ts.isIdentifier(w.expression)) return false;
    const sym = checker.getSymbolAtLocation(w.expression);
    const d = sym?.valueDeclaration;
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
    if (!isFreshExpr(d.initializer)) return false;
    const fnOf = (n: ts.Node) => ts.findAncestor(n, ts.isFunctionLike);
    if (fnOf(w) !== fnOf(d)) return false;
    const loopOf = ts.findAncestor(w, (n) => ts.isIterationStatement(n, false) || ts.isFunctionLike(n));
    if (loopOf && !ts.isFunctionLike(loopOf) && !(d.pos >= loopOf.pos && d.end <= loopOf.end)) return false;
    let escaped = false;
    const scan = (n: ts.Node): void => {
      if (escaped || n.pos >= w.pos) return;
      if (ts.isIdentifier(n) && n.text === w.expression.getText() && n.pos >= d.end && checker.getSymbolAtLocation(n) === sym && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) escaped = true;
      ts.forEachChild(n, scan);
    };
    scan(fnOf(w) ?? w.getSourceFile());
    return !escaped;
  };
  const taint = (e: ts.Expression): void => {
    if (ts.isPropertyAccessExpression(e) && isConstruction(e)) return;
    for (let x: ts.Expression = e; ; ) {
      if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x)) x = x.expression;
      else if (ts.isPropertyAccessExpression(x)) {
        for (const d of checker.getSymbolAtLocation(x.name)?.declarations ?? []) cur.decls.add(d);
        x = x.expression;
      } else if (ts.isElementAccessExpression(x)) {
        // A non-numeric index (a string key) can name any property of the base.
        if (!(checker.getTypeAtLocation(x.argumentExpression).flags & ts.TypeFlags.NumberLike)) writeAllProps(x.expression);
        x = x.expression;
      }
      else if (ts.isArrayLiteralExpression(x)) { x.elements.forEach(taint); return; }
      else if (ts.isObjectLiteralExpression(x)) {
        for (const p of x.properties) {
          if (ts.isPropertyAssignment(p)) taint(p.initializer);
          else if (!ts.isShorthandPropertyAssignment(p)) cur.opaque = true;
        }
        return;
      } else return;
    }
  };
  const assignOps = new Set<ts.SyntaxKind>();
  for (let k = ts.SyntaxKind.FirstAssignment; k <= ts.SyntaxKind.LastAssignment; k++) assignOps.add(k);
  // Visits n and its subtree, charging writes and call edges to `keyFor(node)`.
  const scan = (root: ts.Node, keyFor: (n: ts.Node) => string): void => {
    const walk = (n: ts.Node): void => {
      const k = keyFor(n);
      let w = writesOf.get(k);
      if (!w) writesOf.set(k, (w = { decls: new Set(), opaque: false }));
      cur = w;
      collectEdges(n, k);
      if (ts.isMethodDeclaration(n) && n.name) { const nm = n.name.getText(); let s = methodsByName.get(nm); if (!s) methodsByName.set(nm, (s = new Set())); s.add(keyOf(n)); }
      if (ts.isBinaryExpression(n) && assignOps.has(n.operatorToken.kind)) taint(n.left);
      else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) taint(n.operand);
      else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) taint(n.initializer);
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "replaceNode" && n.arguments.length === 2) writeAllProps(n.arguments[0]);
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const c = n.expression;
        if (MUTATORS.has(c.name.text)) taint(c.expression);
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
  };
  for (const f of files) {
    const sf = program.getSourceFile(f);
    if (sf) scan(sf, keyOf);
  }

  const resolveCalls = (): void => {
    for (const { from, name } of bySignatureName.splice(0)) for (const t of methodsByName.get(name) ?? []) addEdge(from, t);
    for (const { from, type } of unresolved.splice(0)) {
      let targets = fitCache.get(type);
      if (!targets) {
        targets = [];
        for (const [k, nodes] of addressTaken) for (const f of nodes) if (checker.isTypeAssignableTo(checker.getTypeAtLocation(f), type)) { targets.push(k); break; }
        fitCache.set(type, targets);
      }
      for (const t of targets) addEdge(from, t);
    }
  };
  const fitCache = new Map<ts.Type, string[]>();
  resolveCalls();

  const rev = new Map<string, Set<string>>();
  for (const [a, bs] of edges) for (const b of bs) { let s = rev.get(b); if (!s) rev.set(b, (s = new Set())); s.add(a); }
  const closure = (start: Iterable<string>, g: Map<string, Set<string>>): Set<string> => {
    const seen = new Set<string>(start);
    const work = [...seen];
    for (let k = work.pop(); k !== undefined; k = work.pop()) for (const m of g.get(k) ?? []) if (!seen.has(m)) { seen.add(m); work.push(m); }
    return seen;
  };
  type Reach = { decls: Set<ts.Declaration>; opaque: boolean; id: number };
  const reachCache = new Map<string, Reach>();
  const unionWrites = (fns: Iterable<string>, id: number): Reach => {
    const decls = new Set<ts.Declaration>();
    let opaque = false;
    for (const f of fns) {
      const w = writesOf.get(f);
      if (!w) continue;
      for (const d of w.decls) decls.add(d);
      opaque ||= w.opaque;
    }
    return { decls, opaque, id };
  };
  // Every function key, without module-level code (it ran before any copy) and without call regions (their writes
  // are already their enclosing function's).
  const allFns = new Set<string>();
  for (const [a, bs] of edges) { allFns.add(a); for (const b of bs) allFns.add(b); }
  for (const k of writesOf.keys()) allFns.add(k);
  for (const k of [...allFns]) if (k === MODULE || k.startsWith("region:")) allFns.delete(k);
  const laterCache = new Map<number, string[]>();
  // Functions the driver may still enter once a phase-p entry has run.
  const laterEntries = (p: number): string[] => {
    let r = laterCache.get(p);
    if (!r) laterCache.set(p, (r = [...allFns].filter((f) => { const q = phaseOfKey(f); return q === undefined || q >= p; })));
    return r;
  };
  const reach = (k: string): Reach => {
    let r = reachCache.get(k);
    if (!r) {
      const callers = closure([k], rev);
      // Any transitive caller may be the function the driver entered; one with no phase could be entered at any time.
      let p = Infinity;
      for (const c of callers) if (c !== MODULE) p = Math.min(p, phaseOfKey(c) ?? -1);
      reachCache.set(k, (r = unionWrites(closure([...callers, ...(k === MODULE ? [] : laterEntries(p))], edges), reachCache.size)));
    }
    return r;
  };
  // A temporary that dies at the end of `region` (a call argument borrowed for the call): only code the region itself
  // runs can write while it lives, so its reach is forward from the region, with no caller continuation.
  const regionReach = (region: ts.Node): Reach => {
    const rk = `region:${region.getSourceFile().fileName}:${region.pos}:${region.end}`;
    let r = reachCache.get(rk);
    if (!r) {
      scan(region, () => rk);
      // The scan leaves edges (and unresolved calls) charged to rk: patch the reverse map is not needed, only forward edges are walked.
      resolveCalls();
      reachCache.set(rk, (r = unionWrites(closure([rk], edges), reachCache.size)));
    }
    return r;
  };

  const cache = new Map<string, boolean>();
  // `region`: the copy is a temporary that dies at the end of that node (see regionReach); else it lives as long as any caller continues.
  return (root: ts.Type, site: ts.Node, region?: ts.Node): boolean => {
    const rc = region ? regionReach(region) : reach(keyOf(site));
    if (rc.opaque) return false;
    const written = rc.decls;
    const ck = `${rc.id}:${(root as any).id}`;
    const hit = cache.get(ck);
    if (hit !== undefined) return hit;
    const seen = new Set<ts.Type>();
    const go = (t: ts.Type): boolean => {
      if (seen.has(t)) return true;
      seen.add(t);
      if (t.isUnion()) return t.types.every(go);
      if (t.isIntersection()) return false;
      if (!(t.flags & ts.TypeFlags.Object)) return true;
      if (checker.isArrayType(t) || checker.isTupleType(t) || t.symbol?.name === "Map" || t.symbol?.name === "Set") return checker.getTypeArguments(t as ts.TypeReference).every(go);
      if (t.symbol?.declarations?.some((d) => ts.isClassDeclaration(d))) return false;
      for (const p of checker.getPropertiesOfType(t)) {
        const decls = p.declarations ?? [];
        if (decls.some((d) => written.has(d))) { return false; }
        if (decls[0] && !go(checker.getTypeOfSymbolAtLocation(p, decls[0]))) return false;
      }
      return true;
    };
    const r = go(root);
    cache.set(ck, r);
    return r;
  };
}
