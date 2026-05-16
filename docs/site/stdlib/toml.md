# std/toml

TOML config file parsing.

```milo
from "std/toml" import { Toml, tomlParse }
```

## Types

### Toml

```milo
struct Toml {
    raw: string,
    start: i64,
    end: i64,
}
```

A parsed TOML document or sub-table. Access values by key using typed accessor methods.

#### Methods

```milo
fn str(&self, key: &string): Option<string>
fn i64(&self, key: &string): Option<i64>
fn f64(&self, key: &string): Option<f64>
fn bool(&self, key: &string): Option<bool>
fn table(&self, key: &string): Option<Toml>
```

## Functions

### tomlParse

```milo
fn tomlParse(input: string): Result<Toml>
```

Parses a TOML string into a `Toml` value.

## Example

```milo
from "std/toml" import { tomlParse }
from "std/fs" import { readFile }

let text = readFile("config.toml")!
let config = tomlParse(text)!

let title = config.str(&"title")
let port = config.i64(&"port")

match config.table(&"database") {
    Some(db) => {
        let host = db.str(&"host")
        let maxConn = db.i64(&"max_connections")
    }
    None => print("no [database] section")
}
```
