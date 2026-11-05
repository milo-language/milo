// The tagged-union and AST-type rules of the portable subset, shared by the transpiler (which
// maps expressions over these types) and by the Milo AST emitter below (which maps the types).
//
// Rule: a TS `type U = A | B | ...` whose members are interfaces, each carrying a `kind` property
// of a distinct string-literal type, is a tagged union. It becomes `enum U { A_kind(A), ... }`,
// one variant per member named by the kind literal, holding a struct named for the interface
// (without its `kind` field, which the variant now carries).
import ts from "typescript";

export interface Variant { kind: string; iface: ts.InterfaceDeclaration }
export interface TaggedUnion { name: string; decl: ts.TypeAliasDeclaration; variants: Variant[] }

const kindLiteral = (i: ts.InterfaceDeclaration): string | null => {
  for (const m of i.members) {
    if (ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === "kind" && m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) return m.type.literal.text;
  }
  return null;
};

// The declaration is a tagged union if every member resolves to an interface with a distinct kind.
export function taggedUnionOf(checker: ts.TypeChecker, d: ts.TypeAliasDeclaration): TaggedUnion | null {
  if (d.typeParameters || !ts.isUnionTypeNode(d.type)) return null;
  const variants: Variant[] = [];
  for (const t of d.type.types) {
    if (!ts.isTypeReferenceNode(t)) return null;
    const decl = checker.getSymbolAtLocation(t.typeName)?.declarations?.[0];
    if (!decl || !ts.isInterfaceDeclaration(decl)) return null;
    const kind = kindLiteral(decl);
    if (kind === null || variants.some((v) => v.kind === kind)) return null;
    variants.push({ kind, iface: decl });
  }
  return { name: d.name.text, decl: d, variants };
}

// The tagged union a type is (by its alias name), or null.
export function unionOfType(checker: ts.TypeChecker, t: ts.Type): TaggedUnion | null {
  const d = t.aliasSymbol?.declarations?.[0];
  return d && ts.isTypeAliasDeclaration(d) ? taggedUnionOf(checker, d) : null;
}

// ---- field boxing: a by-value cycle needs a Heap ----

export interface AstModel {
  unions: Map<string, TaggedUnion>;
  ifaces: Map<string, ts.InterfaceDeclaration>;
  // Fields whose Milo type is `Heap<...>` (the field closes a by-value cycle).
  boxed: Set<ts.PropertySignature>;
  // Fields with no Milo type (an untagged union of primitives). Counted and reported.
  dropped: { iface: string; field: string; type: string }[];
}

const stripOptional = (t: ts.TypeNode): ts.TypeNode => {
  if (ts.isParenthesizedTypeNode(t)) return stripOptional(t.type);
  if (ts.isUnionTypeNode(t)) {
    const rest = t.types.filter((x) => x.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword));
    if (rest.length === 1) return stripOptional(rest[0]);
  }
  return t;
};

export function buildAstModel(program: ts.Program, checker: ts.TypeChecker, astFile: string): AstModel {
  const sf = program.getSourceFile(astFile)!;
  const unions = new Map<string, TaggedUnion>();
  const ifaces = new Map<string, ts.InterfaceDeclaration>();
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s)) ifaces.set(s.name.text, s);
    if (ts.isTypeAliasDeclaration(s)) { const u = taggedUnionOf(checker, s); if (u) unions.set(u.name, u); }
  }
  // Direct (non-array) edges between named types. A union points at its variants, an interface at
  // the types its non-array fields name. A field on a cycle is boxed.
  const edges = new Map<string, { field: ts.PropertySignature | null; to: string }[]>();
  const add = (from: string, to: string, field: ts.PropertySignature | null) => { if (!edges.has(from)) edges.set(from, []); edges.get(from)!.push({ field, to }); };
  const dropped: AstModel["dropped"] = [];
  for (const u of unions.values()) for (const v of u.variants) add(u.name, v.iface.name.text, null);
  for (const i of ifaces.values()) {
    for (const m of i.members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const t = stripOptional(m.type);
      if (ts.isTypeReferenceNode(t)) {
        const n = t.typeName.getText();
        if (ifaces.has(n) || unions.has(n)) add(i.name.text, n, m);
      }
    }
  }
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const go = (n: string): boolean => {
      if (n === target) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      return (edges.get(n) ?? []).some((e) => go(e.to));
    };
    return (edges.get(from) ?? []).some((e) => go(e.to));
  };
  const boxed = new Set<ts.PropertySignature>();
  for (const [from, es] of edges) for (const e of es) if (e.field && reaches(e.to, from)) boxed.add(e.field);
  return { unions, ifaces, boxed, dropped };
}

// ---- Milo AST types and the JSON decoder, from the types ----

const RESERVED = new Set("fn extern let var return if else while true false struct enum match mut import from break continue as trait impl for in unsafe move null is type interface requires ensures invariant decreases self Self pub".split(" "));
const field_ = (n: string) => (RESERVED.has(n) ? n + "_" : n);
const pascal = (s: string) => s.replace(/(^|[^a-zA-Z0-9]+)(.)/g, (_, __, c) => c.toUpperCase());

export interface AstEmit { types: string; decoder: string; typeNames: string[]; dropped: AstModel["dropped"] }

// Emits Milo for every type reachable from `roots`. `litName(typeNode, ownerIface, field)` names a
// string-literal union the same way the function emitter does, so both sides agree on the enum.
export function emitAst(program: ts.Program, checker: ts.TypeChecker, model: AstModel, roots: string[], litName: (t: ts.TypeNode, owner: string, field: string) => { name: string; lits: string[] } | null): AstEmit {
  const need = new Set<string>();
  const enums = new Map<string, string[]>();
  const order: string[] = [];
  const visit = (name: string) => {
    if (need.has(name)) return;
    need.add(name);
    order.push(name);
    const u = model.unions.get(name);
    if (u) { for (const v of u.variants) visit(v.iface.name.text); return; }
    const i = model.ifaces.get(name);
    if (!i) return;
    for (const m of i.members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      if ((m.name as ts.Identifier).text === "kind" && inVariant(name)) continue;
      const base = stripOptional(m.type);
      const elem = ts.isArrayTypeNode(base) ? stripOptional(base.elementType) : base;
      if (ts.isTypeReferenceNode(elem)) visit(elem.typeName.getText());
    }
  };
  const variantOf = new Map<string, string>();
  for (const u of model.unions.values()) for (const v of u.variants) variantOf.set(v.iface.name.text, u.name);
  const inVariant = (iface: string) => variantOf.has(iface);
  for (const r of roots) visit(r);

  // Milo type of a field, or null when the field has no Milo type (and why).
  const typeOf = (owner: string, m: ts.PropertySignature): string | null => {
    const fname = (m.name as ts.Identifier).text;
    const opt = (s: string, node: ts.TypeNode, question: boolean): string => (question || stripOptional(node) !== node ? `Option<${s}>` : s);
    const conv = (n: ts.TypeNode, boxedHere: boolean): string | null => {
      n = stripOptional(n);
      if (ts.isArrayTypeNode(n)) {
        const inner = n.elementType;
        const e = conv(inner, false);
        if (e === null) return null;
        return `Vec<${opt(e, inner, false)}>`;
      }
      if (n.kind === ts.SyntaxKind.NumberKeyword) return "i64";
      if (n.kind === ts.SyntaxKind.StringKeyword) return "string";
      if (n.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
      if (ts.isLiteralTypeNode(n) && n.literal.kind === ts.SyntaxKind.TrueKeyword) return "bool";
      if (n.kind === ts.SyntaxKind.BigIntKeyword) return "string";
      if (ts.isTypeReferenceNode(n)) {
        const name = n.typeName.getText();
        if (model.ifaces.has(name) || model.unions.has(name)) return boxedHere ? `Heap<${name}>` : name;
        const decl = checker.getSymbolAtLocation(n.typeName)?.declarations?.[0];
        if (decl && ts.isTypeAliasDeclaration(decl)) {
          const l = litName(decl.type, owner, fname);
          if (l) { enums.set(l.name, l.lits); return l.name; }
        }
        return null;
      }
      const l = litName(n, owner, fname);
      if (l) { enums.set(l.name, l.lits); return l.name; }
      return null;
    };
    const full = conv(m.type!, model.boxed.has(m));
    if (full === null) return null;
    return opt(full, m.type!, !!m.questionToken);
  };

  const t: string[] = ["// GENERATED by scripts/ts2milo.ts from src/ast.ts. Do not edit; change the TypeScript."];
  const d: string[] = [];
  const typeNames: string[] = [];
  const decodeField: string[] = [];
  void decodeField;
  const droppedHere: AstModel["dropped"] = [];
  const structFields = new Map<string, { name: string; ty: string; node: ts.PropertySignature }[]>();
  for (const name of order) {
    const i = model.ifaces.get(name);
    if (!i) continue;
    const fs: { name: string; ty: string; node: ts.PropertySignature }[] = [];
    for (const m of i.members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const fname = (m.name as ts.Identifier).text;
      if (fname === "kind" && inVariant(name)) continue;
      const ty = typeOf(name, m);
      if (ty === null) { droppedHere.push({ iface: name, field: fname, type: m.type.getText() }); continue; }
      fs.push({ name: fname, ty, node: m });
    }
    structFields.set(name, fs);
  }
  for (const [en, lits] of enums) {
    t.push(`@derive(Clone)`, `pub enum ${en} { ${lits.map(pascal).join(", ")} }`);
  }
  for (const name of order) {
    const u = model.unions.get(name);
    if (u) {
      typeNames.push(name);
      t.push(`@derive(Clone)`, `pub enum ${name} {`, ...u.variants.map((v) => `    ${pascal(v.kind)}(${v.iface.name.text}),`), `}`);
      continue;
    }
    const fs = structFields.get(name);
    if (!fs) continue;
    typeNames.push(name);
    t.push(`@derive(Clone)`, `pub struct ${name} {`, ...fs.map((f) => `    ${field_(f.name)}: ${f.ty},`), `}`);
  }

  // ---- decoder: one function per type, cursors into a parsed std/json document ----
  d.push("// GENERATED by scripts/ts2milo.ts from src/ast.ts. Do not edit; change the TypeScript.");
  d.push(`from "std/json" import { Json }`);
  d.push(`from "./ts2milo_runtime" import { jsFromUtf8 }`);
  d.push(`from "./ast" import { ${[...typeNames, ...enums.keys()].flatMap((n) => (enums.has(n) ? [n] : [n])).join(", ")} }`);
  d.push("");
  const dec = (ty: string, node: ts.TypeNode, cur: string, depth: number): string => {
    // An expression decoding the value at cursor `cur` as the Milo type `ty`.
    const pad = `d${depth}`;
    void pad;
    return `decode_${ty.replace(/[<>]/g, "_")}(j, ${cur})`;
  };
  void dec;
  // Decoders are emitted by hand-rolled shape: scalars, enums, Vec<T>, Option<T>, Heap<T>, named.
  const decoderFor = (ty: string): string => {
    if (ty === "i64") return "j.curInt(CUR).unwrapOr(0)";
    if (ty === "bool") return "j.curBool(CUR).unwrapOr(false)";
    if (ty === "string") return "jsFromUtf8(j.curStr(CUR).unwrapOr(\"\"))";
    return `decode${ty}(j, CUR)`;
  };
  void decoderFor;
  const helpers = new Set<string>();
  const need2 = (ty: string): string => {
    // Name of the decoder for `ty`, emitting a wrapper for Vec/Option/Heap on first use.
    const name = "dec_" + ty.replace(/[<>, ]/g, "_");
    if (helpers.has(name)) return name;
    helpers.add(name);
    if (ty === "i64") d.push(`fn ${name}(j: &Json, c: i64): i64 {`, `    return j.curInt(c).unwrapOr(0)`, `}`, "");
    else if (ty === "bool") d.push(`fn ${name}(j: &Json, c: i64): bool {`, `    return j.curBool(c).unwrapOr(false)`, `}`, "");
    else if (ty === "string") d.push(`fn ${name}(j: &Json, c: i64): string {`, `    return jsFromUtf8(j.curStr(c).unwrapOr(""))`, `}`, "");
    else if (ty.startsWith("Vec<")) {
      const inner = ty.slice(4, -1);
      const f = need2(inner);
      d.push(`fn ${name}(j: &Json, c: i64): ${ty} {`, `    var out: ${ty} = Vec.new()`, `    let n = j.curLen(c)`, `    var i: i64 = 0`, `    while i < n {`, `        out.push(${f}(j, j.curChild(c, i)))`, `        i += 1`, `    }`, `    return out`, `}`, "");
    } else if (ty.startsWith("Option<")) {
      const inner = ty.slice(7, -1);
      const f = need2(inner);
      d.push(`fn ${name}(j: &Json, c: i64): ${ty} {`, `    if !j.curHolds(c) {`, `        return Option.None`, `    }`, `    return Option.Some(${f}(j, c))`, `}`, "");
    } else if (ty.startsWith("Heap<")) {
      const inner = ty.slice(5, -1);
      const f = need2(inner);
      d.push(`fn ${name}(j: &Json, c: i64): ${ty} {`, `    return Heap(${f}(j, c))`, `}`, "");
    } else if (enums.has(ty)) {
      d.push(`fn ${name}(j: &Json, c: i64): ${ty} {`);
      const lits = enums.get(ty)!;
      d.push(`    let s = jsFromUtf8(j.curStr(c).unwrapOr(""))`);
      for (const l of lits.slice(0, -1)) d.push(`    if s == ${JSON.stringify(l)} {`, `        return ${ty}.${pascal(l)}`, `    }`);
      d.push(`    return ${ty}.${pascal(lits[lits.length - 1])}`, `}`, "");
    } else if (model.unions.has(ty)) {
      const u = model.unions.get(ty)!;
      d.push(`fn ${name}(j: &Json, c: i64): ${ty} {`, `    let k = j.curStr(j.curField(c, "kind")).unwrapOr("")`);
      for (const v of u.variants.slice(0, -1)) d.push(`    if k == ${JSON.stringify(v.kind)} {`, `        return ${ty}.${pascal(v.kind)}(${need2(v.iface.name.text)}(j, c))`, `    }`);
      const last = u.variants[u.variants.length - 1];
      d.push(`    return ${ty}.${pascal(last.kind)}(${need2(last.iface.name.text)}(j, c))`, `}`, "");
    } else {
      const fs = structFields.get(ty) ?? [];
      const body: string[] = [];
      for (const f of fs) {
        const fn = need2(f.ty);
        body.push(`        ${field_(f.name)}: ${fn}(j, j.curField(c, ${JSON.stringify(f.name)})),`);
      }
      d.push(`fn ${name}(j: &Json, c: i64): ${ty} {`, `    return ${ty} {`, ...body, `    }`, `}`, "");
    }
    return name;
  };
  const exported: string[] = [];
  for (const r of roots) exported.push(need2(r));
  d.push(`pub fn decodeRoot(j: &Json, c: i64): ${roots[0]} {`, `    return ${exported[0]}(j, c)`, `}`);
  return { types: t.join("\n") + "\n", decoder: d.join("\n") + "\n", typeNames, dropped: droppedHere };
}

// Variant payload struct names are the interface names; the enum variant of each is `pascal(kind)`.
export { pascal as pascalCase };
