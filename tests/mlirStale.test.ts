// A default build with a milo-opt built from older sources than mlir/ holds must stop with
// "milo-opt is stale", not fail every fixture on an unknown pass flag (it did: 1073 at once).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { staleMiloOpt } from "../src/mlir-backend";

let dir = "";
const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-stale-"));
  mkdirSync(join(dir, "mlir", "build"), { recursive: true });
  for (const f of ["Milo.td", "Scalar.cpp", "Milo.h", "CMakeLists.txt", "README.md"]) {
    writeFileSync(join(dir, "mlir", f), "");
    utimesSync(join(dir, "mlir", f), t(0), t(0));
  }
  writeFileSync(join(dir, "mlir", "build", "milo-opt"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bin = () => join(dir, "mlir", "build", "milo-opt");

test("a milo-opt newer than every source is current", () => {
  utimesSync(bin(), t(10), t(10));
  expect(staleMiloOpt(bin(), join(dir, "mlir"))).toBeNull();
});

for (const f of ["Milo.td", "Scalar.cpp", "Milo.h", "CMakeLists.txt"]) {
  test(`an edited ${f} makes it stale`, () => {
    utimesSync(bin(), t(10), t(10));
    utimesSync(join(dir, "mlir", f), t(20), t(20));
    expect(staleMiloOpt(bin(), join(dir, "mlir"))).toBe(f);
    utimesSync(join(dir, "mlir", f), t(0), t(0));
  });
}

test("a doc edit does not", () => {
  utimesSync(bin(), t(10), t(10));
  utimesSync(join(dir, "mlir", "README.md"), t(20), t(20));
  expect(staleMiloOpt(bin(), join(dir, "mlir"))).toBeNull();
});

test("the compiler refuses a stale milo-opt with the build command", () => {
  utimesSync(bin(), t(10), t(10));
  utimesSync(join(dir, "mlir", "Scalar.cpp"), t(20), t(20));
  const src = join(dir, "a.milo");
  writeFileSync(src, "fn add(a: i32, b: i32): i32 { return a + b }\nfn main() { print(add(1, 2)) }\n");
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "main.ts"), "emit-ir", src], {
    encoding: "utf-8", env: { ...process.env, MILO_MLIR: "1", MILO_LEGACY: "", MILO_OPT: bin() },
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("milo-opt is stale (mlir/Scalar.cpp is newer");
  expect(r.stderr).toContain("run sh mlir/build.sh");
});

test("MILO_LEGACY=1 never runs milo-opt, stale or not", () => {
  utimesSync(bin(), t(10), t(10));
  utimesSync(join(dir, "mlir", "Scalar.cpp"), t(20), t(20));
  const src = join(dir, "a.milo");
  writeFileSync(src, "fn add(a: i32, b: i32): i32 { return a + b }\nfn main() { print(add(1, 2)) }\n");
  const r = spawnSync("bun", ["run", join(import.meta.dir, "..", "src", "main.ts"), "emit-ir", src], {
    encoding: "utf-8", env: { ...process.env, MILO_LEGACY: "1", MILO_OPT: bin() },
  });
  expect(r.status).toBe(0);
  expect(r.stderr).not.toContain("stale");
});
