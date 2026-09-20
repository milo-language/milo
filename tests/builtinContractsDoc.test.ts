// Holds docs/roadmap.md's copy of the builtin container contract table to the one the
// prover actually assumes (BUILTIN_CONTRACTS_SRC in src/verify.ts). A hand-copied table
// drifts the day an entry changes, and this table is a list of facts the prover takes on
// faith, so the doc must show the real one. On failure, paste the printed block between
// the `<!-- builtin-contracts -->` markers.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { builtinContractsDoc } from "../src/verify";

test("docs/roadmap.md quotes the builtin contract table verbatim", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "roadmap.md"), "utf-8");
  const m = doc.match(/<!-- builtin-contracts -->\n([\s\S]*?)\n<!-- \/builtin-contracts -->/);
  expect(m).not.toBeNull();
  expect(m![1]!.trim()).toBe(builtinContractsDoc().trim());
});
