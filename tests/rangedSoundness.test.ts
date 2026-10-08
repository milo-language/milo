// A ranged int (`i32(0..N)`) is an invariant, not a hint: no safe path may produce a value
// outside the range. The niche Option layout reads the first excluded value as `None`, so a
// path that leaks one turns a `Some` into a `None`. Each case tries one entry point with
// 2147483647 (the niche of `i32(0..2147483646)`) and must be stopped: a compile error for a
// constant or a type that would alias unchecked values, a range trap for a runtime value.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const dir = mkdtempSync(join(tmpdir(), "milo-rangesound-"));

const PRELUDE = `type R = i32(0..2147483646)
@derive(Json)
struct NodeId { at: R }
enum E { A(R), B }
struct S {}
impl S { fn take(self: &S, x: R): R { return x } }
struct SO { o: Option<R> }
fn big(): i32 { return 2147483647 }
fn one(): i32 { return 1 }
fn setI(x: &mut i32) { x = 2147483647 }
fn readR(x: &R): R { return x }
fn setR(x: &mut R) { x = 5 }
fn takeO(o: Option<R>): R { return o ?? 0 }
`;

function run(name: string, body: string): string {
  const file = join(dir, `${name}.milo`);
  writeFileSync(file, `${PRELUDE}fn main() {\n${body}\n}\n`);
  const r = spawnSync("bun", ["run", MAIN, "run", file], { cwd: ROOT, encoding: "utf-8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const TRAP = "value out of range";
const cases: [string, string, string][] = [
  ["struct literal field", `let n = NodeId { at: big() }\nprint(n.at)`, TRAP],
  ["struct literal constant", `let n = NodeId { at: 2147483647 }\nprint(n.at)`, "out of range for"],
  ["Some payload", `let o: Option<R> = Some(big())\nprint(o ?? 0)`, TRAP],
  ["auto-wrapped Option", `let o: Option<R> = big()\nprint(o ?? 0)`, TRAP],
  ["auto-wrapped Option arg", `print(takeO(big()))`, TRAP],
  ["enum payload", `let e = E.A(big())\nmatch e { E.A(x) => print(x), E.B => print(0) }`, TRAP],
  ["Vec.push", `var v: Vec<R> = Vec.new()\nv.push(big())\nprint(v[0])`, TRAP],
  ["Vec.insert", `var v: Vec<R> = Vec.new()\nv.insert(0, big())\nprint(v[0])`, TRAP],
  ["Vec literal", `let v: Vec<R> = [big()]\nprint(v[0])`, TRAP],
  ["HashMap.insert", `var m: HashMap<i32, R> = HashMap.new()\nm.insert(1, big())\nprint(m.get(1) ?? 0)`, TRAP],
  ["HashMap.getOrDefault", `let m: HashMap<i32, R> = HashMap.new()\nprint(m.getOrDefault(1, big()))`, TRAP],
  ["as cast", `let r = big() as R\nprint(r)`, TRAP],
  ["as cast from i64", `let x: i64 = 2147483647\nprint(x as R)`, TRAP],
  ["?? default", `let o: Option<R> = None\nlet r: R = o ?? big()\nprint(r)`, TRAP],
  ["wrappingAdd result", `let r: R = 2147483646\nlet w: R = r.wrappingAdd(1)\nprint(w)`, TRAP],
  ["checkedAdd result", `let r: R = 2147483646\nlet o: Option<R> = r.checkedAdd(1)\nprint(o ?? 0)`, "type mismatch"],
  // An operator's result keeps the width, not the range, unless propagation proves one.
  ["unary minus", `let r: R = 5\nlet o: Option<R> = Some(-r)\nprint(o ?? 0)`, TRAP],
  ["bitwise or", `let r: R = 2147483646\nlet o: Option<R> = Some(r | one())\nprint(o ?? 0)`, TRAP],
  ["add of unranged", `let r: R = 2147483646\nlet s = r + one()\nlet o: Option<R> = Some(s)\nprint(o ?? 0)`, TRAP],
  ["const operand", `let r: R = 0\nlet x: i32(-2147483646..2147483646) = r - 2147483647\nprint(x)`, TRAP],
  ["if branches", `let r: R = 1\nlet o: Option<R> = Some(if one() > 5 { r } else { big() })\nprint(o ?? 0)`, TRAP],
  ["if constant branch", `let r: R = 1\nlet o: Option<R> = Some(if one() > 5 { r } else { 2147483647 })\nprint(o ?? 0)`, TRAP],
  ["match arms", `let r: R = 1\nlet o: Option<R> = Some(match one() { 2 => r, _ => big() })\nprint(o ?? 0)`, TRAP],
  ["folded constant", `let n = NodeId { at: 2147483646 + 1 }\nprint(n.at)`, "out of range for"],
  ["unfoldable constant", `let n = NodeId { at: 2147483647 | 0 }\nprint(n.at)`, TRAP],
  ["method argument", `let s = S {}\nprint(s.take(big()))`, TRAP],
  // A decode is an error the caller handles, not a trap: the wire is untrusted input.
  ["Json decode", `match NodeId.fromJson("{\\"at\\": 2147483647}") { Result.Ok(n) => print(n.at), Result.Err(e) => print(e.message()) }`, "out-of-range number"],
  ["Json decode below", `match NodeId.fromJson("{\\"at\\": -1}") { Result.Ok(n) => print(n.at), Result.Err(e) => print(e.message()) }`, "out-of-range number"],
  ["&mut i32 borrowing an R", `var r: R = 1\nsetI(&mut r)\nprint(r)`, "ranges must match"],
  ["&R borrowing an i32", `let a: i32 = big()\nprint(readR(a))`, "ranges must fit"],
  ["&mut R borrowing an i32", `var a: i32 = big()\nsetR(&mut a)\nprint(a)`, "ranges must match"],
  ["Vec<i32> as Vec<R>", `let v: Vec<i32> = [big()]\nlet w: Vec<R> = v\nprint(w[0])`, "type mismatch"],
  ["Option<i32> as Option<R>", `let a: Option<i32> = Some(big())\nlet b: Option<R> = a\nprint(b ?? 0)`, "type mismatch"],
];

for (const [name, body, want] of cases) {
  test(`ranged int cannot leak via ${name}`, () => {
    expect(run(name.replace(/\W+/g, "_"), body)).toContain(want);
  });
}

// The checks do not reject the edges of the range.
test("ranged int edges pass every checked path", () => {
  const out = run("edges", `let hi: i32 = 2147483646
let n = NodeId { at: hi }
let o: Option<R> = Some(hi)
var v: Vec<R> = Vec.new()
v.push(hi)
v.push(0)
let c = 0 as R
print(n.at)
print(o ?? 0)
print(v[0] + v[1])
print(c)
print((hi as i64) as R)`);
  expect(out).toContain("2147483646\n2147483646\n2147483646\n0\n2147483646");
});
