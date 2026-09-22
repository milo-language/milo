// `milo test --contracts`: property tests written by a fn's own requires/ensures
// (src/contract-tests.ts). The sample has one fn whose ensures is false, and the run must
// name it with refuting inputs; the honest fns must pass, including one whose requires
// names an exact string length the generator has to mine. std/string then runs for real:
// its contracts are the ones this feature tightened on its first sweep.
import { test, expect } from "bun:test";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const MILO = join(ROOT, "src", "main.ts");

function run(...files: string[]) {
  const r = Bun.spawnSync(["bun", "run", MILO, "test", "--contracts", "--json", ...files], { cwd: ROOT });
  const out = r.stdout.toString();
  const start = out.indexOf("{");
  return { code: r.exitCode, json: JSON.parse(out.slice(start)), stderr: r.stderr.toString() };
}

test("a false ensures is refuted with the inputs, honest contracts pass", () => {
  const { code, json } = run("tests/contracts/contractTestsSample.milo");
  expect(code).toBe(1);
  const byName = new Map<string, any>(json.tests.map((t: any) => [t.name, t]));
  expect([...byName.keys()].sort()).toEqual([
    "testContract_broken", "testContract_clampPct", "testContract_keyed", "testContract_lower",
  ]);
  expect(byName.get("testContract_clampPct").ok).toBe(true);
  expect(byName.get("testContract_lower").ok).toBe(true);
  expect(byName.get("testContract_keyed").ok).toBe(true);
  const broken = byName.get("testContract_broken");
  expect(broken.ok).toBe(false);
  expect(broken.output).toMatch(/ensures \(result >= a\) failed: a=\d+ b=\d+ result=-?\d+/);
});

test("std/string's contracts hold under drawn inputs", () => {
  const { code, json, stderr } = run("std/string.milo");
  expect({ code, failed: json.failed, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, failed: 0, stderr: "" });
  expect(json.passed).toBeGreaterThanOrEqual(9);
});

test("a struct param is built by its constructor, and the refutation names the ctor args", () => {
  const { code, json } = run("tests/contracts/contractTestsStructs.milo");
  expect(code).toBe(1);
  const byName = new Map<string, any>(json.tests.map((t: any) => [t.name, t]));
  expect([...byName.keys()].sort()).toEqual([
    "testContract_counterBump", "testContract_counterDrained", "testContract_counterLimit",
    "testContract_counterNew", "testContract_sealedNew", "testContract_sealedStamp",
    "testContract_vecClamp",
  ]);
  // `&mut Counter` and `&mut Vec<i64>` both run, and their honest contracts hold.
  expect(byName.get("testContract_counterBump").ok).toBe(true);
  expect(byName.get("testContract_vecClamp").ok).toBe(true);
  // A struct has no Display: the message carries the constructor call and the drawn
  // sequence of mutator calls that together rebuild the state.
  const lying = byName.get("testContract_counterLimit");
  expect(lying.ok).toBe(false);
  expect(lying.output).toMatch(
    /ensures \(result < 0\) failed: c=counterNew\(limit=\d+\)( then( counterBump\(c, n=-?\d+\))+)? result=\d+/);
  // `hits > 0` is a state only counterBump reaches, so the drawn sequence is what makes
  // this test run at all: it must run real cases, not report unreachable.
  const sequenced = byName.get("testContract_counterDrained");
  expect({ ok: sequenced.ok, unreachable: sequenced.unreachable ?? false }).toEqual({ ok: true, unreachable: false });
  // A precondition neither the constructor nor any drawn sequence establishes is not a
  // pass and not a defect: Sealed has no mutator at all, so the harness says so and skips.
  const unreachable = byName.get("testContract_sealedStamp");
  expect(unreachable.unreachable).toBe(true);
  expect(unreachable.output).toMatch(/no constructed value satisfied requires.*construction of s.*declares none/);
  expect(json.unreachable).toBe(1);
});

test("a drawn sequence only ever makes a call whose own requires holds", () => {
  // The rule that keeps every reached state reachable: a mutator drawn with arguments its
  // own `requires` rejects is skipped and the rest of the sequence still runs. `neverBump`
  // can never be called, so it must appear in no refutation's plan, while the sequence it
  // was drawn into still reaches `hits > 0`.
  const { code, json } = run("tests/contracts/contractTestsSkipMutator.milo");
  expect(code).toBe(1);
  const byName = new Map<string, any>(json.tests.map((t: any) => [t.name, t]));
  const lying = byName.get("testContract_gaugeLies");
  expect(lying.ok).toBe(false);
  expect(lying.output).toContain("gaugeBump(g");
  expect(lying.output).not.toContain("neverBump");
});

test("an unsatisfiable requires over scalars stays a hard failure, not a skip", () => {
  // The skip above is scoped to constructed values. When the draw space IS the type,
  // nothing satisfying the requires means the contract is unsatisfiable, and turning that
  // into a skip would be the gate quietly giving up.
  const { code, json } = run("tests/contracts/contractTestsVacuous.milo");
  expect(code).toBe(1);
  const t = json.tests[0];
  expect({ name: t.name, ok: t.ok, unreachable: t.unreachable ?? false })
    .toEqual({ name: "testContract_neverCallable", ok: false, unreachable: false });
  expect(t.output).toMatch(/no drawn input satisfied requires/);
});

test("a file with its own `fn main` is swept; the harness moves that main aside", () => {
  const { code, json } = run("tests/contracts/contractTestsWithMain.milo");
  expect({ code, failed: json.failed, compileErrors: json.compileErrors }).toEqual({
    code: 0, failed: 0, compileErrors: [],
  });
  expect(json.tests.map((t: any) => t.name)).toEqual(["testContract_clampTo"]);
});

test("a file that will not compile is reported without aborting the rest of the sweep", () => {
  const { code, json } = run(
    "tests/contracts/contractTestsUncompilable.milo",
    "tests/contracts/contractTestsWithMain.milo",
  );
  expect(code).toBe(1);
  expect(json.compileErrors.map((c: any) => c.file)).toEqual([
    "tests/contracts/contractTestsUncompilable.milo",
  ]);
  // The point of the test: the file AFTER the broken one still ran.
  expect(json.tests.map((t: any) => t.name)).toEqual(["testContract_clampTo"]);
  expect(json.passed).toBe(1);
});
