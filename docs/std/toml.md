# std/toml

## std/toml

### `Toml.bool`

```milo
fn Toml.bool(self: &Toml, key: &string): Option<bool>
```

_Undocumented._

### `Toml.f64`

```milo
fn Toml.f64(self: &Toml, key: &string): Option<f64>
```

_Undocumented._

### `Toml.i64`

```milo
fn Toml.i64(self: &Toml, key: &string): Option<i64>
```

_Undocumented._

### `Toml.str`

```milo
fn Toml.str(self: &Toml, key: &string): Option<string>
```

_Undocumented._

### `Toml.table`

```milo
fn Toml.table(self: &Toml, key: &string): Option<Toml>
```

_Undocumented._

### `tomlGetBool`

```milo
fn tomlGetBool(s: &string, start: i64, end: i64, key: &string): Option<bool>
```

_Undocumented._

### `tomlGetF64`

```milo
fn tomlGetF64(s: &string, start: i64, end: i64, key: &string): Option<f64>
```

_Undocumented._

### `tomlGetI64`

```milo
fn tomlGetI64(s: &string, start: i64, end: i64, key: &string): Option<i64>
```

_Undocumented._

### `tomlGetStr`

```milo
fn tomlGetStr(s: &string, start: i64, end: i64, key: &string): Option<string>
```

_Undocumented._

### `tomlGetTable`

```milo
fn tomlGetTable(s: &string, start: i64, end: i64, key: &string): Option<Toml>
```

_Undocumented._

### `tomlParse`

```milo
fn tomlParse(s: string): Result<Toml>
```

_Undocumented._
