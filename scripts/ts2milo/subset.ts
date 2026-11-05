// The portable TypeScript subset: the one rule list shared by scripts/ts2milo.ts (which refuses
// anything outside it) and scripts/ts-portable.ts (which counts what is outside it). The
// transpiler only has emit code for what this file allows, so the two cannot disagree.
import ts from "typescript";

export interface Violation {
  file: string;
  line: number;
  col: number;
  construct: string;
}

// Library members the transpiler maps to runtime calls, keyed "<Owner>.<member>".
export const BUILTIN_CALLS = new Set([
  "String.charCodeAt", "String.slice", "StringConstructor.fromCharCode", "StringConstructor.fromCodePoint",
  "Number.toString", "Array.push", "Set.has", "parseInt", "String()",
]);

const K = ts.SyntaxKind;

// Node kinds that need no further rule. Anything not here or in `ruleFor` is a violation.
const PLAIN = new Set<ts.SyntaxKind>([
  K.SourceFile, K.EndOfFileToken, K.SyntaxList, K.Block, K.EmptyStatement, K.ExpressionStatement, K.IfStatement,
  K.WhileStatement, K.ReturnStatement, K.BreakStatement, K.ContinueStatement, K.ThrowStatement, K.VariableStatement,
  K.VariableDeclarationList, K.ImportDeclaration, K.ImportClause, K.NamedImports, K.ImportSpecifier,
  K.ParenthesizedExpression, K.Identifier, K.ThisKeyword, K.TrueKeyword, K.FalseKeyword, K.StringLiteral,
  K.NoSubstitutionTemplateLiteral, K.TemplateExpression, K.TemplateHead, K.TemplateMiddle, K.TemplateTail,
  K.TemplateSpan, K.PropertyAssignment, K.ShorthandPropertyAssignment, K.EnumMember, K.PropertySignature,
  K.ExportKeyword, K.PrivateKeyword, K.PublicKeyword, K.ProtectedKeyword, K.ReadonlyKeyword, K.ConditionalExpression,
  K.NumberKeyword, K.StringKeyword, K.BooleanKeyword, K.VoidKeyword, K.NeverKeyword, K.UndefinedKeyword,
  K.ArrayType, K.LiteralType, K.ParenthesizedType, K.PrefixUnaryExpression, K.PostfixUnaryExpression,
  K.ImportKeyword, K.TypeKeyword, K.ColonToken, K.QuestionToken, K.EqualsToken,
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
  return (t.flags & ts.TypeFlags.StringLike) !== 0;
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

export function violationsOf(program: ts.Program, checker: ts.TypeChecker, sf: ts.SourceFile): Violation[] {
  const out: Violation[] = [];
  const bad = (n: ts.Node, construct: string) => {
    const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    out.push({ file: sf.fileName, line: p.line + 1, col: p.character + 1, construct });
  };
  const needBool = (e: ts.Expression, what: string) => {
    if (!isBool(checker.getTypeAtLocation(e))) bad(e, `non-boolean ${what}`);
  };

  const isProjectSymbolType = (t: ts.Type, pred: (d: ts.Declaration) => boolean): boolean => {
    const d = (t.aliasSymbol ?? t.symbol)?.declarations?.[0];
    return !!d && !isLibDecl(program, d) && pred(d);
  };
  const isArr = (t: ts.Type) => checker.isArrayType(t);

  const typeNode = (n: ts.TypeNode) => {
    if (ts.isTypeReferenceNode(n)) {
      const t = checker.getTypeFromTypeNode(n);
      const name = n.typeName.getText();
      if (name === "Array" || name === "Set") { return; }
      if (n.typeArguments) bad(n, `generic type ${name}`);
      else if (!isProjectSymbolType(t, (d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isEnumDeclaration(d) || ts.isTypeAliasDeclaration(d))) {
        bad(n, `type ${name}`);
      }
    } else if (ts.isUnionTypeNode(n)) {
      const lits = n.types.every((x) => ts.isLiteralTypeNode(x) && ts.isStringLiteral(x.literal));
      const nonUndef = n.types.filter((x) => x.kind !== K.UndefinedKeyword);
      if (!lits && !(nonUndef.length === 1 && n.types.length === 2)) bad(n, "union type");
    } else if (ts.isLiteralTypeNode(n)) {
      if (!ts.isStringLiteral(n.literal)) bad(n, "non-string literal type");
    }
  };

  const rule = (n: ts.Node) => {
    // Operators and punctuation are judged by their parent node (BinaryExpression etc.).
    if (n.kind >= K.FirstPunctuation && n.kind <= K.LastPunctuation) return;
    if (ts.isTypeNode(n) && n.kind !== K.ExpressionWithTypeArguments) {
      if (ts.isTypeReferenceNode(n) || ts.isUnionTypeNode(n) || ts.isLiteralTypeNode(n)) typeNode(n);
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
        else if (!ts.isUnionTypeNode(a.type) && !(ts.isLiteralTypeNode(a.type))) bad(n, "type alias other than string literals");
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
        if (p.questionDotToken) { bad(n, "optional chaining"); return; }
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
        if (key !== null && !BUILTIN_CALLS.has(key)) bad(n, `library call ${key}`);
        else if (key === null && !ts.isIdentifier(c.expression) && !(ts.isPropertyAccessExpression(c.expression))) bad(n, "call of a computed callee");
        return;
      }
      case K.NewExpression: {
        const e = n as ts.NewExpression;
        const t = checker.getTypeAtLocation(e);
        const isSet = (t.symbol?.name === "Set");
        if (!isSet && !isProjectSymbolType(t, (d) => ts.isClassDeclaration(d))) bad(n, "new of a non-project class");
        return;
      }
      case K.BinaryExpression: {
        const b = n as ts.BinaryExpression;
        const op = b.operatorToken.kind;
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
          if (!ts.isExpressionStatement(u.parent)) bad(n, "increment as expression");
        } else if (u.operator !== K.MinusToken) bad(n, "unary operator");
        return;
      }
      case K.PostfixUnaryExpression: {
        if (!ts.isExpressionStatement(n.parent)) bad(n, "increment as expression");
        return;
      }
      case K.AsExpression: {
        const a = n as ts.AsExpression;
        const target = checker.getTypeFromTypeNode(a.type);
        const ok = isStringLike(checker.getTypeAtLocation(a.expression)) && isProjectSymbolType(target, (d) => ts.isEnumDeclaration(d));
        if (!ok) bad(n, "type assertion other than string to enum");
        return;
      }
      case K.ObjectLiteralExpression: {
        const o = n as ts.ObjectLiteralExpression;
        const ctx = checker.getContextualType(o);
        const t = ctx && checker.getNonNullableType(ctx);
        if (!t || !isProjectSymbolType(t, (d) => ts.isInterfaceDeclaration(d))) bad(n, "object literal without an interface type");
        for (const p of o.properties) if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) bad(p, "object literal member");
        return;
      }
      case K.ArrayLiteralExpression: {
        for (const e of (n as ts.ArrayLiteralExpression).elements) if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) bad(e, "array literal spread or hole");
        return;
      }
      case K.IfStatement: needBool((n as ts.IfStatement).expression, "if condition"); return;
      case K.WhileStatement: needBool((n as ts.WhileStatement).expression, "while condition"); return;
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
