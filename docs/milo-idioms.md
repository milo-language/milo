<!-- doc-meta
system: milo-idioms
purpose: canonical Milo patterns for text handling and ownership, and the papercuts that push agents toward non-idiomatic code
key-files: std/string.milo, std/unicode.milo, docs/language-reference.md, CONVENTIONS.md
update-when: a listed workaround stops being necessary, or a new papercut keeps producing the same non-idiomatic shape
last-verified: 2026-09-01
-->

# Milo Idioms

Written after auditing [milojs](https://github.com/milo-language/milojs) — a large hand-written interpreter — against what the language actually offers. Every entry below is a shape that got written the hard way because the easy way wasn't obvious.

`CONVENTIONS.md` has the rules reviewers enforce. This doc is narrower: it's the patterns, and the reasoning behind them.

Before writing anything stdlib-adjacent, run `bun run src/main.ts api <terms>`. It re-scans `std/**/*.milo` on every call, so it's never stale. Most of what follows was already available and simply not found.

## Text

### Iterate, don't index

A manual cursor over a string is almost never needed:

```milo
// don't
var i: i64 = 0
while i < s.len {
    out.push(s[i])
    i += 1
}

// do
for b in s {          // b: u8
    out.push(b)
}

for i, b in s { ... } // i: i64 byte offset, b: u8
```

The same applies to `Vec<T>` and `HashMap<K,V>`. `for` binds **by reference**, so iterating doesn't consume the collection.

### Bytes vs codepoints is a real choice — make it deliberately

`for b in s` yields **bytes**. That is the right default for scanning ASCII structure (delimiters, digits, keywords) and a lexer usually wants exactly that.

When the value is *text* — a character to classify, compare, or re-emit — iterate codepoints:

```milo
for cp in s.codePoints() {         // cp: i32, decoded UTF-8
    ...
}

for at, cp in s.codePoints() { ... } // at: i64 BYTE offset of cp
```

This decodes as it goes; it does not build a `Vec<i32>`. To decode at one known offset instead of looping, use `decodeCodepoint(s, at)` from `std/unicode`, which returns `.value` and `.size` (the byte width) so you can advance your own cursor.

Malformed UTF-8 yields U+FFFD and advances one byte. It never stalls and never reads out of bounds — so a scan over untrusted input always terminates.

**If you find yourself writing a byte-oriented version of something that is specified over codepoints or UTF-16 code units, stop.** That's the shortcut that produced a byte-oriented `codePointAt` in milojs. The correct version is now the cheaper one to write; there is no longer a reason to trade it away. For UTF-16 boundaries (`.length`, `charCodeAt`), `std/unicode` has `utf16UnitCount`, `highSurrogate`, `lowSurrogate`, and `fromSurrogatePair`.

### Build strings with `pushStr`, not `+`

```milo
// don't — reallocates and recopies the whole accumulator per concat (quadratic)
var out = ""
out += chunk

// do — amortized growth, copies only the addition
var out = ""
out.pushStr(chunk)
out.push(byte)      // single u8
```

`+` (and `+=`, which is the same operation) is fine for a fixed number of joins. Neither is fine inside a loop; `milo check --deny=string-concat-in-loop` lists every such site.

### Slices are views; `substr` copies

`s[a..b]` and `s.slice(a, b)` produce a `&string` **view** with no allocation. The checker marks the source borrowed for the view's lifetime, so it can't be mutated or moved out from under you. `s.substr(a, b)` is the owning counterpart — use it only when the result must outlive the source.

`indexOf`/`indexOfFrom`/`lastIndexOf` return `Option<i64>` byte offsets. Match,
use `!` when a preceding check proves the substring exists, or use `??` when a
fallback offset is genuinely meaningful.

### Parsing answers `Option`, so decide what bad input means

`s.parseInt()` and `s.parseF64()` return `Option<i64>` / `Option<f64>`, and they
are strict: the whole string must be the number. `"42x"`, `" 12"`, `""` and an
out-of-range value are all `None`. `std/strconv`'s `parseInt`/`parseFloat` are
named aliases for the same two parsers, not a second implementation.

Pick the failure behaviour on purpose. `let Option.Some(n) = s.parseInt() else {
continue }` skips a junk field; `.unwrapOr(0)` says the fallback is meaningful;
`!` says a preceding check already proved the shape. Reaching for `.unwrapOr(0)`
everywhere just rebuilds the silent-zero this API was changed to remove.

## Ownership

### `.clone()` density is mostly structural — check before you blame yourself

Auto-borrow already covers argument position, and it walks field and index chains. If a parameter is `&T`, pass the expression bare:

```milo
fn jsonEscapeStr(s: &string): string { ... }

jsonEscapeStr(self.members[i].key)    // no clone, no '&'
```

`&x` is not an expression in Milo — shared borrows are implicit. Writing it is an error. Only a mutable borrow is spelled, and only on a call argument: `bump(&mut x)`; the marker tells the reader which argument the call can change and nothing else.

A sweep of all ~200 `.clone()` calls in milojs found exactly **one** that auto-borrow made redundant. The rest are structural, and there are only two reasons for them:

1. **The value outlives the borrow.** Anything stored in a `let`, a struct field, or a `Vec` must be owned. There is no way to bind a borrow to a local — `let x: &T = ...` does not exist, auto-borrow is argument-position only.
2. **The callee takes `string` by value.** Then a clone is the only alternative to a move.

So before adding a clone, check whether the callee could take `&string` instead. If it genuinely needs ownership, the clone is correct and not a smell. Do not "optimize" clones away without checking which case you're in — dropping a required one is a silent data-loss bug, not a compile error (see below).

### Moving a field out of a container element is an error

`let name = toks[i].text` used to compile and zero the slot while `toks` kept the element, so the next read of `toks[i].text` handed back an empty string with no diagnostic. It was the single most common source of silent corruption in Milo code. It is now a compile error:

```
error: cannot move 'toks[...].text' out of 'toks': the element stays in the container, so the move would leave a zeroed 'text' behind
  hint: clone it ('toks[...].text.clone()'), or take the element out first ('toks.remove(i)', 'toks.pop()', or 'replace(toks[...].text, ...)')
```

Three ways out, depending on what you mean:

```milo
let name = toks[i].text.clone()            // the container keeps its value
let tok = toks.remove(i)                   // the whole element leaves; its fields move freely
let name = replace(toks[i].text, "")       // take the field, leave something in its place
```

Reading a WHOLE element (`let t = toks[i]`) already deep-clones (see the `index-clone` lint). A field of a call result (`f().name`) is still a plain move: the temporary is consumed and nothing is left behind.

## Control flow

### Don't build match pyramids

`match` on `Result`/`Option` nests fast. These all exist and read flatter:

```milo
let contents = readFile(path)?              // propagate (converts Err via From)
let n = maybeValue!                         // unwrap, panics on None/Err
let name = maybeName ?? "anonymous"         // default

let Result.Ok(s) = load(path) else {        // let-else: bind, or bail
    return 1
}

if let Option.Some(v) = lookup(k) { ... }
while let Option.Some(item) = queue.pop() { ... }
```

`match` also works in expression position, which collapses bind-or-exit to one statement:

```milo
let content = match readFile(path) {
    Result.Ok(data) => data
    Result.Err(e) => { print($"error: {e}") return 1 }
}
```

`Result` also has `map`/`mapErr`/`andThen` for transforming without unwrapping. Note they **consume the receiver when the forwarded payload is non-Copy** — `map` forwards the `Err` payload, so `r.map(f)` consumes `r` when `E` is a `string`. That's what stops the receiver and the result from both owning the same buffer. `Option.map` never consumes, because `None` has no payload to forward.

Reach for a nested `match` only when the types genuinely nest — patterns are one level deep (`Ok(Some(x))` does not parse), so `Result<Option<T>>` does require two levels.

Reading a nested JSON field used to be the worst offender, because `get` returns an
`Option<Json>` at every level. `std/json`'s path accessors flatten the whole walk:

```milo
// don't — one Option, and one match, per level
match data.get("headers") {
    Option.Some(h) => { match h.get("Host") { Option.Some(v) => { ... } Option.None => {} } }
    Option.None => {}
}

// do
data.strPath("headers.Host") ?? "(none)"
```

`strPath`/`i64Path`/`f64Path`/`boolPath` end the walk at a scalar; `path` returns
`Option<Json>` when you need to keep going. A missing key, an out-of-range `[n]`, or a
value of the wrong kind all give `None` — the walk is total for any document.

When the walk isn't a dotted path — a runtime index, a key containing `.` or `[` —
chain the owned accessors with `Option.andThen` instead:

```milo
doc.at(i).andThen((row) => row.str("name")) ?? "(none)"
```

Each hop deep-clones the subtree, so for a hot loop over a large document use the cursor
API (`curRoot`/`curChild`/`curField`/`curStr`), which walks the same shapes with zero
allocation.

Note `unwrapOr`/`unwrapOrElse` are rejected on non-Copy payloads (`string`, `Vec<T>`) because they'd alias the heap buffer; `??` has no such restriction. Prefer `??`.

### Reading the match subject inside its own arm

```milo
match v {
    Val.Str(s) => {
        // v's payload was moved into `s` at arm entry — v is dead here
        if isStr(v) { ... }
    }
}
```

This is now a compile error. It used to compile and silently read zeroed memory — and because the enum *tag* survives the move, a discriminant-only check kept answering correctly while a payload-reading one didn't. If you need a fact about the subject inside an arm, compute it **before** the match, or use the binding.

Arms that don't destructure a non-Copy payload (`_`, no bindings, Copy-only payloads) leave the subject intact and may still read it.

## Debugging

`print` renders containers structurally — `Vec` as `[a, b, c]`, `HashMap` as `{k: v}`,
recursing into elements and quoting strings. There is no need to write a loop to see
what is in a collection:

```milo
print(v)                       // [1, 2, 3]
print(nested)                  // [[1, 2], [3]]
print(byName)                  // {"a": User { name: "a", age: 3 }}
```

## Making illegal states unrepresentable

Milo has no proof terms and is not getting them ([proofs-vs-contracts](proofs-vs-contracts.md)).
What it does have is enough type structure to stop the wrong value from existing, which is
where most of the value in that idea actually lives. All four of these work today with no
language change.

**An uninhabited type marks a branch that cannot happen.** An empty enum has no values, so a
`match` on one has nothing to handle, and the checker accepts the empty arm list as the
argument that the branch is dead:

```milo
enum Never { }

fn cannotFail(n: i64): Result<i64, Never> {
    return Result.Ok(n * 2)
}
```

At the call site there is **no `Err` arm to write**: exhaustiveness skips a variant whose
payload cannot exist, so `match cannotFail(21) { Result.Ok(v) => { print(v) } }` is complete.
Writing the arm anyway stays legal, and `match e { }` is still the explicit way to say "this
cannot happen" - a checked argument rather than an `abort()`, an `unreachable`, or a comment.

**A witness type carries evidence.** A single-field struct whose only constructor establishes
the invariant means holding the value IS holding the evidence:

```milo
struct NonZero {
    v: i64,
}

fn nonZero(v: i64): Option<NonZero> {
    if v == 0 {
        return Option.None
    }
    return Option.Some(NonZero { v: v })
}
```

Use it for an API surface you want to be impossible to misuse. Do NOT reach for it to state a
fact about a value that already exists: that is what `requires`/`ensures` are for, they are one
line instead of nine, and they are machine-checked. A witness is checked only by the discipline
of keeping the constructor honest.

**A phantom brand separates two things with the same representation.** `struct Id<Tag> { raw: i64 }`
gives each pool or key space its own type, and a cross-pool call stops compiling. Brand an
arena the same way when a program holds two of the same payload type: `Arena<Node>` hands
both the same `Handle<Node>`, so a handle from graph A type-checks against graph B and only
the runtime id check says no. Wrap each in its own pair, `struct GraphA { _a: Arena<Node> }`
with `struct HandleA { _h: Handle<Node> }`, and the mixup is a compile error
(`tests/errors/arenaBrandMixup.milo`). The `_` fields are file-private, so nothing outside
the declaring file can strip the brand. There is no std wrapper for this on purpose: every
real program already wraps its arena in a domain struct, and no program in the corpus holds
two arenas of one type (measured 2026-09-20).

**Typestate is already here.** Move checking is a substructural type system: a consumed `File`
cannot be used again, and a builder method taking `self` by value makes the previous state
unreachable. Nothing needs to be added for this; it is what ownership already buys.

## When something feels harder than it should

That's a signal worth reporting, not routing around. Two of the papercuts above were fixed only because the friction got written down instead of worked around. If the correct version of something is meaningfully more expensive to write than an incorrect shortcut, say so — file it in `docs/backlog.md` or `docs/feedback/`.
