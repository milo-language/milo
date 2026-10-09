// The generation-exhaustion boundary of std/arena, tested from inside the module.
//
// A slot whose generation reaches i32 max is retired, never wrapped back onto an old
// handle. Reaching that from outside takes 2^31 alloc/free cycles, so the fixture used
// to write `arena.gens` directly. The generation table is private now (a writable one
// let any file forge staleness or slip past the freeze refusal), and a `_` field is
// visible only in its declaring file, so this test compiles std/arena.milo's own source
// with a `main` appended: one file, where the private fields are in scope.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");

test("a slot at the maximum generation is retired, not wrapped", () => {
  const arena = readFileSync(join(ROOT, "std", "arena.milo"), "utf-8");
  // std/arena.milo has no imports, so its text can open a program as-is; if it ever
  // gains one this test must hoist the imports above anything it appends.
  expect(arena).not.toMatch(/^from\s+"/m);
  const main = `
fn main(): void {
    var a = Arena<i64>.new()
    let h = a.alloc(1)
    a._gens[h.index as i64] = 2147483647
    let exhausted: Handle<i64> = Handle { arenaId: h.arenaId, index: h.index, generation: 2147483647 }
    print(a.free(exhausted))
    print(a.valid(exhausted))
    print(a._gens[h.index as i64])
    print(a._freeList.len)
    print(a.handles().len)
    let fresh = a.alloc(2)
    print(fresh.index != exhausted.index)
    print(a.len())
}
`;
  const dir = mkdtempSync(join(tmpdir(), "arena-retire-"));
  try {
    const file = join(dir, "retire.milo");
    writeFileSync(file, arena + main);
    const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "run", file], {
      cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    expect(out.trim().split("\n")).toEqual(["true", "false", "0", "0", "0", "true", "1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
