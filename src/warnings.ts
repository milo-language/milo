// The warning names `--deny=` / `--allow=` accept, and which of them are off by default.
//
// The list existed twice — as string literals at each `this.warn("name", …)` call site in
// checker.ts, and as prose inside the `--deny-all` help text — and nothing compared them.
// A user typing `--deny=unused-varibale` got silence, and a warning added to the checker
// never reached the help. tests/langInfo.test.ts holds this file to the call sites in both
// directions, and cli-help.ts renders the help line from it.
//
// `doc`/`fix`/`example` make this the SOURCE the published warning reference is rendered
// from, rather than a second copy of it: docs/site/language/warnings-and-errors.md carries
// a generated region (scripts/gen-lang-docs.ts), `milo lang --json` carries the same text,
// and an editor or third-party linter reads it from there. The site's 26-warning surface
// was hand-written prose that mentioned 10 of them; the other 16 were undiscoverable
// outside `--help`.
interface WarningInfo {
  name: string;
  /** Off by default: not reported unless `--deny=<name>` (or `--deny-all`) asks for it. */
  offByDefault?: true;
  /**
   * What the warning means, in one or two sentences of markdown. Rendered to the site and
   * to `milo lang --json`; write it for a user who has never seen the name before.
   */
  doc?: string;
  /** What to write instead, one imperative line. */
  fix?: string;
  /**
   * A whole program that provokes the warning. Not decoration: tests/langInfo.test.ts runs
   * `milo check --deny=<name>` over it and fails unless the checker reports THIS name, so a
   * documented example cannot drift away from the rule it illustrates.
   */
  example?: string;
}

/** Warnings whose reference entry is finished. Ratchet: may only grow. */
export const DOCUMENTED_FLOOR = 26;

export const WARNINGS: WarningInfo[] = [
  // Reported when `--expect=<name>` was given and that warning never fired. On by
  // default: an expectation nobody is told about is just a quieter `--allow`.
  //
  // The example is a clean program on purpose: this warning is about a FLAG that
  // outlived its cause, so any program the expectation no longer describes provokes it.
  {
    name: "unfulfilled-expectation",
    doc: "`--expect=<name>` says a warning is known about and keeps the build quiet about it. This fires when the run finished and `<name>` never appeared, which means the code the suppression excused has since been fixed and the flag is now stale.",
    fix: "Drop the `--expect=` flag, or switch it to `--allow=` if the finding should stay silenced whatever happens.",
    example: `// Checked with '--expect=<some-warning>', but nothing in here warns any more.
fn main() {
  let greeting = "hello"
  print(greeting)
}
`,
  },
  {
    name: "bare-embedfile",
    doc: "`embedFile(...)` reads like an ordinary function call, but it is compile-time only: the argument has to be a string literal and the file's bytes are inlined into the binary while the program is compiled. Milo marks compiler-level constructs with an `@`.",
    fix: "Write `@embedFile(\"path\")` so the call site shows that the read happens at compile time.",
    example: `fn main() {
  let text = embedFile("banner.txt")
  print(text)
}
`,
  },
  {
    name: "bare-targetos",
    doc: "`targetOs()` is folded to a constant string (`\"darwin\"`, `\"linux\"`, `\"windows\"`) during compilation rather than called at runtime, so it belongs with the other `@`-marked builtins. Both arms of an `if @targetOs() == \"linux\"` still type-check; only the dead one is dropped.",
    fix: "Write `@targetOs()` instead of `targetOs()`.",
    example: `fn main() {
  let os = targetOs()
  print(os)
}
`,
  },
  {
    name: "external-linkage-not-pub",
    doc: "`@externalLinkage` keeps a symbol visible to the C linker, which is a different question from whether Milo code in another file may call it. A function that carries the attribute but is not `pub` is usually one whose author wanted the second thing and reached for the first.",
    fix: "Add `pub` if the function should be importable from Milo, and keep both if a `dlopen`'d library resolves the symbol.",
    example: `@externalLinkage
fn miloCallback(x: i64): i64 {
  return x * 2
}

fn main() {
  print(miloCallback(21).toString())
}
`,
  },
  {
    name: "borrow-that-clones",
    doc: "`arenaWith` exists so a closure can read a value in place without copying it out of the arena. A closure whose entire body is `return x.clone()` throws that borrow away, paying for a closure, a callback and a nested match to get the copy `arenaGet` already returns.",
    fix: "Call `arenaGet(arena, handle)` (or `arena.get(handle)`) and delete the closure.",
    example: `from "std/arena" import { Arena, arenaWith }

fn main() {
  var names: Arena<string> = Arena<string>.new()
  let h = names.alloc("ada")
  let Some(n) = arenaWith(names, h, (s: &string): string => { return s.clone() }) else { return }
  print(n)
}
`,
  },
  {
    name: "index-clone",
    doc: "Indexing a collection of owned values (`v[0]`, `m[key]`) copies the element out, because the language has no stored references to hand back. On a `string` or a `Vec` that copy is a heap allocation per index.",
    fix: "Bind a borrow with a method that lends (`v.at(i)`), or hoist the element out once instead of indexing in a loop.",
    example: `fn main() {
  var v: Vec<string> = Vec.new()
  v.push("a")
  let m = v[0]
  print(m)
}
`,
  },
  {
    name: "large-stack-array",
    offByDefault: true,
    doc: "A fixed-size local array is a single stack allocation of its full size, made on entry to the function. A large one overflows the stack at runtime with no diagnostic at all, so this reports any local above the size limit (512 KiB by default). The limit is tunable with `--max-stack-array` (a `k`/`m` suffix is accepted, e.g. `--max-stack-array=256k`).",
    fix: "Move the buffer to the heap with `Vec<T>`, or make the array smaller.",
    example: `fn main() {
  var buf: [u8; 1048576] = [0; 1048576]
  buf[0] = 1
  print(buf[0].toString())
}
`,
  },
  {
    name: "manual-option-default",
    doc: "A `match` over an `Option` whose `Some` arm hands back the payload untouched and whose `None` arm hands back a constant is the `??` operator written out over five lines.",
    fix: "Write `<option> ?? <default>` in place of the match.",
    example: `fn lookup(flag: bool): Option<i64> {
  if flag { return Some(7) }
  return None
}

fn main() {
  let found = lookup(false)
  let n = match found {
    Some(v) => v
    None => 0
  }
  print(n.toString())
}
`,
  },
  {
    name: "adopt-raw-fields",
    doc: "`adopt` and `adoptSlice` hand back a value that owns its allocation, but a raw pointer field owns nothing and gets no drop glue. Dropping the adopted value therefore frees the struct itself and not whatever its pointer fields address.",
    fix: "Free what the raw pointer fields address before the adopted value drops, or pass `--allow=adopt-raw-fields` when those fields are borrowed.",
    example: `from "std/foreign" import { adopt }

struct Node {
  label: *u8,
  id: i64,
}

fn main() {
  unsafe {
    let n = Heap(Node { label: 0 as *u8, id: 7 })
    let raw = n.ptr()
    forget(n)
    let Some(owned) = adopt(raw) else { return }
    print((*owned).id.toString())
  }
}
`,
  },
  {
    name: "arena-never-frees",
    doc: "This arena is never freed or cleared, so every handle it hands out stays valid for the arena's whole life. `get` still returns an `Option`, so each read makes the caller unwrap a `None` that cannot occur.",
    fix: "Call `arena.sealGrowth()`, which keeps `alloc` and gives an infallible `get`, or `arena.freeze()`.",
    example: `from "std/arena" import { Arena }

fn main() {
  var nodes: Arena<i64> = Arena<i64>.new()
  let h = nodes.alloc(7)
  let Some(v) = nodes.get(h) else { return }
  print(v.toString())
}
`,
  },
  {
    name: "missing-interpolation",
    doc: "Only an f-string interpolates. A plain `\"hi {name}\"` compiles to exactly those characters with no error, which makes it the quietest way to produce wrong output. Reported only when the braced name really resolves in scope, so a literal holding shell, CSS or another tool's format string stays silent.",
    fix: "Prefix the literal with `$`: `$\"hi {name}\"`.",
    example: `fn main() {
  let name = "world"
  print("hello {name}")
}
`,
  },
  // A free fn with three or more `&mut` parameters is a struct's method with the struct
  // un-bundled: every call site is a row of same-typed `&mut` markers that can be swapped
  // silently. Off by default: about 34 hits in tree today (gifdec, the plink and redline
  // world builders), so it is a census lint until those are restructured.
  {
    name: "mut-param-bundle",
    offByDefault: true,
    doc: "A free function with three or more `&mut` parameters is a struct's method with the struct taken apart. Every call site becomes a row of same-typed `&mut` arguments, and two of them can be swapped without the compiler noticing.",
    fix: "Bundle the parameters into a struct and make the function a method on it, so the receiver needs no marker and the fields cannot be reordered.",
    example: `fn step(x: &mut i64, y: &mut i64, ticks: &mut i64): void {
  x = x + 1
  y = y + 2
  ticks = ticks + 1
}

fn main() {
  var x: i64 = 0
  var y: i64 = 0
  var ticks: i64 = 0
  step(&mut x, &mut y, &mut ticks)
  step(&mut x, &mut y, &mut ticks)
  print($"{x} {y} {ticks}")
}
`,
  },
  {
    name: "nan-comparison",
    doc: "NaN compares equal to nothing, itself included, so `x == f64.NAN` is always false and `x != f64.NAN` is always true. Whichever branch the test guards is dead code.",
    fix: "Test with `isNan(x)` from `std/math`.",
    example: `fn main() {
  let x: f64 = 0.0 / 0.0
  if x == f64.NAN {
    print("this branch can never run")
  }
}
`,
  },
  // The thread-boundary global check cannot see through a call to a function value, so it
  // is incomplete there. Off by default: every occurrence in the tree today is a callback
  // that touches nothing, and an on-by-default warning nobody can act on is noise.
  {
    name: "opaque-call-on-thread",
    offByDefault: true,
    doc: "This code runs on a real OS thread and calls through a function value: a closure, a function-typed parameter, or a C function pointer. Such a call has no statically known target, so nothing can check whether it reaches one of the program's unsynchronized mutable globals.",
    fix: "Call a named function instead, or make the globals it might touch atomics from `std/sync`.",
    example: `from "std/runtime" import { spawnOsThreadDetached }

var ticks: i64 = 0

fn main() {
  let report = (): void => { print("worker started") }
  spawnOsThreadDetached(move(): void => {
    report()
  })
  print(ticks.toString())
}
`,
  },
  {
    name: "shadows-stdlib-override",
    doc: "A function whose name and signature both match a standard-library function takes that name over everywhere, including inside the library's own calls to it. Milo's flat namespace makes this a supported override, but it silently rebinds code you did not write.",
    fix: "Rename the function, or pass `--allow=shadows-stdlib-override` when the override is deliberate.",
    example: `// std/string already defines a function with this exact name and signature.
fn asciiIsWhitespace(ch: u8): bool {
  return ch == 32
}

fn main() {
  print(asciiIsWhitespace(9).toString())
}
`,
  },
  {
    name: "single-variant-match",
    offByDefault: true,
    doc: "A `match` in which every arm but one has an empty body is an `if let` with extra punctuation. The empty arms carry no behaviour and bury the single arm that does.",
    fix: "Write `if let Variant(x) = subject { ... }` in place of the match.",
    example: `enum Event {
  Click(i64),
  Scroll(i64),
}

fn main() {
  let e = Event.Click(3)
  match e {
    Click(x) => { print($"clicked {x}") }
    Scroll(y) => {}
  }
}
`,
  },
  // `out += piece` inside a loop copies the whole accumulator per iteration; `pushStr`
  // is amortized. On by default since 2026-09-21, once the example corpus reached zero.
  {
    name: "string-concat-in-loop",
    doc: "`out += piece` inside a loop allocates a fresh string the size of the whole accumulator on every iteration, so a loop that reads as linear is quadratic in the length of the result. `pushStr` appends in place and grows amortized.",
    fix: "Append in place: `out.pushStr(piece)` for a string, `out.push(byte)` for a single byte.",
    example: `fn main() {
  var out = ""
  for i in 0..5 {
    out += "x"
  }
  print(out)
}
`,
  },
  {
    name: "unused-import",
    offByDefault: true,
    doc: "A name in an import list that nothing in the file refers to. It costs every reader a lookup and hides which modules the file actually depends on.",
    fix: "Remove the name from the import list, unless the import is there to force that module to link.",
    example: `from "std/json" import { Json }

fn main() {
  print("no JSON here yet")
}
`,
  },
  // The census of `@copy` structs. Every hit is a deliberate annotation, so it is off by
  // default; `--deny=unowned-pointer-copy` enumerates them for an ownership audit.
  {
    name: "unowned-pointer-copy",
    offByDefault: true,
    doc: "`@copy` keeps a struct copyable although it holds a raw pointer, so every copy of the struct duplicates that pointer and all the copies address the same memory. That is exactly what the annotation asks for; this lint lists every place it was asked for so an audit can re-ask the question.",
    fix: "Confirm the struct does not own what its pointer addresses, and remove `@copy` if it does, so the struct becomes move-tracked.",
    example: `@copy
struct Slice {
  data: *u8,
  len: i64,
}

fn main() {
  print("Slice is Copy and borrows its bytes")
}
`,
  },
  // A `requires` on an `unsafe`-bodied fn is the last guard before C, and `-O2` drops
  // it: an AES key length and a pool block size both reached C unchecked this way
  // (backlog #27). Off by default; `--deny=unchecked-ffi-contract` audits the set.
  {
    name: "unchecked-ffi-contract",
    offByDefault: true,
    doc: "A `requires` clause is checked under `--debug` and compiled out at `-O2`. On a function whose body enters `unsafe`, that contract is the last guard before the value reaches C, and nothing in the body repeats the check, so an optimized build hands C a value nobody validated.",
    fix: "Check the condition in the body as well (return an `Err`, or assert), or pass `--allow=unchecked-ffi-contract`.",
    example: `extern fn abs(x: i32): i32

fn boundedAbs(x: i32): i32
requires x > -1000
{
  unsafe {
    return abs(x)
  }
}

fn main() {
  print(boundedAbs(-5).toString())
}
`,
  },
  {
    name: "unused-move",
    offByDefault: true,
    doc: "This parameter takes ownership of its argument, but the body never moves that value anywhere, so every caller gives up ownership for nothing.",
    fix: "Take `&T` instead, so callers keep the value they pass.",
    example: `fn shout(msg: string): i64 {
  return msg.len()
}

fn main() {
  print(shout("hello").toString())
}
`,
  },
  {
    name: "unused-result",
    doc: "A `Result` or `Option` discarded as a statement, or the return value of a `@mustUse` function thrown away. The value being dropped is the one that says whether the operation failed.",
    fix: "Handle the value, or write `let _ = ...` to discard it on purpose.",
    example: `fn firstEven(v: &Vec<i64>): Option<i64> {
  for n in v {
    if n % 2 == 0 { return Some(n) }
  }
  return None
}

fn main() {
  var v: Vec<i64> = Vec.new()
  v.push(3)
  firstEven(v)
}
`,
  },
  {
    name: "unused-unsafe",
    doc: "Nothing inside this `unsafe` block actually requires it. An `unsafe` that guards nothing trains readers to skim past the ones that guard something.",
    fix: "Remove the `unsafe` wrapper.",
    example: `fn main() {
  unsafe {
    print("nothing in here needs unsafe")
  }
}
`,
  },
  {
    name: "unused-variable",
    doc: "A binding nothing reads. Usually a rename that missed one site, or a value whose computation is now dead.",
    fix: "Delete the binding, or prefix the name with `_` to say the value is deliberately ignored.",
    example: `fn main() {
  let unused = 42
  print("hi")
}
`,
  },
  {
    name: "useless-forget",
    doc: "`forget` suppresses a value's drop, and a `Copy` value owns no resource and has no drop to suppress, so the call does nothing whatsoever.",
    fix: "Delete the `forget` call.",
    example: `fn main() {
  let n: i64 = 7
  forget(n)
  print("done")
}
`,
  },
  {
    name: "unverified-extern",
    offByDefault: true,
    doc: "An `extern struct` without `@cLayout`, or an `extern fn` without `@cSig`, is an unchecked claim about what C declares. A wrong field offset reads garbage, and a wrong pointee width lets the C side write past whatever the caller reserved.",
    fix: "Add `@cLayout(\"struct foo\", \"some/header.h\")` or `@cSig(\"some/header.h\", \"<the C declaration>\")` so the build checks the claim against the real header.",
    example: `extern struct Timespec {
  tv_sec: i64,
  tv_nsec: i64,
}

fn main() {
  print("Timespec mirrors a C layout nothing has checked")
}
`,
  },
];

export const WARNING_NAMES: string[] = WARNINGS.map(w => w.name);

// Where a warning's published entry lives. The heading scripts/gen-lang-docs.ts writes is
// `### <name>`, which VitePress anchors as `#<name>`. tests/langDocs.test.ts holds the
// origin to `SITE` in docs/site/.vitepress/config.mts, so a moved site fails a test instead
// of every editor link going dead.
export const WARNING_DOCS_URL = "https://milo-language.github.io/milo/language/warnings-and-errors";

export function warningDocUrl(name: string): string | undefined {
  return WARNING_NAMES.includes(name) ? `${WARNING_DOCS_URL}#${name}` : undefined;
}
export const OFF_BY_DEFAULT: string[] = WARNINGS.filter(w => w.offByDefault).map(w => w.name);
