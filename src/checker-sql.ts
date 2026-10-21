// Compile-time checked SQL: every `@sql(param[, args])` call site is prepared against the schema the program's own migrations build, at compile time, with bun:sqlite.
//
// The schema comes from the calls to `@sqlSchema(version, sql)` constructors
// (`Migration.sql` / `Migration.baseline` in std/migrate): their SQL must be a compile-time
// constant, and is applied in version order to an in-memory database. The migration list
// is the schema's single source, so the check cannot describe a database the program would
// not build. Function migrations are invisible here (a function cannot run at compile time),
// which is why std/migrate tells schema changes to stay in SQL.
//
// The SQL argument at a call site must be one of: a compile-time constant string (literals,
// `+`, `$"..."` with constant holes, immutable `let`s and module constants holding one),
// `uncheckedSql(e)` (the explicit opt-out for SQL assembled at run time), or the enclosing
// fn's own `@sql` parameter (a wrapper is checked at ITS call sites). Anything else is an
// error, whether or not the program has migrations, so adding the first migration never
// turns an accepted program into a rejected one.
//
// Sites are collected while the checker walks bodies and checked once at the end, because
// the migrations may live in a file checked later than the query. The schema database is
// memoized per process by its migration text, and each prepare by (schema, sql), so the LSP
// and `milo check` re-check without rebuilding either.
import { Database, type Statement } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import type { Attribute, Expr, Span } from "./ast";
import type { RowFieldPlan } from "./derive-row";
import { suggestions, didYouMean } from "./suggest";

export interface SqlAttr { sqlIndex: number; argsIndex: number | null }

interface Site {
  sql: string;
  span?: Span;
  callee: string;
  argCount: number | null;
  row: { name: string; fields: RowFieldPlan[] } | null;
}

// `ddl`: an unversioned `@sqlSchema(sql)` call (run-time DDL such as a TEMP table), applied
// after every versioned migration, in the order the checker met them.
interface Piece { version: bigint | null; ddl: boolean; sql: string | null; span?: Span; callee: string }

export interface ConstResolver {
  ident(name: string): string | null;
  staticCall(type: string, method: string): string | null;
  call(fn: string, args: string[]): string | null;
}

export interface SqlHost {
  error(msg: string, span?: Span, hint?: string): void;
}

// The parameter indices an `@sql(sql[, args])` / `@sqlSchema(version, sql)` attribute
// names, or null when the attribute is absent or names no parameter (validateSqlAttribute
// reports that at the declaration).
export function sqlAttrOf(attrs: Attribute[] | undefined, params: { name: string }[], which: "sql" | "sqlSchema"): SqlAttr | null {
  const a = attrs?.find(x => x.name === which);
  if (!a || a.args.length === 0) return null;
  const idx = (n: string | undefined) => n === undefined ? null : params.findIndex(p => p.name === n);
  if (which === "sqlSchema") {
    // @sqlSchema(sql) is unversioned DDL; @sqlSchema(version, sql) a migration.
    if (a.args.length === 1) {
      const s = idx(a.args[0]);
      return s === null || s < 0 ? null : { sqlIndex: s, argsIndex: null };
    }
    const v = idx(a.args[0]), s = idx(a.args[1]);
    if (v === null || v < 0 || s === null || s < 0) return null;
    return { sqlIndex: s, argsIndex: v };
  }
  const s = idx(a.args[0]);
  const g = idx(a.args[1]);
  if (s === null || s < 0 || (g !== null && g < 0)) return null;
  return { sqlIndex: s, argsIndex: g };
}

// The declaration-side check: the attribute must name parameters the fn has.
export function validateSqlAttribute(attr: Attribute, owner: string, params: { name: string }[]): string | null {
  if (attr.args.length === 0 || attr.args.length > 2) {
    return attr.name === "sqlSchema"
      ? `'@sqlSchema' on '${owner}' takes the SQL parameter's name, after the version's for a migration: @sqlSchema(version, sql) or @sqlSchema(sql)`
      : `'@sql' on '${owner}' takes the SQL parameter's name and optionally the bind arguments': @sql(sql) or @sql(sql, args)`;
  }
  for (const n of attr.args) {
    if (!params.some(p => p.name === n)) {
      return `'@${attr.name}(${attr.args.join(", ")})' on '${owner}': '${n}' is not one of its parameters`;
    }
  }
  return null;
}

const schemaCache = new Map<string, { db: Database } | { error: string; at: number }>();
const prepareCache = new Map<string, PrepareResult>();
type PrepareResult = { ok: true; params: number; columns: string[]; declTypes: (string | null)[] } | { ok: false; error: string };

export class SqlChecker {
  private sites: Site[] = [];
  private pieces: Piece[] = [];
  // Static methods carrying @sql/@sqlSchema, by mangled name; free fns are looked up
  // through the checker's own decl table.
  readonly methodAttrs = new Map<string, Attribute[]>();
  // Structs with @derive(Row), whose generated fetchAll/fetchOne read a result into them.
  readonly rowPlans = new Map<string, RowFieldPlan[]>();
  // @derive(Table) structs: `T.columns()` folds to this select list.
  readonly tableColumns = new Map<string, string>();
  // Where each @derive(Table) struct is declared: its generated statements sit there.
  readonly tableSites = new Map<string, string>();
  noteTable(name: string, span?: Span): void {
    if (span) this.tableSites.set(spanText(span), name);
  }
  readonly staticConst = (type: string, method: string): string | null =>
    method === "columns" ? this.tableColumns.get(type) ?? null : null;

  constructor(private host: SqlHost) {}

  // A constant-folded string, or null when `e` is not a compile-time constant. The
  // resolver supplies what only the checker knows: the constant a name holds, a derived
  // `T.columns()`, and a call to a template function (one whose body is a single
  // `return` of a foldable expression in its parameters).
  static constString(e: Expr, r: ConstResolver): string | null {
    switch (e.kind) {
      case "StringLit": return e.value;
      case "IntLit": return e.value.toString();
      case "Ident": return r.ident(e.name);
      // A zero-argument static call the resolver knows the value of (`User.columns()`).
      case "EnumLit": return e.args.length === 0 ? r.staticCall(e.enumName, e.variant) : null;
      case "BinOp": {
        if (e.op !== "+") return null;
        const l = SqlChecker.constString(e.left, r);
        if (l === null) return null;
        const rt = SqlChecker.constString(e.right, r);
        return rt === null ? null : l + rt;
      }
      case "Call": {
        if (e.func === "embedFile") return embeddedText(e);
        const args: string[] = [];
        for (const a of e.args) {
          const v = SqlChecker.constString(a, r);
          if (v === null) return null;
          args.push(v);
        }
        // `$"..."` desugars to format(pieces...); every hole must fold too.
        if (e.func === "format") return args.join("");
        return r.call(e.func, args);
      }
      case "MethodCall":
        // `SCHEMA.clone()` is the same text (strings are values; the clone is a no-op).
        return e.method === "clone" && e.args.length === 0 ? SqlChecker.constString(e.object, r) : null;
      default:
        return null;
    }
  }

  // One call to a fn carrying `@sql`. `sqlValue` is the folded SQL, or "unchecked" /
  // "passthrough" for the two accepted non-constant forms, or null (rejected here).
  noteQuery(callee: string, attr: SqlAttr, args: Expr[], sqlValue: string | "unchecked" | "passthrough" | null, row: string | null, prepares: boolean, sp?: Span): void {
    const sqlArg = args[attr.sqlIndex];
    if (!sqlArg) return;
    if (sqlValue === "unchecked" || sqlValue === "passthrough") return;
    if (sqlValue === null) {
      this.host.error(`the SQL passed to '${callee}' must be a compile-time constant string`, sqlArg.span ?? sp,
        `checked SQL is prepared against the schema at compile time. Build it from literals, '+', $"..." and constants, or wrap SQL assembled at run time in 'uncheckedSql(...)'`);
      return;
    }
    let argCount: number | null = null;
    if (attr.argsIndex !== null) {
      const a = args[attr.argsIndex];
      if (a && a.kind === "ArrayLit" && !(prepares && a.elements.length === 0)) argCount = a.elements.length;
    }
    const plan = row ? this.rowPlans.get(row) : undefined;
    this.sites.push({ sql: sqlValue, span: sqlArg.span ?? sp, callee, argCount, row: row && plan ? { name: row, fields: plan } : null });
  }

  // One call to an `@sqlSchema(version, sql)` constructor.
  noteSchema(callee: string, attr: SqlAttr, args: Expr[], version: bigint | null, sqlValue: string | null, sp?: Span): void {
    const sqlArg = args[attr.sqlIndex];
    this.pieces.push({ version, ddl: attr.argsIndex === null, sql: sqlValue, span: sqlArg?.span ?? sp, callee });
  }

  run(): void {
    // No checked query, no schema to build: a program holding several migration lists
    // for unrelated databases (tests, tools) is fine as long as it checks no SQL.
    if (this.sites.length === 0) return;
    if (this.pieces.length === 0) return;
    const schema = this.buildSchema();
    if (!schema) return;
    const reported = new Set<string>();
    for (const s of this.sites) this.checkSite(schema.db, schema.key, s, reported);
  }

  private buildSchema(): { db: Database; key: string } | null {
    let bad = false;
    for (const p of this.pieces) {
      if (p.version === null && !p.ddl) {
        this.host.error(`the version passed to '${p.callee}' must be an integer literal or constant when the program uses checked SQL`, p.span);
        bad = true;
      } else if (p.sql === null) {
        this.host.error(`the SQL passed to '${p.callee}' must be a compile-time constant string when the program uses checked SQL`, p.span,
          `the compiler applies the migrations to an empty database to learn the schema queries are checked against; a schema change built at run time belongs in a constant migration`);
        bad = true;
      }
    }
    if (bad) return null;
    const versioned = this.pieces.filter(p => !p.ddl).sort((a, b) => (a.version! < b.version! ? -1 : a.version! > b.version! ? 1 : 0));
    for (let i = 1; i < versioned.length; i++) {
      if (versioned[i]!.version === versioned[i - 1]!.version) {
        this.host.error(`two migrations claim version ${versioned[i]!.version}: checked SQL needs one migration list per program`, versioned[i]!.span,
          `the other is at ${spanText(versioned[i - 1]!.span)}`);
        return null;
      }
    }
    const sorted = [...versioned, ...this.pieces.filter(p => p.ddl)];
    const key = sorted.map(p => `${p.ddl ? "ddl" : p.version}\u0000${p.sql}`).join("\u0001");
    let entry = schemaCache.get(key);
    if (!entry) {
      const db = new Database(":memory:");
      entry = { db };
      for (let i = 0; i < sorted.length; i++) {
        try {
          db.exec(sorted[i]!.sql!);
        } catch (e) {
          db.close();
          entry = { error: sqliteMessage(e), at: i };
          break;
        }
      }
      schemaCache.set(key, entry);
    }
    if ("error" in entry) {
      const p = sorted[entry.at]!;
      this.host.error(p.ddl ? `the DDL passed to '${p.callee}' does not apply after the migrations: ${entry.error}` : `migration ${p.version} does not apply: ${entry.error}`, p.span,
        `the compiler runs every SQL migration, in version order, on an empty database to learn the schema`);
      return null;
    }
    return { db: entry.db, key };
  }

  private prepare(db: Database, key: string, sql: string): PrepareResult {
    const k = key + "\u0002" + sql;
    const hit = prepareCache.get(k);
    if (hit) return hit;
    let r: PrepareResult;
    try {
      const st = db.prepare(sql);
      r = { ok: true, params: st.paramsCount, columns: [...st.columnNames], declTypes: declaredTypesOf(db, st) };
      st.finalize();
    } catch (e) {
      r = { ok: false, error: sqliteMessage(e) };
    }
    prepareCache.set(k, r);
    return r;
  }

  // `reported`: locations that already have a prepare error. @derive(Table) puts all of a
  // struct's statements at the struct, and one missing column would otherwise be
  // reported once per generated statement.
  private checkSite(db: Database, key: string, s: Site, reported: Set<string>): void {
    const r = this.prepare(db, key, s.sql);
    if (!r.ok) {
      const at = spanText(s.span);
      if (s.span && reported.has(at)) return;
      reported.add(at);
      const table = this.tableSites.get(at);
      const msg = table ? `@derive(Table) on '${table}': its generated SQL does not match the schema: ${r.error}` : `SQL error in the query passed to '${s.callee}': ${r.error}`;
      this.host.error(msg, s.span, table ? `the statements are built from the fields (snake_case columns); add the column in a migration, or rename the field` : this.hintFor(db, r.error) ?? `the query is checked against the schema the program's migrations build`);
      return;
    }
    if (s.argCount !== null && s.argCount !== r.params) {
      this.host.error(`the query passed to '${s.callee}' has ${r.params} bound parameter${r.params === 1 ? "" : "s"} but ${s.argCount} argument${s.argCount === 1 ? " is" : "s are"} passed`, s.span,
        `one SqlArg per '?' (or per distinct '?N' / ':name'), in order`);
    }
    if (s.row) this.checkRow(s, r.columns, r.declTypes);
  }

  private checkRow(s: Site, columns: string[], declTypes: (string | null)[]): void {
    const row = s.row!;
    for (const f of row.fields) {
      const i = columns.indexOf(f.field);
      if (i < 0) {
        const snake = f.field.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
        const near = columns.includes(snake) ? `alias it: '${snake} AS ${f.field}'` : `select a column named '${f.field}' (or alias one: 'expr AS ${f.field}')`;
        this.host.error(`${row.name}.${f.field} has no column in the result of this query (columns: ${columns.join(", ") || "none"})`, s.span,
          `${row.name}.fromRow reads each field from the result column of the same name; ${near}`);
        continue;
      }
      const decl = declTypes[i];
      if (!decl) continue; // an expression column (count(*), a CASE): sqlite declares no type
      const aff = affinity(decl);
      const ok = f.kind === "Str" ? aff === "TEXT" || aff === "BLOB"
        : f.kind === "F64" ? aff === "REAL" || aff === "INTEGER" || aff === "NUMERIC"
        : aff === "INTEGER" || aff === "NUMERIC";
      if (!ok) {
        const t = { I64: "i64", I32: "i32", F64: "f64", Bool: "bool", Str: "string" }[f.kind];
        this.host.error(`${row.name}.${f.field} is ${f.optional ? `Option<${t}>` : t} but column '${f.field}' is declared ${decl}`, s.span,
          `change the field's type, or CAST the column in the query`);
      }
    }
  }

  // "did you mean" for an unknown table or column, from the schema itself.
  private hintFor(db: Database, error: string): string | null {
    const m = /^no such (table|column): (\S+)/.exec(error);
    if (!m) return null;
    const missing = m[2]!.replace(/^.*\./, "");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);
    const pool = m[1] === "table" ? tables
      : tables.flatMap(t => (db.query(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map(r => r.name));
    const near = didYouMean(suggestions(missing, new Set(pool)));
    if (near) return near;
    return m[1] === "table" ? `the schema has: ${tables.join(", ") || "no tables"}` : null;
  }
}

// The text `@embedFile("x.sql")` inlines, resolved the way lowering resolves it (relative to
// the calling file), so a schema can live in a .sql file. Null when it cannot be read;
// lowering reports that.
function embeddedText(e: Expr & { kind: "Call" }): string | null {
  const arg = e.args[0];
  if (e.args.length !== 1 || arg?.kind !== "StringLit" || !e.span?.file) return null;
  const path = resolve(dirname(e.span.file), arg.value);
  if (!existsSync(path) || statSync(path).isDirectory()) return null;
  return readFileSync(path, "utf-8");
}

// Bun 1.4 refuses declaredTypes until the statement has run once (1.3 read sqlite's
// decltype straight after prepare). So run it, every parameter NULL, inside a savepoint
// rolled back at once: the schema db is cached and shared by every later site. A run that
// fails (a NULL into NOT NULL) leaves the types unknown, and checkRow skips unknown types.
function declaredTypesOf(db: Database, st: Statement): (string | null)[] {
  const read = () => [...((st as unknown as { declaredTypes?: (string | null)[] }).declaredTypes ?? [])];
  try {
    return read();
  } catch {}
  db.run("SAVEPOINT milo_decltypes");
  try {
    st.get(...(Array(st.paramsCount).fill(null) as null[]));
    return read();
  } catch {
    return [];
  } finally {
    db.run("ROLLBACK TO milo_decltypes");
    db.run("RELEASE milo_decltypes");
  }
}

function sqliteMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function spanText(sp?: Span): string {
  return sp ? `${sp.file ?? "?"}:${sp.line}:${sp.col}` : "an unknown location";
}

// SQLite's column affinity rules (https://sqlite.org/datatype3.html §3.1), in its order.
function affinity(decl: string): "INTEGER" | "TEXT" | "BLOB" | "REAL" | "NUMERIC" {
  const d = decl.toUpperCase();
  if (d.includes("INT")) return "INTEGER";
  if (d.includes("CHAR") || d.includes("CLOB") || d.includes("TEXT")) return "TEXT";
  if (d.includes("BLOB") || d === "") return "BLOB";
  if (d.includes("REAL") || d.includes("FLOA") || d.includes("DOUB")) return "REAL";
  return "NUMERIC";
}
