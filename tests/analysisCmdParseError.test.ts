// Analysis subcommands (verify/wcet/prove/safety) must render a clean Elm-style
// diagnostic on a syntax error, not leak a raw JS ParseError stack trace the way
// they did before parseCheckProgram wrapped their parse step. Regression guard for
// the security audit's D3 finding.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";
let bad = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-d3-"));
  bad = join(dir, "synerr.milo");
  writeFileSync(bad, "fn main( i32 { return @ }\n");
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("bun", ["run", MAIN, ...args], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

for (const cmd of [["verify", bad] as const, ["wcet"] as const, ["prove"] as const, ["safety", "@FILE", "do178c-a"] as const]) {
  const name = cmd[0];
  test(`${name} on a syntax error renders a diagnostic, not a JS trace`, () => {
    const args = name === "safety" ? [name, bad, "do178c-a"] : [name, bad];
    const r = run(args);
    expect(r.code).not.toBe(0);
    // clean diagnostic present
    expect(r.out).toContain("error");
    // JS-level crash signatures absent
    expect(r.out).not.toContain("ParseError:");
    expect(r.out).not.toContain("Maximum call stack");
    expect(r.out).not.toMatch(/\n\s+at .+\(.*main\.ts/);
  });
}
