// Spec lock (src/specLock.ts): a change to the intent surface (requirements, contract clauses)
// since a git ref is ok only if it adds or strengthens, or a spec-signoff.json entry accepts it.
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { specSurface } from "../src/specLock";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const REQS = (r1 = "The command is between 0 and 100.") => JSON.stringify({ requirements: [{ id: "R-1", text: r1 }, { id: "R-2", text: "Off at or above target." }] });
const SRC = (ens1 = "result >= 0 && result <= 100", extra = "@req(R-2) ensures reading >= target ==> result == 0\n") => `@req(R-1)
@req(R-2)
pub fn heat(reading: i32, target: i32): i32
requires reading >= -1000 && reading <= 2000
requires target >= 0 && target <= 1000
@req(R-1) ensures ${ens1}
${extra}{
    if reading >= target {
        return 0
    }
    return 50
}
`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "milo-speclock-"));
  const git = (...a: string[]) => spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf-8" });
  git("init", "-q");
  writeFileSync(join(dir, "requirements.json"), REQS());
  writeFileSync(join(dir, "a.milo"), SRC());
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const entry = join(dir, "a.milo");
  return {
    dir,
    set(src: string, reqs?: string) { writeFileSync(entry, src); if (reqs) writeFileSync(join(dir, "requirements.json"), reqs); },
    sign(entries: object[]) { writeFileSync(join(dir, "spec-signoff.json"), JSON.stringify({ signoffs: entries })); },
    diff() { const r = spawnSync("bun", [MAIN, "spec", "--diff", "HEAD", entry], { encoding: "utf-8" }); return { code: r.status ?? -1, out: r.stdout + r.stderr }; },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("spec prints requirements and clauses with their @req", () => {
  const r = repo();
  try {
    const p = spawnSync("bun", [MAIN, "spec", join(r.dir, "a.milo")], { encoding: "utf-8" });
    expect(p.stdout).toContain("requirement R-1: The command is between 0 and 100.");
    expect(p.stdout).toContain("a.milo:heat ensures @R-1: result >= 0 && result <= 100");
    expect(p.stdout).toContain("a.milo:heat requires: reading >= -1000");
  } finally { r.done(); }
});

test("a strengthened ensures passes", () => {
  const r = repo();
  try {
    r.set(SRC("result >= 0 && result <= 50"));
    const d = r.diff();
    expect(d.out).toContain("ok: clause strengthened");
    expect(d.code).toBe(0);
  } finally { r.done(); }
});

test("a weakened ensures needs sign-off and prints a counterexample", () => {
  const r = repo();
  try {
    r.set(SRC("result >= 0"));
    const d = r.diff();
    expect(d.code).toBe(1);
    expect(d.out).toContain("NEEDS SIGN-OFF: clause weakened: a.milo:heat ensures @R-1");
    expect(d.out).toMatch(/counterexample: .*result = (10[1-9]|1[1-9]\d|[2-9]\d\d|\d{4,})/);
  } finally { r.done(); }
});

test("a removed clause needs sign-off", () => {
  const r = repo();
  try {
    r.set(SRC("result >= 0 && result <= 100", ""));
    const d = r.diff();
    expect(d.code).toBe(1);
    expect(d.out).toContain("NEEDS SIGN-OFF: clause removed: a.milo:heat ensures @R-2");
  } finally { r.done(); }
});

test("a signed-off change passes, a wrong hash does not", () => {
  const r = repo();
  try {
    r.set(SRC("result >= 0"));
    const hash = /clause weakened: a\.milo:heat ensures @R-1  \[hash (\w+)\]/.exec(r.diff().out)![1];
    r.sign([{ id: "a.milo:heat ensures @R-1", hash: "deadbeef0000", who: "cs", why: "x" }]);
    expect(r.diff().code).toBe(1);
    r.sign([{ id: "a.milo:heat ensures @R-1", hash, who: "cs", why: "upper bound moved to the actuator" }]);
    const d = r.diff();
    expect(d.out).toContain("ok (signed off)");
    expect(d.code).toBe(0);
  } finally { r.done(); }
});

test("a requirement text change needs sign-off; an added requirement does not", () => {
  const r = repo();
  try {
    r.set(SRC(), REQS("The command is between 0 and 120."));
    const d = r.diff();
    expect(d.code).toBe(1);
    expect(d.out).toContain("NEEDS SIGN-OFF: requirement text changed: R-1");
    r.set(SRC(), JSON.stringify({ requirements: [{ id: "R-1", text: "The command is between 0 and 100." }, { id: "R-2", text: "Off at or above target." }, { id: "R-3", text: "New." }] }));
    const e = r.diff();
    expect(e.out).toContain("ok: requirement added: R-3");
    expect(e.code).toBe(0);
  } finally { r.done(); }
});

test("trace --strict --spec-base fails on an unsigned weakening", () => {
  const r = repo();
  try {
    r.set(SRC("result >= 0"));
    const t = spawnSync("bun", [MAIN, "trace", join(r.dir, "a.milo"), "--strict", "--no-run", "--spec-base", "HEAD"], { encoding: "utf-8" });
    expect(t.stdout + t.stderr).toContain("spec lock: clause weakened");
    expect(t.status).toBe(1);
  } finally { r.done(); }
});

// ---- clean-room packet (milo spec --packet) ----
const ROOT = join(import.meta.dir, "..");
const packet = (entry: string, out: string) => spawnSync("bun", [MAIN, "spec", "--packet", out, entry], { encoding: "utf-8" });
const tmp = () => mkdtempSync(join(tmpdir(), "milo-packet-"));
const allFiles = (d: string): string[] => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? allFiles(join(d, n)) : [join(d, n)]);
const checkErrors = (file: string) => {
  const j = JSON.parse(spawnSync("bun", [MAIN, "check", file, "--json"], { encoding: "utf-8" }).stdout);
  return { ok: j.ok as boolean, errors: (j.diagnostics as any[]).filter(d => d.severity === "error").map(d => d.message) };
};

test("packet leaks nothing about bodies, private code or comments", () => {
  const dir = tmp(), out = join(tmp(), "pk");
  try {
    writeFileSync(join(dir, "requirements.json"), JSON.stringify({ requirements: [{ id: "R-1", text: "Bounded.", source: "SECRET_SOURCE_Q9" }] }));
    writeFileSync(join(dir, "a.milo"), `// COMMENT_SENTINEL_A1 file header
pub struct Box {
    v: i32, // COMMENT_SENTINEL_A2
}

impl Box {
    // COMMENT_SENTINEL_A3
    fn get(self: &Self): i32 {
        let BODY_SENTINEL_M1 = 7
        return self.v + BODY_SENTINEL_M1
    }
}

pub trait Shape {
    fn area(self: &Self): i32 { return 7 + BODY_SENTINEL_T1() }
}

let globalSENTINEL_G1: i32 = 41

let contractLimit: i32 = 10

fn BODY_SENTINEL_T1(): i32 { return 1 }

fn privateHelperSENTINEL_P1(x: i32): i32 {
    let BODY_SENTINEL_P2 = x
    return BODY_SENTINEL_P2
}

@req(R-1)
pub fn pubFn(x: i32): i32
requires x >= 0 && x <= contractLimit
@req(R-1) ensures result >= 0 // COMMENT_SENTINEL_A4
{
    // COMMENT_SENTINEL_A5
    let BODY_SENTINEL_B1 = privateHelperSENTINEL_P1(x)
    return BODY_SENTINEL_B1
}

fn main(): i32 {
    print("MAIN_SENTINEL_X1")
    return 0
}
`);
    const r = packet(join(dir, "a.milo"), out);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${out}: 3 files`);
    const files = allFiles(out);
    expect(files.length).toBe(3);
    const text = files.map(f => readFileSync(f, "utf-8")).join("\n");
    // The scan must be able to fail: the interface we do keep is present, the sentinels are not.
    expect(text).toContain("pub fn pubFn(x: i32): i32");
    expect(text).toContain("fn get(self: &Self): i32");
    expect(text).toContain("fn area(self: &Self): i32");
    expect(text).toContain("let contractLimit: i32 = 10"); // a kept contract names it
    for (const s of ["SENTINEL", "BODY_", "MAIN_", "privateHelper", "fn main", "SECRET_SOURCE"]) expect(text).not.toContain(s);
    expect(text).not.toContain("//");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(out, ".."), { recursive: true, force: true }); }
});

test("packet keeps a private fn that a kept contract calls, as a stub", () => {
  const dir = tmp(), out = join(tmp(), "pk");
  try {
    writeFileSync(join(dir, "a.milo"), `fn isSmall(x: i32): i32 {
    let SENTINEL_BODY = x
    return if SENTINEL_BODY < 10 { 1 } else { 0 }
}
pub fn f(x: i32): i32
ensures isSmall(result) == 1
{
    return 3
}
`);
    expect(packet(join(dir, "a.milo"), out).status).toBe(0);
    const t = readFileSync(join(out, "a.milo"), "utf-8");
    expect(t).toContain("fn isSmall(x: i32): i32");
    expect(t).not.toContain("SENTINEL");
    expect(checkErrors(join(out, "a.milo")).errors).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(out, ".."), { recursive: true, force: true }); }
});

test("packet stubs of examples/assured and std/json type-check", () => {
  for (const entry of ["examples/assured/intro/heater.milo", "examples/assured/pid/pid.milo", "std/json.milo"]) {
    const out = join(tmp(), "pk");
    try {
      expect(packet(join(ROOT, entry), out).status).toBe(0);
      const stubs = allFiles(out).filter(f => f.endsWith(".milo"));
      expect(stubs.length).toBeGreaterThan(0);
      for (const f of stubs) expect({ f, ...checkErrors(f) }).toEqual({ f, ok: true, errors: [] });
    } finally { rmSync(join(out, ".."), { recursive: true, force: true }); }
  }
});

test("packet carries the same contract: every clause id and hash", () => {
  for (const entry of ["examples/assured/intro/heater.milo", "examples/assured/pid/pid.milo"]) {
    const out = join(tmp(), "pk");
    try {
      expect(packet(join(ROOT, entry), out).status).toBe(0);
      const real = specSurface(join(ROOT, entry));
      const pk = specSurface(join(out, entry.split("/").pop()!));
      expect(real.clauses.size).toBeGreaterThan(0);
      // `main` is dropped from a packet by design; nothing else in these projects is private.
      for (const [id, c] of real.clauses) if (!id.includes(":main ")) expect({ id, hash: pk.clauses.get(id)?.hash }).toEqual({ id, hash: c.hash });
      expect([...pk.requirements]).toEqual([...real.requirements]);
    } finally { rmSync(join(out, ".."), { recursive: true, force: true }); }
  }
});

test("packet refuses a non-empty outdir and changes nothing in it", () => {
  const dir = tmp(), out = tmp();
  try {
    writeFileSync(join(dir, "a.milo"), "pub fn f(): i32 {\n    return 1\n}\n");
    writeFileSync(join(out, "keep.txt"), "mine");
    const r = packet(join(dir, "a.milo"), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not empty");
    expect(readdirSync(out)).toEqual(["keep.txt"]);
    expect(readFileSync(join(out, "keep.txt"), "utf-8")).toBe("mine");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test("a test written against the packet type-checks there and passes in the real project", () => {
  const proj = tmp(), out = join(tmp(), "pk");
  try {
    cpSync(join(ROOT, "examples/assured/intro"), proj, { recursive: true });
    expect(packet(join(proj, "heater.milo"), out).status).toBe(0);
    const t = `from "./heater" import { heaterPercent }

@req(R-1)
fn testPacketRange() {
    assert(heaterPercent(-1000, 1000) <= 100)
    assert(heaterPercent(-1000, 1000) >= 0)
}

@req(R-2)
fn testPacketOffAtTarget() {
    assert(heaterPercent(300, 300) == 0)
}
`;
    writeFileSync(join(out, "packet_test.milo"), t);
    expect(checkErrors(join(out, "packet_test.milo"))).toEqual({ ok: true, errors: [] });
    writeFileSync(join(proj, "packet_test.milo"), t);
    const opt = [process.env.MILO_OPT, join(ROOT, "mlir/build/milo-opt"), join(homedir(), "git/milo/mlir/build/milo-opt")].find(p => p && existsSync(p));
    expect(opt, "milo-opt not found: build it with sh mlir/build.sh or set MILO_OPT").toBeDefined();
    const run = spawnSync("bun", [MAIN, "test", join(proj, "packet_test.milo")], { encoding: "utf-8", env: { ...process.env, MILO_OPT: opt } });
    expect(run.stdout + run.stderr).toContain("2 pass, 0 fail");
    expect(run.status).toBe(0);
  } finally { rmSync(proj, { recursive: true, force: true }); rmSync(join(out, ".."), { recursive: true, force: true }); }
});
