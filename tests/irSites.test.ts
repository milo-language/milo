// IR string-site ratchet: see scripts/ir-sites.ts for what counts and the updater.
import { test, expect } from "bun:test";
import { countSites, measure, readBaseline, violations } from "../scripts/ir-sites";

test("counter sees each kind of string site", () => {
  // If a pattern stops matching, the ratchet reads 0 everywhere and passes forever.
  expect(countSites("lines.push(`  ${t} = load i64, ptr ${p}`);")).toBe(1);
  expect(countSites('entryAllocas.push("  %x = alloca i64");')).toBe(1);
  expect(countSites("b.raw(`  unreachable`);")).toBe(1);
  expect(countSites("const t = ctx.nextTemp();")).toBe(1);
  expect(countSites("emit(lines, `  ${t} = add i64 1, 2`);")).toBe(1);
  expect(countSites('emit(lines, "  store i64 0, ptr %p");')).toBe(1);
  expect(countSites("const t = ctx.nextTemp(); lines.push(`  ${t} = add i64 1, 2`);")).toBe(1);
  expect(countSites("// lines.push(`x`)\nlines.push(...rest);")).toBe(0);
});

test("no src file emits more IR as text than its baseline", () => {
  const current = measure();
  // codegen.ts alone held ~4,100 sites when this landed; a near-empty map means the glob broke.
  expect(Object.keys(readBaseline()).length).toBeGreaterThan(0);
  expect(violations(readBaseline(), current)).toEqual([]);
});
