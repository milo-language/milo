// Gate: the compiler's own TypeScript must typecheck clean. Bun strips types without
// checking them, so nothing else in the suite would notice a type error — tsc is the
// only thing that reads them, and unenforced it just accumulates (it sat at 782 errors
// before this gate landed, which is why `noUncheckedIndexedAccess` is off; see
// tsconfig.json and docs/backlog.md).
//
// Scoped to src/, scripts/ and tests/. examples/ subprojects (hades' vite UI, java-dap),
// docs/site and editors/vscode carry their own tsconfigs and node_modules, so the root
// tsc reports phantom errors for them.
//
// tsconfig turns on noUnusedLocals/noUnusedParameters, so this gate also rejects dead
// locals and imports. src/checker.ts is carved out of THAT check only (TS6133/TS6196)
// while WP4/WP9/WP11 edit it concurrently; the carve-out goes with the WP13 follow-up in
// docs/plans/design-pass-2026-09.md.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

const UNUSED_CODES = /error TS61(33|96):/;

test("src/, scripts/, tests/ typecheck clean", () => {
  let output = "";
  try {
    execSync("bunx tsc --noEmit", { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    // tsc exits nonzero when ANY file errors, including the excluded subprojects —
    // so a nonzero exit alone isn't a failure. Only src/, scripts/, tests/ lines count.
    output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  }
  const errors = output.split("\n")
    .filter(l => /^(src|scripts|tests)\/.*error TS/.test(l))
    .filter(l => !(l.startsWith("src/checker.ts(") && UNUSED_CODES.test(l)));
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} TypeScript error(s):\n${errors.slice(0, 20).join("\n")}` +
      (errors.length > 20 ? `\n... and ${errors.length - 20} more` : "") +
      `\n\nrun: bunx tsc --noEmit`,
    );
  }
  expect(errors.length).toBe(0);
}, 180000);
