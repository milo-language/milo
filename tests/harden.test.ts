// `milo harden` (src/harden.ts, src/harden-rewrites.ts): each rewrite as an exact
// input/output pair, each refusal as "the file is left alone", and the gates themselves.
// Every program has a `main`, so the interpreter comparison runs on all of them.
import { test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenFile } from "../src/harden";

// Each case checks and interprets the program a few times; a loaded machine needs the room.
setDefaultTimeout(120000);

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const dir = mkdtempSync(join(tmpdir(), "harden-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function run(source: string) {
  const path = join(dir, `t${n++}.milo`);
  writeFileSync(path, source);
  return { path, res: hardenFile(path, false) };
}
// The hardened text, or the input when nothing changed.
// A refusal test must run on a program that checks, or "nothing changed" proves nothing.
const out = (source: string) => { const { res } = run(source); expect(res.status).toBe("ok"); return res.newSource ?? source; };
const rewrites = (source: string) => { const { res } = run(source); expect(res.status).toBe("ok"); return res.accepted.map(a => a.rewrite); };

test("index loop becomes for-in", () => {
  const before = `fn sum(v: &Vec<i64>): i64 {
    var t: i64 = 0
    for i in 0..v.len {
        t += v[i]
    }
    return t
}

fn main(): i32 {
    var v: Vec<i64> = Vec.new()
    v.push(3)
    v.push(4)
    print(sum(v))
    return 0
}
`;
  const { res } = run(before);
  expect(res.newSource).toBe(before.replace("for i in 0..v.len {\n        t += v[i]", "for x in v {\n        t += x"));
  expect(res.behaviour).toBe("verified");
  expect(res.rejected).toEqual([]);
});

test("index loop over a field path", () => {
  const before = `struct Bag { items: Vec<i64> }

fn total(b: &Bag): i64 {
    var t: i64 = 0
    for i in 0..b.items.len {
        t += b.items[i]
    }
    return t
}

fn main(): i32 {
    var b = Bag { items: [] }
    b.items.push(5)
    print(total(b))
    return 0
}
`;
  expect(out(before)).toBe(before.replace("for i in 0..b.items.len {\n        t += b.items[i]", "for x in b.items {\n        t += x"));
});

const MAIN_FOR = (body: string, decl = "v: &mut Vec<i64>") => `fn f(${decl}): i64 {
    var t: i64 = 0
${body}
    return t
}

fn main(): i32 {
    var v: Vec<i64> = Vec.new()
    v.push(1)
    v.push(2)
    print(f(&mut v))
    return 0
}
`;

test("index loop is left alone when the index is also written through", () => {
  const src = MAIN_FOR(`    for i in 0..v.len {
        v[i] = v[i] + 1
        t += v[i]
    }`);
  expect(rewrites(src)).toEqual([]);
  expect(out(src)).toBe(src);
});

test("index loop is left alone when i is used for anything else", () => {
  const src = MAIN_FOR(`    for i in 0..v.len {
        t += v[i] * (i as i64)
    }`);
  expect(rewrites(src)).toEqual([]);
  const other = MAIN_FOR(`    for i in 0..v.len {
        if i > 0 {
            t += v[i - 1]
        }
    }`);
  expect(rewrites(other)).toEqual([]);
});

test("index loop is left alone when the vector is mutated in the body", () => {
  const src = MAIN_FOR(`    for i in 0..v.len {
        t += v[i]
        if i == 0 {
            v.push(9)
        }
    }`);
  expect(rewrites(src)).toEqual([]);
  expect(out(src)).toBe(src);
});

test("match that re-wraps the error becomes ?", () => {
  const before = `fn parse(s: string): Result<i64, string> {
    if s.len == 0 {
        return Result.Err("empty")
    }
    return Result.Ok(s.len as i64)
}

fn twice(s: string): Result<i64, string> {
    let n = match parse(s) {
        Result.Ok(v) => v,
        Result.Err(e) => {
            return Result.Err(e)
        }
    }
    return Result.Ok(n * 2)
}

fn main(): i32 {
    print(twice("abc") ?? 0)
    return 0
}
`;
  const expected = before.replace(/    let n = match parse\(s\) \{[\s\S]*?\n    \}\n/, "    let n = parse(s)?\n");
  expect(out(before)).toBe(expected);
  expect(rewrites(before)).toEqual(["match-to-try"]);
});

test("match on an Option that returns None becomes ?", () => {
  const before = `fn inc(o: Option<i64>): Option<i64> {
    let r = match o {
        Option.Some(x) => x,
        Option.None => {
            return Option.None
        }
    }
    return Option.Some(r + 1)
}

fn main(): i32 {
    print(inc(Option.Some(4)) ?? 0)
    return 0
}
`;
  const expected = before.replace(/    let r = match o \{[\s\S]*?\n    \}\n/, "    let r = o?\n");
  expect(out(before)).toBe(expected);
});

test("match that changes the error or the value is left alone", () => {
  const changesError = `fn parse(s: string): Result<i64, string> {
    return Result.Ok(s.len as i64)
}

fn twice(s: string): Result<i64, string> {
    let n = match parse(s) {
        Result.Ok(v) => v,
        Result.Err(e) => {
            return Result.Err("failed")
        }
    }
    return Result.Ok(n)
}

fn main(): i32 {
    print(twice("a") ?? 0)
    return 0
}
`;
  expect(rewrites(changesError)).toEqual([]);
  const changesValue = changesError.replace(`"failed"`, "e").replace("Result.Ok(v) => v,", "Result.Ok(v) => v + 1,");
  expect(rewrites(changesValue)).toEqual([]);
});

test("isSome plus unwrap becomes if let", () => {
  const before = `fn show(o: Option<i64>): void {
    if o.isSome() {
        print(o! + 1)
    }
}

fn main(): i32 {
    show(Option.Some(4))
    show(Option.None)
    return 0
}
`;
  expect(out(before)).toBe(`fn show(o: Option<i64>): void {
    if let Option.Some(oVal) = o {
        print(oVal + 1)
    }
}

fn main(): i32 {
    show(Option.Some(4))
    show(Option.None)
    return 0
}
`);
});

test("isSome is left alone when the option is used any other way", () => {
  const whole = `fn show(o: Option<i64>): void {
    if o.isSome() {
        print(o! + 1)
        print(o.isNone())
    }
}

fn main(): i32 {
    show(Option.Some(4))
    return 0
}
`;
  expect(rewrites(whole)).toEqual([]);
  const written = `fn show(): void {
    var o: Option<i64> = Option.Some(4)
    if o.isSome() {
        print(o! + 1)
        o = Option.None
    }
    print(o.isNone())
}

fn main(): i32 {
    show()
    return 0
}
`;
  expect(rewrites(written)).toEqual([]);
});

test("clone on the last use becomes a move", () => {
  const before = `fn keep(v: Vec<i64>): Vec<i64> {
    print(v.len)
    let w = v.clone()
    return w
}

fn main(): i32 {
    var v: Vec<i64> = Vec.new()
    v.push(1)
    print(keep(v).len)
    return 0
}
`;
  expect(out(before)).toBe(before.replace("let w = v.clone()", "let w = v"));
  expect(rewrites(before)).toEqual(["last-use-clone"]);
});

test("clone that is not the last use is kept", () => {
  const before = `fn keep(v: Vec<i64>): Vec<i64> {
    let w = v.clone()
    print(v.len)
    return w
}

fn main(): i32 {
    var v: Vec<i64> = Vec.new()
    v.push(1)
    print(keep(v).len)
    return 0
}
`;
  expect(rewrites(before)).toEqual([]);
  // A later iteration needs the value again.
  const inLoop = `fn keep(v: Vec<i64>): i64 {
    var t: i64 = 0
    for k in 0..2 {
        let w = v.clone()
        t += w.len
    }
    return t
}

fn main(): i32 {
    var v: Vec<i64> = Vec.new()
    v.push(1)
    print(keep(v))
    return 0
}
`;
  expect(rewrites(inLoop)).toEqual([]);
});

test("clone of a borrowed value is kept", () => {
  const before = `fn keep(v: &Vec<i64>): Vec<i64> {
    let w = v.clone()
    return w
}

fn main(): i32 {
    var v: Vec<i64> = Vec.new()
    v.push(1)
    print(keep(v).len)
    return 0
}
`;
  expect(rewrites(before)).toEqual([]);
});

test("a second run changes nothing, and a file that does not check is skipped", () => {
  const before = `fn sum(v: &Vec<i64>): i64 {
    var t: i64 = 0
    for i in 0..v.len {
        t += v[i]
    }
    return t
}

fn main(): i32 {
    let v: Vec<i64> = Vec.new()
    print(sum(v))
    return 0
}
`;
  const first = run(before);
  const again = run(first.res.newSource!);
  expect(again.res.newSource).toBeUndefined();
  expect(again.res.accepted).toEqual([]);
  const broken = run(`fn main(): i32 { return "x" }\n`);
  expect(broken.res.status).toBe("skipped");
});

test("harden prints a diff by default and rewrites only with --write", () => {
  const src = `fn show(o: Option<i64>): void {
    if o.isSome() {
        print(o! + 1)
    }
}

fn main(): i32 {
    show(Option.Some(4))
    return 0
}
`;
  const path = join(dir, "cli.milo");
  writeFileSync(path, src);
  const diff = spawnSync("bun", ["run", MAIN, "harden", path], { encoding: "utf8" });
  expect(diff.status).toBe(0);
  expect(diff.stdout).toContain("-    if o.isSome() {");
  expect(diff.stdout).toContain("+    if let Option.Some(oVal) = o {");
  expect(readFileSync(path, "utf-8")).toBe(src);
  const written = spawnSync("bun", ["run", MAIN, "harden", path, "--write"], { encoding: "utf8" });
  expect(written.status).toBe(0);
  expect(readFileSync(path, "utf-8")).toContain("if let Option.Some(oVal) = o {");
  expect(spawnSync("bun", ["run", MAIN, "interp", path], { encoding: "utf8" }).stdout).toBe("5\n");
});
