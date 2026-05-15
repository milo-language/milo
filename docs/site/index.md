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
    details: References are second-class — only allowed as function params. This one restriction eliminates Rust's hardest concept entirely.
  - title: Familiar Syntax
    details: "let/var, type annotations after names, arrow closures, string methods like .contains() and .split(). If you know TypeScript, you already know most of Milo."
  - title: Small & Fast
    details: Compiles via LLVM with -O2. CLI tools come out under 300KB with sub-millisecond startup. Performance within noise of C.
---

<div class="stat-cards">
  <div class="stat"><div class="stat-value">&lt;300KB</div><div class="stat-label">binary size</div></div>
  <div class="stat"><div class="stat-value">&lt;1ms</div><div class="stat-label">startup</div></div>
  <div class="stat"><div class="stat-value">~1x C</div><div class="stat-label">runtime perf</div></div>
  <div class="stat"><div class="stat-value">0</div><div class="stat-label">lifetime annotations</div></div>
</div>

```milo
fn main(): i32 {
    let name = "world"
    print("hello, ", name, "!")
    return 0
}
```

<div class="code-caption"><code>milo run hello.milo</code> → compile and run in one step</div>

<div class="comparison-table">

|  | GC | Lifetimes | Ownership | Native |
|---|---|---|---|---|
| Go | yes | no | no | yes |
| Rust | no | yes | yes | yes |
| TypeScript | yes | no | no | no |
| **Milo** | **no** | **no** | **yes** | **yes** |

</div>
