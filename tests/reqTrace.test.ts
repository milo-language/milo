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

// Linear on purpose: the default solver (std/smt) proves it, so no z3 is needed.
const CODE = `@req(LLR-1)
fn inc(x: i64): i64
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
fn testInc(): void {
    assertEq(inc(1), 2)
}
`;

const trace = (p: Project, ...extra: string[]) => milo(["trace", p.entry, "--json", ...extra]);
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

    p.write("a.milo", CODE.replace("@req(LLR-1)\nfn", "@req(LLR 1)\nfn"));
    const bad = milo(["check", p.entry]);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("is not a requirement id");

    p.write("a.milo", CODE.replace("@req(LLR-1)\nfn", "@req()\nfn"));
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
  const p = project({ "a.milo": CODE.replace("@req(LLR-1)\nfn", "@req(LLR-9)\nfn"), "requirements.json": REQS });
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
    expect(gaps).toContain("requirement LLR-2 has no verifying test");
    p.write("requirements.json", REQS);

    // 3. a clause the prover refutes
    p.write("a.milo", CODE.replace("ensures result > x", "ensures result > x + 1"));
    expect(failures(p).some(m => m.includes("ensures clause of 'inc' (LLR-1) is FAILED"))).toBe(true);
    p.write("a.milo", CODE);

    // 4. a clause the prover cannot decide (nonlinear for std/smt), with no test to stand behind it
    const unknownCode = CODE.replace("ensures result > x", "ensures result == x * x").replace("return x + 1", "return x * x");
    p.write("a.milo", unknownCode);
    p.write("a_test.milo", TEST.replace("@req(LLR-1)\n", ""));
    expect(failures(p).some(m => m.includes("is UNKNOWN"))).toBe(true);
    // ...an @assume of the same requirement accepts it
    p.write("a.milo", unknownCode.replace("@req(LLR-1)\nfn", "@assume(LLR-1)\n@req(LLR-1)\nfn"));
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

test("--safety=do178c-a makes the trace strict; other profiles do not", () => {
  const p = project({ "a.milo": CODE + `\nfn helper(): i64 {\n    return 1\n}\n`, "a_test.milo": TEST, "requirements.json": REQS });
  try {
    expect(milo(["trace", p.entry, "--safety=do178c-a"]).code).toBe(1);
    expect(milo(["trace", p.entry, "--safety=iso26262-d"]).code).toBe(0);
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

const hasZ3 = spawnSync("which", ["z3"]).status === 0;

test.skipIf(!hasZ3)("the pid demo's trace --json has the documented shape and is strict-clean", () => {
  const r = milo(["trace", "examples/assured/pid/pid.milo", "--solver=z3", "--strict", "--json"]);
  expect(r.code).toBe(0);
  const rep = JSON.parse(r.out);
  expect(Object.keys(rep).sort()).toEqual([
    "assumptions", "deactivated", "derived", "entry", "errors", "noImplementation", "noVerifyingTest", "ok",
    "requirements", "requirementsFile", "schema", "strict", "strictFailures", "unknown", "untracedFns",
  ]);
  expect(rep.requirements.map((q: any) => q.id)).toEqual(["HLR-1", "HLR-2", "LLR-1", "LLR-2", "LLR-3"]);
  const llr3 = rep.requirements.find((q: any) => q.id === "LLR-3");
  const pidReq = llr3.formalizedBy.find((c: any) => c.fn === "pidStep" && c.text.includes("measured"));
  expect(pidReq.status).toBe("PROVEN");
  expect(pidReq.callSites.every((s: any) => s.status === "PROVEN" && s.line > 0 && s.file.endsWith(".milo"))).toBe(true);
  expect(rep.unknown).toBe(0);
}, 120000);

test.skipIf(!hasZ3)("the pid demo's bad caller shows a FAILED call-site obligation", () => {
  const r = milo(["trace", "examples/assured/pid/pid_bad_caller.milo", "--solver=z3", "--strict", "--json"]);
  expect(r.code).toBe(1);
  const rep = JSON.parse(r.out);
  const sites = rep.requirements.flatMap((q: any) => q.formalizedBy).flatMap((c: any) => c.callSites ?? []);
  const failed = sites.filter((s: any) => s.status === "FAILED");
  expect(failed.map((s: any) => [s.caller, s.file])).toEqual([["controlTickUnclamped", "pid_bad_caller.milo"]]);
}, 120000);
