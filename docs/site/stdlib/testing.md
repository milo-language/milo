# std/testing

Test assertion helpers.

```milo
from "std/testing" import { assert, assertEqual, assertStrEqual }
```

## Functions

### assert

```milo
fn assert(cond: bool)
```

Aborts if `cond` is `false`.

### assertMsg

```milo
fn assertMsg(cond: bool, msg: string)
```

Aborts with a custom message if `cond` is `false`.

### assertEqual

```milo
fn assertEqual(actual: i32, expected: i32)
```

Asserts two `i32` values are equal.

### assertEqual64

```milo
fn assertEqual64(actual: i64, expected: i64)
```

Asserts two `i64` values are equal.

### assertStrEqual

```milo
fn assertStrEqual(actual: &string, expected: &string)
```

Asserts two strings are equal.

### assertBool

```milo
fn assertBool(actual: bool, expected: bool)
```

Asserts two booleans are equal.
