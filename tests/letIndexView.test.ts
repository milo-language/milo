// `let x = v[i]` binds the element in place, with no clone, when the checker proves no one
// can tell (checker viewBindRoot / resolveViewBinds): the binding is never moved and the
// container is not written, moved or mutably borrowed while it lives. The fixtures
// letIndexView.milo and letIndexViewFallback.milo pin the behaviour; this pins the point
// of it, that the copy is really gone from the IR, and that a write brings it back.
import { test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const WORK = mkdtempSync(join(tmpdir(), "milo-letview-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

// The IR of `use` alone: the copy, if any, is a call to the element type's clone.
function useBody(body: string): string {
  const src = `struct Mark {\n    name: string,\n    tags: Vec<string>,\n}\n\nfn use(v: &mut Vec<Mark>): i64 {\n${body}\n}\n\nfn main() {\n    var v: Vec<Mark> = [Mark { name: "a", tags: ["x"] }]\n    print(use(&mut v))\n}\n`;
  const f = join(WORK, `t${Math.random().toString(36).slice(2)}.milo`);
  writeFileSync(f, src);
  const out = `${f}.ll`;
  const r = spawnSync("bun", [COMPILER, "emit-ir", f, "-o", out], { encoding: "utf8" });
  expect(r.status).toBe(0);
  const ir = readFileSync(out, "utf8");
  const m = ir.match(/^define [^\n]*@use\([\s\S]*?^}/m);
  expect(m).not.toBeNull();
  return m![0];
}

test("a read-only binding of an unwritten container calls no clone", () => {
  const ir = useBody(`    let m = v[0]\n    return m.name.len + m.tags.len`);
  expect(ir).not.toMatch(/clone/i);
});

test("writing the container while the binding lives keeps the clone", () => {
  const ir = useBody(`    let m = v[0]\n    v.push(Mark { name: "b", tags: [] })\n    return m.name.len + m.tags.len`);
  expect(ir).toMatch(/clone/i);
});

test("moving the binding keeps the clone", () => {
  const ir = useBody(`    let m = v[0]\n    v.push(m)\n    return v.len`);
  expect(ir).toMatch(/clone/i);
});
