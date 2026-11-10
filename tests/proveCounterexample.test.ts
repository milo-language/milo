// A `failed` verdict from `milo prove` carries the solver's witness. The values differ
// between z3 versions, so nothing here pins them: each witness is plugged back into the
// function it refutes and must satisfy the `requires` and break the `ensures`.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "prove", "counterexampleValues.milo");

type Obligation = { fn: string; kind: string; status: string; detail?: string; counterexample?: Record<string, string> };

function prove(): Obligation[] {
  const r = spawnSync("bun", ["run", join(ROOT, "src", "main.ts"), "prove", FIXTURE, "--json"], { encoding: "utf-8", env: { ...process.env, MILO_ROOT: ROOT } });
  return JSON.parse(r.stdout).obligations;
}

function witness(obs: Obligation[], fn: string): Record<string, string> {
  const o = obs.find(x => x.fn === fn && x.kind === "postcondition");
  expect(o?.status, `${fn} postcondition`).toBe("failed");
  expect(o!.counterexample, `${fn} has no counterexample values: ${o!.detail}`).toBeDefined();
  // The text report and the JSON come from the same pairs.
  expect(o!.detail).toBe("counterexample: " + Object.entries(o!.counterexample!).map(([n, v]) => `${n} = ${v}`).join(", "));
  return o!.counterexample!;
}

const ratio = (s: string) => { const [a, b] = s.split("/"); return b === undefined ? Number(a) : Number(a) / Number(b); };

test("prove counterexamples refute the contract they are reported against", () => {
  const obs = prove();

  const c = witness(obs, "clamp");
  expect(Object.keys(c)).toEqual(["x", "lo", "hi", "result"]);
  const [x, lo, hi, result] = [c.x!, c.lo!, c.hi!, c.result!].map(BigInt) as [bigint, bigint, bigint, bigint];
  expect(lo <= hi).toBe(true);
  expect(result).toBe(x < lo ? lo : x);
  expect(result >= lo && result <= hi).toBe(false);

  // The struct parameter is a placeholder symbol in the query; only its field has a value.
  const b = witness(obs, "bump");
  expect(Object.keys(b).sort()).toEqual(["a_total", "d"]);
  expect(BigInt(b.d!)).toBe(0n);

  const u = witness(obs, "countUp");
  const n = BigInt(u.n!);
  expect(n >= 0n).toBe(true);
  expect(BigInt(u["i (after the loop)"]!)).toBe(n);
  expect(BigInt(u.result!)).toBe(n);

  const a = witness(obs, "area");
  const [w, h, r] = [ratio(a.w!), ratio(a.h!), ratio(a.result!)];
  expect(w > 0 && h > 0).toBe(true);
  expect(r).toBeCloseTo(w * h, 9);
  expect(r > 1).toBe(false);
});

test("a proven obligation carries no counterexample", () => {
  for (const o of prove()) if (o.status !== "failed") expect(o.counterexample).toBeUndefined();
});
