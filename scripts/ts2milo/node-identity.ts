// Node identity. TypeScript keys Maps and Sets by object identity and compares objects with `===`; a
// Milo value has no identity. A struct type used that way carries a hidden `id` field (`ts2miloNextId()`
// at every literal and every decode), a tagged union reads it through `<Union>_id`, and a Map/Set keyed by
// the type is a HashMap/HashSet keyed by that id. One predicate for subset.ts and the emitter.
import ts from "typescript";
import { type TaggedUnion, unionOfType, variantUnionOf } from "./ast-model";

export const ID_FIELD = "id";
export interface NodeKey { name: string; union: TaggedUnion | null }
const KEYED = new Set(["Map", "ReadonlyMap", "WeakMap", "Set", "ReadonlySet", "WeakSet"]);
export const isKeyedContainer = (t: ts.Type) => !!t.symbol && KEYED.has(t.symbol.name);

// The node type `t` is (a tagged union, or a project interface or inline variant), or null.
export function nodeKeyOf(checker: ts.TypeChecker, t: ts.Type): NodeKey | null {
  t = checker.getNonNullableType(t);
  const tu = unionOfType(checker, t);
  if (tu) return { name: tu.name, union: tu };
  const d = t.symbol?.declarations?.[0];
  if (!d || d.getSourceFile().isDeclarationFile) return null;
  if (ts.isInterfaceDeclaration(d)) return { name: d.name.text, union: null };
  const v = variantUnionOf(checker, d);
  return v ? { name: v.variants.find((x) => x.decl === d)!.name, union: null } : null;
}

// Key node type of a Map/Set type that is keyed by a node, or null.
export function nodeKeyOfContainer(checker: ts.TypeChecker, t: ts.Type): NodeKey | null {
  if (!isKeyedContainer(t)) return null;
  const k = checker.getTypeArguments(t as ts.TypeReference)[0];
  return k ? nodeKeyOf(checker, k) : null;
}

const isIdentityCompare = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);

// Both sides of `===` / `!==` are node types: compared by id.
export function nodeCompare(checker: ts.TypeChecker, b: ts.BinaryExpression): [NodeKey, NodeKey] | null {
  if (!isIdentityCompare(b)) return null;
  const l = nodeKeyOf(checker, checker.getTypeAtLocation(b.left)), r = nodeKeyOf(checker, checker.getTypeAtLocation(b.right));
  return l && r ? [l, r] : null;
}

// Names of every type that needs an id: those used as a Map/Set key or compared with `===` / `!==`.
export function collectIdentity(program: ts.Program, checker: ts.TypeChecker, files: string[]): Set<string> {
  const out = new Set<string>();
  const addUnion = (u: TaggedUnion) => { out.add(u.name); for (const v of u.variants) out.add(v.name); for (const m of u.members ?? []) { out.add(m.name); if (m.union) addUnion(m.union); } };
  const addKey = (k: NodeKey | null) => { if (!k) return; out.add(k.name); if (k.union) addUnion(k.union); };
  const visit = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n) && KEYED.has(n.typeName.getText()) && n.typeArguments?.[0]) addKey(nodeKeyOf(checker, checker.getTypeFromTypeNode(n.typeArguments[0])));
    else if (ts.isNewExpression(n)) addKey(nodeKeyOfContainer(checker, checker.getTypeAtLocation(n)));
    else { const c = ts.isBinaryExpression(n) ? nodeCompare(checker, n) : null; if (c) { addKey(c[0]); addKey(c[1]); } }
    ts.forEachChild(n, visit);
  };
  for (const f of files) visit(program.getSourceFile(f)!);
  return out;
}

// `m.values()` of a Map: the one iteration over a map that yields what TypeScript yields (the values).
export function mapValuesRecv(checker: ts.TypeChecker, e: ts.Expression, method: "values" | "keys" = "values"): ts.Expression | null {
  if (!ts.isCallExpression(e) || e.arguments.length || !ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== method) return null;
  const t = checker.getTypeAtLocation(e.expression.expression);
  return t.symbol && (t.symbol.name === "Map" || t.symbol.name === "ReadonlyMap") ? e.expression.expression : null;
}
