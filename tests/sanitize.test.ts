// `--sanitize` must actually instrument, not merely link the ASan runtime.
//
// clang attaches `sanitize_address` in the FRONTEND, which a `.ll` input bypasses
// entirely. Before this was fixed, `-fsanitize=address` over Milo's emitted IR produced
// a binary that linked libclang_rt.asan and instrumented zero functions. The failure was
// silent and looked like success: the malloc/free interceptors still fire, so double-free
// and invalid-free were still reported, and only use-after-free READS passed unnoticed —
// exactly the class the sanitizer is reached for. Symbol presence is the check that
// distinguishes the two, so it is what this test asserts.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MILO = join(import.meta.dir, "..", "src", "main.ts");
const dir = mkdtempSync(join(tmpdir(), "milo-sanitize-"));
// LeakSanitizer rides along with ASan on Linux but not macOS, and a leaked allocation in
// a two-line program would make these tests fail on one platform for a reason none of
// them are about.
const ENV = { ...process.env, ASAN_OPTIONS: "detect_leaks=0" };

// A pointer captured before a reallocating push, read after. Nothing in safe Milo can
// express this, which is the point: it is the shape `unsafe` exists to let through and
// the shape the sanitizer exists to catch.
const UAF = `fn main() {
    var v: Vec<i32> = Vec.new()
    v.push(1)
    v.push(2)
    var x: i32 = 0
    unsafe {
        let p = v.ptr()
        var i: i32 = 0
        while i < 1000 {
            v.push(i)
            i = i + 1
        }
        x = *p
    }
    print(x)
}
`;

test("--sanitize marks emitted functions sanitize_address", () => {
  const src = join(dir, "clean.milo");
  writeFileSync(src, "fn main() { print(\"ok\") }\n");

  const plain = execSync(`bun ${MILO} emit-ir ${src}`, { encoding: "utf-8" });
  expect(plain).not.toContain("sanitize_address");

  const san = execSync(`bun ${MILO} emit-ir --sanitize ${src}`, { encoding: "utf-8" });
  expect(san).toContain("attributes #0 = { sanitize_address }");
  // Every function, not just some: ASan skips any function lacking the attribute, so a
  // partial marking is a partial sanitizer that still reports itself as clean.
  const defines = san.split("\n").filter(l => l.startsWith("define "));
  expect(defines.length).toBeGreaterThan(0);
  expect(defines.filter(l => !l.includes(" #0"))).toEqual([]);
});

test("--sanitize composes with -g (attribute group precedes !dbg)", () => {
  const src = join(dir, "dbg.milo");
  writeFileSync(src, "fn main() { print(\"ok\") }\n");
  const ir = execSync(`bun ${MILO} emit-ir -g --sanitize ${src}`, { encoding: "utf-8" });
  // LLVM requires metadata attachments last; `#0 !dbg !N {` parses, `!dbg !N #0 {` does not.
  expect(ir).toMatch(/^define [^\n]* #0 !dbg !\d+ \{$/m);
  // And it has to survive the verifier, which the emit path alone would not prove.
  execSync(`bun ${MILO} run -g --sanitize ${src}`, { encoding: "utf-8", env: ENV });
}, 120_000);

test("a --sanitize binary carries load/store instrumentation, not just the runtime", () => {
  const src = join(dir, "sym.milo");
  const bin = join(dir, "sym.bin");
  writeFileSync(src, "fn main() { print(\"ok\") }\n");
  execSync(`bun ${MILO} build --sanitize ${src} -o ${bin}`, { encoding: "utf-8" });
  // `nm`, not `nm -u`: clang links libasan statically for executables on Linux, so the
  // interesting symbols are DEFINED there and undefined only on macOS. Asking for the
  // name in any form is the check that means the same thing on both.
  const syms = execSync(`nm ${bin}`, { encoding: "utf-8" });
  // __asan_init alone is what a runtime-only link looks like — the bug this guards.
  expect(syms).toContain("asan_init");
  expect(syms).toMatch(/asan_report_(load|store)/);
}, 120_000);

test("--sanitize reports a use-after-free read", () => {
  const src = join(dir, "uaf.milo");
  writeFileSync(src, UAF);
  let out = "";
  try {
    out = execSync(`bun ${MILO} run --sanitize ${src} 2>&1`, { encoding: "utf-8", env: ENV });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  expect(out).toContain("ERROR: AddressSanitizer: heap-use-after-free");
  expect(out).toContain("READ of size 4");
}, 120_000);

test("without --sanitize the same program is not instrumented", () => {
  const src = join(dir, "uafPlain.milo");
  writeFileSync(src, UAF);
  const ir = execSync(`bun ${MILO} emit-ir ${src}`, { encoding: "utf-8" });
  expect(ir).not.toContain("sanitize_address");
});

// Borrow-capturing closures write through pointers into the caller's frame and into
// `self`. These run clean under ASan; on the compiler before them, a closure moving a
// capture out by reference was a double free (the closure emptied the caller's
// variable and the caller freed it again), which is the inline program below.
test("borrow-capturing closures run clean under --sanitize", () => {
  const consume = join(dir, "closureConsume.milo");
  writeFileSync(consume, `fn take(s: string): i64 {
    return s.len
}

pub fn main(): i32 {
    let s = "a string long enough to live on the heap".clone()
    let f = (): i64 => take(s)
    print(f().toString())
    return 0
}
`);
  const cases: [string, string[]][] = [[consume, ["40"]]];
  for (const name of ["closureCaptureSelf", "closureBorrowedCallbacks", "closureCaptureHeap"]) {
    const src = join(import.meta.dir, "fixtures", `${name}.milo`);
    const want = readFileSync(src, "utf-8").split("\n").filter(l => l.startsWith("// @expect: ")).map(l => l.slice(12));
    cases.push([src, want]);
  }
  for (const [src, want] of cases) {
    let out = "";
    try {
      out = execSync(`bun ${MILO} run --sanitize ${src} 2>&1`, { encoding: "utf-8", env: ENV });
    } catch (e: any) {
      out = (e.stdout ?? "") + (e.stderr ?? "");
    }
    expect(out).not.toContain("AddressSanitizer");
    expect(out.trim().split("\n")).toEqual(want);
  }
}, 240_000);

// Closure bodies drop their own locals at every exit (2026-10-06; before, only an explicit
// `return` did). The new drops must not double-free what the body moved out, what a
// `break` already dropped, or a `move` capture the environment still owns. The inline
// program puts a heap buffer behind each of those paths so a second free is an ASan
// report, not just a duplicated line of output.
test("closure body drops run clean under --sanitize", () => {
  const heap = join(dir, "closureBodyHeap.milo");
  writeFileSync(heap, `fn take(s: string): i64 {
    return s.len
}

fn big(tag: string): string {
    var s = "a heap string long enough to need an allocation: ".clone()
    s.pushStr(tag)
    return s
}

pub fn main(): i32 {
    let cap = big("cap")
    let m = move(): i64 => {
        let a = big("a")
        let b = big("b")
        let n = take(a)
        return n + b.len + cap.len
    }
    print(m().toString())
    let f = (early: bool): void => {
        let x = big("x")
        if early {
            return
        }
        var i = 0
        while i < 3 {
            let y = big("y")
            i = i + 1
            if i == 2 {
                break
            }
            if i == 1 {
                continue
            }
        }
        let z = big("z")
        print(take(z).toString())
    }
    f(true)
    f(false)
    return 0
}
`);
  const cases: [string, string[]][] = [[heap, ["152", "50"]]];
  for (const name of ["closureBodyDrop", "closureBodyDropLoop", "closureBodyDropKinds", "closureBodyDropSpawn", "closureBodyDropTcp", "closureReturnInSretFn"]) {
    const src = join(import.meta.dir, "fixtures", `${name}.milo`);
    const want = readFileSync(src, "utf-8").split("\n").filter(l => l.startsWith("// @expect: ")).map(l => l.slice(12));
    cases.push([src, want]);
  }
  for (const [src, want] of cases) {
    let out = "";
    try {
      out = execSync(`bun ${MILO} run --sanitize ${src} 2>&1`, { encoding: "utf-8", env: ENV, timeout: 60_000 });
    } catch (e: any) {
      out = (e.stdout ?? "") + (e.stderr ?? "");
    }
    expect(out).not.toContain("AddressSanitizer");
    // Linux ASan's swapcontext interceptor prints this once per process whenever green
    // tasks switch stacks (closureBodyDropSpawn); it is a notice, not a finding, and no
    // ASAN_OPTIONS turns it off.
    const lines = out.trim().split("\n").filter(l => !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(l));
    expect(lines).toEqual(want);
  }
}, 300_000);
