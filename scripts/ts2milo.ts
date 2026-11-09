// TypeScript -> Milo transpiler for the portable subset (scripts/ts2milo/subset.ts).
//   bun scripts/ts2milo.ts src/tokens.ts src/lexer.ts -o <dir> [--check] [--overrides <dir>]
// Types come from the TypeScript checker; anything outside the subset fails with file:line and
// the construct name. Thin by design: refactor the TypeScript to fit, do not grow this file.
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { anonStructHandled, assertionIsNoop, assertionReason, stripConst, arrayClosureCall, calleeKey, hoistedClosure, chainCompareHandled, clauseBody, isChainMember, isLibDecl, makeProgram, nullishHandled, sideEffectFree, switchHandled, truthyHandled, truthyKind, violationsOf, inCondPos } from "./ts2milo/subset";
import { buildImmutability } from "./ts2milo/written-props";
import { ID_FIELD, isKeyedContainer, mapValuesRecv, nodeCompare, nodeKeyOf, nodeKeyOfContainer, type NodeKey } from "./ts2milo/node-identity";
import { RUNTIME_OWNED, buildAstModel, isPrimUnion, discriminantRead, emitAst, guardUnion, nestedUnionOf, registerUnions, taggedUnionOf, unionOfType } from "./ts2milo/ast-model";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME_FILE = join(ROOT, "scripts/ts2milo/runtime.milo");
const RUNTIME_MOD = "./ts2milo_runtime";
// JavaScript names the prelude already owns, mirrored under another name in the runtime.
const RUNTIME_RENAMES: Record<string, string> = { Error: "JsError" };
const THROWN_ENUM = "Thrown";
const STD_MODULES: Record<string, string> = { HashSet: "std/set", [THROWN_ENUM]: "./thrown" };
const safeId = (n: string): string => { const m = n.replace(/\$/g, "_d"); return RESERVED.has(m) ? m + "_" : m; };
// Runtime-mirrored interfaces (runtime.milo) that derive Clone.
const RUNTIME_CLONEABLE = new Set(["Diagnostic", "DiagnosticNote", "ReplayPlan", "TargetInfo"]);
const RESERVED = new Set("fn extern let var return if else while true false struct enum match mut import from break continue as trait impl for in unsafe move null is type interface requires ensures invariant decreases self Self pub clone drop".split(" "));

export interface Report {
  files: Map<string, string>;
  functions: { file: string; name: string; override: boolean }[];
  // --lenient: functions whose body hit an unsupported construct, emitted as a stub that names it.
  stubs: { file: string; name: string; reason: string }[];
  // Copies of recursive AST values the read-only rule allowed (a perf note: each is a deep clone).
  recursiveClones: number;
  // "file::Name" of each type, class or module-level const that lenient mode left out as a stub.
  deadDecls: Set<string>;
  constructs: Map<string, { count: number; how: string }>;
  // src/ast.ts is types-only: Milo types and a JSON decoder are generated from its interfaces
  // and tagged unions. Fields with no Milo type are listed, not silently lost.
  ast?: { types: number; dropped: { iface: string; field: string; type: string }[]; sizeBoxed: string[] };
}

export class Unsupported extends Error {}

// `astRoots`: the types of src/ast.ts the Milo AST must contain (everything reachable from them).
// A declaration that turns into a stub can be named by code emitted before it, and the importer then fails to
// compile. A second pass knows which declarations are dead, so their users stub too (the reason names the dead one).
// `stubNames` (--lenient): functions to emit as stubs by "<ts file>::<name>", with the reason (the
// self-host meter's --stub-errors feeds back the Milo compile errors of the previous round).
export function transpile(inputs: string[], opts: { overridesDir?: string; astRoots?: string[]; lenient?: boolean; stubNames?: Map<string, string> } = {}): Report {
  const first = transpileOnce(inputs, opts, new Set());
  if (!opts.lenient || first.deadDecls.size === 0) return first;
  return transpileOnce(inputs, opts, first.deadDecls);
}

function transpileOnce(inputs: string[], opts: { overridesDir?: string; astRoots?: string[]; lenient?: boolean; stubNames?: Map<string, string> }, dead: Set<string>): Report {
  const files = inputs.map((f) => resolve(ROOT, f));
  const astFile = files.find((f) => basename(f) === "ast.ts");
  const program = makeProgram(ROOT, files);
  const checker = program.getTypeChecker();
  registerUnions(program, checker);
  const runtimeSrc = readFileSync(RUNTIME_FILE, "utf8");
  const runtimeNames = new Set([...runtimeSrc.matchAll(/^pub (?:fn|struct|enum) (\w+)/gm)].map((m) => m[1]));
  const rel = (f: string) => f.startsWith(ROOT + "/") ? f.slice(ROOT.length + 1) : f;
  const modOf = (f: string) => "./" + basename(f).replace(/\.ts$/, "");
  const inputSet = new Set(files);

  const report: Report = { files: new Map(), functions: [], constructs: new Map(), stubs: [], recursiveClones: 0, deadDecls: new Set() };
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
  const viol = files.filter((f) => f !== astFile).flatMap((f) => violationsOf(program, checker, program.getSourceFile(f)!));
  // --lenient generates the whole tree anyway: each function that hits an unsupported construct
  // becomes a stub, so the generated frontend compiles and the stubs are the list of what is left.
  if (viol.length && !opts.lenient) {
    const v = viol[0];
    throw new Unsupported(`${rel(v.file)}:${v.line}: ${v.construct}` + (viol.length > 1 ? ` (and ${viol.length - 1} more)` : ""));
  }

  // 2. Whole-program facts: string-literal unions, throwing and mutating functions.
  // A leading non-identifier character (`"$peel"`) is dropped, and a leading digit gets a `V`: both must still give a Milo identifier.
  const pascal = (s: string) => { const t = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/(^|[^a-zA-Z0-9]+)(.)/g, (_, __, c) => c.toUpperCase()); return t === "" ? "V" + [...s].map((c) => c.charCodeAt(0).toString(16)).join("_") : /^[0-9]/.test(t) ? "V" + t : t; };
  const unionKey = (lits: string[]) => [...lits].sort().join("\u0000");
  const litUnions = new Map<string, { name: string; lits: string[]; file: string }>();
  const litsOf = (t: ts.Type): string[] | null => {
    if (!t.isUnion() || (t.flags & ts.TypeFlags.EnumLike)) return null;
    const ls = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    if (ls.length < 2 && !(ls.length === 1 && ls[0].isStringLiteral())) return null;
    return ls.every((x) => x.isStringLiteral()) ? ls.map((x) => (x as ts.StringLiteralType).value) : null;
  };
  const registerUnion = (t: ts.Type, name: string, file: string) => {
    const lits = litsOf(t);
    if (!lits) return;
    const k = unionKey(lits);
    if (!litUnions.has(k)) litUnions.set(k, { name, lits, file });
  };
  // Types with no declared name get one from where they are written: `<fn>_<param>`, `<fn>_ret`,
  // `<fn>_<local>`, `<Owner>_<field>`; identical literal sets share one generated enum. Declared names win,
  // so these register after the whole program has been walked. Emitted at the end of the declaring file.
  const typeNames = new Set<string>();
  const anonStructs = new Map<ts.Node, { name: string; file: string; emitted: boolean; dup?: boolean }>();
  const anonShapes = new Map<string, { name: string; file: string; emitted: boolean }>();
  // Structs for object types TS infers from a literal (`const x = { name, type }`), keyed by shape so two sites with the same
  // fields share one struct. `fields` is absent when the shape matched a written type literal that is emitted already.
  type InferredStruct = { name: string; file: string; emitted: boolean; fields?: { name: string; t: ts.Type }[]; at: ts.Node };
  const inferredStructs = new Map<string, InferredStruct>();
  const genUnions = new Set<{ name: string; lits: string[]; file: string }>();
  const fnLabel = (n: ts.Node): string => {
    for (let c: ts.Node | undefined = n; c; c = c.parent) {
      if (!ts.isFunctionLike(c)) continue;
      const f = c as ts.FunctionLikeDeclaration;
      const own = f.name && ts.isIdentifier(f.name) ? f.name.text : ts.isConstructorDeclaration(f) ? "new" : ts.isVariableDeclaration(f.parent) && ts.isIdentifier(f.parent.name) ? f.parent.name.text : "fn";
      const owner = f.parent && ts.isClassDeclaration(f.parent) && f.parent.name ? `${f.parent.name.text}_` : "";
      return owner + own;
    }
    return "";
  };
  const nameFrom = (n: ts.Node): string => {
    let c: ts.Node = n;
    while (c.parent && (ts.isTypeNode(c.parent) || ts.isParenthesizedExpression(c.parent))) c = c.parent;
    const p = c.parent;
    const join = (...xs: string[]) => xs.filter(Boolean).join("_");
    if (p) {
      if (ts.isParameter(p) && ts.isIdentifier(p.name)) return join(fnLabel(p.parent), p.name.text);
      if (ts.isFunctionLike(p) && (p as ts.FunctionLikeDeclaration).type === c) return join(fnLabel(p), "ret");
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return join(fnLabel(p.parent), p.name.text);
      if ((ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && ts.isIdentifier(p.name)) {
        const o = p.parent as { name?: ts.Identifier };
        return join(o.name?.text ?? "", p.name.text);
      }
      if (ts.isTypeAliasDeclaration(p)) return p.name.text;
    }
    return join(fnLabel(n), "lit");
  };
  const freshName = (base: string) => {
    base = base ? base[0].toUpperCase() + base.slice(1) : "Anon";
    let name = base, i = 1;
    while (typeNames.has(name)) name = `${base}_${++i}`;
    typeNames.add(name);
    return name;
  };
  const registerGenUnion = (t: ts.Type, at: ts.Node) => {
    const lits = litsOf(t);
    if (!lits || litUnions.has(unionKey(lits))) return;
    const u = { name: freshName(nameFrom(at)), lits, file: at.getSourceFile().fileName };
    litUnions.set(unionKey(lits), u);
    genUnions.add(u);
  };
  const genCands: { node: ts.Node; file: string }[] = [];
  const allFns: ts.FunctionLikeDeclaration[] = [];
  for (const sf of program.getSourceFiles()) {
    if (isLibDecl(program, sf)) continue;
    const visit = (n: ts.Node) => {
      if ((ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) && n.name) typeNames.add(n.name.text);
      if (inputSet.has(sf.fileName) && sf.fileName !== astFile && (ts.isUnionTypeNode(n) || ts.isTypeLiteralNode(n))) genCands.push({ node: n, file: sf.fileName });
      if (ts.isTypeAliasDeclaration(n)) {
        registerUnion(checker.getTypeFromTypeNode(n.type), n.name.text, sf.fileName);
        // Registered up front so function bodies resolve `x.tag` to it; the declaring file emits the enum.
        const isAstF = sf.fileName === astFile;
        const tu0 = inputSet.has(sf.fileName) ? taggedUnionOf(checker, n) : null;
        if (tu0 && (isAstF || tu0.variants.every((v) => ts.isTypeLiteralNode(v.decl))) && !litUnions.has(unionKey(tu0.variants.map((v) => v.kind)))) {
          const lits = tu0.variants.map((v) => v.kind);
          litUnions.set(unionKey(lits), { name: `${n.name.text}${isAstF ? "Kind" : "Tag"}`, lits, file: sf.fileName });
        }
      }
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
  for (const { node, file } of genCands) {
    if (ts.isTypeLiteralNode(node)) {
      if (!anonStructHandled(checker, node)) continue;
      const alias = ts.isTypeAliasDeclaration(node.parent) ? node.parent.name.text : null;
      // Two unnamed literals of the same text in one file are one structural type in TypeScript (a class field and the result
      // interface that copies it): one struct, so a value of one is accepted where the other is expected.
      let generic = false;
      for (let q: ts.Node | undefined = node.parent; q; q = q.parent) if ((ts.isFunctionLike(q) || ts.isClassLike(q) || ts.isInterfaceDeclaration(q) || ts.isTypeAliasDeclaration(q)) && (q as { typeParameters?: unknown }).typeParameters) generic = true;
      const shape = alias || generic ? null : file + "|" + node.members.map((m) => m.getText().replace(/\s+/g, " ")).join(";");
      const same = shape ? anonShapes.get(shape) : undefined;
      if (same) { anonStructs.set(node, { ...same, emitted: false, dup: true }); continue; }
      const rec = { name: alias ?? freshName(nameFrom(node)), file, emitted: false };
      if (shape) anonShapes.set(shape, rec);
      anonStructs.set(node, rec);
    } else registerGenUnion(checker.getTypeFromTypeNode(node as ts.TypeNode), node);
  }
  // A union narrowed by earlier `||` operands (`k === "A" || k === "B"`) has fewer members than the
  // declared one: the smallest declared union containing all of them names it.
  const resolveUnion = (t: ts.Type, at: ts.Node) => {
    const lits = litsOf(t);
    let u = lits && litUnions.get(unionKey(lits));
    if (!u && lits) {
      const cands = [...litUnions.values()].filter((c) => lits.every((l) => c.lits.includes(l))).sort((a, b) => a.lits.length - b.lits.length);
      if (cands.length > 0 && (cands.length === 1 || cands[0].lits.length < cands[1].lits.length)) u = cands[0];
    }
    if (!u && lits && inputSet.has(at.getSourceFile().fileName) && at.getSourceFile().fileName !== astFile) {
      registerGenUnion(t, at);
      u = litUnions.get(unionKey(lits));
    }
    if (!u) return fail(at, "string-literal union without a declared name");
    return u;
  };

  const declOf = (call: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration | undefined => checker.getResolvedSignature(call)?.declaration as ts.SignatureDeclaration | undefined;
  const isThrower = (d: ts.Node) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.type?.kind === ts.SyntaxKind.NeverKeyword;
  // `replaceNode(target, next)` (src/checker.ts): a whole-value replacement of an AST node through the place that owns it,
  // translated as an assignment through the `&mut` place that keeps the node's hidden id. Its own body is not translated.
  const isReplaceNode = (n: ts.Node): n is ts.CallExpression => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "replaceNode" || n.arguments.length !== 2) return false;
    const d = declOf(n);
    return !!d && ts.isFunctionDeclaration(d) && inputSet.has(d.getSourceFile().fileName);
  };
  const throwing = new Set<ts.Node>();
  // --lenient: functions a whole-program pass could not handle; emitFn stubs them with the reason.
  const forceStub = new Map<ts.Node, string>();
  // The thrown classes, in first-thrown order, with the file declaring each. One class is the Result's
  // error type as is; several make one generated enum (THROWN_ENUM, one variant per class, carrying it).
  // `catch (e)`: e holds the error the try body failed with, so `throw e` rethrows it and `e instanceof C` tests its class.
  const catchVarOf = (e: ts.Expression) => { const d = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e)?.declarations?.[0] : undefined; return d && ts.isVariableDeclaration(d) && ts.isCatchClause(d.parent) ? d : undefined; };
  const isCatchVar = (e: ts.Expression) => !!catchVarOf(e);
  const errTypes: string[] = [];
  const errDecl = new Map<string, string | undefined>();
  const walkBody = (body: ts.Node, f: (n: ts.Node) => void) => { const w = (n: ts.Node) => { f(n); ts.forEachChild(n, w); }; w(body); };
  for (const fn of allFns) walkBody(fn.body!, (n) => {
    if (ts.isThrowStatement(n)) {
      throwing.add(fn);
      if (isCatchVar(n.expression)) return;
      const sym = checker.getTypeAtLocation(n.expression).symbol;
      const name = sym?.name ?? "?";
      if (name === "?" || name === "__type" || name === "__object") {
        // A caught value rethrown: its class is only known to a `catch` + type test, and try/catch is not translated.
        if (!opts.lenient) fail(n, "throw of a value without a class type");
        const sf = n.getSourceFile();
        forceStub.set(fn, `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: throw of a value without a class type (a rethrown catch variable; try/catch is not translated)`);
        throwing.delete(fn);
        return;
      }
      if (!errTypes.includes(name)) { errTypes.push(name); errDecl.set(name, sym.declarations?.[0]?.getSourceFile().fileName); }
    }
  });
  const thrownName = (s: ts.Symbol) => { const f = s.declarations?.[0]?.getSourceFile().fileName; return f && inputSet.has(f) ? s.name : RUNTIME_RENAMES[s.name] ?? s.name; };
  const errType = errTypes[0] ?? "";
  const multiErr = errTypes.length > 1;
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
    if (isReplaceNode(n)) return rootOf(n.arguments[0]);
    if (ts.isCallExpression(n)) {
      const k = calleeKey(program, checker, n);
      if (k === "Array.push" || k === "Array.pop" || k === "Set.add" || k === "Map.set") return rootOf((n.expression as ts.PropertyAccessExpression).expression);
    }
    return null;
  };
  // Types that are copied, not borrowed, when passed: numbers, bools and unit enums.
  const isOptionT = (t: ts.Type) => t.isUnion() && t.types.some((x) => x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) && !(t.flags & ts.TypeFlags.Boolean);
  const enumDeclOf = (t: ts.Type): ts.EnumDeclaration | null => {
    let d = (t.aliasSymbol ?? t.symbol)?.declarations?.[0];
    if (d && ts.isEnumMember(d)) d = d.parent;
    return d && ts.isEnumDeclaration(d) ? d : null;
  };
  const isScalar = (t: ts.Type) => !isOptionT(t) && (!!(t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Void | ts.TypeFlags.Never)) || !!enumDeclOf(t) || !!litsOf(t));
  // A method takes `&mut self` when it writes through `this`, and a parameter is `&mut` when the
  // body writes through it, calls a mutating method on it, or hands it to a `&mut` parameter.
  // One fixpoint: each answer feeds the others.
  const mutating = new Set<ts.Node>();
  const mutParams = new Map<ts.Node, Set<number>>();
  // A for-of whose body writes through the loop variable (or hands it to something that does) iterates `&mut`,
  // which also makes the iterated array mutated.
  const forOfMutates = (f: ts.ForOfStatement): boolean => {
    const dl = f.initializer;
    const sym = ts.isVariableDeclarationList(dl) && ts.isIdentifier(dl.declarations[0].name) ? checker.getSymbolAtLocation(dl.declarations[0].name) : undefined;
    if (!sym) return false;
    const rooted = (r: ts.Expression) => ts.isIdentifier(r) && checker.getSymbolAtLocation(r) === sym;
    let yes = false;
    walkBody(f.statement, (n) => {
      const w = writes(n);
      if (w && rooted(w)) yes = true;
      if (ts.isCallExpression(n)) {
        const d = declOf(n);
        if (d && mutating.has(d) && ts.isPropertyAccessExpression(n.expression) && rooted(rootOf(n.expression.expression))) yes = true;
        const mp = d && mutParams.get(d);
        if (mp) n.arguments.forEach((a, j) => { if (mp.has(j) && rooted(rootOf(a))) yes = true; });
      }
      if (ts.isForOfStatement(n) && rooted(rootOf(n.expression)) && forOfMutates(n)) yes = true;
    });
    return yes;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of allFns) {
      const symIdx = new Map<ts.Symbol, number>();
      fn.parameters.forEach((p, i) => { const s = checker.getSymbolAtLocation(p.name); if (s) symIdx.set(s, i); });
      const hitRoot = (r: ts.Expression) => {
        if (r.kind === ts.SyntaxKind.ThisKeyword) {
          if (ts.isMethodDeclaration(fn) && !mutating.has(fn)) { mutating.add(fn); changed = true; }
          return;
        }
        const s = ts.isIdentifier(r) ? checker.getSymbolAtLocation(r) : undefined;
        const i = s && symIdx.get(s);
        if (i === undefined || i === null || isScalar(checker.getTypeAtLocation(fn.parameters[i]))) return;
        const set = mutParams.get(fn) ?? new Set<number>();
        if (!set.has(i)) { set.add(i); mutParams.set(fn, set); changed = true; }
      };
      walkBody(fn.body!, (n) => {
        const w = writes(n);
        if (w) hitRoot(w);
        if (ts.isForOfStatement(n) && forOfMutates(n)) hitRoot(rootOf(n.expression));
        if (ts.isCallExpression(n)) {
          const d = declOf(n);
          if (d && mutating.has(d) && ts.isPropertyAccessExpression(n.expression)) hitRoot(rootOf(n.expression.expression));
          const mp = d && mutParams.get(d);
          if (mp) n.arguments.forEach((a, j) => { if (mp.has(j)) hitRoot(rootOf(a)); });
        }
      });
    }
  }

  // 3. Emit.
  const symDeclFile = (sym: ts.Symbol | undefined): string | undefined => {
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations?.[0]?.getSourceFile().fileName;
  };

  // src/ast.ts: Milo types and a decoder from its interfaces and tagged unions; no functions.
  let astForeign: { file: string; name: string }[] = [];
  const astModel = buildAstModel(program, checker, astFile ? [astFile, ...files.filter((f) => f !== astFile)] : files);
  // Types no translated code ever writes into: a clone of one cannot be told from the shared TS reference.
  const neverWritten = buildImmutability(program, checker, files);


  // Emitted before any function: sizing the variant structs boxes fields, and reads of a boxed
  // field in the functions must deref.
  if (astFile) {
    if (!opts.astRoots?.length) throw new Unsupported("ts2milo: src/ast.ts given without --ast-root");
    const litName = (t: ts.TypeNode) => {
      const lits = litsOf(checker.getTypeFromTypeNode(t));
      const u = lits && litUnions.get(unionKey(lits));
      return u ? { name: u.name, lits: u.lits, file: u.file } : null;
    };
    // The AST fields the input files read (a union property read names every variant's declaration).
    const used = new Set<ts.Node>();
    // TS2MILO_AST_ALL_FIELDS=1 carries every field (what a checker that reads the whole tree needs): a probe of whether the full AST builds.
    if (process.env.TS2MILO_AST_ALL_FIELDS || opts.lenient) for (const d of astModel.ifaces.values()) for (const m of d.members) used.add(m);
    for (const f of files) if (f !== astFile) {
      const visitUse = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n)) for (const d of checker.getSymbolAtLocation(n.name)?.declarations ?? []) if (ts.isPropertySignature(d)) used.add(d);
        ts.forEachChild(n, visitUse);
      };
      visitUse(program.getSourceFile(f)!);
    }
    // --lenient: every AST type is a root (the parser builds kinds Program alone does not reach).
    const roots = opts.lenient ? [...new Set([...opts.astRoots, ...astModel.ifaces.keys()])] : opts.astRoots;
    const kindEnum = (u: { name: string; variants: { kind: string }[] }) => {
      const lits = u.variants.map((v) => v.kind);
      let e = litUnions.get(unionKey(lits));
      if (!e) { e = { name: `${u.name}Kind`, lits, file: astFile }; litUnions.set(unionKey(lits), e); }
      return e;
    };
    const em = emitAst(checker, astModel, astFile, roots, litName, modOf, used, kindEnum, !!opts.lenient);
    astForeign = em.foreign;
    report.files.set("ast.milo", em.types);
    // The JSON decoder serves the per-pass differential drivers, each transpiling only its own pass. The whole
    // frontend (--lenient over every file) parses source and never decodes a dump, and its decoder would have to
    // tell apart same-named types of different passes (two BodyTask), which the name-keyed model cannot.
    report.files.set("ast_decode.milo", em.decoder);
    if (opts.lenient) report.files.set("ast_encode.milo", em.encoder);
    report.ast = { types: em.typeNames.length, dropped: em.dropped, sizeBoxed: em.sizeBoxed };
  }

  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    if (file === astFile && !opts.lenient) continue;
    const isAst = file === astFile; // ast.ts: only its functions and consts (types come from emitAst) are appended to ast.milo
    const imports = new Map<string, Set<string>>();
    const use = (mod: string, name: string) => { if (!imports.has(mod)) imports.set(mod, new Set()); imports.get(mod)!.add(name); };
    const useRuntime = (name: string, at?: ts.Node) => {
      if (!runtimeNames.has(name)) fail(at ?? sf, `runtime has no '${name}' (scripts/ts2milo/runtime.milo)`);
      use(RUNTIME_MOD, name);
      return name;
    };
    // A name declared elsewhere: another input file, or the hand-written runtime.
    const useDeclared = (name: string, declFile: string | undefined, at: ts.Node) => {
      if (dead.has(`${declFile ?? file}::${name}`)) throw new Unsupported(`${name} is itself a stub`);
      if (!declFile || declFile === file) return name;
      if (RUNTIME_OWNED.has(name) && declFile === astFile) use(RUNTIME_MOD, name);
      else if (inputSet.has(declFile)) use(modOf(declFile), name);
      else return useRuntime(RUNTIME_RENAMES[name] ?? name, at);
      return name;
    };
    const std = (name: string) => { use(STD_MODULES[name], name); return name; };
    if (isAst) { for (const f of astForeign) use(modOf(f.file), f.name); }
    const out: string[] = [];
    let ind = 0;
    const line = (s: string) => out.push("    ".repeat(ind) + s);

    // Per-function state.
    let scopes: Map<ts.Symbol, string>[] = [];
    let usedNames: Set<string>[] = [];
    let curFn: ts.FunctionLikeDeclaration | null = null;
    let mutated = new Set<ts.Symbol>();
    const symOf = (id: ts.Identifier) => (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id));
    const declareLocal = (sym: ts.Symbol, base: string) => {
      let name = safeId(base);
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
    const onCycle = (t: ts.Type): boolean => {
      const tu = unionOfType(checker, t);
      if (tu) return astModel.cyclic.has(tu.name);
      const d = t.symbol?.declarations?.[0];
      return !!d && ts.isInterfaceDeclaration(d) && astModel.cyclic.has(d.name.text);
    };
    // An element stored into a Vec<Heap<T>> (T on a cycle) is boxed on the way in.
    const heapElem = (el: ts.Type, code: string): string => (onCycle(isOptionT(el) ? checker.getNonNullableType(el) : el) && !isOptionT(el) ? `Heap(${code})` : code);
    // An element of a Vec<Option<Heap<T>>> (T on a cycle): Some(Heap(x)) for a plain T, optBox for an Option<T>, None for null/undefined.
    const optHeapElem = (el: ts.Type, arg: ts.Expression): string | undefined => {
      if (!isOptionT(el) || !onCycle(checker.getNonNullableType(el))) return undefined;
      const nn = checker.getNonNullableType(el);
      const u = unparen(arg);
      if (isUndefinedId(u) || u.kind === ts.SyntaxKind.NullKeyword) return "Option.None";
      if (isOptionT(tOf(arg))) return `${useRuntime("optBox", arg)}<${ty(nn, arg)}>(${ownConv(arg, el)})`;
      return `Option.Some(Heap(${ownConv(arg, nn)}))`;
    };
    // Whether `e` reads an array element held as Heap<T> (see `ty`).
    const boxedElem = (e: ts.Expression): boolean => ts.isElementAccessExpression(e) && checker.isArrayType(tOf(e.expression)) && onCycle(checker.getNonNullableType(checker.getTypeArguments(tOf(e.expression) as ts.TypeReference)[0]));
    let opaqueFallback = false; // lenient signatures: a type with no mapping becomes TsOpaque so the function still exists for importers
    const ty = (t: ts.Type, at: ts.Node): string => {
      try { return ty0(t, at); } catch (e) { if (opaqueFallback && e instanceof Unsupported) return useRuntime("TsOpaque", at); throw e; }
    };
    // Keys with identity but no node id (arrays, Maps, Sets, object, unknown): Milo has no hash for them.
    const unhashableKey = (k: ts.Type, at: ts.Node) => {
      const kn = checker.getNonNullableType(k);
      if (checker.isArrayType(kn) || isKeyedContainer(kn) || (kn.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive))) fail(at, `Map/Set key of type ${checker.typeToString(k)} (identity of a non-node value: needs a hidden id wrapper)`);
    };
    const ty0 = (t: ts.Type, at: ts.Node): string => {
      if (isOptionT(t)) { hit("T | undefined", "Option<T>"); return `Option<${ty(checker.getNonNullableType(t), at)}>`; }
      const ed = enumDeclOf(t);
      if (ed) return useDeclared(ed.name.text, ed.getSourceFile().fileName, at);
      const tu = unionOfType(checker, t);
      if (tu) { hit("tagged union", "enum with one struct-carrying variant per kind"); return useDeclared(tu.name, tu.decl.getSourceFile().fileName, at); }
      if (t.symbol?.name === "Map" || t.symbol?.name === "ReadonlyMap" || t.symbol?.name === "WeakMap") {
        const [k, v] = checker.getTypeArguments(t as ts.TypeReference);
        if (nodeKeyOf(checker, k)) { hit("Map keyed by a node", "HashMap<i64, V> keyed by the node id"); return `HashMap<i64, ${ty(v, at)}>`; }
        if (enumDeclOf(k)) { hit("Map keyed by an enum", "HashMap<string, V> keyed by Enum_value"); return `HashMap<string, ${ty(v, at)}>`; }
        unhashableKey(k, at);
        hit("Map<K, V>", "HashMap<K, V>");
        return `HashMap<${ty(k, at)}, ${ty(v, at)}>`;
      }
      if (t.flags & ts.TypeFlags.Boolean || t.flags & ts.TypeFlags.BooleanLiteral) return "bool";
      if (t.flags & ts.TypeFlags.NumberLike) return "i64";
      if (litsOf(t)) { const u = resolveUnion(t, at); return useDeclared(u.name, u.file, at); }
      if (t.flags & ts.TypeFlags.StringLike) return "string";
      if (t.flags & ts.TypeFlags.Void) return "void";
      if (t.flags & ts.TypeFlags.Never) return "never";
      if (checker.isArrayType(t)) {
        // An element on a type cycle is a Heap<T>: inlined, the type text grows with every level of nesting.
        const el = checker.getTypeArguments(t as ts.TypeReference)[0];
        const core = isOptionT(el) ? checker.getNonNullableType(el) : el;
        const inner = onCycle(core) ? `Heap<${ty(core, at)}>` : ty(core, at);
        return `Vec<${isOptionT(el) ? `Option<${inner}>` : inner}>`;
      }
      if (t.symbol?.name === "Set" || t.symbol?.name === "ReadonlySet" || t.symbol?.name === "WeakSet") {
        const k = checker.getTypeArguments(t as ts.TypeReference)[0];
        if (nodeKeyOf(checker, k)) { hit("Set keyed by a node", "HashSet<i64> of node ids"); return `${std("HashSet")}<i64>`; }
        if (enumDeclOf(k)) { hit("Set keyed by an enum", "HashSet<string> of Enum_value"); return `${std("HashSet")}<string>`; }
        unhashableKey(k, at);
        return `${std("HashSet")}<${ty(k, at)}>`;
      }
      const d = t.symbol?.declarations?.[0];
      if (d && (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d))) return useDeclared(d.name!.text, d.getSourceFile().fileName, at);
      const anon = d && ts.isTypeLiteralNode(d) ? anonStructs.get(d) : undefined;
      if (anon) { hit("inline object type", "generated struct named from where it is written"); return useDeclared(anon.name, anon.file, at); }
      if (d && ts.isObjectLiteralExpression(d)) { const inf = inferredStructOf(t); return useDeclared(inf.name, inf.file, at); }
      return fail(at, `type ${checker.typeToString(t)}`);
    };
    // Properties of an inferred object type with their Milo field types. A field with no mapping names itself in the refusal.
    const inferredFields = (t: ts.Type, d: ts.Node) => checker.getPropertiesOfType(t).map((p) => {
      const ft = checker.getTypeOfSymbolAtLocation(p, d);
      try { return { name: p.name, t: ft, milo: ty(ft, d) }; }
      catch (err) {
        if (err instanceof Unsupported) throw new Unsupported(`inferred object literal type: field '${p.name}' has no mapping (${err.message})`);
        throw err;
      }
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Mapping a field type for the key must not leave imports behind: this file may only reference the struct, not its fields' types.
    const shapeOf = (t: ts.Type, d: ts.Node) => {
      const saved = [...imports].map(([m, names]) => [m, new Set(names)] as const);
      try {
        const fields = inferredFields(t, d);
        return { fields, key: fields.map((f) => `${f.name}:${f.milo}`).join(",") };
      } finally {
        imports.clear();
        for (const [m, names] of saved) imports.set(m, names);
      }
    };
    const inferredStructOf = (t: ts.Type): InferredStruct => {
      const decl = t.symbol.declarations![0];
      const { fields, key } = shapeOf(t, decl);
      const known = inferredStructs.get(key);
      if (known) return known;
      // A written type literal of the same shape is the same TS type, so a value of one must be accepted where the other is expected.
      for (const [node, a] of anonStructs) {
        if (a.dup) continue;
        let k: string;
        try { k = shapeOf(checker.getTypeFromTypeNode(node as ts.TypeNode), node).key; } catch (err) { if (err instanceof Unsupported) continue; throw err; }
        if (k === key) { const rec = { ...a, at: decl }; inferredStructs.set(key, rec); return rec; }
      }
      hit("inferred object literal type", "generated struct keyed by its field names and types");
      const rec: InferredStruct = { name: freshName(nameFrom(decl)), file, emitted: false, fields: fields.map((f) => ({ name: f.name, t: f.t })), at: decl };
      inferredStructs.set(key, rec);
      return rec;
    };
    const defaultOf = (t: ts.Type, at: ts.Node): string => {
      if (t.flags & ts.TypeFlags.NumberLike) return "0";
      if (t.flags & ts.TypeFlags.StringLike) return `""`;
      if (t.flags & ts.TypeFlags.BooleanLike) return "false";
      // `let x: T | undefined;` starts undefined in TS: a typed None (a bare Option.None has no inferable payload).
      if (isOptionT(t)) return `${useRuntime("optNone", at)}<${ty(checker.getNonNullableType(t), at)}>()`;
      // A non-optional array: TS definite assignment (strict) rejects any read before every path has assigned it, so the
      // empty Vec is never observed. A closure could read it before the assignment runs, and TS does not check that.
      if (checker.isArrayType(t) && ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && !readInNestedFn(at)) { hit("declaration without initializer", "empty Vec: TS definite assignment guarantees it is overwritten before any read"); return "Vec.new()"; }
      return fail(at, `declaration without initializer of type ${checker.typeToString(t)}`);
    };
    const readInNestedFn = (d: ts.VariableDeclaration): boolean => {
      const sym = checker.getSymbolAtLocation(d.name as ts.Identifier);
      let fn: ts.Node = d;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      let found = false;
      const walk = (n: ts.Node, nested: boolean) => {
        if (found) return;
        if (nested && ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) { found = true; return; }
        ts.forEachChild(n, (c) => walk(c, nested || (ts.isFunctionLike(c) && c !== fn)));
      };
      if (fn) walk(fn, false);
      return found;
    };

    // ---- expressions ----
    const tOf = (e: ts.Node) => checker.getTypeAtLocation(e);
    const isStr = (e: ts.Node) => !!(tOf(e).flags & ts.TypeFlags.StringLike) && !litsOf(tOf(e)) && !enumDeclOf(tOf(e));
    const isNum = (e: ts.Node) => !!(tOf(e).flags & ts.TypeFlags.NumberLike);
    const isUndefinedId = (e: ts.Expression) => ts.isIdentifier(e) && e.text === "undefined";
    // A value of a string-literal union is an enum in Milo; used as text (`+`, template span) it reads through Name_value.
    const textOf = (x: ts.Expression): string => {
      const u0 = unparen(x);
      const t = tOf(x);
      // A TS string enum is text through its generated Name_value (`"x" + tok.kind`).
      const ed = enumDeclOf(t);
      if (ed && !isOptionT(t)) return `${useDeclared(`${ed.name.text}_value`, ed.getSourceFile().fileName, x)}(${ex(x)})`;
      if (ts.isStringLiteral(u0) || ts.isNoSubstitutionTemplateLiteral(u0) || !litsOf(t) || ed || isOptionT(t)) return ex(x);
      // Only a place or call typed by a declaration holds an enum; a ternary of literals is emitted as text.
      let declT: ts.Type | undefined;
      if (ts.isIdentifier(u0) || ts.isPropertyAccessExpression(u0)) { const sy = checker.getSymbolAtLocation(ts.isIdentifier(u0) ? u0 : u0.name); declT = sy && checker.getTypeOfSymbol(sy); }
      else if (ts.isCallExpression(u0)) { const sg = checker.getResolvedSignature(u0); declT = sg && checker.getReturnTypeOfSignature(sg); }
      if (!declT || !litsOf(checker.getNonNullableType(declT))) return ex(x);
      const u = resolveUnion(t, x);
      if (u.file === astFile) return fail(x, `text of ${u.name}, a union of ast.ts`);
      return `${useDeclared(`${u.name}_value`, u.file, x)}(${ex(x)})`;
    };
    // JS truthiness of a non-boolean (subset.ts truthyHandled). The value is evaluated once.
    const truthText = (k: "str" | "num" | "optBool", code: string) =>
      k === "str" ? `(${useRuntime("jsLen", sf)}(${code}) != 0)` : k === "num" ? `(${code} != 0)` : code;
    // An enum-typed operand where a js string is wanted (`"x" + tok.kind`): its string value.
    const cond = (e: ts.Expression): string => {
      // Outside the subset's narrowing positions (lenient only), an optional is still tested, just not narrowed.
      const ue = unparen(e);
      const logical = ts.isBinaryExpression(ue) && (ue.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || ue.operatorToken.kind === ts.SyntaxKind.BarBarToken);
      const k = truthyHandled(checker, e) ?? (inCondPos(e) && !logical ? truthyKind(tOf(e)) : null);
      if (!k && ts.isBinaryExpression(ue) && (ue.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || ue.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return ex(e);
      if (!k) {
        // Only a boolean may stand where the output wants one: an optional or struct value is not one.
        const t = tOf(e), tk = truthyKind(t);
        if (tk && tk !== "str" && tk !== "num") {
          // Outside an if guard nothing is bound to the payload, so the test is a match yielding the bool.
          hit("truthiness", "optional value: match on Some, payload tested by its own truthiness");
          const v = fresh("v");
          const body = tk === "opt" ? "true" : tk === "optBool" ? v : tk === "optStr" ? truthText("str", v) : truthText("num", v);
          return `(match ${ex(e)} { Option.Some(${tk === "opt" ? "_" : v}) => ${body}, Option.None => false })`;
        }
        if (!t.isUnion() && t.flags & ts.TypeFlags.Object) {
          if (!sideEffectFree(e)) return fail(e, "truthiness of a non-null struct with side effects");
          return "true";
        }
        return ex(e);
      }
      if (k === "str" || k === "num") { hit("truthiness", "string: jsLen != 0, number: != 0"); return truthText(k, ex(e)); }
      // An optional outside an if-guard binding: only the test, the place is not narrowed.
      const v = fresh("v");
      const pay = k === "optStr" ? truthText("str", v) : k === "optNum" ? truthText("num", v) : k === "optBool" ? v : "true";
      hit("optional truthiness", "match on Some / None");
      return k === "opt" ? `${ex(e)}.isSome()` : `(match ${ex(e)} { Option.Some(${v}) => ${pay}, Option.None => false })`;
    };

    // Narrowing. Inside `if (x.kind === "K")` the guarded expression reads as the variant's struct,
    // and inside `if (p !== undefined)` as the Option's payload; both are bound by an `if let`.
    // Keyed by source text, so a path like `e.args[i]` narrows as a whole.
    // The id of a node value: a union reads it through `U_id(&u)`, a struct has the field.
    const idEx = (x: ts.Expression, k0: NodeKey): string => {
      // A guard-narrowed place is bound to the variant's payload struct; any other place holds the declared union.
      const gu = narrow.has(x.getText()) ? null : guardUnion(checker, x);
      const k: NodeKey = gu ? { name: gu.name, union: gu } : nodeKeyOf(checker, tOf(x)) ?? k0;
      return idOf(x, k);
    };
    const idOf = (x: ts.Expression, k: NodeKey): string => k.union ? `${useDeclared(`${k.name}_${ID_FIELD}`, k.union.decl.getSourceFile().fileName, x)}(${ex(x)})` : `${ex(x)}.${ID_FIELD}`;
    // The key argument of a Map/Set call: the node id when the container is keyed by nodes.
    const keyEx = (recv: ts.Expression, arg: ts.Expression, own = false): string => {
      const rt = checker.getNonNullableType(tOf(recv)); // `a?.map.get(k)`: the receiver is `Map | undefined`
      const k = nodeKeyOfContainer(checker, rt);
      if (!k) { const ed = enumDeclOf(checker.getTypeArguments(rt as ts.TypeReference)[0]); if (ed) return `${useDeclared(`${ed.name.text}_value`, ed.getSourceFile().fileName, arg)}(${ex(arg)})`; }
      return k ? idEx(arg, k) : own ? ownConv(arg, checker.getTypeArguments(rt as ts.TypeReference)[0]) : ex(arg);
    };
    const narrow = new Map<string, { name: string; deref: boolean }>();
    // Locals bound by `for (const x of array)` over boxed elements: each reads as `*x`.
    const elemBoxed = new Set<ts.Symbol>();
    const fresh = (text: string) => {
      const ids = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
      const base = ids ? ids[ids.length - 1] : "v";
      let name = safeId(base);
      for (let i = 2; usedNames.some((s) => s.has(name)); i++) name = `${base}_${i}`;
      usedNames[usedNames.length - 1].add(name);
      return name;
    };
    // A value read out of a place that is not Copy would be a move out of a borrow: it is cloned
    // wherever the result is owned (a struct field, a push, a let, a return, a by-value parameter).
    const isPlace = (e: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      // A common field of a tagged union is read by an accessor call, which returns an owned value.
      if (ts.isPropertyAccessExpression(e) && unionOfType(checker, tOf(e.expression)) && !narrow.has(e.expression.getText())) return false;
      return ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e);
    };
    const isCopyT = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) || !!enumDeclOf(t) || !!litsOf(t);
    // A local whose last read (in source order, with no loop between it and its declaration) is this one:
    // the value is moved, which is what TS sharing amounts to when nothing reads the place afterwards.
    const isLastUseLocal = (e0: ts.Expression): boolean => {
      let e = e0;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      // `x.f` of an owned local `x` is a partial move: the last use of that field when no later read of `x` names `f` or `x` whole.
      let field: string | undefined;
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) { field = e.name.text; e = e.expression; }
      if (!ts.isIdentifier(e)) return false;
      const id = e;
      // A shorthand property `{ xs }` names the variable through its own symbol lookup.
      const symOf = (n: ts.Identifier) => ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
      const sy = symOf(id);
      const d = sy?.declarations?.[0];
      // A constructor parameter is owned (the constructor takes its arguments by value): its last mention in the body moves it.
      if (sy && d && sy.declarations?.length === 1 && ts.isParameter(d) && ts.isConstructorDeclaration(d.parent) && d.parent.body && !field) {
        let after = false, inLoop = false;
        for (let q: ts.Node | undefined = id.parent; q && q !== d.parent; q = q.parent) if (ts.isIterationStatement(q, false)) inLoop = true;
        const scan = (n: ts.Node) => { if (ts.isIdentifier(n) && n !== id && n.pos >= id.end && symOf(n) === sy) after = true; ts.forEachChild(n, scan); };
        scan(d.parent.body);
        return !after && !inLoop;
      }
      if (!sy || sy.declarations?.length !== 1 || !d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name)) return false;
      const dl = d.parent;
      if (!ts.isVariableDeclarationList(dl) || ts.isForOfStatement(dl.parent) || ts.isForInStatement(dl.parent)) return false;
      const fnOf = (n: ts.Node) => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return undefined; };
      if (fnOf(id) !== fnOf(d)) return false;
      // `x = { ...x... }`: the old value dies in the assignment, so reading it there is its last use wherever the assignment sits.
      let selfAssign: ts.Node | undefined;
      for (let p: ts.Node | undefined = id.parent; p && !ts.isFunctionLike(p) && !ts.isStatement(p); p = p.parent) {
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left) && symOf(p.left) === sy && id.pos >= p.right.pos && id.end <= p.right.end) { selfAssign = p; break; }
      }
      for (let p: ts.Node | undefined = id.parent; !selfAssign && p && p !== dl.parent.parent; p = p.parent) {
        if (ts.isIterationStatement(p, false) && !(d.pos >= p.pos && d.end <= p.end)) return false;
      }
      let scope: ts.Node = d.getSourceFile();
      for (let p: ts.Node = d; p.parent; p = p.parent) if (ts.isBlock(p.parent) || ts.isCaseClause(p.parent) || ts.isDefaultClause(p.parent)) { scope = p.parent; break; }
      // Inside a `return` nothing after the statement runs: only the rest of that expression can read the place again.
      for (let p: ts.Node | undefined = id.parent; p && !ts.isFunctionLike(p); p = p.parent) if (ts.isReturnStatement(p)) { scope = p; break; }
      if (selfAssign) scope = selfAssign;
      // A block that ends in a return: nothing outside it runs after this read.
      let limit = Infinity;
      for (let p: ts.Node | undefined = id.parent; p && !ts.isFunctionLike(p) && p !== scope; p = p.parent) {
        if (ts.isBlock(p) && p.statements.length > 0 && ts.isReturnStatement(p.statements[p.statements.length - 1])) { limit = p.end; break; }
      }
      // `{ target: x, span: x.span }`: the literal's fields are emitted reads-first (moveOrder), so that read is not after the move.
      const lit = (() => { for (let p: ts.Node | undefined = id.parent; p && !ts.isFunctionLike(p); p = p.parent) if (ts.isObjectLiteralExpression(p)) return p; return undefined; })();
      const siblingFieldRead = (n: ts.Node) => !!lit && n.pos >= lit.pos && n.end <= lit.end && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && (ts.isPropertyAssignment(id.parent) || ts.isShorthandPropertyAssignment(id.parent)) && id.parent.parent === lit;
      // A read in the else arm never follows one in the then arm of the same if.
      const inOtherBranch = (n: ts.Node) => {
        for (let p: ts.Node | undefined = id.parent; p && !ts.isFunctionLike(p); p = p.parent) {
          if (ts.isIfStatement(p) && p.elseStatement && id.pos >= p.thenStatement.pos && id.end <= p.thenStatement.end && n.pos >= p.elseStatement.pos && n.end <= p.elseStatement.end) return true;
          // Likewise the two arms of a ternary: only one is evaluated.
          if (ts.isConditionalExpression(p) && id.pos >= p.whenTrue.pos && id.end <= p.whenTrue.end && n.pos >= p.whenFalse.pos && n.end <= p.whenFalse.end) return true;
        }
        return false;
      };
      let later = false;
      const walk = (n: ts.Node) => {
        if (later) return;
        if (ts.isIdentifier(n) && n !== id && n.text === id.text && n.pos >= id.end && n.pos < limit && !siblingFieldRead(n) && !(field !== undefined && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.name.text !== field) &&!inOtherBranch(n) && symOf(n) === sy) later = true;
        ts.forEachChild(n, walk);
      };
      walk(scope);
      return !later;
    };
    const needsClone = (e: ts.Expression) => isPlace(e) && !(multiErr && ts.isPropertyAccessExpression(e) && isCatchVar(e.expression)) && !isCopyT(tOf(e)) && !isLastUseLocal(e);
    const anonFieldTypes = (t: ts.Type, d: ts.Node): ts.Type[] => checker.getPropertiesOfType(t).map((p) => checker.getTypeOfSymbolAtLocation(p, d));
    // A value of a recursive AST type: its clone is only safe where the copy is never mutated.
    const isRecursiveT = (t: ts.Type): boolean => {
      if (isCopyT(t)) return false;
      if (isOptionT(t)) return isRecursiveT(checker.getNonNullableType(t));
      if (checker.isArrayType(t)) return isRecursiveT(checker.getTypeArguments(t as ts.TypeReference)[0]);
      const tu = unionOfType(checker, t);
      if (tu) return astModel.recursive.has(tu.name);
      const d = t.symbol?.declarations?.[0];
      if (d && ((ts.isTypeLiteralNode(d) && anonStructs.has(d)) || ts.isObjectLiteralExpression(d))) return anonFieldTypes(t, d).some(isRecursiveT);
      return !!d && ts.isInterfaceDeclaration(d) && astModel.recursive.has(d.name.text);
    };
    let roDest = false;
    // The call whose borrowed argument is being converted: a copy made only to be passed by reference dies with the call.
    let argRegion: ts.Node | undefined;
    const cloneFail = (n: ts.Node, t: ts.Type, ro = false, region?: ts.Node): void => {
      if (!canClone(t)) fail(n, `a value of type ${checker.typeToString(t)} copied out of a borrowed place: the type is a class, so it has no Clone; use the place itself`);
      if (!isRecursiveT(t)) return;
      if (!ro && !neverWritten(t, n, region)) fail(n, `a value of type ${checker.typeToString(t)} copied out of a borrowed place: copy of a recursive value that is mutated afterwards, or whose destination is not known to be read-only`);
      report.recursiveClones++;
    };
    const canClone = (t: ts.Type): boolean => {
      if (isCopyT(t)) return true;
      if (isOptionT(t)) return canClone(checker.getNonNullableType(t));
      if (checker.isArrayType(t)) return canClone(checker.getTypeArguments(t as ts.TypeReference)[0]);
      if (t.symbol?.name === "Set" || t.symbol?.name === "ReadonlySet" || t.symbol?.name === "Map") return true;
      const tu = unionOfType(checker, t);
      if (tu) return astModel.cloneable.has(tu.name);
      const d = t.symbol?.declarations?.[0];
      // A generated struct for an object type literal derives Clone; it clones when every field does.
      if (d && ((ts.isTypeLiteralNode(d) && anonStructs.has(d)) || ts.isObjectLiteralExpression(d))) return anonFieldTypes(t, d).every(canClone);
      // Interfaces the runtime declares by hand (@derive(Clone) in runtime.milo).
      if (d && ts.isInterfaceDeclaration(d) && RUNTIME_CLONEABLE.has(d.name.text)) return true;
      return !!d && ts.isInterfaceDeclaration(d) && astModel.cloneable.has(d.name.text);
    };
    // A method tagged `@consumesThis` ends in `return { f: this.f, ... }`: the generated Milo takes each such field out of
    // self (builtin `replace`, leaving an empty value) instead of cloning it, because nothing reads self after the return.
    // The TypeScript source keeps both; a TS caller that reads the object after the call has no generated counterpart.
    const takeFromThis = (e: ts.Expression, s: string): string | null => {
      const u = unparen(e);
      if (!curFn || !ts.isPropertyAccessExpression(u) || u.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
      if (!ts.getJSDocTags(curFn).some((tg) => tg.tagName.text === "consumesThis")) return null;
      const ret = u.parent && ts.isPropertyAssignment(u.parent) && ts.isObjectLiteralExpression(u.parent.parent) && ts.isReturnStatement(u.parent.parent.parent) ? u.parent.parent : null;
      if (!ret || ret.parent.parent !== curFn.body) return null;
      // A sibling property reading the same field would see it already taken.
      let twice = 0;
      const scan = (n: ts.Node) => { if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword && n.name.text === u.name.text) twice++; ts.forEachChild(n, scan); };
      scan(ret);
      if (twice !== 1) return null;
      const m = ty(tOf(e), e);
      const empty = m.startsWith("Vec<") ? "Vec.new()" : m.startsWith("HashMap<") ? "HashMap.new()" : m.startsWith("HashSet<") ? "HashSet.new()" : m.startsWith("Option<") ? "Option.None" : null;
      if (empty === null) return null;
      hit("take a field out of self on return", "builtin replace(self.f, empty)");
      return `replace(${s}, ${empty})`;
    };
    // Ternaries whose value is taken by value: each branch is then an owned value (a borrowed place is cloned).
    const ownBranches = new Set<ts.Node>();
    const isBoxedOptField = (e: ts.Expression): boolean => {
      if (ts.isElementAccessExpression(e)) return isOptionT(tOf(e)) && boxedElem(e);
      if (!ts.isPropertyAccessExpression(e) || !isOptionT(tOf(e)) || unionOfType(checker, tOf(e.expression))) return false;
      const d = checker.getSymbolAtLocation(e.name)?.declarations?.[0];
      return !!d && ts.isPropertySignature(d) && astModel.boxed.has(d);
    };
    let heapOptParam: (p: ts.ParameterDeclaration) => boolean = () => false;
    const conv = (e: ts.Expression, want?: ts.Type, own = false): string => {
      // The read-only flag belongs to this value only, never to the expressions nested inside it.
      const ro = roDest;
      roDest = false;
      const region = argRegion;
      argRegion = undefined;
      const owned = (s: string, force = false) => {
        if (!(own || force) || !needsClone(e)) return s;
        const taken = takeFromThis(e, s);
        if (taken) return taken;
        // A local annotated with a union is that union in Milo even where TS has narrowed this read to one variant.
        const sy = ts.isIdentifier(unparen(e)) ? symOf(unparen(e) as ts.Identifier) : undefined;
        const declared = sy && sy.valueDeclaration && ts.isVariableDeclaration(sy.valueDeclaration) && sy.valueDeclaration.type ? checker.getTypeOfSymbol(sy) : undefined;
        cloneFail(e, declared && unionOfType(checker, declared) ? declared : tOf(e), ro, force ? region : undefined);
        return `${s}.clone()`;
      };
      // A boxed optional field is an Option<Heap<T>> in Milo; anywhere an Option<T> is wanted it
      // is unboxed (a copy, as reading through a Heap must be).
      // (Not a tagged union common field: its accessor already returns the unboxed Option.)
      if (want && isOptionT(want) && isOptionT(tOf(e)) && ts.isPropertyAccessExpression(e) && !unionOfType(checker, tOf(e.expression))) {
        const d = checker.getSymbolAtLocation(e.name)?.declarations?.[0];
        if (d && ts.isPropertySignature(d) && astModel.boxed.has(d)) {
          hit("boxed optional field", "Option<Heap<T>> passed as Option<T> through optUnbox<T>");
          return `${useRuntime("optUnbox", e)}<${ty(checker.getNonNullableType(tOf(e)), e)}>(${ex(e)})`;
        }
      }
      // A parameter retyped to Option<Heap<T>> (heapOptParam) is unboxed the same way where it is
      // handed on to something that wants the plain Option<T>.
      if (want && isOptionT(want) && isOptionT(tOf(e)) && ts.isIdentifier(e)) {
        const d = symOf(e)?.valueDeclaration;
        if (d && ts.isParameter(d) && heapOptParam(d)) {
          hit("boxed optional field", "Option<Heap<T>> parameter passed on as Option<T> through optUnbox<T>");
          return `${useRuntime("optUnbox", e)}<${ty(checker.getNonNullableType(tOf(e)), e)}>(${ex(e)})`;
        }
      }
      if (want && isOptionT(want) && !isOptionT(tOf(e))) {
        if (isUndefinedId(e) || e.kind === ts.SyntaxKind.NullKeyword) return `${useRuntime("optNone", e)}<${ty(checker.getNonNullableType(want), e)}>()`;
        // Option.Some(x) takes x by value even where the argument itself is only borrowed.
        return `Option.Some(${owned(ex(e, checker.getNonNullableType(want)), true)})`;
      }
      // A member of a union of unions where the union is wanted (an Expr for a Node) is wrapped in its variant.
      const wu = want && !isOptionT(want) ? unionOfType(checker, want) : null;
      if (wu?.members) {
        const et = tOf(e);
        const eu = unionOfType(checker, et);
        if (eu?.name !== wu.name) {
          const edecl = et.symbol?.declarations?.[0];
          const m = wu.members.find((x) => (eu ? x.name === eu.name : !!edecl && ts.isInterfaceDeclaration(edecl) && x.name === edecl.name.text));
          if (!m) fail(e, `a value of type ${checker.typeToString(et)} is not a member of the union of unions ${wu.name}`);
          hit("union of unions member as the union", "wrapped in the member's variant");
          return `${useDeclared(wu.name, wu.decl.getSourceFile().fileName, e)}.${m!.name}(${owned(ex(e), true)})`;
        }
      }
      // A value typed as one variant's interface (`const c: ClosureExpr = {...}; return c`) where its union is wanted: wrapped in that variant.
      if (wu && !wu.members && !ts.isObjectLiteralExpression(unparen(e)) && !unionOfType(checker, tOf(e))) {
        // The DECLARED type must be the variant: a narrowed union member (`x.kind === "BinOp"`) is still the union in Milo.
        const ue = unparen(e);
        const dsym = ts.isIdentifier(ue) ? symOf(ue) : undefined;
        const dt = dsym && dsym.valueDeclaration ? checker.getTypeOfSymbol(dsym) : undefined;
        const vd = dt && dt === tOf(e) ? dt.symbol?.declarations?.[0] : undefined;
        const v = vd && ts.isInterfaceDeclaration(vd) ? wu.variants.find((x) => x.name === vd.name.text) : undefined;
        if (v) { hit("variant as its union", "wrapped in the variant constructor"); return `${useDeclared(wu.name, wu.decl.getSourceFile().fileName, e)}.${pascal(v.kind)}(${owned(ex(e), true)})`; }
      }
      if (own && ts.isConditionalExpression(e)) ownBranches.add(e);
      return owned(ex(e, want));
    };
    const ownConv = (e: ts.Expression, want?: ts.Type) => conv(e, want, true);
    // A value going straight into Heap(...) has nothing to infer an empty array's element type from: it is spelled out.
    let boxedFieldInit = false;
    const heapConv = (e: ts.Expression, want?: ts.Type) => { boxedFieldInit = true; try { return ownConv(e, want); } finally { boxedFieldInit = false; } };
    // Struct literal fields evaluate in emitted order, so a field taking a local whole (`target: expr`, a move)
    // must come after a field reading through it (`span: expr.span`); field order does not matter to the struct.
    const moveOrder = (o: ts.ObjectLiteralExpression) => {
      const init = (p: ts.ObjectLiteralElementLike) => (ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) ? unparen(p.initializer) : undefined);
      const readsThrough = new Set<ts.Symbol>();
      for (const p of o.properties) {
        const i = init(p);
        if (i) walkBody(i, (n) => { if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) { const s = symOf(n.expression); if (s) readsThrough.add(s); } });
      }
      const rank = (m: ts.PropertySignature) => {
        const p = o.properties.find((q) => (q.name as ts.Identifier).text === (m.name as ts.Identifier).text);
        const i = p && init(p);
        const s = i && ts.isIdentifier(i) ? (ts.isShorthandPropertyAssignment(i.parent) ? checker.getShorthandAssignmentValueSymbol(i.parent) : symOf(i)) : undefined;
        return s && readsThrough.has(s) ? 1 : 0;
      };
      return (a: ts.PropertySignature, b: ts.PropertySignature) => rank(a) - rank(b);
    };

    // A type with no Milo mapping is a TsOpaque field or parameter; code that reads through it or passes a real value to it cannot compile, so it stubs.
    const unmappableCache = new Map<ts.Type, boolean>();
    const unmappable = (t: ts.Type, at: ts.Node): boolean => {
      let r = unmappableCache.get(t);
      if (r === undefined) { try { ty0(t, at); r = false; } catch (err) { if (!(err instanceof Unsupported)) throw err; r = true; } unmappableCache.set(t, r); }
      return r;
    };
    // By the declared type, not the narrowed one: a tagged union narrowed to a variant is an object type with no name of its own.
    const declUnmappable = (x: ts.Expression): boolean => {
      const u = unparen(x);
      const sy = ts.isPropertyAccessExpression(u) ? checker.getSymbolAtLocation(u.name) : ts.isIdentifier(u) ? checker.getSymbolAtLocation(u) : undefined;
      const d0 = sy?.declarations?.[0];
      // A catch variable is typed by the program-wide thrown enum and narrowed by instanceof, not by its declared type.
      if (d0 && ts.isVariableDeclaration(d0) && ts.isCatchClause(d0.parent)) return false;
      return !!sy && !!d0 && (ts.isPropertyDeclaration(d0) || ts.isPropertySignature(d0) || ts.isParameter(d0) || ts.isVariableDeclaration(d0)) && !isLibDecl(program, d0) && unmappable(checker.getTypeOfSymbol(sy), u);
    };
    const memberAccess = (e: ts.PropertyAccessExpression): string => {
      // `process.env.NAME` (string | undefined): the runtime's jsEnv reads the real environment.
      if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "env" && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === "process") {
        hit("process.env.NAME", "runtime jsEnv(name) over std/env getEnv");
        return `${useRuntime("jsEnv", e)}(${JSON.stringify(e.name.text)})`;
      }
      const sym = checker.getSymbolAtLocation(e.name);
      const d = sym?.declarations?.[0];
      // A field whose own type has no mapping was left out of its struct (or is a TsOpaque there).
      if (d && (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent))) && !isLibDecl(program, d) && unmappable(tOf(e), e)) return fail(e, `field ${e.name.text} whose type has no mapping`);
      if (d && !isLibDecl(program, d) && !ts.isEnumMember(d) && declUnmappable(e.expression)) return fail(e, `member of a value whose type has no mapping (${checker.typeToString(tOf(e.expression))})`);
      if (d && ts.isEnumMember(d)) {
        const en = d.parent as ts.EnumDeclaration;
        return `${useDeclared(en.name.text, en.getSourceFile().fileName, e)}.${d.name.getText()}`;
      }
      if (e.name.text === "length" && d && isLibDecl(program, d)) {
        if (isStr(e.expression)) { hit("string .length", "jsLen (UTF-16 units)"); return `${useRuntime("jsLen", e)}(${ex(e.expression)})`; }
        hit("array .length", "Vec .len");
        return `${ex(e.expression)}.len`;
      }
      if (e.name.text === "size" && d && isLibDecl(program, d) && ["Map", "ReadonlyMap", "Set", "ReadonlySet"].includes(checker.getNonNullableType(tOf(e.expression)).symbol?.name ?? "")) {
        hit("Map/Set .size", "HashMap/HashSet .len()");
        return `${ex(e.expression)}.len()`;
      }
      // A field every variant of a tagged union has (`span`) is read through a generated accessor.
      const tu = unionOfType(checker, tOf(e.expression));
      if (tu) {
        // Only a field every variant declares has an accessor; a TS-narrowed subset of the union may read one the others lack.
        if (!tu.variants.every((v) => v.members.some((m) => m.name?.getText() === e.name.text))) fail(e, `field ${e.name.text} is not on every variant of ${tu.name}`);
        hit("tagged union common field", "generated accessor Union_field(&u)");
        return `${useDeclared(`${tu.name}_${e.name.text}`, tu.decl.getSourceFile().fileName, e)}(${ex(e.expression)})`;
      }
      // A field of the caught error: with several thrown classes the variable is the enum, so the field is
      // read out of its variant (moving the error; a later use of it is a compile error, which stubs the function).
      if (multiErr && isCatchVar(e.expression)) {
        const cls = tOf(e.expression).symbol;
        if (!cls || !errTypes.includes(cls.name)) fail(e, "field of a caught value that is not a thrown class");
        hit("catch variable field", "match on the Thrown variant, payload field moved out");
        return `(match ${ex(e.expression)} { ${std(THROWN_ENUM)}.${thrownName(cls)}(p) => p.${safeId(e.name.text)}, _ => exit(70) })`;
      }
      const base = e.expression.kind === ts.SyntaxKind.ThisKeyword ? "self" : ex(e.expression);
      const code = `${base}.${safeId(e.name.text)}`;
      // A field that closes a by-value cycle is a Heap<T> in Milo: reading it derefs.
      if (d && ts.isPropertySignature(d) && astModel.boxed.has(d) && !isOptionT(tOf(e))) { hit("boxed field", "Heap<T> field read as *field"); return `(*${code})`; }
      return code;
    };

    // ---- `a?.f` chains and `a ?? b` (subset.ts chainHandled / nullishHandled) ----
    // The payload an `if let` binds out of `scrut` is a Heap<T> to deref when the place is boxed.
    const boxedPlace = (scrut: ts.Expression): boolean => {
      if (isChainMember(scrut)) return false; // a chain yields an owned, already unboxed Option
      const d = ts.isPropertyAccessExpression(scrut) ? checker.getSymbolAtLocation(scrut.name)?.declarations?.[0] : undefined;
      return !!(d && ts.isPropertySignature(d) && astModel.boxed.has(d)) || boxedElem(scrut) || (ts.isIdentifier(scrut) && elemBoxed.has(symOf(scrut)!));
    };
    // The chain `n` as nested `match`es: `some` builds the result from the payload once every link is
    // present, `none` is the result when any is absent (so a `??` default runs only then). Each link
    // binds the payload by reference and narrows its source text, so the next link reads through it;
    // only the last link's payload is cloned out when `own`.
    const chainFold = (e: ts.Expression, none: string, some: (v: string) => string, own: boolean): string => {
      const n = e as ts.PropertyAccessExpression;
      hit("optional chain", "nested match on each Option link");
      const link = n.expression;
      const access = (): string => {
        const fieldT = checker.getTypeOfSymbolAtLocation(checker.getSymbolAtLocation(n.name)!, n);
        const code = memberAccess(n);
        const key = n.getText();
        const saved = narrow.get(key);
        const bindTo = (scrut: string, deref: boolean) => {
          const name = fresh(key);
          narrow.set(key, { name, deref });
          const inner = some(name);
          if (saved) narrow.set(key, saved); else narrow.delete(key);
          return `(match ${scrut} { Option.Some(${name}) => ${inner}, Option.None => ${none} })`;
        };
        if (isOptionT(fieldT)) {
          const payloadT = checker.getNonNullableType(fieldT);
          const d = checker.getSymbolAtLocation(n.name)?.declarations?.[0];
          const boxed = !!(d && ts.isPropertySignature(d) && astModel.boxed.has(d));
          if (!own) return bindTo(code, boxed);
          if (boxed) return bindTo(`${useRuntime("optUnbox", n)}<${ty(payloadT, n)}>(${code})`, false);
          cloneFail(n, fieldT);
          return bindTo(`${code}.clone()`, false);
        }
        let v = code;
        if (own && !isCopyT(fieldT)) {
          cloneFail(n, fieldT);
          v = `${code}.clone()`;
        }
        narrow.set(key, { name: code, deref: false });
        const r = some(v);
        if (saved) narrow.set(key, saved); else narrow.delete(key);
        return r;
      };
      if (isChainMember(link)) return chainFold(link, none, () => access(), false);
      // The root: an optional place, bound by reference. One that is not optional (`next?.kind` on a Token,
      // redundant in TS) or already bound by an enclosing match is read through directly.
      const lkey = link.getText();
      if (!isOptionT(tOf(link)) || narrow.has(lkey)) return access();
      const lsaved = narrow.get(lkey);
      const name = fresh(lkey);
      const scrut = ex(link);
      narrow.set(lkey, { name, deref: boxedPlace(link) });
      const inner = access();
      if (lsaved) narrow.set(lkey, lsaved); else narrow.delete(lkey);
      return `(match ${scrut} { Option.Some(${name}) => ${inner}, Option.None => ${none} })`;
    };
    // A chain read as an Option value (the same type as TypeScript gives `a?.f`, flattened).
    const chainOpt = (n: ts.Expression): string => {
      const t = checker.getNonNullableType(tOf(n));
      return chainFold(n, `${useRuntime("optNone", n)}<${ty(t, n)}>()`, (v) => `Option.Some(${v})`, true);
    };
    // The left side of a `place ?? []` loop head whose body never writes the loop variable: iterating a clone is unobservable.
    let roNullishLeft: ts.Expression | null = null;
    const nullish = (b: ts.BinaryExpression): string => {
      const mode = nullishHandled(checker, b) ?? fail(b, "?? outside the subset");
      hit("nullish coalescing", mode === "value" ? "Milo ?? (the default runs only when absent)" : "if isSome, else the default");
      const rt = tOf(b);
      const l = unparen(b.left);
      const dflt = ownConv(b.right, rt);
      if (isChainMember(l)) return mode === "value" ? chainFold(l, dflt, (v) => v, true) : chainFold(l, dflt, (v) => `Option.Some(${v})`, true);
      if (l === roNullishLeft) roDest = true;
      if (mode === "value") return `(${conv(l, tOf(l), true)} ?? ${dflt})`;
      return `(if ${ex(l)}.isSome() { ${conv(l, tOf(l), true)} } else { ${dflt} })`;
    };

    // `byValue`: a constructor takes ownership of its arguments; every other parameter is borrowed,
    // and one the callee writes through is passed as `&mut x`.
    const args = (call: ts.CallExpression | ts.NewExpression, byValue = false): string => {
      const sig = checker.getResolvedSignature(call);
      const decl = sig?.declaration as ts.SignatureDeclaration | undefined;
      const parts: string[] = [];
      const given = call.arguments ?? [];
      const mp = decl && mutParams.get(decl);
      decl?.parameters.forEach((p, i) => {
        const pt = checker.getTypeAtLocation(p);
        if (i < given.length && heapOptParam(p)) { hit("boxed optional field", "passed as Option<Heap<T>> to an optional parameter"); parts.push(`${mp?.has(i) ? "&mut " : ""}${ex(given[i])}`); }
        else if (i < given.length && mp?.has(i)) { hit("&mut parameter", "argument written `&mut x`"); parts.push(`&mut ${conv(given[i], pt)}`); }
        else if (i < given.length) { if (!byValue) argRegion = call; parts.push(conv(given[i], pt, byValue)); argRegion = undefined; }
        else if (p.initializer) { hit("default parameter", "default expression filled in at the call site"); parts.push(ex(p.initializer)); }
        else if (p.questionToken) parts.push("Option.None");
        else fail(call, "missing argument");
      });
      return parts.join(", ");
    };

    let closureDepth = 0;
    // The failure flags of the enclosing `try` blocks, innermost last: inside one, an error sets the flag and leaves the block.
    const tryFlags: string[] = [];
    // Parallel to tryFlags: the variable holding the try's error when its catch binds one, else "".
    const tryErr: string[] = [];
    const recordErr = (v: string) => (tryErr[tryErr.length - 1] ? `${tryErr[tryErr.length - 1]} = Option.Some(${v}); ` : "");
    // A failure inside a loop within a try only left that loop: leave the enclosing ones too.
    const afterLoop = () => { if (tryFlags.length) { line(`if ${tryFlags[tryFlags.length - 1]} {`); line("    break"); line("}"); } };
    const withTry = (call: ts.CallExpression, code: string): string => {
      const d = declOf(call);
      if (closureDepth > 0 && d && throwing.has(d) && !isThrower(d)) fail(call, "closure (loop tier) calling a function that throws");
      if (d && throwing.has(d) && !isThrower(d) && tryFlags.length) {
        hit("call of a throwing function in try", "match on the Result, the Err arm sets the try's flag and breaks out");
        const v = fresh("ok");
        return `(match ${code} { Result.Ok(${v}) => ${v}, Result.Err(${tryErr[tryErr.length - 1] ? "ev" : "_"}) => { ${recordErr("ev")}${tryFlags[tryFlags.length - 1]} = true; break } })`;
      }
      if (d && throwing.has(d) && !isThrower(d)) { hit("call of a throwing function", "`?` on the Result"); return `${code}?`; }
      return code;
    };

    // The text a /x/g literal matches when x is plain characters (escaped punctuation allowed), or a non-empty string literal for replaceAll.
    const replaceLiteral = (e: ts.Expression, isAll: boolean): string | null => {
      if (isAll) return ts.isStringLiteral(e) && e.text.length > 0 ? e.text : null;
      if (!ts.isRegularExpressionLiteral(e)) return null;
      const m = /^\/(.+)\/g$/.exec(e.text);
      if (!m) return null;
      let o = "";
      for (let i = 0; i < m[1].length; i++) {
        const ch = m[1][i];
        if (ch === "\\") { const nx = m[1][++i]; if (nx === undefined || /[a-zA-Z0-9]/.test(nx)) return null; o += nx; }
        else if (/[\^$.*+?()[\]{}|\/]/.test(ch)) return null;
        else o += ch;
      }
      return o;
    };

    // Loop tier (subset.ts arrayClosureCall): xs.some(x => e) becomes jsSome(xs, (x: &T) => e), a runtime helper
    // that loops with the exact JavaScript short-circuit and result rules. The arrow is a by-reference Milo closure.
    const CLOSURE_HELPERS: Record<string, string> = { some: "jsSome", every: "jsEvery", map: "jsMap", filter: "jsFilter", find: "jsFind", findIndex: "jsFindIndex", forEach: "jsForEach", flatMap: "jsFlatMap", reduce: "jsReduce" };
    const closureCall = (c: ts.CallExpression, cl: { method: string; arrow: ts.ArrowFunction; elem: ts.Type }): string => {
      const { method, arrow, elem } = cl;
      hit("closure in an array method", `${CLOSURE_HELPERS[method]}(xs, closure) loop helper`);
      const recv = (c.expression as ts.PropertyAccessExpression).expression;
      const owned = method === "filter" && !(elem.flags & (ts.TypeFlags.Number | ts.TypeFlags.String | ts.TypeFlags.Boolean | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral));
      const helper = useRuntime(owned ? "jsFilterOwned" : CLOSURE_HELPERS[method], c);
      const ret = checker.getSignatureFromDeclaration(arrow)!.getReturnType();
      const core = isOptionT(elem) ? checker.getNonNullableType(elem) : elem;
      const boxed = onCycle(core);
      const inner = boxed ? `Heap<${ty(core, c)}>` : ty(core, c);
      const elemTy = `&${isOptionT(elem) ? `Option<${inner}>` : inner}`;
      // The receiver is evaluated by the caller, outside the closure: a `?` in it propagates from the enclosing function.
      const recvCode = ex(recv);
      const savedFn = curFn;
      curFn = arrow; closureDepth++; push();
      try {
        const ps = arrow.parameters.map((p, i) => {
          const sym = symOf(p.name as ts.Identifier)!;
          const nm = declareLocal(sym, (p.name as ts.Identifier).text);
          if (method === "reduce" && i === 0) return `${nm}: ${ty(ret, p)}`;
          if (boxed) elemBoxed.add(sym);
          return `${nm}: ${elemTy}`;
        });
        const retTy = method === "forEach" ? "" : `: ${ty(ret, arrow)}`;
        const mark = out.length;
        ind++;
        if (ts.isBlock(arrow.body)) block(arrow.body);
        else if (method === "forEach") exprStmt(arrow.body);
        else line(`return ${ownConv(arrow.body, ret)}`);
        ind--;
        const inside = out.splice(mark).join("\n");
        const lit = `(${ps.join(", ")})${retTy} => {\n${inside}\n${"    ".repeat(ind)}}`;
        const tail = method === "reduce" ? `, ${ownConv(c.arguments[1], ret)}` : "";
        return `${helper}(${recvCode}, ${lit}${tail})`;
      } finally { pop(); closureDepth--; curFn = savedFn; }
    };

    // A closure literal for an arrow whose parameters carry annotations.
    const closureLit = (arrow: ts.ArrowFunction, params: { p: ts.ParameterDeclaration; ref: boolean }[]): string => {
      const ret = checker.getSignatureFromDeclaration(arrow)!.getReturnType();
      const savedFn = curFn;
      curFn = arrow; closureDepth++; push();
      try {
        const ps = params.map(({ p, ref }) => `${declareLocal(symOf(p.name as ts.Identifier)!, (p.name as ts.Identifier).text)}: ${ref ? "&" : ""}${ty(checker.getTypeAtLocation(p), p)}`);
        const isVoid = !!(ret.flags & ts.TypeFlags.Void);
        const mark = out.length;
        ind++;
        if (ts.isBlock(arrow.body)) block(arrow.body);
        else if (isVoid) exprStmt(arrow.body);
        else line(`return ${ownConv(arrow.body, ret)}`);
        ind--;
        const inside = out.splice(mark).join("\n");
        return `(${ps.join(", ")})${isVoid ? "" : `: ${ty(ret, arrow)}`} => {\n${inside}\n${"    ".repeat(ind)}}`;
      } finally { pop(); closureDepth--; curFn = savedFn; }
    };

    const callEx = (c: ts.CallExpression): string => {
      const key = calleeKey(program, checker, c);
      const a = c.arguments;
      if (ts.isPropertyAccessExpression(c.expression)) {
        const rx = c.expression.expression;
        // `Math`, `Object` and the like are library namespaces, not values.
        const libNs = ts.isIdentifier(rx) && (checker.getSymbolAtLocation(rx)?.declarations ?? []).every((d) => isLibDecl(program, d));
        if (!libNs && declUnmappable(rx)) return fail(c, `call on a value whose type has no mapping (${checker.typeToString(tOf(rx))})`);
        const cd = checker.getSymbolAtLocation(c.expression.name)?.declarations?.[0];
        if (cd && (ts.isPropertyDeclaration(cd) || ts.isPropertySignature(cd) || (ts.isParameter(cd) && ts.isConstructorDeclaration(cd.parent))) && !isLibDecl(program, cd) && unmappable(tOf(c.expression), c)) return fail(c, `call of field ${c.expression.name.text} whose type has no mapping`);
      }
      const cl = arrayClosureCall(program, checker, c);
      if (cl !== null) return typeof cl === "string" ? fail(c, cl) : closureCall(c, cl);
      if (key !== null) {
        const recv = ts.isPropertyAccessExpression(c.expression) ? c.expression.expression : null;
        switch (key) {
          case "String.charCodeAt": return `${useRuntime("jsCharCodeAt", c)}(${ex(recv!)}, ${ex(a[0])})`;
          case "String.slice": return a.length > 1 ? `${useRuntime("jsSlice", c)}(${ex(recv!)}, ${ex(a[0])}, ${ex(a[1])})` : `${useRuntime("jsSliceFrom", c)}(${ex(recv!)}, ${ex(a[0])})`;
          case "StringConstructor.fromCharCode": return `${useRuntime("jsFromCharCode", c)}(${ex(a[0])})`;
          case "StringConstructor.fromCodePoint": return `${useRuntime("jsFromCodePoint", c)}(${ex(a[0])})`;
          case "Number.toString": return a.length ? `${useRuntime("jsNumRadix", c)}(${ex(recv!)}, ${ex(a[0])})` : `${useRuntime("jsNum", c)}(${ex(recv!)})`;
          case "Array.push": {
            // xs.push(...ys): ys is consumed (a borrowed place is cloned under the usual rules).
            if (a.length === 1 && ts.isSpreadElement(a[0])) return `${ex(recv!)}.extend(${ownConv(a[0].expression, tOf(recv!))})`;
            const el = checker.getTypeArguments(tOf(recv!) as ts.TypeReference)[0]; return `${ex(recv!)}.push(${optHeapElem(el, a[0]) ?? heapElem(el, ownConv(a[0], el))})`; }
          // xs.pop(): the owned last element (the Milo Vec holds it boxed when its type is on a cycle).
          case "Array.pop": {
            const el = checker.getTypeArguments(tOf(recv!) as ts.TypeReference)[0];
            if (a.length !== 0) return fail(c, "Array.pop with arguments");
            // The runtime helper takes the vector `&mut`, written at the call even for a `&mut` parameter.
            return `${useRuntime(onCycle(el) && !isOptionT(el) ? "vecPopHeap" : "vecPop", c)}(&mut ${ex(recv!)})`;
          }
          case "Set.has": case "ReadonlySet.has": case "WeakSet.has": return `${ex(recv!)}.contains(${keyEx(recv!, a[0])})`;
          case "Set.add": case "WeakSet.add": return `${ex(recv!)}.add(${keyEx(recv!, a[0], true)})`;
          case "Set.delete": case "WeakSet.delete": case "Map.delete": case "WeakMap.delete": return `${ex(recv!)}.remove(${keyEx(recv!, a[0])})`;
          case "Map.get": case "ReadonlyMap.get": case "WeakMap.get": return `${ex(recv!)}.get(${keyEx(recv!, a[0])})`;
          case "Map.has": case "ReadonlyMap.has": case "WeakMap.has": return `${ex(recv!)}.contains(${keyEx(recv!, a[0])})`;
          case "Map.set": case "WeakMap.set": { const [, vt] = checker.getTypeArguments(tOf(recv!) as ts.TypeReference); return `${ex(recv!)}.insert(${keyEx(recv!, a[0], true)}, ${ownConv(a[1], vt)})`; }
          // The generated AST holds every `number` as i64, so a float literal keeps its integer part only (a known parser-diff gap until the AST has an f64).
          // TS numbers are i64 in the generated code: a float would silently lose its fraction, so refuse until f64 exists.
          // parseFloat yields an f64, which only an `f64`-typed destination (ast.ts's alias) can hold; the lexer's number text is plain decimal/exponent, so strtod agrees with JS.
          // A deep copy sharing nothing, which is what a derived Clone is (heap fields cloned). The copy is
          // a fresh owned value, so unlike a place copied out of a borrow it needs no read-only destination.
          case "structuredClone": if (a.length !== 1 || !canClone(tOf(a[0]))) return fail(c, "structuredClone of a value with no derived Clone"); return `${ex(a[0])}.clone()`;
          case "parseFloat": if (a.length !== 1 || !isStr(a[0])) return fail(c, "parseFloat of other than one string"); return `${useRuntime("jsParseFloat", c)}(${ex(a[0])})`;
          case "Number": return fail(c, "Number/parseFloat on a value that may not be an integer (no f64 numbers in the generated code yet)");
          case "parseInt": if (!a[1]) return `${useRuntime("jsParseIntAuto", c)}(${ex(a[0])})`; return `${useRuntime("jsParseInt", c)}(${ex(a[0])}, ${ex(a[1])})`;
          // A bigint is its decimal string in the Milo AST. BigInt of a string is that string (the lexer's decimal digits are already canonical).
          case "BigInt": if (a.length !== 1 || !(isStr(a[0]) || isNum(a[0]))) return fail(c, "BigInt of other than one string or number"); return isNum(a[0]) ? `${useRuntime("jsNum", c)}(${ex(a[0])})` : ex(a[0]);
          case "String()": return isNum(a[0]) ? `${useRuntime("jsNum", c)}(${ex(a[0])})` : ex(a[0]);
          // Only the single-argument forms the runtime helpers implement exactly; anything else (a position, a regex, a limit) stays refused.
          case "String.startsWith": case "String.endsWith": case "String.includes": case "String.indexOf": case "String.lastIndexOf": case "String.split": {
            if (a.length !== 1 || !isStr(a[0])) return fail(c, `library call ${key} with other than one string argument`);
            const h = { "String.startsWith": "jsStartsWith", "String.endsWith": "jsEndsWith", "String.includes": "jsIncludes", "String.indexOf": "jsIndexOf", "String.lastIndexOf": "jsLastIndexOf", "String.split": "jsSplit" }[key];
            return `${useRuntime(h, c)}(${ex(recv!)}, ${ex(a[0])})`;
          }
          case "Math.min": case "Math.max": {
            if (a.length !== 2 || !isNum(a[0]) || !isNum(a[1])) return fail(c, `library call ${key} with other than two numbers`);
            return `${useRuntime(key === "Math.min" ? "jsMin" : "jsMax", c)}(${ex(a[0])}, ${ex(a[1])})`;
          }
          case "String.trim": return `${useRuntime("jsTrim", c)}(${ex(recv!)})`;
          case "String.charAt": if (a.length !== 1) return fail(c, "String.charAt without an index"); return `${useRuntime("jsAt", c)}(${ex(recv!)}, ${ex(a[0])})`;
          case "Array.join": {
            const el = checker.getTypeArguments(tOf(recv!) as ts.TypeReference)[0];
            if (!(el.flags & ts.TypeFlags.String) || a.length > 1) return fail(c, "Array.join of other than strings with at most a separator");
            return `${useRuntime("jsJoin", c)}(${ex(recv!)}, ${a.length ? ex(a[0]) : jsLit(",")})`;
          }
          case "String.replace": case "String.replaceAll": {
            // A global replace of a literal with a literal: no regex engine, and no `$` patterns in the replacement.
            const lit = replaceLiteral(a[0], key === "String.replaceAll");
            if (lit === null || a.length !== 2 || !ts.isStringLiteral(a[1]) || a[1].text.includes("$")) return fail(c, `library call ${key}`);
            return `${useRuntime("jsReplaceAll", c)}(${ex(recv!)}, ${jsLit(lit)}, ${ex(a[1])})`;
          }
        }
        return fail(c, `library call ${key}`);
      }
      const csig = checker.getResolvedSignature(c);
      // An interface is emitted as a struct of its data members; its methods have no Milo declaration.
      if (csig?.declaration && ts.isMethodSignature(csig.declaration) && !isLibDecl(program, csig.declaration)) return fail(c, `call of interface method ${csig.declaration.name.getText()}`);
      if (csig?.declaration && !isLibDecl(program, csig.declaration) && unmappable(checker.getReturnTypeOfSignature(csig), c)) return fail(c, `call whose result type has no mapping (${checker.typeToString(checker.getReturnTypeOfSignature(csig))})`);
      if (csig && csig.declaration && !isLibDecl(program, csig.declaration)) for (const ps of csig.getParameters()) {
        const pt = checker.getTypeOfSymbolAtLocation(ps, c);
        if (unmappable(pt, c)) return fail(c, `argument for parameter ${ps.name} whose type has no mapping (${checker.typeToString(pt)})`);
      }
      const argStr = args(c);
      let code: string;
      if (ts.isPropertyAccessExpression(c.expression)) {
        const r = c.expression.expression;
        code = `${r.kind === ts.SyntaxKind.ThisKeyword ? "self" : ex(r)}.${safeId(c.expression.name.text)}(${argStr})`;
      } else {
        const id = c.expression as ts.Identifier;
        const lsym = symOf(id);
        const lname = lsym && lookupLocal(lsym);
        code = lname ? `${lname}(${argStr})` : `${useDeclared(id.text, symDeclFile(symOf(id)), c)}(${argStr})`;
      }
      return withTry(c, code);
    };

    let guardScrut: ts.Expression | null = null;
    // `x.tag === "k" && x.f` / `x.tag !== "k" || x.f` as an expression: the operands after the guard
    // read the variant, so they sit inside a `match` on the union (the else arm is the short-circuit
    // result). Without it `x.f` would read a field of the whole enum.
    // The pattern naming variant `kind` of a tagged union; a leaf of a union of unions is reached through its member first.
    const kindPattern = (tu: NonNullable<ReturnType<typeof discriminantRead>>, kind: string, at: ts.Node) => {
      const useName = useDeclared(tu.name, tu.decl.getSourceFile().fileName, at);
      let pat = (n: string) => `${useName}.${pascal(kind)}(${n})`;
      let outer: ((n: string) => string) | undefined;
      const via = tu.members?.find((m) => m.name === tu.variants.find((v) => v.kind === kind)?.via);
      if (via?.union) {
        const inner = useDeclared(via.union.name, via.union.decl.getSourceFile().fileName, at);
        outer = (o) => `${useName}.${via.name}(${o})`;
        pat = (n) => `${inner}.${pascal(kind)}(${n})`;
      } else if (via) pat = (n) => `${useName}.${via.name}(${n})`;
      return { pat, outer };
    };
    // A condition that, when it evaluates to `positive`, proves a place is a variant or present: the place
    // and the pattern that binds its payload. Operands after it (or a branch) read the payload instead.
    type Guard = { scrut: ts.Expression; pat: (n: string) => string; outer?: (n: string) => string; also?: (n: string) => string; deref: boolean; at: ts.Node };
    const guardOf = (c: ts.Expression, positive: boolean): Guard | null => {
      c = unparen(c);
      if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return guardOf(c.operand, !positive);
      const okPlace = (x: ts.Expression) => { x = unparen(x); return (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && !isChainMember(x); };
      if (ts.isBinaryExpression(c)) {
        const k = c.operatorToken.kind;
        const eq = k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken;
        const ne = k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
        if ((k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken) && ts.isStringLiteral(c.right) && ts.isPropertyAccessExpression(c.left)) {
          const tu = discriminantRead(checker, c.left);
          const sc = unparen(c.left.expression);
          if (!tu || (eq !== positive) || !okPlace(sc)) return null;
          return { scrut: sc, ...kindPattern(tu, c.right.text, c), deref: false, at: c };
        }
        if ((eq || ne) && (isUndefinedId(unparen(c.right)) || unparen(c.right).kind === ts.SyntaxKind.NullKeyword)) {
          const x = unparen(c.left);
          if (!okPlace(x) || !isOptionT(tOf(x)) || (ne !== positive)) return null;
          return { scrut: x, pat: (n) => `Option.Some(${n})`, deref: boxedPlace(x), at: c };
        }
        return null;
      }
      // Truthiness of an optional struct, array or union: present. (A string, number or boolean also tests its payload.)
      if (positive && okPlace(c) && isOptionT(tOf(c))) {
        const nn = checker.getNonNullableType(tOf(c));
        if (litsOf(nn)) return null;
        // A string, number or boolean payload must also be truthy itself.
        const also = nn.flags & ts.TypeFlags.StringLike ? (n: string) => truthText("str", n) : nn.flags & ts.TypeFlags.NumberLike ? (n: string) => truthText("num", n) : nn.flags & ts.TypeFlags.BooleanLike ? (n: string) => n : undefined;
        return { scrut: c, pat: (n) => `Option.Some(${n})`, also, deref: boxedPlace(c), at: c };
      }
      return null;
    };
    // `match scrut { pat => then, _ => other }` with the guarded place bound to the payload inside `then`.
    const matchGuard = (g: Guard, then: () => string, other: string): string => {
      hit("expression guard", "match binding the payload, which replaces the guarded expression inside");
      const key = g.scrut.getText();
      const name = fresh(key);
      guardScrut = g.scrut;
      const scrutCode = ex(g.scrut);
      guardScrut = null;
      const saved = narrow.get(key);
      narrow.set(key, { name, deref: g.deref });
      let body = then();
      if (g.also) body = `(if ${g.also(name)} { ${body} } else { ${other} })`;
      if (saved) narrow.set(key, saved); else narrow.delete(key);
      if (g.outer) { const o = fresh(key); return `match ${scrutCode} { ${g.outer(o)} => match ${o} { ${g.pat(name)} => ${body}, _ => ${other} }, _ => ${other} }`; }
      return `match ${scrutCode} { ${g.pat(name)} => ${body}, _ => ${other} }`;
    };
    // `g(x) && x.f` / `!g(x) || x.f`: the operands after the guard read the narrowed place, so they sit
    // inside a `match` whose other arm is the short-circuit result.
    const foldKindGuards = (b: ts.BinaryExpression): string | null => {
      const op = b.operatorToken.kind;
      const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
      const flat = (e: ts.Expression): ts.Expression[] => {
        e = unparen(e);
        return ts.isBinaryExpression(e) && e.operatorToken.kind === op ? [...flat(e.left), ...flat(e.right)] : [e];
      };
      const fold = (parts: ts.Expression[]): string => {
        const i = parts.findIndex((p, k) => k < parts.length - 1 && guardOf(p, isAnd));
        if (i < 0) return parts.map((p) => cond(p)).join(isAnd ? " && " : " || ");
        const before = parts.slice(0, i).map((p) => cond(p));
        const m = matchGuard(guardOf(parts[i], isAnd)!, () => fold(parts.slice(i + 1)), isAnd ? "false" : "true");
        return `(${[...before, m].join(isAnd ? " && " : " || ")})`;
      };
      const parts = flat(b);
      if (!parts.some((p, k) => k < parts.length - 1 && guardOf(p, isAnd))) return null;
      return fold(parts);
    };
    // `g(x) ? a : b`: a reads the narrowed place (or b does, when the condition is the negative form).
    const foldCondGuard = (c: ts.ConditionalExpression, want?: ts.Type): string | null => {
      const pos = guardOf(c.condition, true);
      if (pos) return `(${matchGuard(pos, () => conv(c.whenTrue, want), conv(c.whenFalse, want))})`;
      const neg = guardOf(c.condition, false);
      if (neg) return `(${matchGuard(neg, () => conv(c.whenFalse, want), conv(c.whenTrue, want))})`;
      return null;
    };
    const ex =(e: ts.Expression, want?: ts.Type): string => {
      if (narrow.size > 0 && (e.kind === ts.SyntaxKind.Identifier || e.kind === ts.SyntaxKind.PropertyAccessExpression || e.kind === ts.SyntaxKind.ElementAccessExpression || e.kind === ts.SyntaxKind.CallExpression)) {
        const nb = narrow.get(e.getText());
        if (nb) {
          const bound = nb.deref ? `(*${nb.name})` : nb.name;
          // A guard-narrowed place handed to a parameter of the whole union: put the variant back in its enum.
          const wu = want ? unionOfType(checker, checker.getNonNullableType(want)) : null;
          const vt = tOf(e).symbol?.declarations?.[0];
          const v = wu && vt ? wu.variants.find((x) => x.decl === vt) : undefined;
          if (wu && v && !unionOfType(checker, checker.getNonNullableType(tOf(e)))) return `${useDeclared(wu.name, wu.decl.getSourceFile().fileName, e)}.${pascal(v.kind)}(${bound}.clone())`;
          return bound;
        }
      }
      // TS narrows a union of unions by an early exit or an else, but the Milo value is still the whole union.
      // (A guard's own scrutinee is exempt: it is the whole union that gets matched.)
      if (e !== guardScrut && (e.kind === ts.SyntaxKind.Identifier || e.kind === ts.SyntaxKind.PropertyAccessExpression)) {
        const sym = checker.getSymbolAtLocation(e.kind === ts.SyntaxKind.Identifier ? e : (e as ts.PropertyAccessExpression).name);
        const declT = sym && sym.declarations?.[0] && !ts.isTypeAliasDeclaration(sym.declarations[0]) ? checker.getNonNullableType(checker.getTypeOfSymbol(sym)) : undefined;
        const du = declT?.aliasSymbol ? unionOfType(checker, declT) : null;
        // Used where the whole union is wanted (`m.set(a, 1)` after `const a: N = { kind: "a" }`, which TS narrows
        // by its initializer), the Milo value is exactly what is wanted: only a member-typed use needs the guard.
        const wantsUnion = !!want && unionOfType(checker, checker.getNonNullableType(want))?.name === du?.name;
        // A const never reassigned is narrowed only by its own initializer: a fact about the value, which a member
        // field read through the union accessor (its other arms unreachable) reproduces exactly.
        const d0 = sym?.declarations?.[0];
        const byInit = !!d0 && ts.isVariableDeclaration(d0) && !!d0.initializer && (ts.getCombinedNodeFlags(d0) & ts.NodeFlags.Const) !== 0;
        if (du && !wantsUnion && !byInit && unionOfType(checker, checker.getNonNullableType(tOf(e)))?.name !== du.name) fail(e, `${e.getText()} is a ${du.name} narrowed to a member by an early exit or an else (narrow with an if guard)`);
      }
      switch (e.kind) {
        case ts.SyntaxKind.ParenthesizedExpression: return `(${ex((e as ts.ParenthesizedExpression).expression, want)})`;
        case ts.SyntaxKind.NonNullExpression: {
          // `xs[i]!` asserts what an index read already is; an operand that really is optional would need an unwrap.
          const inner = (e as ts.NonNullExpression).expression;
          // `x!` on an optional place unwraps (moving the payload out); the program checked it first, so the unwrap never traps.
          if (isOptionT(tOf(inner))) {
            if (!ts.isPropertyAccessExpression(unparen(inner)) && !ts.isIdentifier(unparen(inner))) fail(e, "non-null assertion on an optional value");
            hit("non-null assertion on an optional place", "Option unwrap");
            return `${ex(inner)}!`;
          }
          return ex(inner, want);
        }
        case ts.SyntaxKind.ThisKeyword: return "self";
        case ts.SyntaxKind.TrueKeyword: return "true";
        case ts.SyntaxKind.FalseKeyword: return "false";
        case ts.SyntaxKind.NullKeyword: return "Option.None";
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
          if (local) return sym && elemBoxed.has(sym) && !isOptionT(tOf(e)) ? `(*${local})` : local;
          return useDeclared(id.text, symDeclFile(sym), e);
        }
        case ts.SyntaxKind.TemplateExpression: {
          const t = e as ts.TemplateExpression;
          hit("template literal", "concatenation of js strings");
          const parts: string[] = [];
          if (t.head.text) parts.push(jsLit(t.head.text));
          for (const sp of t.templateSpans) {
            // `${x}` of a number | undefined prints "undefined" for the absent case, as JS does.
            const st = tOf(sp.expression);
            const inner = isOptionT(st) ? checker.getNonNullableType(st) : null;
            if (inner && (inner.flags & ts.TypeFlags.NumberLike || inner.flags & ts.TypeFlags.StringLike) && !litsOf(inner)) {
              const v = fresh("v");
              const some = inner.flags & ts.TypeFlags.NumberLike ? `${useRuntime("jsNum", e)}(${v})` : v;
              parts.push(`(match ${ex(sp.expression)} { Option.Some(${v}) => ${some}, Option.None => ${jsLit("undefined")} })`);
            } else parts.push(isNum(sp.expression) ? `${useRuntime("jsNum", e)}(${ex(sp.expression)})` : textOf(sp.expression));
            if (sp.literal.text) parts.push(jsLit(sp.literal.text));
          }
          return `(${parts.join(" + ")})`;
        }
        case ts.SyntaxKind.PropertyAccessExpression: return isChainMember(e) ? chainOpt(e) : memberAccess(e as ts.PropertyAccessExpression);
        case ts.SyntaxKind.ElementAccessExpression: {
          const el = e as ts.ElementAccessExpression;
          if (isStr(el.expression)) { hit("string[i]", "jsAt: one-unit js string, empty past the end"); return `${useRuntime("jsAt", e)}(${ex(el.expression)}, ${ex(el.argumentExpression)})`; }
          const at = `${ex(el.expression)}[${ex(el.argumentExpression)}]`;
          if (boxedElem(el) && !isOptionT(tOf(el))) { hit("boxed element", "Vec<Heap<T>> element read as *v[i]"); return `(*${at})`; }
          return at;
        }
        case ts.SyntaxKind.CallExpression: return callEx(e as ts.CallExpression);
        case ts.SyntaxKind.NewExpression: {
          const n = e as ts.NewExpression;
          const t = tOf(n);
          if (t.symbol?.name === "Set" || t.symbol?.name === "WeakSet") {
            if (nodeKeyOfContainer(checker, t) && n.arguments?.length) fail(n, "iteration over node-identity keys (new Set from a collection)");
            const ked = enumDeclOf(checker.getTypeArguments(t as ts.TypeReference)[0]);
            if (ked && n.arguments?.length) {
              const lit = n.arguments[0];
              if (!ts.isArrayLiteralExpression(lit)) fail(n, "new Set of enums from a non-literal collection");
              const vf = useDeclared(`${ked.name.text}_value`, ked.getSourceFile().fileName, n);
              hit("new Set([enums])", "HashSet.fromVec of Enum_value strings");
              return `${std("HashSet")}.fromVec([${(lit as ts.ArrayLiteralExpression).elements.map((x) => `${vf}(${ex(x)})`).join(", ")}])`;
            }
            const keysOf = n.arguments?.length ? mapValuesRecv(checker, n.arguments[0], "keys") : null;
            if (keysOf && !nodeKeyOfContainer(checker, tOf(keysOf)) && !enumDeclOf(checker.getTypeArguments(checker.getNonNullableType(tOf(keysOf)) as ts.TypeReference)[0])) { hit("new Set(map.keys())", "HashSet.fromVec(map.keys())"); return `${std("HashSet")}.fromVec(${ex(keysOf)}.keys())`; }
            hit("new Set([...])", "HashSet.fromVec");
            return n.arguments?.length ? `${std("HashSet")}.fromVec(${ownConv(n.arguments[0])})` : `${std("HashSet")}.new()`;
          }
          if (t.symbol?.name === "Map" || t.symbol?.name === "WeakMap") { hit("new Map()", "HashMap.new()"); return "HashMap.new()"; }
          hit("new Class(...)", "Class.new(...), defaults filled");
          const d = t.symbol.declarations![0] as ts.ClassDeclaration;
          return `${useDeclared(d.name!.text, d.getSourceFile().fileName, e)}.new(${args(n, true)})`;
        }
        case ts.SyntaxKind.BinaryExpression: {
          const b = e as ts.BinaryExpression;
          const op = b.operatorToken.kind;
          const text = b.operatorToken.getText();
          if (op === ts.SyntaxKind.CommaToken) fail(b, "comma operator");
          if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) fail(b, `assignment ${text} used as a value`);
          if (op === ts.SyntaxKind.QuestionQuestionToken) return nullish(b);
          if (op === ts.SyntaxKind.InstanceOfKeyword && isCatchVar(b.left)) {
            const cls = checker.getSymbolAtLocation(b.right);
            if (!cls) fail(b, "instanceof of an unresolved class");
            hit("catch variable instanceof", "match on the Thrown variant");
            return multiErr ? `(match ${ex(b.left)} { ${std(THROWN_ENUM)}.${thrownName(cls!)}(_) => true, _ => false })` : "true";
          }
          if ((op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) && isChainMember(unparen(b.left)) && chainCompareHandled(checker, b)) {
            // Absent compares unequal to any value, so `!==` is true there.
            const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
            const l = unparen(b.left);
            const lt = checker.getNonNullableType(tOf(l));
            return chainFold(l, eq ? "false" : "true", (v) => `(${v} ${eq ? "==" : "!="} ${ex(b.right, litsOf(lt) ? lt : undefined)})`, false);
          }
          // `x !== null` / `x === undefined` on an Option is a presence test: a bare Option.None operand has no
          // inferable payload type, and payloads need not support ==.
          if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
            const isNil = (x: ts.Expression) => { const u = unparen(x); return u.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(u) && u.text === "undefined"); };
            const side = isNil(b.right) ? b.left : isNil(b.left) ? b.right : null;
            if (side && isOptionT(tOf(side))) {
              hit("compare with null/undefined", "x.isSome()");
              const eqNil = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
              return `${eqNil ? "!" : ""}${ex(side)}.isSome()`;
            }
          }
          const nc = nodeCompare(checker, b);
          if (nc) {
            hit("=== on nodes", "compare node ids");
            return `(${idEx(b.left, nc[0])} ${op === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!="} ${idEx(b.right, nc[1])})`;
          }
          if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            const sym = op === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!=";
            const lt = tOf(b.left), rt = tOf(b.right);
            // An optional primitive against a plain value (`x === false`, x: boolean | undefined): Option has no
            // `==` with payload, so compare the payload; absent is unequal to any value.
            const nullish = (x: ts.Expression) => isUndefinedId(unparen(x)) || unparen(x).kind === ts.SyntaxKind.NullKeyword;
            for (const [o, ot, p, pt] of [[b.left, lt, b.right, rt], [b.right, rt, b.left, lt]] as const) {
              if (!isOptionT(ot) || isOptionT(pt) || nullish(p) || nullish(o) || !(pt.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike))) continue;
              const v = fresh("v");
              const nn = checker.getNonNullableType(ot);
              return `(match ${ex(o, litsOf(pt) ? pt : undefined)} { Option.Some(${v}) => (${v} ${sym} ${ex(p, litsOf(nn) ? nn : undefined)}), Option.None => ${sym === "==" ? "false" : "true"} })`;
            }
            // Narrowing can make a `string` field's type a literal; the field is still a string, so the other side stays one.
            const wantEnum = (x: ts.Expression, t: ts.Type) => {
              const u = unparen(x);
              const s = ts.isPropertyAccessExpression(u) ? checker.getSymbolAtLocation(u.name) : ts.isIdentifier(u) ? checker.getSymbolAtLocation(u) : undefined;
              const d0 = s?.declarations?.[0];
              const dt = s && d0 && !ts.isTypeAliasDeclaration(d0) && !ts.isEnumMember(d0) ? checker.getNonNullableType(checker.getTypeOfSymbol(s)) : t;
              return litsOf(t) && (dt === t || litsOf(dt)) ? t : undefined;
            };
            return `(${ex(b.left, wantEnum(b.right, rt))} ${sym} ${ex(b.right, wantEnum(b.left, lt))})`;
          }
          if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
            const l0 = unparen(b.left);
            if (ts.isBinaryExpression(l0) && l0.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && isChainMember(unparen(l0.left))) {
              let root: ts.Expression = unparen(l0.left);
              while (isChainMember(root)) root = (root as ts.PropertyAccessExpression).expression;
              // Not for a tagged union: `t?.tag === "fn" && t.owning` narrows to a variant, which the union guard path does.
              if (ts.isIdentifier(root) && isOptionT(tOf(root)) && !narrow.has(root.getText()) && !unionOfType(checker, checker.getNonNullableType(tOf(root)))) {
                hit("optional chain compare narrowing", "x?.f === k && rest: match x once, both sides read the payload");
                const key = root.getText(), name = fresh(key), scrut = ex(root);
                const saved = narrow.get(key);
                narrow.set(key, { name, deref: boxedPlace(root) });
                const inner = `(${ex(l0)} && ${cond(b.right)})`;
                if (saved) narrow.set(key, saved); else narrow.delete(key);
                return `(match ${scrut} { Option.Some(${name}) => ${inner}, Option.None => false })`;
              }
            }
          }
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            // `a && b` as a value yields an operand, not a bool; only the boolean test has a Milo form.
            // An operand of a boolean && / || (`(a && b) && a.n === b.n`) is only tested, whatever its own type.
            const par = b.parent;
            const inBoolLogical = ts.isBinaryExpression(par) && (par.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || par.operatorToken.kind === ts.SyntaxKind.BarBarToken) && !!(tOf(par).flags & ts.TypeFlags.BooleanLike);
            if (!(tOf(b).flags & ts.TypeFlags.BooleanLike) && !inCondPos(b) && !inBoolLogical) return fail(b, `${b.operatorToken.getText()} as a value`);
            const g = foldKindGuards(b);
            if (g) return g;
            return `(${cond(b.left)} ${text} ${cond(b.right)})`;
          }
          if (op === ts.SyntaxKind.PlusToken && (isStr(b.left) || isStr(b.right) || (tOf(b).flags & ts.TypeFlags.StringLike) !== 0 || litsOf(tOf(b.left)) || litsOf(tOf(b.right)))) return `(${textOf(b.left)} ${text} ${textOf(b.right)})`;
          return `(${ex(b.left)} ${text} ${ex(b.right)})`;
        }
        case ts.SyntaxKind.PrefixUnaryExpression: {
          const u = e as ts.PrefixUnaryExpression;
          if (u.operator !== ts.SyntaxKind.ExclamationToken && u.operator !== ts.SyntaxKind.MinusToken) fail(u, `${ts.tokenToString(u.operator)}x used as a value (its result is read)`);
          return u.operator === ts.SyntaxKind.ExclamationToken ? `!${cond(u.operand)}` : `(-${ex(u.operand)})`;
        }
        case ts.SyntaxKind.PostfixUnaryExpression: return fail(e, `x${ts.tokenToString((e as ts.PostfixUnaryExpression).operator)} used as a value (its result is read)`);
        case ts.SyntaxKind.ConditionalExpression: {
          const c = e as ts.ConditionalExpression;
          hit("ternary", "if-expression");
          const fg = foldCondGuard(c, want);
          if (fg) return fg;
          // `place ? a : b` on an optional place: a reads the payload, so bind it like an if guard.
          const ct = unparen(c.condition);
          const ck = truthyHandled(checker, ct);
          if (ck && ck !== "str" && ck !== "num" && (ts.isIdentifier(ct) || ts.isPropertyAccessExpression(ct)) && !isChainMember(ct)) {
            const key = ct.getText();
            const nm = fresh(key);
            const scrutCode = ex(ct);
            const prev = narrow.get(key);
            narrow.set(key, { name: nm, deref: boxedPlace(ct) });
            const yes = conv(c.whenTrue, want, ownBranches.has(c));
            if (prev) narrow.set(key, prev); else narrow.delete(key);
            const no = conv(c.whenFalse, want, ownBranches.has(c));
            const pay = ck === "optStr" ? truthText("str", nm) : ck === "optNum" ? truthText("num", nm) : ck === "optBool" ? nm : "true";
            return `(match ${scrutCode} { Option.Some(${nm}) => (if ${pay} { ${yes} } else { ${no} }), Option.None => ${no} })`;
          }
          return `(if ${cond(c.condition)} { ${conv(c.whenTrue, want, ownBranches.has(c))} } else { ${conv(c.whenFalse, want, ownBranches.has(c))} })`;
        }
        case ts.SyntaxKind.AsExpression: {
          const a = e as ts.AsExpression;
          if (assertionIsNoop(checker, a)) { hit("type assertion", "dropped: the Milo value is the same"); return ex(a.expression); }
          const en = enumDeclOf(checker.getTypeFromTypeNode(a.type));
          if (!en) fail(a, assertionReason(checker, a));
          hit("string as StringEnum", "generated Enum_fromValue");
          return `${useDeclared(en!.name.text + "_fromValue", en!.getSourceFile().fileName, e)}(${ex(a.expression)})`;
        }
        case ts.SyntaxKind.ObjectLiteralExpression: {
          const o = e as ts.ObjectLiteralExpression;
          // A `bigint | number | string | boolean` field is the runtime's JsPrim: the variant is the initializer's own type, and a float is only a Number(string).
          const primConv = (init: ts.Expression): string => {
            let u = unparen(init);
            let neg = false;
            if (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.MinusToken) { neg = true; u = unparen(u.operand); }
            if (ts.isCallExpression(u) && ts.isIdentifier(u.expression) && u.arguments.length === 1 && isStr(u.arguments[0])) {
              const nm = u.expression.text;
              if (nm === "Number") return `${useRuntime("JsPrim", e)}.Num(${neg ? "-" : ""}${useRuntime("jsParseFloat", e)}(${ex(u.arguments[0])}))`;
              if (nm === "BigInt") return `${useRuntime("JsPrim", e)}.Big(${neg ? `${useRuntime("jsBigNeg", e)}(${ex(u.arguments[0])})` : ex(u.arguments[0])})`;
            }
            if (neg) return fail(init, "negated primitive-union value other than Number(string) or BigInt(string)");
            const t = tOf(init);
            if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) return `${useRuntime("JsPrim", e)}.Str(${ownConv(init)})`;
            if (t.flags & ts.TypeFlags.BooleanLike) return `${useRuntime("JsPrim", e)}.Bool(${ex(init)})`;
            return fail(init, "primitive-union value (bigint | number | string | boolean) whose variant is not known from its expression");
          };
          const ctxT = checker.getContextualType(o);
          // No annotation to take the type from: the literal's own inferred type is a synthesized struct.
          const ownT = checker.getNonNullableType(ctxT ?? tOf(o));
          if (ownT.symbol?.declarations?.[0] && ts.isObjectLiteralExpression(ownT.symbol.declarations[0])) {
            // A module-level value would be a global initializer, which the backend cannot lower for a struct yet.
            if (!ts.findAncestor(o, ts.isFunctionLike)) fail(o, "inferred object literal outside a function");
            const sname = ty(ownT, e);
            const keyOf = (q: ts.ObjectLiteralElementLike) => (q.name ? q.name.getText() : "");
            for (const p of o.properties) if (!(ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) || ts.isComputedPropertyName(p.name)) fail(p, `object literal member ${p.getText().slice(0, 30)}: only plain name: value and shorthand members are supported`);
            const vals = checker.getPropertiesOfType(ownT).map((p) => {
              const prop = o.properties.find((q) => keyOf(q) === p.name) as ts.ShorthandPropertyAssignment | ts.PropertyAssignment | undefined;
              const pt = checker.getTypeOfSymbolAtLocation(p, e);
              if (!prop) { if (p.flags & ts.SymbolFlags.Optional) return { name: p.name, v: "Option.None" }; return fail(o, `object literal without property '${p.name}'`); }
              return { name: p.name, v: ts.isShorthandPropertyAssignment(prop) ? ownConv(prop.name, pt) : ownConv(prop.initializer, pt) };
            });
            hit("object literal", "struct literal, missing optionals are Option.None");
            return `${sname} { ${vals.map((x) => `${safeId(x.name)}: ${x.v}`).join(", ")} }`;
          }
          if (!ctxT) fail(o, "object literal without a contextual type");
          const t = checker.getNonNullableType(ctxT!);
          if (!o.properties.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) fail(o, "object literal with spread or method members");
          if (!o.properties.every((p) => ts.isIdentifier(p.name!))) fail(o, "object literal with a non-identifier key");
          const lu = unionOfType(checker, t);
          if (lu) {
            // The variant is picked by the literal discriminant property (`{ tag: "ptr", inner }`).
            const dp = o.properties.find((p) => ts.isPropertyAssignment(p) && (p.name as ts.Identifier).text === lu.field) as ts.PropertyAssignment | undefined;
            const lit = dp && ts.isStringLiteral(stripConst(dp.initializer)) ? (stripConst(dp.initializer) as ts.StringLiteral).text : fail(e, `object literal of ${lu.name} without a literal ${lu.field}`);
            const v = lu.variants.find((x) => x.kind === lit) ?? fail(e, `${lu.name} has no variant ${lit}`);
            hit("tagged union literal", "Union.Variant(Struct { fields })");
            const uname = useDeclared(lu.name, lu.decl.getSourceFile().fileName, e);
            const sname = useDeclared(v.name, lu.decl.getSourceFile().fileName, e);
            const vfields = v.members.filter(ts.isPropertySignature).filter((m) => (m.name as ts.Identifier).text !== lu.field).sort(moveOrder(o)).map((m) => {
              const fname = (m.name as ts.Identifier).text;
              const prop = o.properties.find((p) => (p.name as ts.Identifier).text === fname);
              const pt = checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!);
              const conv1 = astModel.boxed.has(m) && !isOptionT(pt) ? heapConv : ownConv;
              let val = !prop ? "Option.None" : m.type && isPrimUnion(m.type) ? primConv(ts.isShorthandPropertyAssignment(prop) ? prop.name : (prop as ts.PropertyAssignment).initializer) : ts.isShorthandPropertyAssignment(prop) ? conv1(prop.name, pt) : conv1((prop as ts.PropertyAssignment).initializer, pt);
              if (astModel.boxed.has(m)) {
                if (!isOptionT(pt)) val = `Heap(${val})`;
                else if (prop) {
                  const pv = ts.isShorthandPropertyAssignment(prop) ? prop.name : (prop as ts.PropertyAssignment).initializer;
                  if (isUndefinedId(unparen(pv)) || unparen(pv).kind === ts.SyntaxKind.NullKeyword) val = "Option.None";
                  else if (isOptionT(tOf(pv))) val = `${useRuntime("optBox", e)}<${ty(checker.getNonNullableType(pt), e)}>(${val})`;
                  else val = `Option.Some(Heap(${heapConv(pv, checker.getNonNullableType(pt))}))`;
                }
              }
              return `${safeId(fname)}: ${val}`;
            });
            if (astModel.identity.has(v.name)) vfields.unshift(`${ID_FIELD}: ${useRuntime("ts2miloNextId", e)}()`);
            return `${uname}.${pascal(v.kind)}(${sname} { ${vfields.join(", ")} })`;
          }
          const d = t.symbol?.declarations?.[0] as ts.InterfaceDeclaration | ts.TypeLiteralNode | undefined;
          if (!d || !(ts.isInterfaceDeclaration(d) || (ts.isTypeLiteralNode(d) && anonStructs.has(d)))) fail(o, "object literal whose contextual type is not a named interface");
          hit("object literal", "struct literal, missing optionals are Option.None");
          const name = ts.isInterfaceDeclaration(d!) ? useDeclared(d.name.text, d.getSourceFile().fileName, e) : ty(t, e);
          // An AST struct has no field for a single-literal type (its `kind: "ImportDecl"` tag): the Milo struct itself is the tag.
          const tagOnly = (m: ts.PropertySignature) => ts.isInterfaceDeclaration(d!) && d.getSourceFile().fileName === astFile && astModel.ifaces.has(d.name.text) && !!m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal);
          // A field the Milo AST dropped (a type with no mapping, e.g. a Map of a non-AST class) is not initialised.
          const dropped = (m: ts.PropertySignature) => ts.isInterfaceDeclaration(d!) && !!report.ast?.dropped.some((x) => x.iface === d.name.text && x.field === (m.name as ts.Identifier).text);
          // A literal member with no property signature behind it (an interface method such as `error(msg) {..}` supplied as a
          // callback) has no struct field: dropping it silently would lose behavior.
          const sigNames = new Set(d!.members.filter(ts.isPropertySignature).map((m) => (m.name as ts.Identifier).text));
          for (const p of o.properties) if (!p.name || !sigNames.has((p.name as ts.Identifier).text)) fail(p, `object literal member ${p.name?.getText() ?? "(spread)"} has no field in ${name}: an interface method or callback member would be silently dropped`);
          const fields = d!.members.filter(ts.isPropertySignature).filter((m) => !tagOnly(m) && !dropped(m)).sort(moveOrder(o)).map((m) => {
            const fname = (m.name as ts.Identifier).text;
            const prop = o.properties.find((p) => (p.name as ts.Identifier).text === fname);
            const pt = checker.getTypeOfSymbol(checker.getPropertyOfType(t, fname)!);
            let v = !prop ? "Option.None" : m.type && isPrimUnion(m.type) ? primConv(ts.isShorthandPropertyAssignment(prop) ? prop.name : (prop as ts.PropertyAssignment).initializer) : ts.isShorthandPropertyAssignment(prop) ? ownConv(prop.name, pt) : ownConv((prop as ts.PropertyAssignment).initializer, pt);
            // A boxed AST field stores a Heap: Option<Heap<T>> for an optional one.
            if (prop && ts.isInterfaceDeclaration(d!) && astModel.boxed.has(m)) {
              const val = ts.isShorthandPropertyAssignment(prop) ? prop.name : (prop as ts.PropertyAssignment).initializer;
              if (!isOptionT(pt)) v = `Heap(${v})`;
              else if (isUndefinedId(unparen(val)) || unparen(val).kind === ts.SyntaxKind.NullKeyword) v = "Option.None";
              else if (isOptionT(tOf(val))) v = `${useRuntime("optBox", e)}<${ty(checker.getNonNullableType(pt), e)}>(${v})`;
              else if (!isUndefinedId(unparen(val)) && unparen(val).kind !== ts.SyntaxKind.NullKeyword) v = `Option.Some(Heap(${heapConv(val, checker.getNonNullableType(pt))}))`;
            }
            return `${safeId(fname)}: ${v}`;
          });
          if (ts.isInterfaceDeclaration(d!) && ((astModel.identity.has(d.name.text) && inputSet.has(d.getSourceFile().fileName)) || RUNTIME_OWNED.has(d.name.text))) fields.unshift(`${ID_FIELD}: ${useRuntime("ts2miloNextId", e)}()`);
          return `${name} { ${fields.join(", ")} }`;
        }
        case ts.SyntaxKind.ArrayLiteralExpression: {
          const a = e as ts.ArrayLiteralExpression;
          if (a.elements.length === 0) return want && checker.isArrayType(want) && boxedFieldInit ? `${ty(want, e)}.new()` : "Vec.new()";
          const et = want && checker.isArrayType(want) ? checker.getTypeArguments(want as ts.TypeReference)[0] : undefined;
          // `[...set]` of a scalar-element Set: its elements as a Vec, in slot order, not insertion order.
          if (a.elements.length === 1 && ts.isSpreadElement(a.elements[0])) {
            const st = tOf(a.elements[0].expression);
            const el = st.symbol && (st.symbol.name === "Set" || st.symbol.name === "ReadonlySet") ? checker.getTypeArguments(st as ts.TypeReference)[0] : null;
            if (el && isCopyT(el)) { hit("[...set]", "Set.toVec()"); return `${ex(a.elements[0].expression)}.toVec()`; }
          }
          // `[...xs, y, ...zs]` of scalar elements: each spread becomes a Vec (an array is cloned, a Set or Map.keys()/values() is
          // read in slot order), joined by vecConcat. Non-scalar elements would need a per-element clone: refused.
          if (a.elements.length > 1 && a.elements.some(ts.isSpreadElement)) {
            const lt = checker.getTypeArguments(tOf(e) as ts.TypeReference)[0];
            if (!checker.isArrayType(tOf(e)) || !isCopyT(lt)) fail(a, "array spread whose elements are not numbers, booleans or strings");
            const spreadVec = (x: ts.Expression): string => {
              const st = tOf(x);
              const mk = mapValuesRecv(checker, x, "keys");
              const mv = mapValuesRecv(checker, x) ?? mk;
              if (mv) return `${ex(mv)}.${mk ? "keys" : "values"}()`;
              if (st.symbol && (st.symbol.name === "Set" || st.symbol.name === "ReadonlySet")) return `${ex(x)}.toVec()`;
              if (checker.isArrayType(st)) return `${ex(x)}.clone()`;
              return fail(x, "spread of something other than an array, a Set or Map.keys()/values()");
            };
            hit("array spread", "scalar spreads joined by vecConcat");
            const lty = ty(lt, e);
            const parts = a.elements.map((x) => (ts.isSpreadElement(x) ? spreadVec(x.expression) : `${useRuntime("vec1", e)}<${lty}>(${ownConv(x, lt)})`));
            return parts.slice(1).reduce((acc, p) => `${useRuntime("vecConcat", e)}(${acc}, ${p})`, parts[0]);
          }
          if (boxedFieldInit && et && a.elements.length === 1 && !ts.isSpreadElement(a.elements[0])) { boxedFieldInit = false; return `${useRuntime("vec1", e)}<${heapElem(et, "X") !== "X" ? `Heap<${ty(et, e)}>` : ty(et, e)}>(${heapElem(et, ownConv(a.elements[0], et))})`; }
          return `[${a.elements.map((x) => (et ? heapElem(et, ownConv(x, et)) : ownConv(x, et))).join(", ")}]`;
        }
      }
      return fail(e, `expression ${ts.SyntaxKind[e.kind]}`);
    };

    // ---- statements ----
    const retWrap = (fn: ts.FunctionLikeDeclaration) => throwing.has(fn) && !isThrower(fn);
    const varDecls = (list: ts.VariableDeclarationList) => {
          for (const d of list.declarations) {
            const sym = symOf(d.name as ts.Identifier)!;
            const t = checker.getTypeAtLocation(d.name);
            const hoist = hoistedClosure(checker, d);
            if (typeof hoist === "string") fail(d, hoist);
            if (hoist) {
              hit("hoisted const closure", "let f = (params) => closure literal; only called by name");
              const nm = declareLocal(sym, (d.name as ts.Identifier).text);
              const arrow = hoist as ts.ArrowFunction;
              line(`let ${nm} = ${closureLit(arrow, arrow.parameters.map((p) => ({ p, ref: !isScalar(checker.getTypeAtLocation(p)) })))}`);
              continue;
            }
            const isVar = mutated.has(sym) || !d.initializer;
            // A local nothing mutates may share a clone of a recursive value: no write can tell the copy from the TS shared reference.
            if (!isVar) roDest = true;
            const init = d.initializer ? ownConv(d.initializer, t) : defaultOf(t, d);
            roDest = false;
            hit("const/let", "let, or var when reassigned or mutated");
            const name = declareLocal(sym, (d.name as ts.Identifier).text);
            line(`${isVar ? "var" : "let"} ${name}: ${ty(t, d)} = ${init}`);
          }
    };
    const stmt = (s: ts.Statement) => {
      switch (s.kind) {
        case ts.SyntaxKind.EmptyStatement: return;
        case ts.SyntaxKind.Block: { line("{"); ind++; block(s as ts.Block); ind--; line("}"); return; }
        case ts.SyntaxKind.VariableStatement: varDecls((s as ts.VariableStatement).declarationList); return;
        case ts.SyntaxKind.IfStatement: {
          let n: ts.Statement | undefined = s;
          let first = true;
          while (n && ts.isIfStatement(n)) {
            const g = ifHead(n.expression);
            if (g.heads.length > 1 && (n.elseStatement || !first)) fail(n, "guard chain in an else-if or with an else");
            line(`${first ? "" : "} else "}${g.heads[0]}`);
            first = false;
            ind++;
            for (const h of g.heads.slice(1)) { line(h); ind++; }
            body(n.thenStatement);
            for (let i = 1; i < g.heads.length; i++) { ind--; line("}"); }
            ind--;
            g.undo();
            n = n.elseStatement;
          }
          if (n) { line("} else {"); ind++; body(n); ind--; }
          line("}");
          return;
        }
        case ts.SyntaxKind.SwitchStatement: {
          const sw = s as ts.SwitchStatement;
          const mode = switchHandled(checker, sw) ?? fail(sw, "switch outside the subset");
          hit("switch", mode === "kind" ? "else-if chain of kind guards" : "else-if chain of ==");
          const x = unparen(sw.expression);
          // Stacked empty labels (`case A: case B:`) share the next clause's body.
          const groups: { labels: ts.Expression[]; clause: ts.CaseOrDefaultClause; isDefault: boolean }[] = [];
          let pending: ts.Expression[] = [];
          for (const c of sw.caseBlock.clauses) {
            if (ts.isCaseClause(c)) pending.push(c.expression);
            if (c.statements.length === 0 && c !== sw.caseBlock.clauses[sw.caseBlock.clauses.length - 1]) continue;
            groups.push({ labels: pending, clause: c, isDefault: ts.isDefaultClause(c) });
            pending = [];
          }
          groups.sort((a, b) => Number(a.isDefault) - Number(b.isDefault));
          const emitBody = (c: ts.CaseOrDefaultClause) => { push(); ind++; for (const st of clauseBody(c)) stmt(st); ind--; pop(); };
          let first = true;
          for (const g of groups) {
            if (g.isDefault) {
              line(first ? "{" : "} else {");
              emitBody(g.clause);
              first = false;
              continue;
            }
            const open = first ? "" : "} else ";
            if (mode === "kind") {
              const tu = guardUnion(checker, (x as ts.PropertyAccessExpression).expression)!;
              const scrut = (x as ts.PropertyAccessExpression).expression;
              const useName = useDeclared(tu.name, tu.decl.getSourceFile().fileName, g.clause);
              const key = scrut.getText();
              const name = fresh(key);
              line(`${open}if let ${useName}.${pascal((g.labels[0] as ts.StringLiteral).text)}(${name}) = ${ex(scrut)} {`);
              const saved = narrow.get(key);
              narrow.set(key, { name, deref: false });
              emitBody(g.clause);
              if (saved) narrow.set(key, saved); else narrow.delete(key);
            } else {
              const xt = tOf(x);
              const tests = g.labels.map((l) => {
                const lt = tOf(l);
                return `(${ex(x, litsOf(lt) ? lt : undefined)} == ${ex(l, litsOf(xt) ? xt : undefined)})`;
              });
              line(`${open}if ${tests.join(" || ")} {`);
              emitBody(g.clause);
            }
            first = false;
          }
          if (!first) line("}");
          return;
        }
        case ts.SyntaxKind.ForOfStatement: {
          const f = s as ts.ForOfStatement;
          if (!ts.isVariableDeclarationList(f.initializer) || !ts.isIdentifier(f.initializer.declarations[0].name)) fail(f, "for-of with a destructuring or non-declaration head");
          // Map.values() / Map.keys(): a Vec copy in slot order, not insertion order (a body that depends on the order is wrong).
          const mk = mapValuesRecv(checker, f.expression, "keys");
          const mv = mapValuesRecv(checker, f.expression) ?? mk;
          if (!mv && !checker.isArrayType(tOf(f.expression))) fail(f, "for-of over something other than an array");
          const d = (f.initializer as ts.VariableDeclarationList).declarations[0];
          const sym = symOf(d.name as ts.Identifier)!;
          const he = unparen(f.expression);
          if (!mv && ts.isBinaryExpression(he) && he.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && !forOfMutates(f)) roNullishLeft = unparen(he.left);
          const arr = mv ? `${ex(mv)}.${mk ? "keys" : "values"}()` : ex(f.expression);
          roNullishLeft = null;
          const el = mv ? checker.getTypeArguments(tOf(mv) as ts.TypeReference)[mk ? 0 : 1] : checker.getTypeArguments(tOf(f.expression) as ts.TypeReference)[0];
          hit("for-of over an array", "for x in array (borrowed elements)");
          push();
          const name = declareLocal(sym, (d.name as ts.Identifier).text);
          if (onCycle(isOptionT(el) ? checker.getNonNullableType(el) : el)) elemBoxed.add(sym);
          if (!mv && forOfMutates(f) && arr.startsWith("(*")) {
            // The checker takes only a named place after `for x in &mut`, and a boxed field reads as `(*e.f)`:
            // walk it by index, with the loop variable standing for the indexed element. The step runs at the top
            // so a `continue` cannot skip it.
            const k = `${name}_at`;
            scopes[scopes.length - 1].set(sym, `${arr}[${k}]`);
            line(`var ${k}: i64 = -1`);
            line(`while ${k} + 1 < ${arr}.len {`);
            ind++; line(`${k} += 1`); body(f.statement); ind--;
          } else {
          line(`for ${name} in ${!mv && forOfMutates(f) ? "&mut " : ""}${arr} {`);
          ind++; body(f.statement); ind--;
          }
          line("}");
          pop();
          afterLoop();
          return;
        }
        case ts.SyntaxKind.ForStatement: {
          const f = s as ts.ForStatement;
          // A `let` in the head is a fresh binding per iteration in TS; a closure capturing it would see that, a while loop's variable would not.
          const headSyms = new Set<ts.Symbol>();
          if (f.initializer && ts.isVariableDeclarationList(f.initializer)) {
            if (!(f.initializer.flags & ts.NodeFlags.Let)) fail(f, "for with a var or const head");
            for (const d of f.initializer.declarations) { if (!ts.isIdentifier(d.name) || !d.initializer) fail(d, "for head declaration without a plain initializer"); else headSyms.add(symOf(d.name)!); }
          } else if (f.initializer && !(ts.isBinaryExpression(f.initializer) || ts.isPostfixUnaryExpression(f.initializer) || ts.isPrefixUnaryExpression(f.initializer) || ts.isCallExpression(f.initializer))) fail(f, "for head other than a let list or a statement expression");
          if (headSyms.size) {
            const walkCap = (n: ts.Node, nested: boolean) => {
              if (nested && ts.isIdentifier(n)) { const sy = checker.getSymbolAtLocation(n); if (sy && headSyms.has(sy)) fail(n, "for loop variable captured by a closure (per-iteration binding)"); }
              ts.forEachChild(n, (c) => walkCap(c, nested || ts.isFunctionLike(c)));
            };
            walkCap(f, false);
          }
          hit("C-style for", "init; while cond { body; step }, with the step also run before each continue of this loop");
          if (f.initializer) { if (ts.isVariableDeclarationList(f.initializer)) varDecls(f.initializer); else exprStmt(f.initializer); }
          line(`while ${f.condition ? cond(f.condition) : "true"} {`);
          ind++;
          body(f.statement);
          // After a body that ends in an exit the step is dead code.
          const lastS = ts.isBlock(f.statement) ? f.statement.statements[f.statement.statements.length - 1] : f.statement;
          if (f.incrementor && !(lastS && endsBlock(lastS))) exprStmt(f.incrementor);
          ind--;
          line("}");
          afterLoop();
          return;
        }
        case ts.SyntaxKind.WhileStatement: {
          const w = s as ts.WhileStatement;
          line(`while ${cond(w.expression)} {`);
          ind++; body(w.statement); ind--;
          line("}");
          afterLoop();
          return;
        }
        case ts.SyntaxKind.BreakStatement: case ts.SyntaxKind.ContinueStatement: {
          // Inside a try (emitted as a one-shot loop) a break or continue aimed at an outer loop would hit that loop instead.
          for (let p: ts.Node | undefined = s.parent; p && !ts.isFunctionLike(p); p = p.parent) {
            if (ts.isIterationStatement(p, false) || ts.isSwitchStatement(p)) break;
            if (ts.isTryStatement(p)) fail(s, "break or continue out of a try block");
          }
          if ((s as ts.BreakOrContinueStatement).label) fail(s, "labeled break or continue");
          if (s.kind === ts.SyntaxKind.ContinueStatement) {
            let lp: ts.Node | undefined = s.parent;
            while (lp && !ts.isIterationStatement(lp, false)) lp = lp.parent;
            if (lp && ts.isForStatement(lp) && lp.incrementor) exprStmt(lp.incrementor);
          }
          line(s.kind === ts.SyntaxKind.BreakStatement ? "break" : "continue");
          return;
        }
        case ts.SyntaxKind.TryStatement: {
          const t = s as ts.TryStatement;
          if (t.finallyBlock) fail(t, "try with finally");
          if (!t.catchClause) fail(t, "try without catch");
          const bound = t.catchClause!.variableDeclaration;
          if (bound && !ts.isIdentifier(bound.name)) fail(t, "catch with a destructured binding");
          hit("try/catch", "one-shot while loop, failure flag, catch body under if flag");
          const flag = fresh("failed");
          line(`var ${flag}: bool = false`);
          const errVar = bound ? fresh("caught") : "";
          if (bound) line(`var ${errVar}: Option<${errNameFor(curFn!)}> = Option.None`);
          line("while true {");
          ind++;
          tryFlags.push(flag);
          tryErr.push(errVar);
          try { body(t.tryBlock); } finally { tryFlags.pop(); tryErr.pop(); }
          const tl = t.tryBlock.statements[t.tryBlock.statements.length - 1];
          if (!tl || !endsBlock(tl)) line("break");
          ind--;
          line("}");
          line(`if ${flag} {`);
          ind++;
          if (bound) {
            scopes.push(new Map()); usedNames.push(new Set());
            const en = declareLocal(symOf(bound.name as ts.Identifier)!, (bound.name as ts.Identifier).text);
            // `failed` is only set together with the recorded error, so the unwrap never traps.
            line(`let ${en} = ${errVar}!`);
            body(t.catchClause!.block);
            scopes.pop(); usedNames.pop();
          } else body(t.catchClause!.block);
          ind--;
          line("}");
          // Both the try body and the catch end in return/throw: nothing falls out the bottom, but Milo cannot see that through the flag.
          const cs = t.catchClause!.block.statements;
          if (tl && endsBlock(tl) && cs.length && endsBlock(cs[cs.length - 1])) { line("exit(70)"); line("while true {"); line("}"); }
          return;
        }
        case ts.SyntaxKind.ReturnStatement: {
          const r = s as ts.ReturnStatement;
          const rt = curFn ? checker.getSignatureFromDeclaration(curFn)!.getReturnType() : undefined;
          if (curFn && retWrap(curFn)) line(`return Result.Ok(${r.expression ? ownConv(r.expression, rt) : "true"})`);
          else line(r.expression ? `return ${ownConv(r.expression, rt)}` : "return");
          return;
        }
        case ts.SyntaxKind.ThrowStatement: {
          const t = s as ts.ThrowStatement;
          hit("throw", "Result.Err (a never-returning function returns the error itself)");
          // With several thrown classes the value is wrapped in its variant of the program-wide enum.
          const thrown = multiErr && !isCatchVar(t.expression) ? `${std(THROWN_ENUM)}.${thrownName(checker.getTypeAtLocation(t.expression).symbol)}(${ex(t.expression)})` : ex(t.expression);
          if (tryFlags.length) { if (tryErr[tryErr.length - 1]) line(recordErr(thrown).trim().replace(/;$/, "")); line(`${tryFlags[tryFlags.length - 1]} = true`); line("break"); return; }
          line(curFn && isThrower(curFn) ? `return ${thrown}` : `return Result.Err(${thrown})`);
          return;
        }
        case ts.SyntaxKind.ExpressionStatement: return exprStmt((s as ts.ExpressionStatement).expression);
      }
      fail(s, `statement ${ts.SyntaxKind[s.kind]}`);
    };
    // The opening lines of an if: each narrowing guard among the `&&` conjuncts becomes a nested
    // `if let` (binding set until `undo`), and the plain conjuncts around them an ordinary `if`.
    const unparen = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? unparen(e.expression) : e);
    const conjuncts = (e: ts.Expression): ts.Expression[] => {
      e = unparen(e);
      return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
    };
    const ifHead = (test: ts.Expression): { heads: string[]; undo: () => void } => {
      const heads: string[] = [];
      const saved: [string, { name: string; deref: boolean } | undefined][] = [];
      let plain: string[] = [];
      const flush = () => { if (plain.length) { heads.push(`if ${plain.join(" && ")} {`); plain = []; } };
      for (const c of conjuncts(test)) {
        let bind: { scrut: ts.Expression; pat: (n: string) => string; deref: boolean; what: string; then?: (code: string) => string; outer?: (n: string) => string } | null = null;
        const tk = truthyHandled(checker, c);
        if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isStringLiteral(c.right)) {
          const tu = discriminantRead(checker, c.left);
          if (tu && ts.isPropertyAccessExpression(c.left)) {
            const useName = useDeclared(tu.name, tu.decl.getSourceFile().fileName, c);
            const kind = c.right.text;
            bind = { scrut: c.left.expression, pat: (n) => `${useName}.${pascal(kind)}(${n})`, deref: false, what: "tagged union kind guard" };
            // A leaf of a union of unions is reached through its member: Node.Expr(o) first, then Expr.Call(n).
            const via = tu.members?.find((m) => m.name === tu.variants.find((v) => v.kind === kind)?.via);
            if (via?.union) {
              const inner = useDeclared(via.union.name, via.union.decl.getSourceFile().fileName, c);
              bind.outer = (o) => `${useName}.${via.name}(${o})`;
              bind.pat = (n) => `${inner}.${pascal(kind)}(${n})`;
            } else if (via) bind.pat = (n) => `${useName}.${via.name}(${n})`;
          }
        } else if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && (isUndefinedId(c.right) || c.right.kind === ts.SyntaxKind.NullKeyword)) {
          bind = { scrut: c.left, pat: (n) => `Option.Some(${n})`, deref: boxedPlace(c.left), what: "undefined guard" };
        }
        else if (tk && tk !== "str" && tk !== "num") {
          // `if (x)` on an optional narrows x to its payload, so it binds like `x !== undefined`;
          // the payload's own truthiness (non-empty, non-zero, true) is tested right after.
          const then = tk === "optStr" ? (code: string) => truthText("str", code) : tk === "optNum" ? (code: string) => truthText("num", code) : tk === "optBool" ? (code: string) => code : undefined;
          bind = { scrut: c, pat: (n) => `Option.Some(${n})`, deref: boxedPlace(c), what: "truthiness guard", then };
        }
        if (!bind) { plain.push(cond(c)); continue; }
        flush();
        hit(bind.what, "if let binding the payload, which replaces the guarded expression inside");
        const key = bind.scrut.getText();
        const name = fresh(key);
        guardScrut = bind.scrut;
        let scrutCode = ex(bind.scrut);
        guardScrut = null;
        // Binding a string payload out of a local Option moves the local; the rest of the block may still read it.
        const sp = unparen(bind.scrut);
        if (ts.isIdentifier(sp) && !bind.outer && !bind.deref && isOptionT(tOf(sp)) && checker.getNonNullableType(tOf(sp)).flags & ts.TypeFlags.StringLike && !litsOf(checker.getNonNullableType(tOf(sp)))) scrutCode += ".clone()";
        if (bind.outer) { const o = fresh(key); heads.push(`if let ${bind.outer(o)} = ${scrutCode} {`); scrutCode = o; }
        heads.push(`if let ${bind.pat(name)} = ${scrutCode} {`);
        saved.push([key, narrow.get(key)]);
        narrow.set(key, { name, deref: bind.deref });
        if (bind.then) plain.push(bind.then(ex(bind.scrut)));
      }
      flush();
      return { heads, undo: () => { for (const [k, v] of saved.reverse()) { if (v) narrow.set(k, v); else narrow.delete(k); } } };
    };
    const body = (s: ts.Statement) => { push(); if (ts.isBlock(s)) block(s); else stmt(s); pop(); };
    // `if (!x) return` / `if (x === undefined) throw ...` on an optional place: the rest of the block
    // reads x as its payload, so the exit becomes `let Option.Some(x_2) = x else { exit }`.
    const earlyExitNarrow = (s: ts.Statement): { x: ts.Expression; payload?: "str" | "num" | "optBool"; kind?: { tu: NonNullable<ReturnType<typeof discriminantRead>>; k: string } } | null => {
      if (!ts.isIfStatement(s) || s.elseStatement) return null;
      const last = ts.isBlock(s.thenStatement) ? s.thenStatement.statements[s.thenStatement.statements.length - 1] : s.thenStatement;
      if (!last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isContinueStatement(last) || ts.isBreakStatement(last))) return null;
      let c = unparen(s.expression);
      let x: ts.Expression | null = null;
      if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && ts.isStringLiteral(c.right) && ts.isPropertyAccessExpression(c.left)) {
        const tu = discriminantRead(checker, c.left);
        const sc = tu ? unparen(c.left.expression) : null;
        return tu && sc && (ts.isIdentifier(sc) || ts.isPropertyAccessExpression(sc)) ? { x: sc, kind: { tu, k: c.right.text } } : null;
      }
      if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) {
        x = unparen(c.operand);
        const nn = isOptionT(tOf(x)) ? checker.getNonNullableType(tOf(x)) : null;
        if (!nn || litsOf(nn)) return null;
        // `if (!s) exit` on string | undefined: absent or empty exits, so the rest reads the payload.
        if (nn.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) {
          const pk = truthyKind(tOf(x));
          const pay = pk === "optStr" ? "str" : pk === "optNum" ? "num" : pk === "optBool" ? "optBool" : null;
          return pay && (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && !isChainMember(x) ? { x, payload: pay } : null;
        }
      } else if (ts.isBinaryExpression(c) && (c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) && (isUndefinedId(c.right) || c.right.kind === ts.SyntaxKind.NullKeyword)) {
        x = unparen(c.left);
        if (!isOptionT(tOf(x))) return null;
      }
      return x && (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && !isChainMember(x) ? { x } : null;
    };
    const endsBlock = (s: ts.Statement): boolean => {
      if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s)) return true;
      if (!ts.isExpressionStatement(s)) return false;
      const e = unparen(s.expression);
      if (!ts.isCallExpression(e)) return false;
      const d = declOf(e);
      return !!d && isThrower(d);
    };
    const block = (b: ts.Block) => {
      const saved: [string, { name: string; deref: boolean } | undefined][] = [];
      for (const s of b.statements) {
        const en = earlyExitNarrow(s);
        // What follows an exit is dead code in TS; Milo rejects it ("unreachable code"). A call of a never-returning
        // function is emitted as a return (or a break out of the try), so it ends the block like return/throw.
        if (!en) { stmt(s); if (endsBlock(s)) break; continue; }
        const x = en.x;
        const key = x.getText();
        const name = fresh(key);
        hit("early-exit guard", "let Variant(x) = x else { exit }; the rest of the block reads the payload");
        guardScrut = x;
        let scrut = ex(x);
        guardScrut = null;
        let pat = `Option.Some(${name})`;
        if (en.kind) {
          const kp = kindPattern(en.kind.tu, en.kind.k, s);
          if (kp.outer) { const o = fresh(key); line(`let ${kp.outer(o)} = ${scrut} else {`); ind++; body((s as ts.IfStatement).thenStatement); ind--; line("}"); scrut = o; }
          pat = kp.pat(name);
        }
        line(`let ${pat} = ${scrut} else {`);
        ind++; body((s as ts.IfStatement).thenStatement); ind--;
        line("}");
        if (en.payload) {
          line(`if !${truthText(en.payload, name)} {`);
          ind++; body((s as ts.IfStatement).thenStatement); ind--;
          line("}");
        }
        saved.push([key, narrow.get(key)]);
        narrow.set(key, { name, deref: en.kind ? false : boxedPlace(x) });
      }
      for (const [k, v] of saved.reverse()) { if (v) narrow.set(k, v); else narrow.delete(k); }
    };
    const exprStmt = (e: ts.Expression) => {
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        const lt = tOf(e.left);
        // A Milo parameter is immutable (or a borrow): rebinding one needs a local copy, which is not emitted yet.
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(e.left) && checker.getSymbolAtLocation(e.left)?.declarations?.some((d) => ts.isParameter(d))) fail(e, `assignment to the parameter ${e.left.text}`);
        if (op === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(e.left) && !unionOfType(checker, tOf(e.left.expression))) {
          const bd = checker.getSymbolAtLocation(e.left.name)?.declarations?.[0];
          if (bd && ts.isPropertySignature(bd) && astModel.boxed.has(bd)) {
            // A boxed field stores a Heap: Option<Heap<T>> for an optional one.
            if (!isOptionT(lt)) {
              // Written through the box (`*n.e = v`): the Heap stays, its contents are replaced.
              hit("boxed field", "assigned through the Heap, *n.f = v");
              line(`${ex(e.left)} = ${ownConv(e.right, lt)}`);
              return;
            }
            hit("boxed optional field", "assigned as Option.Some(Heap(v)) or Option.None");
            const rhs = unparen(e.right);
            line(`${ex(e.left)} = ${isUndefinedId(rhs) || rhs.kind === ts.SyntaxKind.NullKeyword ? "Option.None" : `Option.Some(Heap(${heapConv(e.right, checker.getNonNullableType(lt))}))`}`);
            return;
          }
        }
        if (op === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(e.left)) {
          const tu = unionOfType(checker, tOf(e.left.expression));
          if (tu) {
            hit("tagged union common field", "assigned through the generated setter Union_set_field(&mut u, v)");
            line(`${useDeclared(`${tu.name}_set_${e.left.name.text}`, tu.decl.getSourceFile().fileName, e)}(&mut ${ex(e.left.expression)}, ${ownConv(e.right, lt)})`);
            return;
          }
        }
        if (op === ts.SyntaxKind.EqualsToken) { line(`${ex(e.left)} = ${ownConv(e.right, lt)}`); return; }
        if (op === ts.SyntaxKind.PlusEqualsToken && isStr(e.left)) { hit("string +=", "pushStr in place"); line(`${ex(e.left)}.pushStr(${ex(e.right)})`); return; }
        // Only the compound assignments Milo has; `??=`, `||=`, `&&=`, `**=` and `>>>=` would be emitted verbatim.
        const MILO_COMPOUND = new Set([ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken]);
        if (!MILO_COMPOUND.has(op)) fail(e, `assignment operator ${e.operatorToken.getText()}`);
        line(`${ex(e.left)} ${e.operatorToken.getText()} ${ex(e.right)}`);
        return;
      }
      if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
        hit("x++ / x--", "x += 1 / x -= 1");
        line(`${ex(e.operand)} ${e.operator === ts.SyntaxKind.PlusPlusToken ? "+=" : "-="} 1`);
        return;
      }
      if (isReplaceNode(e)) {
        const target = e.arguments[0];
        const declared = checker.getTypeAtLocation(declOf(e)!.parameters[0]);
        const tu = unionOfType(checker, declared);
        if (!tu) return fail(e, "replaceNode of a value that is not a tagged union");
        if (narrow.has(target.getText()) || !ts.isIdentifier(unparen(target))) return fail(e, "replaceNode through a guard-narrowed or non-parameter place");
        hit("node replacement", "assigned through the `&mut` place, keeping the node's hidden id");
        const file = tu.decl.getSourceFile().fileName;
        const place = ex(target);
        const keep = astModel.identity.has(tu.name) ? fresh("id") : "";
        if (keep) line(`let ${keep} = ${useDeclared(`${tu.name}_${ID_FIELD}`, file, e)}(${place})`);
        line(`${place} = ${ownConv(e.arguments[1], declared)}`);
        if (keep) line(`${useDeclared(`${tu.name}_set_${ID_FIELD}`, file, e)}(&mut ${place}, ${keep})`);
        return;
      }
      if (ts.isCallExpression(e)) {
        const d = declOf(e);
        if (d && isThrower(d)) {
          if (closureDepth > 0) fail(e, "closure (loop tier) calling a function that throws");
          if (tryFlags.length) { if (tryErr[tryErr.length - 1]) line(recordErr(callEx(e)).trim().replace(/;$/, "")); line(`${tryFlags[tryFlags.length - 1]} = true`); line("break"); return; }
          // A never-returning function's own return value is the error, so passing one on is a plain return.
          line(curFn && isThrower(curFn) ? `return ${callEx(e)}` : `return Result.Err(${callEx(e)})`);
          return;
        }
        line(callEx(e));
        return;
      }
      fail(e, `expression statement ${ts.SyntaxKind[e.kind]}`);
    };

    // ---- declarations ----
    const overridesDir = opts.overridesDir ?? join(ROOT, "scripts/ts2milo/overrides");
    const fileBase = basename(file).replace(/\.ts$/, "");
    // An optional parameter that every call site feeds a boxed optional field is an Option<Heap<T>> in Milo,
    // taking the field as is: a `&mut` view of the place, so the callee's `if let` binds the payload `&mut`
    // (a match on a field place binds only `&`, and unboxing the field would copy the node).
    let heapOpt: Set<ts.Node> | undefined;
    heapOptParam = (p) => {
      if (!heapOpt) {
        const good = new Set<ts.Node>(), bad = new Set<ts.Node>();
        for (const fn of allFns) walkBody(fn.body!, (n) => {
          if (!ts.isCallExpression(n)) return;
          const decl = checker.getResolvedSignature(n)?.declaration as ts.SignatureDeclaration | undefined;
          decl?.parameters.forEach((q, i) => {
            const a = n.arguments[i];
            if (a) (isBoxedOptField(a) ? good : bad).add(q);
          });
        });
        for (const q of bad) good.delete(q);
        heapOpt = good;
      }
      return heapOpt.has(p) && isOptionT(checker.getTypeAtLocation(p));
    };
    const fnHeader = (fn: ts.FunctionLikeDeclaration, name: string, selfKind: "" | "&" | "&mut "): string => {
      const sig = checker.getSignatureFromDeclaration(fn)!;
      // Parameters other than numbers, bools and unit enums are borrowed; one the body writes
      // through is `&mut`.
      const ps = fn.parameters.map((p, i) => {
        const t = checker.getTypeAtLocation(p);
        const borrow = isScalar(t) ? "" : mutParams.get(fn)?.has(i) ? "&mut " : "&";
        const heapOpt = heapOptParam(p);
        const name = declareLocal(symOf(p.name as ts.Identifier)!, (p.name as ts.Identifier).text);
        if (heapOpt) { elemBoxed.add(symOf(p.name as ts.Identifier)!); return `${name}: ${borrow}Option<Heap<${ty(checker.getNonNullableType(t), p)}>>`; }
        return `${name}: ${borrow}${ty(t, p)}`;
      });
      if (selfKind) ps.unshift(`self: ${selfKind}${(fn.parent as ts.ClassDeclaration).name!.text}`);
      let r = sig.getReturnType();
      let rs = isThrower(fn) ? errNameFor(fn) : ty(r, fn);
      if (retWrap(fn)) rs = `Result<${r.flags & ts.TypeFlags.Void ? "bool" : rs}, ${errNameFor(fn)}>`;
      return `fn ${safeId(name)}(${ps.join(", ")})${rs === "void" ? "" : `: ${rs}`}`;
    };
    // The error class a function throws: resolved through the first `throw new X` in the program.
    let errDeclFile: string | undefined;
    const findErrName = (fn: ts.Node): ts.Identifier => {
      let id: ts.Identifier | undefined;
      for (const f of allFns) walkBody(f.body!, (n) => { if (!id && ts.isThrowStatement(n) && ts.isNewExpression(n.expression) && ts.isIdentifier(n.expression.expression)) id = n.expression.expression; });
      return id ?? fail(fn, "cannot find the thrown class");
    };
    const errNameFor = (fn: ts.Node) => {
      if (multiErr) return std(THROWN_ENUM);
      const id = findErrName(fn);
      errDeclFile = symDeclFile(checker.getSymbolAtLocation(id));
      return useDeclared(errType, errDeclFile, fn);
    };
    // `@consumesThis` is a promise that the callee empties its receiver: refuse a caller that could observe that.
    const checkConsumesCall = (fn: ts.FunctionLikeDeclaration, n: ts.CallExpression) => {
      const d = declOf(n);
      if (!d || !ts.getJSDocTags(d).some((tg) => tg.tagName.text === "consumesThis") || !ts.isPropertyAccessExpression(n.expression)) return;
      let recv: ts.Expression = n.expression.expression;
      while (ts.isParenthesizedExpression(recv) || ts.isNonNullExpression(recv)) recv = recv.expression;
      // A fresh value (`new C(..).m()`, `f().m()`) has no other reader.
      if (ts.isNewExpression(recv) || ts.isCallExpression(recv)) return;
      const what = `@consumesThis method ${(d as ts.MethodDeclaration).name?.getText() ?? "?"} called on ${recv.getText()}`;
      if (!ts.isIdentifier(recv)) return fail(n, `${what}: the receiver is not a local the function owns`);
      const recvId = recv;
      const sy = symOf(recvId);
      const decl = sy?.valueDeclaration;
      if (!sy || !decl ||!ts.isVariableDeclaration(decl) || decl.getSourceFile() !== fn.getSourceFile() || decl.pos < fn.pos || decl.end > fn.end) return fail(n, `${what}: the receiver is not a local variable of this function`);
      // A loop that does not declare the receiver runs the call again on the emptied value.
      for (let p: ts.Node | undefined = n.parent; p && p !== fn; p = p.parent) {
        if ((ts.isForStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p)) && !(decl.pos >= p.pos && decl.end <= p.end)) fail(n, `${what}: inside a loop that outlives the receiver`);
      }
      walkBody(fn.body!, (m) => {
        if (ts.isIdentifier(m) && m !== recvId && m.text === recvId.text && m.pos >= n.end && symOf(m) === sy) fail(m, `${what}: the receiver is read after the call`);
      });
    };
    const prepareMutated = (fn: ts.FunctionLikeDeclaration) => {
      mutated = new Set();
      walkBody(fn.body!, (n) => {
        if (ts.isCallExpression(n)) checkConsumesCall(fn, n);
        const consider = (target: ts.Expression) => { const r = rootOf(target); if (ts.isIdentifier(r)) { const s = symOf(r); if (s) mutated.add(s); } };
        if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind)) consider(n.left);
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) consider(n.operand);
        if (ts.isForOfStatement(n) && forOfMutates(n)) consider(n.expression);
        if (ts.isCallExpression(n)) {
          const k = calleeKey(program, checker, n);
          if (k === "Array.push" || k === "Array.pop" || k === "Set.add" || k === "Map.set") consider((n.expression as ts.PropertyAccessExpression).expression);
          // A local lent to a `&mut` parameter, or the receiver of a mutating method, is a `var`.
          const d = declOf(n);
          const mp = d && mutParams.get(d);
          if (mp) n.arguments.forEach((a, j) => { if (mp.has(j)) consider(a); });
          if (d && mutating.has(d) && ts.isPropertyAccessExpression(n.expression)) consider(n.expression.expression);
        }
      });
    };
    const emitFn = (fn: ts.FunctionLikeDeclaration, name: string, isMethod: boolean, exported: boolean) => {
      // An overload signature has no body; only the implementation is emitted.
      if (!fn.body) return;
      if (name === "replaceNode" && ts.isFunctionDeclaration(fn) && !isMethod) return; // the intrinsic isReplaceNode translates at its call sites
      const ovPath = join(overridesDir, `${fileBase}.${name}.milo`);
      if (existsSync(ovPath)) {
        hit("override", "whole function replaced by hand");
        report.functions.push({ file: rel(file), name, override: true });
        for (const l of readFileSync(ovPath, "utf8").trimEnd().split("\n")) line(l);
        return;
      }
      report.functions.push({ file: rel(file), name, override: false });
      const mark = out.length, markInd = ind;
      try {
        const forced = forceStub.get(fn) ?? opts.stubNames?.get(`${rel(file)}::${name}`);
        if (forced) throw new Unsupported(forced);
        curFn = fn; narrow.clear(); /* a function that threw mid-guard never ran its undo */ scopes = []; usedNames = []; push();
        prepareMutated(fn);
        const hdr = fnHeader(fn, name, isMethod ? (mutating.has(fn) ? "&mut " : "&") : "");
        line(`${exported && !isMethod ? "pub " : ""}${hdr} {`);
        ind++;
        if (isThrower(fn)) hit("never-returning function", "returns the error value; callers `return Result.Err(call)`");
        block(fn.body as ts.Block);
        if (retWrap(fn) && (fn.type?.kind === ts.SyntaxKind.VoidKeyword)) line("return Result.Ok(true)");
        ind--;
        line("}");
      } catch (err) {
        let e = err as Error;
        if (!opts.lenient) throw e;
        if (!(e instanceof Unsupported) && process.env.TS2MILO_STACK) console.error((e as Error).stack); if (!(e instanceof Unsupported)) e = new Unsupported(`transpiler crash: ${(e as Error).message}`);
        out.length = mark; ind = markInd;
        report.stubs.push({ file: rel(file), name, reason: e.message });
        let hdr: string | null = null;
        const mkHdr = () => { scopes = []; usedNames = []; push(); return fnHeader(fn, name, isMethod ? (mutating.has(fn) ? "&mut " : "&") : ""); };
        try { hdr = mkHdr(); } catch (e2) { if (!(e2 instanceof Unsupported)) throw e2; opaqueFallback = true; try { hdr = mkHdr(); } catch (e3) { if (!(e3 instanceof Unsupported)) throw e3; } finally { opaqueFallback = false; } }
        // A signature the transpiler cannot type is left out; its callers then fail to compile, which is the honest count.
        if (hdr !== null) {
          line(`${exported && !isMethod ? "pub " : ""}${hdr} {`);
          // exit never returns; the empty loop only satisfies the checker's "every path returns".
          line(`    eprint(${JSON.stringify("ts2milo stub: " + e.message)})`);
          for (const m of hdr.matchAll(/([A-Za-z_][A-Za-z0-9_]*): &mut /g)) line(`    ${useRuntime("stubKeep", fn)}(&mut ${m[1]})`);
          line("    exit(70)");
          line("    while true {");
          line("    }");
          line("}");
        }
      } finally {
        pop(); curFn = null;
      }
    };
    const lenientField = (f: () => { type: string; init: string | null }, what: string): { type: string; init: string | null; opaque: boolean } => {
      try { return { ...f(), opaque: false }; } catch (err) {
        if (!opts.lenient) throw err;
        const e = err instanceof Unsupported ? err : new Unsupported(`transpiler crash: ${(err as Error).message}`);
        report.stubs.push({ file: rel(file), name: what, reason: e.message });
        return { type: useRuntime("TsOpaque", sf), init: `${useRuntime("TsOpaque", sf)} {}`, opaque: true };
      }
    };
    const isExported = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    const mname = (n: ts.PropertyName) => (n as ts.Identifier).text;

    const emitTop = (n: ts.Statement): void => {
      if (ts.isImportDeclaration(n) || ts.isEmptyStatement(n)) return;
      if (isAst && !ts.isFunctionDeclaration(n) && !ts.isVariableStatement(n)) return;
      // Types are always pub: a non-exported interface can still be imported by a sibling file's generated code.
      const pub = isExported(n) || ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n) ? "pub " : "";
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
        const lits = litsOf(checker.getTypeFromTypeNode(n.type));
        const u = lits && litUnions.get(unionKey(lits));
        if (u && u.name === n.name.text && u.file === file) emitUnion(u);
        // A tagged union of inline object types (`{ tag: "int"; bits: number } | ...`) is declared where it
        // is written: a struct per variant, the enum, and an accessor per field every variant has.
        const tu = taggedUnionOf(checker, n);
        if (tu && file !== astFile && tu.variants.every((v) => ts.isTypeLiteralNode(v.decl))) {
          hit("tagged union of inline types", "enum + one struct per variant + common-field accessors");
          const idF = astModel.identity.has(tu.name) ? [{ name: ID_FIELD, ty: "i64" }] : [];
          const fieldsOfV = (v: (typeof tu.variants)[number]) => idF.concat(v.members.filter(ts.isPropertySignature).filter((m) => (m.name as ts.Identifier).text !== tu.field).map((m) => {
            const pt = m.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!) : checker.getTypeAtLocation(m);
            let t = ty(pt, m);
            if (astModel.boxed.has(m)) t = isOptionT(pt) ? `Option<Heap<${ty(checker.getNonNullableType(pt), m)}>>` : `Heap<${t}>`;
            return { name: mname(m.name), ty: t };
          }));
          const per = tu.variants.map(fieldsOfV);
          tu.variants.forEach((v, i) => {
            line(`${pub}struct ${v.name} {`);
            ind++; for (const f of per[i]) line(`${safeId(f.name)}: ${f.ty},`); ind--;
            line("}");
          });
          if (astModel.cloneable.has(tu.name)) line("@derive(Clone)");
          line(`${pub}enum ${tu.name} {`);
          ind++; for (const v of tu.variants) line(`${pascal(v.kind)}(${v.name}),`); ind--;
          line("}");
          // A field some variants lack is read only where TS narrowed to variants that have it; the other arms are unreachable.
          const seenF = new Set<string>();
          for (const f of per.flat()) {
            if (seenF.has(f.name)) continue;
            seenF.add(f.name);
            const having = tu.variants.filter((_, i) => per[i].some((x) => x.name === f.name));
            if (per.some((p) => p.some((x) => x.name === f.name && (x.ty !== f.ty || x.ty.includes("Heap<"))))) { report.deadDecls.add(`${file}::${tu.name}_${f.name}`); continue; }
            const fn = safeId(f.name);
            line(`${pub}fn ${tu.name}_${f.name}(e: &${tu.name}): ${f.ty} {`);
            ind++; line("return match e {"); ind++;
            for (const v of having) line(`${tu.name}.${pascal(v.kind)}(p) => p.${fn}.clone(),`);
            if (having.length < tu.variants.length) {
              line("_ => {"); ind++;
              line(`eprint("ts2milo: ${tu.name}.${f.name} read on a variant without it")`);
              line("exit(70)");
              ind--; line("},");
            }
            ind--; line("}"); ind--;
            line("}");
          }
          // The discriminant read outside a guard (`t.tag === "x"`) goes through `U_tag(e)`, an enum of the kinds.
          const tagEnum = litUnions.get(unionKey(tu.variants.map((v) => v.kind)));
          if (tagEnum) {
            hit("tagged union discriminant", "U_tag accessor returning an enum of the kinds");
            if (tagEnum.file === file) emitUnion(tagEnum);
            else useDeclared(tagEnum.name, tagEnum.file, n);
            line(`${pub}fn ${tu.name}_${tu.field}(e: &${tu.name}): ${tagEnum.name} {`);
            ind++; line("return match e {"); ind++;
            for (const v of tu.variants) line(`${tu.name}.${pascal(v.kind)}(p) => ${tagEnum.name}.${pascal(v.kind)},`);
            ind--; line("}"); ind--;
            line("}");
          }
        }
        // A union of unions (ast-model.ts nestedUnionOf): one variant per member, wrapping it.
        const nu = nestedUnionOf(checker, n);
        if (nu) {
          hit("union of unions", "enum with one variant per member union/interface, wrapping it");
          const memberFile = (m: { decl: ts.Declaration }) => m.decl.getSourceFile().fileName;
          line(`${pub}enum ${nu.name} {`);
          ind++; for (const m of nu.members!) line(`${m.name}(${useDeclared(m.name, memberFile(m), n)}),`); ind--;
          line("}");
          // A field every leaf has, delegating to each member union's own accessor.
          const fieldOf = (v: (typeof nu.variants)[number], name: string) => v.members.find((x): x is ts.PropertySignature => ts.isPropertySignature(x) && (x.name as ts.Identifier).text === name);
          for (const f of nu.variants[0].members.filter(ts.isPropertySignature)) {
            const fname = mname(f.name);
            if (fname === nu.field) continue;
            const sigs = nu.variants.map((v) => fieldOf(v, fname));
            if (sigs.some((x) => !x)) continue;
            const tys = sigs.map((x) => ty(x!.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(x!.name)!) : checker.getTypeAtLocation(x!), x!));
            if (tys.some((t) => t !== tys[0] || t.includes("Heap<")) || sigs.some((x) => astModel.boxed.has(x!))) continue;
            line(`${pub}fn ${nu.name}_${fname}(e: &${nu.name}): ${tys[0]} {`);
            ind++; line("return match e {"); ind++;
            for (const m of nu.members!) line(`${nu.name}.${m.name}(p) => ${m.union ? `${useDeclared(`${m.name}_${fname}`, memberFile(m), n)}(p)` : `p.${safeId(fname)}.clone()`},`);
            ind--; line("}"); ind--;
            line("}");
          }
          if (astModel.identity.has(nu.name)) {
            line(`${pub}fn ${nu.name}_${ID_FIELD}(e: &${nu.name}): i64 {`);
            ind++; line("return match e {"); ind++;
            for (const m of nu.members!) line(`${nu.name}.${m.name}(p) => ${m.union ? `${useDeclared(`${m.name}_${ID_FIELD}`, memberFile(m), n)}(p)` : `p.${ID_FIELD}`},`);
            ind--; line("}"); ind--;
            line("}");
          }
        }
      } else if (ts.isInterfaceDeclaration(n)) {
        hit("interface", "struct");
        for (const m of n.members) if (ts.isPropertySignature(m)) {
          const t = checker.getNonNullableType(checker.getTypeFromTypeNode(m.type!));
          const u = litsOf(t) && litUnions.get(unionKey(litsOf(t)!));
          if (u && u.file === file && u.name === `${n.name.text}_${mname(m.name)}`) emitUnion(u);
        }
        if (astModel.cloneable.has(n.name.text)) line("@derive(Clone)");
        line(`${pub}struct ${n.name.text} {`);
        ind++;
        if (astModel.identity.has(n.name.text)) line(`${ID_FIELD}: i64,`);
        for (const m of n.members.filter(ts.isPropertySignature)) {
          const t = checker.getTypeAtLocation(m);
          const pt = m.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!) : t;
          // An unmappable member type must not drop the whole declaration (siblings import it): lenient makes it opaque.
          line(`${safeId(mname(m.name))}: ${lenientField(() => ({ type: ty(pt, m), init: null }), `${n.name.text}.${mname(m.name)}`).type},`);
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
            const field = (): { type: string; init: string | null } => ({ type: ty(t, m), init: m.initializer ? ownConv(m.initializer, t) : null });
            props.push({ name: mname(m.name), ...lenientField(field, `${cname}.${mname(m.name)}`), param: null });
          }
        }
        for (const p of ctor?.parameters ?? []) if (p.modifiers?.length) {
          hit("constructor parameter property", "struct field + parameter of new");
          const pt = lenientField(() => ({ type: ty(checker.getTypeAtLocation(p), p), init: null }), `${cname}.${(p.name as ts.Identifier).text}`);
          props.push({ name: (p.name as ts.Identifier).text, type: pt.type, init: pt.opaque ? pt.init : null, param: pt.opaque ? null : p });
        }
        line(`${pub}struct ${cname} {`);
        ind++; for (const p of props) line(`${safeId(p.name)}: ${p.type},`); ind--;
        line("}");
        line(`impl ${cname} {`);
        ind++;
        report.functions.push({ file: rel(file), name: `${cname}.new`, override: false });
        const newMark = out.length, newInd = ind;
        try {
        scopes = []; usedNames = []; push();
        const ps = (ctor?.parameters ?? []).map((p) => `${declareLocal(symOf(p.name as ts.Identifier)!, (p.name as ts.Identifier).text)}: ${ty(checker.getTypeAtLocation(p), p)}`);
        line(`fn new(${ps.join(", ")}): ${cname} {`);
        ind++;
        // A constructor body of `this.f = e;` statements only: each e initializes field f. Anything else would be dropped silently, so it stubs.
        const ctorInit = new Map<string, string>();
        for (const st of ctor?.body?.statements ?? []) {
          if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && st.expression.expression.kind === ts.SyntaxKind.SuperKeyword) continue; // an Error subclass's message, as before
          const b = ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) ? st.expression : null;
          if (!b || b.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(b.left) || b.left.expression.kind !== ts.SyntaxKind.ThisKeyword) throw new Unsupported("constructor body statement other than this.field = expression");
          const fname = b.left.name.text;
          const decl = n.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && mname(m.name) === fname);
          if (!decl || ctorInit.has(fname)) throw new Unsupported("constructor assigns a field twice or one that is not declared");
          hit("constructor field assignment", "field initializer in new");
          ctorInit.set(fname, ownConv(b.right, checker.getTypeAtLocation(decl)));
        }
        line(`return ${cname} {`);
        ind++;
        for (const p of props) {
          // A field with no initializer that is no parameter property is assigned in the constructor body, which is not translated.
          const init = p.param ? lookupLocal(symOf(p.param.name as ts.Identifier)!)! : ctorInit.get(p.name) ?? p.init ?? (p.type.startsWith("Option<") ? "Option.None" : fail(n, `field ${p.name} is assigned in the constructor body`));
          line(`${safeId(p.name)}: ${init},`);
        }
        ind--; line("}");
        ind--; line("}");
        pop();
        } catch (err) {
          if (!opts.lenient) throw err;
          const e = err instanceof Unsupported ? err : new Unsupported(`transpiler crash: ${(err as Error).message}`);
          out.length = newMark; ind = newInd; pop();
          report.stubs.push({ file: rel(file), name: `${cname}.new`, reason: e.message });
          line(`fn new(): ${cname} {`);
          line(`    eprint(${JSON.stringify("ts2milo stub: " + e.message)})`);
          line("    exit(70)");
          line("    while true {");
          line("    }");
          line("}");
        }
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
    };
    for (const n of sf.statements) {
      const tmark = out.length, tind = ind;
      try { emitTop(n); } catch (err) {
        let e = err as Error;
        if (!opts.lenient) throw e;
        if (!(e instanceof Unsupported)) e = new Unsupported(`transpiler crash: ${(e as Error).message}`);
        // A declaration the transpiler cannot express (a type it has no mapping for) is left out
        // with its reason; whatever uses it then fails to compile, which is the honest count.
        out.length = tmark; ind = tind;
        const nm = (n as { name?: ts.Node }).name?.getText() ?? ts.SyntaxKind[n.kind];
        report.stubs.push({ file: rel(file), name: nm, reason: e.message });
        if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n)) report.deadDecls.add(`${file}::${nm}`);
        if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) report.deadDecls.add(`${file}::${d.name.getText()}`);
        line(`// ts2milo stub: ${e.message.replace(/\n/g, " ")}`);
      }
    }
    // Generated types for this file (names synthesized in step 2); emitting a struct can create more unions.
    for (const [node, a] of anonStructs) if (a.file === file && !a.dup) {
      const lit = node as ts.TypeLiteralNode;
      const tmark = out.length;
      try {
        const fields = lit.members.filter(ts.isPropertySignature).map((m) => {
          const pt = m.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!) : checker.getTypeAtLocation(m);
          return `${RESERVED.has(mname(m.name)) ? mname(m.name) + "_" : mname(m.name)}: ${ty(pt, m)},`;
        });
        line("@derive(Clone)");
        line(`pub struct ${a.name} {`);
        ind++; for (const f of fields) line(f); ind--;
        line("}");
      } catch (err) {
        if (!(err instanceof Unsupported) || !opts.lenient) throw err;
        out.length = tmark;
        report.stubs.push({ file: rel(file), name: a.name, reason: err.message });
        report.deadDecls.add(`${file}::${a.name}`);
        line(`// ts2milo stub: ${err.message.replace(/\n/g, " ")}`);
      }
    }
    // Emitting a struct can register more inferred structs (its field types), so run to a fixed point.
    for (let again = true; again;) {
      again = false;
      for (const a of [...inferredStructs.values()]) if (a.file === file && a.fields && !a.emitted) {
        a.emitted = again = true;
        const tmark = out.length;
        try {
          const fields = a.fields.map((f) => `${safeId(f.name)}: ${ty(f.t, a.at)},`);
          line("@derive(Clone)");
          line(`pub struct ${a.name} {`);
          ind++; for (const f of fields) line(f); ind--;
          line("}");
        } catch (err) {
          if (!(err instanceof Unsupported) || !opts.lenient) throw err;
          out.length = tmark;
          report.stubs.push({ file: rel(file), name: a.name, reason: err.message });
          report.deadDecls.add(`${file}::${a.name}`);
          line(`// ts2milo stub: ${err.message.replace(/\n/g, " ")}`);
        }
      }
    }
    for (const u of genUnions) if (u.file === file) emitUnion(u);
    function emitUnion(u: { name: string; lits: string[] }) {
      hit("string-literal union", "generated enum + Name_value");
      line("@derive(Clone)");
      line(`pub enum ${u.name} { ${u.lits.map(pascal).join(", ")} }`);
      line(`pub fn ${u.name}_value(k: &${u.name}): string {`);
      ind++; line("return match k {"); ind++;
      for (const l of u.lits) line(`${u.name}.${pascal(l)} => ${jsLit(l)},`);
      ind--; line("}"); ind--; line("}");
    }

    const header = `// GENERATED by scripts/ts2milo.ts from ${rel(file)}. Do not edit; change the TypeScript.`;
    const impLines = [...imports.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, names]) => `from "${m}" import { ${[...names].sort().join(", ")} }`);
    if (isAst) report.files.set("ast.milo", [report.files.get("ast.milo")!.replace(/^(\/\/[^\n]*\n)/, (m) => m + impLines.map((l) => l + "\n").join("")), ...out, ""].join("\n"));
    else report.files.set(basename(file).replace(/\.ts$/, ".milo"), [header, ...impLines, "", ...out, ""].join("\n"));
  }
  if (multiErr) {
    // One variant per thrown class. Declared classes come from their own generated file, the rest from the runtime.
    const byMod = new Map<string, string[]>();
    const variants: string[] = [];
    for (const n of errTypes) {
      const f = errDecl.get(n);
      const mod = f && inputSet.has(f) ? modOf(f) : RUNTIME_MOD;
      const vn = mod === RUNTIME_MOD ? RUNTIME_RENAMES[n] ?? n : n;
      variants.push(vn);
      if (mod === RUNTIME_MOD && !runtimeNames.has(vn)) throw new Unsupported(`runtime has no '${vn}' (scripts/ts2milo/runtime.milo)`);
      byMod.set(mod, [...(byMod.get(mod) ?? []), vn]);
    }
    const imps = [...byMod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, ns]) => `from "${m}" import { ${[...ns].sort().join(", ")} }`);
    report.files.set("thrown.milo", [
      "// GENERATED by scripts/ts2milo.ts. Do not edit; one variant per class the TypeScript throws.",
      ...imps, "", `pub enum ${THROWN_ENUM} {`, ...variants.map((n) => `    ${n}(${n}),`), "}", "",
    ].join("\n"));
  }
  report.files.set("ts2milo_runtime.milo", runtimeSrc);
  return report;
}

export function summary(r: Report): string {
  const total = r.functions.length;
  const ov = r.functions.filter((f) => f.override);
  const auto = total - ov.length;
  let s = `functions: ${total} total, ${auto} automatic, ${ov.length} overrides = ${total ? ((auto / total) * 100).toFixed(1) : "0"}% automatic\n`;
  if (r.stubs.length) s += `stubs: ${r.stubs.length} (${((1 - r.stubs.length / Math.max(total, 1)) * 100).toFixed(1)}% of functions translated)\n`;
  for (const o of ov) s += `override: ${o.file} ${o.name}\n`;
  if (r.ast) {
    s += `ast types: ${r.ast.types} generated from src/ast.ts (fields no input reads are not carried)\n`;
    for (const d of r.ast.dropped) s += `ast field without a Milo type: ${d.iface}.${d.field}: ${d.type}\n`;
    if (r.ast.sizeBoxed.length) s += `ast fields boxed to keep a value under 128 bytes: ${r.ast.sizeBoxed.length} (${r.ast.sizeBoxed.slice(0, 4).join(", ")}, ...)\n`;
  }
  s += "constructs hit:\n";
  for (const [k, v] of [...r.constructs.entries()].sort(([a], [b]) => a.localeCompare(b))) s += `  ${String(v.count).padStart(5)}  ${k}  ->  ${v.how}\n`;
  return s;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const inputs: string[] = [];
  let outDir = "", check = false, overridesDir: string | undefined;
  const astRoots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o") outDir = argv[++i];
    else if (argv[i] === "--check") check = true;
    else if (argv[i] === "--lenient") continue;
    else if (argv[i] === "--overrides") overridesDir = argv[++i];
    else if (argv[i] === "--ast-root") astRoots.push(argv[++i]);
    else inputs.push(argv[i]);
  }
  if (!inputs.length || !outDir) { console.error("usage: ts2milo.ts <files.ts...> -o <dir> [--check] [--overrides <dir>] [--ast-root <Type>] [--lenient]"); process.exit(2); }
  try {
    const r = transpile(inputs, { overridesDir, astRoots, lenient: argv.includes("--lenient") });
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
