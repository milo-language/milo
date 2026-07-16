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
});

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

test("single-statement inline block is unaffected", () => {
  // `if c { return 1 }` already expands (brace reflow); reflow must not corrupt it.
  const out = format(`fn f(c: bool): i32 {\n    if c { return 1 }\n    return 0\n}\n`);
  expect(out).toContain("if c {\n        return 1\n    }");
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
