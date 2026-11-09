// Generates the explicit AST traversal from the types in src/ast.ts, so a hand-written walk over
// about 60 node kinds cannot drift from the tree.
//   bun scripts/gen-ast-walk.ts           write src/ast-walk-types.ts, src/ast-walk.ts, src/ast-nodes.ts
//   bun scripts/gen-ast-walk.ts --check   fail if a committed copy is stale
//
// A node is any object with a `kind` tag: the Expr, Stmt, Pattern and ChainClause unions plus
// Contract. Children are the fields whose type is a node, an array of nodes, or a plain struct
// holding nodes (MatchArm, StructLitField). Ids are pre-order positions: `v.next` is the id the
// next node gets, so a post-visit hook learns its children's ids from `kids`.
//
// The visitor is the class MutScan in src/mutability-scan.ts; the walker calls the hooks it
// declares (`node`, `visit<Kind>` before the children, `after<Kind>` after them) and no others.
import ts from "typescript";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
// Fields the old reflective walk skipped: spans and types are not nodes and carry no children.
const SKIP = new Set(["span", "type", "targetType", "retType", "methodSpan"]);
const FAMILIES = ["Expr", "Stmt", "Pattern", "ChainClause"];
// One walker per pass, each calling only its own visitor class (static calls, no interface to
// dispatch through, which keeps the generated Milo plain). Edges and ids are the same in all.
interface Visitor { file: string; cls: string; out: string }
const VISITORS: Visitor[] = [
  { file: "src/mutability-scan.ts", cls: "MutScan", out: "src/ast-walk.ts" },
  { file: "src/checker-nonescaping.ts", cls: "NonEscapingScan", out: "src/ast-walk-nonescaping.ts" },
  { file: "src/checker-purity.ts", cls: "PurityScan", out: "src/ast-walk-purity.ts" },
  { file: "src/checker-pointer-escape.ts", cls: "PointerEscapeScan", out: "src/ast-walk-pointer-escape.ts" },
  { file: "src/checker-pointer-mention.ts", cls: "MentionScan", out: "src/ast-walk-pointer-mention.ts" },
  { file: "src/checker-mut-bundle.ts", cls: "MutBundleScan", out: "src/ast-walk-mut-bundle.ts" },
  { file: "src/checker-task-scopes.ts", cls: "TaskScopeScan", out: "src/ast-walk-task-scopes.ts" },
  { file: "src/checker-escaping-closures.ts", cls: "EscapingScan", out: "src/ast-walk-escaping-closures.ts" },
  { file: "src/checker-global-borrow.ts", cls: "GlobalBorrowScan", out: "src/ast-walk-global-borrow.ts" },
];

interface NodeInfo { iface: string; kind: string; family: string; edges: { field: string; array: boolean; optional: "" | "null" | "undefined"; elemOptional: "" | "null" | "undefined"; family?: string; struct?: string }[]; opField: boolean }

export function generate(): Map<string, string> {
  const files = [join(ROOT, "src/ast.ts"), ...VISITORS.map((v) => join(ROOT, v.file))];
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowImportingTsExtensions: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(files[0])!;
  const ifaces = new Map<string, ts.InterfaceDeclaration>();
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s)) ifaces.set(s.name.text, s);
    if (ts.isTypeAliasDeclaration(s)) aliases.set(s.name.text, s);
  }
  const kindOf = (i: ts.InterfaceDeclaration): string | null => {
    for (const m of i.members) if (ts.isPropertySignature(m) && (m.name as ts.Identifier).text === "kind" && m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) return m.type.literal.text;
    return null;
  };
  const members = (fam: string): string[] => (aliases.get(fam)!.type as ts.UnionTypeNode).types.map((t) => (t as ts.TypeReferenceNode).typeName.getText());

  // Struct types that sit between a node and its children (not nodes themselves).
  const nodeFamilyOf = (name: string): string | undefined => FAMILIES.includes(name) ? name : name === "Contract" ? "Contract" : undefined;
  const structHasNodes = (name: string): boolean => {
    const d = ifaces.get(name);
    return !!d && kindOf(d) === null && d.members.some((m) => ts.isPropertySignature(m) && !SKIP.has((m.name as ts.Identifier).text) && shapeOf(m.type!, false).family !== undefined);
  };
  function shapeOf(t: ts.TypeNode, allowStruct = true, question = false): { family?: string; struct?: string; array: boolean; optional: "" | "null" | "undefined"; elemOptional: "" | "null" | "undefined" } {
    let optional: "" | "null" | "undefined" = "";
    let elemOptional: "" | "null" | "undefined" = "";
    let array = false;
    const strip = (n: ts.TypeNode): ts.TypeNode => {
      if (ts.isParenthesizedTypeNode(n)) return strip(n.type);
      if (ts.isUnionTypeNode(n)) {
        const rest = n.types.filter((x) => !(x.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword)));
        if (rest.length === 1 && rest.length < n.types.length) return strip(rest[0]);
      }
      return n;
    };
    const nullKind = (n: ts.TypeNode): "" | "null" | "undefined" => {
      if (ts.isParenthesizedTypeNode(n)) return nullKind(n.type);
      if (!ts.isUnionTypeNode(n)) return "";
      if (n.types.some((x) => ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword)) return "null";
      if (n.types.some((x) => x.kind === ts.SyntaxKind.UndefinedKeyword)) return "undefined";
      return "";
    };
    optional = nullKind(t);
    if (question && !optional) optional = "undefined";
    let core = strip(t);
    if (ts.isArrayTypeNode(core)) {
      array = true;
      elemOptional = nullKind(core.elementType);
      core = strip(core.elementType);
    }
    if (ts.isTypeReferenceNode(core)) {
      const name = core.typeName.getText();
      const fam = nodeFamilyOf(name);
      if (fam) return { family: fam, array, optional, elemOptional };
      if (allowStruct && structHasNodes(name)) return { family: "struct", struct: name, array, optional, elemOptional };
    }
    return { array, optional, elemOptional };
  }

  const nodes: NodeInfo[] = [];
  const addNode = (iface: string, kind: string, family: string) => {
    const d = ifaces.get(iface)!;
    const edges: NodeInfo["edges"] = [];
    let opField = false;
    for (const m of d.members) {
      if (!ts.isPropertySignature(m)) continue;
      const f = (m.name as ts.Identifier).text;
      if (f === "op" && m.type!.getText() === "string") opField = true;
      if (SKIP.has(f) || f === "kind") continue;
      const sh = shapeOf(m.type!, true, !!m.questionToken);
      if (sh.family) edges.push({ field: f, array: sh.array, optional: sh.optional, elemOptional: sh.elemOptional, family: sh.family === "struct" ? undefined : sh.family, struct: sh.struct });
    }
    nodes.push({ iface, kind, family, edges, opField });
  };
  for (const fam of FAMILIES) for (const iface of members(fam)) addNode(iface, kindOf(ifaces.get(iface)!)!, fam);
  addNode("Contract", "Contract", "Contract");

  // Visitor hooks, read from the class so the walker calls exactly what exists.
  const hooksOf = (V: Visitor): Set<string> => {
    const hooks = new Set<string>();
    program.getSourceFile(join(ROOT, V.file))!.forEachChild((n) => {
      if (ts.isClassDeclaration(n) && n.name?.text === V.cls) for (const m of n.members) if (ts.isMethodDeclaration(m)) hooks.add((m.name as ts.Identifier).text);
    });
    return hooks;
  };
  void checker;

  const kinds = nodes.map((n) => n.kind);
  const keys = new Set<string>();
  const structEdges = (name: string) => ifaces.get(name)!.members.filter(ts.isPropertySignature).flatMap((m) => {
    const f = (m.name as ts.Identifier).text;
    if (SKIP.has(f)) return [];
    const sh = shapeOf(m.type!, true, !!m.questionToken);
    return sh.family && sh.family !== "struct" ? [{ field: f, array: sh.array, optional: sh.optional, elemOptional: sh.elemOptional, family: sh.family }] : [];
  });

  const header = (what: string) => `// GENERATED by scripts/gen-ast-walk.ts from src/ast.ts (${what}). Do not edit; change src/ast.ts and rerun it.\n`;
  const fn = (fam: string) => `walk${fam}`;

  // ---- walker ----
  const emitWalker = (V: Visitor): string => {
    const hooks = hooksOf(V);
    let uid = 0;
    const w: string[] = [];
    const emitEdge = (ind: string, path: string, e: { field: string; array: boolean; optional: "" | "null" | "undefined"; elemOptional: "" | "null" | "undefined"; family?: string; struct?: string }, collectKids: boolean) => {
      const body = (i2: string, p: string, indexExpr: string) => {
        if (e.struct) {
          for (const se of structEdges(e.struct)) emitEdge(i2, `${p}.${se.field}`, se, collectKids);
          return;
        }
        keys.add(e.field);
        if (collectKids) w.push(`${i2}kids.push(v.next);`);
        w.push(`${i2}${fn(e.family!)}(v, ${p}, ${"p"}, "${e.field}", ${indexExpr});`);
      };
      const guard = (cond: string, ind2: string, inner: (i3: string) => void) => {
        w.push(`${ind2}if (${cond}) {`);
        inner(ind2 + "  ");
        w.push(`${ind2}}`);
      };
      const single = (i1: string, p: string, idx: string, opt: string) => opt ? guard(`${p} !== ${opt}`, i1, (i2) => body(i2, p, idx)) : body(i1, p, idx);
      if (!e.array) { single(ind, path, "-1", e.optional); return; }
      // A statement list is a lexical scope: a visitor with enterStmts/exitStmts hooks is told
      // where each one begins and ends (a pass tracking bindings needs both; the after<Kind>
      // hooks fire only once per node, after all of its lists).
      const scoped = e.family === "Stmt" && !e.struct;
      const emitLoop = (i1: string) => {
        if (scoped && hooks.has("enterStmts")) w.push(`${i1}v.enterStmts(p.id, "${e.field}");`);
        const i = `i${uid++}`;
        w.push(`${i1}let ${i} = 0;`);
        const x = `x${uid++}`;
        w.push(`${i1}for (const ${x} of ${path}) {`);
        single(i1 + "  ", x, i, e.elemOptional);
        w.push(`${i1}  ${i}++;`);
        w.push(`${i1}}`);
        if (scoped && hooks.has("exitStmts")) w.push(`${i1}v.exitStmts(p.id, "${e.field}");`);
      };
      if (e.optional) guard(`${path} !== ${e.optional}`, ind, emitLoop); else emitLoop(ind);
    };

    w.push(header("walker"));
    w.push(`import type { ${[...FAMILIES, "Contract"].join(", ")} } from "./ast";`);
    w.push(`import type { ${V.cls} } from "./${V.file.replace(/^src\//, "").replace(/\.ts$/, "")}";`);
    w.push(`import type { Parent, EdgeKey } from "./ast-walk-types";`);
    w.push("");
    for (const fam of [...FAMILIES, "Contract"]) {
      // A kind with no children and no hook needs no branch: only its id is spent.
      const ns = nodes.filter((n) => n.family === fam && (n.edges.length > 0 || hooks.has(`visit${n.kind}`) || hooks.has(`after${n.kind}`)));
      const varName = fam === "Expr" ? "e" : fam === "Stmt" ? "s" : fam === "Pattern" ? "p0" : fam === "ChainClause" ? "c" : "k";
      // Only a visit hook reads where the node sits; without one the params are named unused.
      const u = ns.some((n) => hooks.has(`visit${n.kind}`)) ? "" : "_";
      w.push(`export function ${fn(fam)}(v: ${V.cls}, ${varName}: ${fam}, ${u}parent: Parent, ${u}key: EdgeKey, ${u}index: number): void {`);
      w.push(`  const id = v.enter();`);
      if (hooks.has("node")) w.push(`  v.node(id);`);
      ns.forEach((n, ni) => {
        const single = nodes.filter((x) => x.family === fam).length === 1;
        const open = single ? "" : `  ${ni === 0 ? "" : "} else "}if (${varName}.kind === "${n.kind}") {`;
        if (open) w.push(open);
        const hasAfter = hooks.has(`after${n.kind}`);
        if (hooks.has(`visit${n.kind}`)) w.push(`    v.visit${n.kind}(${varName}, id, parent, key, index);`);
        if (n.edges.length > 0) {
          w.push(`    const p: Parent = { kind: "${n.kind}", id: id, op: ${n.opField ? `${varName}.op` : '""'} };`);
          if (hasAfter) w.push(`    const kids: number[] = [];`);
          for (const e of n.edges) emitEdge("    ", `${varName}.${e.field}`, e, hasAfter);
          if (hasAfter) w.push(`    v.after${n.kind}(${varName}, id, kids);`);
        } else if (hasAfter) {
          w.push(`    v.after${n.kind}(${varName}, id, []);`);
        }
        if (!single && ni === ns.length - 1) w.push("  }");
      });
      w.push("}");
      w.push("");
    }
    for (const fam of [...FAMILIES, "Contract"]) {
      w.push(`export function ${fn(fam)}s(v: ${V.cls}, list: ${fam}[], parent: Parent, key: EdgeKey): void {`);
      w.push(`  let i = 0;`);
      w.push(`  for (const x of list) {`);
      w.push(`    ${fn(fam)}(v, x, parent, key, i);`);
      w.push(`    i++;`);
      w.push(`  }`);
      w.push(`}`);
      w.push("");
    }
    return w.join("\n");
  };
  // Emitted before the types: emitting fills `keys`, which the EdgeKey type lists.
  const walkers = VISITORS.map((V) => [V.out, emitWalker(V)] as [string, string]);

  // ---- types ----
  const types = [
    header("walker types"),
    `export type NodeKind = "None" | ${kinds.map((k) => `"${k}"`).join(" | ")};`,
    `export type EdgeKey = "root" | ${[...keys].sort().map((k) => `"${k}"`).join(" | ")};`,
    `// What a child needs to know about the nearest ancestor that is a node. \`op\` is the operator of a`,
    `// BinOp or UnaryOp and "" otherwise. A parent of kind "None" stands for the root of a walk.`,
    `export interface Parent { kind: NodeKind; id: number; op: string }`,
    "",
  ].join("\n");

  // ---- preorder node list (TS only: the adapter keys host facts by object identity) ----
  const n: string[] = [header("node list, same order as the walker's ids")];
  n.push(`import type { ${[...FAMILIES, "Contract"].join(", ")} } from "./ast";`);
  n.push(`export type AnyNode = ${[...FAMILIES, "Contract"].join(" | ")};`);
  n.push(`export const EXPR_KINDS = new Set<string>([${nodes.filter((x) => x.family === "Expr").map((x) => `"${x.kind}"`).join(", ")}]);`);
  n.push("");
  const emitCollect = (ind: string, path: string, e: { field: string; array: boolean; optional: string; elemOptional: string; family?: string; struct?: string }) => {
    const target = (p: string): string[] => {
      if (e.struct) return structEdges(e.struct).map((se) => `${se.array ? `for (const x of ${p}.${se.field}) ` : ""}${se.optional || se.elemOptional ? `if (${se.array ? "x" : `${p}.${se.field}`}) ` : ""}collect${se.family}(${se.array ? "x" : `${p}.${se.field}`}, out);`);
      return [`collect${e.family}(${p}, out);`];
    };
    if (e.array) {
      n.push(`${ind}if (${path}) for (const x of ${path}) if (x) {${e.struct ? "" : ` collect${e.family}(x, out);`}`);
      if (e.struct) for (const se of structEdges(e.struct)) n.push(`${ind}  ${se.array ? `if (x.${se.field}) for (const y of x.${se.field}) collect${se.family}(y, out);` : `if (x.${se.field}) collect${se.family}(x.${se.field}, out);`}`);
      n.push(`${ind}}`);
    } else {
      n.push(`${ind}if (${path}) { ${target(path).join(" ")} }`);
    }
  };
  for (const fam of [...FAMILIES, "Contract"]) {
    const ns = nodes.filter((x) => x.family === fam);
    const vn = "x0";
    n.push(`export function collect${fam}(${vn}: ${fam}, out: AnyNode[]): void {`);
    n.push(`  out.push(${vn});`);
    for (const nd of ns) {
      if (nd.edges.length === 0) continue;
      n.push(ns.length === 1 ? `  {` : `  if (${vn}.kind === "${nd.kind}") {`);
      for (const e of nd.edges) emitCollect("    ", `${vn}.${e.field}`, e);
      n.push(`  }`);
    }
    n.push("}");
    n.push("");
  }
  n.push(`export function collectStmts(list: Stmt[], out: AnyNode[]): void {`);
  n.push(`  for (const s of list) collectStmt(s, out);`);
  n.push(`}`);
  n.push("");

  return new Map([
    ["src/ast-walk-types.ts", types],
    ...walkers,
    ["src/ast-nodes.ts", n.join("\n")],
  ]);
}

if (import.meta.main) {
  const out = generate();
  if (process.argv.includes("--check")) {
    let stale = 0;
    for (const [f, text] of out) {
      const p = join(ROOT, f);
      if (!existsSync(p) || readFileSync(p, "utf8") !== text) { console.error(`stale: ${f} (run bun scripts/gen-ast-walk.ts)`); stale++; }
    }
    if (stale) process.exit(1);
    console.log(`ast walk: ${out.size} generated files up to date`);
  } else {
    for (const [f, text] of out) writeFileSync(join(ROOT, f), text);
    console.log(`wrote ${[...out.keys()].join(", ")}`);
  }
}
