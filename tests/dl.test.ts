import { test, expect, describe } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// std/dl end to end, with the link flags the feature actually requires.
//
// Two directions matter and only one is obvious:
//   - host -> library: dlsym a symbol and call it through `extern (T) => R`
//   - library -> host: the loaded object resolving ITS undefined symbols against
//     the executable, which is what makes a Node-API addon loadable at all
//
// Both need -Wl,-export_dynamic on the host, so this test builds its own binaries
// rather than relying on the fixture runner's flags.

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const dir = mkdtempSync(join(tmpdir(), "milo-dl-"));

function sh(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

// a C library that both exports a symbol and requires one from the host
const cSrc = join(dir, "addon.c");
writeFileSync(cSrc, `
extern int hostValue(void);
int probe(void) { return hostValue() + 1; }
int addTwo(int a, int b) { return a + b; }
`);
const dylib = join(dir, process.platform === "darwin" ? "addon.dylib" : "addon.so");
const dylibFlags = process.platform === "darwin"
  ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
  : ["-shared", "-fPIC"];
sh("clang", [...dylibFlags, "-o", dylib, cSrc]);

function buildMilo(name: string, source: string): string {
  const src = join(dir, `${name}.milo`);
  const bin = join(dir, name);
  writeFileSync(src, source);
  sh("bun", ["run", COMPILER, "build", src, "-o", bin, "-Wl,-export_dynamic"]);
  return bin;
}

describe("std/dl", () => {
  test("loads a library, calls a symbol, and satisfies its host callback", () => {
    const bin = buildMilo("dlhost", `
from "std/io" import { writeStdout }
from "std/dl" import { dlOpen }

// the library resolves this against us at load time
fn hostValue(): i32 {
    return 41
}

fn main() {
    let lib = dlOpen(${JSON.stringify(dylib)})!
    let addPtr = lib.sym("addTwo")!
    let add = addPtr as extern (i32, i32) => i32
    writeStdout("add=" + add(2, 3).toString() + "\\n")

    let probePtr = lib.sym("probe")!
    let probe = probePtr as extern () => i32
    writeStdout("probe=" + probe().toString() + "\\n")

    if lib.has("no_such_symbol_here") {
        writeStdout("bad-has\\n")
    } else {
        writeStdout("has-ok\\n")
    }
}
`);
    const out = sh(bin, []);
    expect(out).toContain("add=5");
    // 42 proves the library called back INTO the milo host
    expect(out).toContain("probe=42");
    expect(out).toContain("has-ok");
  }, 120000);

  test("reports an error for a library that does not exist", () => {
    const bin = buildMilo("dlmissing", `
from "std/io" import { writeStdout }
from "std/dl" import { dlOpen }

fn main() {
    match dlOpen("/nonexistent/definitely-not-here.dylib") {
        Result.Ok(_l) => { writeStdout("unexpected-ok\\n") }
        Result.Err(e) => {
            if e.len() > 0 {
                writeStdout("err-ok\\n")
            } else {
                writeStdout("err-empty\\n")
            }
        }
    }
}
`);
    const out = sh(bin, []);
    expect(out).toContain("err-ok");
  }, 120000);
});
