// A panic on a spawned green task retires that task (std/runtime onRuntimePanic), but a
// panic in `main` must still abort the process. Once spawn is reachable, main itself runs
// as a green task (schedulerRunMainRaw), and retiring it ended the program with exit code
// 0 after a failed unwrap: a script that died on a missing file reported success.
// Fixtures check stdout only, so the exit status is asserted here.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-green-main-panic-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const SRC = `from "std/runtime" import { Task }

fn main() {
    let t = Task.spawn(move(): void => {
        print("task ran")
    })
    t.join()
    let v: Vec<i64> = [1, 2, 3]
    let i = v.len + 2
    print("before")
    print(v[i])
    print("after")
}
`;

test("a panic in main aborts with a nonzero status even when main is a green task", () => {
  const file = join(dir, "p.milo");
  const bin = join(dir, "p");
  writeFileSync(file, SRC);
  execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build", file, "-o", bin], { cwd: ROOT, stdio: "pipe" });
  const r = spawnSync(bin, [], { encoding: "utf-8", timeout: 30000 });
  expect(r.stdout).toBe("task ran\nbefore\n");
  expect({ status: r.status, aborted: r.status !== 0 || r.signal !== null }).toEqual({ status: r.status, aborted: true });
}, 60000);
