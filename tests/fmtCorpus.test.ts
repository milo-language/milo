// Property test over the whole .milo corpus: formatting is idempotent —
// format(format(x)) == format(x). No expected-output files to maintain; it just asserts
// the formatter reaches a fixed point.
//
// This is the shape of bug that motivated it: fmt.milo split `extern struct Foo` across
// three lines, and because that output was itself stable, only a second opinion (a
// round-trip, or a human noticing) could catch it. Idempotence won't catch a wrong-but-
// stable rewrite, so the targeted cases in fmt.test.ts stay the real safety net; this
// catches the formatter oscillating or progressively mangling a construct it can't reparse.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
let dir = "";
let fmtBin = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-fmtcorpus-"));
  fmtBin = join(dir, "fmt");
  // Build once — `milo run` would recompile the formatter for each of ~430 files.
  execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build",
    join(ROOT, "examples", "cli-tools", "fmt.milo"), "-o", fmtBin],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
}, 120000);

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function fmt(src: string, name: string): string {
  const f = join(dir, `${name}.milo`);
  writeFileSync(f, src);
  return execFileSync(fmtBin, [f], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

// Recursive: src-milo/ keeps half its files in checker/ and codegen/, so a top-level-only
// scan would have watched 12 of its 25 and called that covered.
function corpus(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".milo")) out.push(p);
    }
  };
  for (const sub of ["std", "tests/fixtures", "src-milo"]) walk(join(ROOT, sub));
  return out;
}

// std/, tests/fixtures/ and src-milo/ are all formatted, so this gates at zero. src-milo
// joined once the self-hosted compiler was run through fmt: 24 files changed, and the
// selfhost lane (173 tests, which rebuilds milo-self from this source) stayed green.
// A handful under examples/ + tests/errors/ are still unformatted — tests/errors/ is
// excluded on purpose (the fixtures are deliberately malformed).
test("committed std/, tests/fixtures/ and src-milo/ sources are formatted", () => {
  const dirty: string[] = [];
  for (const path of corpus()) {
    const src = readFileSync(path, "utf-8");
    try {
      if (fmt(src, "c") !== src) dirty.push(path);
    } catch { /* crashes are reported by the idempotence test */ }
  }
  if (dirty.length) {
    throw new Error(
      `${dirty.length} file(s) not formatted:\n${dirty.slice(0, 15).join("\n")}` +
      `\n\nrun: bun run src/main.ts run examples/cli-tools/fmt.milo -- -w <file>`,
    );
  }
  expect(dirty.length).toBe(0);
}, 300000);

test("formatting every .milo in std/, tests/fixtures/ and src-milo/ is idempotent", () => {
  const unstable: string[] = [];
  const failed: string[] = [];
  for (const path of corpus()) {
    const src = readFileSync(path, "utf-8");
    let once = "", twice = "";
    try {
      once = fmt(src, "a");
      twice = fmt(once, "b");
    } catch (e: any) {
      // The formatter is lexical and shouldn't reject anything the compiler accepts.
      failed.push(`${path}: ${e.stderr?.toString().trim().split("\n")[0] ?? e.message}`);
      continue;
    }
    if (once !== twice) unstable.push(path);
  }
  const problems = [...failed.map(f => `crashed: ${f}`), ...unstable.map(u => `not idempotent: ${u}`)];
  if (problems.length) throw new Error(`${problems.length} file(s):\n${problems.slice(0, 15).join("\n")}`);
  expect(problems.length).toBe(0);
}, 300000);
