// `milo doc` — reference markdown for any .milo file or directory, using the same
// extractor and renderer as the std reference (scripts/gen-std-docs.ts).
//
// The arg parsing has one trap worth pinning: `-o` is found with findIndex, which
// returns -1 when absent, so a naive `i !== oIdx + 1` filter silently drops argv[0]
// — the target itself — and every no-`-o` invocation degrades to a usage error.
import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const dirs: string[] = [];

afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} });

function doc(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync("bun", ["run", MAIN, "doc", ...args], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("a single file renders to stdout", () => {
  const r = doc([join(ROOT, "std", "json.milo")]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("## json");
  expect(r.out).toContain("```milo");
});

test("a directory writes one .md per module", () => {
  const out = mkdtempSync(join(tmpdir(), "milo-doc-"));
  dirs.push(out);
  const r = doc([join(ROOT, "std"), "-o", out]);
  expect(r.code).toBe(0);
  expect(existsSync(join(out, "json.md"))).toBe(true);
  expect(readFileSync(join(out, "json.md"), "utf-8")).toContain("jsonParse");
});

// Nested dirs must keep their path as the module name, not collapse to a basename.
test("nested modules keep their relative path", () => {
  const out = mkdtempSync(join(tmpdir(), "milo-doc-nested-"));
  dirs.push(out);
  const r = doc([join(ROOT, "src-milo"), "-o", out]);
  expect(r.code).toBe(0);
  expect(existsSync(join(out, "parser.md"))).toBe(true);
});

test("a missing path is an error, not an empty document", () => {
  const r = doc([join(ROOT, "no-such-dir-xyz")]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("no such file or directory");
});

test("no target prints usage", () => {
  const r = doc([]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("usage: milo doc");
});
