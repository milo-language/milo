# std/sqlite

SQLite3 database bindings.

```milo
from "std/sqlite" import { Database, Statement, dbOpen, dbClose, dbExec, dbQuery, dbStep, dbColumnText, dbColumnInt, dbColumnInt64, dbColumnFloat, dbColumnCount, dbColumnIsNull, dbFinalize, dbBindInt, dbBindInt64, dbBindText, dbBindNull, dbReset, dbLastInsertId }
```

## Types

### Database

```milo
struct Database {
    _handle: *u8,
}
```

Handle to an open SQLite3 database connection.

### Statement

```milo
struct Statement {
    _handle: *u8,
    _db: *u8,
}
```

Prepared SQL statement. Must be finalized after use.

## Functions

### dbOpen

```milo
fn dbOpen(path: string): Result<Database>
```

Open or create a database at the given file path. Use `":memory:"` for an in-memory database.

### dbClose

```milo
fn dbClose(db: &Database)
```

Close the database connection.

### dbExec

```milo
fn dbExec(db: &Database, sql: string): Result<i32>
```

Execute a SQL statement that returns no rows (CREATE, INSERT, UPDATE, DELETE).

### dbQuery

```milo
fn dbQuery(db: &Database, sql: string): Result<Statement>
```

Prepare a SQL query for row-by-row iteration.

### dbStep

```milo
fn dbStep(stmt: &Statement): bool
```

Advance to the next row. Returns `true` if a row is available, `false` when done.

### dbColumnInt

```milo
fn dbColumnInt(stmt: &Statement, col: i32): i32
```

Read a 32-bit integer from the given column index (0-based).

### dbColumnInt64

```milo
fn dbColumnInt64(stmt: &Statement, col: i32): i64
```

Read a 64-bit integer from the given column index.

### dbColumnFloat

```milo
fn dbColumnFloat(stmt: &Statement, col: i32): f64
```

Read a double from the given column index.

### dbColumnText

```milo
fn dbColumnText(stmt: &Statement, col: i32): string
```

Read a string from the given column index.

### dbColumnCount

```milo
fn dbColumnCount(stmt: &Statement): i32
```

Return the number of columns in the result set.

### dbColumnIsNull

```milo
fn dbColumnIsNull(stmt: &Statement, col: i32): bool
```

Check if the value at the given column is NULL.

### dbFinalize

```milo
fn dbFinalize(stmt: &Statement)
```

Free the prepared statement resources.

### dbBindInt

```milo
fn dbBindInt(stmt: &Statement, index: i32, value: i32): Result<i32>
```

Bind a 32-bit integer to a parameter (1-based index).

### dbBindInt64

```milo
fn dbBindInt64(stmt: &Statement, index: i32, value: i64): Result<i32>
```

Bind a 64-bit integer to a parameter.

### dbBindText

```milo
fn dbBindText(stmt: &Statement, index: i32, value: string): Result<i32>
```

Bind a string to a parameter.

### dbBindNull

```milo
fn dbBindNull(stmt: &Statement, index: i32): Result<i32>
```

Bind NULL to a parameter.

### dbReset

```milo
fn dbReset(stmt: &Statement)
```

Reset a prepared statement so it can be re-executed with new bindings.

### dbLastInsertId

```milo
fn dbLastInsertId(db: &Database): i64
```

Return the rowid of the most recent successful INSERT.

## Example: Create and Query

```milo
from "std/sqlite" import { dbOpen, dbClose, dbExec, dbQuery, dbStep, dbColumnText, dbColumnInt, dbFinalize, dbBindText, dbBindInt }

fn main(): i32 {
    let db = dbOpen(":memory:")!

    dbExec(&db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")!
    dbExec(&db, "INSERT INTO users (name, age) VALUES ('Alice', 30)")!
    dbExec(&db, "INSERT INTO users (name, age) VALUES ('Bob', 25)")!

    // Query with prepared statement
    let stmt = dbQuery(&db, "SELECT name, age FROM users WHERE age > ?")!
    dbBindInt(&stmt, 1, 20)!

    while dbStep(&stmt) {
        let name = dbColumnText(&stmt, 0)
        let age = dbColumnInt(&stmt, 1)
        print(name + " is " + intToString(age))
    }

    dbFinalize(&stmt)
    dbClose(&db)

    return 0
}
```
