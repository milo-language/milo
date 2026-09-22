<!-- doc-meta
system: c-ffi
purpose: declaring, linking, and verifying C interfaces from Milo — extern fn/struct, @link, and the @cSig/@cLayout/@cValue build-time guards
key-files: src/checker.ts (checkCSig/checkCLayout/checkCValue), src/codegen.ts (cDeclGuards/cSigGuard), src/csig.ts, src/main.ts (verifyCDecls)
update-when: an FFI annotation changes what it accepts or what it verifies
last-verified: 2026-08-31
-->

# C FFI

Call any C library by declaring external functions.

```milo
extern fn puts(s: *u8): i32
extern fn printf(fmt: *u8, ...): i32
extern fn sqrt(x: f64): f64
extern fn malloc(size: u64): *u8
```

## Safe and unsafe calls

An extern call is not automatically unsafe. The compiler decides from the types:

**Safe** — no `unsafe` needed:

- every pointer parameter gets an auto-coerced argument (`string`→`*u8`, `[T;N]`→`*T`, matching `*T`→`*T`)
- a function-typed parameter gets a matching Milo function
- a by-value `extern struct` argument
- the return type is scalar, `void`, or a by-value `extern struct`

**Unsafe** — the return is a pointer (unknown provenance), or a parameter takes a raw `*T` that didn't come from coercion.

```milo
extern fn puts(s: *u8): i32
extern fn malloc(size: u64): *u8

fn main(): i32 {
    puts("Hello from C!")             // safe — string coerces to *u8, returns i32
    unsafe { let p = malloc(64) }     // unsafe — returns *u8
    return 0
}
```

`string.cstr()` and `vec.ptr()` hand out a data pointer without `unsafe` — the owner stays alive in the caller. `x.addrOf()` takes the address of any lvalue and does require `unsafe`.

## Linking a library

`@link` adds the `-l` flag, so the declaration and the link requirement live together:

```milo
@link("SDL2")
extern fn SDL_Init(flags: u32): i32
```

A darwin framework is not a `-l` name, so it gets its own spelling. The framework and the
linux `-l` usually hold the same symbols under two names, which makes this a job for the
platform split — `gl.darwin.milo` and `gl.linux.milo` declaring the same surface:

```milo
// gl.darwin.milo
@link("framework:OpenGL")
pub extern fn glGetError(): u32

// gl.linux.milo
@link("GL")
pub extern fn glGetError(): u32
```

`framework:` off darwin is an error, not a silently dropped flag — it means the platform
arm is wrong, and a link that quietly omits a library fails later with undefined symbols.

The name is constrained to letters, digits, `_`, `.`, `+` and `-` (after an optional
`framework:`). It is pasted into the link command the compiler shells out to, and `milo
add` fetches third-party source — building a package must not be able to run one.

## Verifying declarations against C

An `extern fn` or `extern struct` is a **claim** about C, and C linkage has no mangling to check it against. A wrong parameter type, a wrong arity, or a field at the wrong offset links fine and corrupts silently at the ABI seam. `unsafe` does not help — it tracks provenance, not layout.

Milo verifies these claims at build time against the real headers. The checks run when a
program is built (`milo build`, `milo run`, `milo build-lib`); `milo emit-ir` stops before
that step and skips them.

### `@cSig` — check a function signature

```milo
@cSig("unistd.h", "long sysconf(int)")
extern fn sysconf(name: i32): i64
```

The compiler generates a throwaway C translation unit that includes the header, compiles it, and discards it. It checks three independent claims and reports which one broke:

1. the stated signature really is what the header declares (via `__builtin_types_compatible_p`)
2. the Milo return type's width and signedness match that C return type
3. each Milo parameter's width — and, for a pointer, its **pointee's** width — matches the C parameter in the same position

```
error[c-decl]: a declaration does not match the C header it claims to describe
  sysconf: Milo declares a 4-byte return, C returns a different width
```

Claim 3 is what an out-param needs. An out-param is the callee writing into your frame, so the pointee width *is* the contract, and nothing else in the pipeline can see it — the ABI passes one machine word whatever the pointee is:

```milo
@cSig("OpenGL/gl3.h", "void glGetShaderiv(GLuint, GLenum, GLint *)")
extern fn glGetShaderiv(shader: u32, pname: u32, out: *u16)   // GL writes 4 bytes, not 2
```

```
error[c-decl]: a declaration does not match the C header it claims to describe
  glGetShaderiv parameter 3: Milo writes through a *u16 (2-byte pointee), OpenGL/gl3.h says 'GLint *'
```

Arity is checked earlier still, in the type checker, with no header involved — a signature that lists a different number of parameters than the declaration would shift every comparison above by one.

**`*u8` is the opt-out.** A Milo `*u8` parameter stands for C's `void *` and for any pointer whose pointee Milo does not model — `LPSECURITY_ATTRIBUTES`, or a `struct stat` a caller reads as a byte buffer. Its pointee is never checked, because checking it would only force you to invent a fake pointee. Every other pointee is a claim about how wide the callee's writes are, and that claim gets checked. Spell the real pointee whenever you know it: `*u32` for a GL name, `*i32` for a `GLint` out-param. A struct pointee is compared with `>=`, matching the prefix rule below.

**Why you write the C signature instead of the compiler deriving it:** Milo's type system can't express C type identity. `i64` is a 64-bit integer, but C distinguishes `long` from `long long` — on macOS `int64_t` *is* `long long`, so a derived declaration would reject the correct `sysconf` above. The signature says which C type is meant.

Write it exactly as the header spells it, pointers included (`"ssize_t read(int, void *, size_t)"`) — that is what makes pointer-taking functions checkable at all.

**What is still not checked:** signedness of a parameter (a `size_t` C parameter against a Milo `i64` is common and harmless), and any parameter of a signature that takes a function pointer — nested parens make splitting the list unreliable, so those signatures get the header comparison and nothing else.

### Headers that aren't named the same everywhere

Some headers have no one portable spelling. Separate alternates with `|`; the first one present wins:

```milo
@cSig("OpenGL/gl3.h|GL/glcorearb.h", "GLenum glGetError(void)")
extern fn glGetError(): u32
```

A path may be prefixed with `+`-separated feature macros the header needs before it declares anything — without them the header is present and empty, which reads as a wrong Milo declaration rather than a missing `#define`:

```milo
@cSig("OpenGL/gl3.h|GL_GLEXT_PROTOTYPES+GL/glcorearb.h", "void glGenBuffers(GLsizei, GLuint *)")
extern fn glGenBuffers(n: i32, ids: *u32)
```

The same spelling works on `@cLayout` and `@cValue`.

### `@cLayout` — check a struct layout

The compiler believes a declared layout and computes field offsets from it, so a field that disagrees with the real header reads its neighbour and returns plausible garbage — no crash, no diagnostic. `@cLayout(cType, header)` compiles a translation unit of `_Static_assert`s against the real header instead:

```milo
@cLayout("struct timespec", "time.h")
extern struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}
```

```
error[c-layout]: an extern struct's declared layout does not match the C header
  Timespec.tv_sec: Milo says offset 0, C header disagrees
```

Every field is checked for both its offset and its own size — offsets alone miss a wrong width on the last field, and elsewhere a too-narrow field can hide inside the next field's padding. Milo field names are used as the C field names. If the layout ever drifts from an OS update or a new architecture, the **build breaks** instead of the program lying.

Declaring only a **prefix** of a C struct is supported and common: total size is checked with `>=`, not `==`, so you can stop early and ignore trailing platform fields. Field *order* must still match from the start. Mark a field `@cOpaque` to exclude it — filler with no C counterpart.

### `@cValue` — check a constant

An FFI surface is not only functions and structs. Every `#define` you bind gets retyped as a Milo literal, and that transcription has no anchor at all: a wrong pixel format or scancode links fine and runs, producing a garbled frame or a key that does nothing. `@cValue(cName, header)` asserts the constant against the macro it claims to mirror:

```milo
@cValue("SDL_PIXELFORMAT_ABGR8888", "SDL2/SDL.h")
pub let SDL_PIXELFORMAT_ABGR8888: u32 = 0x16762004
```

```
error[c-decl]: a declaration does not match the C header it claims to describe
  SDL_INIT_VIDEO: Milo says 33, SDL2/SDL.h defines SDL_INIT_VIDEO as something else
```

It goes on an immutable global whose initializer is an **integer literal**. A computed initializer is rejected: folding it here and asserting the result would compare Milo's arithmetic against itself, which says nothing about the header. The point is to check a hand-transcribed number, so there has to be a transcription.

Both sides are cast to one 64-bit type before comparing, so C's usual arithmetic conversions can't decide the result on a bit pattern instead of a value.

### Third-party headers

The compiler links `@link` libraries by name and never needs their headers to build — so nothing else in a Milo build carries an `-I`. The guard TU does, and gets it from `pkg-config --cflags` for each `@link`ed library (trying the name as written, then lowercased: `@link("SDL2")` finds `sdl2.pc`).

If the header isn't installed — a machine with `libSDL2` but not `libsdl2-dev` — that header's guards are **skipped with a warning**, not failed:

```
warning: @cLayout/@cSig/@cValue guards for 'SDL2/SDL.h' skipped — no such header on
this machine, so those declarations went unchecked
```

Failing would make every consumer of an annotated package install dev headers to build something that links fine without them. Skipping silently would be worse than no guard at all, so it is always announced, by name.

The skip is **per header**. Each header is included behind its own `__has_include`, and each group of asserts behind its own `#ifdef`, so one absent third-party header no longer takes the `sys/stat.h` and `unistd.h` claims down with it. This is what makes the annotations usable in portable library code: a binding can be verified on the machines that have the header without becoming a hard dev-package dependency for everyone else.

### Finding what isn't verified

These annotations are opt-in, so an unannotated `extern struct` or `extern fn` looks exactly like a verified one. `--deny=unverified-extern` turns that into an error:

```
error: extern struct 'Stat' has no @cLayout — its layout is an unverified claim about C
error: extern fn 'glGenBuffers' has no @cSig — its signature is an unverified claim about C
  hint: 'ids' is a pointer C writes through, so its pointee width is part of the
        contract and nothing checks it
```

It's off by default on purpose: an `extern struct` paired with a local `.c` file has no header to name, a legitimate shape `@cLayout` can't express. Turn it on for a project where every declaration should be pinned to a real header. It only reports declarations in the file being compiled — an extern inside a library you imported isn't yours to annotate.

All three checks are skipped for bare-metal targets, which are freestanding and cross-compiled — the host's headers aren't the ones the program runs against. On a cross-compile with a sysroot (`MILO_WINDOWS_SDK`), they *do* run, against the target's headers.

## Platform-specific declarations

There is no `#[cfg]` or `#ifdef`. Two mechanisms, for two different situations.

**A C declaration that differs by platform** goes in a filename split. The resolver picks the arm matching the target OS:

```
std/platform.darwin.milo
std/platform.linux.milo
std/platform.windows.milo
```

The filename states which C library is being described, so the claim inside it is unconditionally true — Windows spells POSIX `read` as `_read` and returns `int` where POSIX returns `ssize_t`, which is two declarations in two files, not one annotation with an escape hatch. Every arm must export the *same* surface: a name only some platforms can provide still has to exist on all of them, failing loudly (a link error naming the symbol, or an explicit abort) rather than returning a plausible-looking value.

**Application code that has no such split** branches on `@targetOs()`, a compile-time constant that is `"darwin"`, `"linux"`, or `"windows"`:

```milo
let devNull = if @targetOs() == "windows" { "NUL" } else { "/dev/null" }
```

Both arms are type-checked, but the compiler folds the condition and keeps only the taken arm — the other is never lowered or code-generated. So the dead branch may reference symbols that exist on no other platform:

```milo
// Declared everywhere, linked only on Windows. The dead branch is folded out
// before codegen elsewhere, so the reference never reaches the linker there.
extern fn startWinsock(): void

fn main(): i32 {
    if @targetOs() == "windows" {
        startWinsock()
    }
    return 0
}
```

The fold triggers on any statically-known condition — `@targetOs()` compared with a string literal, and `!`/`&&`/`||` over such comparisons.

## Opaque foreign types

`extern type` declares a type with no known size or layout. It can only exist behind a pointer:

```milo
extern type sqlite3
extern type sqlite3_stmt

extern fn sqlite3_open(path: *u8, db: **sqlite3): i32
extern fn sqlite3_close(db: *sqlite3): i32
```

Using one by value is a compile error. `*sqlite3` is a distinct type from `*sqlite3_stmt` and from `*u8`, so handle mixups are caught at compile time.

## Structs by value

An `extern struct` may cross the C ABI by value, as an argument and as a return value. The compiler classifies each struct per the platform ABI (AAPCS64 on ARM64, System V on x86-64): small structs are coerced into registers, homogeneous-float structs go in SIMD/SSE registers, larger ones pass indirectly (`byval`) and return through a hidden pointer (`sret`). The lowering matches what clang emits.

```milo
extern struct Vec2 { x: f64, y: f64 }

extern fn vec2_add(a: Vec2, b: Vec2): Vec2

fn main(): i32 {
    let c = vec2_add(Vec2 { x: 1.0, y: 2.0 }, Vec2 { x: 3.0, y: 4.0 })
    print(c.x)      // safe — no unsafe needed
    return 0
}
```

Only an `extern struct` may cross by value, and its fields must be C-representable: integers, floats, `bool`, pointers, nested extern structs, and fixed arrays of those. `string`, `Vec`, and enums are rejected — every extern struct is plain-old-data, so passing one leaves the original usable. Not supported (pass `&T` instead): a struct in a variadic position, an `enum` crossing the ABI, a function-pointer parameter that itself passes a struct by value, and struct-by-value on bare-metal ARM.

## Typed function pointers

Extern functions can declare function-typed parameters. Passing a matching Milo function needs no cast:

```milo
extern fn qsort(base: *u8, num: i64, size: i64, cmp: (*u8, *u8) => i32): void

fn cmpI32(a: *u8, b: *u8): i32 {
    unsafe { return *(a as *i32) - *(b as *i32) }
}

fn main(): i32 {
    var arr: [i32; 5] = [50, 10, 99, 30, 70]
    unsafe { qsort(arr[0].addrOf() as *u8, 5, 4, cmpI32) }
    return 0
}
```

### As an extern struct field

The same spelling inside an `extern struct` means a **thin C function pointer**: one word, the
code pointer alone. A Milo fn value is a `{ code, environment }` pair, and only the code half has
a C representation, so the field is laid out and passed exactly as C's
`int32_t (*read)(uint8_t*, int32_t)` is. `milo build-lib` publishes it with that spelling.

```milo
extern struct Ops {
    read: (*u8, i32) => i32,
}

fn readCount(_p: *u8, n: i32): i32 {
    return n
}

fn main() {
    let ops = Ops {
        read: readCount,
    }
    unsafe {
        print(ops.read(0 as *u8, 41))
    }
}
```

What may be stored in such a field is exactly two things: a **top-level function** whose
signature matches, and **another field of the same type** (a pointer copy). A closure is
rejected, because the environment would be lost on the way in and the C call would then read
garbage out of the argument register.

What may be done with one is also exactly two things: **call it**, which needs `unsafe` for the
reason calling it from C is unchecked (it may be null, and its real signature is the caller's
word), and **`isNull(s.field)`**, since a C ops table routinely leaves an optional callback null.
Binding it to a local, passing it on, returning it or putting it in a `Vec` are errors: all four
would need a thin pointer to become a fat one, which means inventing an environment.

## Memory Milo did not allocate

At a C boundary Milo owns nothing: C allocated the memory, C will free it, and C may write it
after you return. `std/foreign` is the three constructors that let a program keep its guarantees
across that seam without adding a reference kind, a lifetime, or a rule. See
[std/foreign](/stdlib/foreign) for the full contracts.

```milo
from "std/foreign" import { withRaw, withRawMut, adopt, adoptSlice }
```

- **`withRaw(p, len, f)` / `withRawMut`** call `f` with a real `&[T]` / `&mut [T]` over
  `(ptr, len)`. The view is a second-class reference in parameter position, so it provably dies
  with the call and cannot be stored or returned. `Option.None` without calling `f` when `p` is
  null, so the null path is in the type rather than in a convention.
- **`?&mut T`** is a nullable extern reference: legal only in an `extern` / `@externalLinkage`
  signature, ABI exactly `T*`, unwrapped with `let`-else. It is what lets an exported entry point
  take a pointer a C caller may leave null without the body ever seeing a pointer.
- **`adopt(p)` / `adoptSlice(p, len)`** take ownership back through a raw pointer, the inverse of
  `forget`: the `Heap<T>` / `Vec<T>` that comes out drops, and that drop frees the allocation.
  Milo allocates with plain libc `malloc`, so the round trip is symmetric in both directions.

The give leg is `h.ptr()`, the `Heap<T>` sibling of `v.ptr()`:

```milo
from "std/foreign" import { adopt }

struct Point {
    x: i64,
    y: i64,
}

pub fn main(): i32 {
    let h = Heap(Point {
        x: 1,
        y: 2,
    }
    )
    unsafe {
        let raw = h.ptr()      // *Point, the allocation itself
        forget(h)              // Milo's ownership ends here
        match adopt(raw) {     // ...and comes back
            Option.Some(box) => {
                print((*box).x)
            }
            Option.None => {
                print("null")
            }
        }
    }
    return 0
}
```

`adopt` frees the struct and not what its raw pointer fields address, because a raw pointer owns
nothing and gets no drop glue. The compiler says so at the call site (`adopt-raw-fields`) rather
than leaving it to the reader.

## Calling Milo from C

Two ways out, depending on what the other build system wants to consume:

```bash
milo emit-obj mathlib.milo -o mathlib.o --emit-header   # one object file + mathlib.h
milo build-lib mathlib.milo -o libmathlib.a             # static archive + libmathlib.h
```

`pub` is the API boundary. Only `pub` functions are declared in the header, so a helper
you never marked `pub` stays out of the published surface. A `pub` function that lives in an
imported file also needs
[`@externalLinkage`](./annotations#keeping-an-imported-function-for-c-callers), or it is
dropped as unreachable:

```milo
// mathlib.milo
pub fn gcd(a: i32, b: i32): i32 {
    var x = a
    var y = b
    while y != 0 {
        let t = x % y
        x = y
        y = t
    }
    return x
}

fn unusedHelper(n: i32): i32 { return n + 1 }   // not pub — not in the header
```

The generated `mathlib.h` declares `gcd` and nothing else:

```c
/* exported functions */
int32_t gcd(int32_t a, int32_t b);
```

Include it and link the object like any other:

```c
// main.c
#include <stdio.h>
#include "mathlib.h"

int main(void) {
    printf("gcd(84, 36) = %d\n", gcd(84, 36));
    return 0;
}
```

```bash
$ milo emit-obj mathlib.milo -o mathlib.o --emit-header
$ clang main.c mathlib.o -o demo && ./demo
gcd(84, 36) = 12
```

The archive works the same way — `clang main.c -L. -lmathlib -o demo`.

Alongside the functions, the header declares the extern structs; opaque `extern type`
declarations become forward `typedef struct X X;`. Anything without a stable C spelling — a
`Vec`, `String`, or enum in a signature — is emitted as a `/* skipped: ... */` comment, so
the header stays valid and the gap stays visible.

::: warning Linkage is wider than the header
The header is the contract, but the object still carries external symbols for non-`pub`
functions, so a determined caller can declare and link one by hand. Narrowing the symbols
themselves is tracked in [backlog.md](https://github.com/milo-language/milo/blob/main/docs/backlog.md);
don't rely on a name the header doesn't declare.
:::
