// Proof that a data type is never mutated after construction: no translated code writes any property
// reachable from it. A copy (clone) of such a value is indistinguishable from the shared TypeScript
// reference, so it needs no read-only-destination proof.
import ts from "typescript";

// Not scanned: `delete x.f` and `Object.assign(x, ..)` are write forms ts2milo refuses (tests/ts2milo.test.ts pins it), so a
// function using one is stubbed and the write never happens in the generated program.
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);

export function buildImmutability(program: ts.Program, checker: ts.TypeChecker, files: string[]): (t: ts.Type) => boolean {
  const written = new Set<ts.Declaration>();
  let opaqueWrite = false; // a write the scan cannot attribute to a property (a spread or method member on an assignment target): nothing is proven
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
      for (const p of checker.getPropertiesOfType(ty)) { named = true; for (const d of p.declarations ?? []) written.add(d); }
    };
    props(checker.getTypeAtLocation(origin(e)));
    return named;
  };
  // Every property along the access chain of a write target is changed by it: `a.inner.x = v` changes a.inner too.
  const taint = (e: ts.Expression): void => {
    for (let x: ts.Expression = e; ; ) {
      if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x)) x = x.expression;
      else if (ts.isPropertyAccessExpression(x)) {
        for (const d of checker.getSymbolAtLocation(x.name)?.declarations ?? []) written.add(d);
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
          else if (!ts.isShorthandPropertyAssignment(p)) opaqueWrite = true;
        }
        return;
      } else return;
    }
  };
  const assignOps = new Set<ts.SyntaxKind>();
  for (let k = ts.SyntaxKind.FirstAssignment; k <= ts.SyntaxKind.LastAssignment; k++) assignOps.add(k);
  for (const f of files) {
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    const walk = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && assignOps.has(n.operatorToken.kind)) taint(n.left);
      else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) taint(n.operand);
      else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) taint(n.initializer);
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const c = n.expression;
        if (MUTATORS.has(c.name.text)) taint(c.expression);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  const cache = new Map<ts.Type, boolean>();
  return (root: ts.Type): boolean => {
    if (opaqueWrite) return false;
    const hit = cache.get(root);
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
        if (decls.some((d) => written.has(d))) return false;
        if (decls[0] && !go(checker.getTypeOfSymbolAtLocation(p, decls[0]))) return false;
      }
      return true;
    };
    const r = go(root);
    cache.set(root, r);
    return r;
  };
}
