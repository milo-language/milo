import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseSections, runtimeFn, runtimeSectionKeys } from "../src/runtime-ir";

test("sections: comments dropped, trailing blanks trimmed, stray text and duplicates rejected", () => {
  const s = parseSections("; header\n\n; @@ a\nentry:\n  ; note\n  ret void\n\n; @@ b\n}\n");
  expect(s.get("a")).toEqual(["entry:", "  ret void"]);
  expect(s.get("b")).toEqual(["}"]);
  expect(() => parseSections("define void @f() {\n")).toThrow("outside any");
  expect(() => parseSections("; @@ a\n; @@ a\n")).toThrow("defined twice");
});

test("runtimeFn substitutes every placeholder and rejects a mismatch either way", () => {
  const load = runtimeFn("milo.atomic.load", { name: "f", ty: "i64", align: "8" });
  expect(load).toContain("define internal i64 @f(ptr %p) {");
  expect(() => runtimeFn("milo.atomic.load", { name: "f", ty: "i64" })).toThrow("needs a value for {{align}}");
  expect(() => runtimeFn("milo.atomic.load", { name: "f", ty: "i64", align: "8", extra: "x" })).toThrow("has no {{extra}}");
  expect(() => runtimeFn("milo.nope")).toThrow("no section milo.nope");
  expect(() => runtimeFn("milo.atomic.load", { name: ["a"], ty: "i64", align: "8" })).toThrow("takes a string");
});

// Keys are named in full at every call so this can find them. A section nobody loads is dead runtime text that still looks maintained.
test("every section in src/runtime/*.ll is loaded by src/runtime-ir.ts", () => {
  const cg = readFileSync(join(import.meta.dir, "..", "src", "runtime-ir.ts"), "utf-8");
  const keys = runtimeSectionKeys();
  // Every marker in the files parsed into a section: a loader that drops a file finds fewer.
  const dir = join(import.meta.dir, "..", "src", "runtime");
  const markers = readdirSync(dir).filter(f => f.endsWith(".ll"))
    .map(f => (readFileSync(join(dir, f), "utf-8").match(/^; @@ /gm) ?? []).length).reduce((x, y) => x + y, 0);
  expect(markers).toBeGreaterThan(0);
  expect(keys.length).toBe(markers);
  expect(keys.filter((k: string) => !cg.includes(`"${k}"`))).toEqual([]);
});
