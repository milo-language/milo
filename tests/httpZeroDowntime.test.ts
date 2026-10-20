// Zero-downtime restarts for std/http: opt-in socket activation (LISTEN_FDS), SIGTERM drain and the
// connection cap. tests/http-zero-downtime/harness.py plays systemd (owns the listening
// socket, hands it over as fd 3, restarts the server under load); each mode exits non-zero
// on any failed request or missed deadline and prints its totals.
import { test, expect, beforeAll, describe } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const DIR = join(ROOT, "tests", "http-zero-downtime");
const havePython = (() => {
  try { execFileSync("python3", ["--version"], { stdio: "pipe" }); return true; } catch { return false; }
})();
const posix = process.platform !== "win32";
let bin = "";

beforeAll(() => {
  if (!havePython || !posix) return;
  bin = join(mkdtempSync(join(tmpdir(), "zd-")), "server");
  execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build", join(DIR, "server.milo"), "-o", bin],
    { cwd: ROOT, stdio: "pipe" });
}, 120_000);

function mode(name: string): void {
  const r = spawnSync("python3", ["-u", join(DIR, "harness.py"), name, bin], { encoding: "utf8", timeout: 100_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  console.log(out);
  expect(out).toContain(`${name}: PASS`);
  expect(r.status).toBe(0);
}

describe.skipIf(!havePython || !posix)("std/http zero-downtime", () => {
  test("20 restarts under load lose no request", () => mode("restart"), 110_000);
  test("maxConn bounds concurrency; the excess queues in the kernel", () => mode("cap"), 30_000);
  test("a handler longer than drainMs is cut at the cap", () => mode("drain"), 30_000);
  test("a long-lived stream is closed when the drain starts", () => mode("stream"), 30_000);
  test("without LISTEN_FDS the server binds itself", () => mode("plain"), 30_000);
  test("activation is opt-in: announced when taken, refused when not asked for", () => mode("explicit"), 30_000);
});
