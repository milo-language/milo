// Spec lock (src/specLock.ts): a change to the intent surface (requirements, contract clauses)
// since a git ref is ok only if it adds or strengthens, or a spec-signoff.json entry accepts it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

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
