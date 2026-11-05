// How many places a real rollout of node ids would touch: collections keyed by an AST node, and
// assignments to AST fields, counted with the TypeScript checker (not by pattern) per frontend file.
//   bun scripts/ts2milo-identity-census.ts            table
//   bun scripts/ts2milo-identity-census.ts --list     every site with file:line
// A key is an AST node when its type (or a union member of it) is declared in src/ast.ts as an
// interface, or when it is the Expr/Stmt/Pattern/... unions. `unknown`/`object` keys are counted apart.
import ts from "typescript";
import { join, resolve } from "path";
import { makeProgram } from "./ts2milo/subset";

const ROOT = resolve(import.meta.dir, "..");
const FILES = ["checker.ts", "checker-program-passes.ts", "checker-closure-env.ts", "checker-derive.ts", "checker-sql.ts", "checker-mutability.ts", "emit-mlir.ts", "emit-forms.ts", "resolver.ts", "parser.ts", "backend-program.ts"].map((f) => `src/${f}`);
const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

interface Site { file: string; line: number; what: string }

export function census(): { sites: Site[]; table: Map<string, Record<string, number>> } {
  const program = makeProgram(ROOT, [...FILES.map((f) => join(ROOT, f)), join(ROOT, "src/ast.ts")]);
  const checker = program.getTypeChecker();
  const astFile = join(ROOT, "src/ast.ts");
  const isAstDecl = (d: ts.Declaration | undefined) => !!d && d.getSourceFile().fileName === astFile;
  const isNodeType = (t: ts.Type): boolean => {
    if (t.isUnion()) return t.types.some(isNodeType);
    if (isAstDecl((t.aliasSymbol ?? t.symbol)?.declarations?.[0])) return true;
    return false;
  };
  const isLooseKey = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) || t.symbol?.name === "Object";
  const sites: Site[] = [];
  const table = new Map<string, Record<string, number>>();
  const add = (file: string, kind: string, n: ts.Node, what: string) => {
    const sf = n.getSourceFile();
    sites.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what: `${kind}: ${what}` });
    const row = table.get(file) ?? {};
    row[kind] = (row[kind] ?? 0) + 1;
    table.set(file, row);
  };
  const keyOf = (t: ts.Type): ts.Type | undefined => {
    const name = t.symbol?.name;
    if (!name || !COLLECTIONS.has(name)) return undefined;
    return checker.getTypeArguments(t as ts.TypeReference)[0];
  };
  for (const file of FILES) {
    const sf = program.getSourceFile(join(ROOT, file))!;
    const visit = (n: ts.Node) => {
      // A declaration (field, variable, parameter, return type) of a collection keyed by a node.
      if ((ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertySignature(n)) && n.name) {
        const t = checker.getTypeAtLocation(n.name);
        const k = keyOf(t);
        if (k && isNodeType(k)) add(file, "declarations", n, `${t.symbol.name}<${checker.typeToString(k)}> ${n.name.getText()}`);
        else if (k && isLooseKey(k)) add(file, "loose-key declarations", n, `${t.symbol.name}<${checker.typeToString(k)}> ${n.name.getText()}`);
      }
      // A use: .get/.set/.has/.add/.delete on such a collection.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["get", "set", "has", "add", "delete"].includes(n.expression.name.text)) {
        const k = keyOf(checker.getTypeAtLocation(n.expression.expression));
        if (k && isNodeType(k)) add(file, "lookups", n, n.getText().slice(0, 70));
      }
      // An assignment to a field declared in src/ast.ts.
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isPropertyAccessExpression(n.left)) {
        const d = checker.getSymbolAtLocation(n.left.name)?.declarations?.[0];
        if (d && isAstDecl(d)) add(file, "AST field assignments", n, n.getText().slice(0, 70));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, table };
}

if (import.meta.main) {
  const { sites, table } = census();
  const cols = ["declarations", "lookups", "loose-key declarations", "AST field assignments"];
  console.log(["file".padEnd(34), ...cols.map((c) => c.padStart(24))].join(""));
  const sum: Record<string, number> = {};
  for (const [file, row] of [...table].sort()) {
    console.log([file.padEnd(34), ...cols.map((c) => String(row[c] ?? 0).padStart(24))].join(""));
    for (const c of cols) sum[c] = (sum[c] ?? 0) + (row[c] ?? 0);
  }
  console.log([ "total".padEnd(34), ...cols.map((c) => String(sum[c] ?? 0).padStart(24))].join(""));
  if (process.argv.includes("--list")) for (const s of sites) console.log(`${s.file}:${s.line}  ${s.what}`);
}
