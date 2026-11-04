// The docs playground bundle (scripts/build-playground.ts -> docs/site/public/playground/):
// every offered example runs through the BUILT asset and must print what it claims. The bundle
// is built by `bun scripts/build-playground.ts` (the docs build does it); this test only reads it.
import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";
import { EXAMPLES } from "../docs/site/.vitepress/theme/playgroundExamples";

const bundle = resolve(import.meta.dir, "../docs/site/public/playground/milo-playground.js");
let run: (src: string) => { stdout: string; stderr: string; exitCode: number; diagnostics: { message: string; line?: number }[] };

beforeAll(async () => {
  if (!existsSync(bundle)) throw new Error("playground bundle missing: run `bun scripts/build-playground.ts`");
  run = (await import(bundle)).run;
});

for (const ex of EXAMPLES) {
  test(`playground example: ${ex.id}`, () => {
    const r = run(ex.code);
    if (ex.expect !== undefined) {
      expect(r.diagnostics.filter(d => (d as any).severity === "error")).toEqual([]);
      expect(r.stdout).toBe(ex.expect);
      expect(r.exitCode).toBe(0);
    } else {
      expect(r.exitCode).toBe(1);
      const msgs = r.diagnostics.map(d => d.message).join("\n");
      expect(msgs).toContain(ex.error!);
      expect(r.diagnostics.find(d => d.message.includes(ex.error!))?.line).toBeGreaterThan(0);
    }
  });
}

test("playground: unsupported features say so plainly", () => {
  const r = run(`pub fn main(): i32 {\n    let x = sizeOf(i64)\n    print(x)\n    return 0\n}\n`);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr + r.diagnostics.map(d => d.message).join()).toMatch(/unsupported|sizeOf/);
});

test("playground: raw memory and the in-memory filesystem work in the browser bundle", () => {
  const r = run(`from "std/os" import { malloc, free }
from "std/fs" import { readFile, writeFile }
pub fn main(): i32 {
    unsafe {
        let p = malloc(16) as *i64
        p[1] = 42
        print(p[1])
        free(p as *u8)
    }
    let _w = writeFile("note.txt", "kept in memory")
    match readFile("note.txt") {
        Result.Ok(s) => print(s),
        Result.Err(_) => print("err"),
    }
    return 0
}
`);
  expect(r.stderr).toBe("");
  expect(r.stdout).toBe("42\nkept in memory\n");
});

test("playground: std import resolves from the embedded bundle", () => {
  const r = run(`from "std/hex" import { hexChar }\npub fn main(): i32 {\n    print(hexChar(11))\n    return 0\n}\n`);
  expect(r.stderr).toBe("");
  expect(r.stdout).toBe("98\n");
});
