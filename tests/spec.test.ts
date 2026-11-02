// Gate on docs/spec.md — the normative specification, generated from the suites that
// decide what the compiler does.
//
// The document's whole claim is that it cannot describe a language the compiler does not
// implement, because every requirement in it is derived from a test that runs on every
// commit. That claim is only true while the file on disk matches what the generator
// produces now, which is what the first test here checks.
//
// The rest guard the properties a requirement identifier has to have to be worth citing:
// stable across a reworded diagnostic, unique, and never present without a verification.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { requirements } from "../scripts/gen-spec";

const ROOT = join(import.meta.dir, "..");

test("the checked-in spec matches the generator", () => {
  // Regenerate with: bun run scripts/gen-spec.ts
  execFileSync("bun", ["run", "scripts/gen-spec.ts", "--check"], { cwd: ROOT, stdio: "pipe" });
});

test("every pinned program states exactly one requirement", () => {
  const reqs = requirements();
  // A count guard, because a scan that found nothing would report perfect compliance —
  // the same failure mode this repo's other generated gates are built to avoid.
  expect(reqs.length).toBeGreaterThan(800);

  const errorFiles = readdirSync(join(ROOT, "tests", "errors")).filter(f => f.endsWith(".milo"));
  expect(reqs.filter(r => r.kind === "reject").length).toBe(errorFiles.length);

  const ids = reqs.map(r => r.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("an identifier is keyed to the file name, not to the diagnostic text", () => {
  // The property that makes an id citable: improving a message must not renumber the
  // spec. Checked structurally rather than by rewording a fixture — every id has to be
  // derivable from its program's path alone.
  for (const r of requirements()) {
    const stem = r.file.replace(/^tests\/(errors|fixtures)\//, "").replace(/\.milo$/, "");
    const prefix = r.kind === "reject" ? "MILO-E-" : "MILO-B-";
    expect(r.id).toBe(`${prefix}${stem}`);
  }
});

test("no requirement appears without a verification", () => {
  for (const r of requirements()) {
    expect(r.verifiedBy).toContain("tests/run.test.ts");
    expect(r.detail.length).toBeGreaterThan(0);
  }
});

test("the document states its own limits", () => {
  // A spec that overclaims its coverage is worse than one that admits the boundary, so
  // the caveats are part of the artifact and are pinned here rather than left to review.
  const spec = readFileSync(join(ROOT, "docs", "spec.md"), "utf-8");
  for (const claim of [
    "specification by example",
    "There is no denotational or operational model",
    "A rule with no fixture states no requirement",
  ]) {
    expect(spec).toContain(claim);
  }
});

test("every value-semantics rule is pinned by behavioural programs that exist", () => {
  const { VALUE_RULES } = require("../scripts/value-rules") as typeof import("../scripts/value-rules");
  const behaviours = new Set(requirements().filter(r => r.kind === "behaviour").map(r => r.id));
  expect(VALUE_RULES.length).toBeGreaterThanOrEqual(5);
  const ids = new Set<string>();
  for (const r of VALUE_RULES) {
    expect(r.id).toMatch(/^MILO-V-[A-Za-z]+$/);
    expect(ids.has(r.id)).toBe(false);
    ids.add(r.id);
    expect(r.fixtures.length).toBeGreaterThan(0);
    for (const f of r.fixtures) expect(behaviours.has(`MILO-B-${f}`)).toBe(true);
  }
});

test("every ownership rule is pinned by behavioural programs that exist", () => {
  const { OWNERSHIP_RULES } = require("../scripts/ownership-rules") as typeof import("../scripts/ownership-rules");
  const behaviours = new Set(requirements().filter(r => r.kind === "behaviour").map(r => r.id));
  // A count guard, as above: an empty list would pass every check below.
  expect(OWNERSHIP_RULES.length).toBeGreaterThan(10);
  const ids = new Set<string>();
  for (const r of OWNERSHIP_RULES) {
    expect(r.id).toMatch(/^MILO-O-[A-Za-z]+$/);
    expect(ids.has(r.id)).toBe(false);
    ids.add(r.id);
    expect(r.fixtures.length).toBeGreaterThan(0);
    // A rule whose program states no output pins nothing.
    for (const f of r.fixtures) expect(behaviours.has(`MILO-B-${f}`)).toBe(true);
  }
});
