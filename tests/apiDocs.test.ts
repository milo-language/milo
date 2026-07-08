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
