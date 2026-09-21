// Formatter regression tests. fmt.milo had no coverage at all, which is how it shipped
// splitting `extern struct Foo` across three lines — and then baked that into 16
// committed fixtures, since formatting is applied on the way in.
//
// Each case asserts two properties: the formatter's output for an already-canonical
// input is unchanged (round-trip), and formatting twice equals formatting once
// (idempotence — the property that catches "fix moves the mangling around").
import { test, expect, beforeAll } from "bun:test";
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const FMT = join(ROOT, "examples", "cli-tools", "fmt.milo");
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-fmt-")); });

function format(src: string, name: string): string {
  const f = join(dir, `${name}.milo`);
  writeFileSync(f, src);
  return execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "run", FMT, "--", f], {
    cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  });
}

// `extern fn` already round-tripped; `extern struct` and `extern type` did not.
const cases: Record<string, string> = {
  externStruct: `extern struct Timespec {\n    tv_sec: i64,\n    tv_nsec: i64,\n}\n`,
  externFn: `extern fn clock_gettime(clockId: i32, tp: *Timespec): i32\n`,
  externType: `extern type Opaque\n`,
  attributed: `@cLayout("struct timespec", "time.h")\nextern struct Timespec {\n    tv_sec: i64,\n    tv_nsec: i64,\n}\n`,
  // The lexer emits `@` as an Ident, so inside a struct body `@cOpaque b: i32` looked
  // like three statements sharing a line and the reflow split it across three — output
  // the parser then rejects, since an attribute name must hug its `@`. The formatter
  // broke a working file.
  fieldAttribute: `extern struct Timeval {\n    tv_sec: i64,\n    @cOpaque _pad: i32,\n}\n`,
  // `@embedFile("x")` is the first `@` construct in *expression* position. Same
  // Ident-lexed `@` hazard as fieldAttribute: `@` then `embedFile` looked like two
  // statements sharing a line, so the reflow split the call in half.
  sigilBuiltin: `fn main(): i32 {\n    let s = @embedFile("hello.txt")\n    print(s)\n    return 0\n}\n`,
  sigilBuiltinNested: `fn body(): string {\n    return wrap(@embedFile("hello.txt"), 1)\n}\n`,
  // A prefix `!` in an argument list came out as `f(a,!b)`: the `!` rule returned
  // before the general space-after-a-comma one. Stable output, so the idempotence
  // corpus could not see it — only a round-trip case can.
  bangAfterComma: `fn main() {\n    let x = true\n    take(x, !x, 1)\n}\n`,
  // `?&mut T` is the one PREFIX use of `?`; the postfix rule for the propagate operator
  // and the `T?` shorthand printed it as `b:?&mut Bump`. Stable output, so idempotence
  // could not see it — a round-trip case is the only thing that can.
  nullableExternRef: `@externalLinkage\npub fn bumpX(b: ?&mut Bump): i32 {\n    let p = b else {\n        return -1\n    }\n    return p.x\n}\n`,
  nullableExternRefShared: `extern fn peek(b: ?&Bump): i32\n`,
  // A C function-pointer field: the fn-type arrow and a `*T` parameter inside a struct
  // body, which no other case puts there.
  externFnPtrField: `extern struct Ops {\n    read: (*u8, i32) => i32,\n    close: () => void,\n}\n`,
  // `&mut x` on a call argument (explicit mutable borrow): the `&` must hug `mut` after
  // `(` and after `, `, while a binary `&` keeps its spaces.
  explicitMutArg: `fn main(): i32 {\n    var x: i64 = 1\n    var v: Vec<i64> = []\n    g(&mut x, 2, &mut v)\n    let y = x & 3\n    return y\n}\n`,
  // A `{ }` pair on one source line is an inline group: every `{` used to force a
  // newline and every `}` a newline on both sides, so `take(P { x: 1 })` came out as
  // four lines with the `)` alone on the last. The line structure is the author's.
  inlineStructDecl: `struct P { x: i64, y: i64 }\n`,
  inlineStructLitArg: `fn main(): i32 {\n    take(P { x: 1, y: 2 })\n    let q = P { x: 1, y: 2 }\n    return 0\n}\n`,
  emptyFnBody: `fn take(p: P) {}\n`,
  inlineMatchArm: `fn f(o: Option<i64>): i64 {\n    match o {\n        Option.Some(n) => { return n }\n        Option.None => {}\n    }\n    return 0\n}\n`,
  inlineClosureArg: `fn main(): i32 {\n    let r = ap((n: i64) => { return n + 1 })\n    return r\n}\n`,
  // `fn` inside the group is a top-level keyword; the blank-line rule must not fire
  // inside a one-line trait.
  inlineTrait: `trait T { fn f(self: &Self): i64 }\n`,
  inlineIfElse: `fn f(x: bool): i64 {\n    if x { return 1 } else { return 2 }\n}\n`,
  // A multi-line block that closes a call argument or an array element hugs the
  // `)` / `,` after it (gofmt/prettier style) instead of dropping it on its own line.
  blockArgHugsParen: `fn main(): i32 {\n    take(P {\n        x: 1,\n        y: 2,\n    })\n    return 0\n}\n`,
  closureArgHugsParen: `fn main(): i32 {\n    arenaModify(&mut a, h, (n: DLNode) => {\n        n.x = 1\n        return n\n    })\n    return 0\n}\n`,
  blockInArrayHugsComma: `fn main(): i32 {\n    let v = [P {\n        x: 1,\n    }, P {\n        x: 2,\n    }]\n    return v.len\n}\n`,
  blockElse: `fn f(a: bool) {\n    if a {\n        b()\n    } else {\n        c()\n    }\n}\n`,
};

for (const [name, src] of Object.entries(cases)) {
  test(`${name}: canonical source is unchanged`, () => {
    expect(format(src, name)).toBe(src);
  }, 60000);

  test(`${name}: formatting is idempotent`, () => {
    const once = format(src, `${name}1`);
    expect(format(once, `${name}2`)).toBe(once);
  }, 60000);
}

test("extern keyword is never split from its declaration", () => {
  // The original bug: `struct` reads as a top-level item, so a blank line was pushed
  // between it and `extern`. Feed the mangled form and require it to be healed.
  const mangled = `extern\n\nstruct Foo {\n    a: i32,\n}\n`;
  expect(format(mangled, "healed")).toContain("extern struct Foo");
}, 60000);

test("a block closing a call argument heals `}\\n)` to `})`", () => {
  // The old output shape, committed into 170 example files: the `)` alone on a line.
  const mangled = `fn main(): i32 {\n    take(P {\n        x: 1, y: 2\n    }\n    )\n    return 0\n}\n`;
  const once = format(mangled, "hugParen1");
  expect(once).toBe(`fn main(): i32 {\n    take(P {\n        x: 1, y: 2\n    })\n    return 0\n}\n`);
  expect(format(once, "hugParen2")).toBe(once);
}, 60000);

test("`else` on its own source line rejoins its `}`", () => {
  // Used to come out as `} \nelse` (trailing space, then a bare `else` line): the `}`
  // case kept the line open but the source-newline rule broke it again.
  const mangled = `fn f(a: bool) {\n    if a {\n        b()\n    }\n    else {\n        c()\n    }\n}\n`;
  const once = format(mangled, "hugElse1");
  expect(once).toBe(`fn f(a: bool) {\n    if a {\n        b()\n    } else {\n        c()\n    }\n}\n`);
  expect(format(once, "hugElse2")).toBe(once);
}, 60000);
