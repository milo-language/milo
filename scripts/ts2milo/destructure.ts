// Destructuring declarations, lowered as a source rewrite before the transpiler sees them:
// `const { a, b: x } = e` becomes `const a = e.a, x = e.b` (a temp first when `e` is not a plain place),
// so each element goes through exactly the path an explicit property read does (types, Option, clones).
// The rewrite keeps every statement on its original line, so stub reasons keep their line numbers.
import ts from "typescript";
import { nodeKeyOfContainer } from "./node-identity";

export const TUPLE_REASON = "array destructuring (tuples have no Milo mapping)";

// Why a binding pattern cannot be lowered, or null when every element is `name` or `key: name`.
export function patternRefusal(name: ts.BindingName): string | null {
  if (ts.isIdentifier(name)) return null;
  if (ts.isArrayBindingPattern(name)) return TUPLE_REASON;
  if (name.elements.length === 0) return "empty destructuring pattern";
  for (const el of name.elements) {
    if (el.dotDotDotToken) return "destructuring with a rest element";
    if (el.initializer) return "destructuring with a default value";
    if (!ts.isIdentifier(el.name)) return "destructuring with a nested pattern";
    if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) return "destructuring with a computed key";
    if (el.propertyName && !ts.isIdentifier(el.propertyName)) return "destructuring with a non-identifier key";
  }
  return null;
}

const insideFunction = (n: ts.Node): boolean => {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true;
  return false;
};

// A place that can be read once per element without re-running anything: `a`, `this.a.b`.
const plainPlace = (e: ts.Expression): boolean =>
  ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(e) && !e.questionDotToken && plainPlace(e.expression));

const isMap = (checker: ts.TypeChecker, t: ts.Type): boolean => ["Map", "ReadonlyMap"].includes(checker.getNonNullableType(t).symbol?.name ?? "");

// `for (const [k, v] of m)` / `m.entries()` over a plain Map place: the receiver, else null.
export function entriesRecv(checker: ts.TypeChecker, f: ts.ForOfStatement): ts.Expression | null {
  let e = f.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "entries" && e.arguments.length === 0) e = e.expression.expression;
  // A map keyed by node identity holds ids in Milo, not the keys TS yields.
  return plainPlace(e) && isMap(checker, checker.getTypeAtLocation(e)) && !nodeKeyOfContainer(checker, checker.getTypeAtLocation(e)) ? e : null;
}

// The loop-head pattern of a for-of with a declaration head, else undefined.
const headDecl = (d: ts.VariableDeclaration): ts.ForOfStatement | undefined =>
  ts.isVariableDeclarationList(d.parent) && ts.isForOfStatement(d.parent.parent) && d.parent.parent.initializer === d.parent ? d.parent.parent : undefined;

// Whether the rewrite translates this destructuring declaration (the portable subset counts the rest).
export function destructureHandled(checker: ts.TypeChecker, d: ts.VariableDeclaration): boolean {
  if (ts.isIdentifier(d.name)) return true;
  if (ts.isCatchClause(d.parent)) return false;
  const f = headDecl(d);
  if (f) {
    if (ts.isObjectBindingPattern(d.name)) return destructureRefusal(checker, d.name) === null;
    return mapHead(checker, f, d.name as ts.ArrayBindingPattern) !== null;
  }
  return destructureRefusal(checker, d.name) === null && ts.isVariableDeclarationList(d.parent) && ts.isVariableStatement(d.parent.parent) && insideFunction(d) && !!d.initializer;
}

// `[k, v]`, `[k]` or `[, v]` over a Map place: which of the two the body binds.
function mapHead(checker: ts.TypeChecker, f: ts.ForOfStatement, p: ts.ArrayBindingPattern): { k?: ts.Identifier; v?: ts.Identifier; recv: ts.Expression } | null {
  const recv = entriesRecv(checker, f);
  if (!recv || p.elements.length === 0 || p.elements.length > 2) return null;
  const parts = p.elements.map((el) => (ts.isOmittedExpression(el) ? undefined : !el.dotDotDotToken && !el.initializer && ts.isIdentifier(el.name) ? el.name : null));
  if (parts.includes(null) || parts.every((x) => x === undefined)) return null;
  return { k: parts[0] ?? undefined, v: parts[1] ?? undefined, recv };
}

type Edit = { at: number; end: number; text: string };

// The text with every handled destructuring declaration rewritten, or null when there is none.
export function desugarDestructuring(checker: ts.TypeChecker, sf: ts.SourceFile): string | null {
  const edits: Edit[] = [];
  let tmp = 0;
  const elemLets = (p: ts.ObjectBindingPattern, src: string) =>
    p.elements.map((el) => `${(el.name as ts.Identifier).text} = ${src}.${((el.propertyName ?? el.name) as ts.Identifier).text}`);
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && !ts.isIdentifier(n.name) && destructureHandled(checker, n)) {
      const f = headDecl(n);
      if (f) {
        const list = f.initializer as ts.VariableDeclarationList;
        const kw = list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var";
        const name = `destr_${++tmp}`;
        let lets: string;
        let headText = name;
        let iterText: string | null = null;
        if (ts.isObjectBindingPattern(n.name)) lets = elemLets(n.name, name).join(", ");
        else {
          const h = mapHead(checker, f, n.name)!;
          const recv = h.recv.getText(sf);
          // One variable walks the keys (or the values when the key is unused); the other is read from the map.
          if (h.k) { headText = h.k.text; iterText = `${recv}.keys()`; lets = h.v ? `${h.v.text} = ${recv}.get(${h.k.text})!` : ""; }
          else { headText = h.v!.text; iterText = `${recv}.values()`; lets = ""; }
        }
        edits.push({ at: n.getStart(sf), end: n.end, text: headText });
        if (iterText) edits.push({ at: f.expression.getStart(sf), end: f.expression.end, text: iterText });
        if (lets) {
          const decl = `${kw} ${lets};`;
          if (ts.isBlock(f.statement)) edits.push({ at: f.statement.getStart(sf) + 1, end: f.statement.getStart(sf) + 1, text: ` ${decl}` });
          else {
            edits.push({ at: f.statement.getStart(sf), end: f.statement.getStart(sf), text: `{ ${decl} ` });
            edits.push({ at: f.statement.end, end: f.statement.end, text: " }" });
          }
        }
      } else {
        const pat = n.name as ts.ObjectBindingPattern;
        const init = n.initializer!;
        if (plainPlace(init)) edits.push({ at: n.getStart(sf), end: n.end, text: elemLets(pat, init.getText(sf)).join(", ") });
        else {
          const name = `destr_${++tmp}`;
          edits.push({ at: pat.getStart(sf), end: pat.end, text: name });
          edits.push({ at: n.end, end: n.end, text: `, ${elemLets(pat, name).join(", ")}` });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (edits.length === 0) return null;
  let text = sf.text;
  for (const e of edits.sort((a, b) => b.at - a.at || b.end - a.end)) text = text.slice(0, e.at) + e.text + text.slice(e.end);
  return text;
}

const MUTATING_METHODS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "set", "add", "delete", "clear"]);
const isPrimitive = (t: ts.Type): boolean => {
  const nn = t.getNonNullableType ? t.getNonNullableType() : t;
  return (nn.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.EnumLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) !== 0;
};

// The lowered `let x = e.f` copies a non-primitive field, while TS binds the same object: a write through the
// local (a member assignment or a mutating method call) would no longer reach `e.f`, so such a pattern is refused.
function aliasRefusal(checker: ts.TypeChecker, pat: ts.ObjectBindingPattern): string | null {
  let scope: ts.Node = pat;
  while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent;
  for (const el of pat.elements) {
    const sym = checker.getSymbolAtLocation(el.name);
    if (!sym || isPrimitive(checker.getTypeAtLocation(el.name))) continue;
    let hit = false;
    const walk = (n: ts.Node) => {
      if (hit) return;
      if (ts.isIdentifier(n) && n !== el.name && checker.getSymbolAtLocation(n) === sym) {
        let top: ts.Expression = n;
        while (ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top || ts.isElementAccessExpression(top.parent) && top.parent.expression === top || ts.isNonNullExpression(top.parent) || ts.isParenthesizedExpression(top.parent)) top = top.parent as ts.Expression;
        const p = top.parent;
        const member = top !== n;
        if (member && ts.isBinaryExpression(p) && p.left === top && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) hit = true;
        else if (member && (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) hit = true;
        else if (member && ts.isDeleteExpression(p)) hit = true;
        else if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && MUTATING_METHODS.has(n.parent.name.text) && ts.isCallExpression(n.parent.parent) && n.parent.parent.expression === n.parent) hit = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(scope);
    if (hit) return `destructured field ${el.name.getText()} is mutated through the local (a copy would not alias the source)`;
  }
  return null;
}

// Every reason a pattern cannot be lowered: its shape, then the aliasing check.
export function destructureRefusal(checker: ts.TypeChecker, name: ts.BindingName): string | null {
  return patternRefusal(name) ?? (ts.isObjectBindingPattern(name) ? aliasRefusal(checker, name) : null);
}
