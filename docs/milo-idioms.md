<!-- doc-meta
system: milo-idioms
purpose: canonical Milo patterns for text handling and ownership, and the papercuts that push agents toward non-idiomatic code
key-files: std/string.milo, std/unicode.milo, docs/language-reference.md, CONVENTIONS.md
update-when: a listed workaround stops being necessary, or a new papercut keeps producing the same non-idiomatic shape
last-verified: 2026-07-18
-->

# Milo Idioms

Written after auditing `examples/apps/milojs` — a large hand-written interpreter — against what the language actually offers. Every entry below is a shape that got written the hard way because the easy way wasn't obvious.

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
    i = i + 1
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
out = out + chunk

// do — amortized growth, copies only the addition
var out = ""
out.pushStr(chunk)
out.push(byte)      // single u8
```

`+` is fine for a fixed number of joins. It is not fine inside a loop.

### Slices are views; `substr` copies

`s[a..b]` and `s.slice(a, b)` produce a `&string` **view** with no allocation. The checker marks the source borrowed for the view's lifetime, so it can't be mutated or moved out from under you. `s.substr(a, b)` is the owning counterpart — use it only when the result must outlive the source.

Note `indexOf`/`lastIndexOf` return a plain `i64` and use `-1` for "not found", not `Option<i64>`.

## Ownership

### `.clone()` density is mostly structural — check before you blame yourself

Auto-borrow already covers argument position, and it walks field and index chains. If a parameter is `&T`, pass the expression bare:

```milo
fn jsonEscapeStr(s: &string): string { ... }

jsonEscapeStr(self.members[i].key)    // no clone, no '&'
```

`&x` is not an expression in Milo — borrows are implicit. Writing it is an error.

A sweep of all ~200 `.clone()` calls in milojs found exactly **one** that auto-borrow made redundant. The rest are structural, and there are only two reasons for them:

1. **The value outlives the borrow.** Anything stored in a `let`, a struct field, or a `Vec` must be owned. There is no way to bind a borrow to a local — `let x: &T = ...` does not exist, auto-borrow is argument-position only.
2. **The callee takes `string` by value.** Then a clone is the only alternative to a move.

So before adding a clone, check whether the callee could take `&string` instead. If it genuinely needs ownership, the clone is correct and not a smell. Do not "optimize" clones away without checking which case you're in — dropping a required one is a silent data-loss bug, not a compile error (see below).

### Moving out of a container zeroes it

`let name = toks[i].text` does not copy — it **moves** the field out and zeroes the source slot, leaving a zeroed string inside the `Vec`. There is no error. If the container is still live afterwards, you need `.clone()`.

This is the single most common source of silent corruption in Milo code.

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

## When something feels harder than it should

That's a signal worth reporting, not routing around. Two of the papercuts above were fixed only because the friction got written down instead of worked around. If the correct version of something is meaningfully more expensive to write than an incorrect shortcut, say so — file it in `docs/backlog.md` or `docs/feedback/`.
