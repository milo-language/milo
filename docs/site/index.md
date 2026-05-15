---
layout: home
hero:
  name: Milo
  text: "Ownership without lifetimes."
  tagline: "A memory-safe systems language that compiles to native code via LLVM. No GC, no lifetime annotations. Modern syntax."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: Learn the Language
      link: /language/variables

features:
  - title: Memory Safe
    details: Single-owner move semantics catch use-after-free at compile time. No GC pauses, no manual free(), no dangling pointers.
  - title: No Lifetime Annotations
    details: "References are second-class — they live in function params and local variables, but can't escape. This one restriction eliminates Rust's hardest concept entirely."
  - title: Modern Syntax
    details: "let/var bindings, arrow closures, for-in loops, .map/.filter/.find on collections. Reads like a scripting language, compiles like a systems one."
  - title: Small & Fast
    details: "Compiles via LLVM with -O2. Binaries under 300KB, sub-millisecond startup, performance within noise of C."
---

Milo gives you memory safety through ownership — like Rust — but without the lifetime annotations. The compiler tracks who owns what, frees memory automatically, and catches use-after-free at compile time. No garbage collector, no manual memory management, no footguns.

### Ownership that gets out of the way

```milo
fn main(): i32 {
    var names: Vec<string> = Vec.new()
    names.push("alice")
    names.push("bob")

    // Functional pipelines — callbacks borrow elements, no cloning needed
    let loud = names.map((n: &string) => n.to_upper())
    for name in loud {
        print(name)
    }

    return 0
}   // names and loud are freed here — no GC, no manual free
```

### Zero-copy string slices

```milo
fn processLine(line: &string): void {
    let method = line[0..3]       // &string — zero-copy view, no allocation
    let path = line[4..line.len]
    print(method, " -> ", path)
}
```

`line[0..3]` doesn't allocate. It returns a `&string` that points into the original data. The compiler ensures the view can't outlive the source — no dangling pointers, no lifetime annotations.

### Enums + pattern matching

```milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
}

fn area(s: &Shape): f64 {
    match s {
        Shape.Circle(r) => { return 3.14159 * r * r }
        Shape.Rect(w, h) => { return w * h }
    }
}
```

### The pitch

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native |
|---|---|---|---|---|
| Go | yes | no | no | yes |
| Rust | no | yes | yes | yes |
| TypeScript | yes | no | no | no |
| **Milo** | **no** | **no** | **yes** | **yes** |

</div>
