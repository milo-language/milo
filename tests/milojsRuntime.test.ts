// CI coverage for the milojs RUNTIME (examples/apps/milojs/milojs.milo) — the
// binary tahoeroads runs on. R1 async activations exist only on the runtime (the
// engine executes on the main thread and never spawns one), so these fixtures
// cannot run through the engine-only fixture harness. Each tests/runtime/*.js is
// run and its stdout compared to a committed .expected captured from node.
//
// This is the automated guard against regressing the tahoeroads-critical async /
// fetch / event-loop machinery: selfFetchServes serves an HTTP request to itself
// and would hang (caught by the per-test timeout) if the cold-fetch fix regresses;
// asyncReturnsPendingPromise guards promise adoption. Both are network-free
// (loopback only / timer-driven), so they are safe in CI.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const MILO_ROOT = join(import.meta.dir, "..");
const RUNTIME_DIR = join(MILO_ROOT, "examples/apps/milojs/tests/runtime");
const RUNTIME_SRC = join(MILO_ROOT, "examples/apps/milojs/milojs.milo");
const OUT = join(mkdtempSync(join(tmpdir(), "milojs-rt-")), "milojs");

beforeAll(() => {
  execSync(`bun run ${join(MILO_ROOT, "src/main.ts")} build ${RUNTIME_SRC} -o ${OUT}`, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}, 300000);

afterAll(() => {
  try { unlinkSync(OUT); } catch {}
});

const files = existsSync(RUNTIME_DIR)
  ? readdirSync(RUNTIME_DIR).filter(f => f.endsWith(".js"))
  : [];

for (const file of files) {
  test(`runtime/${file.replace(".js", "")}`, () => {
    const exp = join(RUNTIME_DIR, file.replace(".js", ".expected"));
    if (!existsSync(exp)) return; // no expectation → nothing to assert
    // -s KILL: a wedged milojs (e.g. a regressed blocking accept) ignores SIGTERM,
    // so the default signal would leave it running past the timeout. A hung
    // fixture must fail loudly, not hang the suite.
    let got: string;
    try {
      got = execSync(`timeout -s KILL 60 ${OUT} ${join(RUNTIME_DIR, file)}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      // timeout kills with 124/137; surface the partial output for debugging.
      throw new Error(`runtime fixture ${file} failed or hung:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    const expected = readFileSync(exp, "utf-8").trim();
    expect(got.trim()).toEqual(expected);
  }, 90000);
}
