# std/sqlite

## std/sqlite

### `dbBindInt`

```milo
fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32>
```

_Undocumented._

### `dbBindInt64`

```milo
fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32>
```

_Undocumented._

### `dbBindNull`

```milo
fn dbBindNull(stmt: &Statement, idx: i32): Result<i32>
```

_Undocumented._

### `dbBindText`

```milo
fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32>
```

_Undocumented._

### `dbClose`

```milo
fn dbClose(db: &Database): void
```

_Undocumented._

### `dbColumnCount`

```milo
fn dbColumnCount(stmt: &Statement): i32
```

_Undocumented._

### `dbColumnFloat`

```milo
fn dbColumnFloat(stmt: &Statement, col: i32): f64
```

_Undocumented._

### `dbColumnInt`

```milo
fn dbColumnInt(stmt: &Statement, col: i32): i32
```

_Undocumented._

### `dbColumnInt64`

```milo
fn dbColumnInt64(stmt: &Statement, col: i32): i64
```

_Undocumented._

### `dbColumnIsNull`

```milo
fn dbColumnIsNull(stmt: &Statement, col: i32): bool
```

_Undocumented._

### `dbColumnText`

```milo
fn dbColumnText(stmt: &Statement, col: i32): string
```

_Undocumented._

### `dbExec`

```milo
fn dbExec(db: &Database, sql: string): Result<i32>
```

_Undocumented._

### `dbFinalize`

```milo
fn dbFinalize(stmt: &Statement): void
```

_Undocumented._

### `dbLastInsertId`

```milo
fn dbLastInsertId(db: &Database): i64
```

_Undocumented._

### `dbOpen`

```milo
fn dbOpen(path: string): Result<Database>
```

_Undocumented._

### `dbQuery`

```milo
fn dbQuery(db: &Database, sql: string): Result<Statement>
```

_Undocumented._

### `dbReset`

```milo
fn dbReset(stmt: &Statement): void
```

_Undocumented._

### `dbStep`

```milo
fn dbStep(stmt: &Statement): bool
```

_Undocumented._
