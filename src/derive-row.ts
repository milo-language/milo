// @derive(Row): `Struct.fromRow(st)` reads each field from the sqlite result column with
// the same name (the SQL alias), so a SELECT can reorder or add columns without breaking
// the mapping. `fetchAll`/`fetchOne` prepare a query and read every / the first row; they
// carry `@sql`, so their SQL is checked at compile time and the checker also matches the
// query's result columns against the fields (checker-sql.ts). Emits Milo source like
// derive-json.ts; the readers live in std/sqlite (`dbRowI64`, `dbRowOptStr`, ...) and the
// resolver injects the import.

export type RowKind = "I64" | "I32" | "F64" | "Bool" | "Str";

export interface RowFieldPlan { field: string; kind: RowKind; optional: boolean }

// The methods the derive adds; a struct that already defines one cannot derive Row.
export const ROW_METHODS = ["fromRow", "fetchAll", "fetchOne"];

// What the resolver must put in scope for the generated body.
export const ROW_IMPORT_NAMES = [
  "Statement", "Database", "SqlArg", "dbPrepare", "dbNext",
  ...(["I64", "I32", "F64", "Bool", "Str"] as const).flatMap(k => [`dbRow${k}`, `dbRowOpt${k}`]),
];

export const ROW_SUPPORTED = "i64, i32, f64, bool, string, and Option<T> of each";

export function deriveRowSource(structName: string, fields: RowFieldPlan[]): string {
  // Field reads sit inline in the literal rather than in locals: a field named `st`
  // would otherwise shadow the statement parameter for every later read.
  const init = fields.map(f =>
    `${f.field}: dbRow${f.optional ? "Opt" : ""}${f.kind}(st, "${f.field}", "${structName}.${f.field}")?`).join(", ");
  const s = structName;
  return [
    `impl ${s} {`,
    `    fn fromRow(st: &Statement): Result<${s}> {`,
    `        return Result.Ok(${s} { ${init} })`,
    `    }`,
    `    @sql(sql, args)`,
    `    fn fetchAll(db: &Database, sql: string, args: Vec<SqlArg>): Result<Vec<${s}>> {`,
    `        let st = dbPrepare(db, sql, args)?`,
    `        var out: Vec<${s}> = []`,
    `        while dbNext(st)? {`,
    `            out.push(${s}.fromRow(st)?)`,
    `        }`,
    `        return Result.Ok(out)`,
    `    }`,
    `    @sql(sql, args)`,
    `    fn fetchOne(db: &Database, sql: string, args: Vec<SqlArg>): Result<Option<${s}>> {`,
    `        let st = dbPrepare(db, sql, args)?`,
    `        if !dbNext(st)? {`,
    `            return Result.Ok(None)`,
    `        }`,
    `        return Result.Ok(Some(${s}.fromRow(st)?))`,
    `    }`,
    `}`,
  ].join("\n");
}
