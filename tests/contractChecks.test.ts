// `--contract-checks`: requires/ensures/invariant assert at ANY optimization level,
// independently of `--overflow-checks`.
//
// The two used to be one switch, so `--overflow-checks` silently turned contract asserts
// on and `--no-overflow-checks` silently turned them off. They answer different questions
// — what the machine does to your arithmetic vs a claim you wrote down — so the pairing
// is asserted in BOTH directions here: a release build with only `--overflow-checks` must
// NOT assert contracts, and a debug build with `--no-overflow-checks` must still do so.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";

// randRange keeps the argument out of reach of constant folding — a literal -1 is a
// compile error at every -O, which would test the checker instead of the codegen gate.
const SRC = `from "std/random" import { Random }

pub fn takesNonNegative(n: i64): i64
requires n >= 0
{
    return n
}

fn main(): i32 {
    print(takesNonNegative(-1 * Random.range(1, 2)))
    return 0
}
`;

// `old(e)` reads a value that no longer exists by the time the clause runs, so a debug
// build has to snapshot it at entry. Separate file: this one must RUN, not abort, so the
// pass/fail signal isn't confused with the `requires` violation above.
const OLD_SRC = `from "std/random" import { Random }

fn bump(n: &mut i64, by: i64): void
ensures n == old(n) + by
{
    n = n + by
}

fn drift(n: &mut i64, by: i64): void
ensures n == old(n) + by
{
    n = n + by + 1
}

fn main(): i32 {
    // Random.range(1, 1) is deterministically 1 yet still opaque to the prover (an
    // arc4random call it can't see through), so the ensures becomes a runtime check
    // rather than a compile-time proof — and the printed value is stable. randRange is
    // an INCLUSIVE [min, max] range, so Random.range(1, 2) would be 1 or 2 and this test
    // would flake between printing 11 and 12.
    var a: i64 = Random.range(1, 1)
    bump(&mut a, 10)
    print(a)
    var b: i64 = Random.range(1, 1)
    drift(&mut b, 10)
    print(b)
    return 0
}
`;

// A for-in invariant asserts at the top of every iteration. Nothing else in the suite
// exercises the for-loop arm of emitLoopInvariants, and the while arm is a different
// code path in codegen.
const FORIN_SRC = `from "std/random" import { Random }

fn main(): i32 {
    var total: i64 = 0
    for i in 0..Random.range(3, 4)
    invariant total < 2
    {
        total = total + 1
    }
    print(total)
    return 0
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-contract-"));
  writeFileSync(join(dir, "contract.milo"), SRC);
  writeFileSync(join(dir, "old.milo"), OLD_SRC);
  writeFileSync(join(dir, "forin.milo"), FORIN_SRC);
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function build(out: string, extra: string[], src = "contract.milo") {
  execFileSync("bun", ["run", MAIN, "build", join(dir, src), "-o", join(dir, out), ...extra],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
}

function emitIr(extra: string[]): string {
  return execFileSync("bun", ["run", MAIN, "emit-ir", join(dir, "contract.milo"), ...extra],
    { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function run(bin: string): { out: string; code: number } {
  try {
    return { out: execFileSync(join(dir, bin), { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("release build drops contract asserts by default", () => {
  build("rel", ["--release"]);
  const r = run("rel");
  expect(r.code).toBe(0);
}, 120000);

test("--contract-checks asserts in a release build", () => {
  build("relChecked", ["--release", "--contract-checks"]);
  const r = run("relChecked");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("requires clause violated");
}, 120000);

test("--no-contract-checks drops the asserts in a debug build", () => {
  build("dbgUnchecked", ["--debug", "--no-contract-checks"]);
  const r = run("dbgUnchecked");
  expect(r.code).toBe(0);
}, 120000);

test("--overflow-checks alone does not turn contract asserts on", () => {
  build("relOvf", ["--release", "--overflow-checks"]);
  const r = run("relOvf");
  expect(r.code).toBe(0);
}, 120000);

test("--no-overflow-checks alone does not turn contract asserts off", () => {
  build("dbgNoOvf", ["--debug", "--no-overflow-checks"]);
  const r = run("dbgNoOvf");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("requires clause violated");
}, 120000);

test("emit-ir honors explicit contract-check settings", () => {
  const checked = emitIr(["--release", "--contract-checks"]);
  const unchecked = emitIr(["--release", "--no-contract-checks"]);
  expect(checked).toContain("@.contract_err");
  expect(unchecked).not.toContain("@.contract_err");
  expect(checked).not.toBe(unchecked);
}, 120000);

test("emit-ir honors explicit overflow-check settings", () => {
  const checked = emitIr(["--release", "--overflow-checks", "--no-contract-checks"]);
  const unchecked = emitIr(["--release", "--no-overflow-checks", "--no-contract-checks"]);
  expect(checked).toContain("llvm.smul.with.overflow.i64");
  expect(unchecked).not.toContain("llvm.smul.with.overflow.i64");
}, 120000);

test("old() snapshots the entry value in a contract-checking build", () => {
  build("oldChecked", ["--debug"], "old.milo");
  const r = run("oldChecked");
  // `drift` adds one more than it promised, so the FIRST ensures passes and the second
  // aborts — proving the snapshot is a real pre-state and not just the current value
  // under another name, which would make both clauses trivially true.
  expect(r.out).toContain("11");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("ensures clause violated");
}, 120000);

test("old() costs nothing when contracts are not checked", () => {
  build("oldRelease", ["--release"], "old.milo");
  const r = run("oldRelease");
  expect(r.code).toBe(0);
  const ir = execFileSync("bun", ["run", MAIN, "emit-ir", join(dir, "old.milo"), "--release"],
    { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  expect(ir).not.toContain("contract_kind_ensures");
}, 120000);

test("a for-in invariant asserts on each iteration", () => {
  build("forinChecked", ["--debug"], "forin.milo");
  const r = run("forinChecked");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("invariant clause violated");
}, 120000);
