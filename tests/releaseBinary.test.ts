// Gate: the shipped `bun build --compile` binary — the thing release.yml uploads
// and users actually install — must be able to format. Nothing else in the suite
// exercises it, and the difference is not cosmetic: `milo fmt` from a release
// tarball died with `EROFS: read-only file system, mkdir '/$bunfs'` because it
// tried to build the formatter next to the executable, inside the read-only
// bundle. Every non-checkout user hit it; every test passed.
import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("shipped binary can format", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-release-"));
  const bin = join(dir, "milo");

  execFileSync("bun", ["run", join(ROOT, "scripts", "bundle-stdlib.ts")], { cwd: ROOT });
  execFileSync("bun", ["build", "--compile", join(ROOT, "src", "main.ts"), "--outfile", bin], { cwd: ROOT });
  // The release archive ships milo-opt beside the binary (release.yml); building the
  // formatter compiles Milo, and every compile goes through it.
  copyFileSync(join(ROOT, "mlir", "build", "milo-opt"), join(dir, "milo-opt"));

  const src = join(dir, "t.milo");
  writeFileSync(src, "fn main(){\n  let x  =  1\n  print(\"hi\")\n}\n");

  // XDG_CACHE_HOME redirects the formatter cache so the test can't poison (or be
  // rescued by) the developer's real ~/.milo/cache.
  const run = spawnSync(bin, ["fmt", src], {
    encoding: "utf-8",
    env: { ...process.env, XDG_CACHE_HOME: join(dir, "cache") },
    timeout: 180000,
  });

  expect(run.stderr ?? "").not.toContain("EROFS");
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("    let x = 1");
}, 300000);
