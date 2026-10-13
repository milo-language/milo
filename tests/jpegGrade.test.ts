// std/jpeg against libjpeg-turbo itself (scripts/jpeg-grade.ts), when cjpeg/djpeg exist.
//
// The fixtures pin a dozen frozen djpeg/cjpeg outputs; this regenerates ~130 decoder and
// ~80 encoder cases from the live tools and requires every one to be bit-exact (decode)
// and byte-identical (encode). Without libjpeg-turbo on PATH it says so and passes: the
// frozen fixtures still gate.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("std/jpeg matches libjpeg-turbo bit for bit", () => {
  const r = spawnSync("bun", [join(ROOT, "scripts", "jpeg-grade.ts")], { cwd: ROOT, encoding: "utf-8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (/skipped/.test(out)) {
    console.log(out.trim());
    return;
  }
  expect(r.status, out).toBe(0);
  const dec = /decode: (\d+) cases, (\d+) bit-exact/.exec(out);
  const enc = /encode: (\d+) cases, (\d+) byte-identical/.exec(out);
  expect(dec, out).not.toBeNull();
  expect(enc, out).not.toBeNull();
  expect(+dec![1]!).toBeGreaterThan(100);
  expect(dec![2]).toBe(dec![1]);
  expect(+enc![1]!).toBeGreaterThan(50);
  expect(enc![2]).toBe(enc![1]);
}, 600_000);
