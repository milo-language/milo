// The object cache (src/objcache.ts): a second build of an unchanged program takes its
// objects from the cache, and a one-function edit under the CGU split re-compiles one
// unit, not all of them. Both run against a private cache root so the developer's own
// ~/.milo/cache is neither read nor polluted, and both read MILO_VERBOSE's report
// rather than timing anything, so the test cannot go flaky on a loaded machine.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { hotStateLoad, hotStateStore } from "../src/objcache";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedRun } from "../scripts/guard";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function build(src: string, out: string, cache: string, extra: string[] = [], env: Record<string, string> = {}): string {
  const r = spawnSync("bun", ["run", MAIN, "build", src, "-o", out, ...extra], {
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cache, MILO_VERBOSE: "1", MILO_OBJ_CACHE: "1", MILO_HOT_UNIT: "1", ...env },
  });
  expect(r.status, r.stderr).toBe(0);
  // A failed split build silently falls back to one module; the unit counts asserted
  // below would then describe a build that never linked.
  expect(r.stderr).not.toContain("falling back to a single module");
  return r.stderr;
}

async function runGuarded(bin: string): Promise<string> {
  const r = await guardedRun(bin, [], { memMb: 256, timeoutMs: 30000 });
  expect(r.code, r.stderr).toBe(0);
  return r.stdout;
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

test("a one-function edit under the cgu split re-compiles one unit, then only the hot unit", async () => {
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
    // Edit one body. The sticky placement keeps every other function on its unit; the
    // edited one moves to the hot unit, so its old unit and the hot unit recompile.
    writeFileSync(src, readFileSync(src, "utf8").replace("var s: i64 = 7\n", "var s: i64 = 70\n"));
    const edited = build(src, join(dir, "p"), cache, ["--cgus=2"]);
    expect(edited).toMatch(/cgu: 2 units \(\+1 hot unit: 1 fns\), .*1 cached/);
    expect(await runGuarded(join(dir, "p"))).toBe("591\n");
    // A second edit to the same function recompiles only the hot unit.
    writeFileSync(src, readFileSync(src, "utf8").replace("var s: i64 = 70\n", "var s: i64 = 700\n"));
    const again = build(src, join(dir, "p"), cache, ["--cgus=2"]);
    expect(again).toMatch(/cgu: 2 units \(\+1 hot unit: 1 fns\), .*2 cached/);
    expect(await runGuarded(join(dir, "p"))).toBe("1221\n");
    // The same source with the hot unit off: the function goes back to its old unit,
    // which recompiles with the new body; the other unit is still cached.
    const off = build(src, join(dir, "p"), cache, ["--cgus=2"], { MILO_HOT_UNIT: "0" });
    expect(off).toMatch(/cgu: 2 units, .*1 cached/);
    expect(await runGuarded(join(dir, "p"))).toBe("1221\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fail closed: a hot-unit state file that is not exactly the shape we write loads as
// "no state", which means nothing is hot, never a partly-trusted guess.
test("a corrupt hot-unit state file loads as no state", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-objcache-"));
  const saved = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    hotStateStore("/p.milo", 4, { hashes: new Map([["main", "h1"]]), hot: ["main"] });
    expect(hotStateLoad("/p.milo", 4)).toEqual({ hashes: new Map([["main", "h1"]]), hot: ["main"] });
    const hotDir = join(dir, "milo", "obj", "hot");
    const file = join(hotDir, readdirSync(hotDir)[0]!);
    for (const bad of ["", "{", "null", "[]", `{"v":2,"hot":[],"hashes":{}}`, `{"v":1,"hot":"main","hashes":{}}`,
      `{"v":1,"hot":[1],"hashes":{}}`, `{"v":1,"hot":[],"hashes":{"main":3}}`, `{"v":1,"hot":[],"hashes":null}`]) {
      writeFileSync(file, bad);
      expect(hotStateLoad("/p.milo", 4)).toBeNull();
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
