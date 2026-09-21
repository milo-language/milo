// A `move` closure that moves a capture out can run once. The checker rejects a second
// call it can see; through a function parameter it cannot, and before 2026-09-21 the
// second call read the zeroed capture and returned a wrong answer, quietly (backlog
// #32). The environment's liveness flag now turns that second call into a named abort.
import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const SRC = `
fn consume(s: string): i64 { return s.len }
fn twice(f: move () => i64): i64 { return f() + f() }
fn once(f: move () => i64): i64 { return f() }
fn main(): i32 {
    let s = "abc"
    print(once(move (): i64 => consume(s)))
    let t = "abcd"
    print(twice(move (): i64 => consume(t)))
    return 0
}
`;

test("a once-closure called twice through a parameter aborts instead of answering wrong", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-once-"));
  try {
    const src = join(dir, "p.milo");
    writeFileSync(src, SRC);
    execFileSync("bun", ["run", MAIN, "build", src, "-o", join(dir, "p")], { stdio: "pipe" });
    const r = spawnSync(join(dir, "p"), [], { encoding: "utf8" });
    // The first, legitimate call ran; the second aborted before producing a number.
    expect(r.stdout).toBe("3\n");
    expect(r.stderr).toContain("closure called again after it moved 't' out");
    expect(r.status === 0).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
