// Regenerate docs/std/<module>.md from the std doc-comments (source of truth).
// Run: bun run scripts/gen-std-docs.ts
// The drift test in tests/stdDocs.test.ts fails CI if these are stale.
import { stdDocsByModule } from "../src/api-search";
import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";

const OUT_DIR = join(import.meta.dir, "..", "docs", "std");
mkdirSync(OUT_DIR, { recursive: true });

const docs = stdDocsByModule();
// Drop stale files for modules that no longer exist.
if (existsSync(OUT_DIR)) {
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith(".md") && f !== "README.md" && !docs.has(f.replace(/\.md$/, ""))) {
      rmSync(join(OUT_DIR, f));
    }
  }
}

const index: string[] = ["# Standard Library Reference\n", "Generated from `std/**/*.milo` doc-comments — do not edit by hand.\n"];
for (const stem of [...docs.keys()].sort()) {
  writeFileSync(join(OUT_DIR, `${stem}.md`), `# std/${stem}\n\n${docs.get(stem)}`);
  index.push(`- [std/${stem}](./${stem}.md)`);
}
writeFileSync(join(OUT_DIR, "README.md"), index.join("\n") + "\n");
console.log(`wrote ${docs.size} module docs to docs/std/`);
