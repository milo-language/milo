// Hover documentation for every keyword in the language, plus the contextual words
// (`old`, `result`) a contract introduces.
//
// A keyword carries no type and no declaration site, so every other hover path in the
// LSP has nothing to say about it: hovering `pub`, `extern` or `fn` used to return
// null. That is exactly backwards — those are the words a reader new to the language
// hovers FIRST, because nothing about them can be inferred from context the way a
// function signature can.
//
// One table, in src/, so the editor hover and `milo lang --json` (which is how a
// tree-sitter grammar, a Zed/Neovim plugin or the docs site gets its vocabulary) say
// the same thing. tests/langInfo.test.ts holds the table to KEYWORDS ∪ SOFT_KEYWORDS,
// so a new keyword cannot land undocumented.

// Markdown. A leading fenced `milo` block gives the FORM; the prose says what it means
// and, where the rule is easy to get wrong, what the compiler will actually reject.
export const KEYWORD_DOCS: Record<string, string> = {
  // ── Declarations ──
  fn: "```milo\nfn name(param: T): Ret { … }\n```\nDeclares a function. Parameter types are mandatory and the return type follows the `:` — omit it and the function returns `void`.\n\n`fn name<T>(x: T): T` adds type parameters; generics are monomorphized, so a generic call costs nothing at run time. A `&T` / `&mut T` parameter is fed the value **bare** at the call site (`f(x)`, never `f(&x)`) — borrows are implicit and `&x` is not an expression.",

  extern: "```milo\nextern fn puts(s: *u8): i32\nextern fn printf(fmt: *u8, ...): i32\n```\nDeclares a function implemented **outside** Milo. There is no body: the C linker resolves the symbol, and nothing on the far side is checked for memory safety. A trailing `...` declares it variadic — get the fixed arity wrong and the call is miscompiled on AArch64, silently.\n\nA call needs **no** `unsafe` when every argument auto-coerces (scalar, `&T`, a Milo `fn`, `string` / `[T; N]` → `*T`, a matching `*T`, or a by-value `extern struct`) **and** the return is scalar, `void`, or an `extern struct`. A pointer return has provenance the compiler cannot see, so it forces an `unsafe` block at every call.\n\n`@cSig` / `@cLayout` on the declaration make the C compiler check this signature (and a struct's layout) against the real header, rather than trusting that the hand-written declaration matches.",

  let: "```milo\nlet x = 5\nlet x: i64 = 5\n```\nAn **immutable** binding — assigned once, never reassigned. It lowers to an SSA register, not a stack slot.\n\nUse `var` for something you need to mutate. Milo has no shadowing: re-declaring a name already in scope is a compile error, not a new binding.",

  var: "```milo\nvar x: i64 = 5\nx = 6\n```\nA **mutable** binding, stored in a stack slot (`alloca`). Reassignment and `&mut` borrowing both require `var`.\n\nAt file scope, `var name: T = …` declares a global; `thread_local var` gives it per-thread storage.",

  struct: "```milo\nstruct Point {\n    x: i32,\n    y: i32,\n}\n```\nA product type with named fields, stored inline. A struct whose fields are all Copy (scalars, raw pointers, arrays of those) copies on assignment; one that owns anything — a `string`, a `Vec`, a `Heap` — **moves**, and touching the source afterwards is a compile error. `@noCopy` forces that move tracking onto a struct that would otherwise copy, which is how an FFI handle stops being duplicable.\n\n`struct Pair<A, B>` adds type parameters. `@derive(Json, Eq, …)` above the declaration generates the trait impls. A single-field struct is Milo's newtype — a distinct type, not an alias.",

  enum: "```milo\nenum Shape {\n    Circle(f64),\n    Square(f64),\n}\n```\nA sum type: a value is exactly one variant, and a payload is reachable only through a pattern that binds it. `match` over one must be exhaustive, so adding a variant turns every incomplete match into a compile error.\n\nA payload-free enum can carry explicit integer values (`enum Color { Red = 1, … }`) and then convert with `as i32` / `tryFrom`.",

  impl: "```milo\nimpl Point {\n    fn len(self: &Point): f64 { … }\n}\n\nimpl Show for Point { … }\n```\nAttaches methods to a type: inherent methods with `impl Type`, a trait implementation with `impl Trait for Type`. The receiver is spelled out as the first parameter (`self: &Point` or `self: &mut Point`); a method with no `self` is a static, called as `Point.new()`.\n\n`impl` blocks are never marked `pub` — an impl's visibility follows the type it implements.",

  trait: "```milo\ntrait Show {\n    fn show(self: &Self): string\n}\n```\nA nominal, **statically dispatched** interface: a type has the trait only where an `impl Trait for Type` says so. Traits are what generic bounds (`fn p<T: Show>(x: T)`), operator overloading and `@derive` are built on, and every call monomorphizes — no vtable.\n\nFor runtime polymorphism over mixed concrete types, use `interface` instead.",

  interface: "```milo\ninterface Draw {\n    fn draw(self: &Self): void\n}\n```\nA **structurally** typed, **dynamically dispatched** interface: any type whose methods match satisfies it, with no declaration linking the two. A `&Draw` parameter accepts any of them, and the value passed is a fat pointer (data pointer + itable), so the call dispatches at run time.\n\nv1 restrictions: methods must take `self: &Self`, interfaces take no type parameters, there is no interface inheritance and no downcast back to the concrete type. When you want static dispatch and generic bounds, use `trait`.",

  type: "```milo\ntype Bytes = Vec<u8>\n```\nA type alias — a second spelling for an existing type, interchangeable with it everywhere.\n\nIt is **not** a new type: an alias will not stop you passing a `UserId` where an `OrderId` is meant. For that, declare a single-field struct (a newtype), which the checker keeps distinct.",

  import: "```milo\nfrom \"std/json\" import { Json }\nfrom \"std/io\" import { readFile as slurp }\n```\nBinds names from another file. Paths are `std/<name>` for the standard library, or a path relative to the importing file.\n\nThis is the only form: there is no glob import, and a bare `import \"path\"` is rejected. An import binds the name **locally** — it never re-exports, so `pub` on an import is not a thing.",

  // ── Modifiers ──
  pub: "```milo\npub fn parse(s: string): Doc { … }\n```\nExports the declaration. Declarations are **file-private by default** — without `pub`, a name is visible only inside its own file, and referencing it from another file is a compile error. The unit of privacy is the file, matching how imports already work.\n\nApplies to top-level `fn`, `struct`, `enum`, `trait`, `type`, `interface` and globals. A `pub struct` exposes its fields, except those named with a leading `_`, which are private to the declaring file. Not applicable to `impl` (visibility follows the type) or `import` (which binds locally).\n\n`pub` is about other **Milo** files; `@externalLinkage` is what makes a symbol visible to the **C** linker. `pub` is a soft keyword: away from a declaration it stays an ordinary identifier (`var pub = 5`).",

  mut: "```milo\nfn bump(n: &mut i64): void\n```\nMarks a reference parameter as mutable: `&mut T` may write through the borrow, `&T` may only read.\n\n`mut` appears **only** inside a reference type. A local is made mutable by declaring it `var`, not by writing `mut`. References are second-class — legal in parameter position only, never stored in a struct or returned — and the caller passes the value bare (`bump(n)`), since borrows are implicit.",

  thread_local: "```milo\nthread_local var counter: i64 = 0\n```\nGives a global **per-thread** storage: every thread gets its own independently initialized copy, so no synchronization is needed to touch it and no other thread can observe the writes.\n\nA soft keyword — an ordinary identifier anywhere but in front of a global declaration.",

  derive: "```milo\n@derive(Json, Eq, Clone)\nstruct Point { x: i32, y: i32 }\n\nderive Show {\n    fn show(self: &Self): string { … }\n}\n```\nTwo related spellings. `@derive(Trait, …)` on a struct or enum generates the trait impls from the shape of the type — `Json` for serialization, `Eq` for `==`, `Clone` for `.clone()`, and so on. `Eq` and `Clone` are also derived automatically for plain structs; `Clone` skips Drop and `@noCopy` types, whose duplication would release a resource twice.\n\n`derive Trait { … }` declares the **template** a `@derive(Trait)` expands to, so a user-written trait can be derivable too. The body is a template, not ordinary code: `@fields` repeats over the fields of the type being derived for.\n\nSoft keyword — a legal identifier elsewhere.",

  // ── Control flow ──
  if: "```milo\nif cond { … } else if other { … } else { … }\n```\nBranches on a `bool` — no truthiness, so an integer or an `Option` will not do. The condition needs no parentheses; the braces are mandatory.\n\n`if let Pattern = expr { … }` matches a single pattern and binds its payload for the body, which is how you take an `Option`/`Result` apart without a full `match`.",

  else: "```milo\nif cond { … } else { … }\n```\nThe branch taken when the `if` condition is false; `else if` chains another test.\n\nAlso pairs with `let … else { … }`: a `let-else` binds a pattern into the enclosing scope, and runs the `else` block when the pattern does not match. That block must diverge (`return` / `break` / `continue`) — the compiler rejects one that could fall through to code where the binding does not exist.",

  while: "```milo\nwhile i < n { … }\nwhile let Option.Some(line) = readLine(i) { … }\n```\nLoops while the condition is true. `while let` loops as long as the pattern keeps matching, binding the payload each iteration — the idiomatic way to drain a source that reports exhaustion with `Option.None`.\n\nA loop may carry `invariant` clauses (proved by induction and then available after the loop) and a `decreases` measure that proves it terminates.",

  for: "```milo\nfor x in items { … }\nfor i in 0..n { … }\n```\nIterates a container, a range, or anything with an iterator. The loop variable **binds by reference** into the container — it does not copy the element and does not consume the container, so `items` is still usable after the loop.\n\nThe binding is **immutable**: to change elements in place, assign through the index (`v[i] = …`) or hand the container to a function taking a `&mut [T]` slice.",

  in: "```milo\nfor entry in dir { … }\n```\nSeparates the loop variable from the sequence in a `for` loop. Also spells a range: `for i in 0..n`.\n\nA soft keyword — it is only special in `for` position, so `in` remains usable as a parameter or field name.",

  match: "```milo\nmatch shape {\n    Shape.Circle(r) => { … }\n    Shape.Square(w) => { … }\n}\n```\nPattern-matches a value. Matching an enum must be **exhaustive**: leave a variant out and the program does not compile, which is what makes adding a variant a safe, compiler-guided change. `_` is the catch-all arm.\n\n`match` is also an expression — every arm's value becomes the value of the match. Matching on a `&T` binds payloads by reference and does not move the scrutinee.",

  break: "```milo\nbreak\n```\nExits the innermost enclosing `while` or `for` loop immediately.",

  continue: "```milo\ncontinue\n```\nSkips the rest of the loop body and starts the next iteration of the innermost enclosing loop.",

  return: "```milo\nreturn value\nreturn        // from a void function\n```\nReturns from the enclosing function.\n\nLike every statement it ends at the **newline**: an expression on the next line is a new statement, not the returned value. Since nothing after it can run, a statement following `return` in the same block is an unreachable-code error.",

  unsafe: "```milo\nunsafe {\n    let p = malloc(64)\n    let v = *p\n}\n```\nOpens a block for the operations the compiler cannot verify: dereferencing or indexing a raw pointer, `x.addrOf()`, and extern calls whose return or arguments break the safe-coercion rule.\n\nIt does not turn checking off — everything else inside the block is checked exactly as usual; it marks the seam where **you** own the invariant. `0 as *T` (a null pointer literal) needs no `unsafe`, and `string.cstr()` hands out a `*u8` without one because the string stays alive in the caller's scope.",

  move: "```milo\nlet f = move || { print(name) }\n```\nMakes a closure capture by **value**, taking ownership of what it names instead of borrowing it. That is what lets the closure outlive the scope it was written in — required to hand it to `spawn`, a `Promise`, or anything stored past the current frame.\n\nA borrowing closure is cheaper but is confined to the enclosing scope, and the checker rejects letting one escape.",

  // ── Expressions and literals ──
  as: "```milo\nlet n = x as i64\nlet p = 0 as *u8\n```\nAn explicit conversion, and it is **total** — every input has a defined result, no undefined behavior. Integer → integer truncates or extends by bit width and wraps **silently**, which is the deliberate opt-out from the default overflow trap: reach for `checked*` / `saturating*` when you need to detect or clamp instead. Float → integer saturates at the target's bounds, and `NaN` maps to `0`.\n\n`0 as *T` is how a null raw pointer is spelled, and it is the one pointer cast needing no `unsafe`.\n\nAn integer-repr enum converts out with `as i32`; converting **in** goes through `tryFrom`, which returns an `Option` because an arbitrary integer may name no variant.",

  is: "```milo\nif shape is Shape.Circle { … }\n```\nTests which variant an enum value currently holds, as a `bool`. It only inspects — it binds no payload, so reaching a payload still needs `match` or `if let`.",

  null: "```milo\nlet x: Option<i64> = null\n```\nThe empty `Option` — `null` is sugar for `Option.None`, not a null pointer. Safe Milo has no null pointers at all: absence is an `Option`, which the type checker forces you to open before use.\n\nA null **raw** pointer, at an FFI boundary, is written `0 as *T`.",

  true: "```milo\nlet ok: bool = true\n```\nThe true `bool` literal. Conditions must be `bool` — no other type is truthy.",

  false: "```milo\nlet ok: bool = false\n```\nThe false `bool` literal. Conditions must be `bool` — no other type is falsy.",

  from: "```milo\nfrom \"std/json\" import { Json }\n```\nIntroduces an import, naming the module the following `import { … }` list draws from.\n\nA soft keyword — it is only special at the start of an import, so `from` stays usable as a field or parameter name (`struct Edge { from: i32, to: i32 }`).",

  // ── Contracts ──
  // These are the words a reader is most likely to hover, because nothing about
  // `decreases` or `old` explains itself from context.
  requires: "```milo\nrequires <bool expr>\n```\nPrecondition. Must hold at every call site — `milo prove` discharges it there, and a contract-checking build asserts it on entry.",

  ensures: "```milo\nensures <bool expr>\n```\nPostcondition. Holds at every return. `result` names the return value; `old(e)` names what `e` was at entry.",

  invariant: "```milo\ninvariant <bool expr>\n```\nOn a loop: holds before every iteration. Proved by induction — established on entry, preserved by one pass through the body — and then available to everything after the loop.\n\nOn a `struct` (written after the closing brace, over bare field names): a property of the TYPE. Assumed wherever a value of that type is observed, and owed at every struct literal and every `&mut` function that could break it.",

  decreases: "```milo\ndecreases <integer expr>\n```\nTermination measure: must be non-negative and strictly fall across every self-recursive call, or every loop iteration.\n\nOn a function this is not optional bookkeeping — a self-recursive call is modelled by assuming that function's own `ensures`, which is induction, and induction over a recursion that may not terminate proves anything. Without a discharged measure such a proof is reported as conditional.",
};

// Contextual words a contract introduces. They are ordinary identifiers to the lexer
// (you may still name a variable `old`), so the LSP looks them up only after every
// symbol lookup has failed.
export const CONTRACT_WORD_DOCS: Record<string, string> = {
  result: "```milo\nfn abs(x: i64): i64\nensures result >= 0\n```\nThe value the function returns. The checker binds this name only for the `ensures` clauses of a non-`void` function — it does not exist in the body, and a clause sees the parameters and nothing else of the function's internals.\n\nFor what a parameter held *before* the call, use `old(e)`.",

  old: "```milo\nold(e): <type of e>\n```\nThe value `e` held at function entry. Legal only inside `ensures`, and only for a scalar (integer, float, bool) — a debug build snapshots it on entry, and copying a Vec or struct there would either alias or clone on every call.\n\nThis is what lets a contract describe a `&mut` parameter:\n```milo\nfn bump(n: &mut i64): void\nensures n == old(n) + 100\n```\nWithout it, `ensures` can only talk about `result`, so a mutating function has no expressible specification — and a caller learns nothing from it.",
};
