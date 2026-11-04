// Gates for the object column of the trace (docs/plans/object-level-assurance.md step 2):
// `milo trace-object` maps address ranges of a -g binary to source lines, @req ids and MILO-O
// rules. Bare-metal cortex-m3 images are static, so the line table is the program's own.
import { describe, expect, test as bunTest, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const test = (name: string, fn: () => void) => bunTest(name, fn, 90_000);

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "tests", "trace-object", "table.milo");
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-trace-object-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function milo(args: string[]): { code: number; out: string } {
  const r = spawnSync("bun", ["run", join(ROOT, "src", "main.ts"), ...args], { encoding: "utf-8", cwd: ROOT });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("trace-object", () => {
  test("a bounds check maps to its rule, a fn to its @req, and the trace is fully covered", () => {
    const bin = join(dir, "table.elf");
    // -O0: the optimizer would fold this whole program to a constant.
    expect(milo(["build", SRC, "--target=cortex-m3", "-g", "--debug", "-o", bin]).code).toBe(0);
    const r = milo(["trace-object", bin, "--strict", "--json"]);
    expect(r.code).toBe(0);
    const t = JSON.parse(r.out);
    const fn = (n: string) => t.functions.find((f: any) => f.name === n);
    const pick = fn("pick");
    expect(pick.ranges.some((x: any) => x.rules.includes("MILO-O-boundsCheck") && x.reqs.includes("R-1") && x.line === 3)).toBe(true);
    expect(pick.ranges.every((x: any) => x.reqs.join() === "R-1")).toBe(true);
    expect(fn("total").ranges.some((x: any) => x.rules.includes("MILO-O-overflowTrap") && x.reqs.includes("R-2"))).toBe(true);
    expect(t.untraced).toEqual([]);
    expect(t.coveredBytes).toBe(t.totalBytes);
  });

  test("a host build's compiler-generated Eq/Clone glue has the line of its type, and the pid trace is 100% covered", () => {
    const bin = join(dir, "pid-host");
    expect(milo(["build", join(ROOT, "examples", "assured", "pid", "pid.milo"), "-g", "--debug", "-o", bin]).code).toBe(0);
    const r = milo(["trace-object", bin, "--strict", "--json"]);
    expect(r.code).toBe(0);
    const t = JSON.parse(r.out);
    expect(t.untraced).toEqual([]);
    expect(t.coveredBytes).toBe(t.totalBytes);
    // the glue is in the binary (prelude's ErrorMessage and Unit) and every range has a line
    const glue = t.functions.filter((f: any) => /\$(Eq\$eq|Clone\$clone)$/.test(f.name));
    expect(glue.map((f: any) => f.name)).toContain("ErrorMessage$Eq$eq");
    expect(glue.map((f: any) => f.name)).toContain("ErrorMessage$Clone$clone");
    for (const f of glue) expect(f.ranges.every((x: any) => x.line > 0 && x.file.endsWith("prelude.milo"))).toBe(true);
  });

  test("`milo trace --object` lists the address ranges under each requirement", () => {
    const bin = join(dir, "table-trace.elf");
    expect(milo(["build", SRC, "--target=cortex-m3", "-g", "--debug", "-o", bin]).code).toBe(0);
    const r = milo(["trace", SRC, "--no-run", "--object", bin]);
    expect(r.out).toMatch(/R-1[^]*object\s+0x[0-9a-f]+-0x[0-9a-f]+ \(\d+ B\) pick/);
    expect(r.out).toMatch(/R-2[^]*object\s+0x[0-9a-f]+-0x[0-9a-f]+ \(\d+ B\) total/);
    expect(r.out).toContain("MILO-O-boundsCheck");
  });

  test("without -g every program range is untraced and --strict fails", () => {
    const bin = join(dir, "nodebug.elf");
    expect(milo(["build", SRC, "--target=cortex-m3", "--debug", "-o", bin]).code).toBe(0);
    const r = milo(["trace-object", bin, "--entry", SRC, "--strict"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no source line and no rule");
    expect(r.out).toContain("in pick");
    // Not strict: the same findings are reported without failing.
    expect(milo(["trace-object", bin, "--entry", SRC]).code).toBe(0);
  });
});
