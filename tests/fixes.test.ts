// `milo fix` and the `fix` field of `check --json` (src/fixes.ts): every mechanical
// diagnostic in one file is fixed in one command, the result is the program the author
// meant, and it compiles. Exact-text assertions, so a fix that drifts by a character
// (a lost comma in an import list, a swallowed newline) fails here rather than in a
// user's file.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function milo(args: string[]) {
  return spawnSync("bun", ["run", MAIN, ...args], { encoding: "utf8" });
}

const BEFORE = `from "std/os" import { getenv }
from "std/strconv" import { parseInt, parseFloat }

fn bump(n: &mut i64): void { n = n + 1 }

fn main(): i32 {
    var x: i64 = 1
    bump(x)
    let s = "value \${x}"
    unsafe { print(s) }
    print(strlen("hi"))
    print(parseInt("3")!)
    return 0
}
`;

const AFTER = `from "std/os" import { strlen }
from "std/strconv" import { parseInt }

fn bump(n: &mut i64): void { n = n + 1 }

fn main(): i32 {
    var x: i64 = 1
    bump(&mut x)
    let s = $"value {x}"
    print(s)
    print(strlen("hi"))
    print(parseInt("3")!)
    return 0
}
`;

test("check --json carries a fix for each mechanical diagnostic", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-fix-"));
  try {
    const src = join(dir, "p.milo");
    writeFileSync(src, BEFORE);
    const r = milo(["check", src, "--json", "--deny=unused-import"]);
    const out = JSON.parse(r.stdout);
    expect(out.schema).toBe(2);
    const fixes = Object.fromEntries(out.diagnostics.filter((d: any) => d.fix).map((d: any) => [d.code, d.fix.title]));
    expect(fixes).toEqual({
      "unused-import": "Remove 'parseFloat' from the import list",
      "implicit-mut-borrow": "Write '&mut'",
      "missing-interpolation": "Make this an interpolated string",
      "unused-unsafe": "Remove unnecessary 'unsafe'",
      "unimported": "Import 'strlen' from 'std/os'",
    });
    // Edits are 1-based line/col ranges; an insertion has an empty range.
    const mut = out.diagnostics.find((d: any) => d.code === "implicit-mut-borrow").fix.edits[0];
    expect(mut).toEqual({ line: 8, col: 10, endLine: 8, endCol: 10, newText: "&mut " });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("milo fix applies every fix and the program then compiles and runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-fix-"));
  try {
    const src = join(dir, "p.milo");
    writeFileSync(src, BEFORE);
    const r = milo(["fix", src, "--deny=unused-import"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(src, "utf8")).toBe(AFTER);
    const run = milo(["run", src, "--deny=unused-import"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("value 2\n2\n3\n");
    // Idempotent: nothing left to fix.
    expect(milo(["fix", src, "--deny=unused-import"]).stdout).toContain("0 fix(es) applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing import in an imported module is fixed there, from the entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-fix-"));
  try {
    writeFileSync(join(dir, "lib.milo"), `from "std/os" import { getenv }\npub fn n(): i64 { return strlen("abc") as i64 }\n`);
    const entry = join(dir, "main.milo");
    writeFileSync(entry, `from "./lib" import { n }\nfn main(): i32 {\n    print(n())\n    return 0\n}\n`);
    const r = milo(["fix", entry]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "lib.milo"), "utf8")).toBe(`from "std/os" import { getenv, strlen }\npub fn n(): i64 { return strlen("abc") as i64 }\n`);
    expect(milo(["run", entry]).stdout).toBe("3\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
