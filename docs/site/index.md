---
layout: home
hero:
  name: Milo
  text: "Memory safety for dummies."
  tagline: "A modern systems language that compiles to native code. No GC, no lifetime annotations, no PhD required."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/variables

features:
  - title: You Already Know This
    details: "let/var, arrow functions, for-in loops, generics with angle brackets. If you've written any modern language, you can read Milo on day one."
  - title: Memory Safe. No GC.
    details: "The compiler tracks ownership and frees memory for you. Use-after-free? Caught at compile time. No garbage collector pauses, no manual malloc/free."
  - title: No Lifetime Annotations
    details: "Rust's biggest learning cliff, gone. References can't escape the function they're passed to — one simple rule replaces an entire chapter of the Rust book."
  - title: Native Binaries via LLVM
    details: "Compiles to optimized machine code. Sub-millisecond startup. Binaries under 300KB. Performance within noise of C."
---

### Familiar syntax, serious guarantees

```milo
fn main(): i32 {
    var names: Vec<string> = Vec.new()
    names.push("alice")
    names.push("bob")

    let loud = names.map((n: &string) => n.to_upper())
    for name in loud {
        print(name)
    }

    return 0
}   // names and loud are freed here — no GC, no manual free
```

Modern syntax. Native performance. Memory safe by default.

### The safety you want without the syntax you don't

```milo
fn processLine(line: &string): void {
    let method = line[0..3]       // zero-copy view — no allocation
    let path = line[4..line.len]
    print(method, " -> ", path)
}
```

`&string` is a borrow. It can't outlive the data it points to. The compiler enforces this — no annotations required from you.

### Real programs, not toy demos

```milo
enum JsonValue {
    Null,
    Bool(bool),
    Number(i64),
    Str(string),
    Array(Vec<Box<JsonValue>>),
    Object(Vec<JsonKV>),
}

fn parse_value(s: &string, pos: &mut i64): Box<JsonValue> {
    skip_ws(s, pos)
    let ch = s[pos]
    if ch == '"' { return parse_string(s, pos) }
    if ch == '{' { return parse_object(s, pos) }
    if ch == '[' { return parse_array(s, pos) }
    return Box(JsonValue.Null)
}
```

Tagged unions, pattern matching, heap allocation with `Box<T>` — the tools you need for real systems code, in syntax you can actually read.

### Where Milo fits

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native | Familiar Syntax |
|---|---|---|---|---|---|
| Go | yes | no | no | yes | yes |
| Rust | no | yes | yes | yes | no |
| TypeScript | yes | no | no | no | yes |
| **Milo** | **no** | **no** | **yes** | **yes** | **yes** |

</div>
