# std/json

## std/json

### `Json.asBool`

```milo
fn Json.asBool(self: &Json): Option<bool>
```

_Undocumented._

### `Json.asF64`

```milo
fn Json.asF64(self: &Json): Option<f64>
```

_Undocumented._

### `Json.asI64`

```milo
fn Json.asI64(self: &Json): Option<i64>
```

_Undocumented._

### `Json.asStr`

```milo
fn Json.asStr(self: &Json): Option<string>
```

_Undocumented._

### `Json.at`

```milo
fn Json.at(self: &Json, index: i64): Option<Json>
```

_Undocumented._

### `Json.bool`

```milo
fn Json.bool(self: &Json, key: &string): Option<bool>
```

_Undocumented._

### `Json.boolAt`

```milo
fn Json.boolAt(self: &Json, index: i64, key: &string): Option<bool>
```

_Undocumented._

### `Json.childBoolAt`

```milo
fn Json.childBoolAt(self: &Json, key: &string, index: i64, subKey: &string): Option<bool>
```

_Undocumented._

### `Json.childF64At`

```milo
fn Json.childF64At(self: &Json, key: &string, index: i64, subKey: &string): Option<f64>
```

_Undocumented._

### `Json.childI64At`

```milo
fn Json.childI64At(self: &Json, key: &string, index: i64, subKey: &string): Option<i64>
```

_Undocumented._

### `Json.childLen`

```milo
fn Json.childLen(self: &Json, key: &string): i64
```

_Undocumented._

### `Json.childStrAt`

```milo
fn Json.childStrAt(self: &Json, key: &string, index: i64, subKey: &string): Option<string>
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

### `Json.curInt`

```milo
fn Json.curInt(self: &Json, cur: i64): Option<i64>
```

_Undocumented._

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

### `Json.curRoot`

```milo
fn Json.curRoot(self: &Json): i64
```


`get`/`at` above return an owned Json by deep-cloning the whole document
(source string + every node) per call — navigating a large doc thousands
of times blows up to gigabytes. The cursor API instead treats a plain
`i64` node index as a cursor into THIS document: navigation returns child
indices (‑1 = missing) with zero allocation, and only leaf-string reads
materialize (just that one string). Start at `curRoot()` and chain:
  let user = doc.curField(doc.curChild(doc.curRoot(), 0), "name")
  match doc.curStr(user) { Option.Some(s) => ..., Option.None => ... }

### `Json.curStr`

```milo
fn Json.curStr(self: &Json, cur: i64): Option<string>
```

_Undocumented._

### `Json.f64`

```milo
fn Json.f64(self: &Json, key: &string): Option<f64>
```

_Undocumented._

### `Json.f64At`

```milo
fn Json.f64At(self: &Json, index: i64, key: &string): Option<f64>
```

_Undocumented._

### `Json.get`

```milo
fn Json.get(self: &Json, key: &string): Option<Json>
```

_Undocumented._

### `Json.getAt`

```milo
fn Json.getAt(self: &Json, index: i64, key: &string): Option<Json>
```

_Undocumented._

### `Json.i64`

```milo
fn Json.i64(self: &Json, key: &string): Option<i64>
```

_Undocumented._

### `Json.i64At`

```milo
fn Json.i64At(self: &Json, index: i64, key: &string): Option<i64>
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

_Undocumented._

### `Json.len`

```milo
fn Json.len(self: &Json): i64
```

_Undocumented._

### `Json.rawStr`

```milo
fn Json.rawStr(self: &Json): string
```

_Undocumented._

### `Json.str`

```milo
fn Json.str(self: &Json, key: &string): Option<string>
```

_Undocumented._

### `Json.strAt`

```milo
fn Json.strAt(self: &Json, index: i64, key: &string): Option<string>
```

_Undocumented._

### `jsonArr`

```milo
pub fn jsonArr(): JsonArr
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
fn JsonArr.raw(self: JsonArr, json: string): JsonArr
```

Splice a pre-serialized JSON value verbatim (caller guarantees validity).

### `JsonArr.str`

```milo
fn JsonArr.str(self: JsonArr, val: string): JsonArr
```

_Undocumented._

### `JsonArr.val`

```milo
fn JsonArr.val(self: JsonArr, val: JsonVal): JsonArr
```

_Undocumented._

### `jsonClone`

```milo
pub fn jsonClone(src: &Json): Json
```

_Undocumented._

### `jsoncParse`

```milo
pub fn jsoncParse(s: string): Result<Json>
```

_Undocumented._

### `jsonEscapeStr`

```milo
pub fn jsonEscapeStr(s: &string): string
```

_Undocumented._

### `jsonExtractSubtree`

```milo
pub fn jsonExtractSubtree(src: &Json, nodeIdx: i64): Json
```

_Undocumented._

### `jsonKeyEq`

```milo
pub fn jsonKeyEq(source: &string, off: i64, klen: i64, target: &string): bool
```

_Undocumented._

### `jsonMaterializeStr`

```milo
pub fn jsonMaterializeStr(source: &string, start: i64, len: i64): string
```

_Undocumented._

### `jsonNodeRawStr`

```milo
pub fn jsonNodeRawStr(doc: &Json, nodeIdx: i64): string
```

_Undocumented._

### `jsonNull`

```milo
pub fn jsonNull(): Json
```

_Undocumented._

### `jsonObj`

```milo
pub fn jsonObj(): JsonObj
```

_Undocumented._

### `JsonObj.arr`

```milo
fn JsonObj.arr(self: JsonObj, key: string, val: JsonArr): JsonObj
```

_Undocumented._

### `JsonObj.bool`

```milo
fn JsonObj.bool(self: JsonObj, key: string, val: bool): JsonObj
```

_Undocumented._

### `JsonObj.boolOpt`

```milo
fn JsonObj.boolOpt(self: JsonObj, key: string, val: Option<bool>): JsonObj
```

_Undocumented._

### `JsonObj.build`

```milo
fn JsonObj.build(self: &JsonObj): string
```

_Undocumented._

### `JsonObj.float`

```milo
fn JsonObj.float(self: JsonObj, key: string, val: f64): JsonObj
```

_Undocumented._

### `JsonObj.floatOpt`

```milo
fn JsonObj.floatOpt(self: JsonObj, key: string, val: Option<f64>): JsonObj
```

_Undocumented._

### `JsonObj.int`

```milo
fn JsonObj.int(self: JsonObj, key: string, val: i64): JsonObj
```

_Undocumented._

### `JsonObj.intOpt`

```milo
fn JsonObj.intOpt(self: JsonObj, key: string, val: Option<i64>): JsonObj
```

_Undocumented._

### `JsonObj.nil`

```milo
fn JsonObj.nil(self: JsonObj, key: string): JsonObj
```

_Undocumented._

### `JsonObj.obj`

```milo
fn JsonObj.obj(self: JsonObj, key: string, val: JsonObj): JsonObj
```

_Undocumented._

### `JsonObj.raw`

```milo
fn JsonObj.raw(self: JsonObj, key: string, json: string): JsonObj
```

Splice a pre-serialized JSON value verbatim (caller guarantees validity).

### `JsonObj.str`

```milo
fn JsonObj.str(self: JsonObj, key: string, val: string): JsonObj
```

_Undocumented._

### `JsonObj.strOpt`

```milo
fn JsonObj.strOpt(self: JsonObj, key: string, val: Option<string>): JsonObj
```

Optional-field helpers: add the key only when the Option is Some, so a
conditional field stays inside the fluent chain instead of breaking out
to an `if` around each call.

### `JsonObj.val`

```milo
fn JsonObj.val(self: JsonObj, key: string, val: JsonVal): JsonObj
```

_Undocumented._

### `jsonParse`

```milo
pub fn jsonParse(s: string): Result<Json>
```

_Undocumented._

### `jsonParseArray`

```milo
pub fn jsonParseArray(s: &string, pos: &mut i64, nodes: &mut Vec<JsonNode>, childIdx: &mut Vec<i64>, keyOffsets: &mut Vec<i64>, keyLens: &mut Vec<i64>, scratch: &mut Vec<i64>, scratchLen: &mut i64, err: &mut bool): i64
```

Container children must be contiguous in childIdx, but grandchildren are discovered
interleaved while a container is still open. Children park on the scratch stack until
the container closes, then commit as one contiguous block — this replaced a pre-counting
scan to the matching close bracket that re-read every container body (73% of parse time).

### `jsonParseNumber`

```milo
pub fn jsonParseNumber(s: &string, pos: &mut i64, nodes: &mut Vec<JsonNode>, _err: &mut bool): i64
```

_Undocumented._

### `jsonParseObject`

```milo
pub fn jsonParseObject(s: &string, pos: &mut i64, nodes: &mut Vec<JsonNode>, childIdx: &mut Vec<i64>, keyOffsets: &mut Vec<i64>, keyLens: &mut Vec<i64>, scratch: &mut Vec<i64>, scratchLen: &mut i64, err: &mut bool): i64
```

_Undocumented._

### `jsonParseString`

```milo
pub fn jsonParseString(s: &string, pos: &mut i64, nodes: &mut Vec<JsonNode>, err: &mut bool): i64
```

_Undocumented._

### `jsonParseValue`

```milo
pub fn jsonParseValue(s: &string, pos: &mut i64, nodes: &mut Vec<JsonNode>, childIdx: &mut Vec<i64>, keyOffsets: &mut Vec<i64>, keyLens: &mut Vec<i64>, scratch: &mut Vec<i64>, scratchLen: &mut i64, err: &mut bool): i64
```

_Undocumented._

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

### `jsonPullNumber`

```milo
pub fn jsonPullNumber(s: &string, pos: &mut i64): f64
```

Standalone number → f64 (int . frac e exp), advancing pos past the literal.
The flat-pool parser's jsonParseNumber is node-coupled, so the scan is inlined.

### `jsonScanString`

```milo
pub fn jsonScanString(s: &string, pos: &mut i64, _err: &mut bool)
```

RFC 8259 §7: a string char is any Unicode scalar except '"', '\' and the C0 controls (< 0x20),
which must be escaped. Valid escapes are " \ / b f n r t and \uXXXX. We validate the escape
letter but not the 4 hex digits (no fail case exercises bad \u, and over-checking risks false
positives on valid \u sequences).

### `jsonScanStringRange`

```milo
pub fn jsonScanStringRange(s: &string, pos: &mut i64, start: &mut i64, _slen: &mut i64, err: &mut bool)
```

_Undocumented._

### `jsonScratchPush`

```milo
pub fn jsonScratchPush(scratch: &mut Vec<i64>, scratchLen: &mut i64, v: i64)
```

Push onto the scratch stack reusing already-grown capacity: scratchLen is the logical
length, scratch.len() the high-water mark — entries above scratchLen are stale and
overwritten in place, so repeated container parses cost zero allocations.

### `jsonSer`

```milo
pub fn jsonSer(v: &JsonVal): string
```

_Undocumented._

### `jsonSkipWs`

```milo
pub fn jsonSkipWs(s: &string, pos: &mut i64)
```

_Undocumented._

### `jsonStripJsonc`

```milo
pub fn jsonStripJsonc(s: &string): string
```

JSONC (Microsoft/VS Code flavor): JSON plus // and /* */ comments and trailing commas.
No formal spec exists; this matches the de-facto jsonc-parser behavior. Implemented as a
string-aware preprocessor that emits strict JSON, so everything else inherits jsonParse's
exact RFC-8259 validation — JSONC is strictly a superset of comments + trailing commas, not
a second, looser parser.

### `jsonTok`

```milo
pub fn jsonTok(k: JsonEvent): JsonToken
```

_Undocumented._
