import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseSections, runtimeFn, runtimeSectionKeys } from "../src/codegen-runtime";

test("sections: comments dropped, trailing blanks trimmed, stray text and duplicates rejected", () => {
  const s = parseSections("; header\n\n; @@ a\nentry:\n  ; note\n  ret void\n\n; @@ b\n}\n");
  expect(s.get("a")).toEqual(["entry:", "  ret void"]);
  expect(s.get("b")).toEqual(["}"]);
  expect(() => parseSections("define void @f() {\n")).toThrow("outside any");
  expect(() => parseSections("; @@ a\n; @@ a\n")).toThrow("defined twice");
});

test("runtimeFn substitutes every placeholder and rejects a mismatch either way", () => {
  expect(runtimeFn("milo.str.oom", { where: "@.str.9" })).toContain("  call void @__milo_overflow_fail(ptr @.str.9, i32 0)");
  expect(() => runtimeFn("milo.str.oom")).toThrow("needs a value for {{where}}");
  expect(() => runtimeFn("milo.str.free", { where: "x" })).toThrow("has no {{where}}");
  expect(() => runtimeFn("milo.nope")).toThrow("no section milo.nope");
  const grow = ["  a", "b:"];
  const r = runtimeFn("milo.str.reserve", { grow, reallocMin: "4096", reIn: "[ %r, %re ]" });
  expect(r.slice(r.indexOf("  a"), r.indexOf("  a") + 2)).toEqual(grow);
  expect(() => runtimeFn("milo.str.reserve", { grow: "x", reallocMin: ["1"], reIn: "" })).toThrow("takes a string");
});

// Keys are named in full at every call so this can find them. A section nobody loads is dead runtime text that still looks maintained.
test("every section in src/runtime/str.ll is loaded by codegen", () => {
  const cg = readFileSync(join(import.meta.dir, "..", "src", "codegen.ts"), "utf-8");
  const keys = runtimeSectionKeys();
  expect(keys.length).toBe(15);
  expect(keys.filter(k => !cg.includes(`"${k}"`))).toEqual([]);
});
