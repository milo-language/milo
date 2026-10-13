// src/*.ts file-size ratchet: see scripts/file-size-ratchet.ts for the rules and the updater.
import { test, expect } from "bun:test";
import { measure, readBaseline, violations } from "../scripts/file-size-ratchet";

test("no src/*.ts file grew past its baseline line count", () => {
  const current = measure();
  const baseline = readBaseline();
  // A glob that stops matching checks nothing and passes forever; the corpus is ~60 files.
  expect(Object.keys(current).length).toBeGreaterThan(20);
  expect(Object.keys(baseline).length).toBeGreaterThan(20);
  expect(violations(baseline, current)).toEqual([]);
});
