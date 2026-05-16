# std/json

Zero-copy JSON parser with typed accessors.

```milo
from "std/json" import { Json, jsonParse }
```

## Types

### Json

```milo
struct Json {
    raw: string,
    start: i64,
    end: i64,
}
```

A view into a parsed JSON string. All accessors operate on the underlying `raw` buffer without copying.

#### Json.get

```milo
fn get(self, key: &string): Option<Json>
```

Look up an object key, returning a `Json` view of the value.

#### Json.str

```milo
fn str(self, key: &string): Option<string>
```

Get a string value by key.

#### Json.i64

```milo
fn i64(self, key: &string): Option<i64>
```

Get an integer value by key.

#### Json.f64

```milo
fn f64(self, key: &string): Option<f64>
```

Get a float value by key.

#### Json.bool

```milo
fn bool(self, key: &string): Option<bool>
```

Get a boolean value by key.

#### Json.asStr

```milo
fn asStr(self): Option<string>
```

Read the current node as a string.

#### Json.asI64

```milo
fn asI64(self): Option<i64>
```

Read the current node as an integer.

#### Json.asF64

```milo
fn asF64(self): Option<f64>
```

Read the current node as a float.

#### Json.asBool

```milo
fn asBool(self): Option<bool>
```

Read the current node as a boolean.

#### Json.at

```milo
fn at(self, index: i64): Option<Json>
```

Index into a JSON array.

#### Json.isNull

```milo
fn isNull(self): bool
```

#### Json.isStr

```milo
fn isStr(self): bool
```

#### Json.isNum

```milo
fn isNum(self): bool
```

#### Json.isBool

```milo
fn isBool(self): bool
```

#### Json.isArray

```milo
fn isArray(self): bool
```

#### Json.isObject

```milo
fn isObject(self): bool
```

#### Json.len

```milo
fn len(self): i64
```

Length of an array or object.

#### Json.rawStr

```milo
fn rawStr(self): string
```

The raw JSON text for this node.

#### Json.keys

```milo
fn keys(self): Vec<string>
```

List all keys of an object.

## Functions

### jsonParse

```milo
fn jsonParse(s: string): Result<Json>
```

Parse a JSON string. The returned `Json` borrows the input.

## Example

```milo
from "std/json" import { Json, jsonParse }
from "std/io" import { writeStdout }

fn main(): i32 {
    let data = jsonParse("{\"name\": \"milo\", \"version\": 1, \"tags\": [\"fast\", \"safe\"]}")!

    match data.str("name") {
        Some(name) => writeStdout(&name),
        None => writeStdout("unknown"),
    }

    let tags = data.get("tags")
    match tags {
        Some(arr) => {
            let first = arr.at(0)
            match first {
                Some(tag) => {
                    match tag.asStr() {
                        Some(s) => writeStdout(&s),
                        None => {},
                    }
                },
                None => {},
            }
        },
        None => {},
    }

    return 0
}
```
