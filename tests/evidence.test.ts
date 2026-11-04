// Evidence records (src/evidence.ts): they satisfy the verification claims `milo trace` cannot check itself.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
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

const CODE = "@req(PERF-1)\npub fn serve(x: i64): i64 {\n    return x + 1\n}\n";
const reqs = (text: string, verification?: object[]) => JSON.stringify({ requirements: [{ id: "PERF-1", text, kind: "timing", ...(verification ? { verification } : {}) }] });
const LOAD = [{ method: "test", env: "load" }];

function project(code = CODE, req = reqs("p95 under 300 ms", LOAD)) {
  const dir = mkdtempSync(join(tmpdir(), "milo-evid-"));
  writeFileSync(join(dir, "a.milo"), code);
  writeFileSync(join(dir, "requirements.json"), req);
  const entry = join(dir, "a.milo");
  const write = (n: string, t: string) => writeFileSync(join(dir, n), t);
  const strict = () => milo(["trace", entry, "--strict", "--no-run"]);
  const json = () => JSON.parse(milo(["trace", entry, "--no-run", "--json"]).out);
  const evid = (...a: string[]) => milo(["evidence", ...a]);
  const records = () => (existsSync(join(dir, "evidence")) ? readdirSync(join(dir, "evidence")).filter(f => f.endsWith(".json")) : []);
  const add = (result: string, ...extra: string[]) => evid("add", entry, "PERF-1", "--method", "test", "--env", "load", "--result", result, ...extra);
  return { dir, entry, write, strict, json, evid, records, add, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const T = 120000;

test("a claim with no record fails strict and names the claim", () => {
  const p = project();
  try {
    const r = p.strict();
    expect(r.code).toBe(1);
    expect(r.out).toContain("PERF-1");
    expect(r.out).toContain('"test@load"');
    expect(r.out).toContain("no evidence record");
  } finally { p.done(); }
}, T);

test("evidence add passes strict and the row says attested", () => {
  const p = project();
  try {
    expect(p.add("pass", "--measured", "p95 212 ms").code).toBe(0);
    expect(p.strict().code).toBe(0);
    const out = milo(["trace", p.entry, "--no-run"]).out;
    expect(out).toMatch(/evidence\s+PASS\s+test@load \d{4}-\d\d-\d\d p95 212 ms\s+evidence\/PERF-1-test-load-[0-9a-f]{12}\.json\s+\(attested\)/);
    const rec = p.json().requirements[0];
    expect(rec.evidence[0].source).toBe("attested");
    const file = JSON.parse(readFileSync(join(p.dir, "evidence", p.records()[0]!), "utf-8"));
    expect(file.source).toBe("attested");
    expect(file.codeHash).toMatch(/^[0-9a-f]{12}$/);
  } finally { p.done(); }
}, T);

test("evidence run captures output as an artifact and says run", () => {
  const p = project();
  try {
    const r = p.evid("run", p.entry, "PERF-1", "--method", "test", "--env", "load", "--", "sh", "-c", "echo hello; exit 0");
    expect(r.code).toBe(0);
    const logs = readdirSync(join(p.dir, "evidence", "artifacts"));
    expect(logs.length).toBe(1);
    expect(readFileSync(join(p.dir, "evidence", "artifacts", logs[0]!), "utf-8")).toContain("hello");
    const rec = JSON.parse(readFileSync(join(p.dir, "evidence", p.records()[0]!), "utf-8"));
    expect(rec.argv).toEqual(["sh", "-c", "echo hello; exit 0"]);
    expect(rec.artifact.path).toBe(`evidence/artifacts/${logs[0]}`);
    expect(p.strict().code).toBe(0);
    expect(milo(["trace", p.entry, "--no-run"]).out).toContain("(run)");
  } finally { p.done(); }
}, T);

test("a failing run still writes the record, exits with the command's code, and fails strict", () => {
  const p = project();
  try {
    const r = p.evid("run", p.entry, "PERF-1", "--method", "test", "--env", "load", "--", "sh", "-c", "echo boom; exit 3");
    expect(r.code).toBe(3);
    expect(p.records().length).toBe(1);
    const logs = readdirSync(join(p.dir, "evidence", "artifacts"));
    expect(readFileSync(join(p.dir, "evidence", "artifacts", logs[0]!), "utf-8")).toContain("boom");
    const s = p.strict();
    expect(s.code).toBe(1);
    expect(s.out).toContain("failed");
    expect(milo(["trace", p.entry, "--no-run"]).out).toMatch(/evidence\s+FAILED/);
  } finally { p.done(); }
}, T);

test("the latest record by date wins, in either direction", () => {
  const p = project();
  try {
    p.add("fail");
    expect(p.strict().code).toBe(1);
    Bun.sleepSync(20);
    p.add("pass");
    expect(p.strict().code).toBe(0);
    Bun.sleepSync(20);
    p.add("fail");
    expect(p.strict().code).toBe(1);
  } finally { p.done(); }
}, T);

test("editing the requirement text or the implementing fn makes the record stale; reformatting does not", () => {
  const p = project();
  try {
    p.add("pass");
    expect(p.strict().code).toBe(0);
    p.write("a.milo", "@req(PERF-1)\npub   fn serve( x: i64 ):  i64 {\n\n        return   x+1\n}\n");
    expect(p.strict().code).toBe(0);
    p.write("a.milo", "@req(PERF-1)\npub fn serve(x: i64): i64 {\n    return x + 2\n}\n");
    const code = p.strict();
    expect(code.code).toBe(1);
    expect(code.out).toContain("the implementing code changed");
    p.write("a.milo", CODE);
    expect(p.strict().code).toBe(0);
    p.write("requirements.json", reqs("p95 under 200 ms", LOAD));
    const text = p.strict();
    expect(text.code).toBe(1);
    expect(text.out).toContain("the requirement text changed");
    expect(milo(["trace", p.entry, "--no-run"]).out).toMatch(/evidence\s+STALE/);
  } finally { p.done(); }
}, T);

test("tampering with the artifact fails", () => {
  const p = project();
  try {
    p.evid("run", p.entry, "PERF-1", "--method", "test", "--env", "load", "--", "sh", "-c", "echo ok");
    expect(p.strict().code).toBe(0);
    const log = join(p.dir, "evidence", "artifacts", readdirSync(join(p.dir, "evidence", "artifacts"))[0]!);
    writeFileSync(log, "edited\n");
    const r = p.strict();
    expect(r.code).toBe(1);
    expect(r.out).toContain("evidence artifact changed or missing");
    rmSync(log);
    expect(p.strict().out).toContain("evidence artifact changed or missing");
  } finally { p.done(); }
}, T);

test("env must match exactly: a stray record fails the claim and is named in a warning", () => {
  const p = project();
  try {
    p.evid("add", p.entry, "PERF-1", "--method", "test", "--env", "bench", "--result", "pass");
    const r = p.strict();
    expect(r.code).toBe(1);
    expect(r.out).toContain("no evidence record");
    expect(r.out).toMatch(/stray evidence records[\s\S]*PERF-1-test-bench-[0-9a-f]{12}\.json/);
    expect(p.json().strayEvidence.length).toBe(1);
  } finally { p.done(); }
}, T);

test("a record never verifies a requirement that declares nothing", () => {
  const p = project(CODE, reqs("p95 under 300 ms"));
  try {
    p.evid("add", p.entry, "PERF-1", "--method", "test", "--env", "load", "--result", "pass");
    const r = p.strict();
    expect(r.code).toBe(1);
    expect(r.out).toContain("not verified");
    expect(p.json().requirements[0].verified).toBe(false);
  } finally { p.done(); }
}, T);

test("a top-level requirement with only a satisfied test@load claim is verified", () => {
  const p = project();
  try {
    expect(p.strict().out).toContain("is not verified");
    p.add("pass");
    const r = p.strict();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("is not verified");
    expect(p.json().requirements[0].verification).toBe("evidence");
  } finally { p.done(); }
}, T);

test("an analysis claim with an unproved clause still fails even with a record for it", () => {
  const code = "@req(PERF-1)\npub fn serve(x: i64): i64\nrequires x < 100\n@req(PERF-1)\nensures result > x * x\n{\n    return x + 1\n}\n";
  const p = project(code, reqs("t", [{ method: "analysis" }]));
  try {
    p.evid("add", p.entry, "PERF-1", "--method", "analysis", "--result", "pass");
    const r = milo(["trace", p.entry, "--strict", "--no-run"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('"analysis"');
  } finally { p.done(); }
}, T);

test("usage errors write no record", () => {
  const p = project();
  try {
    const bad = [
      ["add", p.entry, "NOPE-1", "--method", "test", "--result", "pass"],
      ["add", p.entry, "PERF-1", "--method", "wish", "--result", "pass"],
      ["add", p.entry, "PERF-1", "--method", "test", "--env", "Load!", "--result", "pass"],
      ["add", p.entry, "PERF-1", "--method", "test", "--result", "pass", "--artifact", join(p.dir, "missing.txt")],
      ["add", p.entry, "PERF-1", "--method", "test"],
    ];
    for (const a of bad) {
      const r = p.evid(...a);
      expect(r.code).toBe(2);
      expect(r.out).toContain("usage:");
    }
    expect(p.records()).toEqual([]);
  } finally { p.done(); }
}, T);

test("evidence list shows each record's state", () => {
  const p = project();
  try {
    p.add("pass");
    const l = p.evid("list", p.entry);
    expect(l.code).toBe(0);
    expect(l.out).toMatch(/PERF-1-test-load-[0-9a-f]{12}\.json\s+PERF-1\s+test@load\s+PASS .*\(attested\)/);
  } finally { p.done(); }
}, T);
