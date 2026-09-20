<!-- doc-meta
system: annotations
purpose: the `@` surface — every compile-time builtin and declaration attribute the compiler understands
key-files: src/parser.ts, src/checker.ts (validateAttributes), src/lower.ts (embedFile/targetOs), src/codegen.ts (cSigGuard)
update-when: an `@` construct is added, removed, or changes what it accepts
last-verified: 2026-09-19
-->

# Annotations and Compiler Builtins

`@` marks something the compiler handles, not the runtime. It is the whole mechanism —
there is no preprocessor, no `#[cfg]`, no macro system. Everything spelled with an `@`
is one of the constructs below. `bun run src/main.ts lang --json` is the authority on that
list, and `tests/langInfo.test.ts` fails if this table omits an attribute it reports.

| Construct | Goes on | What it does |
|---|---|---|
| `@embedFile(path)` | expression | Inlines a file's contents as a string at compile time |
| `@targetOs()` | expression | The OS being compiled for, as a string |
| `@derive(Eq)` | struct | Generates field-by-field `==` and `!=` |
| `@link(lib)` | `extern fn` | Links against a native library |
| `@externalLinkage` | `fn` | Forces external linkage, so DCE cannot drop the symbol |
| `@cSig(header, sig)` | `extern fn` | Verifies the signature against a C header |
| `@cLayout(cType, header)` | `extern struct` | Verifies field offsets against a C header |
| `@cValue(cName, header)` | global `let` | Verifies an integer constant against a C macro |
| `@cOpaque` | struct field | Marks filler with no C counterpart, so `@cLayout` skips it |
| `@noCopy` | struct | Opts a struct out of the all-fields-Copy rule, so move checking engages for a type that wraps a handle |
| `@copyOnly`, `@copyOnly(T)` | struct, `fn` | Restricts a generic's type parameters to Copy types, so a container that moves elements through a raw pointer cannot be instantiated with a heap-owning `T` |
| `@wrapping` | `fn`, method | Arithmetic inside wraps instead of trapping, for inherently modular code; `@!wrapping` applies it to a whole file |
| `@pure` | `fn`, method | Asserts the function reads no global or module state; the checker enforces it |
| `@thread` | `fn`, method | Declares that this function hands a closure to a real OS thread, so the checker holds its captures to `Send` |
| `@synchronized` | method | Declares that the method provides mutual exclusion, so a global written inside it is not racing |
| `@parks` | `fn`, method, `extern fn` | Declares that the call may park the current green task; no view into a mutable global (for-in binding, slice, `&` into an element) may be live across it. Derived transitively from `swapcontext`, so callers need not repeat it |
| `@unsafe` | `fn` | Calling this function requires an `unsafe` block: it has a precondition the compiler cannot check |

Two of these are **builtins** — they appear where a value does, and evaluate while
compiling. The rest are **attributes** — they sit above a declaration.

An unknown attribute is an error, never a silent no-op. So is an attribute on the wrong
kind of declaration: `@cLayout` on a non-extern struct, `@link` on a regular `fn`, or
`@externalLinkage` on an `extern fn` (which declares a function defined elsewhere, so
there is no definition there to give linkage to).

## Compile-time builtins

Both builtins also work without the `@`, but warn (`bare-embedfile`, `bare-targetos`) —
the sigil is what tells a reader the call never happens at runtime.

### `@embedFile(path)`

```milo
let html = @embedFile("index.html")
```

The argument must be a string literal, and the path resolves relative to the file
containing the call. Contents are read as raw bytes, so binary assets embed intact.

What comes back is an ordinary `string`, so the data is parsed with the same code that
would parse it off disk — the only difference is that there is no disk, and no failure
path to handle:

```milo
// Sitting next to this file: version.txt holding `1.4.2`, and pairs.tsv holding
// two tab-separated rows — `alpha  bravo` and `charlie  delta`.

fn main(): i32 {
    let version = @embedFile("version.txt").trim()
    print(version)                                  // 1.4.2

    for line in @embedFile("pairs.tsv").trim().split("\n") {
        let cols = line.split("\t")
        print(cols[0] + " -> " + cols[1])           // alpha -> bravo, charlie -> delta
    }
    return 0
}
```

The parsing still runs at startup; only the *reading* moved to compile time. That is the
usual reason to reach for it — a single-file binary that carries its own assets, with no
install step and no path to get wrong at the customer site.

Web servers are where that pays off most, since the alternative is shipping a static
directory next to the binary and keeping the two in sync. A handler returns the asset
directly:

```milo skip
// Handler shapes from std/http; `index.html` and `public/style.css` are the reader's
// own asset files, so this fence illustrates rather than compiles.
pub fn homeHandler(ctx: &mut Context): Response {
    return ctx.html(@embedFile("index.html"))
}

pub fn styleHandler(ctx: &mut Context): Response {
    return Response.Status(200, "text/css; charset=utf-8", @embedFile("public/style.css"))
}
```

`examples/net/webserver.milo` serves its home page this way.
`examples/net/weather/app.milo` goes further and embeds an entire PWA — HTML, CSS, JS,
service worker, PNG icons, and a US place-name index — so the deployable is one file
with no asset root to configure. `examples/net/termpair/server.milo` embeds xterm.js the
same way. Binary assets work because the contents are raw bytes, not text.

### `@targetOs()`

A constant that is `"darwin"`, `"linux"`, or `"windows"`:

```milo
let devNull = if @targetOs() == "windows" { "NUL" } else { "/dev/null" }
```

Both arms of the `if` are type-checked, but the compiler evaluates the condition and
keeps only the taken arm — the other is never lowered or code-generated. That means the
dead branch may reference symbols that exist on no other platform, such as a Windows-only
extern, without breaking the build anywhere else. The fold triggers on any statically
known condition: `@targetOs()` compared with a string literal, and `!`, `&&`, `||` over
such comparisons.

For a *C declaration* that differs by platform, prefer the stdlib filename split over
`@targetOs()` — see [C FFI](./ffi#platform-specific-declarations).

## Code generation

### `@derive(Eq)`

```milo
@derive(Eq)
struct Point { x: i32, y: i32 }

print(Point { x: 1, y: 2 } == Point { x: 1, y: 2 })   // true
```

Three traits are built-in derivable: `Eq`, `Clone`, and `Json`. `Eq` and `Clone` are
also derived automatically for any plain struct whose fields support them, so `==` and
`.clone()` exist with no annotation at all. The exceptions are resource types: a struct
with a `Drop` impl or `@noCopy` never gets an automatic `clone()`, because duplicating it
would release the resource twice. A user-written trait becomes derivable with a
`derive Trait { … }` template. Operators are implemented by hand — see
[Traits](/language/traits) for overloading `Add`, `Sub`, `Mul`, and `Div`.

## Linkage

### `@link(lib)`

Adds the `-l` flag, so the declaration and its link requirement stay together:

```milo
@link("SDL2")
extern fn SDL_Init(flags: u32): i32
```

### `@externalLinkage`

Forces external linkage on a function the compiler would otherwise see as unreachable
and drop. There is one reason to need it, in two settings: the only caller is outside
what reachability analysis can see. That is a `dlopen`'d library resolving a symbol back
against this executable, or a C program linking a Milo archive — in both cases nothing
inside the program calls the function, so nothing keeps it.

```milo
@externalLinkage
pub fn pluginEntry(): i32 { return 7 }
```

The rule is about *where the definition lives*, not about `pub`. Functions in the file
being compiled get external linkage already; a function reached only through an `import`
is `internal` by default, so dead-code elimination is free to drop it.
`@externalLinkage` is what overrides that.

`build-lib` shows the difference, since its header declares exactly the functions that
kept external linkage:

```milo skip
// mathlib.milo — the file passed to build-lib. `./helpers` is the reader's own file,
// so this fence is illustrative rather than compiled.
from "./helpers" import { miloAdd }

pub fn miloGreet(): void { print("hello from milo") }
```

```milo
// helpers.milo — reached only by import, so it needs @externalLinkage
@externalLinkage
pub fn miloAdd(a: i32, b: i32): i32 { return a + b }
```

Drop the `@externalLinkage` and `miloAdd` vanishes from both the header and the archive,
and the C side fails to link. `miloGreet` needs no annotation, being in the file that was
built.

```bash
milo build-lib mathlib.milo -o libmathlib.a    # also writes libmathlib.h
```

```c
/* host.c */
#include <stdio.h>
#include "libmathlib.h"

int main(void) {
    miloGreet();
    printf("%d\n", miloAdd(2, 3));
    return 0;
}
```

```bash
clang host.c libmathlib.a -o host && ./host
# hello from milo
# 5
```

No wrapper, no runtime to initialize, and no linker flags beyond the archive itself — the
Milo runtime is inside it. What the generated header does and does not cover is in
[C FFI](./ffi#calling-milo-from-c).

## Verifying claims about C

`extern` declarations are claims about a C library, and C linkage has no mangling to
check them against — a wrong return width or a field at the wrong offset links fine and
corrupts silently. These three annotations make the **build** check the claim against the
real headers.

```milo
@cSig("unistd.h", "long sysconf(int)")
extern fn sysconf(name: i32): i64

@cLayout("struct timespec", "time.h")
extern struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}
```

The full rules — what is and isn't checked, prefix structs, `@cOpaque`, cross-compiles,
and `--deny=unverified-extern` for finding declarations nobody annotated — are in
[C FFI](./ffi#verifying-declarations-against-c).

Note that the C checks run when a program is actually built (`milo build`, `milo run`,
`milo build-lib`). `milo emit-ir` stops before that step and does not run them.

## Not annotations

Contract clauses — `requires`, `ensures`, `invariant`, `decreases` — are ordinary keywords in
the declaration, not `@` annotations, because they are type-checked expressions rather than
instructions to the compiler. `old(e)`, which names a parameter's entry value inside an
`ensures`, is contract-only syntax for the same reason. See [Contracts & Safety](/language/safety).

Next: [C FFI](./ffi)
