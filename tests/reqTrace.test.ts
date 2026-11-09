// Requirements traceability: @req parsing, requirements.json checks, `milo trace`, strict mode,
// the vacuous-contract warning, and the shape of the demo's `milo trace --json`.
// Every strict failure is planted in a scratch project, seen, then fixed and seen to clear.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { LLVM_BIN } from "../src/mlir-backend";
import { tmpdir } from "os";
import { basename, join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function milo(args: string[]): { code: number; out: string } {
  const r = spawnSync("bun", [MAIN, ...args], { encoding: "utf-8", cwd: ROOT });
  return { code: r.status ?? -1, out: strip((r.stdout ?? "") + (r.stderr ?? "")) };
}

interface Project { dir: string; write(name: string, text: string): void; entry: string; done(): void }

function project(files: Record<string, string>): Project {
  const dir = mkdtempSync(join(tmpdir(), "milo-req-"));
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  for (const [n, t] of Object.entries(files)) write(n, t);
  return { dir, write, entry: join(dir, "a.milo"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const REQS = JSON.stringify({
  requirements: [
    { id: "HLR-1", text: "the result is bigger" },
    { id: "LLR-1", parent: "HLR-1", text: "inc adds one" },
  ],
});

const CODE = `@req(LLR-1)
pub fn inc(x: i64): i64
requires x < 100
@req(LLR-1)
ensures result > x
{
    return x + 1
}
`;

const TEST = `from "std/testing" import { assertEq }
from "./a" import { inc }

@req(LLR-1)
@req(HLR-1)
fn testInc(): void {
    assertEq(inc(1), 2)
}
`;

// A derived requirement (@derived(D-1) on code, @req(D-1) on its test) for the tests that exempt a fn with @derived.
const DREQS = JSON.stringify({ requirements: [...JSON.parse(REQS).requirements, { id: "D-1", derived: true, text: "a helper the design needs" }] });
const DTEST = TEST + `\n@req(D-1)\nfn testHelper(): void {\n    assertEq(1, 1)\n}\n`;

// --no-run: most checks here are about the matrix, not the tests; the run has its own test below.
const trace = (p: Project, ...extra: string[]) => milo(["trace", p.entry, "--json", "--no-run", ...extra]);
const failures = (p: Project) => JSON.parse(trace(p, "--strict").out).strictFailures as string[];

// ── parsing ──

test("@req parses on fns, clauses and quoted ids; a bad id is a parse error", () => {
  const p = project({ "a.milo": CODE + `\n@req("LLR-1")\nfn main() {\n    print(inc(1).toString())\n}\n`, "requirements.json": REQS });
  try {
    const ast = JSON.parse(milo(["emit-ast", p.entry]).out);
    const inc = ast.functions.find((f: any) => f.name === "inc");
    expect(inc.attributes[0]).toMatchObject({ name: "req", args: ["LLR-1"] });
    expect(inc.contracts[1].attributes[0]).toMatchObject({ name: "req", args: ["LLR-1"] });
    expect(inc.contracts[0].attributes).toBeUndefined();
    expect(ast.functions.find((f: any) => f.name === "main").attributes[0].args).toEqual(["LLR-1"]);
    expect(milo(["check", p.entry]).code).toBe(0);

    p.write("a.milo", CODE.replace("@req(LLR-1)\npub fn", "@req(LLR 1)\npub fn"));
    const bad = milo(["check", p.entry]);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("is not a requirement id");

    p.write("a.milo", CODE.replace("@req(LLR-1)\npub fn", "@req()\npub fn"));
    expect(milo(["check", p.entry]).out).toContain("write a requirement id");
  } finally { p.done(); }
}, 120000);

test("an attribute before a struct's next declaration is not swallowed by the invariant parser", () => {
  const p = project({
    "a.milo": `struct Box { v: i64 }\ninvariant v >= 0\n\n@derive(Eq)\nstruct Other { w: i64 }\n\nfn main() {\n    print("ok")\n}\n`,
  });
  try { expect(milo(["check", p.entry]).code).toBe(0); } finally { p.done(); }
}, 120000);

test("@req on a clause only; @deactivated needs a reason; @assume is for fns", () => {
  const p = project({ "a.milo": CODE, "requirements.json": REQS });
  try {
    p.write("a.milo", CODE + `\n@deactivated\nfn off(): void {\n}\n`);
    expect(milo(["check", p.entry]).out).toContain("write a reason");
    p.write("a.milo", CODE.replace("@req(LLR-1)\nensures", "@assume(LLR-1)\nensures"));
    expect(milo(["check", p.entry]).out).toContain("only '@req(ID)' goes before a ensures clause");
  } finally { p.done(); }
}, 120000);

test("milo fmt leaves @req ids and clause attributes alone", () => {
  for (const file of ["pid.milo", "pid_test.milo", "pid_bad_caller.milo"]) {
    const path = join("examples", "assured", "pid", file);
    const r = milo(["fmt", path]);
    expect({ file, same: r.out === readFileSync(join(ROOT, path), "utf-8") }).toEqual({ file, same: true });
  }
}, 120000);

// ── requirements.json ──

test("requirements.json: unknown id, duplicate id, missing parent and a parent cycle are errors", () => {
  const p = project({ "a.milo": CODE.replace("@req(LLR-1)\npub fn", "@req(LLR-9)\npub fn"), "requirements.json": REQS });
  try {
    const unknown = milo(["check", p.entry]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.out).toContain("unknown requirement 'LLR-9'");

    p.write("a.milo", CODE);
    expect(milo(["check", p.entry]).code).toBe(0);

    const bad = (reqs: object[]) => { p.write("requirements.json", JSON.stringify({ requirements: reqs })); return milo(["check", p.entry]); };
    const dup = bad([{ id: "LLR-1", text: "a" }, { id: "LLR-1", text: "b" }]);
    expect(dup.out).toContain("duplicate requirement id 'LLR-1'");
    const orphan = bad([{ id: "LLR-1", parent: "HLR-7", text: "a" }]);
    expect(orphan.out).toContain("parent 'HLR-7' does not exist");
    const cycle = bad([{ id: "LLR-1", parent: "HLR-1", text: "a" }, { id: "HLR-1", parent: "LLR-1", text: "b" }]);
    expect(cycle.out).toContain("parent cycle");

    p.write("requirements.json", REQS);
    expect(milo(["check", p.entry]).code).toBe(0);
  } finally { p.done(); }
}, 120000);

// ── the matrix and strict mode ──

test("trace is a report without a profile; strict fails on each gap and each fix clears it", () => {
  const p = project({ "a.milo": CODE, "a_test.milo": TEST, "requirements.json": REQS });
  try {
    const clean = trace(p, "--strict");
    expect(clean.code).toBe(0);
    const rep = JSON.parse(clean.out);
    expect(rep.ok).toBe(true);
    const llr = rep.requirements.find((r: any) => r.id === "LLR-1");
    expect(llr.implementedBy[0].fn).toBe("inc");
    expect(llr.formalizedBy.map((c: any) => [c.kind, c.status])).toEqual([["ensures", "PROVEN"]]);
    expect(llr.verifiedBy[0].fn).toBe("testInc");
    // the parent is covered through its child
    expect(rep.requirements.find((r: any) => r.id === "HLR-1")).toMatchObject({ implemented: true, verified: true });

    // 1. a fn with no @req
    p.write("a.milo", CODE + `\nfn helper(): i64 {\n    return 1\n}\n`);
    expect((await_(failures(p))).some(m => m.includes("fn 'helper' has no @req"))).toBe(true);
    expect(trace(p).code).toBe(0); // a report run does not fail on it
    expect(trace(p, "--strict").code).toBe(1);
    p.write("requirements.json", DREQS);
    p.write("a_test.milo", DTEST);
    p.write("a.milo", CODE + `\n@derived(D-1)\nfn helper(): i64 {\n    return 1\n}\n`);
    expect(trace(p, "--strict").code).toBe(0);
    p.write("requirements.json", REQS);
    p.write("a_test.milo", TEST);
    p.write("a.milo", CODE + `\n@deactivated("flight-test hook")\nfn helper(): i64 {\n    return 1\n}\n`);
    expect(trace(p, "--strict").code).toBe(0);

    // 2. a requirement nothing implements or tests
    p.write("a.milo", CODE);
    p.write("requirements.json", JSON.stringify({ requirements: [...JSON.parse(REQS).requirements, { id: "LLR-2", text: "orphan" }] }));
    const gaps = failures(p);
    expect(gaps).toContain("requirement LLR-2 has no implementation");
    expect(gaps.some(m => m.startsWith("requirement LLR-2 is not verified"))).toBe(true);
    p.write("requirements.json", REQS);

    // 3. a clause the prover refutes
    p.write("a.milo", CODE.replace("ensures result > x", "ensures result > x + 1"));
    expect(failures(p).some(m => m.includes("ensures clause of 'inc' (LLR-1) is FAILED"))).toBe(true);
    p.write("a.milo", CODE);

    // 4. a clause the prover cannot decide (the callee has no contract, so its result is
    // unconstrained), with no test to stand behind it
    const unknownCode = "fn opaque(x: i64): i64 {\n    return x * x\n}\n\n" + CODE.replace("ensures result > x", "ensures result == opaque(x)").replace("return x + 1", "return opaque(x)");
    p.write("a.milo", unknownCode);
    p.write("a_test.milo", TEST.replace("@req(LLR-1)\n", ""));
    expect(failures(p).some(m => m.includes("is UNKNOWN"))).toBe(true);
    // ...an @assume of the same requirement accepts it
    p.write("a.milo", unknownCode.replace("@req(LLR-1)\npub fn", "@assume(LLR-1)\n@req(LLR-1)\npub fn"));
    expect(failures(p).some(m => m.includes("is UNKNOWN"))).toBe(false);
    // ...and so does a @req test of it
    p.write("a.milo", unknownCode);
    p.write("a_test.milo", TEST);
    expect(failures(p).some(m => m.includes("is UNKNOWN"))).toBe(false);
    expect(JSON.parse(trace(p).out).unknown).toBe(1);
  } finally { p.done(); }
}, 120000);

const await_ = <T>(x: T): T => x;

test("a requires clause is judged at every call site, with file:line", () => {
  const p = project({
    "a.milo": `@req(LLR-1)
fn inc(x: i64): i64
@req(LLR-1)
requires x < 100
{
    return x + 1
}

@req(LLR-1)
fn good(): i64 {
    return inc(5)
}

@req(LLR-1)
fn bad(n: i64): i64 {
    return inc(n)
}
`,
    "a_test.milo": TEST,
    "requirements.json": REQS,
  });
  try {
    const rep = JSON.parse(trace(p, "--strict").out);
    const clause = rep.requirements.find((r: any) => r.id === "LLR-1").formalizedBy[0];
    expect(clause.status).toBe("FAILED");
    const sites = clause.callSites.map((s: any) => [s.caller, s.line, s.status]).sort();
    expect(sites).toEqual([["bad", 16, "FAILED"], ["good", 11, "PROVEN"]]);
    expect(rep.strictFailures.some((m: string) => m.startsWith("a.milo:16:") && m.includes("violates LLR-1"))).toBe(true);
    // fixed: the caller proves the bound itself
    p.write("a.milo", readFixed(p));
    expect(trace(p, "--strict").code).toBe(0);
  } finally { p.done(); }
}, 120000);

function readFixed(p: Project): string {
  return readFileSync(join(p.dir, "a.milo"), "utf-8").replace("fn bad(n: i64): i64 {", "fn bad(n: i64): i64\nrequires n < 100\n{");
}

test("--safety=<profile> makes the trace strict when the profile's traceability field says so", () => {
  const p = project({ "a.milo": CODE + `\nfn helper(): i64 {\n    return 1\n}\n`, "a_test.milo": TEST, "requirements.json": REQS });
  try {
    expect(milo(["trace", p.entry, "--no-run", "--safety=do178c-a"]).code).toBe(1);
    // IEC 62304 class A sets no traceability objective: the matrix is a report there
    expect(milo(["trace", p.entry, "--no-run", "--safety=iec62304-a"]).code).toBe(0);
  } finally { p.done(); }
}, 120000);

// ── the vacuous-contract warning ──

test("vacuous-contract: a clause that proves itself warns; a real one does not", () => {
  const p = project({ "a.milo": `fn same(x: i64): i64\nensures result == result\n{\n    return x\n}\n\nfn main() {\n    print(same(1).toString())\n}\n` });
  try {
    const w = milo(["check", p.entry, "--deny=vacuous-contract"]);
    expect(w.code).not.toBe(0);
    expect(w.out).toContain("[vacuous-contract]");
    expect(milo(["explain", "vacuous-contract"]).out).toContain("true for every input");
    p.write("a.milo", `fn same(x: i64): i64\nensures result == x\n{\n    return x\n}\n\nfn main() {\n    print(same(1).toString())\n}\n`);
    expect(milo(["check", p.entry, "--deny=vacuous-contract"]).code).toBe(0);
    // NaN makes `x == x` a real claim about a float
    p.write("a.milo", `fn keep(x: f64): f64\nensures result == result\n{\n    return x\n}\n\nfn main() {\n    print("ok")\n}\n`);
    expect(milo(["check", p.entry, "--deny=vacuous-contract"]).code).toBe(0);
  } finally { p.done(); }
}, 120000);

// ── the demo ──

test("the pid demo's trace --json has the documented shape and is strict-clean", () => {
  const r = milo(["trace", "examples/assured/pid/pid.milo", "--strict", "--json"]);
  expect(r.code).toBe(0);
  const rep = JSON.parse(r.out);
  expect(Object.keys(rep).sort()).toEqual([
    "assumptions", "baselined", "coarseTrace", "deactivated", "deadBranches", "derived", "entry", "errors", "gaps", "noImplementation", "noVerifyingTest", "ok",
    "requirements", "requirementsFile", "schema", "staleBaseline", "strayEvidence", "strict", "strictFailures", "tooCoarse", "unknown", "untracedFns",
  ]);
  expect(rep.requirements.map((q: any) => q.id)).toEqual(["HLR-1", "DR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"].sort((a, b) => ["HLR-1", "DR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"].indexOf(a) - ["HLR-1", "DR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"].indexOf(b)));
  // The harness is derived, not an implementation of HLR-1 (DO-178C: a test harness is not flight code)
  const hlr1 = rep.requirements.find((q: any) => q.id === "HLR-1");
  // controlTick links to the child it implements (LLR-3), not to the parent: HLR-1 is traced through its children
  expect(hlr1).toMatchObject({ implemented: true, implementedBy: [] });
  expect(rep.requirements.find((q: any) => q.id === "LLR-3").implementedBy.map((i: any) => i.fn)).toContain("controlTick");
  expect(rep.requirements.find((q: any) => q.id === "DR-1").implementedBy.map((i: any) => i.fn)).toEqual(["demoCommand", "main"]);
  // every @req test ran and passed
  expect(rep.requirements.flatMap((q: any) => q.verifiedBy).every((t: any) => t.result === "PASS")).toBe(true);
  const llr3 = rep.requirements.find((q: any) => q.id === "LLR-3");
  const pidReq = llr3.formalizedBy.find((c: any) => c.fn === "pidStep" && c.text.includes("measured"));
  expect(pidReq.status).toBe("PROVEN");
  expect(pidReq.callSites.every((s: any) => s.status === "PROVEN" && s.line > 0 && s.file.endsWith(".milo"))).toBe(true);
  expect(rep.unknown).toBe(0);
}, 120000);

test("the pid demo's bad caller shows a FAILED call-site obligation", () => {
  const r = milo(["trace", "examples/assured/pid/pid_bad_caller.milo", "--strict", "--json", "--no-run"]);
  expect(r.code).toBe(1);
  const rep = JSON.parse(r.out);
  const sites = rep.requirements.flatMap((q: any) => q.formalizedBy).flatMap((c: any) => c.callSites ?? []);
  const failed = sites.filter((s: any) => s.status === "FAILED");
  expect(failed.map((s: any) => [s.caller, s.file])).toEqual([["controlTickUnclamped", "pid_bad_caller.milo"]]);
}, 120000);

// ── DO-333: what verifies a requirement ──

const verification = (p: Project, id: string) => JSON.parse(trace(p, "--strict").out).requirements.find((r: any) => r.id === id).verification;

test("DO-333: a proven low-level requirement needs no test; a high-level one and an unformalized one do", () => {
  const noTests = (extra?: string) => ({ "a.milo": CODE + (extra ?? ""), "requirements.json": REQS });
  // 1. LLR-1 has a PROVEN clause and no test; HLR-1 (its parent) has a test of its own
  const p = project({ ...noTests(), "a_test.milo": TEST.replace("@req(LLR-1)\n", "") });
  try {
    expect(trace(p, "--strict").code).toBe(0);
    expect(verification(p, "LLR-1")).toBe("proof");
    expect(verification(p, "HLR-1")).toBe("test");

    // 2. the parent's children are all proven, but it has no test of its own: strict fails
    p.write("a_test.milo", "");
    const rep = JSON.parse(trace(p, "--strict").out);
    expect(rep.ok).toBe(false);
    expect(rep.strictFailures.some((m: string) => m.startsWith("requirement HLR-1 is not verified") && m.includes("needs a passing test of its own"))).toBe(true);
    expect(rep.strictFailures.some((m: string) => m.includes("LLR-1"))).toBe(false);

    const bare = project({ "a.milo": `@req(LLR-1)\nfn inc(x: i64): i64 {\n    return x + 1\n}\n`, "requirements.json": REQS, "a_test.milo": TEST.replace("@req(LLR-1)\n", "") });
    try {
      const b = JSON.parse(trace(bare, "--strict").out);
      expect(b.strictFailures.some((m: string) => m.startsWith("requirement LLR-1 is not verified") && m.includes("no formalizing clause and no test"))).toBe(true);
      bare.write("a_test.milo", TEST);
      expect(verification(bare, "LLR-1")).toBe("test");
      expect(trace(bare, "--strict").code).toBe(0);
    } finally { bare.done(); }
  } finally { p.done(); }
}, 120000);

// ── the tests are run ──

test("trace runs each @req test: PASS/FAIL rows, a failing test is a strict error, --no-run skips them", () => {
  const p = project({ "a.milo": CODE, "a_test.milo": TEST, "requirements.json": REQS });
  const run = (...extra: string[]) => milo(["trace", p.entry, ...extra]);
  try {
    const ok = run("--strict");
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/verified\s+PASS\s+a_test\.milo:\d+ testInc/);

    p.write("a_test.milo", TEST.replace("assertEq(inc(1), 2)", "assertEq(inc(1), 3)"));
    const bad = run("--strict");
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/verified\s+FAIL\s+a_test\.milo:\d+ testInc/);
    expect(bad.out).toContain("test 'testInc' (HLR-1) FAILED");
    // HLR-1's only test fails, so it is unverified (LLR-1 still stands on its proof)
    expect(bad.out).toContain("requirement HLR-1 is not verified: its verifying test fails (testInc)");
    // a report run lists it but does not fail
    expect(run().code).toBe(0);
    // --no-run does not execute it
    const skipped = run("--strict", "--no-run");
    expect(skipped.code).toBe(0);
    expect(skipped.out).toMatch(/verified\s+NOT RUN\s+a_test\.milo:\d+ testInc/);
  } finally { p.done(); }
}, 120000);

// ── the profile's traceability field, and how hard a build enforces it ──

const LIB = `@req(LLR-1)
pub fn inc(x: i64): i64
requires x < 100
@req(LLR-1)
ensures result > x
{
    return x + 1
}

fn helper(): i64
ensures result == 1
{
    return 1
}

@derived(D-1)
pub fn main(): i32 {
    return inc(1) as i32
}
`;

test.each(["iso26262-d", "iec61508-4"])("%s: traceability is strict, so an untraced fn fails trace and a --strict build", level => {
  const p = project({ "a.milo": LIB, "a_test.milo": DTEST, "requirements.json": DREQS });
  try {
    const t = milo(["trace", p.entry, "--no-run", `--safety=${level}`]);
    expect(t.code).toBe(1);
    expect(t.out).toContain("fn 'helper' has no @req");
    const b = milo(["build", p.entry, `--safety=${level}`, "--strict", "-o", join(p.dir, "out")]);
    expect(b.code).toBe(1);
    expect(b.out).toContain("fn 'helper' has no @req");
  } finally { p.done(); }
}, 120000);

test("milo safety --list names the traceability and coverage fields", () => {
  const out = milo(["safety", "--list"]).out;
  expect(out).toMatch(/do178c-a .*\[traceability strict, coverage mcdc\]/);
  expect(out).toMatch(/iec62304-a .*\[traceability report, coverage statement\]/);
});

test("a dev build warns about a traceability gap and succeeds; --strict fails; a baseline keeps it a warning", () => {
  const p = project({ "a.milo": LIB, "a_test.milo": DTEST, "requirements.json": DREQS });
  const build = (...extra: string[]) => milo(["build", p.entry, "--safety=iec62304-b", "-o", join(p.dir, "out"), ...extra]);
  try {
    const dev = build();
    expect(dev.code).toBe(0);
    expect(dev.out).toContain("warning: traceability gap: a.milo:10: fn 'helper' has no @req");

    const strict = build("--strict");
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("error: a.milo:10: fn 'helper' has no @req");

    // adopt the profile on the existing code: the gap is recorded, strict passes with a warning
    const base = join(p.dir, "baseline.json");
    const w = milo(["trace", p.entry, "--no-run", "--write-baseline", base]);
    expect(w.code).toBe(0);
    expect(JSON.parse(readFileSync(base, "utf-8")).gaps).toEqual(["untraced:helper"]);
    const adopted = build("--strict", "--baseline", base);
    expect(adopted.code, adopted.out.slice(0, 2000)).toBe(0);
    expect(adopted.out).toContain("warning: baselined traceability gap: a.milo:10: fn 'helper' has no @req");

    // a NEW gap is not in the baseline and fails
    p.write("a.milo", LIB + `\nfn another(): i64\nensures result == 2\n{\n    return 2\n}\n`);
    const fresh = build("--strict", "--baseline", base);
    expect(fresh.code).toBe(1);
    expect(fresh.out).toContain("fn 'another' has no @req");
    expect(fresh.out).not.toContain("error: a.milo:10");

    // the baseline only shrinks: it cannot be rewritten with the new gap in it...
    const grow = milo(["trace", p.entry, "--no-run", "--write-baseline", base]);
    expect(grow.code).toBe(1);
    expect(grow.out).toContain("a baseline can only shrink");
    // ...and a fixed gap that is still listed is reported stale
    p.write("a.milo", LIB.replace("fn helper(): i64\nensures", "@derived(D-1)\nfn helper(): i64\nensures"));
    const stale = build("--strict", "--baseline", base);
    expect(stale.code).toBe(0);
    expect(stale.out).toContain("baseline lists a gap that is fixed, remove it: untraced:helper");
  } finally { p.done(); }
}, 180000);

// ── module layout ──

// std/json.milo keeps its requirements and tests in std/json/. The directory the entry sits in
// is a pile of other modules, so only the entry file and its own directory are the project.
test("a single-file module finds m/requirements.json and ignores its neighbours", () => {
  const p = project({
    "a.milo": CODE,
    "neighbour.milo": `pub fn untraced(x: i64): i64 {\n    return x\n}\n`,
  });
  try {
    mkdirSync(join(p.dir, "a"));
    writeFileSync(join(p.dir, "a", "requirements.json"), REQS);
    writeFileSync(join(p.dir, "a", "a_test.milo"), TEST.replace(`"./a"`, `"../a"`));
    const rep = JSON.parse(trace(p, "--strict").out);
    expect(rep.requirementsFile).toContain(join("a", "requirements.json"));
    expect(rep.untracedFns).toEqual([]);
    const llr = rep.requirements.find((r: any) => r.id === "LLR-1");
    expect(llr.implementedBy.map((s: any) => s.fn)).toEqual(["inc"]);
    expect(llr.verifiedBy.map((s: any) => s.fn)).toEqual(["testInc"]);
    // a requirements.json beside the entry still wins over the module directory
    p.write("requirements.json", JSON.stringify({ requirements: [{ id: "OTHER", text: "x" }] }));
    // Anchored on the directory: the random temp dir name can itself end in "a".
    expect(JSON.parse(trace(p).out).requirementsFile).toEndWith(join(basename(p.dir), "requirements.json"));
  } finally { p.done(); }
}, 120000);

// std/json is the worked module: its trace must stay strict-clean (the matrix in
// docs/site/stdlib/json.md is condensed from it), and the doc must name every requirement.
// The tests are not run here (json_test.milo has its own gate); everything else is.
test("milo trace std/json.milo --strict is ok and docs/site/stdlib/json.md lists every requirement", () => {
  const r = JSON.parse(milo(["trace", "std/json.milo", "--json", "--no-run", "--strict"]).out);
  expect({ ok: r.ok, failures: r.strictFailures, errors: r.errors }).toEqual({ ok: true, failures: [], errors: [] });
  expect(r.requirements.length).toBeGreaterThan(30);
  expect(r.untracedFns).toEqual([]);
  const doc = readFileSync(join(ROOT, "docs", "site", "stdlib", "json.md"), "utf-8");
  const missing = r.requirements.map((q: any) => q.id).filter((id: string) => !doc.includes("`" + id + "`"));
  expect(missing).toEqual([]);
}, 180000);

// ── strict: coarse traces and tests that cannot fail ──

test("strict: a file-level @!req is a coarse trace and a parent-only link is too coarse; own child links clear both", () => {
  const bare = CODE.replace(/@req\(LLR-1\)\n/g, "");
  const p = project({ "a.milo": `@!req(LLR-1)\n\n${bare}`, "a_test.milo": TEST, "requirements.json": REQS });
  try {
    // dev mode lists the fn but does not fail
    const dev = JSON.parse(trace(p).out);
    expect(dev.ok).toBe(true);
    expect(dev.coarseTrace.map((f: any) => f.fn)).toEqual(["inc"]);
    expect(dev.untracedFns).toEqual([]);
    expect(milo(["trace", p.entry, "--no-run"]).out).toContain("coarse trace");
    // strict fails on it
    expect(failures(p).some(m => m.includes("fn 'inc' is traced only by a file-level @!req"))).toBe(true);
    // a fn's own @req clears it, even beside the file-level one
    p.write("a.milo", `@!req(LLR-1)\n\n${CODE}`);
    expect(trace(p, "--strict").code).toBe(0);

    // only the parent: too coarse
    p.write("a.milo", CODE.replace("@req(LLR-1)\npub fn", "@req(HLR-1)\npub fn"));
    const coarse = failures(p);
    expect(coarse.some(m => m.includes("fn 'inc' traces too coarsely: HLR-1 has child requirements"))).toBe(true);
    expect(JSON.parse(trace(p).out).tooCoarse.map((f: any) => f.fn)).toEqual(["inc"]);
    p.write("a.milo", CODE);
    expect(trace(p, "--strict").code).toBe(0);
  } finally { p.done(); }
}, 120000);

test("strict: a requirement with no formalizing clause needs a verifying test that can fail", () => {
  const noClause = "@req(LLR-1)\npub fn inc(x: i64): i64 {\n    return x + 1\n}\n";
  const noAssert = TEST.replace("assertEq(inc(1), 2)", "let _y = inc(1)");
  const p = project({ "a.milo": noClause, "a_test.milo": noAssert, "requirements.json": REQS });
  try {
    const rep = JSON.parse(trace(p, "--strict").out);
    expect(rep.strictFailures.some((m: string) => m.includes("requirement LLR-1 has no formalizing clause") && m.includes("cannot fail"))).toBe(true);
    expect(rep.requirements.find((r: any) => r.id === "LLR-1").verifiedBy[0].cannotFail).toBe(true);
    expect(trace(p).code).toBe(0); // a report run only lists it
    expect(milo(["trace", p.entry, "--no-run"]).out).toContain("cannot fail");

    // an assertion in a helper the test calls counts
    p.write("a_test.milo", noAssert.replace("let _y = inc(1)", "check(inc(1))") + `\nfn check(v: i64): void {\n    assertEq(v, 2)\n}\n`);
    expect(trace(p, "--strict").code).toBe(0);
    // so does one in the test itself
    p.write("a_test.milo", TEST);
    expect(trace(p, "--strict").code).toBe(0);

    // a proven clause is the evidence instead, so the assertion-free test is not flagged
    p.write("a.milo", CODE);
    p.write("a_test.milo", noAssert);
    // (the parent HLR-1 has no clause, so its assertion-free test is still flagged)
    expect(failures(p).filter(m => m.includes("cannot fail")).map(m => m.split(" ")[1])).toEqual(["HLR-1"]);
  } finally { p.done(); }
}, 120000);

// ── requirements.json schema: fixed fields, derived, verification ──

const reqs = (...rs: object[]) => JSON.stringify({ requirements: rs });
const errorsOf = (p: Project) => JSON.parse(trace(p).out).errors as string[];

test("schema: an unknown field is an error naming the file and the requirement", () => {
  const p = project({ "a.milo": CODE, "requirements.json": reqs({ id: "HLR-1", text: "t", priority: "high" }) });
  try {
    const errs = errorsOf(p);
    expect(errs.some(e => e.includes("requirements.json") && e.includes("'HLR-1'") && e.includes("unknown field 'priority'"))).toBe(true);
    p.write("requirements.json", reqs({ id: "HLR-1", text: "t", kind: "timing", source: "RFC 1" }));
    expect(errorsOf(p).filter(e => e.includes("unknown field"))).toEqual([]);
    p.write("requirements.json", reqs({ id: "HLR-1", text: "t", kind: "speedy" }));
    expect(errorsOf(p).some(e => e.includes('"kind" must be one of'))).toBe(true);
    p.write("requirements.json", reqs({ id: "D-1", text: "t", derived: true, parent: "HLR-1" }, { id: "HLR-1", text: "t" }));
    expect(errorsOf(p).some(e => e.includes("derived requirement may not have a parent"))).toBe(true);
  } finally { p.done(); }
});

test("derived: @derived needs a derived requirement and @req rejects one", () => {
  const plain = reqs({ id: "R-1", text: "t" });
  const derived = reqs({ id: "R-1", text: "t", derived: true });
  const p = project({ "a.milo": "@derived(R-1)\nfn f(): i64 {\n    return 1\n}\n", "requirements.json": plain });
  try {
    expect(errorsOf(p).some(e => e.includes("@derived(R-1)") && e.includes('not "derived": true'))).toBe(true);
    p.write("requirements.json", derived);
    expect(errorsOf(p)).toEqual([]);
    p.write("a.milo", "@req(R-1)\nfn f(): i64 {\n    return 1\n}\n");
    expect(errorsOf(p).some(e => e.includes("@req(R-1)") && e.includes("derived requirement"))).toBe(true);
  } finally { p.done(); }
});

test("verification: [\"analysis\"] needs a PROVEN clause under --strict; absent keeps the default rules", () => {
  const noClause = "@req(LLR-1)\npub fn inc(x: i64): i64 {\n    return x + 1\n}\n";
  const decl = (verification?: object[]) => reqs({ id: "HLR-1", text: "t" }, { id: "LLR-1", parent: "HLR-1", text: "t", ...(verification ? { verification } : {}) });
  const p = project({ "a.milo": noClause, "a_test.milo": TEST, "requirements.json": decl([{ method: "analysis" }]) });
  try {
    expect(failures(p).some(m => m.includes("LLR-1") && m.includes('"analysis"'))).toBe(true);
    p.write("requirements.json", decl());
    expect(failures(p).filter(m => m.includes('"analysis"'))).toEqual([]);
    p.write("a.milo", CODE);
    p.write("requirements.json", decl([{ method: "analysis" }]));
    expect(failures(p).filter(m => m.includes('"analysis"'))).toEqual([]);
  } finally { p.done(); }
}, 120000);

// ── presets: milo.json "profile": "app" | "hardened" ──

const MAIN_FN = `\n@req(LLR-1)\nfn main() {\n    print(inc(1).toString())\n}\n`;
const manifest = (profile: string) => JSON.stringify({ name: "t", version: "0.1.0", profile });
const build = (p: Project, ...extra: string[]) => milo(["build", p.entry, "-o", join(p.dir, "out"), ...extra]);

test("preset hardened: unsafe outside std and a failing prove --rte are errors; app is not", () => {
  const unsafeSrc = `fn main() {\n    unsafe {\n        print("x")\n    }\n}\n`;
  const overflowSrc = `fn f(a: i64, b: i64): i64 {\n    return a + b\n}\n\nfn main() {\n    print(f(1, 2).toString())\n}\n`;
  const p = project({ "a.milo": unsafeSrc, "milo.json": manifest("hardened") });
  try {
    const bad = build(p);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("hardened allows unsafe only inside std");
    p.write("a.milo", overflowSrc);
    const rte = build(p);
    expect(rte.code).toBe(1);
    expect(rte.out).toContain("runtime-error proof(s) failed under profile hardened");
    // the same sources build under app, and under no profile at all
    p.write("milo.json", manifest("app"));
    expect(build(p).code).toBe(0);
    p.write("a.milo", unsafeSrc);
    expect(build(p).code).toBe(0);
    // the flag spells the same preset, and wins over the manifest
    expect(build(p, "--safety=hardened").code).toBe(1);
    p.write("milo.json", manifest("hardened"));
    expect(build(p, "--safety=app").code).toBe(0);
  } finally { p.done(); }
}, 240000);

test("preset app: requirement gaps are warnings, --strict fails on new ones, a baseline accepts today's", () => {
  const p = project({ "a.milo": CODE + MAIN_FN + `\nfn helper(): i64 {\n    return 1\n}\n`, "a_test.milo": TEST, "requirements.json": REQS, "milo.json": manifest("app") });
  try {
    const dev = build(p);
    expect(dev.code).toBe(0);
    expect(dev.out).toContain("traceability gap");
    expect(dev.out).toContain("under profile app");
    const strict = build(p, "--strict");
    expect(strict.code).toBe(1);
    expect(strict.out).toContain("fn 'helper' has no @req");
    expect(strict.out).toContain("under profile app");
    const base = join(p.dir, "gaps.json");
    expect(milo(["trace", p.entry, "--no-run", "--write-baseline", base]).code).toBe(0);
    expect(build(p, "--strict", "--baseline", base).code).toBe(0);
    // a NEW gap is not in the baseline
    p.write("a.milo", CODE + MAIN_FN + `\nfn helper(): i64 {\n    return 1\n}\n\nfn another(): i64 {\n    return 2\n}\n`);
    const fresh = build(p, "--strict", "--baseline", base);
    expect(fresh.code).toBe(1);
    expect(fresh.out).toContain("fn 'another' has no @req");
    // no object checks: the binary is not pinned or re-verified
    expect(fresh.out).not.toContain("does not satisfy");
  } finally { p.done(); }
}, 240000);

test("milo trace reads milo.json's profile when there is no --safety flag", () => {
  const gappy = CODE + `\nfn helper(): i64 {\n    return 1\n}\n`;
  const p = project({ "a.milo": gappy, "a_test.milo": TEST, "requirements.json": REQS, "milo.json": manifest("app") });
  try {
    // a preset labels the report; the gap fails only under --strict
    const app = JSON.parse(trace(p).out);
    expect(app.profile).toBe("app");
    expect(app.strict).toBe(false);
    expect(trace(p).code).toBe(0);
    expect(milo(["trace", p.entry, "--no-run"]).out).toContain("[profile app]");
    // a certification profile with strict traceability makes the trace strict by itself
    p.write("milo.json", manifest("do178c-b"));
    expect(trace(p).code).toBe(1);
    // ...unless --safety names another profile
    expect(trace(p, "--safety=iec62304-a").code).toBe(0);
  } finally { p.done(); }
}, 240000);

test("milo safety --list names the presets", () => {
  const out = milo(["safety", "--list"]).out;
  expect(out).toContain("presets");
  expect(out).toMatch(/\n\s+app\s+requirements reported/);
  expect(out).toMatch(/\n\s+hardened\s+app, plus prove --rte/);
});

// trace hands `milo test` an absolute path, where names are module-mangled; a test tagging a derived
// requirement must still count as a test, or the whole file stops compiling under trace.
test("a test may @req a derived requirement when reached by absolute path", () => {
  const file = join(import.meta.dir, "..", "std", "json", "json_test.milo");
  const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "main.ts"), "test", "--json", file, "-t", "^(testAccessors)$"], { encoding: "utf-8" });
  expect(JSON.parse(r.stdout).passed).toBe(1);
}, 60000);

// ── --coverage: statement coverage of the implementing fn bodies by the @req tests ──

const HAVE_LLVM_COV = existsSync(join(LLVM_BIN, "llvm-cov"));
if (!HAVE_LLVM_COV) console.log(`skipping the coverage tests: no llvm-cov in ${LLVM_BIN} (set MILO_LLVM_BIN)`);
const covTest = HAVE_LLVM_COV ? test : test.skip; // no llvm-cov: --coverage cannot build its report

const CLAMP = `@req(LLR-1)
pub fn clamp(x: i64): i64
requires x < 1000
requires x > -1000
@req(LLR-1)
ensures result >= 0
@req(LLR-1)
ensures result < 1000
{
    if x < 0 {
        return 0
    }
    return x
}
`;
const lineOf = (src: string, needle: string) => src.split("\n").findIndex(l => l.includes(needle)) + 1;
const CLAMP_TESTS = (neg: boolean) => `from "std/testing" import { assertEq }
from "./a" import { clamp }

@req(LLR-1)
@req(HLR-1)
fn testPositive(): void {
    assertEq(clamp(5), 5)
}
${neg ? `
@req(LLR-1)
fn testNegative(): void {
    assertEq(clamp(-5), 0)
}
` : ""}`;
const cov = (p: Project, ...extra: string[]) => milo(["trace", p.entry, "--coverage", ...extra]);

covTest("coverage: both branches tested is 100% and passes strict; contract lines are never counted", () => {
  const p = project({ "a.milo": CLAMP, "a_test.milo": CLAMP_TESTS(true), "requirements.json": REQS });
  try {
    const r = cov(p, "--strict");
    expect(r.out).toContain("line coverage: 100.0% (3/3)");
    expect(r.code).toBe(0);
    // 4 contract clauses sit between the signature and the `{`; only the 3 body statements count
    const j = JSON.parse(cov(p, "--json").out);
    expect(j.coverage.fns).toEqual([{ fn: "clamp", file: "a.milo", line: 2, covered: 3, total: 3, uncovered: [] }]);
  } finally { p.done(); }
}, 240000);

covTest("coverage: an untested branch fails strict and names its exact line; a baseline adopts it, a new one fails", () => {
  const p = project({ "a.milo": CLAMP, "a_test.milo": CLAMP_TESTS(false), "requirements.json": REQS });
  try {
    const want = lineOf(CLAMP, "return 0");
    const r = cov(p, "--strict");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`line not covered by any requirement test: a.milo:${want} clamp`);
    expect(r.out).toContain("line coverage: 66.7% (2/3)");
    expect(r.out.match(/line not covered by any requirement test/g)!.length).toBe(1);
    // report mode still exits 0
    expect(cov(p).code).toBe(0);

    const base = join(p.dir, "baseline.json");
    expect(milo(["trace", p.entry, "--coverage", "--write-baseline", base]).code).toBe(0);
    expect(JSON.parse(readFileSync(base, "utf-8")).gaps).toContain(`coverage:a.milo:${want}`);
    const adopted = cov(p, "--strict", "--baseline", base);
    expect(adopted.code).toBe(0);
    expect(adopted.out).toContain(`warning: baselined gap: line not covered by any requirement test: a.milo:${want} clamp`);

    // a newly uncovered line is not in the baseline
    const grown = CLAMP.replace("return x\n", "if x > 500 {\n        return 500\n    }\n    return x\n");
    p.write("a.milo", grown);
    const fresh = cov(p, "--strict", "--baseline", base);
    expect(fresh.code).toBe(1);
    expect(fresh.out).toContain(`a.milo:${lineOf(grown, "return 500")} clamp`);
  } finally { p.done(); }
}, 240000);

covTest("coverage: a fn no test calls lists every body line, not 0 of 0", () => {
  const unused = `
@req(LLR-1)
pub fn unused(x: i64): i64 {
    let y = x + 1
    return y * 2
}
`;
  const src = CLAMP + unused;
  const p = project({ "a.milo": src, "a_test.milo": CLAMP_TESTS(true), "requirements.json": REQS });
  try {
    const j = JSON.parse(cov(p, "--json").out);
    const fn = j.coverage.fns.find((f: any) => f.fn === "unused");
    expect(fn).toMatchObject({ covered: 0, total: 2, uncovered: [lineOf(src, "let y"), lineOf(src, "return y * 2")] });
  } finally { p.done(); }
}, 240000);

covTest("coverage: no data is an error, never a pass; a missing llvm-cov is named; --no-run is a usage error", () => {
  const p = project({ "a.milo": CLAMP, "a_test.milo": CLAMP_TESTS(true), "requirements.json": REQS });
  try {
    // tests pointed at an empty dir: no process runs, so no .gcda exists
    const empty = join(p.dir, "none");
    mkdirSync(empty);
    const r = cov(p, "--strict", "--tests", empty);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no test process wrote coverage data");
    expect(r.out).not.toContain("line coverage: 100");

    const tool = spawnSync("bun", [MAIN, "trace", p.entry, "--coverage"], { encoding: "utf-8", cwd: ROOT, env: { ...process.env, MILO_LLVM_BIN: join(p.dir, "nollvm") } });
    expect(tool.status).toBe(1);
    expect(strip(tool.stderr + tool.stdout)).toContain("llvm-cov not found");

    const usage = milo(["trace", p.entry, "--coverage", "--no-run"]);
    expect(usage.code).toBe(1);
    expect(usage.out).toContain("--coverage needs the tests to run");
  } finally { p.done(); }
}, 240000);
