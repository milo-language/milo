// Ownership-site census (scripts/ownership-sites.ts) and the ownership-cells ratchet comparison
// (scripts/gen-ownership-cells.ts): the matcher, that the gates can fail, and that the real census runs.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { census, checkAgainst, collectExpected, collectSites, findSites, isOwnershipWorded, siteKey, type Site } from "../scripts/ownership-sites";

const site = (...pieces: string[]): Site => ({ file: "src/checker.ts", line: 1, pieces });

describe("matcher", () => {
  test("reached, unreached, template hole", () => {
    const c = census(
      [site("use of moved variable '", "'"), site("cannot return a borrowed slice"), site("'", "' is freed when the function returns")],
      ["use of moved variable 'box'", "'x' is freed when the function returns", "unrelated text"],
    );
    expect(c.reachedSites).toBe(2);
    expect(c.unreached).toEqual([siteKey(site("cannot return a borrowed slice"))]);
  });
  test("expected substring inside a longer site literal counts", () => {
    expect(census([site("cannot move 'x' because it is borrowed")], ["because it is borrowed"]).reachedSites).toBe(1);
  });
  test("static finder takes the first literal argument and the word list filters", () => {
    const src = "class C { f() { this.error(`use of moved value '${x}'`, sp); this.error('unknown type', sp); this.warn('moved', sp); } }";
    const found = findSites("x.ts", src);
    expect(found.map(s => s.pieces)).toEqual([["use of moved value '", "'"], ["unknown type"]]);
    expect(found.filter(isOwnershipWorded).length).toBe(1);
  });
});

describe("census check", () => {
  test("fails when a reached site stops being reached", () => {
    const sites = [site("use of moved variable '", "'"), site("'", "' is freed when the function returns")];
    const expected = ["use of moved variable 'box'", "'x' is freed when the function returns"];
    const toBase = (c: ReturnType<typeof census>) => ({ reached: c.reachedSites, unreached: c.unreached });
    const base = toBase(census(sites, expected));
    expect(checkAgainst(base, base)).toEqual([]);
    const after = toBase(census(sites, expected.slice(1)));
    const problems = checkAgainst(base, after);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain("reached 1 < baseline 2");
    expect(problems[1]).toContain("newly unreached");
  });
});

describe("real census", () => {
  test("runs under 20 s with more than 50 sites", () => {
    const t = Date.now();
    const sites = collectSites();
    const c = census(sites, collectExpected());
    expect(Date.now() - t).toBeLessThan(20_000);
    expect(sites.length).toBeGreaterThan(50);
    expect(c.reachedSites).toBeGreaterThan(0);
  });
});

describe("ownership-cells ratchet", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-cells-"));
  const write = (name: string, v: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(v)); return p; };
  const rows = write("rows.json", [
    { name: "a-x-s", status: "covered", message: "" },
    { name: "b-x-s", status: "refused", message: "m" },
  ]);
  const run = (baseline: string, env: Record<string, string> = {}, extra: string[] = []) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gen-ownership-cells.ts"), "--compare-rows", rows, "--baseline", baseline, ...extra], { env: { ...process.env, ...env } });
    return { code: p.exitCode, err: p.stderr.toString() };
  };
  const full = write("full.json", { refused: 1, wrong: 0, covered: ["a-x-s"], refusedCells: ["b-x-s"] });

  test("clean rows pass", () => { expect(run(full).code).toBe(0); });
  test("a planted covered-to-refused cell fails and is named", () => {
    const r = run(full, { OWNERSHIP_CELLS_PLANT: "refused" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("REGRESSED: a-x-s");
    expect(r.err).toContain("NEWLY REFUSED: a-x-s");
  });
  test("a new refused cell fails even though covered stays covered", () => {
    const base = write("shrunk.json", { refused: 0, wrong: 0, covered: ["a-x-s"], refusedCells: [] });
    const r = run(base);
    expect(r.code).toBe(1);
    expect(r.err).toContain("NEWLY REFUSED: b-x-s");
  });
  test("old-format baseline compares counts, and says so", () => {
    const old = write("old.json", { refused: 0, wrong: 0, covered: ["a-x-s"] });
    const r = run(old);
    expect(r.code).toBe(1);
    expect(r.err).toContain("old format");
    expect(r.err).toContain("REFUSED GREW");
    expect(run(write("old-ok.json", { refused: 1, wrong: 0, covered: ["a-x-s"] })).code).toBe(0);
  });
});
