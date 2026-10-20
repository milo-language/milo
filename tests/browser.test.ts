// std/browser against a real headless Chrome: launch, viewport, color scheme, evaluate, and a
// PNG screenshot. Skipped (with the reason printed) on a machine without Chrome, since the
// module's whole job is talking to one.
import { test, expect, describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const CHROME = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(p => p && existsSync(p));
if (!CHROME) console.log("browser.test.ts: no Chrome installed, skipping");

const PROGRAM = `
from "std/browser" import { Browser, findChrome }
fn main(): i32 {
    var b = Browser.launch(findChrome()!, 9347)!
    b.setViewport(400, 300, 2.0, false)!
    b.setColorScheme("dark")!
    b.navigate("data:text/html,<style>@media (prefers-color-scheme: dark){body{background:rgb(1,2,3)}}</style><title>t</title><p id=p>hi</p>")!
    print(b.evaluate("getComputedStyle(document.body).backgroundColor")!)
    print(b.evaluate("[innerWidth, devicePixelRatio, document.getElementById('p').textContent]")!)
    match b.evaluate("nope()") {
        Ok(_) => print("no error")
        Err(e) => print(if e.contains("nope is not defined") { "threw" } else { e })
    }
    b.screenshot(OUT)!
    b.close()
    return 0
}
`;

describe.skipIf(!CHROME)("std/browser", () => {
  test("drives headless Chrome: dark scheme, viewport, evaluate, PNG", () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-browser-test-"));
    try {
      const png = join(dir, "shot.png");
      const src = join(dir, "shot.milo");
      writeFileSync(src, PROGRAM.replace("OUT", JSON.stringify(png)));
      const r = Bun.spawnSync(["bun", "run", join(ROOT, "src", "main.ts"), "run", src], { env: { ...process.env, CHROME: CHROME! } });
      expect(r.stderr.toString()).not.toContain("error");
      expect(r.stdout.toString().trim().split("\n")).toEqual(['"rgb(1, 2, 3)"', '[400,2,"hi"]', "threw"]);
      const bytes = readFileSync(png);
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      // 400x300 CSS pixels at a device pixel ratio of 2
      expect(bytes.readUInt32BE(16)).toBe(800);
      expect(bytes.readUInt32BE(20)).toBe(600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
