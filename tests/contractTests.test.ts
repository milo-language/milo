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
