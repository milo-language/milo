# std/sqlite

## std/sqlite

### `Database.handle`

```milo
fn Database.handle(self: &Database): *u8
```

The raw `sqlite3*`, for callers that reach sqlite3 functions this module does not
wrap. Borrowed: the Database still owns and closes it.

### `dbBindInt`

```milo
pub fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32>
```

Bind an i32 to parameter `idx`. Parameter indices are 1-based.

### `dbBindInt64`

```milo
pub fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32>
```

Bind an i64 to parameter `idx` (1-based).

### `dbBindNull`

```milo
pub fn dbBindNull(stmt: &Statement, idx: i32): Result<i32>
```

Bind NULL to parameter `idx` (1-based).

### `dbBindText`

```milo
pub fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32>
```

Bind a string to parameter `idx` (1-based).

### `dbClose`

```milo
pub fn dbClose(db: &Database): void
```

Close the connection. Nothing closes it on drop.

### `dbColumnCount`

```milo
pub fn dbColumnCount(stmt: &Statement): i32
```

Number of columns in the result set.

### `dbColumnFloat`

```milo
pub fn dbColumnFloat(stmt: &Statement, col: i32): f64
```

The column `col` (0-based) of the current row as an f64.

### `dbColumnInt`

```milo
pub fn dbColumnInt(stmt: &Statement, col: i32): i32
```

The column `col` (0-based) of the current row as an i32.

### `dbColumnInt64`

```milo
pub fn dbColumnInt64(stmt: &Statement, col: i32): i64
```

The column `col` (0-based) of the current row as an i64.

### `dbColumnIsNull`

```milo
pub fn dbColumnIsNull(stmt: &Statement, col: i32): bool
```

Whether column `col` (0-based) of the current row is NULL.

### `dbColumnText`

```milo
pub fn dbColumnText(stmt: &Statement, col: i32): string
```

The column `col` (0-based) of the current row as a string.

### `dbExec`

```milo
pub fn dbExec(db: &Database, sql: string): Result<i32>
```

Execute SQL that returns no rows (CREATE, INSERT, UPDATE, DELETE). Errs with sqlite's
message.

### `dbFinalize`

```milo
pub fn dbFinalize(stmt: &Statement): void
```

Free the prepared statement.

### `dbLastInsertId`

```milo
pub fn dbLastInsertId(db: &Database): i64
```

The rowid of the most recent successful INSERT on this connection.

### `dbOpen`

```milo
pub fn dbOpen(path: string): Result<Database>
```

Open or create the database at `path`. `":memory:"` opens an in-memory database.

### `dbQuery`

```milo
pub fn dbQuery(db: &Database, sql: string): Result<Statement>
```

Prepare a query for row-by-row iteration with `dbStep`.

### `dbReset`

```milo
pub fn dbReset(stmt: &Statement): void
```

Reset the statement so it can run again with new bindings.

### `dbStep`

```milo
pub fn dbStep(stmt: &Statement): bool
```

Advance to the next row: true if a row is available, false when done.

### `Statement.handle`

```milo
fn Statement.handle(self: &Statement): *u8
```

The raw `sqlite3_stmt*`, for callers that reach sqlite3 functions this module does
not wrap. Borrowed: the Statement still owns and finalizes it.
