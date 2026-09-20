// @derive(Json) — generates `toJson` / `fromJson` / `fromJsonNode` for a struct.
//
// The generator emits Milo *source*, which the checker parses back into impl
// decls. Emitting AST nodes by hand was the alternative; source means the
// derived code is bound by exactly the same rules as hand-written code — there
// is no path by which a derive can produce something a user could not have
// typed — and it stays inspectable: `MILO_DUMP_DERIVES=1` prints each generated
// impl to stderr, which is the only way to read code the user never wrote.
//
// Everything it calls lives in std/json: the zero-copy cursor API for decoding,
// `jsonQuote`/`jsonBoolStr` for encoding, and `JsonError`/`JsonMismatch` for
// failures. The resolver injects that import when the attribute is present.

// A field type reduced to what the generator needs to know about it.
export type JsonPlan =
  | { k: "string" }
  | { k: "bool" }
  // `ty` is the Milo spelling. `range`, when present, is the closed interval the
  // decoded value must land in before it is cast down to `ty` — without it a
  // `u8` field would take 300 from the wire and store 44.
  | { k: "int"; ty: string; unsigned64: boolean; range?: { lo: string; hi: string } }
  | { k: "float"; ty: string }
  | { k: "struct"; name: string }
  | { k: "unitEnum"; name: string; variants: string[] }
  | { k: "vec"; ty: string; elem: JsonPlan }
  // A FIXED array. `size` is the exact element count the wire must supply, and `zero` is
  // the element expression the slots are built with before they are filled — a fixed
  // array cannot be grown into like a Vec.
  | { k: "array"; ty: string; elem: JsonPlan; size: number; zero: string }
  // Keys are always `string` — a JSON object has no other kind. `ty` is the Milo
  // spelling of the whole map, needed to declare the accumulator on decode.
  | { k: "map"; ty: string; value: JsonPlan }
  | { k: "option"; ty: string; inner: JsonPlan };

export interface JsonFieldPlan {
  field: string;
  key: string; // wire name — differs from `field` only under @json("…")
  plan: JsonPlan;
}

// Milo string literal. Renames are validated before they reach here, and field
// and variant names are identifiers, so no character needing an escape can
// appear — the escaping is belt-and-braces against a future caller.
function lit(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

class Gen {
  private n = 0;
  lines: string[] = [];
  constructor(private indent: string) {}
  tmp(prefix: string): string { return `${prefix}${this.n++}`; }
  push(depth: number, line: string): void {
    this.lines.push(`${this.indent}${"    ".repeat(depth)}${line}`);
  }
}

// Emit statements that build the JSON text of `val`, returning the expression
// that holds it.
function emitSer(p: JsonPlan, val: string, g: Gen, d: number): string {
  switch (p.k) {
    case "string": return `jsonQuote(${val})`;
    case "bool": return `jsonBoolStr(${val})`;
    case "int": case "float": return `${val}.toString()`;
    case "struct": return `${val}.toJson()`;
    case "unitEnum": {
      const s = g.tmp("s");
      g.push(d, `var ${s}: string = ""`);
      g.push(d, `match ${val} {`);
      for (const v of p.variants) {
        g.push(d + 1, `${p.name}.${v} => {`);
        g.push(d + 2, `${s} = ${lit(`"${v}"`)}`);
        g.push(d + 1, `}`);
      }
      g.push(d, `}`);
      return s;
    }
    // Serialising a fixed array is exactly serialising a Vec: both iterate and both emit
    // a JSON array. Only the DECODE side differs, because one grows and the other cannot.
    case "array":
    case "vec": {
      const s = g.tmp("s");
      const i = g.tmp("i");
      const e = g.tmp("e");
      g.push(d, `var ${s}: string = "["`);
      g.push(d, `var ${i}: i64 = 0`);
      g.push(d, `for ${e} in ${val} {`);
      g.push(d + 1, `if ${i} > 0 {`);
      g.push(d + 2, `${s} = ${s} + ","`);
      g.push(d + 1, `}`);
      const inner = emitSer(p.elem, e, g, d + 1);
      g.push(d + 1, `${s} = ${s} + ${inner}`);
      g.push(d + 1, `${i} = ${i} + 1`);
      g.push(d, `}`);
      g.push(d, `${s} = ${s} + "]"`);
      return s;
    }
    case "map": {
      const s = g.tmp("s");
      const ks = g.tmp("ks");
      const i = g.tmp("i");
      const k = g.tmp("k");
      const v = g.tmp("v");
      g.push(d, `var ${s}: string = "{"`);
      // Sorted, NOT in map order. Milo's HashMap iterates in a different order on every
      // RUN of the same binary (verified: three runs, three orders), so an unsorted
      // encoder would emit a different byte string each time — a config file that churns
      // its own diff, and a test that cannot assert on its output. JSON objects are
      // unordered, so sorting costs nothing semantically and buys reproducibility.
      g.push(d, `var ${ks}: Vec<string> = ${val}.keys()`);
      g.push(d, `sortStrings(&mut ${ks})`);
      g.push(d, `var ${i}: i64 = 0`);
      g.push(d, `for ${k} in ${ks} {`);
      g.push(d + 1, `if ${i} > 0 {`);
      g.push(d + 2, `${s} = ${s} + ","`);
      g.push(d + 1, `}`);
      // The key came out of the map, so the lookup cannot miss; `match` rather than an
      // unwrap keeps the generated code inside the same rules hand-written code obeys.
      g.push(d + 1, `match ${val}.get(${k}) {`);
      g.push(d + 2, `Option.Some(${v}) => {`);
      const inner = emitSer(p.value, v, g, d + 3);
      g.push(d + 3, `${s} = ${s} + jsonQuote(${k}) + ":" + ${inner}`);
      g.push(d + 2, `}`);
      g.push(d + 2, `Option.None => {`);
      g.push(d + 2, `}`);
      g.push(d + 1, `}`);
      g.push(d + 1, `${i} = ${i} + 1`);
      g.push(d, `}`);
      g.push(d, `${s} = ${s} + "}"`);
      return s;
    }
    case "option": {
      const s = g.tmp("s");
      const x = g.tmp("x");
      g.push(d, `var ${s}: string = "null"`);
      g.push(d, `match ${val} {`);
      g.push(d + 1, `Option.Some(${x}) => {`);
      const inner = emitSer(p.inner, x, g, d + 2);
      g.push(d + 2, `${s} = ${inner}`);
      g.push(d + 1, `}`);
      g.push(d + 1, `Option.None => {`);
      g.push(d + 1, `}`);
      g.push(d, `}`);
      return s;
    }
  }
}

// `path` and `node` are Milo *expressions*. A path is only ever evaluated inside
// an error branch, so decoding a correct document allocates no path strings.
function mismatch(path: string, expected: string, node: string): string {
  return `Result.Err(JsonError.Mismatch(JsonMismatch { path: ${path}, expected: ${lit(expected)}, `
    + `actual: jsonKindName(doc.curKind(${node})) }))`;
}

function emitScalarDe(
  accessor: string, expected: string, node: string, path: string, g: Gen, d: number,
): string {
  const t = g.tmp("v");
  g.push(d, `let Option.Some(${t}) = doc.${accessor}(${node}) else {`);
  g.push(d + 1, `return ${mismatch(path, expected, node)}`);
  g.push(d, `}`);
  return t;
}

// Emit statements that decode the node at cursor `node`, returning the
// expression that holds the value.
function emitDe(p: JsonPlan, node: string, path: string, g: Gen, d: number): string {
  switch (p.k) {
    case "string": return emitScalarDe("curStr", "string", node, path, g, d);
    case "bool": return emitScalarDe("curBool", "bool", node, path, g, d);
    case "float": {
      const raw = emitScalarDe("curFloat", "number", node, path, g, d);
      if (p.ty === "f64") return raw;
      const t = g.tmp("v");
      g.push(d, `let ${t} = ${raw} as ${p.ty}`);
      return t;
    }
    case "int": {
      // "integer" rather than "number": `curInt`/`curUint` also reject a
      // fractional or out-of-i64-range literal, and "expected integer, got
      // number" says exactly that, where "got number" alone would not.
      const raw = emitScalarDe(p.unsigned64 ? "curUint" : "curInt", "integer", node, path, g, d);
      if (!p.range) return raw;
      g.push(d, `if ${raw} < ${p.range.lo} || ${raw} > ${p.range.hi} {`);
      g.push(d + 1, `return Result.Err(JsonError.Mismatch(JsonMismatch { path: ${path}, `
        + `expected: ${lit(p.ty)}, actual: "out-of-range number" }))`);
      g.push(d, `}`);
      const t = g.tmp("v");
      g.push(d, `let ${t} = ${raw} as ${p.ty}`);
      return t;
    }
    case "struct": {
      const t = g.tmp("v");
      const x = g.tmp("x");
      const er = g.tmp("er");
      g.push(d, `let ${t} = match ${p.name}.fromJsonNode(doc, ${node}) {`);
      g.push(d + 1, `Result.Ok(${x}) => ${x},`);
      g.push(d + 1, `Result.Err(${er}) => {`);
      // The nested decoder reports paths relative to itself; re-rooting here is
      // what turns "zip" into "address.zip" without threading a prefix down.
      g.push(d + 2, `return Result.Err(${er}.under(${path}))`);
      g.push(d + 1, `}`);
      g.push(d, `}`);
      return t;
    }
    case "unitEnum": {
      const s = emitScalarDe("curStr", "string", node, path, g, d);
      const t = g.tmp("v");
      const ok = g.tmp("ok");
      g.push(d, `var ${t}: ${p.name} = ${p.name}.${p.variants[0]}`);
      g.push(d, `var ${ok}: bool = false`);
      for (const v of p.variants) {
        g.push(d, `if ${s} == ${lit(v)} {`);
        g.push(d + 1, `${t} = ${p.name}.${v}`);
        g.push(d + 1, `${ok} = true`);
        g.push(d, `}`);
      }
      g.push(d, `if !${ok} {`);
      const oneOf = p.variants.map(v => `"${v}"`).join(", ");
      g.push(d + 1, `return Result.Err(JsonError.Mismatch(JsonMismatch { path: ${path}, `
        + `expected: ${lit(`one of ${oneOf}`)}, actual: "\\"" + ${s} + "\\"" }))`);
      g.push(d, `}`);
      return t;
    }
    case "array": {
      const t = g.tmp("a");
      const i = g.tmp("i");
      const c = g.tmp("c");
      g.push(d, `if doc.curKind(${node}) != 4 {`);
      g.push(d + 1, `return ${mismatch(path, "array", node)}`);
      g.push(d, `}`);
      // A fixed array has exactly this many slots, so a wire array of any other length
      // cannot be represented. Reported rather than truncated or zero-padded: silently
      // accepting the wrong length is how a caller ends up reading a slot the sender
      // never wrote.
      g.push(d, `if doc.curLen(${node}) != ${p.size} {`);
      g.push(d + 1, `return Result.Err(JsonError.Mismatch(JsonMismatch { path: ${path}, `
        + `expected: ${lit(`an array of exactly ${p.size} elements`)}, actual: "an array of " + doc.curLen(${node}).toString() + " elements" }))`);
      g.push(d, `}`);
      g.push(d, `var ${t}: ${p.ty} = [${p.zero}; ${p.size}]`);
      g.push(d, `var ${i}: i64 = 0`);
      g.push(d, `while ${i} < ${p.size} {`);
      g.push(d + 1, `let ${c} = doc.curChild(${node}, ${i})`);
      const aElemPath = `${path} + "[" + ${i}.toString() + "]"`;
      const aInner = emitDe(p.elem, c, aElemPath, g, d + 1);
      g.push(d + 1, `${t}[${i}] = ${aInner}`);
      g.push(d + 1, `${i} = ${i} + 1`);
      g.push(d, `}`);
      return t;
    }
    case "vec": {
      const t = g.tmp("v");
      const i = g.tmp("i");
      const c = g.tmp("c");
      g.push(d, `if doc.curKind(${node}) != 4 {`);
      g.push(d + 1, `return ${mismatch(path, "array", node)}`);
      g.push(d, `}`);
      g.push(d, `var ${t}: ${p.ty} = Vec.new()`);
      g.push(d, `var ${i}: i64 = 0`);
      g.push(d, `while ${i} < doc.curLen(${node}) {`);
      g.push(d + 1, `let ${c} = doc.curChild(${node}, ${i})`);
      const elemPath = `${path} + "[" + ${i}.toString() + "]"`;
      const inner = emitDe(p.elem, c, elemPath, g, d + 1);
      g.push(d + 1, `${t}.push(${inner})`);
      g.push(d + 1, `${i} = ${i} + 1`);
      g.push(d, `}`);
      return t;
    }
    case "map": {
      const t = g.tmp("m");
      const i = g.tmp("i");
      const k = g.tmp("k");
      const c = g.tmp("c");
      g.push(d, `if doc.curKind(${node}) != 5 {`);
      g.push(d + 1, `return ${mismatch(path, "object", node)}`);
      g.push(d, `}`);
      g.push(d, `var ${t}: ${p.ty} = HashMap.new()`);
      g.push(d, `var ${i}: i64 = 0`);
      g.push(d, `while ${i} < doc.curLen(${node}) {`);
      // curKeyAt/curValueAt, not curField: the keys are the DATA here, so they cannot be
      // named at generation time the way a struct field's can.
      g.push(d + 1, `let ${k} = doc.curKeyAt(${node}, ${i})`);
      g.push(d + 1, `let ${c} = doc.curValueAt(${node}, ${i})`);
      const entryPath = `${path} + "." + ${k}`;
      const inner = emitDe(p.value, c, entryPath, g, d + 1);
      g.push(d + 1, `${t}.insert(${k}, ${inner})`);
      g.push(d + 1, `${i} = ${i} + 1`);
      g.push(d, `}`);
      return t;
    }
    case "option": {
      const t = g.tmp("v");
      g.push(d, `var ${t}: ${p.ty} = Option.None`);
      // An absent field and an explicit `null` both decode to None — the two
      // spellings mean the same thing to every JSON producer worth supporting.
      g.push(d, `if ${node} >= 0 && doc.curKind(${node}) != 0 {`);
      const inner = emitDe(p.inner, node, path, g, d + 1);
      g.push(d + 1, `${t} = Option.Some(${inner})`);
      g.push(d, `}`);
      return t;
    }
  }
}

export function deriveJsonSource(structName: string, fields: JsonFieldPlan[]): string {
  const out: string[] = [];
  out.push(`impl ${structName} {`);

  // ── toJson ──
  {
    const g = new Gen("        ");
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const expr = emitSer(f.plan, `self.${f.field}`, g, 0);
      const prefix = i === 0 ? "" : ",";
      g.push(0, `out = out + ${lit(`${prefix}"${f.key}":`)} + ${expr}`);
    }
    out.push(`    fn toJson(self: &Self): string {`);
    out.push(`        var out: string = "{"`);
    out.push(...g.lines);
    out.push(`        out = out + "}"`);
    out.push(`        return out`);
    out.push(`    }`);
  }

  // ── fromJsonNode ──
  {
    const g = new Gen("        ");
    const vals: string[] = [];
    for (const f of fields) {
      const node = g.tmp("n");
      g.push(0, `let ${node} = doc.curField(cur, ${lit(f.key)})`);
      // Only an Option field tolerates absence; everything else is required, so
      // a typo'd key is an error rather than a zeroed field.
      if (f.plan.k !== "option") {
        g.push(0, `if ${node} < 0 {`);
        g.push(1, `return Result.Err(JsonError.Missing(${lit(f.key)}))`);
        g.push(0, `}`);
      }
      vals.push(`${f.field}: ${emitDe(f.plan, node, lit(f.key), g, 0)}`);
    }
    out.push(`    fn fromJsonNode(doc: &Json, cur: i64): Result<${structName}, JsonError> {`);
    out.push(`        if doc.curKind(cur) != 5 {`);
    out.push(`            return ${mismatch(`""`, "object", "cur")}`);
    out.push(`        }`);
    out.push(...g.lines);
    out.push(`        return Result.Ok(${structName} { ${vals.join(", ")} })`);
    out.push(`    }`);
  }

  // ── fromJson ──
  out.push(`    fn fromJson(text: string): Result<${structName}, JsonError> {`);
  out.push(`        match Json.parse(text) {`);
  out.push(`            Result.Ok(doc) => {`);
  out.push(`                return ${structName}.fromJsonNode(doc, doc.curRoot())`);
  out.push(`            }`);
  out.push(`            Result.Err(e) => {`);
  out.push(`                return Result.Err(JsonError.Syntax(e))`);
  out.push(`            }`);
  out.push(`        }`);
  out.push(`    }`);

  out.push(`}`);
  return out.join("\n") + "\n";
}
