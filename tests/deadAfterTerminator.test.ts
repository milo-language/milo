// A match arm whose tail is a nested match with every arm diverging ends in `unreachable`.
// It once reported itself as not terminated, so the outer match appended `br label %match.end`
// after that terminator. Clang parses the dead instruction as a new unnamed block, so the
// fixture's stdout can't catch it: only the IR shows it.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("no instruction follows a terminator in matchVoidNested", () => {
  const ir = execSync(`bun run src/main.ts emit-ir tests/fixtures/matchVoidNested.milo`, { cwd: ROOT, encoding: "utf8" });
  const lines = ir.split("\n");
  const dead: string[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s+(ret\b|br\b|unreachable\b)/.test(lines[i])) continue;
    const next = lines[i + 1];
    if (next.trim() === "" || next === "}" || /^[\w.$"-]+:/.test(next)) continue;
    dead.push(`${i + 2}: ${next.trim()} (after: ${lines[i].trim()})`);
  }
  expect(dead).toEqual([]);
});
