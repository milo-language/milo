// @derive(Row): `Struct.fromRow(st)` reads each field from the sqlite result column with
// the same name (the SQL alias), so a SELECT can reorder or add columns without breaking
// the mapping. Emits Milo source like derive-json.ts; the readers live in std/sqlite
// (`dbRowI64`, `dbRowOptStr`, ...) and the resolver injects the import.

export type RowKind = "I64" | "I32" | "F64" | "Bool" | "Str";

export interface RowFieldPlan { field: string; kind: RowKind; optional: boolean }

// What the resolver must put in scope for the generated body.
export const ROW_IMPORT_NAMES = [
  "Statement",
  ...(["I64", "I32", "F64", "Bool", "Str"] as const).flatMap(k => [`dbRow${k}`, `dbRowOpt${k}`]),
];

export const ROW_SUPPORTED = "i64, i32, f64, bool, string, and Option<T> of each";

export function deriveRowSource(structName: string, fields: RowFieldPlan[]): string {
  // Field reads sit inline in the literal rather than in locals: a field named `st`
  // would otherwise shadow the statement parameter for every later read.
  const init = fields.map(f =>
    `${f.field}: dbRow${f.optional ? "Opt" : ""}${f.kind}(st, "${f.field}", "${structName}.${f.field}")?`).join(", ");
  return [
    `impl ${structName} {`,
    `    fn fromRow(st: &Statement): Result<${structName}> {`,
    `        return Result.Ok(${structName} { ${init} })`,
    `    }`,
    `}`,
  ].join("\n");
}
