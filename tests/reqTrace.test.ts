// Requirements traceability: @req parsing, requirements.json checks, `milo trace`, strict mode,
// the vacuous-contract warning, and the shape of the demo's `milo trace --json`.
// Every strict failure is planted in a scratch project, seen, then fixed and seen to clear.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    p.write("a.milo", CODE + `\n@derived(LLR-1)\nfn helper(): i64 {\n    return 1\n}\n`);
    expect(trace(p, "--strict").code).toBe(0);
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
    "assumptions", "baselined", "deactivated", "deadBranches", "derived", "entry", "errors", "gaps", "noImplementation", "noVerifyingTest", "ok",
    "requirements", "requirementsFile", "schema", "staleBaseline", "strict", "strictFailures", "unknown", "untracedFns",
  ]);
  expect(rep.requirements.map((q: any) => q.id)).toEqual(["HLR-1", "DR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"].sort((a, b) => ["HLR-1", "DR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"].indexOf(a) - ["HLR-1", "DR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"].indexOf(b)));
  // The harness is derived, not an implementation of HLR-1 (DO-178C: a test harness is not flight code)
  const hlr1 = rep.requirements.find((q: any) => q.id === "HLR-1");
  expect(hlr1.implementedBy.map((i: any) => i.fn)).toEqual(["controlTick"]);
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
    expect(bad.out).toContain("requirement HLR-1 is not verified: its verifying test fail (testInc)");
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

@derived(LLR-1)
pub fn main(): i32 {
    return inc(1) as i32
}
`;

test.each(["iso26262-d", "iec61508-4"])("%s: traceability is strict, so an untraced fn fails trace and a --strict build", level => {
  const p = project({ "a.milo": LIB, "a_test.milo": TEST, "requirements.json": REQS });
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
  const p = project({ "a.milo": LIB, "a_test.milo": TEST, "requirements.json": REQS });
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
    expect(adopted.code).toBe(0);
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
    p.write("a.milo", LIB.replace("fn helper(): i64\nensures", "@derived(LLR-1)\nfn helper(): i64\nensures"));
    const stale = build("--strict", "--baseline", base);
    expect(stale.code).toBe(0);
    expect(stale.out).toContain("baseline lists a gap that is fixed, remove it: untraced:helper");
  } finally { p.done(); }
}, 180000);
