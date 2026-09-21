// The object cache (src/objcache.ts): a second build of an unchanged program takes its
// objects from the cache, and a one-function edit under the CGU split re-compiles one
// unit, not all of them. Both run against a private cache root so the developer's own
// ~/.milo/cache is neither read nor polluted, and both read MILO_VERBOSE's report
// rather than timing anything, so the test cannot go flaky on a loaded machine.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function build(src: string, out: string, cache: string, extra: string[] = []): string {
  const r = spawnSync("bun", ["run", MAIN, "build", src, "-o", out, ...extra], {
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cache, MILO_VERBOSE: "1", MILO_OBJ_CACHE: "1" },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stderr;
}

test("an unchanged program is linked from cached objects on its second build", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-objcache-"));
  try {
    const src = join(dir, "p.milo");
    writeFileSync(src, `fn main(): i32 {\n    print("hi")\n    return 0\n}\n`);
    const first = build(src, join(dir, "p"), join(dir, "cache"));
    expect(first).not.toContain("objcache: hit");
    const second = build(src, join(dir, "p"), join(dir, "cache"));
    expect(second).toContain("objcache: hit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a one-function edit under the cgu split re-compiles one unit", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-objcache-"));
  try {
    // Enough distinct functions for a 2-way split (splitModule wants >= 4 per unit),
    // each with its own body so the units are not trivially identical.
    const fns = Array.from({ length: 16 }, (_, i) =>
      `fn f${i}(x: i64): i64 {\n    var s: i64 = ${i}\n    for k in 0..x { s = s + k * ${i + 1} }\n    return s\n}\n`).join("\n");
    const main = `fn main(): i32 {\n    var t: i64 = 0\n${Array.from({ length: 16 }, (_, i) => `    t = t + f${i}(3)`).join("\n")}\n    print(t)\n    return 0\n}\n`;
    const src = join(dir, "p.milo");
    writeFileSync(src, fns + "\n" + main);
    const cache = join(dir, "cache");
    const first = build(src, join(dir, "p"), cache, ["--cgus=2"]);
    expect(first).toMatch(/cgu: 2 units, .*0 cached/);
    const warm = build(src, join(dir, "p"), cache, ["--cgus=2"]);
    expect(warm).toMatch(/cgu: 2 units, .*2 cached/);
    // Edit one body. The sticky placement keeps every other function on its unit, so
    // exactly one unit's IR changes.
    writeFileSync(src, readFileSync(src, "utf8").replace("var s: i64 = 7\n", "var s: i64 = 70\n"));
    const edited = build(src, join(dir, "p"), cache, ["--cgus=2"]);
    expect(edited).toMatch(/cgu: 2 units, .*1 cached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
