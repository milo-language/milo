// `--expect=<warning>`: suppress the finding AND report if it stops occurring.
//
// `--allow` is silent forever. Nothing ever deletes it, so a suppression outlives the code
// it excused and the project keeps claiming a lint it no longer needs. An expectation
// deletes itself: the moment the finding stops firing, the build says so.
//
// Two things make this more than a rename of `--allow`, and both are asserted here: an
// off-by-default lint has to be ENABLED by expecting it (otherwise it never runs, never
// fires, and reports itself unfulfilled against code that does contain the finding), and a
// misspelled warning name has to be refused rather than silently accepted.
import { test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const WORK = mkdtempSync(join(tmpdir(), "milo-expect-"));

function check(src: string, flags: string[]): { out: string; code: number } {
  const f = join(WORK, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(f, src);
  // spawnSync, not execFileSync: warnings go to STDERR, and execFileSync returns only
  // stdout on success, so a passing check discarded the very line under test.
  const r = spawnSync("bun", [join(ROOT, "src", "main.ts"), "check", f, ...flags], { encoding: "utf8" });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status ?? 1 };
}

const HAS_FINDING = `fn main() {\n  var v: Vec<Vec<i64>> = Vec.new()\n  v.push(Vec.new())\n  let m = v[0]\n  v.push(Vec.new())\n  print(m.len)\n}\n`;
const CLEAN = `fn main() {\n  print("clean")\n}\n`;

test("an expectation that is met stays silent", () => {
  const r = check(HAS_FINDING, ["--expect=index-clone"]);
  expect(r.out).not.toContain("index-clone");
});

test("an expectation that is not met is reported", () => {
  const r = check(CLEAN, ["--expect=index-clone"]);
  expect(r.out).toContain("no 'index-clone' warning was reported");
});

test("the unmet report can itself be promoted to an error", () => {
  const r = check(CLEAN, ["--expect=index-clone", "--deny=unfulfilled-expectation"]);
  expect(r.code).not.toBe(0);
});

test("a misspelled warning name is refused, not ignored", () => {
  const r = check(CLEAN, ["--deny=indx-clone"]);
  expect({ code: r.code, mentions: r.out.includes("unknown warning 'indx-clone'") })
    .toEqual({ code: 1, mentions: true });
});

// In afterAll, not at module scope: a bare call there runs while the module is being
// evaluated, which is BEFORE any test body, so it deleted the directory the tests write to.
afterAll(() => rmSync(WORK, { recursive: true, force: true }));
