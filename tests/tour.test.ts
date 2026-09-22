// The docs-site tour prints each lesson's output as captured text. This runs every
// lesson through the real compiler so that text cannot drift from what Milo prints.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lessons } from "../docs/site/.vitepress/theme/tourLessons";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const ANSI = /\x1b\[[0-9;]*m/g;

test("tour has lessons", () => {
  expect(lessons.length).toBeGreaterThan(0);
});

for (const [i, l] of lessons.entries()) {
  test(`tour lesson ${i + 1}: ${l.title}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-tour-"));
    try {
      writeFileSync(join(dir, l.file), l.code + "\n");
      // Run from the lesson's directory with a bare filename so diagnostics print
      // `ownership.milo:4:11`, the same path the page shows.
      const args = ["bun", "run", MAIN, "run", ...(l.debug ? ["--debug"] : []), l.file];
      const p = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      const lines = (out + err).replace(ANSI, "").split("\n").map((s) => s.trimEnd());
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      expect(lines).toEqual(l.out);
      if (l.fails) expect(code).not.toBe(0);
      else expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
}
