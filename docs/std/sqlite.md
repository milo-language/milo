# std/sqlite

## std/sqlite

### `dbBindInt`

```milo
pub fn dbBindInt(stmt: &Statement, idx: i32, val: i32): Result<i32>
```

_Undocumented._

### `dbBindInt64`

```milo
pub fn dbBindInt64(stmt: &Statement, idx: i32, val: i64): Result<i32>
```

_Undocumented._

### `dbBindNull`

```milo
pub fn dbBindNull(stmt: &Statement, idx: i32): Result<i32>
```

_Undocumented._

### `dbBindText`

```milo
pub fn dbBindText(stmt: &Statement, idx: i32, val: string): Result<i32>
```

_Undocumented._

### `dbClose`

```milo
pub fn dbClose(db: &Database): void
```

_Undocumented._

### `dbColumnCount`

```milo
pub fn dbColumnCount(stmt: &Statement): i32
```

_Undocumented._

### `dbColumnFloat`

```milo
pub fn dbColumnFloat(stmt: &Statement, col: i32): f64
```

_Undocumented._

### `dbColumnInt`

```milo
pub fn dbColumnInt(stmt: &Statement, col: i32): i32
```

_Undocumented._

### `dbColumnInt64`

```milo
pub fn dbColumnInt64(stmt: &Statement, col: i32): i64
```

_Undocumented._

### `dbColumnIsNull`

```milo
pub fn dbColumnIsNull(stmt: &Statement, col: i32): bool
```

_Undocumented._

### `dbColumnText`

```milo
pub fn dbColumnText(stmt: &Statement, col: i32): string
```

_Undocumented._

### `dbExec`

```milo
pub fn dbExec(db: &Database, sql: string): Result<i32>
```

_Undocumented._

### `dbFinalize`

```milo
pub fn dbFinalize(stmt: &Statement): void
```

_Undocumented._

### `dbLastInsertId`

```milo
pub fn dbLastInsertId(db: &Database): i64
```

_Undocumented._

### `dbOpen`

```milo
pub fn dbOpen(path: string): Result<Database>
```

_Undocumented._

### `dbQuery`

```milo
pub fn dbQuery(db: &Database, sql: string): Result<Statement>
```

_Undocumented._

### `dbReset`

```milo
pub fn dbReset(stmt: &Statement): void
```

_Undocumented._

### `dbStep`

```milo
pub fn dbStep(stmt: &Statement): bool
```

_Undocumented._
