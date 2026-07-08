// Drift guard: committed docs/std/*.md must match what the generator produces
// from the current std doc-comments. If this fails, run:
//   bun run scripts/gen-std-docs.ts
import { test, expect } from "bun:test";
import { stdDocsByModule } from "../src/api-search";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const OUT_DIR = join(import.meta.dir, "..", "docs", "std");

test("committed std docs are up to date with std doc-comments", () => {
  const docs = stdDocsByModule();
  const stale: string[] = [];
  for (const [stem, body] of docs) {
    const path = join(OUT_DIR, `${stem}.md`);
    const expected = `# std/${stem}\n\n${body}`;
    if (!existsSync(path) || readFileSync(path, "utf-8") !== expected) stale.push(stem);
  }
  if (stale.length) {
    throw new Error(`stale/missing docs for: ${stale.join(", ")}\nrun: bun run scripts/gen-std-docs.ts`);
  }
});
