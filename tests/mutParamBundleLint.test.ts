// Gate on the mut-param-bundle census. A free fn with three or more `&mut` parameters
// is a struct's method with the struct un-bundled: every `&mut` argument is spelled at
// the call site except a method receiver, so each caller is a row of same-typed markers
// that can be swapped silently. OFF by default (about 41 hits in tree at the time it
// shipped), opted into with `--deny=mut-param-bundle`.
//
// Driven through the CLI because the evidence suffix reads every resolved call site of
// the fn, which only a whole-program check can establish.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const MILO_ROOT = join(import.meta.dir, "..");
const FIXTURE = join(MILO_ROOT, "tests/fixtures/mutParamBundle.milo");

function diagnosticsFor(...flags: string[]): { code: string; message: string; hint?: string; line: number }[] {
  const r = spawnSync("bun", [join(MILO_ROOT, "src/main.ts"), "check", FIXTURE, "--json", ...flags], {
    cwd: MILO_ROOT, encoding: "utf-8", timeout: 180_000,
  });
  return JSON.parse(r.stdout).diagnostics ?? [];
}

test("a fn whose callers all pass the same variables reports them as travelling together", () => {
  const hits = diagnosticsFor("--deny=mut-param-bundle").filter(d => d.code === "mut-param-bundle");
  const step = hits.find(d => d.message.startsWith("fn stepState "));
  expect(step?.message).toBe("fn stepState threads 3 &mut parameters; the same 3 variables travel together at all 2 call sites");
  expect(step?.hint).toBe("bundle them in a struct and make stepState a method on it: a receiver needs no &mut marker at call sites, and named fields cannot be passed in the wrong order");
  // At the fn's name, not at a call site.
  expect(step?.line).toBe(13);
});

test("a fn whose callers pass different locals gets the base message only", () => {
  const hits = diagnosticsFor("--deny=mut-param-bundle").filter(d => d.code === "mut-param-bundle");
  const fill = hits.find(d => d.message.startsWith("fn fillOut "));
  expect(fill?.message).toBe("fn fillOut threads 3 &mut parameters");
});

test("two &mut params is under the threshold, and an impl method is never a subject", () => {
  // `Counter.step` carries `&mut self` plus three `&mut` params: a receiver already
  // bundles, so the method is exactly what the hint asks for.
  const hits = diagnosticsFor("--deny=mut-param-bundle").filter(d => d.code === "mut-param-bundle");
  expect(hits.map(d => d.message.split(" ")[1]).sort()).toEqual(["fillOut", "stepState"]);
});

test("off by default: the fixture checks clean without the flag", () => {
  expect(diagnosticsFor()).toEqual([]);
});
