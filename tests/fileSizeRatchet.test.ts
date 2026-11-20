// File-size ratchet over tracked source: see scripts/file-size-ratchet.ts for the rules and the updater.
import { test, expect } from "bun:test";
import { LIMIT, measure, readBaseline, updated, violations } from "../scripts/file-size-ratchet";

test("no tracked source file over the limit grew past its baseline line count", () => {
  const current = measure();
  const baseline = readBaseline();
  // A glob that stops matching checks nothing and passes forever; the corpus is ~150 files.
  expect(Object.keys(current).length).toBeGreaterThan(400);
  // Every directory in scope is measured, not only src/.
  for (const d of ["src/", "scripts/", "std/", "mlir/", "tests/", "proofs/"]) expect(Object.keys(current).some(f => f.startsWith(d))).toBe(true);
  // checker.ts is why the ratchet exists; a baseline without it guards nothing.
  expect(baseline["src/checker.ts"]).toBeGreaterThan(LIMIT);
  expect(violations(baseline, current)).toEqual([]);
});

test("the ratchet is red for growth of a big file, a file crossing the limit, a large shrink and a stale entry", () => {
  const base = { "src/big.ts": 5000 };
  const red = (current: Record<string, number>) => violations(base, current).map(v => v.split(":")[0]);
  expect(red({ "src/big.ts": 5000, "src/small.ts": 100 })).toEqual([]);
  expect(red({ "src/big.ts": 5001 })).toEqual(["src/big.ts"]);
  expect(red({ "src/big.ts": 4800 })).toEqual(["src/big.ts"]);
  expect(red({ "src/big.ts": 5000, "src/small.ts": LIMIT })).toEqual([]);
  expect(red({ "src/big.ts": 5000, "src/small.ts": LIMIT + 1 })).toEqual(["src/small.ts"]);
  expect(red({})).toEqual(["src/big.ts"]);
});

test("--update only lowers: a raise or a new oversized file needs --allow-growth", () => {
  const base = { "src/big.ts": 5000 };
  expect(updated(base, { "src/big.ts": 4000 }, new Set())).toEqual({ next: { "src/big.ts": 4000 }, refused: [] });
  expect(updated(base, { "src/big.ts": 5001 }, new Set())).toEqual({ next: { "src/big.ts": 5000 }, refused: ["src/big.ts: 5000 -> 5001"] });
  expect(updated(base, { "src/big.ts": 5001 }, new Set(["src/big.ts"]))).toEqual({ next: { "src/big.ts": 5001 }, refused: [] });
  expect(updated({}, { "src/new.ts": LIMIT + 1 }, new Set()).refused).toEqual([`src/new.ts: none -> ${LIMIT + 1}`]);
  expect(updated(base, { "src/big.ts": LIMIT }, new Set()).next).toEqual({});
});
