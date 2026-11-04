// scripts/gen-programs.ts: the generator is deterministic and mostly accepted by the checker, and
// the runner's comparison notices each kind of disagreement. No compiled binaries here (the
// campaign itself is `bun scripts/gen-programs.ts`); the interpreter is the one pipeline run.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generate } from "../scripts/gen-programs-grammar";
import { checkSource, divergences, runAll, type Obs, type Outcome } from "../scripts/gen-programs";

const dir = mkdtempSync(join(tmpdir(), "milo-gen-test-"));
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);

test("same seed, same program; different seeds differ", () => {
  for (const s of SEEDS) expect(generate(s).src).toBe(generate(s).src);
  expect(new Set(SEEDS.map(s => generate(s).src)).size).toBe(SEEDS.length);
});

test("most generated programs pass the checker, and the accepted ones terminate in the interpreter", async () => {
  const ok = SEEDS.filter(s => checkSource(generate(s).src, join(dir, `g${s}.milo`)) === null);
  expect(ok.length).toBeGreaterThanOrEqual(6);
  const s = ok[0]!;
  const out = await runAll(join(dir, `g${s}.milo`), dir, ["interp"]);
  expect(out.interp.note).toBeNull();
  expect(out.interp.code).toBe(0);
}, 60_000);

test("a rejected program is reported with the checker's message", () => {
  expect(checkSource("fn main(): i32 {\n    let v: Vec<i64> = [1]\n    let w = v\n    print(v.len)\n    return 0\n}\n", join(dir, "bad.milo"))).toMatch(/moved/);
});

const obs = (o: Partial<Obs> = {}): Obs => ({ stdout: "x\n", code: 0, live: "0", note: null, ...o });
const outcome = (o: Partial<Outcome> = {}): Outcome => ({ interp: obs(), o0: obs(), asan: obs(), ...o });

test("divergences names each kind of disagreement", () => {
  expect(divergences(outcome())).toEqual([]);
  expect(divergences(outcome({ o0: obs({ stdout: "y\n" }) }))).toEqual(["stdout:o0"]);
  expect(divergences(outcome({ asan: obs({ code: 134 }) }))).toEqual(["exit:asan"]);
  expect(divergences(outcome({ o0: obs({ live: "3" }) }))).toEqual(["live:o0"]);
  expect(divergences(outcome({ asan: obs({ note: "ERROR: AddressSanitizer: heap-use-after-free" }) }))).toEqual(["asan-report:asan"]);
  expect(divergences(outcome({ o0: obs({ note: "build failed: boom" }) }))).toEqual(["build-failed:o0"]);
  expect(divergences(outcome({ interp: obs({ note: "stuck: interp: stuck at x" }) }))).toContain("interp-stuck");
  expect(divergences(outcome({ interp: obs({ note: "unsupported: interp: unsupported: x" }) }))).toEqual(["skip"]);
});

test("an interpreter-only run of a known program sees its stdout", async () => {
  const p = join(dir, "known.milo");
  writeFileSync(p, "fn main(): i32 {\n    print(\"hi\")\n    return 3\n}\n");
  const out = await runAll(p, dir, ["interp"]);
  expect(out.interp.stdout).toBe("hi\n");
  expect(out.interp.code).toBe(3);
}, 60_000);
