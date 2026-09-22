# std/json

## std/json

### `Json.arr`

```milo
fn Json.arr(): JsonArr
```

New empty array builder.

### `Json.asBool`

```milo
fn Json.asBool(self: &Json): Option<bool>
```

This node as a boolean, or None if it is not one.

### `Json.asF64`

```milo
fn Json.asF64(self: &Json): Option<f64>
```

This node as a float, or None if it is not a number.

### `Json.asI64`

```milo
fn Json.asI64(self: &Json): Option<i64>
```

This node as an integer, or None if it is not one. Fractional, exponent and
out-of-range literals are None, as for `i64`.

### `Json.asStr`

```milo
fn Json.asStr(self: &Json): Option<string>
```

This node as a string, or None if it is not one.

### `Json.at`

```milo
fn Json.at(self: &Json, index: i64): Option<Json>
```

Element `index` of an array as its own `Json`, or None if this is not an array or
the index is out of range. Deep-clones like `get`.

### `Json.bool`

```milo
fn Json.bool(self: &Json, key: &string): Option<bool>
```

The boolean value of object key `key`, or None if absent or not a boolean.

### `Json.boolPath`

```milo
fn Json.boolPath(self: &Json, p: &string): Option<bool>
```

_Undocumented._

### `Json.curBool`

```milo
fn Json.curBool(self: &Json, cur: i64): Option<bool>
```

_Undocumented._

### `Json.curChild`

```milo
fn Json.curChild(self: &Json, cur: i64, index: i64): i64
```

_Undocumented._

### `Json.curField`

```milo
fn Json.curField(self: &Json, cur: i64, key: &string): i64
```

_Undocumented._

### `Json.curFloat`

```milo
fn Json.curFloat(self: &Json, cur: i64): Option<f64>
```

_Undocumented._

### `Json.curHolds`

```milo
fn Json.curHolds(self: &Json, cur: i64): bool
```

Whether `cur` is a cursor into THIS document (and in range). Branch on
this for a cursor you did not navigate to yourself; the accessors abort
on a foreign cursor instead. False for -1. Mirrors Sealed.holds.

### `Json.curInt`

```milo
fn Json.curInt(self: &Json, cur: i64): Option<i64>
```

_Undocumented._

### `Json.curKeyAt`

```milo
fn Json.curKeyAt(self: &Json, cur: i64, index: i64): string
```

Key of the object child at `index`. `keys()` answers the same question for the
ROOT only, which is no help to a nested object whose keys are not known ahead of
time — decoding a `HashMap<string, V>` field has to walk children it cannot name.
Empty string for a non-object cursor or an out-of-range index; "" is also a legal
JSON key, so bound the walk with `curLen` rather than testing the result.

### `Json.curKind`

```milo
fn Json.curKind(self: &Json, cur: i64): i32
```

Node kind at the cursor: 0 null, 1 bool, 2 number, 3 string, 4 array,
5 object; -1 if the cursor is invalid.

### `Json.curLen`

```milo
fn Json.curLen(self: &Json, cur: i64): i64
```

_Undocumented._

### `Json.curPath`

```milo
fn Json.curPath(self: &Json, p: &string): i64
```

Cursor at the end of a dotted path — "a.b", "items[0].name". A missing key,
an out-of-range index or a shape mismatch yields -1, which every cursor
accessor already reads as "nothing here", so the walk is total for any input.
A key containing '.' or '[' is not addressable this way; use get()/at().

### `Json.curRoot`

```milo
fn Json.curRoot(self: &Json): i64
```


`get`/`at` above return an owned Json by deep-cloning the whole document
(source string + every node) per call — navigating a large doc thousands
of times blows up to gigabytes. The cursor API instead hands out an `i64`
cursor into THIS document: navigation returns cursors (-1 = missing) with
zero allocation, and only leaf-string reads materialize (just that one
string). Start at `curRoot()` and chain:
  let user = doc.curField(doc.curChild(doc.curRoot(), 0), "name")
  match doc.curStr(user) { Option.Some(s) => ..., Option.None => ... }

A cursor is not a bare node index: the document's brand rides in its
high bits (see jsonCurResolve above). Resolving a cursor against a
different Json used to read a wrong-but-in-bounds node of the other
document and report nothing; now it aborts, naming the mistake. -1 still
flows through every accessor as "nothing here", so navigation stays
total for any in-document miss. A memberwise copy of a Json shares its
brand, which is sound because copying preserves node numbering; the
documents `get`/`at`/`path` return carry a fresh brand because
extraction renumbers the pool.

This is one of two ways to reach a nested value. The other is to chain the
owned accessors with `Option.andThen` — `doc.at(0).andThen((j) => j.str("name"))`
— which reads better but pays one deep clone per hop. Both replaced the family
of fixed-shape accessors (`strAt`, `childI64At`, …) this module used to carry;
see docs/breaking-changes.md.

### `Json.curStr`

```milo
fn Json.curStr(self: &Json, cur: i64): Option<string>
```

_Undocumented._

### `Json.curUint`

```milo
fn Json.curUint(self: &Json, cur: i64): Option<u64>
```

Unsigned read, for values above i64::MAX that `curInt` must reject.

### `Json.curValueAt`

```milo
fn Json.curValueAt(self: &Json, cur: i64, index: i64): i64
```

Value of the object child at `index`, the other half of curKeyAt. Deliberately
separate from `curChild`, which is the ARRAY accessor and returns -1 for an object:
"element i of an array" and "entry i of an object" are different questions, and one
function answering both would make an object walked as an array look like it worked.

### `Json.f64`

```milo
fn Json.f64(self: &Json, key: &string): Option<f64>
```

The numeric value of object key `key` as a float, or None if absent or not a
number.

### `Json.f64Path`

```milo
fn Json.f64Path(self: &Json, p: &string): Option<f64>
```

_Undocumented._

### `Json.get`

```milo
fn Json.get(self: &Json, key: &string): Option<Json>
```

The value of object key `key` as its own `Json`, or None if this is not an object
or has no such key. Deep-clones the subtree on every call; for hot navigation use
the cursor API (`curRoot`, `curField`, ...).

### `Json.i64`

```milo
fn Json.i64(self: &Json, key: &string): Option<i64>
```

The integer value of object key `key`, or None if absent or not an integer. Only
a literal that is an integer and fits i64 answers Some: `1.5`, `1e3` and
out-of-range values are None, never a truncation.

### `Json.i64Path`

```milo
fn Json.i64Path(self: &Json, p: &string): Option<i64>
```

_Undocumented._

### `Json.isArray`

```milo
fn Json.isArray(self: &Json): bool
```

_Undocumented._

### `Json.isBool`

```milo
fn Json.isBool(self: &Json): bool
```

_Undocumented._

### `Json.isNull`

```milo
fn Json.isNull(self: &Json): bool
```

_Undocumented._

### `Json.isNum`

```milo
fn Json.isNum(self: &Json): bool
```

_Undocumented._

### `Json.isObject`

```milo
fn Json.isObject(self: &Json): bool
```

_Undocumented._

### `Json.isStr`

```milo
fn Json.isStr(self: &Json): bool
```

_Undocumented._

### `Json.keys`

```milo
fn Json.keys(self: &Json): Vec<string>
```

Every key of an object, in document order.

### `Json.len`

```milo
fn Json.len(self: &Json): i64
```

Number of elements of an array or members of an object.

### `Json.obj`

```milo
fn Json.obj(): JsonObj
```

New empty object builder: Json.obj().set("k", ...).build().

### `Json.parse`

```milo
fn Json.parse(s: &string): Result<Json>
```

Parse strict RFC 8259 JSON. Propagate failures with `?` or match on the error.
Takes a borrow because most callers hold the text in a buffer they still need;
the document owns its source, so this copies once. A caller done with its owned
buffer can hand it to `jsonParse` and skip the copy.

### `Json.parseJsonc`

```milo
fn Json.parseJsonc(s: &string): Result<Json>
```

Parse JSON with JSONC extensions (comments, trailing commas). Borrows like `parse`;
`jsoncParse` is the owned form.

### `Json.path`

```milo
fn Json.path(self: &Json, p: &string): Option<Json>
```

_Undocumented._

### `Json.pretty`

```milo
fn Json.pretty(self: &Json, indent: i64): string
```

The document re-rendered with `indent` spaces per level (0 or less
minifies). Reformats rawStr(), so what comes out is the same bytes the
parse went in with, only re-spaced (see jsonPretty).

### `Json.rawStr`

```milo
fn Json.rawStr(self: &Json): string
```

The raw JSON text of this node.

### `Json.str`

```milo
fn Json.str(self: &Json, key: &string): Option<string>
```

The string value of object key `key`, or None if absent or not a string.

### `Json.strPath`

```milo
fn Json.strPath(self: &Json, p: &string): Option<string>
```

_Undocumented._

### `JsonArr.arr`

```milo
fn JsonArr.arr(self: JsonArr, val: JsonArr): JsonArr
```

_Undocumented._

### `JsonArr.bool`

```milo
fn JsonArr.bool(self: JsonArr, val: bool): JsonArr
```

_Undocumented._

### `JsonArr.build`

```milo
fn JsonArr.build(self: &JsonArr): string
```

_Undocumented._

### `JsonArr.buildPretty`

```milo
fn JsonArr.buildPretty(self: &JsonArr, indent: i64): string
```

build() with `indent` spaces per nesting level (0 or less minifies).

### `JsonArr.float`

```milo
fn JsonArr.float(self: JsonArr, val: f64): JsonArr
```

_Undocumented._

### `JsonArr.int`

```milo
fn JsonArr.int(self: JsonArr, val: i64): JsonArr
```

_Undocumented._

### `JsonArr.nil`

```milo
fn JsonArr.nil(self: JsonArr): JsonArr
```

_Undocumented._

### `JsonArr.obj`

```milo
fn JsonArr.obj(self: JsonArr, val: JsonObj): JsonArr
```

_Undocumented._

### `JsonArr.raw`

```milo
fn JsonArr.raw(self: JsonArr, json: &string): JsonArr
```

Splice a pre-serialized JSON value verbatim (caller guarantees validity).

### `JsonArr.str`

```milo
fn JsonArr.str(self: JsonArr, val: &string): JsonArr
```

_Undocumented._

### `JsonArr.val`

```milo
fn JsonArr.val(self: JsonArr, val: JsonVal): JsonArr
```

_Undocumented._

### `jsonBoolStr`

```milo
pub fn jsonBoolStr(b: bool): string
```

`true`/`false` as JSON text.

### `jsoncParse`

```milo
pub fn jsoncParse(s: string): Result<Json>
```

_Undocumented._

### `JsonError.message`

```milo
fn JsonError.message(self: &JsonError): string
```

_Undocumented._

### `JsonError.path`

```milo
fn JsonError.path(self: &JsonError): string
```

Dotted path to the offending value, "" for a syntax error.

### `JsonError.under`

```milo
fn JsonError.under(self: JsonError, seg: string): JsonError
```

Re-root the error one level up. Decoders build paths bottom-up so the
success path never allocates a path string.

### `JsonError.underIndex`

```milo
fn JsonError.underIndex(self: JsonError, index: i64): JsonError
```

_Undocumented._

### `jsonEscapeStr`

```milo
pub fn jsonEscapeStr(s: &string): string
```

_Undocumented._

### `jsonKindName`

```milo
pub fn jsonKindName(kind: i32): string
```

Human-readable name for a `curKind` result, including -1 for "no such node".

### `JsonObj.arr`

```milo
fn JsonObj.arr(self: JsonObj, key: &string, val: JsonArr): JsonObj
```

_Undocumented._

### `JsonObj.bool`

```milo
fn JsonObj.bool(self: JsonObj, key: &string, val: bool): JsonObj
```

_Undocumented._

### `JsonObj.boolOpt`

```milo
fn JsonObj.boolOpt(self: JsonObj, key: &string, val: Option<bool>): JsonObj
```

_Undocumented._

### `JsonObj.build`

```milo
fn JsonObj.build(self: &JsonObj): string
```

_Undocumented._

### `JsonObj.buildPretty`

```milo
fn JsonObj.buildPretty(self: &JsonObj, indent: i64): string
```

build() with `indent` spaces per nesting level (0 or less minifies).

### `JsonObj.float`

```milo
fn JsonObj.float(self: JsonObj, key: &string, val: f64): JsonObj
```

_Undocumented._

### `JsonObj.floatOpt`

```milo
fn JsonObj.floatOpt(self: JsonObj, key: &string, val: Option<f64>): JsonObj
```

_Undocumented._

### `JsonObj.int`

```milo
fn JsonObj.int(self: JsonObj, key: &string, val: i64): JsonObj
```

_Undocumented._

### `JsonObj.intOpt`

```milo
fn JsonObj.intOpt(self: JsonObj, key: &string, val: Option<i64>): JsonObj
```

_Undocumented._

### `JsonObj.nil`

```milo
fn JsonObj.nil(self: JsonObj, key: &string): JsonObj
```

_Undocumented._

### `JsonObj.obj`

```milo
fn JsonObj.obj(self: JsonObj, key: &string, val: JsonObj): JsonObj
```

_Undocumented._

### `JsonObj.raw`

```milo
fn JsonObj.raw(self: JsonObj, key: &string, json: &string): JsonObj
```

Splice a pre-serialized JSON value verbatim (caller guarantees validity).

### `JsonObj.str`

```milo
fn JsonObj.str(self: JsonObj, key: &string, val: &string): JsonObj
```

_Undocumented._

### `JsonObj.strOpt`

```milo
fn JsonObj.strOpt(self: JsonObj, key: &string, val: Option<string>): JsonObj
```

Optional-field helpers: add the key only when the Option is Some, so a
conditional field stays inside the fluent chain instead of breaking out
to an `if` around each call.

### `JsonObj.val`

```milo
fn JsonObj.val(self: JsonObj, key: &string, val: JsonVal): JsonObj
```

_Undocumented._

### `jsonParse`

```milo
pub fn jsonParse(s: string): Result<Json>
```

_Undocumented._

### `jsonPretty`

```milo
pub fn jsonPretty(src: &string, indent: i64): string
```

Re-render a JSON document. `indent` > 0 indents nested values by that many
spaces per level, exactly as `JSON.stringify(v, null, indent)` does; `indent`
<= 0 minifies, dropping every byte of whitespace outside a string.

Text that does not start with '{' or '[' comes back unchanged: a bare scalar
has nothing to indent, and text that is not JSON at all (a plain-text error
line, an empty body) is not this function's to mangle.

### `jsonPull`

```milo
pub fn jsonPull(src: string): JsonPull
```

_Undocumented._

### `JsonPull.next`

```milo
fn JsonPull.next(self: &mut JsonPull): JsonToken
```

_Undocumented._

### `jsonQuote`

```milo
pub fn jsonQuote(s: &string): string
```

Quote and escape a string as a JSON string literal, brackets included.

### `jsonSer`

```milo
pub fn jsonSer(v: &JsonVal): string
```

_Undocumented._
