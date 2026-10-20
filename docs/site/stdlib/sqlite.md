# std/sqlite

SQLite3 database bindings, with SQL checked at compile time against the program's migrations (see [Checked SQL](#checked-sql)). Needs libsqlite3 at link time. A `Database` closes itself and a
`Statement` finalizes itself when it goes out of scope. `dbClose` and `dbFinalize` do it
early and consume the handle. A statement may outlive its connection: the connection is
freed when the last of them goes.

```milo
from "std/sqlite" import { Database, Statement, dbOpen, dbClose, dbExec, dbQuery, dbStep, dbColumnText, dbColumnInt, dbColumnInt64, dbColumnFloat, dbColumnCount, dbColumnIsNull, dbFinalize, dbBindInt, dbBindInt64, dbBindText, dbBindNull, dbReset, dbLastInsertId }
```

## Example: Create and Query

```milo
from "std/sqlite" import { dbOpen, dbClose, dbExec, dbQuery, dbStep, dbColumnText, dbColumnInt, dbFinalize, dbBindText, dbBindInt }

fn main(): i32 {
    let db = dbOpen(":memory:")!

    dbExec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")!
    dbExec(db, "INSERT INTO users (name, age) VALUES ('Alice', 30)")!
    dbExec(db, "INSERT INTO users (name, age) VALUES ('Bob', 25)")!

    // Query with prepared statement
    let stmt = dbQuery(db, "SELECT name, age FROM users WHERE age > ?")!
    dbBindInt(stmt, 1, 20)!

    while dbStep(stmt) {
        let name = dbColumnText(stmt, 0)
        let age = dbColumnInt(stmt, 1)
        print(name + " is " + age.toString())
    }

    // Optional: both would also happen when `stmt` and `db` go out of scope.
    dbFinalize(stmt)
    dbClose(db)

    return 0
}
```

## Checked SQL

`dbPrepare`, `dbRun` and `dbScalar` take their SQL through the `@sql` attribute: the
compiler prepares it at compile time against the schema the program's own migrations
([std/migrate](migrate)) build, and reports a syntax error, an unknown table or column, or a
bind-argument count that does not match the query's `?`s, at the literal. Parameters are
`SqlArg` values, bound in order.

```milo
from "std/sqlite" import { dbOpen, dbPrepare, dbRun, dbScalar, dbNext, dbColumnText, SqlArg }
from "std/migrate" import { Migration, dbMigrate }

fn main(): i32 {
    let db = dbOpen(":memory:")!
    dbMigrate(db, [Migration.sql(1, "users", "CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT NOT NULL)")])!
    dbRun(db, "INSERT INTO users (login) VALUES (?)", [SqlArg.Text("ada")])!
    let st = dbPrepare(db, "SELECT login FROM users WHERE id = ?", [SqlArg.Int(1)])!
    while dbNext(st)! {
        print(dbColumnText(st, 0))                         // ada
    }
    print(dbScalar(db, "SELECT count(*) FROM users", [])!) // Some(1)
    return 0
}
```

Change `login` to `logn` in the SELECT and the program no longer compiles:
`SQL error in the query passed to 'dbPrepare': no such column: logn`, with `did you mean
'login'?`.

What counts as constant: string literals, `+` between constants, `$"..."` whose holes are
constants, and immutable `let`s (local or module-level) holding one, so
`$"SELECT {USER_COLS} FROM users WHERE id = ?"` with a module-level `let USER_COLS` is
checked. SQL assembled at run time goes through `uncheckedSql(...)`, the explicit opt-out:
grep for it to find every query the compiler did not see. The older `dbQuery`/`dbExec`
take any string and are never checked, so existing code keeps compiling; `dbExec` is the
one for DDL and multi-statement scripts.

The rules hold whether or not the program has migrations; without any, the constant rule
applies but there is no schema to prepare against. The schema is the migration list, so
the compiler cannot check against a database the program would not build. One schema per
program: two migrations sharing a version are an error once the program checks SQL.

A wrapper of your own gets the same checking by naming its SQL parameter, and optionally
its bind arguments: `@sql(sql, args)`. Its callers' SQL is checked; inside it, passing the
parameter on to `dbPrepare` is accepted as is.

```milo
from "std/sqlite" import { Database, dbPrepare, dbNext, SqlArg }

@sql(sql, args)
fn exists(db: &Database, sql: string, args: Vec<SqlArg>): Result<bool> {
    let st = dbPrepare(db, sql, args)?
    return dbNext(st)
}
```

## Reading rows into structs

`@derive(Row)` on a struct generates `fromRow(st)`, which reads each field from the result
column of the same name (alias snake_case columns: `github_id AS githubId`), and two
checked queries: `fetchAll(db, sql, args): Result<Vec<T>>` and
`fetchOne(db, sql, args): Result<Option<T>>`. For those two the compiler also matches the
query's result columns against the fields: a field with no column of its name, or whose type
cannot hold the column's declared type (an `i64` read from a `TEXT` column), is a compile
error naming the field. A NULL in a non-`Option` field is still a run-time error, since
sqlite does not report a result column's nullability.

```milo
from "std/sqlite" import { dbOpen, dbRun, SqlArg }
from "std/migrate" import { Migration, dbMigrate }

@derive(Row)
struct User {
    id: i64,
    githubId: i64,
    login: string,
}

fn main(): i32 {
    let db = dbOpen(":memory:")!
    dbMigrate(db, [Migration.sql(1, "users", "CREATE TABLE users (id INTEGER PRIMARY KEY, github_id INTEGER NOT NULL, login TEXT NOT NULL)")])!
    dbRun(db, "INSERT INTO users (github_id, login) VALUES (?, ?)", [SqlArg.Int(7), SqlArg.Text("ada")])!
    let users = User.fetchAll(db, "SELECT id, github_id AS githubId, login FROM users", [])!
    print(users[0].githubId)                               // 7
    return 0
}
```

<!-- generated:api -->
<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/sqlite*.milo. -->

## API reference

### `Database`

```milo
pub struct Database
```

An open SQLite3 connection, closed when it goes out of scope (or by `dbClose`).

Both handles own what sqlite handed back, so the pointer fields make them
move-tracked: a second copy would `close`/`finalize` the same object again.

#### `Database.handle`

```milo
fn Database.handle(self: &Database): *u8
```

The raw `sqlite3*`, for callers that reach sqlite3 functions this module does not
wrap. Borrowed: the Database still owns and closes it.

### `SqlArg`

```milo
pub enum SqlArg
```

One bound parameter, in `?` order.

Variants:

- `Int(i64)`
- `Float(f64)`
- `Text(string)`
- `Null`

### `Statement`

```milo
pub struct Statement
```

A prepared SQL statement, finalized when it goes out of scope (or by `dbFinalize`).

#### `Statement.handle`

```milo
fn Statement.handle(self: &Statement): *u8
```

The raw `sqlite3_stmt*`, for callers that reach sqlite3 functions this module does
not wrap. Borrowed: the Statement still owns and finalizes it.

### `Transaction`

```milo
pub struct Transaction
```

An open transaction. Rolls back when it goes out of scope; `commit()` is the only way
to keep the writes. Move-only (the raw handle makes it move-tracked), and `commit` /
`rollback` consume it, so it cannot be used afterwards.

  let tx = dbBegin(db)?
  dbExec(db, "INSERT ...")?     // an early return via `?` drops tx -> ROLLBACK
  tx.commit()?

Fields: `done: bool`.

#### `Transaction.commit`

```milo
fn Transaction.commit(self: Transaction): Result<i32>
```

COMMIT, consuming the guard. On Err the transaction is still open in sqlite
(e.g. SQLITE_BUSY), so the guard rolls it back as it drops at the end of this fn.

#### `Transaction.rollback`

```milo
fn Transaction.rollback(self: Transaction): Result<i32>
```

ROLLBACK now, consuming the guard.

### Functions

#### `dbBegin`

```milo
pub fn dbBegin(db: &Database): Result<Transaction>
```

BEGIN a deferred transaction. Hold the result in a `let`; it rolls back on drop.

#### `dbBeginImmediate`

```milo
pub fn dbBeginImmediate(db: &Database): Result<Transaction>
```

BEGIN IMMEDIATE: takes the write lock up front, so a write transaction under WAL
contention fails here with SQLITE_BUSY rather than at its first write.

#### `dbBindFloat`

```milo
pub fn dbBindFloat(stmt: &Statement, idx: i32, val: f64): Result<i32>
```

Bind an f64 to parameter `idx` (1-based). A whole-number value still binds as REAL;
SQLite compares REAL and INTEGER by value, so a range check against an INTEGER
column means the same either way.

#### `dbBindInt`

```milo
pub fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32>
```

Bind an i32 to parameter `idx`. Parameter indices are 1-based.

#### `dbBindInt64`

```milo
pub fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32>
```

Bind an i64 to parameter `idx` (1-based).

#### `dbBindNull`

```milo
pub fn dbBindNull(stmt: &Statement, idx: i32): Result<i32>
```

Bind NULL to parameter `idx` (1-based).

#### `dbBindText`

```milo
pub fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32>
```

Bind a string to parameter `idx` (1-based). Every byte is bound, embedded NULs too.

#### `dbClose`

```milo
pub fn dbClose(db: Database): void
```

Close the connection now rather than at the end of its scope. It consumes `db`:
taking it by reference left a closed handle usable, and the next call on it was a
use-after-free. Statements still alive keep working; see `sqlite3_close_v2`.

#### `dbColumnCount`

```milo
pub fn dbColumnCount(stmt: &Statement): i32
```

Number of columns in the result set.

#### `dbColumnFloat`

```milo
pub fn dbColumnFloat(stmt: &Statement, col: i32): f64
```

The column `col` (0-based) of the current row as an f64.

#### `dbColumnIndex`

```milo
pub fn dbColumnIndex(stmt: &Statement, name: &string, what: &string): Result<i32>
```

Index of the column named exactly `name`, or Err naming `what` (the "Struct.field"
being read) when the result has no such column.

#### `dbColumnInt`

```milo
pub fn dbColumnInt(stmt: &Statement, col: i32): i32
```

The column `col` (0-based) of the current row as an i32.

#### `dbColumnInt64`

```milo
pub fn dbColumnInt64(stmt: &Statement, col: i32): i64
```

The column `col` (0-based) of the current row as an i64.

#### `dbColumnIsNull`

```milo
pub fn dbColumnIsNull(stmt: &Statement, col: i32): bool
```

Whether column `col` (0-based) of the current row is NULL.

#### `dbColumnName`

```milo
pub fn dbColumnName(stmt: &Statement, col: i32): string
```

The name of column `col` (0-based) in the result set: the SQL alias when there is one
(`SELECT p.user_id AS userId` is "userId"). Empty when `col` is out of range.

#### `dbColumnText`

```milo
pub fn dbColumnText(stmt: &Statement, col: i32): string
```

The column `col` (0-based) of the current row as a string, every byte of it:
embedded NULs are kept.

#### `dbExec`

```milo
pub fn dbExec(db: &Database, sql: string): Result<i32>
```

Execute SQL that returns no rows (CREATE, INSERT, UPDATE, DELETE). Errs with sqlite's
message.

#### `dbExecDdl`

```milo
pub fn dbExecDdl(db: &Database, sql: string): Result<i32>
```

Run DDL the program creates at run time instead of in a migration, typically a TEMP
table a job fills and joins against. Like `dbExec`, but `sql` must be a compile-time
constant, and the compiler adds it, after the migrations, to the schema checked SQL is
prepared against, so queries over the temp table are checked too. Use `CREATE TEMP
TABLE IF NOT EXISTS` when it can run twice on one connection.

#### `dbFinalize`

```milo
pub fn dbFinalize(stmt: Statement): void
```

Free the prepared statement now rather than at the end of its scope. Consumes
`stmt` for the reason `dbClose` consumes its handle.

#### `dbLastInsertId`

```milo
pub fn dbLastInsertId(db: &Database): i64
```

The rowid of the most recent successful INSERT on this connection.

#### `dbNext`

```milo
pub fn dbNext(stmt: &Statement): Result<bool>
```

Advance to the next row: Ok(true) for a row, Ok(false) when done, and Err with
sqlite's message when the step fails (a constraint violation, a busy database, or a
table dropped since the statement was prepared, which prepare cannot see).

#### `dbOpen`

```milo
pub fn dbOpen(path: string): Result<Database>
```

Open or create the database at `path`. `":memory:"` opens an in-memory database.

Also sets the pragmas a small service wants, so every caller does not have to:
`busy_timeout=5000` (a writer behind another waits up to 5 s instead of failing with
SQLITE_BUSY), `journal_mode=WAL` (readers keep running during a write; skipped for
`":memory:"` and `""`, which have no journal file), `synchronous=NORMAL` (safe under
WAL: a crash can lose the last commits but never corrupts) and `foreign_keys=ON`
(sqlite leaves them unenforced by default). Errs naming the pragma that failed.

#### `dbPrepare`

```milo
pub fn dbPrepare(db: &Database, sql: string, args: Vec<SqlArg>): Result<Statement>
```

Prepare `sql` (checked at compile time) and bind `args` to its `?`s in order.

#### `dbQuery`

```milo
pub fn dbQuery(db: &Database, sql: string): Result<Statement>
```

Prepare a query for row-by-row iteration with `dbStep`.

#### `dbReset`

```milo
pub fn dbReset(stmt: &Statement): void
```

Reset the statement so it can run again with new bindings.

#### `dbRowBool`

```milo
pub fn dbRowBool(st: &Statement, name: &string, what: &string): Result<bool>
```

The column `name` of the current row as a bool (nonzero is true); NULL is an Err naming `what`. Called by `@derive(Row)`.

#### `dbRowF64`

```milo
pub fn dbRowF64(st: &Statement, name: &string, what: &string): Result<f64>
```

The column `name` of the current row as an f64; NULL is an Err naming `what`. Called by `@derive(Row)`.

#### `dbRowI32`

```milo
pub fn dbRowI32(st: &Statement, name: &string, what: &string): Result<i32>
```

The column `name` of the current row as an i32; NULL is an Err naming `what`. Called by `@derive(Row)`.

#### `dbRowI64`

```milo
pub fn dbRowI64(st: &Statement, name: &string, what: &string): Result<i64>
```

The column `name` of the current row as an i64; NULL is an Err naming `what`. Called by `@derive(Row)`.

#### `dbRowOptBool`

```milo
pub fn dbRowOptBool(st: &Statement, name: &string, what: &string): Result<bool?>
```

The column `name` of the current row as a bool (nonzero is true), NULL as None. Called by `@derive(Row)`.

#### `dbRowOptF64`

```milo
pub fn dbRowOptF64(st: &Statement, name: &string, what: &string): Result<f64?>
```

The column `name` of the current row as an f64, NULL as None. Called by `@derive(Row)`.

#### `dbRowOptI32`

```milo
pub fn dbRowOptI32(st: &Statement, name: &string, what: &string): Result<i32?>
```

The column `name` of the current row as an i32, NULL as None. Called by `@derive(Row)`.

#### `dbRowOptI64`

```milo
pub fn dbRowOptI64(st: &Statement, name: &string, what: &string): Result<i64?>
```

The column `name` of the current row as an i64, NULL as None. Called by `@derive(Row)`.

#### `dbRowOptStr`

```milo
pub fn dbRowOptStr(st: &Statement, name: &string, what: &string): Result<string?>
```

The column `name` of the current row as a string, NULL as None. Called by `@derive(Row)`.

#### `dbRowStr`

```milo
pub fn dbRowStr(st: &Statement, name: &string, what: &string): Result<string>
```

The column `name` of the current row as a string; NULL is an Err naming `what`. Called by `@derive(Row)`.

#### `dbRun`

```milo
pub fn dbRun(db: &Database, sql: string, args: Vec<SqlArg>): Result<i64>
```

Run `sql` (checked at compile time) to completion with `args` bound; the number of rows
it inserted, updated or deleted.

#### `dbScalar`

```milo
pub fn dbScalar(db: &Database, sql: string, args: Vec<SqlArg>): Result<Option<i64>>
```

The first column of the first row of `sql` (checked at compile time) as an i64: None
when there is no row or the value is NULL. For `SELECT count(*) ...` and `SELECT 1 ...
LIMIT 1` existence probes.

#### `dbStep`

```milo
pub fn dbStep(stmt: &Statement): bool
```

Advance to the next row: true if a row is available, false when done. An error also
reads as false; use dbNext where a failed step must not pass for an empty result.

#### `sqlOptInt`

```milo
pub fn sqlOptInt(v: Option<i64>): SqlArg
```

`SqlArg.Int(v)` for Some, `SqlArg.Null` for None.

#### `sqlOptText`

```milo
pub fn sqlOptText(v: &Option<string>): SqlArg
```

`SqlArg.Text(v)` for Some, `SqlArg.Null` for None.

#### `uncheckedSql`

```milo
pub fn uncheckedSql(sql: string): string
```

`sql`, unchanged: the explicit opt-out from compile-time checking for SQL built at run
time. The checker accepts any string inside it, so grep for it to find every query the
compiler did not see.

<!-- /generated:api -->
