// `milo api --markdown` turns std doc-comments into reference markdown, so the
// doc-comments in std are the single source of truth for the .md docs.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
function api(args: string): string {
  return execSync(`bun run ${COMPILER} api ${args}`, { encoding: "utf-8" });
}

test("--markdown emits a signature code block + doc for a documented API", () => {
  const md = api("--module std/runtime --markdown");
  expect(md).toContain("## std/runtime");
  expect(md).toContain("### `Task.spawn`");
  expect(md).toContain("```milo");
  expect(md).toContain("fn Task.spawn(f: () => void): Task");
  // full doc-comment body, not just the first line
  expect(md).toContain("guard-paged stack");
});

test("undocumented APIs are marked, not silently blank", () => {
  const md = api("--module std/runtime --markdown");
  expect(md).toContain("_Undocumented._");
});

// A leaked `impl` scope printed free functions as `File.splitLines` — a name that
// looks like a real call path but isn't callable. std/io is the regression case:
// its free fns all sit after `impl File`.
test("free fns after an impl block are not impl-prefixed", () => {
  const out = api("--module std/io");
  expect(out).toContain("fn splitLines(");
  expect(out).toContain("fn readStdin(");
  expect(out).not.toContain("File.splitLines");
  expect(out).not.toContain("File.readStdin");
  // methods genuinely inside `impl File` keep their prefix
  expect(out).toContain("fn File.readAll(");
});
