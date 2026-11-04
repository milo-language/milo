// Interpreter gaps closed one rule at a time: library behaviour and C functions that need no
// system access (sort and min/max natives, string pieces, error boxing, jsonStringify, ...), and the
// CLI-only FFI. Each title carries the rule IDs it covers (scripts/trace-semantics.ts check (c)).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { Interp } from "../src/interp";
import { runChecked, type RunOptions } from "../src/interp-co";
import { InterpStuck, InterpUnsupported } from "../src/interp-values";
import { BunForeign } from "../src/interp-ffi";
import type { Program } from "../src/ast";
import type { CheckResult } from "../src/checker";

const dir = mkdtempSync(join(tmpdir(), "milo-interp-gaps-"));
let n = 0;
const checkedOf = new Map<Program, CheckResult>();
function check(src: string, name = `t${n++}.milo`): { program: Program; interp: Interp; path: string } {
  const path = join(dir, name);
  writeFileSync(path, src);
  const tokens = new Lexer(src).tokenize();
  const parsed = new Parser(tokens, src, path).parse();
  const program = resolveImports(parsed, dirname(path), getHostTarget(), path);
  const result = new TypeChecker().check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  if (errors.length) throw new Error(`checker rejected the test program: ${errors.map(e => e.message).join("; ")}`);
  checkedOf.set(program, result);
  return { program, interp: new Interp(program, result), path };
}
const run = (src: string, opts: RunOptions = {}, name?: string) => {
  const { program, path } = check(src, name);
  const { result: r } = runChecked(program, checkedOf.get(program)!, { entryFile: path, ...opts });
  return { out: new TextDecoder().decode(r.stdout), code: r.code, live: r.live };
};

test("E-VEC: sort, min, max and sortByKey order ints, floats (a NaN is less than nothing), strings by bytes and false before true", () => {
  const r = run(`
fn main() {
    var v: Vec<i64> = [5, -3, 9, 0]
    v.sort()
    print(v)
    var f: Vec<f64> = [2.5, 0.0 / 0.0, -1.0]
    f.sort()
    print(f.len)
    var b: Vec<bool> = [true, false, true]
    b.sort()
    print(b)
    let s: Vec<string> = ["pear", "app", "Zed"]
    match s.min() { Option.Some(x) => print(x), Option.None => print("none") }
    match s.max() { Option.Some(x) => print(x), Option.None => print("none") }
    var w: Vec<string> = ["ccc", "a", "bb"]
    w.sortByKey((x: &string) => x.len)
    print(w)
}`);
  expect(r.out).toBe("[-3, 0, 5, 9]\n3\n[false, true, true]\nZed\npear\n[\"a\", \"bb\", \"ccc\"]\n");
  expect(r.live).toBe(0);
});

test("R-INT-BITS: rotateLeft, rotateRight, reverseBits and checkedNeg work at the width of the integer", () => {
  const r = run(`
fn main() {
    let a: u8 = 129
    print(a.rotateLeft(1), " ", a.rotateRight(1), " ", a.rotateLeft(9))
    let b: i32 = -2147483648
    print(b.rotateLeft(1), " ", b.rotateRight(31))
    let c: u8 = 1
    print(c.reverseBits())
    print(b.checkedNeg().isNone(), " ", (5 as i32).checkedNeg().unwrapOr(0))
    let z: u32 = 0
    print(z.checkedNeg().isSome(), " ", (3 as u32).checkedNeg().isNone())
}`);
  expect(r.out).toBe("3 192 3\n1 1\n128\ntrue -5\ntrue true\n");
});

test("E-NEW-ITER: lines() drops the final newline and a CR, splitView() keeps empty pieces, and the enumerate form counts from 0", () => {
  const r = run(`
fn main() {
    for line in "a\\r\\nb\\n\\nc\\n".lines() { print("[", line, "]") }
    for p in "x,,y,".splitView(",") { print("<", p, ">") }
    for i, p in "ab".splitView("") { print(i, p) }
}`);
  expect(r.out).toBe("[a]\n[b]\n[]\n[c]\n<x>\n<>\n<y>\n<>\n0a\n1b\n");
});

test("R-JSON-STRINGIFY: a struct of scalars is an object with escaped strings and shortest floats", () => {
  const r = run(`
struct M { s: string, n: i64, f: f64, ok: bool }
fn main() {
    var s = "q\\"\\n"
    s.push(27)
    print(jsonStringify(M { s: s, n: -1, f: 0.1, ok: true }))
}`);
  expect(r.out).toBe(`{"s":"q\\"\\n\\u001b","n":-1,"f":0.1,"ok":true}\n`);
});

test("E-IFACE: ? boxes an error into Heap<Error> (a string as an ErrorMessage), context() wraps it, and ? into a string uses message()", () => {
  const r = run(`
struct Oops { code: i64 }
impl Oops { fn message(self: &Self): string { return $"oops {self.code}" } }
fn fails(): Result<i64, Oops> { return Result.Err(Oops { code: 7 }) }
fn failsStr(): Result<i64, string> { return Result.Err("plain") }
fn boxed(): Result<i64, Heap<Error>> { let x = fails()?; return Result.Ok(x) }
fn boxedStr(): Result<i64, Heap<Error>> { let x = failsStr()?; return Result.Ok(x) }
fn asText(): Result<i64, string> { let x = fails()?; return Result.Ok(x) }
fn main() {
    match boxed() { Result.Ok(_) => print("ok"), Result.Err(e) => print(e.message()) }
    match boxedStr() { Result.Ok(_) => print("ok"), Result.Err(e) => print(e.message()) }
    match asText() { Result.Ok(_) => print("ok"), Result.Err(e) => print(e) }
    match boxed().context("loading") { Result.Ok(_) => print("ok"), Result.Err(e) => print(e.message()) }
}`);
  expect(r.out).toBe("oops 7\nplain\noops 7\nloading: oops 7\n");
  expect(r.live).toBe(0);
});

test("R-EMBED-FILE: @embedFile reads the bytes of a file beside the source through the host reader, and is unsupported without one", () => {
  const src = `fn main() { let s = @embedFile("lib/x.txt")\n print(s.len, " ", s) }`;
  const hostFs = {
    readFile: (p: string) => (p === join(dir, "lib", "x.txt") ? new TextEncoder().encode("hi!") : null),
    readdir: () => null,
    stat: () => null,
  };
  expect(run(src, { sys: { hostFs } }).out).toBe("3 hi!\n");
  expect(() => run(src)).toThrow(InterpUnsupported);
  void InterpStuck;
});

test("R-MEM-ADOPT: h.ptr() is the Heap's own block, adopt takes it back, and adoptSlice cuts a Vec's buffer", () => {
  const r = run(`
from "std/foreign" import { adopt, adoptSlice }
from "std/os" import { malloc, free }
struct P { x: i64, y: i64 }
fn main() {
    let h = Heap(P { x: 7, y: 9 })
    unsafe {
        let slot = h.addrOf() as *i64
        let raw = h.ptr()
        print(raw as i64 == *slot)
        print(raw.x, " ", raw.y)
        forget(h)
        match adopt(raw) { Option.Some(b) => print((*b).x + (*b).y), Option.None => print("none") }
    }
    var v: Vec<i64> = [1, 2, 3, 4, 5]
    unsafe {
        let d = v.ptr()
        forget(v)
        match adoptSlice(d, 3) { Option.Some(w) => print(w.len, " ", w.capacity()), Option.None => print("none") }
        let m = malloc(16) as *P
        free(m as *u8)
    }
}`);
  expect(r.out).toBe("true\\n7 9\\n16\\n3 3\\n".replace(/\\n/g, "\n"));
  expect(r.live).toBe(0);
});

test("R-MEM-ADOPT, R-MEM-LOAD: a malloc block holds a struct with a string in it, and a field of it reads and writes in place", () => {
  const r = run(`
from "std/os" import { malloc, free, memcpy, memset }
struct Inner { a: string, n: i64 }
struct Outer { rc: i64, inner: Inner }
fn main() {
    var tmp = Inner { a: "hey".clone(), n: 3 }
    unsafe {
        let raw = malloc(sizeOf<Outer>())
        memset(raw, 0, sizeOf<Outer>())
        let o = raw as *Outer
        (*o).rc = 1
        memcpy(((*o).inner.addrOf()) as *u8, (tmp.addrOf()) as *u8, sizeOf<Inner>())
        memset((tmp.addrOf()) as *u8, 0, sizeOf<Inner>())
        print((*o).inner.a, " ", (*o).rc, " ", tmp.a.len)
        free(raw)
    }
}`);
  expect(r.out).toBe("hey 1 0\n");
});

test("R-MEM-NULLREF: let-else over a nullable extern reference runs the else on null and otherwise reads the pointee", () => {
  const r = run(`
extern struct Bump { x: i32, y: i32 }
@externalLinkage
pub fn readX(b: ?&Bump): i32 {
    let p = b else { return -1 }
    return p.x
}
fn main() {
    var slot = Bump { x: 41, y: 7 }
    unsafe {
        print(readX(slot.addrOf()))
        print(readX(0 as *Bump))
    }
}`);
  expect(r.out).toBe("41\n-1\n");
});

test("R-SYS-LIBC: strtoll stops at the first bad byte and saturates, strtod reads a float prefix, setlocale and uname answer", () => {
  const r = run(`
extern fn strtoll(s: *u8, end: **u8, base: i32): i64
extern fn strtod(s: *u8, end: *u8): f64
extern fn setlocale(cat: i32, loc: *u8): *u8
extern fn uname(buf: *u8): i32
extern fn strlen(s: *u8): i64
fn main() {
    var end: *u8 = 0 as *u8
    unsafe {
        let a = "  -42xyz".cstr()
        print(strtoll(a, end.addrOf() as **u8, 10), " ", end as i64 - a as i64)
        print(strtoll("ff".cstr(), 0 as **u8, 16), " ", strtoll("0x1F".cstr(), 0 as **u8, 0), " ", strtoll("zz".cstr(), 0 as **u8, 10))
        print(strtoll("99999999999999999999".cstr(), 0 as **u8, 10))
        print(strtod("3.5e2rest".cstr(), 0 as *u8))
        print(strlen(setlocale(2, "UTF-8".cstr())), " ", setlocale(2, "xx_YY".cstr()) as i64)
        var buf: [u8; 2048] = [0; 2048]
        print(uname(buf as *u8))
    }
}`);
  expect(r.out).toBe("-42 5\n255 31 0\n9223372036854775807\n350\n5 0\n0\n");
});

test("R-SYS-TIME: localtime_r follows TZ (UTC, a POSIX offset, an IANA name), mktime inverts it and strftime formats in the C locale", () => {
  const r = run(`
extern fn setenv(n: *u8, v: *u8, o: i32): i32
extern fn localtime_r(t: *i64, out: *u8): *u8
extern fn mktime(tm: *u8): i64
extern fn strftime(buf: *u8, max: i64, fmt: *u8, tm: *u8): i64
fn show(tz: string) {
    var t: i64 = 1705318245
    var tm: [u8; 64] = [0; 64]
    var out: [u8; 64] = [0; 64]
    unsafe {
        setenv("TZ".cstr(), tz.cstr(), 1)
        localtime_r(t.addrOf(), tm as *u8)
        let n = strftime(out as *u8, 64, "%Y-%m-%dT%H:%M:%S %a %b %j %z".cstr(), tm as *u8)
        print(n, " ", _bytesToString(out as *u8, n))
        print(mktime(tm as *u8) == t)
    }
}
fn main() {
    show("UTC")
    show("EST5")
    show("Asia/Tokyo")
}`);
  expect(r.out).toBe("37 2024-01-15T11:30:45 Mon Jan 015 +0000\ntrue\n37 2024-01-15T06:30:45 Mon Jan 015 -0500\ntrue\n37 2024-01-15T20:30:45 Mon Jan 015 +0900\ntrue\n");
});

test("R-SYS-PRINTF: printf and snprintf format integers, floats and strings and count the full output", () => {
  const r = run(`
extern fn printf(fmt: *u8, ...): i32
extern fn snprintf(buf: *u8, n: i64, fmt: *u8, ...): i32
fn main() {
    let s = "hi"
    unsafe {
        printf("[%5d|%-5d|%05d|%x|%X|%o|%c|%s|%.1f|%e|%g|%g|%lld|%%]\\n".cstr(), 42 as i32, 42 as i32, 42 as i32, 255 as i32, 255 as i32, 8 as i32, 65 as i32, s, 2.25, 1234.5, 0.0001, 1e10, 1099511627776)
        var buf: [u8; 8] = [0; 8]
        let n = snprintf(buf as *u8, 8, "%d-%s".cstr(), 12345 as i32, "abcdef".cstr())
        print(n, " ", _cstrToString(buf as *u8))
    }
}`);
  expect(r.out).toBe("[   42|42   |00042|ff|FF|10|A|hi|2.2|1.234500e+03|0.0001|1e+10|1099511627776|%]\n12 12345-a\n");
});

test("R-SYS-SYMLINK: symlink, readlink and stat treat a link as a link, and chmod succeeds on its target", () => {
  const r = run(`
from "std/fs" import { writeFile, readFile, softLink, readLink, isSymlink, setMode }
fn main() {
    let _w = writeFile("/tmp/real.txt", "data")
    softLink("/tmp/real.txt", "/tmp/link.txt")!
    print(isSymlink("/tmp/link.txt"), " ", isSymlink("/tmp/real.txt"))
    print(readLink("/tmp/link.txt")!)
    print(readFile("/tmp/link.txt")!)
    print(setMode("/tmp/link.txt", 384).isOk())
}`);
  expect(r.out).toBe("true false\n/tmp/real.txt\ndata\ntrue\n");
});

const foreign = () => new BunForeign();

test("R-FFI-CALL, R-FFI-LIB: sqlite3_* run in the system sqlite: handles are opaque, text comes back as read-only copies, out-parameters are copied back", () => {
  const r = run(`
from "std/sqlite" import { dbOpen, dbExec, dbQuery, dbStep, dbColumnText, dbColumnInt, dbClose }
fn main() {
    let db = dbOpen(":memory:")!
    dbExec(db, "create table t(a integer, b text)")!
    dbExec(db, "insert into t values (1, 'one'), (2, 'two')")!
    let q = dbQuery(db, "select a, b from t order by a desc")!
    while dbStep(q) {
        print(dbColumnInt(q, 0), " ", dbColumnText(q, 1))
    }
    match dbExec(db, "select * from nope") { Ok(_) => print("ok"), Err(e) => print(e) }
    dbClose(db)
}`, { sys: { foreign: foreign() } });
  expect(r.out).toBe("2 two\n1 one\nno such table: nope\n");
  expect(r.live).toBe(0);
});

test("R-FFI-SQLITE-PATH: a database file named by an interpreter path lives in a private host directory and shows in the interpreter's filesystem", () => {
  const r = run(`
from "std/sqlite" import { dbOpen, dbExec, dbClose }
from "std/fs" import { pathExists, removeFile, fileSizePath }
fn main() {
    let db = dbOpen("/tmp/gaps-test.db")!
    dbExec(db, "create table t(a)")!
    dbClose(db)
    print(pathExists("/tmp/gaps-test.db"))
    print(fileSizePath("/tmp/gaps-test.db").unwrapOr(0) > 0)
    removeFile("/tmp/gaps-test.db")!
    print(pathExists("/tmp/gaps-test.db"))
}`, { sys: { foreign: foreign() } });
  expect(r.out).toBe("true\ntrue\nfalse\n");
});

test("R-FFI-CALL: with no Foreign handed in, a wrapped C library call is unsupported", () => {
  expect(() => run(`
from "std/sqlite" import { dbOpen }
fn main() { let _db = dbOpen(":memory:") }`)).toThrow(InterpUnsupported);
});

test.skipIf(process.platform !== "darwin")("R-FFI-CALL: CommonCrypto digests run in the system library over the interpreter's buffers", () => { // CommonCrypto is macOS-only; Linux std/crypto binds OpenSSL, which BunForeign does not load
  const r = run(`
from "std/crypto" import { Crypto }
fn main() {
    print(Crypto.sha256("abc"))
}`, { sys: { foreign: foreign() } });
  expect(r.out).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n");
});

test("R-FFI-COMPANION: a foo.c beside the program is compiled to a shared library and its externs are called through it; a struct by value is unsupported", () => {
  writeFileSync(join(dir, "comp.c"), "long twice(long x) { return 2 * x; }\nvoid fill(int *p, int n) { for (int i = 0; i < n; i++) p[i] = i * i; }\ntypedef struct { int x; int y; } P;\nint sum_p(P p) { return p.x + p.y; }\n");
  const src = (body: string) => `
extern fn twice(x: i64): i64
extern fn fill(p: *i32, n: i32)
extern struct P { x: i32, y: i32 }
extern fn sum_p(p: P): i32
fn main() {
    ${body}
}`;
  const f = new BunForeign(join(dir, "comp.c"));
  expect(run(src(`
    var a: [i32; 4] = [0; 4]
    unsafe {
        fill(a as *i32, 4)
        print(twice(21), " ", a[3])
    }`), { sys: { foreign: f } }, "comp.milo").out).toBe("42 9\n");
  expect(() => run(src(`unsafe { print(sum_p(P { x: 1, y: 2 })) }`), { sys: { foreign: f } }, "comp2.milo")).toThrow(InterpUnsupported);
});

test("R-FFI-LIB: the foreign layer is its own Bun-only file, and the files the browser bundle reaches import no bun or node module", () => {
  const fs = require("fs") as typeof import("fs");
  const read = (f: string) => fs.readFileSync(join(import.meta.dir, "..", "src", f), "utf-8");
  for (const f of ["interp-mem.ts", "interp-sys.ts", "interp-libc.ts"]) {
    const imports = [...read(f).matchAll(/^import [^;]*from "([^"]+)";/gm)].map(m => m[1]!);
    expect(imports.filter(i => !i.startsWith("./"))).toEqual([]);
  }
  for (const f of ["interp-mem.ts", "interp-sys.ts", "interp-libc.ts", "interp.ts", "interp-natives.ts", "interp-co.ts", "interp-co-natives.ts", "interp-values.ts"]) {
    expect([...read(f).matchAll(/^import [^;]*from "([^"]+)";/gm)].map(m => m[1]!)).not.toContain("./interp-ffi");
  }
  expect(read("interp-ffi.ts")).toContain('from "bun:ffi"');
});

test("R-SYS-REGEX: std/regex over regcomp and regexec finds byte offsets of code-point matches, with classes, anchors and a bad pattern", () => {
  const r = run(`
from "std/regex" import { Regex }
fn main() {
    match Regex.compile("[[:alpha:]]+[0-9]{2}") {
        Result.Ok(re) => {
            match re.find("..é日x42..") { Option.Some(m) => print(m.start, " ", m.end), Option.None => print("none") }
            print(re.findAll("ab12 cd34 ef5").len())
        }
        Result.Err(_) => print("bad")
    }
    match Regex.compile("^a.c$") {
        Result.Ok(re) => print(re.isMatch("aéc"), " ", re.isMatch("xaéc")),
        Result.Err(_) => print("bad")
    }
    match Regex.compile("(unclosed") { Result.Ok(_) => print("ok"), Result.Err(_) => print("rejected") }
}`);
  expect(r.out).toBe("2 10\n2\ntrue false\nrejected\n");
});
