// Dead-branch detection (src/dead.ts): a branch is reported only when the solver proves its
// path condition unsatisfiable. Soundness is the point: a reachable branch reported dead would
// tell a certifier to delete live code, so every "not dead" case here is as important as the
// dead ones, and the planted-solver test shows the reachable case is what goes red.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { findDeadBranches } from "../src/dead";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

const dead = (src: string, o: Parameters<typeof findDeadBranches>[2] = {}) =>
  findDeadBranches(new Parser(new Lexer(src).tokenize(), src, "t.milo").parse(), undefined, o);
const lines = (src: string, o?: Parameters<typeof findDeadBranches>[2]) => dead(src, o).map(d => `${d.fn}:${d.line}`);

const REQUIRES = `pub fn f(x: i64): i64
requires x > 5
{
    if x < 3 {
        return 1
    }
    return 2
}
`;

const CONTRADICTING_GUARDS = `pub fn f(x: i64): i64 {
    if x > 10 {
        if x < 5 {
            return 1
        }
        return 2
    }
    return 3
}
`;

const REACHABLE = `pub fn f(x: i64): i64 {
    if x > 10 {
        return 1
    } else {
        return 2
    }
}
`;

test("a branch made unreachable by a requires is dead, and the report names the contradiction", () => {
  const d = dead(REQUIRES);
  expect(d.map(x => x.line)).toEqual([4]);
  expect(d[0]!.why).toContain("requires x > 5");
  expect(d[0]!.why).toContain("x < 3");
});

test("a guard contradicting an earlier guard is dead; the outer branch is not", () => {
  expect(lines(CONTRADICTING_GUARDS)).toEqual(["f:3"]);
});

test("a branch reachable for some input is not dead (both arms)", () => {
  expect(dead(REACHABLE)).toEqual([]);
});

test("sequential ifs: the path through the first then-arm rules the second out, the else path does not", () => {
  // Found on examples/embedded/flightController.milo: `if k == UP {..}` then `if k == DOWN {..}`
  // has an infeasible PATH to the second branch, but the branch itself runs when k == DOWN.
  const src = `pub fn f(k: i64): i64 {
    var t = 0
    if k == 1 {
        t = t + 1
    }
    if k == 2 {
        t = t + 2
    }
    return t
}
`;
  expect(dead(src)).toEqual([]);
});

test("a branch the solver cannot decide is not reported", () => {
  // x * y is nonlinear: std/smt bounds the product and answers unknown for a satisfiable query.
  const src = `pub fn f(x: i64, y: i64): i64 {
    if x * y == 7 {
        return 1
    }
    return 2
}
`;
  expect(dead(src)).toEqual([]);
});

test("a loop body that cannot run is dead; one that can is not", () => {
  const body = (range: string) => `pub fn f(): i64 {
    var s = 0
    for i in ${range} {
        s = s + i
    }
    return s
}
`;
  expect(lines(body("0..0"))).toEqual(["f:3"]);
  expect(dead(body("0..3"))).toEqual([]);
});

test("a branch nested in a dead branch is reported once, as the outer one", () => {
  const src = `pub fn f(x: i64): i64
requires x > 5
{
    if x < 3 {
        if x < 2 {
            return 0
        }
        return 1
    }
    return 2
}
`;
  expect(lines(src)).toEqual(["f:4"]);
});

test("planted: a solver that calls everything dead turns the reachable case red", () => {
  const everything = { solve: (vcs: unknown[]) => vcs.map(() => "proven" as const) };
  // The oracle works only if the reachable program is distinguishable from a dead one.
  expect(dead(REACHABLE, everything).length).toBeGreaterThan(0);
  expect(dead(REACHABLE)).toEqual([]);
});

// ── trace: the matrix line, strict mode, @deactivated, baseline ──

function project(code: string) {
  const dir = mkdtempSync(join(tmpdir(), "milo-dead-"));
  writeFileSync(join(dir, "requirements.json"), JSON.stringify({ requirements: [{ id: "HLR-1", text: "t" }, { id: "LLR-1", parent: "HLR-1", text: "t" }] }));
  writeFileSync(join(dir, "a.milo"), code);
  return { dir, entry: join(dir, "a.milo"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const trace = (entry: string, ...extra: string[]) => {
  const r = spawnSync("bun", [MAIN, "trace", entry, "--json", "--no-run", ...extra], { encoding: "utf-8", cwd: ROOT });
  return { code: r.status ?? -1, rep: JSON.parse(r.stdout) };
};
const traced = (attr: string) => `@req(LLR-1)
${attr}pub fn f(x: i64): i64
requires x > 5
{
    if x < 3 {
        return 1
    }
    return 2
}
`;

test("trace lists the dead branch; strict fails on it; @deactivated and a baseline clear it", () => {
  const p = project(traced(""));
  try {
    const loose = trace(p.entry);
    expect(loose.rep.deadBranches.map((d: any) => d.line)).toEqual([5]);
    const strict = trace(p.entry, "--strict");
    expect(strict.code).toBe(1);
    expect(strict.rep.gaps.map((g: any) => g.key)).toContain("dead:a.milo:f:5");

    // The scratch project has unrelated gaps (no tests); a baseline of those isolates the dead one.
    const keys = strict.rep.gaps.map((g: any) => g.key) as string[];
    const others = join(p.dir, "others.json"), all = join(p.dir, "all.json");
    writeFileSync(others, JSON.stringify({ schema: 1, gaps: keys.filter(k => !k.startsWith("dead:")) }));
    writeFileSync(all, JSON.stringify({ schema: 1, gaps: keys }));
    expect(trace(p.entry, "--strict", "--baseline", others).code).toBe(1);
    expect(trace(p.entry, "--strict", "--baseline", all).code).toBe(0);

    writeFileSync(p.entry, traced(`@deactivated("flight-test hook")\n`));
    const off = trace(p.entry, "--strict", "--baseline", others);
    expect(off.code).toBe(0);
    expect(off.rep.deadBranches[0].reason).toBe("flight-test hook");
  } finally { p.done(); }
});
