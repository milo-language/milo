// std/log leaves timestamps off when JOURNAL_STREAM is set (systemd sets it when stderr
// is the journal, which stamps lines itself); an explicit setTimestamps still wins.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "logj-"));

function run(name: string, body: string, env: Record<string, string>): string {
  const src = join(dir, `${name}.milo`);
  writeFileSync(src, `from "std/log" import { Log }\n\npub fn main(): i32 {\n    Log.setSinkStdout()\n${body}\n    Log.info("hello")\n    return 0\n}\n`);
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.JOURNAL_STREAM;
  const r = spawnSync("bun", ["run", join(ROOT, "src", "main.ts"), "run", src], {
    cwd: ROOT, encoding: "utf8", env: { ...base, ...env }, timeout: 100_000,
  });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

const stamped = /^\d{4}-\d{2}-\d{2}T\S+ INFO  hello$/;

test("timestamps are on by default", () => {
  expect(run("plain", "", {})).toMatch(stamped);
}, 120_000);

test("JOURNAL_STREAM turns the default off", () => {
  expect(run("journal", "", { JOURNAL_STREAM: "8:1234" })).toBe("INFO  hello");
}, 120_000);

test("an explicit setTimestamps(true) wins over JOURNAL_STREAM", () => {
  expect(run("explicit", "    Log.setTimestamps(true)", { JOURNAL_STREAM: "8:1234" })).toMatch(stamped);
}, 120_000);
