// TypeScript -> Milo transpiler for the portable subset (scripts/ts2milo/subset.ts).
//   bun scripts/ts2milo.ts src/tokens.ts src/lexer.ts -o <dir> [--check] [--overrides <dir>]
// Types come from the TypeScript checker; anything outside the subset fails with file:line and
// the construct name. Thin by design: refactor the TypeScript to fit, do not grow this file.
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { calleeKey, isLibDecl, makeProgram, violationsOf } from "./ts2milo/subset";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME_FILE = join(ROOT, "scripts/ts2milo/runtime.milo");
const RUNTIME_MOD = "./ts2milo_runtime";
const STD_MODULES: Record<string, string> = { HashSet: "std/set" };
const RESERVED = new Set("fn extern let var return if else while true false struct enum match mut import from break continue as trait impl for in unsafe move null is type interface requires ensures invariant decreases self Self pub".split(" "));

export interface Report {
  files: Map<string, string>;
  functions: { file: string; name: string; override: boolean }[];
  constructs: Map<string, { count: number; how: string }>;
}

export class Unsupported extends Error {}

export function transpile(inputs: string[], opts: { overridesDir?: string } = {}): Report {
  const files = inputs.map((f) => resolve(ROOT, f));
  const program = makeProgram(ROOT, files);
  const checker = program.getTypeChecker();
  const runtimeSrc = readFileSync(RUNTIME_FILE, "utf8");
  const runtimeNames = new Set([...runtimeSrc.matchAll(/^pub (?:fn|struct|enum) (\w+)/gm)].map((m) => m[1]));
  const rel = (f: string) => f.startsWith(ROOT + "/") ? f.slice(ROOT.length + 1) : f;
  const modOf = (f: string) => "./" + basename(f).replace(/\.ts$/, "");
  const inputSet = new Set(files);

  const report: Report = { files: new Map(), functions: [], constructs: new Map() };
  const hit = (construct: string, how: string) => {
    const e = report.constructs.get(construct);
    if (e) e.count++; else report.constructs.set(construct, { count: 1, how });
  };
  const fail = (n: ts.Node, what: string): never => {
    const sf = n.getSourceFile();
    const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    throw new Unsupported(`${rel(sf.fileName)}:${p.line + 1}: ${what}`);
  };

  // 1. The subset gate: nothing outside it reaches the emitter.
  const viol = files.flatMap((f) => violationsOf(program, checker, program.getSourceFile(f)!));
  if (viol.length) {
    const v = viol[0];
    throw new Unsupported(`${rel(v.file)}:${v.line}: ${v.construct}` + (viol.length > 1 ? ` (and ${viol.length - 1} more)` : ""));
  }

  // 2. Whole-program facts: string-literal unions, throwing and mutating functions.
  const pascal = (s: string) => s.replace(/(^|[^a-zA-Z0-9]+)(.)/g, (_, __, c) => c.toUpperCase());
  const unionKey = (lits: string[]) => [...lits].sort().join("\u0000");
  const litUnions = new Map<string, { name: string; lits: string[]; file: string }>();
  const litsOf = (t: ts.Type): string[] | null => {
    if (!t.isUnion() || (t.flags & ts.TypeFlags.EnumLike)) return null;
    const ls = t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined));
    if (ls.length < 2 && !(ls.length === 1 && ls[0].isStringLiteral())) return null;
    return ls.every((x) => x.isStringLiteral()) ? ls.map((x) => (x as ts.StringLiteralType).value) : null;
  };
  const registerUnion = (t: ts.Type, name: string, file: string) => {
    const lits = litsOf(t);
    if (!lits) return;
    const k = unionKey(lits);
    if (!litUnions.has(k)) litUnions.set(k, { name, lits, file });
  };
  const allFns: ts.FunctionLikeDeclaration[] = [];
  for (const sf of program.getSourceFiles()) {
    if (isLibDecl(program, sf)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isTypeAliasDeclaration(n)) registerUnion(checker.getTypeFromTypeNode(n.type), n.name.text, sf.fileName);
      if (ts.isInterfaceDeclaration(n)) {
        for (const m of n.members) if (ts.isPropertySignature(m) && m.type) {
          const t = checker.getNonNullableType(checker.getTypeFromTypeNode(m.type));
          registerUnion(t, `${n.name.text}_${(m.name as ts.Identifier).text}`, sf.fileName);
        }
      }
      if (inputSet.has(sf.fileName) && (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.body) allFns.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const unionName = (t: ts.Type, at: ts.Node): string => {
    const lits = litsOf(t);
    const u = lits && litUnions.get(unionKey(lits));
    if (!u) return fail(at, "string-literal union without a declared name");
    return u.name;
  };

  const declOf = (call: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration | undefined => checker.getResolvedSignature(call)?.declaration as ts.SignatureDeclaration | undefined;
  const isThrower = (d: ts.Node) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.type?.kind === ts.SyntaxKind.NeverKeyword;
  const throwing = new Set<ts.Node>();
  let errType = "";
  const walkBody = (body: ts.Node, f: (n: ts.Node) => void) => { const w = (n: ts.Node) => { f(n); ts.forEachChild(n, w); }; w(body); };
  for (const fn of allFns) walkBody(fn.body!, (n) => {
    if (ts.isThrowStatement(n)) {
      throwing.add(fn);
      const name = checker.getTypeAtLocation(n.expression).symbol?.name ?? "?";
      if (errType && errType !== name) fail(n, "throw of two different error types");
      errType = name;
    }
  });
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of allFns) {
      if (throwing.has(fn)) continue;
      walkBody(fn.body!, (n) => {
        if (ts.isCallExpression(n)) { const d = declOf(n); if (d && throwing.has(d) && !throwing.has(fn)) { throwing.add(fn); changed = true; } }
      });
    }
  }
  // A method takes `&mut self` when it assigns through `this`, or calls a method that does.
  const rootOf = (e: ts.Expression): ts.Expression => {
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const writes = (n: ts.Node): ts.Expression | null => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind)) {
      return ts.isIdentifier(n.left) ? null : rootOf(n.left);
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      return ts.isIdentifier(n.operand) ? null : rootOf(n.operand);
    }
    if (ts.isCallExpression(n) && calleeKey(program, checker, n) === "Array.push") return rootOf((n.expression as ts.PropertyAccessExpression).expression);
    return null;
  };
  const mutating = new Set<ts.Node>();
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of allFns) {
      if (mutating.has(fn) || !ts.isMethodDeclaration(fn)) continue;
      walkBody(fn.body!, (n) => {
        const w = writes(n);
        let hitIt = !!w && w.kind === ts.SyntaxKind.ThisKeyword;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const d = declOf(n);
          if (d && mutating.has(d)) hitIt = true;
        }
        if (hitIt && !mutating.has(fn)) { mutating.add(fn); changed = true; }
      });
    }
  }

  // 3. Emit.
  const symDeclFile = (sym: ts.Symbol | undefined): string | undefined => {
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations?.[0]?.getSourceFile().fileName;
  };

  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    const imports = new Map<string, Set<string>>();
    const use = (mod: string, name: string) => { if (!imports.has(mod)) imports.set(mod, new Set()); imports.get(mod)!.add(name); };
    const useRuntime = (name: string, at?: ts.Node) => {
      if (!runtimeNames.has(name)) fail(at ?? sf, `runtime has no '${name}' (scripts/ts2milo/runtime.milo)`);
      use(RUNTIME_MOD, name);
      return name;
    };
    // A name declared elsewhere: another input file, or the hand-written runtime.
    const useDeclared = (name: string, declFile: string | undefined, at: ts.Node) => {
      if (!declFile || declFile === file) return name;
      if (inputSet.has(declFile)) use(modOf(declFile), name);
      else useRuntime(name, at);
      return name;
    };
    const std = (name: string) => { use(STD_MODULES[name], name); return name; };
    const out: string[] = [];
    let ind = 0;
    const line = (s: string) => out.push("    ".repeat(ind) + s);

    // Per-function state.
    let scopes: Map<ts.Symbol, string>[] = [];
    let usedNames: Set<string>[] = [];
    let curFn: ts.FunctionLikeDeclaration | null = null;
    let mutated = new Set<ts.Symbol>();
    const symOf = (id: ts.Identifier) => checker.getSymbolAtLocation(id);
    const declareLocal = (sym: ts.Symbol, base: string) => {
      let name = RESERVED.has(base) ? base + "_" : base;
      const taken = () => usedNames.some((s) => s.has(name));
      for (let i = 2; taken(); i++) name = `${base}_${i}`;
      scopes[scopes.length - 1].set(sym, name);
      usedNames[usedNames.length - 1].add(name);
      return name;
    };
    const lookupLocal = (sym: ts.Symbol) => { for (let i = scopes.length - 1; i >= 0; i--) { const n = scopes[i].get(sym); if (n) return n; } return undefined; };
    const push = () => { scopes.push(new Map()); usedNames.push(new Set()); };
    const pop = () => { scopes.pop(); usedNames.pop(); };

    const jsLit = (s: string): string => {
      if (s.length === 0) return `""`;
      hit("string literal", "UTF-16LE byte escapes in a Milo string (JS string semantics)");
      let o = "";
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        o += "\\x" + (c & 255).toString(16).padStart(2, "0") + "\\x" + (c >> 8).toString(16).padStart(2, "0");
      }
      return `"${o}"`;
    };

    // ---- types ----
    const isOptionT = (t: ts.Type) => t.isUnion() && t.types.some((x) => x.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Boolean);
    const enumDeclOf = (t: ts.Type): ts.EnumDeclaration | null => {
      let d = (t.aliasSymbol ?? t.symbol)?.declarations?.[0];
      if (d && ts.isEnumMember(d)) d = d.parent;
      return d && ts.isEnumDeclaration(d) ? d : null;
    };
    const ty = (t: ts.Type, at: ts.Node): string => {
      if (isOptionT(t)) { hit("T | undefined", "Option<T>"); return `Option<${ty(checker.getNonNullableType(t), at)}>`; }
      const ed = enumDeclOf(t);
      if (ed) return useDeclared(ed.name.text, ed.getSourceFile().fileName, at);
      if (t.flags & ts.TypeFlags.Boolean || t.flags & ts.TypeFlags.BooleanLiteral) return "bool";
      if (t.flags & ts.TypeFlags.NumberLike) return "i64";
      if (litsOf(t)) { const n = unionName(t, at); const u = litUnions.get(unionKey(litsOf(t)!))!; return useDeclared(n, u.file, at); }
      if (t.flags & ts.TypeFlags.StringLike) return "string";
      if (t.flags & ts.TypeFlags.Void) return "void";
      if (t.flags & ts.TypeFlags.Never) return "never";
      if (checker.isArrayType(t)) return `Vec<${ty(checker.getTypeArguments(t as ts.TypeReference)[0], at)}>`;
      if (t.symbol?.name === "Set") return `${std("HashSet")}<${ty(checker.getTypeArguments(t as ts.TypeReference)[0], at)}>`;
      const d = t.symbol?.declarations?.[0];
      if (d && (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d))) return useDeclared(d.name!.text, d.getSourceFile().fileName, at);
      return fail(at, `type ${checker.typeToString(t)}`);
    };
    const defaultOf = (t: ts.Type, at: ts.Node): string => {
      if (t.flags & ts.TypeFlags.NumberLike) return "0";
      if (t.flags & ts.TypeFlags.StringLike) return `""`;
      if (t.flags & ts.TypeFlags.BooleanLike) return "false";
      return fail(at, `declaration without initializer of type ${checker.typeToString(t)}`);
    };

    // ---- expressions ----
    const tOf = (e: ts.Node) => checker.getTypeAtLocation(e);
    const isStr = (e: ts.Node) => !!(tOf(e).flags & ts.TypeFlags.StringLike) && !litsOf(tOf(e)) && !enumDeclOf(tOf(e));
    const isNum = (e: ts.Node) => !!(tOf(e).flags & ts.TypeFlags.NumberLike);
    const isUndefinedId = (e: ts.Expression) => ts.isIdentifier(e) && e.text === "undefined";

    const conv = (e: ts.Expression, want?: ts.Type): string => {
      if (want && isOptionT(want) && !isOptionT(tOf(e))) {
        if (isUndefinedId(e)) return "Option.None";
        return `Option.Some(${ex(e, checker.getNonNullableType(want))})`;
      }
      return ex(e, want);
    };

    const memberAccess = (e: ts.PropertyAccessExpression): string => {
      const sym = checker.getSymbolAtLocation(e.name);
      const d = sym?.declarations?.[0];
      if (d && ts.isEnumMember(d)) {
        const en = d.parent as ts.EnumDeclaration;
        return `${useDeclared(en.name.text, en.getSourceFile().fileName, e)}.${d.name.getText()}`;
      }
      if (e.name.text === "length" && d && isLibDecl(program, d)) {
        if (isStr(e.expression)) { hit("string .length", "jsLen (UTF-16 units)"); return `${useRuntime("jsLen", e)}(${ex(e.expression)})`; }
        hit("array .length", "Vec .len");
        return `${ex(e.expression)}.len`;
      }
      const base = e.expression.kind === ts.SyntaxKind.ThisKeyword ? "self" : ex(e.expression);
      return `${base}.${RESERVED.has(e.name.text) ? e.name.text + "_" : e.name.text}`;
    };

    const args = (call: ts.CallExpression | ts.NewExpression): string => {
      const sig = checker.getResolvedSignature(call);
      const decl = sig?.declaration as ts.SignatureDeclaration | undefined;
      const parts: string[] = [];
      const given = call.arguments ?? [];
      decl?.parameters.forEach((p, i) => {
        const pt = checker.getTypeAtLocation(p);
        if (i < given.length) parts.push(conv(given[i], pt));
        else if (p.initializer) { hit("default parameter", "default expression filled in at the call site"); parts.push(ex(p.initializer)); }
        else if (p.questionToken) parts.push("Option.None");
        else fail(call, "missing argument");
      });
      return parts.join(", ");
    };

    const withTry = (call: ts.CallExpression, code: string): string => {
      const d = declOf(call);
      if (d && throwing.has(d) && !isThrower(d)) { hit("call of a throwing function", "`?` on the Result"); return `${code}?`; }
      return code;
    };

    const callEx = (c: ts.CallExpression): string => {
      const key = calleeKey(program, checker, c);
      const a = c.arguments;
      if (key !== null) {
        const recv = ts.isPropertyAccessExpression(c.expression) ? c.expression.expression : null;
        switch (key) {
          case "String.charCodeAt": return `${useRuntime("jsCharCodeAt", c)}(${ex(recv!)}, ${ex(a[0])})`;
          case "String.slice": return a.length > 1 ? `${useRuntime("jsSlice", c)}(${ex(recv!)}, ${ex(a[0])}, ${ex(a[1])})` : `${useRuntime("jsSliceFrom", c)}(${ex(recv!)}, ${ex(a[0])})`;
          case "StringConstructor.fromCharCode": return `${useRuntime("jsFromCharCode", c)}(${ex(a[0])})`;
          case "StringConstructor.fromCodePoint": return `${useRuntime("jsFromCodePoint", c)}(${ex(a[0])})`;
          case "Number.toString": return a.length ? `${useRuntime("jsNumRadix", c)}(${ex(recv!)}, ${ex(a[0])})` : `${useRuntime("jsNum", c)}(${ex(recv!)})`;
          case "Array.push": return `${ex(recv!)}.push(${conv(a[0], checker.getTypeArguments(tOf(recv!) as ts.TypeReference)[0])})`;
          case "Set.has": return `${ex(recv!)}.contains(${ex(a[0])})`;
          case "parseInt": return `${useRuntime("jsParseInt", c)}(${ex(a[0])}, ${ex(a[1])})`;
          case "String()": return isNum(a[0]) ? `${useRuntime("jsNum", c)}(${ex(a[0])})` : ex(a[0]);
        }
        return fail(c, `library call ${key}`);
      }
      const argStr = args(c);
      let code: string;
      if (ts.isPropertyAccessExpression(c.expression)) {
        const r = c.expression.expression;
        code = `${r.kind === ts.SyntaxKind.ThisKeyword ? "self" : ex(r)}.${c.expression.name.text}(${argStr})`;
      } else {
        const id = c.expression as ts.Identifier;
        code = `${useDeclared(id.text, symDeclFile(symOf(id)), c)}(${argStr})`;
      }
      return withTry(c, code);
    };

    const ex = (e: ts.Expression, want?: ts.Type): string => {
      switch (e.kind) {
        case ts.SyntaxKind.ParenthesizedExpression: return `(${ex((e as ts.ParenthesizedExpression).expression, want)})`;
        case ts.SyntaxKind.ThisKeyword: return "self";
        case ts.SyntaxKind.TrueKeyword: return "true";
        case ts.SyntaxKind.FalseKeyword: return "false";
        case ts.SyntaxKind.NumericLiteral: return e.getText();
        case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return jsLit((e as ts.NoSubstitutionTemplateLiteral).text);
        case ts.SyntaxKind.StringLiteral: {
          const s = (e as ts.StringLiteral).text;
          if (want && litsOf(want)) { hit("string literal as union enum", "enum variant"); return `${ty(want, e)}.${pascal(s)}`; }
          return jsLit(s);
        }
        case ts.SyntaxKind.Identifier: {
          const id = e as ts.Identifier;
          if (id.text === "undefined") return "Option.None";
          const sym = symOf(id);
          const local = sym && lookupLocal(sym);
          if (local) return local;
          return useDeclared(id.text, symDeclFile(sym), e);
        }
        case ts.SyntaxKind.TemplateExpression: {
          const t = e as ts.TemplateExpression;
          hit("template literal", "concatenation of js strings");
          const parts: string[] = [];
          if (t.head.text) parts.push(jsLit(t.head.text));
          for (const sp of t.templateSpans) {
            parts.push(isNum(sp.expression) ? `${useRuntime("jsNum", e)}(${ex(sp.expression)})` : ex(sp.expression));
            if (sp.literal.text) parts.push(jsLit(sp.literal.text));
          }
          return `(${parts.join(" + ")})`;
        }
        case ts.SyntaxKind.PropertyAccessExpression: return memberAccess(e as ts.PropertyAccessExpression);
        case ts.SyntaxKind.ElementAccessExpression: {
          const el = e as ts.ElementAccessExpression;
          if (isStr(el.expression)) { hit("string[i]", "jsAt: one-unit js string, empty past the end"); return `${useRuntime("jsAt", e)}(${ex(el.expression)}, ${ex(el.argumentExpression)})`; }
          return `${ex(el.expression)}[${ex(el.argumentExpression)}]`;
        }
        case ts.SyntaxKind.CallExpression: return callEx(e as ts.CallExpression);
        case ts.SyntaxKind.NewExpression: {
          const n = e as ts.NewExpression;
          const t = tOf(n);
          if (t.symbol?.name === "Set") {
            hit("new Set([...])", "HashSet.fromVec");
            return `${std("HashSet")}.fromVec(${n.arguments?.length ? ex(n.arguments[0]) : "Vec.new()"})`;
          }
          hit("new Class(...)", "Class.new(...), defaults filled");
          const d = t.symbol.declarations![0] as ts.ClassDeclaration;
          return `${useDeclared(d.name!.text, d.getSourceFile().fileName, e)}.new(${args(n)})`;
        }
        case ts.SyntaxKind.BinaryExpression: {
          const b = e as ts.BinaryExpression;
          const op = b.operatorToken.kind;
          const text = b.operatorToken.getText();
          if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            const sym = op === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!=";
            const lt = tOf(b.left), rt = tOf(b.right);
            return `(${ex(b.left, litsOf(rt) ? rt : undefined)} ${sym} ${ex(b.right, litsOf(lt) ? lt : undefined)})`;
          }
          return `(${ex(b.left)} ${text} ${ex(b.right)})`;
        }
        case ts.SyntaxKind.PrefixUnaryExpression: {
          const u = e as ts.PrefixUnaryExpression;
          return u.operator === ts.SyntaxKind.ExclamationToken ? `!${ex(u.operand)}` : `(-${ex(u.operand)})`;
        }
        case ts.SyntaxKind.ConditionalExpression: {
          const c = e as ts.ConditionalExpression;
          hit("ternary", "if-expression");
          return `(if ${ex(c.condition)} { ${conv(c.whenTrue, want)} } else { ${conv(c.whenFalse, want)} })`;
        }
        case ts.SyntaxKind.AsExpression: {
          const a = e as ts.AsExpression;
          const en = enumDeclOf(checker.getTypeFromTypeNode(a.type))!;
          hit("string as StringEnum", "generated Enum_fromValue");
          return `${useDeclared(en.name.text + "_fromValue", en.getSourceFile().fileName, e)}(${ex(a.expression)})`;
        }
        case ts.SyntaxKind.ObjectLiteralExpression: {
          const o = e as ts.ObjectLiteralExpression;
          const t = checker.getNonNullableType(checker.getContextualType(o)!);
          const d = t.symbol.declarations![0] as ts.InterfaceDeclaration;
          hit("object literal", "struct literal, missing optionals are Option.None");
          const name = useDeclared(d.name.text, d.getSourceFile().fileName, e);
          const fields = d.members.filter(ts.isPropertySignature).map((m) => {
            const fname = (m.name as ts.Identifier).text;
            const prop = o.properties.find((p) => (p.name as ts.Identifier).text === fname);
            const pt = checker.getTypeOfSymbol(checker.getPropertyOfType(t, fname)!);
            const v = !prop ? "Option.None" : ts.isShorthandPropertyAssignment(prop) ? conv(prop.name, pt) : conv((prop as ts.PropertyAssignment).initializer, pt);
            return `${RESERVED.has(fname) ? fname + "_" : fname}: ${v}`;
          });
          return `${name} { ${fields.join(", ")} }`;
        }
        case ts.SyntaxKind.ArrayLiteralExpression: {
          const a = e as ts.ArrayLiteralExpression;
          if (a.elements.length === 0) return "Vec.new()";
          const et = want && checker.isArrayType(want) ? checker.getTypeArguments(want as ts.TypeReference)[0] : undefined;
          return `[${a.elements.map((x) => conv(x, et)).join(", ")}]`;
        }
      }
      return fail(e, `expression ${ts.SyntaxKind[e.kind]}`);
    };

    // ---- statements ----
    const retWrap = (fn: ts.FunctionLikeDeclaration) => throwing.has(fn) && !isThrower(fn);
    const stmt = (s: ts.Statement) => {
      switch (s.kind) {
        case ts.SyntaxKind.EmptyStatement: return;
        case ts.SyntaxKind.Block: { line("{"); ind++; block(s as ts.Block); ind--; line("}"); return; }
        case ts.SyntaxKind.VariableStatement: {
          for (const d of (s as ts.VariableStatement).declarationList.declarations) {
            const sym = symOf(d.name as ts.Identifier)!;
            const t = checker.getTypeAtLocation(d.name);
            const init = d.initializer ? conv(d.initializer, t) : defaultOf(t, d);
            const isVar = mutated.has(sym) || !d.initializer;
            hit("const/let", "let, or var when reassigned or mutated");
            const name = declareLocal(sym, (d.name as ts.Identifier).text);
            line(`${isVar ? "var" : "let"} ${name}: ${ty(t, d)} = ${init}`);
          }
          return;
        }
        case ts.SyntaxKind.IfStatement: {
          let n: ts.Statement | undefined = s;
          let first = true;
          while (n && ts.isIfStatement(n)) {
            line(`${first ? "" : "} else "}if ${ex(n.expression)} {`);
            first = false;
            ind++; body(n.thenStatement); ind--;
            n = n.elseStatement;
          }
          if (n) { line("} else {"); ind++; body(n); ind--; }
          line("}");
          return;
        }
        case ts.SyntaxKind.WhileStatement: {
          const w = s as ts.WhileStatement;
          line(`while ${ex(w.expression)} {`);
          ind++; body(w.statement); ind--;
          line("}");
          return;
        }
        case ts.SyntaxKind.BreakStatement: line("break"); return;
        case ts.SyntaxKind.ContinueStatement: line("continue"); return;
        case ts.SyntaxKind.ReturnStatement: {
          const r = s as ts.ReturnStatement;
          const rt = curFn ? checker.getSignatureFromDeclaration(curFn)!.getReturnType() : undefined;
          if (curFn && retWrap(curFn)) line(`return Result.Ok(${r.expression ? conv(r.expression, rt) : "true"})`);
          else line(r.expression ? `return ${conv(r.expression, rt)}` : "return");
          return;
        }
        case ts.SyntaxKind.ThrowStatement: {
          const t = s as ts.ThrowStatement;
          hit("throw", "Result.Err (a never-returning function returns the error itself)");
          line(curFn && isThrower(curFn) ? `return ${ex(t.expression)}` : `return Result.Err(${ex(t.expression)})`);
          return;
        }
        case ts.SyntaxKind.ExpressionStatement: return exprStmt((s as ts.ExpressionStatement).expression);
      }
      fail(s, `statement ${ts.SyntaxKind[s.kind]}`);
    };
    const body = (s: ts.Statement) => { push(); if (ts.isBlock(s)) block(s); else stmt(s); pop(); };
    const block = (b: ts.Block) => { for (const s of b.statements) stmt(s); };
    const exprStmt = (e: ts.Expression) => {
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        const lt = tOf(e.left);
        if (op === ts.SyntaxKind.EqualsToken) { line(`${ex(e.left)} = ${conv(e.right, lt)}`); return; }
        if (op === ts.SyntaxKind.PlusEqualsToken && isStr(e.left)) { hit("string +=", "pushStr in place"); line(`${ex(e.left)}.pushStr(${ex(e.right)})`); return; }
        line(`${ex(e.left)} ${e.operatorToken.getText()} ${ex(e.right)}`);
        return;
      }
      if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
        hit("x++ / x--", "x += 1 / x -= 1");
        line(`${ex(e.operand)} ${e.operator === ts.SyntaxKind.PlusPlusToken ? "+=" : "-="} 1`);
        return;
      }
      if (ts.isCallExpression(e)) {
        const d = declOf(e);
        if (d && isThrower(d)) { line(`return Result.Err(${callEx(e)})`); return; }
        line(callEx(e));
        return;
      }
      fail(e, `expression statement ${ts.SyntaxKind[e.kind]}`);
    };

    // ---- declarations ----
    const overridesDir = opts.overridesDir ?? join(ROOT, "scripts/ts2milo/overrides");
    const fileBase = basename(file).replace(/\.ts$/, "");
    const fnHeader = (fn: ts.FunctionLikeDeclaration, name: string, selfKind: "" | "&" | "&mut "): string => {
      const sig = checker.getSignatureFromDeclaration(fn)!;
      const ps = fn.parameters.map((p) => `${declareLocal(symOf(p.name as ts.Identifier)!, (p.name as ts.Identifier).text)}: ${ty(checker.getTypeAtLocation(p), p)}`);
      if (selfKind) ps.unshift(`self: ${selfKind}${(fn.parent as ts.ClassDeclaration).name!.text}`);
      let r = sig.getReturnType();
      let rs = isThrower(fn) ? errNameFor(fn) : ty(r, fn);
      if (retWrap(fn)) rs = `Result<${r.flags & ts.TypeFlags.Void ? "bool" : rs}, ${errNameFor(fn)}>`;
      return `fn ${RESERVED.has(name) ? name + "_" : name}(${ps.join(", ")})${rs === "void" ? "" : `: ${rs}`}`;
    };
    // The error class a function throws: resolved through the first `throw new X` in the program.
    let errDeclFile: string | undefined;
    const findErrName = (fn: ts.Node): ts.Identifier => {
      let id: ts.Identifier | undefined;
      for (const f of allFns) walkBody(f.body!, (n) => { if (!id && ts.isThrowStatement(n) && ts.isNewExpression(n.expression) && ts.isIdentifier(n.expression.expression)) id = n.expression.expression; });
      return id ?? fail(fn, "cannot find the thrown class");
    };
    const errNameFor = (fn: ts.Node) => {
      const id = findErrName(fn);
      errDeclFile = symDeclFile(checker.getSymbolAtLocation(id));
      return useDeclared(errType, errDeclFile, fn);
    };
    const prepareMutated = (fn: ts.FunctionLikeDeclaration) => {
      mutated = new Set();
      walkBody(fn.body!, (n) => {
        const consider = (target: ts.Expression) => { const r = rootOf(target); if (ts.isIdentifier(r)) { const s = symOf(r); if (s) mutated.add(s); } };
        if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind)) consider(n.left);
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) consider(n.operand);
        if (ts.isCallExpression(n) && calleeKey(program, checker, n) === "Array.push") consider((n.expression as ts.PropertyAccessExpression).expression);
      });
    };
    const emitFn = (fn: ts.FunctionLikeDeclaration, name: string, isMethod: boolean, exported: boolean) => {
      const ovPath = join(overridesDir, `${fileBase}.${name}.milo`);
      if (existsSync(ovPath)) {
        hit("override", "whole function replaced by hand");
        report.functions.push({ file: rel(file), name, override: true });
        for (const l of readFileSync(ovPath, "utf8").trimEnd().split("\n")) line(l);
        return;
      }
      report.functions.push({ file: rel(file), name, override: false });
      curFn = fn; scopes = []; usedNames = []; push();
      prepareMutated(fn);
      const hdr = fnHeader(fn, name, isMethod ? (mutating.has(fn) ? "&mut " : "&") : "");
      line(`${exported && !isMethod ? "pub " : ""}${hdr} {`);
      ind++;
      if (isThrower(fn)) hit("never-returning function", "returns the error value; callers `return Result.Err(call)`");
      block(fn.body as ts.Block);
      if (retWrap(fn) && (fn.type?.kind === ts.SyntaxKind.VoidKeyword)) line("return Result.Ok(true)");
      ind--;
      line("}");
      pop(); curFn = null;
    };
    const isExported = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    const mname = (n: ts.PropertyName) => (n as ts.Identifier).text;

    for (const n of sf.statements) {
      if (ts.isImportDeclaration(n) || ts.isEmptyStatement(n)) continue;
      const pub = isExported(n) ? "pub " : "";
      if (ts.isEnumDeclaration(n)) {
        hit("string enum", "enum + Enum_value + Enum_fromValue");
        const name = n.name.text;
        line(`${pub}enum ${name} {`);
        ind++; for (const m of n.members) line(`${m.name.getText()},`); ind--;
        line("}");
        line(`${pub}fn ${name}_value(k: ${name}): string {`);
        ind++; line("return match k {"); ind++;
        for (const m of n.members) line(`${name}.${m.name.getText()} => ${jsLit((m.initializer as ts.StringLiteral).text)}`);
        ind--; line("}"); ind--; line("}");
        line(`${pub}fn ${name}_fromValue(s: string): ${name} {`);
        ind++;
        for (const m of n.members) line(`if s == ${jsLit((m.initializer as ts.StringLiteral).text)} { return ${name}.${m.name.getText()} }`);
        line(`todo("${name}_fromValue: no such value")`);
        ind--; line("}");
      } else if (ts.isTypeAliasDeclaration(n)) {
        const u = litUnions.get(unionKey(litsOf(checker.getTypeFromTypeNode(n.type))!))!;
        if (u.name === n.name.text && u.file === file) emitUnion(u);
      } else if (ts.isInterfaceDeclaration(n)) {
        hit("interface", "struct");
        for (const m of n.members) if (ts.isPropertySignature(m)) {
          const t = checker.getNonNullableType(checker.getTypeFromTypeNode(m.type!));
          const u = litsOf(t) && litUnions.get(unionKey(litsOf(t)!));
          if (u && u.file === file && u.name === `${n.name.text}_${mname(m.name)}`) emitUnion(u);
        }
        line(`${pub}struct ${n.name.text} {`);
        ind++;
        for (const m of n.members.filter(ts.isPropertySignature)) {
          const t = checker.getTypeAtLocation(m);
          const pt = m.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!) : t;
          line(`${RESERVED.has(mname(m.name)) ? mname(m.name) + "_" : mname(m.name)}: ${ty(pt, m)},`);
        }
        ind--; line("}");
      } else if (ts.isClassDeclaration(n)) {
        hit("class", "struct + impl; this -> self, &mut self inferred");
        const cname = n.name!.text;
        const ctor = n.members.find(ts.isConstructorDeclaration);
        const props: { name: string; type: string; init: string | null; param: ts.ParameterDeclaration | null }[] = [];
        for (const m of n.members) {
          if (ts.isPropertyDeclaration(m)) {
            const t = checker.getTypeAtLocation(m);
            props.push({ name: mname(m.name), type: ty(t, m), init: m.initializer ? conv(m.initializer, t) : null, param: null });
          }
        }
        for (const p of ctor?.parameters ?? []) if (p.modifiers?.length) {
          hit("constructor parameter property", "struct field + parameter of new");
          props.push({ name: (p.name as ts.Identifier).text, type: ty(checker.getTypeAtLocation(p), p), init: null, param: p });
        }
        line(`${pub}struct ${cname} {`);
        ind++; for (const p of props) line(`${p.name}: ${p.type},`); ind--;
        line("}");
        line(`impl ${cname} {`);
        ind++;
        report.functions.push({ file: rel(file), name: `${cname}.new`, override: false });
        scopes = []; usedNames = []; push();
        const ps = (ctor?.parameters ?? []).map((p) => `${declareLocal(symOf(p.name as ts.Identifier)!, (p.name as ts.Identifier).text)}: ${ty(checker.getTypeAtLocation(p), p)}`);
        line(`fn new(${ps.join(", ")}): ${cname} {`);
        ind++;
        line(`return ${cname} {`);
        ind++;
        for (const p of props) line(`${p.name}: ${p.param ? lookupLocal(symOf(p.param.name as ts.Identifier)!)! : p.init},`);
        ind--; line("}");
        ind--; line("}");
        pop();
        for (const m of n.members) if (ts.isMethodDeclaration(m)) emitFn(m, mname(m.name), true, false);
        ind--; line("}");
      } else if (ts.isFunctionDeclaration(n)) {
        emitFn(n, n.name!.text, false, !!pub);
      } else if (ts.isVariableStatement(n)) {
        scopes = []; usedNames = []; push(); mutated = new Set();
        for (const d of n.declarationList.declarations) {
          hit("module-level const", "global (initialized on first read)");
          const t = checker.getTypeAtLocation(d.name);
          line(`${pub}let ${(d.name as ts.Identifier).text}: ${ty(t, d)} = ${conv(d.initializer!, t)}`);
        }
        pop();
      } else fail(n, `top-level ${ts.SyntaxKind[n.kind]}`);
    }
    function emitUnion(u: { name: string; lits: string[] }) {
      hit("string-literal union", "generated enum + Name_value");
      line(`pub enum ${u.name} { ${u.lits.map(pascal).join(", ")} }`);
    }

    const header = `// GENERATED by scripts/ts2milo.ts from ${rel(file)}. Do not edit; change the TypeScript.`;
    const impLines = [...imports.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, names]) => `from "${m}" import { ${[...names].sort().join(", ")} }`);
    report.files.set(basename(file).replace(/\.ts$/, ".milo"), [header, ...impLines, "", ...out, ""].join("\n"));
  }
  report.files.set("ts2milo_runtime.milo", runtimeSrc);
  return report;
}

export function summary(r: Report): string {
  const total = r.functions.length;
  const ov = r.functions.filter((f) => f.override);
  const auto = total - ov.length;
  let s = `functions: ${total} total, ${auto} automatic, ${ov.length} overrides = ${total ? ((auto / total) * 100).toFixed(1) : "0"}% automatic\n`;
  for (const o of ov) s += `override: ${o.file} ${o.name}\n`;
  s += "constructs hit:\n";
  for (const [k, v] of [...r.constructs.entries()].sort(([a], [b]) => a.localeCompare(b))) s += `  ${String(v.count).padStart(5)}  ${k}  ->  ${v.how}\n`;
  return s;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const inputs: string[] = [];
  let outDir = "", check = false, overridesDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o") outDir = argv[++i];
    else if (argv[i] === "--check") check = true;
    else if (argv[i] === "--overrides") overridesDir = argv[++i];
    else inputs.push(argv[i]);
  }
  if (!inputs.length || !outDir) { console.error("usage: ts2milo.ts <files.ts...> -o <dir> [--check] [--overrides <dir>]"); process.exit(2); }
  try {
    const r = transpile(inputs, { overridesDir });
    console.log(summary(r).trimEnd());
    if (check) {
      let stale = 0;
      for (const [name, text] of r.files) {
        const p = join(outDir, name);
        if (!existsSync(p) || readFileSync(p, "utf8") !== text) { console.error(`stale: ${p}`); stale++; }
      }
      if (stale) process.exit(1);
    } else {
      mkdirSync(outDir, { recursive: true });
      for (const [name, text] of r.files) writeFileSync(join(outDir, name), text);
    }
  } catch (e) {
    if (e instanceof Unsupported) { console.error(`ts2milo: ${e.message}`); process.exit(1); }
    throw e;
  }
}
