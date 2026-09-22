// Formatter behavior tests. `bin/milo-fmt` (built from examples/cli-tools/fmt.milo)
// is the sole formatter — the same binary `milo fmt` and the LSP use. These tests
// drive it directly so they cover the source of truth, not a reference impl.
import { test, expect, beforeAll } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";

const root = resolve(__dirname, "..");
const fmtBin = resolve(root, "bin", "milo-fmt");

beforeAll(() => {
  // Always rebuild. This used to `return` when the binary merely existed, so the tests
  // ran whatever stale bin/milo-fmt was lying around — editing fmt.milo left them green
  // while testing the OLD formatter. bin/milo-fmt is gitignored and rebuilt only on
  // demand, so "exists" says nothing about "current". ~400ms, once.
  const build = spawnSync(process.execPath, [
    resolve(root, "src", "main.ts"), "build",
    resolve(root, "examples", "cli-tools", "fmt.milo"), "-o", fmtBin,
  ], { encoding: "utf-8" });
  if (build.status !== 0 || !existsSync(fmtBin)) throw new Error(build.stderr || "could not build bin/milo-fmt");
// spawnSync re-transpiles src/main.ts and then compiles fmt.milo; on a loaded CI runner
// that exceeds bun's 5s default hook budget and fails with an empty-stderr timeout that
// looks like a build error but isn't. Give it room.
}, 120000);

// Format via the native binary reading stdin (same path the LSP uses).
function format(source: string): string {
  const r = spawnSync(fmtBin, [], { input: source, encoding: "utf-8", timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || "milo-fmt failed");
  return r.stdout;
}

test("extern fn stays on one line even when source splits them", () => {
  const src = `extern

fn read(fd: i32, buf: *u8, nbyte: i64): i64

extern
fn close(fd: i32): i32

extern fn open(path: *u8, flags: i32): i32
`;
  const out = format(src);
  expect(out).toContain("extern fn read(");
  expect(out).toContain("extern fn close(");
  expect(out).toContain("extern fn open(");
  // no `extern` left dangling on its own line before an fn
  expect(out).not.toMatch(/extern\s*\n\s*(\n\s*)?fn\b/);
});

test("formatting is idempotent for extern blocks", () => {
  const src = `extern

fn read(fd: i32): i64
`;
  const once = format(src);
  expect(format(once)).toBe(once);
});

// Reflow: the formatter owns line breaks structurally rather than copying source
// line breaks. It splits multiple statements sharing a line and collapses param /
// arg / array lists that were split across lines.

test("multiple statements on one line are split", () => {
  const out = format(`fn f(): i32 {\n    let a = 1 let b = 2 a = b\n    return a\n}\n`);
  expect(out).toContain("    let a = 1\n");
  expect(out).toContain("    let b = 2\n");
  expect(out).toContain("    a = b\n");
});

test("statement after a call/index on the same line is split", () => {
  const out = format(`fn f(cpu: &mut Cpu): void {\n    let v = read(cpu) cpu.a = v setZN(cpu, v)\n}\n`);
  expect(out).toContain("    let v = read(cpu)\n");
  expect(out).toContain("    cpu.a = v\n");
  expect(out).toContain("    setZN(cpu, v)\n");
});

test("a param list split across source lines collapses onto one line", () => {
  const out = format(`fn aImm(\ncpu: &mut Cpu\n): u16 {\n    return 0\n}\n`);
  expect(out).toContain("fn aImm(cpu: &mut Cpu): u16 {");
});

test("params broken mid-declaration collapse with correct spacing", () => {
  const out = format(`fn aZp(cpu:\n&mut Cpu, bus: &mut Bus): u16 {\n    return 0\n}\n`);
  expect(out).toContain("fn aZp(cpu: &mut Cpu, bus: &mut Bus): u16 {");
});

test("an if-expression after `=` is not mistaken for a new statement", () => {
  const out = format(`fn f(c: bool): i32 {\n    let a = if c { 1 } else { 2 }\n    return a\n}\n`);
  expect(out).toContain("let a = if c {");
  expect(out).not.toContain("let a =\n");
});

test("keyword operators (as/in/mut) don't trigger a statement split", () => {
  const out = format(`fn f(v: i32): i64 {\n    let x = v as i64\n    return x\n}\n`);
  expect(out).toContain("let x = v as i64");
});

test("comments inside an array literal are never swallowed by reflow", () => {
  // A `//` comment runs to EOL; collapsing the following newline would glue the
  // next element into the comment text and corrupt the token stream.
  const src = `fn f(): void {\n    let p = [\n    0xA9, // LDA\n    0x0C, // imm\n    ]\n}\n`;
  const out = format(src);
  expect(out).toContain("0xA9, // LDA\n");
  expect(out).toContain("0x0C, // imm\n");
  expect(out).not.toMatch(/LDA0x0C/);
});

test("a closure body inside a call still reflows as its own block", () => {
  const out = format(`fn f(): void {\n    run(|| {\n    let a = 1 let b = 2\n    })\n}\n`);
  expect(out).toContain("let a = 1\n");
  expect(out).toContain("let b = 2\n");
});

test("an attribute attaches to its decl (no blank between, name hugs @)", () => {
  const out = format(`// doc for handle\n@ derive(Eq)\nstruct Handle {\n    index: i32,\n}\n`);
  // doc, attribute, and struct stay contiguous; the blank goes above the doc, not
  // between the attribute and the struct. The name hugs `@` → `@derive`, not `@ derive`.
  expect(out).toContain("// doc for handle\n@derive(Eq)\nstruct Handle {");
  expect(out).not.toMatch(/@derive\(Eq\)\n\nstruct/);
  // idempotent
  expect(format(out)).toBe(out);
});

test("single-statement inline block stays inline", () => {
  // A one-line brace group is kept inline (commit 90eba160); reflow must not
  // explode it or glue the next statement onto it.
  const out = format(`fn f(c: bool): i32 {\n    if c { return 1 }\n    return 0\n}\n`);
  expect(out).toContain("if c { return 1 }\n    return 0\n");
  expect(format(out)).toBe(out);
});

// Regressions: each of these used to emit source that no longer lexes/parses,
// or that silently changed meaning. Guard with the token-stream property below.

test("f-strings survive formatting", () => {
  const src = `fn main(): i32 {\n    print($"fib({n}) = {r}")\n    return 0\n}\n`;
  expect(format(src)).toContain(`print($"fib({n}) = {r}")`);
});

test("nested f-strings and escaped braces survive formatting", () => {
  const src = `fn main(): i32 {\n    print($" {bold($"File: {p}")}")\n    print($"\\{literal}")\n    return 0\n}\n`;
  const out = format(src);
  expect(out).toContain(`$" {bold($"File: {p}")}"`);
  expect(out).toContain(`$"\\{literal}"`);
});

test("shift operators stay glued (<< and >> are adjacency-lexed)", () => {
  const src = `fn f(hi: i64, lo: i64): i64 {\n    return (hi << 4) | (lo >> 2)\n}\n`;
  const out = format(src);
  expect(out).toContain("hi << 4");
  expect(out).toContain("lo >> 2");
  expect(out).not.toMatch(/<\s+</);
  expect(out).not.toMatch(/>\s+>/);
});

// A fn type as a type argument is the one generic whose interior is not type-like
// tokens: `Vec<(i64) => i64>` opens with a paren, which stopped isGenericOpen's scan
// and left the brackets classified as comparisons. The result still parsed, so nothing
// failed loudly — it just spaced out as `Vec < (i64) => i64 >`, and the pre-commit hook
// wrote that back into std/http.milo and a fixture. The other half has to keep holding:
// a genuine `<` before a parenthesised expression is still a comparison.
test("a fn type used as a generic argument keeps its brackets glued", () => {
  const src = `fn apply(fs: Vec<(i64) => i64>, x: i64): i64 {\n    return x\n}\n`;
  const out = format(src);
  expect(out).toContain("Vec<(i64) => i64>");
  expect(out).not.toMatch(/Vec\s+</);
  expect(format(out)).toBe(out);
});

test("a comparison against a parenthesised expression is still spaced", () => {
  const src = `fn f(x: i64, y: i64): bool {\n    return x < (y + 1) && y > (x)\n}\n`;
  const out = format(src);
  expect(out).toContain("x < (y + 1)");
  expect(out).toContain("y > (x)");
});

// `move` marks an owning closure in TYPE position too (`f: move () => void`), and the
// formatter has to tell that from the closure EXPRESSION it shares a keyword with. It is
// not in this formatter's keyword list, so without a rule the type came out `move() =>
// void`, which reads as a call. Only the tail distinguishes them: a type's parens hold
// bare types and are followed straight by `=>`; a closure's hold params (with `:`) or
// carry `: ret` before the arrow, or open a `{` body after it.
test("a move-closure TYPE keeps its space", () => {
  const src = `fn run(f: move () => void): void {\n    f()\n}\n`;
  const out = format(src);
  expect(out).toContain("move () => void");
  expect(format(out)).toBe(out);
});

test("a move-closure EXPRESSION does not gain one", () => {
  const src = `fn main(): void {\n    let f = move(x: i64) => x + 1\n    print(f(1))\n}\n`;
  const out = format(src);
  expect(out).toContain("move(x: i64) => x + 1");
  expect(out).not.toContain("move (x: i64)");
});

test("a move-closure expression with a block body does not gain one", () => {
  const src = `fn main(): void {\n    let f = move(): void => {\n        print(1)\n    }\n    f()\n}\n`;
  const out = format(src);
  expect(out).toContain("move(): void =>");
  expect(out).not.toContain("move ():");
});

test("`extern type` and `move` keywords keep a trailing space", () => {
  expect(format(`extern type Opaque\n`)).toContain("extern type Opaque");
  expect(format(`fn f(): i32 {\n    let g = move || 1\n    return 0\n}\n`)).toContain("move ||");
});

test("prefix operators hug their operand after a keyword", () => {
  const out = format(`fn f(t: i32): i32 {\n    match *t {\n        A => 1,\n    }\n}\n`);
  expect(out).toContain("match *t");
  // binary uses still get spaces
  expect(format(`fn f(a: i64, b: i64): i64 {\n    return a * b - a\n}\n`)).toContain("a * b - a");
});

test("output ends with exactly one newline", () => {
  for (const src of [`fn main(): i32 {\n    return 0\n}\n`, `fn main(): i32 {\n    return 0\n}\n\n\n`]) {
    const out = format(src);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  }
});

test("cosmetic ';' is stripped but '[T; N]' is preserved", () => {
  const out = format(`fn main(): i32 {\n    let a: [i32; 3] = [1, 2, 3]\n    print(a.len);\n    return 0;\n}\n`);
  expect(out).toContain("i32;");           // array-type ';' kept (spacing is impl-defined)
  expect(out).toContain("print(a.len)\n"); // trailing ';' dropped
  expect(out).toContain("return 0\n");
  expect(out).not.toContain("a.len);");
});

test("method-chain continuation lines indent one level past the statement", () => {
  const out = format(
    `fn f() {\n    let msg = a().int("seq", 1).str("type", "x")\n    .int("rs", 2).bool("ok", true)\n    .build()\n    g(msg)\n}\n`);
  // leading-`.` lines get 8 spaces (2 levels): 1 for the fn body + 1 continuation
  expect(out).toContain(`\n        .int("rs", 2)`);
  expect(out).toContain(`\n        .build()`);
  // the statement itself and the following stmt stay at body indent (4 spaces)
  expect(out).toContain(`\n    let msg = a()`);
  expect(out).toContain(`\n    g(msg)`);
  expect(format(out)).toBe(out); // fixed point
});

// `unsafe` is a keyword, so `@unsafe` does not arrive as an Ident the way every other
// attribute name does. The formatter is a SEPARATE implementation (examples/cli-tools/
// fmt.milo has its own lexer), so a compiler that accepts the spelling proves nothing
// about the tool that rewrites every file in the repo.
test("@unsafe survives formatting like any other attribute", () => {
  const src = `@unsafe
pub fn peek(p: *i64): i64 {
    unsafe {
        return p[0]
    }
}
`;
  const out = format(src);
  expect(out).toContain("@unsafe");
  expect(out).toBe(src);
  expect(format(out)).toBe(out); // fixed point
});

// Property test over the whole repo: formatting must never change the token
// stream (whitespace-only, apart from dropping cosmetic ';'), and must be a fixed
// point. This is what makes a format-on-commit hook safe. ';' is excluded from the
// signature because Milo treats a statement-level ';' as cosmetic and the formatter
// strips it; `[T; N]` correctness is covered by tests/fixtures.
test("formatting preserves the token stream and is idempotent, repo-wide", () => {
  const { Lexer } = require("../src/lexer");
  const { readFileSync } = require("fs");
  const { execSync } = require("child_process");
  const root = require("path").resolve(__dirname, "..");
  const files = execSync("git ls-files '*.milo'", { cwd: root, encoding: "utf-8" })
    .trim().split("\n").map((f: string) => `${root}/${f}`);
  expect(files.length).toBeGreaterThan(100);

  const sig = (s: string) => new Lexer(s).tokenize().filter((t: any) => t.kind !== ";").map((t: any) => `${t.kind} ${t.value}`).join("");
  const tokenChanged: string[] = [], notIdempotent: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    let before: string;
    try { before = sig(src); } catch { continue; } // deliberately unlexable fixture
    const once = format(src);
    if (sig(once) !== before) tokenChanged.push(f);
    if (format(once) !== once) notIdempotent.push(f);
  }
  expect(tokenChanged).toEqual([]);
  expect(notIdempotent).toEqual([]);
}, 120_000); // spawns bin/milo-fmt twice per repo file (~200) — far past the 5s default

// `requires`/`ensures`/`invariant`/`decreases` are keywords to the compiler but plain
// idents to the formatter's own lexer, so the rule that hugs a call's parens rewrote
// `requires (a + b) < 10` into `requires(a + b) < 10`: still valid, and reads as a call to
// a fn named `requires`. Surfaced by a real contract, `std/sort.milo::qsortI32`.
test("a contract keyword keeps its space before a parenthesised expression", () => {
  const out = format(`fn f(a: i64, b: i64): i64
requires (a + b) < 10
ensures (result) >= 0
{
    return a + b
}
`);
  expect(out).toContain("requires (a + b) < 10");
  expect(out).toContain("ensures (result) >= 0");
  expect(out).not.toContain("requires(");
  expect(out).not.toContain("ensures(");
});

test("a call still hugs its parens", () => {
  const out = format(`fn g(): i64 {
    return h(1)
}
`);
  expect(out).toContain("h(1)");
});
