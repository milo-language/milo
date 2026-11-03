#!/usr/bin/env bun
// Cross-target gate for the MLIR backend: each program's LLVM IR for a non-host target must
// be for that target. Details (docs/mlir-backend.md); the module must be for the TARGET:
//   - its `target triple` is the target's, and its `target datalayout` is the literal
//     layout in EXPECT below (not asked of clang, so a host layout leaking into a cross
//     build cannot agree with itself);
//   - functions went through MLIR (the log has "ok" lines);
//   - clang (the one of milo-opt's LLVM) compiles the IR for that target to an object.
// Nothing is linked or run: a foreign binary cannot run here.
//
//   bun scripts/mlir-cross.ts [--targets linux-x64,wasm64] [--filter regex]
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const CLANG = join(process.env.MILO_LLVM_BIN ?? "/opt/homebrew/opt/llvm/bin", "clang");

const EXPECT: Record<string, { triple: string; layout: string }> = {
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", layout: "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", layout: "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32" },
  "windows-x64": { triple: "x86_64-pc-windows-msvc", layout: "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128" },
  "macos-x64": { triple: "x86_64-apple-darwin", layout: "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128" },
  "wasm64": { triple: "wasm64-unknown-unknown", layout: "e-m:e-p:64:64-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20" },
};

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const targets = (opt("--targets") ?? Object.keys(EXPECT).join(",")).split(",");
const filter = opt("--filter") ? new RegExp(opt("--filter")!) : null;

// mlir/test/programs plus a spread of fixtures: enums, structs, closures, strings, externs.
const FIXTURES = ["addressOf", "arrayRepeatStruct", "closureArgThroughFnValue", "coalesceUnboundTempDrop", "enumNicheIntOps", "externStructNested", "fnPtrDispatch", "fstringNestedStrings", "deriveJsonFixedArray", "byRefCaptureMovedIntoThread"];
const files = [
  ...readdirSync(join(ROOT, "mlir", "test", "programs")).filter(f => f.endsWith(".milo")).map(f => join(ROOT, "mlir", "test", "programs", f)),
  ...FIXTURES.map(f => join(ROOT, "tests", "fixtures", `${f}.milo`)),
].filter(f => existsSync(f) && (!filter || filter.test(f)));

const tmp = mkdtempSync(join(tmpdir(), "mlir-cross-"));
let bad = 0, checked = 0, mlirFns = 0;
const fail = (what: string, msg: string) => { bad++; console.log(`FAIL ${what}: ${msg}`); };

for (const t of targets) {
  const want = EXPECT[t];
  if (!want) { console.error(`mlir-cross: no expectation for target ${t}`); process.exit(2); }
  for (const f of files) {
    const what = `${f.slice(ROOT.length + 1)} --target ${t}`;
    const log = join(tmp, "log");
    rmSync(log, { force: true });
    const env = { ...process.env, MILO_MLIR_LOG: log } as Record<string, string>;
    const m = await guardedRun("bun", ["run", MAIN, "emit-ir", f, "--target", t], { env, timeoutMs: 120_000 });
    checked++;
    if (m.code !== 0) { fail(what, `build failed: ${m.stderr.trim().split("\n")[0]}`); continue; }
    const tripleLine = `target triple = "${want.triple}"`;
    if (!m.stdout.split("\n").includes(tripleLine)) fail(what, `mlir module lacks ${tripleLine}`);
    const dl = /^target datalayout = "(.*)"$/m.exec(m.stdout)?.[1];
    if (dl !== want.layout) fail(what, `mlir data layout is ${dl}, want ${want.layout}`);
    const ok = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(x => x.endsWith("\tok")).length : 0;
    if (ok === 0) fail(what, "no function went through MLIR");
    mlirFns += ok;
    const ll = join(tmp, "m.ll");
    await Bun.write(ll, m.stdout);
    const c = await guardedRun(CLANG, [`--target=${want.triple}`, "-c", "-O0", "-Wno-override-module", ll, "-o", join(tmp, "m.o")], { timeoutMs: 120_000 });
    if (c.code !== 0) fail(what, `clang rejects the IR: ${c.stderr.trim().split("\n")[0]}`);
  }
}
rmSync(tmp, { recursive: true, force: true });
if (checked === 0) { console.error("mlir-cross: nothing was checked"); process.exit(2); }
console.log(`mlir-cross: ${checked} (program, target) pairs, ${mlirFns} functions through MLIR, ${bad} failures`);
process.exit(bad ? 1 : 0);
