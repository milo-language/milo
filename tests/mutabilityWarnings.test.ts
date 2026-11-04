// `var-never-reassigned` and `unwritten-mut-param` (hard errors; src/checker-mutability.ts): what
// fires, what must not, and the exact text `milo fix` leaves (comments and layout intact,
// the result checks clean and prints what the original printed).
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const dir = mkdtempSync(join(tmpdir(), "milo-mut-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function milo(args: string[]) {
  return spawnSync("bun", ["run", MAIN, ...args], { encoding: "utf8" });
}

let n = 0;
function hits(src: string): { code: string; line: number; message: string }[] {
  const f = join(dir, `h${n++}.milo`);
  writeFileSync(f, src);
  const out = JSON.parse(milo(["check", f, "--json"]).stdout);
  return out.diagnostics
    .filter((d: any) => d.code === "var-never-reassigned" || d.code === "unwritten-mut-param")
    .map((d: any) => ({ code: d.code, line: d.line, message: d.message }));
}

function fixed(src: string): { text: string; run: string } {
  const f = join(dir, `f${n++}.milo`);
  writeFileSync(f, src);
  expect(milo(["fix", f]).status).toBe(0);
  const run = milo(["run", f]);
  expect(run.status, run.stderr).toBe(0);
  expect(milo(["fix", f]).stdout).toContain("0 fix(es) applied");
  return { text: readFileSync(f, "utf8"), run: run.stdout };
}

const lines = (...l: string[]) => l.join("\n") + "\n";

test("var never reassigned -> let, trailing comment survives", () => {
  const src = lines(
    "fn main() {",
    "    var x = 40 + 2 // the answer",
    "    print(x)",
    "}");
  expect(hits(src).map(h => h.code)).toEqual(["var-never-reassigned"]);
  expect(fixed(src)).toEqual({
    text: lines("fn main() {", "    let x = 40 + 2 // the answer", "    print(x)", "}"),
    run: "42\n",
  });
});

test("var reassigned in one branch only stays var", () => {
  expect(hits(lines(
    "fn main() {",
    "    var x = 1",
    "    if x > 0 { x = 2 }",
    "    print(x)",
    "}"))).toEqual([]);
});

test("var mutated through a method call stays var", () => {
  expect(hits(lines(
    "fn main() {",
    "    var v: Vec<i64> = Vec.new()",
    "    v.push(1)",
    "    print(v.len())",
    "}"))).toEqual([]);
});

test("compound assignment, field write, index write, and an iterator loop keep var", () => {
  expect(hits(lines(
    "struct P { x: i64 }",
    "fn main() {",
    "    var a = 1",
    "    a += 1",
    "    var p = P { x: 1 }",
    "    p.x = 2",
    "    var v: Vec<i64> = Vec.new()",
    "    v.push(1)",
    "    v[0] = 3",
    "    print(a + p.x + v[0])",
    "}"))).toEqual([]);
});

test("a var lent as &mut to a callee that writes stays var", () => {
  expect(hits(lines(
    "fn bump(n: &mut i64): void { n = n + 1 }",
    "fn main() {",
    "    var a = 1",
    "    bump(&mut a)",
    "    print(a)",
    "}"))).toEqual([]);
});

test("&mut param only read -> & and the call site loses &mut", () => {
  const src = lines(
    "// reads only",
    "fn peek(n: &mut i64): i64 {",
    "    return n + 1 // keep me",
    "}",
    "",
    "fn main() {",
    "    var a: i64 = 1",
    "    print(peek(&mut a))",
    "    a = 5",
    "    print(peek(&mut a))",
    "}");
  expect(hits(src).map(h => h.code)).toEqual(["unwritten-mut-param"]);
  expect(fixed(src)).toEqual({
    text: lines(
      "// reads only",
      "fn peek(n: &i64): i64 {",
      "    return n + 1 // keep me",
      "}",
      "",
      "fn main() {",
      "    var a: i64 = 1",
      "    print(peek(a))",
      "    a = 5",
      "    print(peek(a))",
      "}"),
    run: "2\n6\n",
  });
});

test("&mut param passed on to a callee's &mut stays", () => {
  const src = lines(
    "fn bump(n: &mut i64): void { n = n + 1 }",
    "fn fwd(n: &mut i64): void { bump(&mut n) }",
    "fn main() {",
    "    var a: i64 = 1",
    "    fwd(&mut a)",
    "    print(a)",
    "}");
  expect(hits(src)).toEqual([]);
});

test("a &mut param written through a method call or an index stays", () => {
  expect(hits(lines(
    "fn add(v: &mut Vec<i64>): void { v.push(1) }",
    "fn set(v: &mut Vec<i64>): void { v[0] = 2 }",
    "fn main() {",
    "    var v: Vec<i64> = Vec.new()",
    "    add(&mut v)",
    "    set(&mut v)",
    "    print(v.len())",
    "}"))).toEqual([]);
});

test("a pub fn keeps its &mut param", () => {
  expect(hits(lines(
    "pub fn peek(n: &mut i64): i64 { return n }",
    "fn main() {",
    "    var a: i64 = 1",
    "    print(peek(&mut a))",
    "    a = 2",
    "}"))).toEqual([]);
});

test("a chain of forwarders is peeled one link per fix round, and ends clean", () => {
  const { text, run } = fixed(lines(
    "fn leaf(n: &mut i64): i64 { return n }",
    "fn mid(n: &mut i64): i64 { return leaf(&mut n) }",
    "fn main() {",
    "    var a: i64 = 7",
    "    print(mid(&mut a))",
    "    a = 1",
    "}"));
  expect(text).toContain("fn leaf(n: &i64)");
  expect(text).toContain("fn mid(n: &i64)");
  expect(text).toContain("print(mid(a))");
  expect(run).toBe("7\n");
});

test("both are hard errors: severity error, check fails, --allow does not reach them, a fix is attached", () => {
  const srcs = [
    lines("fn main() {", "    var x = 1", "    print(x)", "}"),
    lines("fn show(n: &mut i64): void { print(n) }", "fn main() {", "    var a: i64 = 1", "    show(&mut a)", "    a = 2", "}"),
  ];
  for (const [i, src] of srcs.entries()) {
    const f = join(dir, `e${n++}.milo`);
    writeFileSync(f, src);
    const code = ["var-never-reassigned", "unwritten-mut-param"][i]!;
    for (const flags of [[], [`--allow=${code}`]]) {
      const r = milo(["check", f, "--json", ...flags]);
      expect(r.status).not.toBe(0);
      const d = JSON.parse(r.stdout).diagnostics.find((x: any) => x.code === code);
      expect(d.severity).toBe("error");
      expect(JSON.stringify(d)).toContain("fix");
    }
  }
});

test("a fn used as a value keeps its signature", () => {
  expect(hits(lines(
    "fn peek(n: &mut i64): i64 { return n }",
    "fn main() {",
    "    let f = peek",
    "    var a: i64 = 1",
    "    print(f(&mut a))",
    "    a = 2",
    "}")).filter(h => h.code === "unwritten-mut-param")).toEqual([]);
});
