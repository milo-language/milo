// Gate: the compiler's own TypeScript must typecheck clean. Bun strips types without
// checking them, so nothing else in the suite would notice a type error — tsc is the
// only thing that reads them, and unenforced it just accumulates (it sat at 782 errors
// before this gate landed, which is why `noUncheckedIndexedAccess` is off; see
// tsconfig.json and docs/backlog.md).
//
// Scoped to src/ — the compiler. examples/ subprojects (hades' vite UI, java-dap) carry
// their own tsconfigs and node_modules, so the root tsc reports phantom errors for them.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("src/ typechecks clean", () => {
  let output = "";
  try {
    execSync("bunx tsc --noEmit", { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    // tsc exits nonzero when ANY file errors, including the excluded subprojects —
    // so a nonzero exit alone isn't a failure. Only src/ lines count.
    output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  }
  const errors = output.split("\n").filter(l => /^src\/.*error TS/.test(l));
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} TypeScript error(s) in src/:\n${errors.slice(0, 20).join("\n")}` +
      (errors.length > 20 ? `\n... and ${errors.length - 20} more` : "") +
      `\n\nrun: bunx tsc --noEmit`,
    );
  }
  expect(errors.length).toBe(0);
}, 180000);
