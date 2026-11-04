// The reference interpreter (src/interp.ts) against docs/semantics/mini-milo.md: small programs
// whose output pins one rule each (move, field move, drop order, &mut write-back, temporaries),
// a program the checker would reject run anyway to see it get stuck, and the golden comparison
// (scripts/interp-vs-golden.ts) over a slice of the fixtures.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { Interp } from "../src/interp";
import { InterpStuck } from "../src/interp-values";
import type { Program } from "../src/ast";
import { compareOne } from "../scripts/interp-vs-golden";

const dir = mkdtempSync(join(tmpdir(), "milo-interp-test-"));
let n = 0;
function check(src: string): { program: Program; interp: Interp } {
  const path = join(dir, `t${n++}.milo`);
  writeFileSync(path, src);
  const tokens = new Lexer(src).tokenize();
  const parsed = new Parser(tokens, src, path).parse();
  const program = resolveImports(parsed, dirname(path), getHostTarget(), path);
  const result = new TypeChecker().check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  if (errors.length) throw new Error(`checker rejected the test program: ${errors.map(e => e.message).join("; ")}`);
  return { program, interp: new Interp(program, result) };
}
const run = (src: string) => {
  const r = check(src).interp.run();
  return { out: new TextDecoder().decode(r.stdout), code: r.code, live: r.live };
};

const NOISY = `
struct Noisy { id: i64 }
impl Drop for Noisy {
    fn drop(self: &mut Self) { print("drop ", self.id) }
}
fn mk(id: i64): Noisy { return Noisy { id: id } }
`;

test("E-MOVE: a moved Vec is dropped once, by its new owner, and no block leaks", () => {
  const r = run(`
fn len(v: Vec<i64>): i64 { return v.len }
fn main() {
    var v: Vec<i64> = [1, 2, 3]
    v.push(4)
    let w = v
    print(len(w))
}`);
  expect(r.out).toBe("4\n");
  expect(r.live).toBe(0);
});

test("E-FIELD-MOVE: moving one field leaves the other to drop with its struct", () => {
  const r = run(`${NOISY}
struct Pair { a: Noisy, b: Noisy }
fn take(n: Noisy) { print("took ", n.id) }
fn main() {
    let p = Pair { a: mk(1), b: mk(2) }
    take(p.a)
    print("end")
}`);
  expect(r.out).toBe("took 1\ndrop 1\nend\ndrop 2\n");
});

test("S-SCOPE-END: variables drop in reverse declaration order, fields last first", () => {
  const r = run(`${NOISY}
struct Pair { a: Noisy, b: Noisy }
fn main() {
    let x = mk(1)
    let p = Pair { a: mk(2), b: mk(3) }
    let y = mk(4)
    print("end")
}`);
  expect(r.out).toBe("end\ndrop 4\ndrop 3\ndrop 2\ndrop 1\n");
});

test("S-ASSIGN-REF: a write through &mut lands in the caller's slot, and S-ASSIGN drops the old value", () => {
  const r = run(`${NOISY}
fn bump(n: &mut Noisy, to: i64) { n.id = to }
fn swapIn(n: &mut Noisy) { n = mk(9) }
fn main() {
    var a = mk(1)
    bump(&mut a, 5)
    print(a.id)
    swapIn(&mut a)
    print(a.id)
}`);
  expect(r.out).toBe("5\ndrop 5\n9\ndrop 9\n");
});

test("S-TEMP-CALL: a temporary lent to a by-ref parameter dies when the call returns", () => {
  const r = run(`${NOISY}
fn peek(n: &Noisy): i64 { return n.id * 2 }
fn main() {
    print("got ", peek(mk(7)))
}`);
  expect(r.out).toBe("drop 7\ngot 14\n");
});

test("panics exit 134 and run no drops", () => {
  const r = run(`${NOISY}
fn main() {
    let n = mk(1)
    let v: Vec<i64> = [1]
    print(v[3])
}`);
  expect(r.code).toBe(134);
  expect(r.out).toBe("");
  expect(r.live).toBeNull();
});

test("E-STUCK: reading a moved variable stops the run, naming the rule", () => {
  // The checker rejects this program, so take a valid one and aim a read at the moved slot.
  const { program, interp } = check(`
fn main() {
    let s = "a" + "b"
    let t = s
    print(t)
}`);
  const main = program.functions.find(f => f.name === "main")!;
  const printCall = (main.body[2] as { expr: { args: { name: string }[] } }).expr;
  printCall.args[0]!.name = "s";
  let rule = "";
  try { interp.run(); } catch (e) { rule = (e as InterpStuck).rule; }
  expect(rule).toBe("E-STUCK");
});

// Fixtures the interpreter must run exactly as the compiled golden does (stdout, exit, live blocks).
const FIXTURES = [
  "arithmetic", "arrayCombinators", "closureCapture", "enumMatch", "forLoop", "structs", "stringOps", "vecBasics",
  "optionBasics", "resultPropagate", "ownershipMove", "whileLoop", "recursion", "nestedStructs", "stringInterp",
  "dropOrder", "shadowing", "floatMath", "matchLiteral", "genericsBasic",
];
test("interp-vs-golden: a slice of the fixtures is the same as the compiled run", async () => {
  const results = [];
  for (const name of FIXTURES) results.push(await compareOne({ path: join(import.meta.dir, "fixtures", `${name}.milo`), name, kind: "fixtures" }, dir));
  const bad = results.filter(r => r.verdict !== "same");
  expect(bad.map(r => `${r.name}: ${r.verdict} ${r.detail}`)).toEqual([]);
}, 120_000);
