// Allocas outside the entry block are dynamic in LLVM: SP bumps every time one
// executes and is never restored, so a loop-body temp alloca (e.g. a string
// literal passed by-ref each iteration) leaks stack per iteration — grep over a
// 1M-line file segfaulted this way. Codegen must hoist every alloca into the
// entry block (all Milo allocas are constant-size, so this is always legal).
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

// exercises the paths that emitted point-of-use allocas: by-ref literal args +
// slices in a loop, a match scrutinee in a loop, and a closure with a loop body
const SRC = `
fn pick(n: i64): Option<i64> {
    if n > 2 { return Option.Some(n) }
    return Option.None
}
fn main(): void {
    let s = "abcdef abcdef abcdef"
    var count: i64 = 0
    var i: i64 = 0
    while i < 10 {
        var nl = strIndexOfFrom(s, "f", 0)
        let sub = s[0..10]
        if sub.contains("cde") && nl >= 0 { count = count + 1 }
        match pick(i) {
            Option.Some(v) => { count = count + v }
            Option.None => {}
        }
        i = i + 1
    }
    let f = (n: i64): i64 => {
        var acc: i64 = 0
        var j: i64 = 0
        while j < n {
            let piece = s[0..3]
            if piece.contains("b") { acc = acc + 1 }
            j = j + 1
        }
        return acc
    }
    print(count + f(5))
}
`;

test("no allocas outside any function's entry block", () => {
  const f = join(tmpdir(), "milo_alloca_hoist.milo");
  writeFileSync(f, SRC);
  const ir = execSync(`bun run ${COMPILER} emit-ir ${f}`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
  unlinkSync(f);

  const offenders: string[] = [];
  let currentFn = "";
  let pastEntryBlock = false;
  for (const line of ir.split("\n")) {
    const def = line.match(/^define .*@(\S+)\(/);
    if (def) { currentFn = def[1]; pastEntryBlock = false; continue; }
    if (line === "}") { currentFn = ""; continue; }
    if (!currentFn) continue;
    // block labels are column-0 lines ending in ':'; the first one is the entry
    if (line.length > 0 && line[0] !== " " && line.endsWith(":")) {
      if (line !== "entry.bb:") pastEntryBlock = true;
      continue;
    }
    if (pastEntryBlock && /^ {2}%\S+ = alloca /.test(line)) {
      offenders.push(`${currentFn}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
