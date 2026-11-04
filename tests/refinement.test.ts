// `milo trace --refinement`: z3 checks that child clauses deliver the parent's, and that each contract is satisfiable.
// Each test names the verdict it expects; the NOT REFINED test is the proof the check can fail.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

interface Run { code: number; json: any; text: string }

function withProject<T>(reqs: Record<string, string | null>, code: string, fn: (dir: string, run: (...extra: string[]) => Run) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "milo-refine-"));
  try {
    writeFileSync(join(dir, "requirements.json"), JSON.stringify({
      requirements: Object.entries(reqs).map(([id, parent]) => ({ id, text: `requirement ${id}`, ...(parent ? { parent } : {}) })),
    }));
    writeFileSync(join(dir, "a.milo"), code);
    const entry = join(dir, "a.milo");
    const run = (...extra: string[]): Run => {
      const j = spawnSync("bun", [MAIN, "trace", entry, "--no-run", "--refinement", "--json", ...extra], { encoding: "utf-8", cwd: ROOT });
      const t = spawnSync("bun", [MAIN, "trace", entry, "--no-run", "--refinement", ...extra], { encoding: "utf-8", cwd: ROOT });
      return { code: j.status ?? -1, json: JSON.parse(j.stdout), text: t.stdout ?? "" };
    };
    return fn(dir, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HL: Record<string, string | null> = { "HLR-1": null, "LLR-1": "HLR-1", "LLR-2": "HLR-1" };

/** One fn `f(x: i64): i64` whose clauses are `[kind, req id, expr]`. */
const fnWith = (clauses: [string, string, string][], name = "f", ret = "i64") =>
  `pub fn ${name}(x: i64): ${ret}\n${clauses.map(([k, id, e]) => `@req(${id})\n${k} ${e}`).join("\n")}\n{\n    return x\n}\n`;

const rows = (r: Run) => r.json.refinement.obligations as { req: string; verdict: string; counterexample?: string; by: string[]; note?: string }[];

test("1. child result <= 80 refines parent result <= 100: REFINED", () => {
  withProject(HL, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "LLR-1", "result <= 80"]]), (_d, run) => {
    const r = run("--strict");
    expect(rows(r).map(o => [o.req, o.verdict, o.by])).toEqual([["HLR-1", "REFINED", ["LLR-1"]]]);
    expect(r.json.refinement.gaps).toEqual([]);
    expect(r.text).toContain("REFINED by LLR-1");
    expect(r.text).toContain("1 refinement obligations checked: 1 refined, 0 not refined");
  });
});

test("2. child result <= 200 does not refine parent result <= 100: NOT REFINED with a counterexample, strict fails", () => {
  withProject(HL, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "LLR-1", "result <= 200"]]), (_d, run) => {
    const r = run("--strict");
    const [o] = rows(r);
    expect(o!.req).toBe("HLR-1");
    expect(o!.verdict).toBe("NOT REFINED");
    const m = /result = (\d+)/.exec(o!.counterexample!);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(101);
    expect(Number(m![1])).toBeLessThanOrEqual(200);
    expect(r.code).toBe(1);
    expect(r.json.strictFailures.some((f: string) => f.includes("HLR-1") && f.includes("not refined"))).toBe(true);
    expect(r.json.gaps.some((g: any) => /^refinement:HLR-1:[0-9a-f]{12}$/.test(g.key))).toBe(true);
    expect(r.text).toContain("NOT REFINED by LLR-1: counterexample");
  });
});

test("3. two children together imply the parent, neither alone: REFINED", () => {
  const code = fnWith([["ensures", "HLR-1", "result >= 0 && result <= 100"], ["ensures", "LLR-1", "result >= 0"], ["ensures", "LLR-2", "result <= 100"]]);
  withProject(HL, code, (_d, run) => {
    expect(rows(run()).map(o => [o.verdict, o.by])).toEqual([["REFINED", ["LLR-1", "LLR-2"]]]);
  });
});

test("4. a child that holds only under the fn's requires: REFINED", () => {
  const code = `pub fn f(x: i64): i64\nrequires x >= 0 && x <= 50\n@req(HLR-1)\nensures result <= 100\n@req(LLR-1)\nensures result == x\n{\n    return x\n}\n`;
  withProject(HL, code, (_d, run) => {
    expect(rows(run()).map(o => o.verdict)).toEqual(["REFINED"]);
  });
});

test("5. parent clause on f, child clause on g: NOT COMPARABLE, not a pass, strict does not fail, count printed", () => {
  const code = fnWith([["ensures", "HLR-1", "result <= 100"]], "f") + fnWith([["ensures", "LLR-1", "result <= 80"]], "g");
  withProject(HL, code, (_d, run) => {
    const r = run("--strict");
    expect(rows(r).map(o => [o.verdict, o.note])).toEqual([["NOT COMPARABLE", "no child clause on f"]]);
    expect(r.json.refinement.gaps).toEqual([]);
    expect(r.json.strictFailures.filter((f: string) => f.includes("refine"))).toEqual([]);
    expect(r.text).toContain("0 refinement obligations checked");
    expect(r.text).toContain("1 not comparable");
    expect(r.text).not.toContain("REFINED by");
  });
});

test("6. a requirement with clauses and no children claims no pass: no obligation, count says 0", () => {
  withProject({ "HLR-1": null }, fnWith([["ensures", "HLR-1", "result <= 100"]]), (_d, run) => {
    const r = run("--strict");
    expect(rows(r)).toEqual([]);
    expect(r.text).toContain("0 refinement obligations checked");
    expect(r.text).not.toContain("REFINED by");
  });
});

test("7. a grandchild's clause counts toward the grandparent", () => {
  const reqs = { "HLR-1": null, "MLR-1": "HLR-1", "LLR-1": "MLR-1" };
  withProject(reqs, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "LLR-1", "result <= 80"]]), (_d, run) => {
    expect(rows(run()).map(o => [o.req, o.verdict, o.by])).toEqual([["HLR-1", "REFINED", ["LLR-1"]]]);
  });
});

test("8. the parent's own second clause does not refine its first", () => {
  withProject(HL, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "HLR-1", "result <= 50"]]), (_d, run) => {
    const r = run();
    expect(rows(r).map(o => o.verdict)).toEqual(["NOT COMPARABLE", "NOT COMPARABLE"]);
    expect(r.text).not.toContain("REFINED by");
  });
  // With a child present, the weaker child bound refines the first clause but not the stricter second one.
  withProject(HL, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "HLR-1", "result <= 50"], ["ensures", "LLR-1", "result <= 80"]]), (_d, run) => {
    expect(rows(run()).map(o => o.verdict)).toEqual(["REFINED", "NOT REFINED"]);
  });
});

test("9. requires x > 5 && x < 3: UNSAT, vacuous wording, strict fails", () => {
  const code = `@req(LLR-1)\nrequires x > 5 && x < 3\n@req(LLR-1)\nensures result > 0\n`;
  withProject(HL, `pub fn f(x: i64): i64\n${code}{\n    return 1\n}\n`, (_d, run) => {
    const r = run("--strict");
    const [s] = r.json.refinement.satisfiability;
    expect(s.verdict).toBe("UNSAT");
    expect(s.scope).toBe("requires");
    expect(s.message).toContain("every proof of 'f' is vacuous");
    expect(s.clauses.join(" ")).toContain("x > 5");
    expect(r.code).toBe(1);
    expect(r.json.gaps.some((g: any) => g.key === "unsat:f")).toBe(true);
  });
});

test("10. satisfiable requires, contradictory ensures: UNSAT, no-implementation wording", () => {
  const code = `pub fn f(x: i64): i64\n@req(LLR-1)\nrequires x > 0\n@req(LLR-1)\nensures result > 0\n@req(LLR-1)\nensures result < 0\n{\n    return x\n}\n`;
  withProject(HL, code, (_d, run) => {
    const r = run("--strict");
    const [s] = r.json.refinement.satisfiability;
    expect(s.verdict).toBe("UNSAT");
    expect(s.scope).toBe("contract");
    expect(s.message).toContain("no implementation can meet this contract");
    expect(s.message).not.toContain("vacuous");
    expect(r.code).toBe(1);
  });
});

test("11. a baseline accepts test 2's gap and the rerun passes", () => {
  withProject(HL, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "LLR-1", "result <= 200"]]), (dir, run) => {
    const first = run("--strict");
    expect(first.code).toBe(1);
    const keys = first.json.gaps.filter((g: any) => g.key.startsWith("refinement:")).map((g: any) => g.key);
    expect(keys.length).toBe(1);
    const base = join(dir, "baseline.json");
    writeFileSync(base, JSON.stringify({ schema: 1, gaps: keys }));
    const second = run("--strict", "--baseline", base);
    expect(second.json.strictFailures.filter((f: string) => f.includes("not refined"))).toEqual([]);
    expect(second.json.baselined.some((m: string) => m.includes("not refined"))).toBe(true);
    expect(second.json.staleBaseline).toEqual([]);
  });
});

test("without --refinement the report has no refinement section", () => {
  withProject(HL, fnWith([["ensures", "HLR-1", "result <= 100"], ["ensures", "LLR-1", "result <= 200"]]), (dir) => {
    const r = spawnSync("bun", [MAIN, "trace", join(dir, "a.milo"), "--no-run", "--json", "--strict"], { encoding: "utf-8", cwd: ROOT });
    expect(JSON.parse(r.stdout).refinement).toBeUndefined();
  });
});

test("12. the real examples run without crashing", () => {
  for (const f of ["examples/assured/pid/pid.milo", "examples/assured/intro/heater.milo"]) {
    const r = spawnSync("bun", [MAIN, "trace", f, "--no-run", "--refinement"], { encoding: "utf-8", cwd: ROOT });
    expect(r.stdout).toContain("requirement refinement:");
    expect(r.stdout).toContain("contract satisfiability:");
    expect(r.stderr).not.toContain("at ");
  }
});
