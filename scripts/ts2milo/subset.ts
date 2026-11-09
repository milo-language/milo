// The portable TypeScript subset: the one rule list shared by scripts/ts2milo.ts (which refuses
// anything outside it) and scripts/ts-portable.ts (which counts what is outside it). The
// transpiler only has emit code for what this file allows, so the two cannot disagree.
import ts from "typescript";
import { discriminantRead, nestedUnionOf, registerUnions, taggedUnionOf, unionOfType } from "./ast-model";

export interface Violation {
  file: string;
  line: number;
  col: number;
  construct: string;
}

// Library members the transpiler maps to runtime calls, keyed "<Owner>.<member>".
export const BUILTIN_CALLS = new Set([
  "String.charCodeAt", "String.slice", "StringConstructor.fromCharCode", "StringConstructor.fromCodePoint",
  "Number.toString", "Array.push", "Set.has", "ReadonlySet.has", "Set.add", "Map.get", "Map.set", "Map.has",
  "Map.values", "ReadonlyMap.values", "Set.delete", "Map.delete", "ReadonlyMap.get", "ReadonlyMap.has", "WeakMap.get", "WeakMap.set", "WeakMap.has", "WeakMap.delete", "WeakSet.has", "WeakSet.add", "WeakSet.delete", "parseInt", "String()",
  "String.startsWith", "String.endsWith", "String.includes", "String.indexOf", "String.lastIndexOf", "String.split", "String.trim",
  "Math.min", "Math.max", "String.charAt", "String.replace", "String.replaceAll", "Array.join", "Array.pop",
]);

import { mapValuesRecv, nodeKeyOfContainer } from "./node-identity";

const K = ts.SyntaxKind;

// Node kinds that need no further rule. Anything not here or in `ruleFor` is a violation.
const PLAIN = new Set<ts.SyntaxKind>([
  K.SourceFile, K.EndOfFileToken, K.SyntaxList, K.Block, K.EmptyStatement, K.ExpressionStatement, K.IfStatement,
  K.WhileStatement, K.ForStatement, K.ReturnStatement, K.BreakStatement, K.ContinueStatement, K.ThrowStatement, K.VariableStatement,
  K.VariableDeclarationList, K.ImportDeclaration, K.ImportClause, K.NamedImports, K.ImportSpecifier,
  K.ParenthesizedExpression, K.Identifier, K.ThisKeyword, K.TrueKeyword, K.FalseKeyword, K.StringLiteral,
  K.NoSubstitutionTemplateLiteral, K.TemplateExpression, K.TemplateHead, K.TemplateMiddle, K.TemplateTail,
  K.TemplateSpan, K.PropertyAssignment, K.ShorthandPropertyAssignment, K.EnumMember, K.PropertySignature,
  K.ExportKeyword, K.PrivateKeyword, K.PublicKeyword, K.ProtectedKeyword, K.ReadonlyKeyword, K.ConditionalExpression,
  K.NumberKeyword, K.StringKeyword, K.BooleanKeyword, K.VoidKeyword, K.NeverKeyword, K.UndefinedKeyword,
  K.ArrayType, K.LiteralType, K.ParenthesizedType, K.PrefixUnaryExpression, K.PostfixUnaryExpression,
  K.ImportKeyword, K.TypeKeyword, K.ColonToken, K.QuestionToken, K.EqualsToken, K.NullKeyword,
]);

const BINARY_OK = new Set<ts.SyntaxKind>([
  K.PlusToken, K.MinusToken, K.AsteriskToken, K.PercentToken, K.AmpersandToken, K.BarToken, K.CaretToken,
  K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.LessThanToken, K.GreaterThanToken,
  K.LessThanEqualsToken, K.GreaterThanEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
  K.AmpersandAmpersandToken, K.BarBarToken, K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken,
]);
const ASSIGN_OPS = new Set<ts.SyntaxKind>([K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken]);

const MODIFIER_NAMES: Record<number, string> = { [K.StaticKeyword]: "static member", [K.AsyncKeyword]: "async", [K.AsteriskToken]: "generator" };

export function isLibDecl(program: ts.Program, d: ts.Node): boolean {
  const sf = d.getSourceFile();
  return program.isSourceFileDefaultLibrary(sf) || sf.fileName.includes("node_modules");
}

function isBool(t: ts.Type): boolean {
  return (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;
}

function isStringLike(t: ts.Type): boolean {
  return (t.flags & ts.TypeFlags.StringLike) !== 0 || (t.isUnion() && t.types.every(isStringLike));
}

// Truthiness of a non-boolean value in a condition, for the types whose JS semantics Milo matches
// exactly. Numbers are i64, so there is no NaN case. TypeScript also narrows the tested value, which
// the emitted code reproduces only as an if-guard binding, so the optional kinds are accepted only
// there (the same restriction as `x !== undefined`).
export type Truthy = "str" | "num" | "opt" | "optBool" | "optStr" | "optNum";
export function truthyKind(t: ts.Type): Truthy | null {
  const F = ts.TypeFlags;
  if (!t.isUnion()) return t.flags & F.String ? "str" : t.flags & F.Number ? "num" : null;
  const rest = t.types.filter((x) => !(x.flags & (F.Undefined | F.Null)));
  if (rest.length === t.types.length || rest.length === 0) return null;
  if (rest.every((x) => x.flags & F.BooleanLiteral)) return "optBool";
  if (rest.length === 1 && rest[0].flags & F.String) return "optStr";
  if (rest.length === 1 && rest[0].flags & F.Number) return "optNum";
  // A union of non-empty string literals is an enum in Milo: present means truthy.
  return rest.every((x) => x.flags & F.Object || (x.isStringLiteral() && x.value !== "")) ? "opt" : null;
}
const outerParens = (n: ts.Node): ts.Node => { while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent; return n; };
// The expression is the condition of an if, while or ternary, an operand of `!`, or an operand of
// an &&/|| that is itself in condition position. A value-position `a || b` is not: it yields an
// operand, not a boolean, so it has no boolean rewrite.
export function inCondPos(e: ts.Node): boolean {
  const c = outerParens(e), p = c.parent;
  if (!p) return false;
  if (ts.isIfStatement(p) || ts.isWhileStatement(p)) return p.expression === c;
  if (ts.isConditionalExpression(p)) return p.condition === c;
  if (ts.isPrefixUnaryExpression(p)) return p.operator === K.ExclamationToken;
  if (ts.isBinaryExpression(p) && (p.operatorToken.kind === K.AmpersandAmpersandToken || p.operatorToken.kind === K.BarBarToken)) return inCondPos(p);
  return false;
}
// An inline object type (`{ a: number; b?: string }`) the emitter turns into a generated struct named
// from where it is written. One predicate for the subset gate and the emitter. A variant of a tagged
// union declaration is the union rule's, not this one.
export function anonStructHandled(checker: ts.TypeChecker, n: ts.TypeLiteralNode): boolean {
  if (ts.isUnionTypeNode(n.parent) && ts.isTypeAliasDeclaration(n.parent.parent) && taggedUnionOf(checker, n.parent.parent) !== null) return false;
  return n.members.length > 0 && n.members.every((m) => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && !!m.type);
}
// The expression is the condition of an if statement, or a conjunct of it (through parens and &&).
export function inIfGuard(e: ts.Node): boolean {
  let c: ts.Node = e;
  while (c.parent && (ts.isParenthesizedExpression(c.parent) || (ts.isBinaryExpression(c.parent) && c.parent.operatorToken.kind === K.AmpersandAmpersandToken))) c = c.parent;
  return !!c.parent && ts.isIfStatement(c.parent) && c.parent.expression === c;
}
// The one predicate both the subset gate and the emitter use.
export function truthyHandled(checker: ts.TypeChecker, e: ts.Expression): Truthy | null {
  // `n || m` on numbers has type number, but in condition position it is a boolean test of its operands.
  let u = e;
  while (ts.isParenthesizedExpression(u)) u = u.expression;
  if (ts.isBinaryExpression(u) && (u.operatorToken.kind === K.AmpersandAmpersandToken || u.operatorToken.kind === K.BarBarToken)) return null;
  const k = truthyKind(checker.getTypeAtLocation(e));
  if (!k) return null;
  if (k === "str" || k === "num") return inCondPos(e) ? k : null;
  // An optional is narrowed by the test, which the emitter reproduces for an if guard and for a ternary's condition.
  const c = outerParens(e);
  return inIfGuard(e) || (!!c.parent && ts.isConditionalExpression(c.parent) && c.parent.condition === c) ? k : null;
}

// ---- `??`, `?.` and `switch` ----
// Each predicate is the one both the gate and the emitter ask, so they cannot drift.
const NULLISH = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
export const isOptionalType = (t: ts.Type): boolean => t.isUnion() && t.types.some((x) => !!(x.flags & NULLISH)) && !(t.flags & ts.TypeFlags.Boolean);
// A type assertion that changes nothing in the Milo value: `as const`, an assertion to the expression's own type,
// or a literal asserted to the type it is already contextually typed by (the emitter types the literal from that context).
export const isConstAssertion = (a: ts.AsExpression) => ts.isTypeReferenceNode(a.type) && a.type.typeName.getText() === "const";
export const assertionIsNoop = (checker: ts.TypeChecker, a: ts.AsExpression): boolean => {
  if (isConstAssertion(a)) return true;
  const target = checker.getTypeFromTypeNode(a.type);
  if (target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const e = unparenE(a.expression);
  if (ts.isObjectLiteralExpression(e)) return true;
  const from = checker.getTypeAtLocation(a.expression);
  return from === target || checker.typeToString(from) === checker.typeToString(target);
};
export const assertionReason = (checker: ts.TypeChecker, a: ts.AsExpression): string => {
  const to = checker.getTypeFromTypeNode(a.type);
  const from = checker.getTypeAtLocation(a.expression);
  if (to.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return `'as' to ${checker.typeToString(to)}`;
  if (from.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return `'as' from ${checker.typeToString(from)} to ${checker.typeToString(to)}: an unchecked cast`;
  return `'as' from ${checker.typeToString(from)} to ${checker.typeToString(to)}: a narrowing or widening that changes the Milo value`;
};
export const stripConst = (e: ts.Expression): ts.Expression => {
  while (true) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) && isConstAssertion(e)) e = e.expression;
    else return e;
  }
};
// `x++` whose value is unused: a statement, or the init/step slot of a C-style for.
export const inStmtPosition = (n: ts.Node): boolean => ts.isExpressionStatement(n.parent) || (ts.isForStatement(n.parent) && (n.parent.initializer === n || n.parent.incrementor === n));
const unparenE = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparenE(e.expression) : e);
// A place or literal: reading it twice, or not at all, is not observable.
export function sideEffectFree(e: ts.Node): boolean {
  if (ts.isParenthesizedExpression(e)) return sideEffectFree(e.expression);
  if (ts.isIdentifier(e) || e.kind === K.ThisKeyword || e.kind === K.TrueKeyword || e.kind === K.FalseKeyword || e.kind === K.NullKeyword) return true;
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isPrefixUnaryExpression(e)) return e.operator === K.MinusToken && sideEffectFree(e.operand);
  if (ts.isPropertyAccessExpression(e)) return sideEffectFree(e.expression);
  if (ts.isElementAccessExpression(e)) return sideEffectFree(e.expression) && sideEffectFree(e.argumentExpression);
  return false;
}
const isPlaceE = (e: ts.Expression): boolean => { e = unparenE(e); return ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || e.kind === K.ThisKeyword; };

// A member access inside an optional chain (`a?.b`, and the `.c` of `a?.b.c`).
export const isChainMember = (e: ts.Node): boolean => ts.isPropertyAccessExpression(e) && !!(e.flags & ts.NodeFlags.OptionalChain);
// `a?.f`: a is an optional struct place (or an earlier link of the chain) and f one of its fields.
// A method call, element access or non-null assertion on a chain has no translation.
export function chainHandled(checker: ts.TypeChecker, e: ts.Expression): boolean {
  const p = e as ts.PropertyAccessExpression;
  const par = p.parent;
  if (par && ((ts.isCallExpression(par) && par.expression === p) || (ts.isElementAccessExpression(par) && par.expression === p) || ts.isNonNullExpression(par))) return false;
  const d = checker.getSymbolAtLocation(p.name)?.declarations?.[0];
  if (!d || !(ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) || d.getSourceFile().fileName.includes("node_modules")) return false;
  const base = p.expression;
  if (!isChainMember(base) && !isPlaceE(base)) return false;
  const bt = checker.getNonNullableType(checker.getTypeAtLocation(base));
  if (unionOfType(checker, bt)) return false;
  const bd = bt.symbol?.declarations?.[0];
  return !!bd && ts.isInterfaceDeclaration(bd);
}
// `a ?? b`: "value" (a optional, b its payload type: the result is not optional) or "opt" (b optional
// too; `a` is read twice, so it must be a side-effect-free place). `b` may have calls: it runs only
// when `a` is absent, in both emitted forms.
export function nullishHandled(checker: ts.TypeChecker, b: ts.BinaryExpression): "value" | "opt" | null {
  const lt = checker.getTypeAtLocation(b.left), rt = checker.getTypeAtLocation(b), r = checker.getTypeAtLocation(b.right);
  if (!isOptionalType(lt)) return null;
  const l = unparenE(b.left);
  const chainOk = !isChainMember(l) || chainHandled(checker, l);
  if (!isOptionalType(rt)) {
    if (isOptionalType(r) || checker.typeToString(rt) !== checker.typeToString(checker.getNonNullableType(lt))) return null;
    return chainOk ? "value" : null;
  }
  if (checker.typeToString(rt) !== checker.typeToString(lt) || !chainOk) return null;
  return isChainMember(l) || (isPlaceE(l) && sideEffectFree(l)) ? "opt" : null;
}
// `chain === k` / `chain !== k`: k is a side-effect-free non-nullish value (JS evaluates it even
// when the chain short-circuits).
export function chainCompareHandled(checker: ts.TypeChecker, b: ts.BinaryExpression): boolean {
  const l = unparenE(b.left);
  const rt = checker.getTypeAtLocation(b.right);
  return isChainMember(l) && chainHandled(checker, l) && sideEffectFree(b.right) && !isOptionalType(rt) && !(rt.flags & NULLISH);
}

const isValueType = (t: ts.Type): boolean => (t.isUnion() ? t.types.every(isValueType) : !!(t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) && !(t.flags & ts.TypeFlags.BigIntLike));
const isTerminator = (s: ts.Statement) => ts.isBreakStatement(s) || ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isContinueStatement(s);
// The statements of a clause, a lone block unwrapped, without its closing `break`.
export function clauseBody(c: ts.CaseOrDefaultClause): ts.Statement[] {
  let st = [...c.statements];
  while (st.length === 1 && ts.isBlock(st[0])) st = [...st[0].statements];
  if (st.length && ts.isBreakStatement(st[st.length - 1]) && !(st[st.length - 1] as ts.BreakStatement).label) st.pop();
  return st;
}
const breaksOut = (n: ts.Node): boolean => {
  if (ts.isBreakStatement(n)) return true;
  if (ts.isIterationStatement(n, false) || ts.isSwitchStatement(n) || ts.isFunctionLike(n)) return false;
  return ts.forEachChild(n, (c) => breaksOut(c) || undefined) === true;
};
function lastTerminates(c: ts.CaseOrDefaultClause): boolean {
  let st = [...c.statements];
  while (st.length === 1 && ts.isBlock(st[0])) st = [...st[0].statements];
  return st.length > 0 && isTerminator(st[st.length - 1]);
}
// `switch` on a string, a number, a string-literal union or an enum ("value"), or on a tagged
// union's `.kind` ("kind"), as an if / else-if chain. No fallthrough but stacked empty labels, and
// no `break` but each clause's last statement (a `break` elsewhere would leave the chain, not the loop).
export function switchHandled(checker: ts.TypeChecker, s: ts.SwitchStatement): "value" | "kind" | null {
  const d = unparenE(s.expression);
  const du = discriminantRead(checker, d);
  // A switch is an else-if chain; a leaf of a union of unions needs two nested if-lets per arm.
  if (du?.members) return null;
  const kind = !!du;
  if (kind) { if (!sideEffectFree((d as ts.PropertyAccessExpression).expression) || !isPlaceE((d as ts.PropertyAccessExpression).expression)) return null; }
  else if (!sideEffectFree(d) || !isValueType(checker.getTypeAtLocation(d))) return null;
  const cs = s.caseBlock.clauses;
  let stacked = false;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (ts.isCaseClause(c)) {
      const l = unparenE(c.expression);
      const member = ts.isPropertyAccessExpression(l) ? checker.getSymbolAtLocation(l.name)?.declarations?.[0] : undefined;
      const ok = kind ? ts.isStringLiteral(l)
        : ts.isStringLiteral(l) || ts.isNoSubstitutionTemplateLiteral(l) || (ts.isNumericLiteral(l) && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(l.getText()))
          || (ts.isPrefixUnaryExpression(l) && l.operator === K.MinusToken && ts.isNumericLiteral(l.operand))
          || (!!member && ts.isEnumMember(member));
      if (!ok) return null;
    }
    const last = i === cs.length - 1;
    if (c.statements.length === 0 && !last) {
      if (kind || ts.isDefaultClause(c)) return null;
      stacked = true;
      continue;
    }
    if (stacked && ts.isDefaultClause(c)) return null;
    stacked = false;
    if (!last && !lastTerminates(c)) return null;
    if (clauseBody(c).some((st) => breaksOut(st))) return null;
  }
  return kind ? "kind" : "value";
}

// "Owner.member" for a library member, or null when the symbol is project code.
export function calleeKey(program: ts.Program, checker: ts.TypeChecker, call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const sym = checker.getSymbolAtLocation(callee);
    const d = sym?.declarations?.[0];
    if (!d || !isLibDecl(program, d)) return null;
    return callee.text === "String" ? "String()" : callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const sym = checker.getSymbolAtLocation(callee.name);
    const d = sym?.declarations?.[0];
    if (!d || !isLibDecl(program, d)) return null;
    const owner = d.parent;
    const ownerName = ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner) ? owner.name?.text ?? "?" : "?";
    return `${ownerName}.${callee.name.text}`;
  }
  return "?";
}

// Array methods whose callback is an arrow literal, lowered to the jsSome/jsMap/... runtime helpers (loop tier).
const CLOSURE_METHODS = new Set(["some", "every", "map", "filter", "find", "findIndex", "forEach", "flatMap", "reduce"]);
const BOOL_CLOSURE = new Set(["some", "every", "filter", "find", "findIndex"]);
const isCopyScalar = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Number | ts.TypeFlags.String | ts.TypeFlags.Boolean | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral));

// The one predicate the gate and the emitter share for `xs.some(x => ...)`: null when the call is not such a method,
// a refusal reason when it is but cannot be matched exactly, else the method and its arrow.
export function arrayClosureCall(program: ts.Program, checker: ts.TypeChecker, c: ts.CallExpression): { method: string; arrow: ts.ArrowFunction; elem: ts.Type } | string | null {
  const key = calleeKey(program, checker, c);
  const m = key && /^(?:Readonly)?Array\.(\w+)$/.exec(key);
  if (!m || !CLOSURE_METHODS.has(m[1]) || !ts.isPropertyAccessExpression(c.expression)) return null;
  const method = m[1];
  const why = (r: string) => `closure (loop tier) in Array.${method}: ${r}`;
  const recvT = checker.getTypeAtLocation(c.expression.expression);
  if (!checker.isArrayType(recvT)) return why("receiver is not an array");
  const elem = checker.getTypeArguments(recvT as ts.TypeReference)[0];
  const arrow = c.arguments[0];
  if (!arrow || !ts.isArrowFunction(arrow)) return why("callback is not an arrow literal");
  if (c.arguments.length !== (method === "reduce" ? 2 : 1)) return why(method === "reduce" ? "reduce without an initial value" : "thisArg");
  if (arrow.modifiers || arrow.typeParameters) return why("async or generic arrow");
  if (arrow.parameters.length > (method === "reduce" ? 2 : 1) || (method === "reduce" && arrow.parameters.length !== 2)) return why("callback names the index or array argument");
  if (arrow.parameters.some((p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken || p.questionToken)) return why("destructured or defaulted parameter");
  let thrown = false;
  const scan = (n: ts.Node) => { if (ts.isThrowStatement(n)) thrown = true; ts.forEachChild(n, scan); };
  scan(arrow.body);
  if (thrown) return why("closure that throws");
  const ret = checker.getSignatureFromDeclaration(arrow)!.getReturnType();
  if (BOOL_CLOSURE.has(method) && !(ret.flags & ts.TypeFlags.Boolean)) return why("non-boolean result");
  // filter/find copy elements out of a borrowed vector: only plain Copy values.
  if ((method === "filter" || method === "find") && !isCopyScalar(elem)) return why("element is not a number, boolean or string");
  if (method === "flatMap") {
    const re = checker.isArrayType(ret) ? checker.getTypeArguments(ret as ts.TypeReference)[0] : null;
    if (!re || !isCopyScalar(re)) return why("result is not an array of numbers, booleans or strings");
  }
  if (method === "reduce" && !isCopyScalar(ret)) return why("accumulator is not a number, boolean or string");
  if (method === "map" && ret.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return why("map to nothing");
  return { method, arrow, elem };
}

// Hoist tier, the other shared predicate: `const f = (x: T): R => ...` that is only ever called by name and captures
// nothing that is written or mutated in the enclosing function. Returns the arrow, a refusal reason, or null when d is no such declaration.
export function hoistedClosure(checker: ts.TypeChecker, d: ts.VariableDeclaration): ts.ArrowFunction | string | null {
  const arrow = d.initializer;
  if (!arrow || !ts.isArrowFunction(arrow) || !ts.isIdentifier(d.name)) return null;
  const why = (r: string) => `closure (hoist tier): ${r}`;
  if (!(d.parent.flags & ts.NodeFlags.Const)) return why("not a const");
  if (arrow.modifiers || arrow.typeParameters) return why("async or generic arrow");
  if (arrow.parameters.some((p) => !ts.isIdentifier(p.name) || !p.type || p.initializer || p.dotDotDotToken || p.questionToken)) return why("parameter without a plain annotated name");
  let fnScope: ts.Node = d;
  while (fnScope.parent && !ts.isFunctionLike(fnScope)) fnScope = fnScope.parent;
  const assigned = new Set<ts.Symbol>();
  const root = (e: ts.Expression): ts.Expression => (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? root(e.expression) : e);
  const markW = (e: ts.Expression) => { const r = root(e); if (ts.isIdentifier(r)) { const s = checker.getSymbolAtLocation(r); if (s) assigned.add(s); } };
  const scanW = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= K.FirstAssignment && n.operatorToken.kind <= K.LastAssignment) markW(n.left);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)) markW(n.operand);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) markW(n.expression.expression);
    ts.forEachChild(n, scanW);
  };
  scanW(fnScope);
  let bad: string | null = null;
  const scan = (n: ts.Node) => {
    if (ts.isThrowStatement(n)) bad = "closure that throws";
    if (ts.isIdentifier(n)) {
      const s = checker.getSymbolAtLocation(n);
      const vd = s?.declarations?.[0];
      const outside = !!vd && (ts.isVariableDeclaration(vd) || ts.isParameter(vd)) && !(vd.pos >= arrow.pos && vd.end <= arrow.end) && vd.getSourceFile() === d.getSourceFile();
      if (s && outside && assigned.has(s)) bad = "closure that writes or mutates captured state";
    }
    ts.forEachChild(n, scan);
  };
  scan(arrow.body);
  if (bad) return why(bad);
  // Only called by name: never passed around.
  const sym = checker.getSymbolAtLocation(d.name);
  let escapes = false;
  const refs = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n !== d.name && checker.getSymbolAtLocation(n) === sym && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) escapes = true;
    ts.forEachChild(n, refs);
  };
  refs(fnScope);
  if (escapes) return why("closure value passed around, not only called");
  return arrow;
}

export function violationsOf(program: ts.Program, checker: ts.TypeChecker, sf: ts.SourceFile): Violation[] {
  const out: Violation[] = [];
  registerUnions(program, checker);
  const bad = (n: ts.Node, construct: string) => {
    const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    out.push({ file: sf.fileName, line: p.line + 1, col: p.character + 1, construct });
  };
  const needBool = (e: ts.Expression, what: string) => {
    // An &&/|| as a condition has its operands checked on their own; its TS type is the union of
    // them, not a boolean.
    let u = e;
    while (ts.isParenthesizedExpression(u)) u = u.expression;
    if (ts.isBinaryExpression(u) && (u.operatorToken.kind === K.AmpersandAmpersandToken || u.operatorToken.kind === K.BarBarToken)) return;
    if (!isBool(checker.getTypeAtLocation(e)) &&!truthyHandled(checker, e)) bad(e, `non-boolean ${what}`);
  };

  const isProjectSymbolType = (t: ts.Type, pred: (d: ts.Declaration) => boolean): boolean => {
    const d = (t.aliasSymbol ?? t.symbol)?.declarations?.[0];
    return !!d && !isLibDecl(program, d) && pred(d);
  };
  const isArr = (t: ts.Type) => checker.isArrayType(t);
  const isNullishExpr = (e: ts.Expression) => (ts.isIdentifier(e) && e.text === "undefined") || e.kind === K.NullKeyword;
  // `x.kind` is only read as `x.kind === "K"` in a guard.
  const isKindGuard = (access: ts.Node): boolean => {
    const b = access.parent;
    if (b && ts.isSwitchStatement(b) && b.expression === access) return switchHandled(checker, b) === "kind";
    return !!b && ts.isBinaryExpression(b) && b.operatorToken.kind === K.EqualsEqualsEqualsToken && b.left === access && ts.isStringLiteral(b.right) && inIfGuard(b);
  };

  const typeNode = (n: ts.TypeNode) => {
    if (ts.isTypeReferenceNode(n)) {
      const t = checker.getTypeFromTypeNode(n);
      const name = n.typeName.getText();
      if (name === "Array" || name === "Set" || name === "ReadonlySet" || name === "Map" || name === "ReadonlyMap" || name === "WeakMap" || name === "WeakSet") { return; }
      if (name === "f64" && !n.typeArguments) return;
      if (n.typeArguments) bad(n, `generic type ${name}`);
      else if (!isProjectSymbolType(t, (d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isEnumDeclaration(d) || ts.isTypeAliasDeclaration(d))) {
        bad(n, `type ${name}`);
      }
    } else if (ts.isUnionTypeNode(n)) {
      const lits = n.types.every((x) => ts.isLiteralTypeNode(x) && ts.isStringLiteral(x.literal));
      const isNullish = (x: ts.TypeNode) => x.kind === K.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === K.NullKeyword);
      const rest = n.types.filter((x) => !isNullish(x));
      // The body of a tagged union declaration is the union rule itself, not a union type use.
      const taggedBody = ts.isTypeAliasDeclaration(n.parent) && (taggedUnionOf(checker, n.parent) !== null || nestedUnionOf(checker, n.parent) !== null);
      if (!lits && !taggedBody && !(rest.length === 1 && n.types.length === 2)) bad(n, "union type");
    } else if (ts.isLiteralTypeNode(n)) {
      const inOption = ts.isUnionTypeNode(n.parent) && n.parent.types.length === 2 && n.literal.kind === K.NullKeyword;
      if (!ts.isStringLiteral(n.literal) && !inOption) bad(n, "non-string literal type");
    }
  };

  // An inline object type that is one member of a tagged union declaration is a variant, not a type use.
  const inTaggedBody = (n: ts.Node) => ts.isUnionTypeNode(n.parent) && ts.isTypeAliasDeclaration(n.parent.parent) && taggedUnionOf(checker, n.parent.parent) !== null;

  const rule = (n: ts.Node) => {
    // Operators and punctuation are judged by their parent node (BinaryExpression etc.).
    if (n.kind >= K.FirstPunctuation && n.kind <= K.LastPunctuation) return;
    if (ts.isTypeNode(n) && n.kind !== K.ExpressionWithTypeArguments) {
      if (ts.isTypeReferenceNode(n) || ts.isUnionTypeNode(n) || ts.isLiteralTypeNode(n)) typeNode(n);
      else if (ts.isTypeLiteralNode(n) && (inTaggedBody(n) || anonStructHandled(checker, n))) return;
      else if (!PLAIN.has(n.kind)) bad(n, `type ${K[n.kind]}`);
      return;
    }
    switch (n.kind) {
      case K.FunctionDeclaration: {
        const f = n as ts.FunctionDeclaration;
        if (f.typeParameters) bad(n, "generic function");
        if (!f.body) bad(n, "function without body");
        return;
      }
      case K.Parameter: {
        const p = n as ts.ParameterDeclaration;
        if (!ts.isIdentifier(p.name)) bad(n, "destructured parameter");
        if (p.dotDotDotToken) bad(n, "rest parameter");
        return;
      }
      case K.ClassDeclaration: {
        const c = n as ts.ClassDeclaration;
        if (c.heritageClauses) bad(n, "class inheritance");
        if (c.typeParameters) bad(n, "generic class");
        return;
      }
      case K.PropertyDeclaration: {
        const p = n as ts.PropertyDeclaration;
        if (!ts.isIdentifier(p.name)) bad(n, "computed property name");
        return;
      }
      case K.Constructor: {
        const c = n as ts.ConstructorDeclaration;
        if (c.body && c.body.statements.length > 0) bad(n, "constructor body");
        return;
      }
      case K.MethodDeclaration: {
        const m = n as ts.MethodDeclaration;
        if (m.typeParameters) bad(n, "generic method");
        if (!ts.isIdentifier(m.name)) bad(n, "computed method name");
        return;
      }
      case K.InterfaceDeclaration: {
        const i = n as ts.InterfaceDeclaration;
        if (i.heritageClauses || i.typeParameters) bad(n, "interface extends or generics");
        return;
      }
      case K.EnumDeclaration: {
        for (const m of (n as ts.EnumDeclaration).members) {
          if (!m.initializer || !ts.isStringLiteral(m.initializer)) bad(m, "non-string enum member");
        }
        return;
      }
      case K.TypeAliasDeclaration: {
        const a = n as ts.TypeAliasDeclaration;
        if (a.typeParameters) bad(n, "generic type alias");
        else if (a.name.text === "f64" && a.type.kind === K.NumberKeyword) { /* the f64 alias ts2milo maps to Milo f64 */ }
        else if (taggedUnionOf(checker, a) === null && nestedUnionOf(checker, a) === null && !ts.isUnionTypeNode(a.type) && !(ts.isLiteralTypeNode(a.type))) bad(n, "type alias other than string literals");
        return;
      }
      case K.VariableDeclaration: {
        if (!ts.isIdentifier((n as ts.VariableDeclaration).name)) bad(n, "destructuring");
        return;
      }
      case K.NumericLiteral: {
        if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(n.getText())) bad(n, "non-integer number literal");
        return;
      }
      case K.PropertyAccessExpression: {
        const p = n as ts.PropertyAccessExpression;
        if (isChainMember(p)) { if (!chainHandled(checker, p)) bad(n, "optional chaining"); return; }
        const disc = discriminantRead(checker, p);
        const u = disc ?? unionOfType(checker, checker.getTypeAtLocation(p.expression));
        if (u) {
          // A tagged union value has no fields of its own: its discriminant only in a guard, and a field only
          // if every variant has it (the transpiler emits an accessor for those).
          if (disc) { if (!isKindGuard(p)) bad(n, "tagged union kind read outside an if guard"); }
          else if (!u.variants.every((v) => v.members.some((m) => ts.isPropertySignature(m) && (m.name as ts.Identifier).text === p.name.text))) bad(n, `field ${p.name.text} is not on every variant of ${u.name}`);
          return;
        }
        const sym = checker.getSymbolAtLocation(p.name);
        const d = sym?.declarations?.[0];
        if (d && isLibDecl(program, d)) {
          const isCallee = ts.isCallExpression(p.parent) && p.parent.expression === p;
          if (!isCallee && !(p.name.text === "length" && (isStringLike(checker.getTypeAtLocation(p.expression)) || isArr(checker.getTypeAtLocation(p.expression))))) {
            bad(n, `library property ${p.name.text}`);
          }
        }
        return;
      }
      case K.ElementAccessExpression: {
        const t = checker.getTypeAtLocation((n as ts.ElementAccessExpression).expression);
        if (!isStringLike(t) && !isArr(t)) bad(n, "element access on non-string, non-array");
        return;
      }
      case K.CallExpression: {
        const c = n as ts.CallExpression;
        if (c.questionDotToken) bad(n, "optional call");
        if (c.typeArguments) bad(n, "explicit type arguments");
        if (c.arguments.some(ts.isSpreadElement)) bad(n, "spread argument");
        const key = calleeKey(program, checker, c);
        const recvT = ts.isPropertyAccessExpression(c.expression) ? checker.getTypeAtLocation(c.expression.expression) : null;
        const cl = arrayClosureCall(program, checker, c);
        if (cl !== null) { if (typeof cl === "string") bad(n, cl); }
        else if (key !== null && !BUILTIN_CALLS.has(key)) bad(n, recvT && /\.(keys|entries|forEach)$/.test(key) && nodeKeyOfContainer(checker, recvT) ? `iteration over node-identity keys (${key})` : `library call ${key}`);
        else if (key === null && !ts.isIdentifier(c.expression) && !(ts.isPropertyAccessExpression(c.expression))) bad(n, "call of a computed callee");
        return;
      }
      case K.NewExpression: {
        const e = n as ts.NewExpression;
        const t = checker.getTypeAtLocation(e);
        const isSet = (t.symbol?.name === "Set" || t.symbol?.name === "Map" || t.symbol?.name === "WeakMap" || t.symbol?.name === "WeakSet");
        if (!isSet && !isProjectSymbolType(t, (d) => ts.isClassDeclaration(d))) bad(n, "new of a non-project class");
        return;
      }
      case K.BinaryExpression: {
        const b = n as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (op === K.CommaToken) { bad(n, "comma operator"); return; }
        // `x !== undefined` (or null) binds the Option's payload, so it is a guard or nothing.
        if ((op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken) && (isNullishExpr(b.left) || isNullishExpr(b.right))) {
          if (!inIfGuard(b) || op === K.EqualsEqualsEqualsToken) bad(n, "undefined or null comparison outside a positive if guard");
          return;
        }
        if ((op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken) && (isChainMember(unparenE(b.left)) || isChainMember(unparenE(b.right)))) {
          // A chain the walk already flags needs no second violation for the comparison around it.
          const operandOk = [b.left, b.right].some((x) => isChainMember(unparenE(x)) && chainHandled(checker, unparenE(x)));
          if (operandOk && !chainCompareHandled(checker, b)) bad(n, "optional chain comparison");
          return;
        }
        if (op === K.QuestionQuestionToken) { if (!nullishHandled(checker, b)) bad(n, "operator ??"); return; }
        if (!BINARY_OK.has(op)) { bad(n, `operator ${b.operatorToken.getText()}`); return; }
        if (ASSIGN_OPS.has(op) && !ts.isExpressionStatement(b.parent)) bad(n, "assignment as expression");
        if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) { needBool(b.left, "operand of &&/||"); needBool(b.right, "operand of &&/||"); }
        if (op === K.PlusToken) {
          const l = checker.getTypeAtLocation(b.left), r = checker.getTypeAtLocation(b.right);
          if (isStringLike(l) !== isStringLike(r)) bad(n, "mixed string + number");
        }
        if (op === K.LessThanToken || op === K.GreaterThanToken || op === K.LessThanEqualsToken || op === K.GreaterThanEqualsToken) {
          if (isStringLike(checker.getTypeAtLocation(b.left))) bad(n, "string ordering comparison");
        }
        return;
      }
      case K.PrefixUnaryExpression: {
        const u = n as ts.PrefixUnaryExpression;
        if (u.operator === K.ExclamationToken) needBool(u.operand, "operand of !");
        else if (u.operator === K.PlusPlusToken || u.operator === K.MinusMinusToken) {
          if (!inStmtPosition(u)) bad(n, "increment as expression");
        } else if (u.operator !== K.MinusToken) bad(n, "unary operator");
        return;
      }
      case K.PostfixUnaryExpression: {
        if (!inStmtPosition(n)) bad(n, "increment as expression");
        return;
      }
      case K.AsExpression: {
        const a = n as ts.AsExpression;
        const target = checker.getTypeFromTypeNode(a.type);
        const ok = (isStringLike(checker.getTypeAtLocation(a.expression)) && isProjectSymbolType(target, (d) => ts.isEnumDeclaration(d))) || assertionIsNoop(checker, a);
        if (!ok) bad(n, assertionReason(checker, a));
        return;
      }
      case K.ObjectLiteralExpression: {
        const o = n as ts.ObjectLiteralExpression;
        const ctx = checker.getContextualType(o);
        const t = ctx && checker.getNonNullableType(ctx);
        // A tagged union's variant is picked by a literal discriminant property.
        const unionLit = !!t && !!unionOfType(checker, t) && o.properties.some((p) => ts.isPropertyAssignment(p) && ts.isStringLiteral(stripConst(p.initializer)) && p.name.getText() === unionOfType(checker, t)!.field);
        if (!t || !(unionLit || isProjectSymbolType(t, (d) => ts.isInterfaceDeclaration(d) || (ts.isTypeLiteralNode(d) && anonStructHandled(checker, d))))) bad(n, "object literal without an interface type");
        for (const p of o.properties) if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) bad(p, "object literal member");
        return;
      }
      case K.ArrayLiteralExpression: {
        for (const e of (n as ts.ArrayLiteralExpression).elements) if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) bad(e, "array literal spread or hole");
        return;
      }
      case K.ForOfStatement: {
        // `for (const x of array)` borrows each element in turn: the way to walk a Vec of boxed nodes.
        const f = n as ts.ForOfStatement;
        const src = ts.isCallExpression(f.expression) && ts.isPropertyAccessExpression(f.expression.expression) && f.expression.expression.name.text !== "values" ? f.expression.expression.expression : f.expression;
        if (nodeKeyOfContainer(checker, checker.getTypeAtLocation(src))) { bad(n, "iteration over node-identity keys (for-of)"); return; }
        const one = ts.isVariableDeclarationList(f.initializer) && f.initializer.declarations.length === 1 && ts.isIdentifier(f.initializer.declarations[0].name);
        if (!one || !(isArr(checker.getTypeAtLocation(f.expression)) || mapValuesRecv(checker, f.expression)) || f.awaitModifier) bad(n, "for-of other than `const x of array`");
        return;
      }
      case K.ArrowFunction: {
        const p = n.parent;
        const cl = ts.isCallExpression(p) ? arrayClosureCall(program, checker, p) : null;
        if (cl && typeof cl !== "string" && cl.arrow === n) return;
        const h = ts.isVariableDeclaration(p) ? hoistedClosure(checker, p) : null;
        if (h === n) return;
        bad(n, typeof h === "string" ? h : typeof cl === "string" ? cl : "closure outside a direct array-method callback or a called const (param / this-cb tier)");
        return;
      }
      case K.SwitchStatement: if (!switchHandled(checker, n as ts.SwitchStatement)) bad(n, "switch outside the subset"); return;
      case K.CaseBlock: return;
      case K.CaseClause: case K.DefaultClause: if (!switchHandled(checker, n.parent.parent as ts.SwitchStatement)) bad(n, K[n.kind]); return;
      // Only as the pattern of s.replace(/x/g, "y"); ts2milo itself refuses any regex that is not a plain global literal.
      case K.RegularExpressionLiteral: if (!(ts.isCallExpression(n.parent) && n.parent.arguments[0] === n && ts.isPropertyAccessExpression(n.parent.expression) && n.parent.expression.name.text === "replace")) bad(n, "RegularExpressionLiteral"); return;
      case K.IfStatement: needBool((n as ts.IfStatement).expression, "if condition"); return;
      case K.WhileStatement: needBool((n as ts.WhileStatement).expression, "while condition"); return;
      case K.ForStatement: { const f = n as ts.ForStatement; if (f.condition) needBool(f.condition, "for condition"); return; }
      default:
        if (PLAIN.has(n.kind)) {
          if (n.kind === K.ConditionalExpression) needBool((n as ts.ConditionalExpression).condition, "ternary condition");
          return;
        }
        bad(n, MODIFIER_NAMES[n.kind] ?? K[n.kind] ?? String(n.kind));
    }
  };

  const walk = (n: ts.Node) => {
    rule(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

// Same compiler options the repo type-checks with, so types resolve the way `tsc` sees them.
export function makeProgram(root: string, files: string[]): ts.Program {
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")!;
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, root);
  return ts.createProgram(files, { ...cfg.options, noEmit: true });
}
