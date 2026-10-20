// @derive(Table): typed insert / get / update / delete for a `@table("name")` struct, as Milo source over checked SQL.
//
// Columns are the fields in snake_case (`githubId` is `github_id`), and the primary key is
// the `id: i64` field, assigned by sqlite on insert. Every generated statement is a
// constant passed to `dbRun` / `fetchOne`, so the ordinary `@sql` check prepares it
// against the program's migrations: a field with no column, or a table that does not
// exist, is a compile error at the struct. `columns()` is the SELECT list with each column
// aliased back to its field name, and folds as a constant inside checked SQL, so
// `$"SELECT {User.columns()} FROM users WHERE login = ?"` is checked too.
import type { RowFieldPlan } from "./derive-row";

export const TABLE_METHODS = ["columns", "insert", "get", "update", "delete"];

export const TABLE_IMPORT_NAMES = ["Database", "SqlArg", "dbRun", "dbLastInsertId", "sqlOptInt", "sqlOptText"];

export function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
}

export function selectList(fields: RowFieldPlan[]): string {
  return fields.map(f => { const c = snakeCase(f.field); return c === f.field ? c : `${c} AS ${f.field}`; }).join(", ");
}

// One field of `row` as the SqlArg that binds it.
function argOf(f: RowFieldPlan): string {
  const v = `row.${f.field}`;
  if (!f.optional) {
    switch (f.kind) {
      case "I64": return `SqlArg.Int(${v})`;
      case "I32": return `SqlArg.Int(${v} as i64)`;
      case "F64": return `SqlArg.Float(${v})`;
      case "Bool": return `SqlArg.Int(if ${v} { 1 } else { 0 })`;
      case "Str": return `SqlArg.Text(${v})`;
    }
  }
  switch (f.kind) {
    case "I64": return `sqlOptInt(${v})`;
    case "Str": return `sqlOptText(${v})`;
    case "I32": return `match ${v} { Some(x) => SqlArg.Int(x as i64), None => SqlArg.Null }`;
    case "F64": return `match ${v} { Some(x) => SqlArg.Float(x), None => SqlArg.Null }`;
    case "Bool": return `match ${v} { Some(x) => SqlArg.Int(if x { 1 } else { 0 }), None => SqlArg.Null }`;
  }
}

export function deriveTableSource(structName: string, table: string, fields: RowFieldPlan[]): string {
  const s = structName;
  const rest = fields.filter(f => f.field !== "id");
  const cols = rest.map(f => snakeCase(f.field));
  const insertSql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  const updateSql = `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`;
  const selectSql = `SELECT ${selectList(fields)} FROM ${table} WHERE id = ?`;
  const args = rest.map(argOf).join(", ");
  return [
    `impl ${s} {`,
    `    fn columns(): string {`,
    `        return "${selectList(fields)}"`,
    `    }`,
    `    fn insert(db: &Database, row: &${s}): Result<i64> {`,
    `        dbRun(db, "${insertSql}", [${args}])?`,
    `        return Result.Ok(dbLastInsertId(db))`,
    `    }`,
    `    fn get(db: &Database, id: i64): Result<Option<${s}>> {`,
    `        return ${s}.fetchOne(db, "${selectSql}", [SqlArg.Int(id)])`,
    `    }`,
    `    fn update(db: &Database, row: &${s}): Result<bool> {`,
    `        let n = dbRun(db, "${updateSql}", [${args}${args ? ", " : ""}SqlArg.Int(row.id)])?`,
    `        return Result.Ok(n > 0)`,
    `    }`,
    `    fn delete(db: &Database, id: i64): Result<bool> {`,
    `        let n = dbRun(db, "DELETE FROM ${table} WHERE id = ?", [SqlArg.Int(id)])?`,
    `        return Result.Ok(n > 0)`,
    `    }`,
    `}`,
  ].join("\n");
}
