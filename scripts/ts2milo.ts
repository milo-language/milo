// TypeScript -> Milo transpiler for the portable subset (scripts/ts2milo/subset.ts).
//   bun scripts/ts2milo.ts src/tokens.ts src/lexer.ts -o <dir> [--check] [--overrides <dir>]
// Types come from the TypeScript checker; anything outside the subset fails with file:line and
// the construct name. Thin by design: refactor the TypeScript to fit, do not grow this file.
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { anonStructHandled, arrayClosureCall, calleeKey, hoistedClosure, chainCompareHandled, clauseBody, isChainMember, isLibDecl, makeProgram, nullishHandled, switchHandled, truthyHandled, violationsOf } from "./ts2milo/subset";
import { buildAstModel, discriminantRead, emitAst, guardUnion, nestedUnionOf, registerUnions, taggedUnionOf, unionOfType } from "./ts2milo/ast-model";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME_FILE = join(ROOT, "scripts/ts2milo/runtime.milo");
const RUNTIME_MOD = "./ts2milo_runtime";
// JavaScript names the prelude already owns, mirrored under another name in the runtime.
const RUNTIME_RENAMES: Record<string, string> = { Error: "JsError" };
const THROWN_ENUM = "Thrown";
const STD_MODULES: Record<string, string> = { HashSet: "std/set", [THROWN_ENUM]: "./thrown" };
const safeId = (n: string): string => { const m = n.replace(/\$/g, "_d"); return RESERVED.has(m) ? m + "_" : m; };
const RESERVED = new Set("fn extern let var return if else while true false struct enum match mut import from break continue as trait impl for in unsafe move null is type interface requires ensures invariant decreases self Self pub".split(" "));

export interface Report {
  files: Map<string, string>;
  functions: { file: string; name: string; override: boolean }[];
  // --lenient: functions whose body hit an unsupported construct, emitted as a stub that names it.
  stubs: { file: string; name: string; reason: string }[];
  constructs: Map<string, { count: number; how: string }>;
  // src/ast.ts is types-only: Milo types and a JSON decoder are generated from its interfaces
  // and tagged unions. Fields with no Milo type are listed, not silently lost.
  ast?: { types: number; dropped: { iface: string; field: string; type: string }[]; sizeBoxed: string[] };
}

export class Unsupported extends Error {}

// `astRoots`: the types of src/ast.ts the Milo AST must contain (everything reachable from them).
export function transpile(inputs: string[], opts: { overridesDir?: string; astRoots?: string[]; lenient?: boolean } = {}): Report {
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

  const report: Report = { files: new Map(), functions: [], constructs: new Map(), stubs: [] };
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
  const pascal = (s: string) => { const t = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/(^|[^a-zA-Z0-9]+)(.)/g, (_, __, c) => c.toUpperCase()); return /^[0-9]/.test(t) || t === "" ? "V" + t : t; };
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
  const anonStructs = new Map<ts.Node, { name: string; file: string; emitted: boolean }>();
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
      anonStructs.set(node, { name: alias ?? freshName(nameFrom(node)), file, emitted: false });
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
  const throwing = new Set<ts.Node>();
  // --lenient: functions a whole-program pass could not handle; emitFn stubs them with the reason.
  const forceStub = new Map<ts.Node, string>();
  // The thrown classes, in first-thrown order, with the file declaring each. One class is the Result's
  // error type as is; several make one generated enum (THROWN_ENUM, one variant per class, carrying it).
  const errTypes: string[] = [];
  const errDecl = new Map<string, string | undefined>();
  const walkBody = (body: ts.Node, f: (n: ts.Node) => void) => { const w = (n: ts.Node) => { f(n); ts.forEachChild(n, w); }; w(body); };
  for (const fn of allFns) walkBody(fn.body!, (n) => {
    if (ts.isThrowStatement(n)) {
      throwing.add(fn);
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
    if (ts.isCallExpression(n)) {
      const k = calleeKey(program, checker, n);
      if (k === "Array.push" || k === "Set.add" || k === "Map.set") return rootOf((n.expression as ts.PropertyAccessExpression).expression);
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
  const astModel = buildAstModel(program, checker, astFile ? [astFile, ...files.filter((f) => f !== astFile)] : files);

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
    const em = emitAst(checker, astModel, astFile, roots, litName, modOf, used, kindEnum);
    report.files.set("ast.milo", em.types);
    report.files.set("ast_decode.milo", em.decoder);
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
      if (!declFile || declFile === file) return name;
      if (inputSet.has(declFile)) use(modOf(declFile), name);
      else return useRuntime(RUNTIME_RENAMES[name] ?? name, at);
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
    // Whether `e` reads an array element held as Heap<T> (see `ty`).
    const boxedElem = (e: ts.Expression): boolean => ts.isElementAccessExpression(e) && checker.isArrayType(tOf(e.expression)) && onCycle(checker.getNonNullableType(checker.getTypeArguments(tOf(e.expression) as ts.TypeReference)[0]));
    let opaqueFallback = false; // lenient signatures: a type with no mapping becomes TsOpaque so the function still exists for importers
    const ty = (t: ts.Type, at: ts.Node): string => {
      try { return ty0(t, at); } catch (e) { if (opaqueFallback && e instanceof Unsupported) return useRuntime("TsOpaque", at); throw e; }
    };
    const ty0 = (t: ts.Type, at: ts.Node): string => {
      if (isOptionT(t)) { hit("T | undefined", "Option<T>"); return `Option<${ty(checker.getNonNullableType(t), at)}>`; }
      const ed = enumDeclOf(t);
      if (ed) return useDeclared(ed.name.text, ed.getSourceFile().fileName, at);
      const tu = unionOfType(checker, t);
      if (tu) { hit("tagged union", "enum with one struct-carrying variant per kind"); return useDeclared(tu.name, tu.decl.getSourceFile().fileName, at); }
      if (t.symbol?.name === "Map") {
        const [k, v] = checker.getTypeArguments(t as ts.TypeReference);
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
      if (t.symbol?.name === "Set" || t.symbol?.name === "ReadonlySet") return `${std("HashSet")}<${ty(checker.getTypeArguments(t as ts.TypeReference)[0], at)}>`;
      const d = t.symbol?.declarations?.[0];
      if (d && (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d))) return useDeclared(d.name!.text, d.getSourceFile().fileName, at);
      const anon = d && ts.isTypeLiteralNode(d) ? anonStructs.get(d) : undefined;
      if (anon) { hit("inline object type", "generated struct named from where it is written"); return useDeclared(anon.name, anon.file, at); }
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
    // JS truthiness of a non-boolean (subset.ts truthyHandled). The value is evaluated once.
    const truthText = (k: "str" | "num" | "optBool", code: string) =>
      k === "str" ? `(${useRuntime("jsLen", sf)}(${code}) != 0)` : k === "num" ? `(${code} != 0)` : code;
    const cond = (e: ts.Expression): string => {
      const k = truthyHandled(checker, e);
      if (!k) return ex(e);
      if (k === "str" || k === "num") { hit("truthiness", "string: jsLen != 0, number: != 0"); return truthText(k, ex(e)); }
      return fail(e, "optional truthiness outside an if guard");
    };

    // Narrowing. Inside `if (x.kind === "K")` the guarded expression reads as the variant's struct,
    // and inside `if (p !== undefined)` as the Option's payload; both are bound by an `if let`.
    // Keyed by source text, so a path like `e.args[i]` narrows as a whole.
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
    const needsClone = (e: ts.Expression) => isPlace(e) && !isCopyT(tOf(e));
    const canClone = (t: ts.Type): boolean => {
      if (isCopyT(t)) return true;
      if (isOptionT(t)) return canClone(checker.getNonNullableType(t));
      if (checker.isArrayType(t)) return canClone(checker.getTypeArguments(t as ts.TypeReference)[0]);
      if (t.symbol?.name === "Set" || t.symbol?.name === "ReadonlySet" || t.symbol?.name === "Map") return true;
      const tu = unionOfType(checker, t);
      if (tu) return astModel.cloneable.has(tu.name);
      const d = t.symbol?.declarations?.[0];
      return !!d && ts.isInterfaceDeclaration(d) && astModel.cloneable.has(d.name.text);
    };
    const conv = (e: ts.Expression, want?: ts.Type, own = false): string => {
      const owned = (s: string, force = false) => {
        if (!(own || force) || !needsClone(e)) return s;
        if (!canClone(tOf(e))) fail(e, `a value of type ${checker.typeToString(tOf(e))} copied out of a borrowed place: the type is recursive or a class, so it has no Clone; use the place itself`);
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
      if (want && isOptionT(want) && !isOptionT(tOf(e))) {
        if (isUndefinedId(e) || e.kind === ts.SyntaxKind.NullKeyword) return "Option.None";
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
      return owned(ex(e, want));
    };
    const ownConv = (e: ts.Expression, want?: ts.Type) => conv(e, want, true);

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
      // A field every variant of a tagged union has (`span`) is read through a generated accessor.
      const tu = unionOfType(checker, tOf(e.expression));
      if (tu) {
        hit("tagged union common field", "generated accessor Union_field(&u)");
        return `${useDeclared(`${tu.name}_${e.name.text}`, tu.decl.getSourceFile().fileName, e)}(${ex(e.expression)})`;
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
          if (!canClone(fieldT)) fail(n, `a value of type ${checker.typeToString(fieldT)} copied out of a borrowed place: the type is recursive or a class, so it has no Clone; use the place itself`);
          return bindTo(`${code}.clone()`, false);
        }
        let v = code;
        if (own && !isCopyT(fieldT)) {
          if (!canClone(fieldT)) fail(n, `a value of type ${checker.typeToString(fieldT)} copied out of a borrowed place: the type is recursive or a class, so it has no Clone; use the place itself`);
          v = `${code}.clone()`;
        }
        narrow.set(key, { name: code, deref: false });
        const r = some(v);
        if (saved) narrow.set(key, saved); else narrow.delete(key);
        return r;
      };
      if (isChainMember(link)) return chainFold(link, none, () => access(), false);
      // The root: an optional place, bound by reference.
      const lkey = link.getText();
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
    const nullish = (b: ts.BinaryExpression): string => {
      const mode = nullishHandled(checker, b) ?? fail(b, "?? outside the subset");
      hit("nullish coalescing", mode === "value" ? "Milo ?? (the default runs only when absent)" : "if isSome, else the default");
      const rt = tOf(b);
      const l = unparen(b.left);
      const dflt = ownConv(b.right, rt);
      if (isChainMember(l)) return mode === "value" ? chainFold(l, dflt, (v) => v, true) : chainFold(l, dflt, (v) => `Option.Some(${v})`, true);
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
        if (i < given.length && mp?.has(i)) { hit("&mut parameter", "argument written `&mut x`"); parts.push(`&mut ${conv(given[i], pt)}`); }
        else if (i < given.length) parts.push(conv(given[i], pt, byValue));
        else if (p.initializer) { hit("default parameter", "default expression filled in at the call site"); parts.push(ex(p.initializer)); }
        else if (p.questionToken) parts.push("Option.None");
        else fail(call, "missing argument");
      });
      return parts.join(", ");
    };

    let closureDepth = 0;
    const withTry = (call: ts.CallExpression, code: string): string => {
      const d = declOf(call);
      if (closureDepth > 0 && d && throwing.has(d) && !isThrower(d)) fail(call, "closure (loop tier) calling a function that throws");
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
      const helper = useRuntime(CLOSURE_HELPERS[method], c);
      const recv = (c.expression as ts.PropertyAccessExpression).expression;
      const ret = checker.getSignatureFromDeclaration(arrow)!.getReturnType();
      const core = isOptionT(elem) ? checker.getNonNullableType(elem) : elem;
      const boxed = onCycle(core);
      const inner = boxed ? `Heap<${ty(core, c)}>` : ty(core, c);
      const elemTy = `&${isOptionT(elem) ? `Option<${inner}>` : inner}`;
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
        return `${helper}(${ex(recv)}, ${lit}${tail})`;
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
          case "Array.push": return `${ex(recv!)}.push(${ownConv(a[0], checker.getTypeArguments(tOf(recv!) as ts.TypeReference)[0])})`;
          case "Set.has": case "ReadonlySet.has": return `${ex(recv!)}.contains(${ex(a[0])})`;
          case "Set.add": return `${ex(recv!)}.add(${ownConv(a[0], checker.getTypeArguments(tOf(recv!) as ts.TypeReference)[0])})`;
          case "Map.get": return `${ex(recv!)}.get(${ex(a[0])})`;
          case "Map.has": return `${ex(recv!)}.contains(${ex(a[0])})`;
          case "Map.set": { const [kt, vt] = checker.getTypeArguments(tOf(recv!) as ts.TypeReference); return `${ex(recv!)}.insert(${ownConv(a[0], kt)}, ${ownConv(a[1], vt)})`; }
          case "parseInt": if (!a[1]) fail(c, "parseInt without a radix"); return `${useRuntime("jsParseInt", c)}(${ex(a[0])}, ${ex(a[1])})`;
          case "String()": return isNum(a[0]) ? `${useRuntime("jsNum", c)}(${ex(a[0])})` : ex(a[0]);
          // Only the single-argument forms the runtime helpers implement exactly; anything else (a position, a regex, a limit) stays refused.
          case "String.startsWith": case "String.endsWith": case "String.includes": case "String.indexOf": case "String.lastIndexOf": case "String.split": {
            if (a.length !== 1 || !isStr(a[0])) return fail(c, `library call ${key} with other than one string argument`);
            const h = { "String.startsWith": "jsStartsWith", "String.endsWith": "jsEndsWith", "String.includes": "jsIncludes", "String.indexOf": "jsIndexOf", "String.lastIndexOf": "jsLastIndexOf", "String.split": "jsSplit" }[key];
            return `${useRuntime(h, c)}(${ex(recv!)}, ${ex(a[0])})`;
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
    const ex = (e: ts.Expression, want?: ts.Type): string => {
      if (narrow.size > 0 && (e.kind === ts.SyntaxKind.Identifier || e.kind === ts.SyntaxKind.PropertyAccessExpression || e.kind === ts.SyntaxKind.ElementAccessExpression)) {
        const nb = narrow.get(e.getText());
        if (nb) return nb.deref ? `(*${nb.name})` : nb.name;
      }
      // TS narrows a union of unions by an early exit or an else, but the Milo value is still the whole union.
      // (A guard's own scrutinee is exempt: it is the whole union that gets matched.)
      if (e !== guardScrut && (e.kind === ts.SyntaxKind.Identifier || e.kind === ts.SyntaxKind.PropertyAccessExpression)) {
        const sym = checker.getSymbolAtLocation(e.kind === ts.SyntaxKind.Identifier ? e : (e as ts.PropertyAccessExpression).name);
        const declT = sym && sym.declarations?.[0] && !ts.isTypeAliasDeclaration(sym.declarations[0]) ? checker.getNonNullableType(checker.getTypeOfSymbol(sym)) : undefined;
        const du = declT?.aliasSymbol ? unionOfType(checker, declT) : null;
        if (du?.members && unionOfType(checker, checker.getNonNullableType(tOf(e)))?.name !== du.name) fail(e, `${e.getText()} is a ${du.name} narrowed to a member by an early exit or an else (narrow with an if guard)`);
      }
      switch (e.kind) {
        case ts.SyntaxKind.ParenthesizedExpression: return `(${ex((e as ts.ParenthesizedExpression).expression, want)})`;
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
            parts.push(isNum(sp.expression) ? `${useRuntime("jsNum", e)}(${ex(sp.expression)})` : ex(sp.expression));
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
          if (t.symbol?.name === "Set") {
            hit("new Set([...])", "HashSet.fromVec");
            return n.arguments?.length ? `${std("HashSet")}.fromVec(${ownConv(n.arguments[0])})` : `${std("HashSet")}.new()`;
          }
          if (t.symbol?.name === "Map") { hit("new Map()", "HashMap.new()"); return "HashMap.new()"; }
          hit("new Class(...)", "Class.new(...), defaults filled");
          const d = t.symbol.declarations![0] as ts.ClassDeclaration;
          return `${useDeclared(d.name!.text, d.getSourceFile().fileName, e)}.new(${args(n, true)})`;
        }
        case ts.SyntaxKind.BinaryExpression: {
          const b = e as ts.BinaryExpression;
          const op = b.operatorToken.kind;
          const text = b.operatorToken.getText();
          if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) fail(b, `assignment ${text} used as a value`);
          if (op === ts.SyntaxKind.QuestionQuestionToken) return nullish(b);
          if ((op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) && isChainMember(unparen(b.left)) && chainCompareHandled(checker, b)) {
            // Absent compares unequal to any value, so `!==` is true there.
            const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
            const l = unparen(b.left);
            const lt = checker.getNonNullableType(tOf(l));
            return chainFold(l, eq ? "false" : "true", (v) => `(${v} ${eq ? "==" : "!="} ${ex(b.right, litsOf(lt) ? lt : undefined)})`, false);
          }
          if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            const sym = op === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!=";
            const lt = tOf(b.left), rt = tOf(b.right);
            return `(${ex(b.left, litsOf(rt) ? rt : undefined)} ${sym} ${ex(b.right, litsOf(lt) ? lt : undefined)})`;
          }
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return `(${cond(b.left)} ${text} ${cond(b.right)})`;
          return `(${ex(b.left)} ${text} ${ex(b.right)})`;
        }
        case ts.SyntaxKind.PrefixUnaryExpression: {
          const u = e as ts.PrefixUnaryExpression;
          return u.operator === ts.SyntaxKind.ExclamationToken ? `!${cond(u.operand)}` : `(-${ex(u.operand)})`;
        }
        case ts.SyntaxKind.ConditionalExpression: {
          const c = e as ts.ConditionalExpression;
          hit("ternary", "if-expression");
          return `(if ${cond(c.condition)} { ${conv(c.whenTrue, want)} } else { ${conv(c.whenFalse, want)} })`;
        }
        case ts.SyntaxKind.AsExpression: {
          const a = e as ts.AsExpression;
          const en = enumDeclOf(checker.getTypeFromTypeNode(a.type));
          if (!en) fail(a, "'as' to a type that is not a string enum");
          hit("string as StringEnum", "generated Enum_fromValue");
          return `${useDeclared(en!.name.text + "_fromValue", en!.getSourceFile().fileName, e)}(${ex(a.expression)})`;
        }
        case ts.SyntaxKind.ObjectLiteralExpression: {
          const o = e as ts.ObjectLiteralExpression;
          const ctxT = checker.getContextualType(o);
          if (!ctxT) fail(o, "object literal without a contextual type");
          const t = checker.getNonNullableType(ctxT!);
          if (!o.properties.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) fail(o, "object literal with spread or method members");
          if (!o.properties.every((p) => ts.isIdentifier(p.name!))) fail(o, "object literal with a non-identifier key");
          const lu = unionOfType(checker, t);
          if (lu) {
            // The variant is picked by the literal discriminant property (`{ tag: "ptr", inner }`).
            const dp = o.properties.find((p) => ts.isPropertyAssignment(p) && (p.name as ts.Identifier).text === lu.field) as ts.PropertyAssignment | undefined;
            const lit = dp && ts.isStringLiteral(dp.initializer) ? dp.initializer.text : fail(e, `object literal of ${lu.name} without a literal ${lu.field}`);
            const v = lu.variants.find((x) => x.kind === lit) ?? fail(e, `${lu.name} has no variant ${lit}`);
            hit("tagged union literal", "Union.Variant(Struct { fields })");
            const uname = useDeclared(lu.name, lu.decl.getSourceFile().fileName, e);
            const sname = useDeclared(v.name, lu.decl.getSourceFile().fileName, e);
            const vfields = v.members.filter(ts.isPropertySignature).filter((m) => (m.name as ts.Identifier).text !== lu.field).map((m) => {
              const fname = (m.name as ts.Identifier).text;
              const prop = o.properties.find((p) => (p.name as ts.Identifier).text === fname);
              const pt = checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!);
              let val = !prop ? "Option.None" : ts.isShorthandPropertyAssignment(prop) ? ownConv(prop.name, pt) : ownConv((prop as ts.PropertyAssignment).initializer, pt);
              if (astModel.boxed.has(m)) {
                if (isOptionT(pt)) return fail(e, "object literal with a boxed optional field");
                val = `Heap(${val})`;
              }
              return `${safeId(fname)}: ${val}`;
            });
            return `${uname}.${pascal(v.kind)}(${sname} { ${vfields.join(", ")} })`;
          }
          const d = t.symbol?.declarations?.[0] as ts.InterfaceDeclaration | ts.TypeLiteralNode | undefined;
          if (!d || !(ts.isInterfaceDeclaration(d) || (ts.isTypeLiteralNode(d) && anonStructs.has(d)))) fail(o, "object literal whose contextual type is not a named interface");
          hit("object literal", "struct literal, missing optionals are Option.None");
          const name = ts.isInterfaceDeclaration(d!) ? useDeclared(d.name.text, d.getSourceFile().fileName, e) : ty(t, e);
          const fields = d!.members.filter(ts.isPropertySignature).map((m) => {
            const fname = (m.name as ts.Identifier).text;
            const prop = o.properties.find((p) => (p.name as ts.Identifier).text === fname);
            const pt = checker.getTypeOfSymbol(checker.getPropertyOfType(t, fname)!);
            const v = !prop ? "Option.None" : ts.isShorthandPropertyAssignment(prop) ? ownConv(prop.name, pt) : ownConv((prop as ts.PropertyAssignment).initializer, pt);
            return `${safeId(fname)}: ${v}`;
          });
          return `${name} { ${fields.join(", ")} }`;
        }
        case ts.SyntaxKind.ArrayLiteralExpression: {
          const a = e as ts.ArrayLiteralExpression;
          if (a.elements.length === 0) return "Vec.new()";
          const et = want && checker.isArrayType(want) ? checker.getTypeArguments(want as ts.TypeReference)[0] : undefined;
          return `[${a.elements.map((x) => ownConv(x, et)).join(", ")}]`;
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
            const hoist = hoistedClosure(checker, d);
            if (typeof hoist === "string") fail(d, hoist);
            if (hoist) {
              hit("hoisted const closure", "let f = (params) => closure literal; only called by name");
              const nm = declareLocal(sym, (d.name as ts.Identifier).text);
              const arrow = hoist as ts.ArrowFunction;
              line(`let ${nm} = ${closureLit(arrow, arrow.parameters.map((p) => ({ p, ref: !isScalar(checker.getTypeAtLocation(p)) })))}`);
              continue;
            }
            const init = d.initializer ? ownConv(d.initializer, t) : defaultOf(t, d);
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
          if (!checker.isArrayType(tOf(f.expression))) fail(f, "for-of over something other than an array");
          const d = (f.initializer as ts.VariableDeclarationList).declarations[0];
          const sym = symOf(d.name as ts.Identifier)!;
          const arr = ex(f.expression);
          const el = checker.getTypeArguments(tOf(f.expression) as ts.TypeReference)[0];
          hit("for-of over an array", "for x in array (borrowed elements)");
          push();
          const name = declareLocal(sym, (d.name as ts.Identifier).text);
          if (onCycle(isOptionT(el) ? checker.getNonNullableType(el) : el)) elemBoxed.add(sym);
          line(`for ${name} in ${arr} {`);
          ind++; body(f.statement); ind--;
          line("}");
          pop();
          return;
        }
        case ts.SyntaxKind.WhileStatement: {
          const w = s as ts.WhileStatement;
          line(`while ${cond(w.expression)} {`);
          ind++; body(w.statement); ind--;
          line("}");
          return;
        }
        case ts.SyntaxKind.BreakStatement: line("break"); return;
        case ts.SyntaxKind.ContinueStatement: line("continue"); return;
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
          const thrown = multiErr ? `${std(THROWN_ENUM)}.${thrownName(checker.getTypeAtLocation(t.expression).symbol)}(${ex(t.expression)})` : ex(t.expression);
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
    const block = (b: ts.Block) => { for (const s of b.statements) stmt(s); };
    const exprStmt = (e: ts.Expression) => {
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        const lt = tOf(e.left);
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
      if (ts.isCallExpression(e)) {
        const d = declOf(e);
        if (d && isThrower(d)) { if (closureDepth > 0) fail(e, "closure (loop tier) calling a function that throws"); line(`return Result.Err(${callEx(e)})`); return; }
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
      // Parameters other than numbers, bools and unit enums are borrowed; one the body writes
      // through is `&mut`.
      const ps = fn.parameters.map((p, i) => {
        const t = checker.getTypeAtLocation(p);
        const borrow = isScalar(t) ? "" : mutParams.get(fn)?.has(i) ? "&mut " : "&";
        return `${declareLocal(symOf(p.name as ts.Identifier)!, (p.name as ts.Identifier).text)}: ${borrow}${ty(t, p)}`;
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
    const prepareMutated = (fn: ts.FunctionLikeDeclaration) => {
      mutated = new Set();
      walkBody(fn.body!, (n) => {
        const consider = (target: ts.Expression) => { const r = rootOf(target); if (ts.isIdentifier(r)) { const s = symOf(r); if (s) mutated.add(s); } };
        if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(n.operatorToken.kind)) consider(n.left);
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) consider(n.operand);
        if (ts.isCallExpression(n)) {
          const k = calleeKey(program, checker, n);
          if (k === "Array.push" || k === "Set.add" || k === "Map.set") consider((n.expression as ts.PropertyAccessExpression).expression);
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
        const forced = forceStub.get(fn);
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
        if (!(e instanceof Unsupported)) e = new Unsupported(`transpiler crash: ${(e as Error).message}`);
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
          const fieldsOfV = (v: (typeof tu.variants)[number]) => v.members.filter(ts.isPropertySignature).filter((m) => (m.name as ts.Identifier).text !== tu.field).map((m) => {
            const pt = m.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!) : checker.getTypeAtLocation(m);
            let t = ty(pt, m);
            if (astModel.boxed.has(m)) t = isOptionT(pt) ? `Option<Heap<${ty(checker.getNonNullableType(pt), m)}>>` : `Heap<${t}>`;
            return { name: mname(m.name), ty: t };
          });
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
            if (per.some((p) => p.some((x) => x.name === f.name && (x.ty !== f.ty || x.ty.includes("Heap<"))))) continue;
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
        line(`return ${cname} {`);
        ind++;
        for (const p of props) line(`${safeId(p.name)}: ${p.param ? lookupLocal(symOf(p.param.name as ts.Identifier)!)! : p.init},`);
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
        line(`// ts2milo stub: ${e.message.replace(/\n/g, " ")}`);
      }
    }
    // Generated types for this file (names synthesized in step 2); emitting a struct can create more unions.
    for (const [node, a] of anonStructs) if (a.file === file) {
      const lit = node as ts.TypeLiteralNode;
      const tmark = out.length;
      try {
        const fields = lit.members.filter(ts.isPropertySignature).map((m) => {
          const pt = m.questionToken ? checker.getTypeOfSymbol(checker.getSymbolAtLocation(m.name)!) : checker.getTypeAtLocation(m);
          return `${RESERVED.has(mname(m.name)) ? mname(m.name) + "_" : mname(m.name)}: ${lenientField(() => ({ type: ty(pt, m), init: null }), `${a.name}.${mname(m.name)}`).type},`;
        });
        line("@derive(Clone)");
        line(`pub struct ${a.name} {`);
        ind++; for (const f of fields) line(f); ind--;
        line("}");
      } catch (err) {
        if (!(err instanceof Unsupported) || !opts.lenient) throw err;
        out.length = tmark;
        report.stubs.push({ file: rel(file), name: a.name, reason: err.message });
        line(`// ts2milo stub: ${err.message.replace(/\n/g, " ")}`);
      }
    }
    for (const u of genUnions) if (u.file === file) emitUnion(u);
    function emitUnion(u: { name: string; lits: string[] }) {
      hit("string-literal union", "generated enum + Name_value");
      line("@derive(Clone)");
      line(`pub enum ${u.name} { ${u.lits.map(pascal).join(", ")} }`);
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
