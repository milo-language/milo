#!/usr/bin/env bun
// Falsifier for std/json and @derive(Json): the two paths a JSON API server leans on
// (derived toJson for every response, Json.parse + doc.strAt/curField for every upstream
// feed). Two halves, both built with --sanitize so a heap error is a finding, not a flake.
//
//   rt     Random struct shapes (nested structs, unit enums, Option, Vec, HashMap<string, i64>,
//          every integer width at its edges, f64, strings with quotes, backslashes, control
//          bytes, braces, 2/3/4-byte UTF-8) with random values written as literals. The
//          generated program prints toJson, decodes it with fromJson and re-encodes, and
//          reads every top-level string field back through Json.parse + doc.strAt. The oracle
//          is a host model that emits the expected JSON independently: formatting is
//          normalised (string escapes re-encoded, floats compared numerically) so only a real
//          value difference counts. Any mismatch, ASan report, crash, or `fromJson` of its own
//          `toJson` failing is a finding.
//   parse  Hostile text: valid documents mutated (truncated, bytes inserted/deleted, invalid
//          UTF-8, lone surrogate escapes, BOM, trailing garbage, duplicate keys, 400-digit
//          numbers, 1e999999, 100k-deep nesting, huge arrays) fed to Json.parse, a cursor walk,
//          doc.strAt/i64At/curPath, pretty-print + reparse, and a derived struct's fromJson.
//          Findings: crash / ASan / hang (the reached case is named from the line-buffered
//          output and skipped on the next pass), a document JS accepts that Json.parse rejects,
//          or pretty() output that does not reparse. Json.parse ACCEPTING what JS rejects is
//          counted separately as leniency, not a finding.
//
// Usage: bun scripts/fuzz-json.ts [--mode rt|parse|both] [--cases N] [--batch N] [--seed N]
//          [--parse-cases N] [--keep] [--verbose]
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const MILO = process.env.MILO_ROOT ? join(process.env.MILO_ROOT, "src", "main.ts") : join(ROOT, "src", "main.ts");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const strArg = (flag: string, dflt: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const MODE = strArg("--mode", "both");
const CASES = argOf("--cases", 60);
const BATCH = argOf("--batch", 6);
const SEED = argOf("--seed", 1);
const PARSE_CASES = argOf("--parse-cases", 600);
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------------------
// Normalisation: both sides are rewritten so escape spelling and float spelling cannot
// produce a difference. Integers (the i64 edge values) stay textual, so precision loss in
// the host is impossible.
function normalise(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, m => {
    if (m[0] === '"') return JSON.stringify(JSON.parse(m));
    if (/^-?\d+$/.test(m)) return m;
    return String(Number(m));
  });
}

// ---------------------------------------------------------------------------------------
// rt half
type Ty =
  | { k: "str" } | { k: "bool" } | { k: "f64" } | { k: "enum" }
  | { k: "int"; ty: string; lo: bigint; hi: bigint }
  | { k: "opt"; inner: Ty } | { k: "vec"; inner: Ty } | { k: "map" }
  | { k: "struct"; idx: number };

const INTS = [
  { ty: "i8", lo: -128n, hi: 127n }, { ty: "u8", lo: 0n, hi: 255n },
  { ty: "i16", lo: -32768n, hi: 32767n }, { ty: "u16", lo: 0n, hi: 65535n },
  { ty: "i32", lo: -2147483648n, hi: 2147483647n }, { ty: "u32", lo: 0n, hi: 4294967295n },
  { ty: "i64", lo: -9223372036854775808n, hi: 9223372036854775807n },
  { ty: "u64", lo: 0n, hi: 18446744073709551615n },
];
const STR_POOL = [
  "", " ", "a", "hello world", "\"", "\\", "\\\"", "\"\"", "a\"b\\c", "\n", "\t\r", "line1\nline2",
  "\u0001", "\u001f", "\u007f", "\u0000", "{", "}", "{x}", "{{", "$", "%s", "/", "</script>", "é",
  "café", "日本語", "😀", "x😀y", "  ", "﻿", "\u0080",
  "߿", "ࠀ", "￿", "퟿", "", "\u{10ffff}", "\u{10000}", "a".repeat(300), "\\u0041", "\\n",
];

type Pick = <T>(xs: T[]) => T;

function milStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "{" || ch === "}") out += `\\u{${c.toString(16)}}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

function genCase(seed: number, k: number): { src: string; fn: string; expect: string; strPaths: { path: string; val: string }[] } {
  const rnd = rng(seed);
  const pick: Pick = xs => xs[Math.floor(rnd() * xs.length)]!;
  const P = `C${k}`;
  const nStruct = 1 + Math.floor(rnd() * 3);
  const structs: { fields: { name: string; ty: Ty }[] }[] = [];
  const tyName = (t: Ty): string => {
    switch (t.k) {
      case "str": return "string"; case "bool": return "bool"; case "f64": return "f64";
      case "enum": return `${P}E`; case "int": return t.ty;
      case "opt": return `Option<${tyName(t.inner)}>`; case "vec": return `Vec<${tyName(t.inner)}>`;
      case "map": return "HashMap<string, i64>"; case "struct": return `${P}S${t.idx}`;
    }
  };
  const genTy = (depth: number, idx: number): Ty => {
    const r = rnd();
    if (r < 0.2) return { k: "str" };
    if (r < 0.4) { const i = pick(INTS); return { k: "int", ...i }; }
    if (r < 0.46) return { k: "bool" };
    if (r < 0.52) return { k: "f64" };
    if (r < 0.58) return { k: "enum" };
    if (r < 0.62) return { k: "map" };
    if (depth >= 2) return { k: "str" };
    if (r < 0.74) { const inn = genTy(depth + 1, idx); return inn.k === "opt" ? inn : { k: "opt", inner: inn }; }
    if (r < 0.86) return { k: "vec", inner: genTy(depth + 1, idx) };
    if (idx > 0) return { k: "struct", idx: Math.floor(rnd() * idx) };
    return { k: "int", ...pick(INTS) };
  };
  for (let i = 0; i < nStruct; i++) {
    const n = 1 + Math.floor(rnd() * 6);
    structs.push({ fields: Array.from({ length: n }, (_, j) => ({ name: `f${j}`, ty: genTy(0, i) })) });
  }
  const decl: string[] = [`enum ${P}E {`, "    Ea,", "    Eb,", "    Ec,", "}", ""];
  structs.forEach((s, i) => {
    decl.push("@derive(Json)", `struct ${P}S${i} {`);
    for (const f of s.fields) decl.push(`    ${f.name}: ${tyName(f.ty)},`);
    decl.push("}", "");
  });

  const body: string[] = [];
  let tmp = 0;
  const intVal = (t: { lo: bigint; hi: bigint }): bigint => {
    const edges = [t.lo, t.hi, 0n, 1n, -1n, t.lo + 1n, t.hi - 1n, 127n, 128n, 255n, 256n, 65535n, 2147483647n, 2147483648n, 4294967295n]
      .filter(v => v >= t.lo && v <= t.hi);
    if (rnd() < 0.6) return pick(edges);
    const v = BigInt(Math.floor(rnd() * 2000) - 1000);
    return v < t.lo ? t.lo : v > t.hi ? t.hi : v;
  };
  const strVal = () => {
    if (rnd() < 0.5) return pick(STR_POOL);
    let s = ""; const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) s += pick(STR_POOL);
    return s;
  };
  const strPaths: { path: string; val: string }[] = [];
  // returns [milo expr, expected json text]
  const gen = (t: Ty, path: string | null): [string, string] => {
    switch (t.k) {
      case "str": { const v = strVal(); if (path) strPaths.push({ path, val: v }); return [milStr(v), JSON.stringify(v)]; }
      case "bool": { const b = rnd() < 0.5; return [String(b), String(b)]; }
      case "f64": { const v = pick([0.5, -2.25, 1024, 0, 3.0e10, 1.5e-7, 123456.789, -1e15]); const lit = Number.isInteger(v) ? `${v}.0` : String(v); return [lit.includes("e") ? lit : lit, String(v)]; }
      case "enum": { const v = pick(["Ea", "Eb", "Ec"]); return [`${P}E.${v}`, `"${v}"`]; }
      case "int": {
        const v = intVal(t);
        const lit = v === t.lo && t.lo < 0n ? `(${t.lo + 1n} - 1)` : String(v);
        return [lit, String(v)];
      }
      case "opt": {
        if (rnd() < 0.4) return ["Option.None", "null"];
        const [e, j] = gen(t.inner, null);
        return [`Option.Some(${e})`, j];
      }
      case "vec": {
        const name = `v${tmp++}`;
        const n = Math.floor(rnd() * 4);
        body.push(`    ${n ? "var" : "let"} ${name}: ${tyName(t)} = Vec.new()`);
        const js: string[] = [];
        for (let i = 0; i < n; i++) { const [e, j] = gen(t.inner, null); body.push(`    ${name}.push(${e})`); js.push(j); }
        return [name, `[${js.join(",")}]`];
      }
      case "map": {
        const name = `m${tmp++}`;
        const keys = ["a", "b", "k\\\"q", "z"].slice(0, Math.floor(rnd() * 4));
        body.push(`    ${keys.length ? "var" : "let"} ${name}: HashMap<string, i64> = HashMap.new()`);
        const entries: [string, bigint][] = [];
        for (const key of keys) {
          const raw = key.replace('\\"', '"');
          const v = intVal(INTS[6]!);
          const lit = v === INTS[6]!.lo ? "(-9223372036854775807 - 1)" : String(v);
          body.push(`    ${name}.insert(${milStr(raw)}, ${lit})`);
          entries.push([raw, v]);
        }
        entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        return [name, `{${entries.map(([a, b]) => `${JSON.stringify(a)}:${b}`).join(",")}}`];
      }
      case "struct": return genStruct(t.idx, path);
    }
  };
  const genStruct = (idx: number, path: string | null): [string, string] => {
    const fs = structs[idx]!.fields;
    const parts: string[] = []; const js: string[] = [];
    for (const f of fs) {
      const [e, j] = gen(f.ty, path === null ? null : (path ? `${path}.${f.name}` : f.name));
      parts.push(`${f.name}: ${e}`);
      js.push(`${JSON.stringify(f.name)}:${j}`);
    }
    return [`${P}S${idx} { ${parts.join(", ")} }`, `{${js.join(",")}}`];
  };
  const root = nStruct - 1;
  const [expr, json] = genStruct(root, "");
  const fn = `case${k}`;
  const lines = [`fn ${fn}(): i32 {`, ...body, `    let r = ${expr}`, `    let text = r.toJson()`, `    print("T${k}:" + text)`,
    `    match ${P}S${root}.fromJson(text) {`,
    `        Result.Ok(back) => {`,
    `            let again = back.toJson()`,
    `            if again == text { print("R${k}:same") } else { print("R${k}:diff:" + again) }`,
    `        }`,
    `        Result.Err(e) => { print("R${k}:err:" + e.message()) }`,
    `    }`,
    `    match Json.parse(text) {`,
    `        Result.Ok(doc) => {`];
  strPaths.forEach((sp, i) => {
    lines.push(`            match doc.strAt(doc.curRoot(), ${milStr(sp.path)}) {`,
      `                Option.Some(s) => { print("S${k}.${i}:" + jsonQuote(s)) }`,
      `                Option.None => { print("S${k}.${i}:NONE") }`,
      `            }`);
  });
  lines.push(`        }`, `        Result.Err(e) => { print("P${k}:err:" + e) }`, `    }`, `    return 0`, `}`);
  return { src: decl.join("\n") + "\n" + lines.join("\n") + "\n", fn, expect: json, strPaths };
}

type Finding = { kind: string; detail: string; file?: string };
const findings: Finding[] = [];

function buildAndRun(dir: string, name: string, src: string, args: string[], timeoutMs: number) {
  const file = join(dir, `${name}.milo`), bin = join(dir, name);
  writeFileSync(file, src);
  const b = spawnSync("bun", [MILO, "build", file, "-o", bin, "--sanitize"], { encoding: "utf-8", timeout: 300000 });
  if (b.status !== 0) return { compileFail: (b.stdout + b.stderr).slice(0, 1500), out: "", err: "", status: -1, timedOut: false, file };
  const r = spawnSync(bin, args, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1 << 28, env: { ...process.env, MILO_LINE_BUFFERED: "1", ASAN_OPTIONS: "detect_leaks=0" } });
  return { compileFail: "", out: r.stdout ?? "", err: r.stderr ?? "", status: r.status ?? -1, timedOut: r.error?.message.includes("ETIMEDOUT") ?? false, file };
}

function runRt(dir: string): { programs: number; cases: number } {
  let programs = 0, cases = 0;
  for (let p = 0; p * BATCH < CASES; p++) {
    const gens = Array.from({ length: BATCH }, (_, k) => genCase(SEED * 100003 + p * 64 + k, k));
    const src = `from "std/json" import { Json, jsonQuote }\n\n` + gens.map(g => g.src).join("\n") +
      `\npub fn main(): i32 {\n${gens.map(g => `    ${g.fn}()`).join("\n")}\n    return 0\n}\n`;
    const r = buildAndRun(dir, `rt${p}`, src, [], 60000);
    programs++;
    if (r.compileFail) { findings.push({ kind: "rt-compile-fail", detail: r.compileFail, file: r.file }); continue; }
    if (r.timedOut) findings.push({ kind: "rt-hang", detail: r.out.slice(-300), file: r.file });
    if (r.status !== 0 || /AddressSanitizer|panic|runtime error/.test(r.err)) findings.push({ kind: "rt-crash", detail: `status=${r.status}\n${r.err.slice(0, 1200)}\nlast out: ${r.out.slice(-200)}`, file: r.file });
    const lines = r.out.split("\n");
    gens.forEach((g, k) => {
      cases++;
      const t = lines.find(l => l.startsWith(`T${k}:`));
      if (t === undefined) return; // crash already reported
      if (normalise(t.slice(`T${k}:`.length)) !== normalise(g.expect)) findings.push({ kind: "rt-toJson-mismatch", detail: `case ${k}\n got ${t.slice(0, 600)}\nwant ${g.expect.slice(0, 600)}`, file: r.file });
      const rr = lines.find(l => l.startsWith(`R${k}:`));
      if (rr !== `R${k}:same`) findings.push({ kind: "rt-fromJson", detail: `case ${k}: ${rr?.slice(0, 600)}`, file: r.file });
      g.strPaths.forEach((sp, i) => {
        const s = lines.find(l => l.startsWith(`S${k}.${i}:`));
        const want = JSON.stringify(sp.val);
        if (s === undefined || normalise(s.slice(`S${k}.${i}:`.length)) !== want) findings.push({ kind: "rt-strAt-mismatch", detail: `case ${k} path ${sp.path}: got ${s?.slice(0, 200)} want ${want.slice(0, 200)}`, file: r.file });
      });
    });
    if (VERBOSE) console.error(`rt program ${p}: ${findings.length} findings so far`);
  }
  return { programs, cases };
}

// ---------------------------------------------------------------------------------------
// parse half
const PARSE_PROGRAM = `from "std/json" import { Json }
from "std/fs" import { readFile }
from "std/args" import { args }
from "std/strconv" import { parseInt }

enum PE {
    Pa,
    Pb,
}

@derive(Json)
struct PIn {
    v: i64,
    w: Option<string>,
}

@derive(Json)
struct Probe {
    s: string,
    n: i64,
    b: u8,
    f: f64,
    t: bool,
    e: PE,
    o: Option<string>,
    l: Vec<i64>,
    inner: PIn,
    items: Vec<PIn>,
    m: HashMap<string, i64>,
}

fn walk(doc: &Json, cur: i64, depth: i64): i64 {
    if depth > 40 {
        return 1
    }
    let k = doc.curKind(cur)
    var n: i64 = 1
    if k == 4 || k == 5 {
        for i in 0..doc.curLen(cur) {
            n += walk(doc, doc.curChild(cur, i), depth + 1)
        }
    } else if k == 3 {
        match doc.curStr(cur) {
            Option.Some(s) => { n += s.len() }
            Option.None => { n += 0 }
        }
    } else if k == 2 {
        match doc.curInt(cur) {
            Option.Some(v) => { n += v & 1 }
            Option.None => { n += 0 }
        }
        match doc.curFloat(cur) {
            Option.Some(f) => { n += 1 }
            Option.None => { n += 0 }
        }
        n += doc.curRaw(cur).len()
    }
    return n
}

pub fn main(): i32 {
    let a = args()
    let dir = a[1]
    let from = parseInt(a[2])!
    let to = parseInt(a[3])!
    var i: i64 = from
    while i < to {
        print("C" + i.toString())
        let path = dir + "/" + i.toString() + ".json"
        match readFile(path) {
            Result.Err(e) => { print("X" + i.toString() + " read-err") }
            Result.Ok(text) => {
                var line = "X" + i.toString()
                match Json.parse(text) {
                    Result.Err(e) => { line += " parse=err" }
                    Result.Ok(doc) => {
                        line += " parse=ok n=" + walk(doc, doc.curRoot(), 0).toString()
                        match doc.strAt(doc.curRoot(), "a.b") {
                            Option.Some(s) => { line += " a.b=" + s.len().toString() }
                            Option.None => { line += " a.b=none" }
                        }
                        match doc.i64At(doc.curRoot(), "0") {
                            Option.Some(v) => { line += " i0" }
                            Option.None => { line += " i0=none" }
                        }
                        let pp = doc.pretty(2)
                        match Json.parse(pp) {
                            Result.Ok(d2) => { if d2.pretty(2) != pp { line += " PRETTY-UNSTABLE" } }
                            Result.Err(e) => { line += " PRETTY-REPARSE-FAIL" }
                        }
                    }
                }
                match Probe.fromJson(text) {
                    Result.Ok(p) => { line += " derive=ok " + p.toJson().len().toString() }
                    Result.Err(e) => { line += " derive=err" }
                }
                print(line)
            }
        }
        i += 1
    }
    return 0
}
`;

function genValue(rnd: () => number, depth: number): string {
  const pick: Pick = xs => xs[Math.floor(rnd() * xs.length)]!;
  const r = rnd();
  if (depth > 3 || r < 0.35) {
    return pick([
      "null", "true", "false", "0", "-0", "1", "-1", "12345678901234567890", "9223372036854775807", "-9223372036854775808",
      "9223372036854775808", "1.5", "1e10", "1E-5", "0.1e2", JSON.stringify(pick(STR_POOL)), '"\\ud83d\\ude00"', '"\\u00e9\\n\\t\\\\\\/"', '""',
    ]);
  }
  if (r < 0.65) { const n = Math.floor(rnd() * 5); return `[${Array.from({ length: n }, () => genValue(rnd, depth + 1)).join(",")}]`; }
  const n = Math.floor(rnd() * 6);
  const keys = ["a", "b", "s", "n", "b", "f", "t", "e", "o", "l", "inner", "items", "m", "v", "w", "0"];
  return `{${Array.from({ length: n }, () => `${JSON.stringify(pick(keys))}:${genValue(rnd, depth + 1)}`).join(",")}}`;
}

function probeDoc(rnd: () => number): string {
  const pick: Pick = xs => xs[Math.floor(rnd() * xs.length)]!;
  return `{"s":${JSON.stringify(pick(STR_POOL))},"n":${pick(["0", "-1", "9223372036854775807", "-9223372036854775808", "1e3", "1.5"])},"b":${pick(["0", "255", "256", "-1"])},"f":${pick(["0.5", "1e308", "1e999", "-0.0"])},"t":${pick(["true", "false", "null"])},"e":${pick(['"Pa"', '"Pb"', '"Pc"', "1"])},"o":${pick(["null", '"x"', "3"])},"l":[${pick(["", "1,2", "1,\"a\"", "9223372036854775808"])}],"inner":{"v":${pick(["1", "null"])},"w":null},"items":[{"v":1},{"v":2,"w":"q"}],"m":{"a":1,"b":${pick(["2", "\"x\""])}}}`;
}

function mutate(rnd: () => number, base: Buffer): Buffer {
  const pick: Pick = xs => xs[Math.floor(rnd() * xs.length)]!;
  let b = Buffer.from(base);
  const rounds = 1 + Math.floor(rnd() * 3);
  for (let r = 0; r < rounds; r++) {
    const pos = Math.floor(rnd() * (b.length + 1));
    switch (Math.floor(rnd() * 11)) {
      case 0: b = b.subarray(0, pos); break; // truncate
      case 1: b = Buffer.concat([b.subarray(0, pos), b.subarray(pos + 1)]); break; // delete a byte
      case 2: b = Buffer.concat([b.subarray(0, pos), Buffer.from(pick(['"', "\\", "{", "}", "[", "]", ",", ":", "-", ".", "e", "0", "t", "n", " ", "\u0000", "\n"])), b.subarray(pos)]); break;
      case 3: b = Buffer.concat([b.subarray(0, pos), Buffer.from(pick([[0xff], [0xc0, 0x80], [0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xc3], [0xf8, 0x88, 0x80, 0x80, 0x80]])), b.subarray(pos)]); break;
      case 4: b = Buffer.concat([Buffer.from(pick([[0xef, 0xbb, 0xbf], [0xfe, 0xff], [0xff, 0xfe]])), b]); break; // BOM
      case 5: b = Buffer.concat([b, Buffer.from(pick(["x", ",", "{}", " garbage", "\u0000", "]", "\n\n", "/*c*/"]))]); break; // trailing
      case 6: b = Buffer.concat([b.subarray(0, pos), Buffer.from(pick(['\\ud800', '\\udc00', '\\ud83d', '\\u12', '\\x41', '\\u{41}', '\\', '\\ud83d\\u0041', '\\u0000'])), b.subarray(pos)]); break;
      case 7: b = Buffer.concat([b.subarray(0, pos), Buffer.from(pick(["01", "1.", ".5", "+1", "1e", "1e+", "NaN", "Infinity", "-", "0x10", "1".repeat(400), "9".repeat(60) + ".5e-" + "9".repeat(30), "1e999999", "-1e999999", "0." + "0".repeat(500) + "1"])), b.subarray(pos)]); break;
      case 8: b = Buffer.concat([b.subarray(0, pos), Buffer.from(pick(['"a":1,"a":2,', '"a":{"b":"x"},"a":{"b":"y"},', '"":1,', ',,', "//x\n", "#"])), b.subarray(pos)]); break;
      case 9: { const i = Math.floor(rnd() * b.length); if (b.length) b[i] = Math.floor(rnd() * 256); break; }
      default: b = Buffer.from(b.toString("latin1").split("").reverse().join(""), "latin1"); break;
    }
  }
  return b;
}

function structuralCase(rnd: () => number, i: number): Buffer {
  const pick: Pick = xs => xs[Math.floor(rnd() * xs.length)]!;
  const depth = pick([100, 1000, 10000, 100000, 300000]);
  switch (i % 6) {
    case 0: return Buffer.from("[".repeat(depth) + "]".repeat(rnd() < 0.5 ? depth : depth - 1));
    case 1: return Buffer.from('{"a":'.repeat(depth) + "1" + "}".repeat(depth));
    case 2: return Buffer.from("[" + Array.from({ length: pick([1000, 50000, 200000]) }, () => "1").join(",") + "]");
    case 3: return Buffer.from("[" + '"x"'.repeat(1) + (",\"" + "y".repeat(pick([10, 100000, 3000000])) + '"')) ;
    case 4: return Buffer.from(`{${Array.from({ length: pick([100, 5000, 40000]) }, (_, j) => `"k${j % 7}":${j}`).join(",")}}`);
    default: return Buffer.from("[" + "[".repeat(depth) + "1" + "]".repeat(depth) + "," + '{"a":{"b":"deep"}}' + "]");
  }
}

function runParse(dir: string): { cases: number; lenient: number } {
  const rnd = rng(SEED * 7919 + 13);
  const cdir = join(dir, "cases");
  mkdirSync(cdir, { recursive: true });
  const valid: boolean[] = [];
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const bases: string[] = [];
  for (let i = 0; i < 40; i++) bases.push(genValue(rnd, 0), probeDoc(rnd));
  // Fully valid Probe documents: the derive decoder only reaches its deeper arms when the
  // text survives the earlier fields, which the random pools above almost never produce.
  for (let i = 0; i < 20; i++) {
    const pick: Pick = xs => xs[Math.floor(rnd() * xs.length)]!;
    bases.push(`{"s":${JSON.stringify(pick(STR_POOL))},"n":${pick(["0", "-9223372036854775808", "9223372036854775807"])},"b":${pick(["0", "255"])},"f":${pick(["0.5", "-1e300", "2"])},"t":${pick(["true", "false"])},"e":${pick(['"Pa"', '"Pb"'])},"o":${pick(["null", JSON.stringify(pick(STR_POOL))])},"l":[${pick(["", "1,2,3", "-9223372036854775808"])}],"inner":{"v":${pick(["1", "-5"])},"w":${pick(["null", '"w"'])}},"items":[{"v":1,"w":null},{"v":2,"w":"q"}],"m":{"a":1,"b":${pick(["2", "-3"])}}}`);
  }
  for (let i = 0; i < PARSE_CASES; i++) {
    let buf: Buffer;
    if (i % 25 === 24) buf = structuralCase(rnd, i);
    else if (i % 3 === 0) buf = Buffer.from(bases[Math.floor(rnd() * bases.length)]!);
    else buf = mutate(rnd, Buffer.from(bases[Math.floor(rnd() * bases.length)]!));
    writeFileSync(join(cdir, `${i}.json`), buf);
    let ok = true;
    try {
      const text = dec.decode(buf);
      JSON.parse(text);
      // std/json caps nesting at JSON_MAX_DEPTH (512) on purpose; deeper is a clean rejection.
      let d = 0, md = 0, inStr = false;
      for (let q = 0; q < text.length; q++) {
        const c = text[q];
        if (inStr) { if (c === "\\") q++; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === "[" || c === "{") { d++; if (d > md) md = d; }
        else if (c === "]" || c === "}") d--;
      }
      if (md > 512) ok = false;
    } catch { ok = false; }
    valid.push(ok);
  }
  const src = PARSE_PROGRAM;
  // Pass loop: a crash or hang names the case from the line-buffered "C<i>" marker; that case
  // is reported and the next pass resumes after it.
  let parseOk = 0, deriveOk = 0;
  let from = 0, lenient = 0, jsOkMilRej = 0, prettyBad = 0;
  const seenLines = new Map<number, string>();
  let pass = 0;
  while (from < PARSE_CASES && pass < 40) {
    const r = buildAndRunOnce(dir, "parse", src, [cdir, String(from), String(PARSE_CASES)], pass === 0);
    pass++;
    if (r.compileFail) { findings.push({ kind: "parse-harness-compile-fail", detail: r.compileFail }); break; }
    let lastC = from - 1;
    for (const l of r.out.split("\n")) {
      const mc = /^C(\d+)$/.exec(l);
      if (mc) { lastC = Number(mc[1]); continue; }
      const mx = /^X(\d+) (.*)$/.exec(l);
      if (!mx) continue;
      const i = Number(mx[1]), rest = mx[2]!;
      seenLines.set(i, rest);
      const ok = rest.includes("parse=ok");
      if (valid[i] && !ok) { jsOkMilRej++; findings.push({ kind: "parse-rejects-valid", detail: `case ${i} ${join(cdir, i + ".json")} ${rest}` }); }
      if (!valid[i] && ok) lenient++;
      if (ok) parseOk++;
      if (rest.includes("derive=ok")) deriveOk++;
      if (rest.includes("PRETTY-")) { prettyBad++; findings.push({ kind: "pretty-roundtrip", detail: `case ${i} ${rest}` }); }
    }
    const crashed = r.timedOut || r.status !== 0 || /AddressSanitizer|panic|runtime error/.test(r.err);
    if (!crashed) { from = PARSE_CASES; break; }
    findings.push({ kind: r.timedOut ? "parse-hang" : "parse-crash", detail: `case ${lastC} (${join(cdir, lastC + ".json")}) status=${r.status}\n${r.err.slice(0, 1000)}` });
    from = lastC + 1;
  }
  console.error(`parse: parse=ok ${parseOk}, derive=ok ${deriveOk}, of ${PARSE_CASES}`);
  if (VERBOSE) console.error(`parse: lenient=${lenient} rejectsValid=${jsOkMilRej} prettyBad=${prettyBad}`);
  return { cases: PARSE_CASES, lenient };
}

let compiled: string | null = null;
function buildAndRunOnce(dir: string, name: string, src: string, args: string[], rebuild: boolean) {
  const file = join(dir, `${name}.milo`), bin = join(dir, name);
  if (rebuild || compiled !== bin) {
    writeFileSync(file, src);
    const b = spawnSync("bun", [MILO, "build", file, "-o", bin, "--sanitize"], { encoding: "utf-8", timeout: 300000 });
    if (b.status !== 0) return { compileFail: (b.stdout + b.stderr).slice(0, 2000), out: "", err: "", status: -1, timedOut: false };
    compiled = bin;
  }
  const r = spawnSync(bin, args, { encoding: "utf-8", timeout: 180000, maxBuffer: 1 << 28, env: { ...process.env, MILO_LINE_BUFFERED: "1", ASAN_OPTIONS: "detect_leaks=0" } });
  return { compileFail: "", out: r.stdout ?? "", err: r.stderr ?? "", status: r.status ?? -1, timedOut: r.error?.message.includes("ETIMEDOUT") ?? false };
}

const dir = mkdtempSync(join(tmpdir(), "fuzz-json-"));
let rt = { programs: 0, cases: 0 }, pr = { cases: 0, lenient: 0 };
if (MODE === "rt" || MODE === "both") rt = runRt(dir);
if (MODE === "parse" || MODE === "both") pr = runParse(dir);
console.log(`fuzz-json seed=${SEED}: rt ${rt.cases} cases in ${rt.programs} programs, parse ${pr.cases} texts (${pr.lenient} accepted though JS rejects), ${findings.length} findings`);
for (const f of findings.slice(0, 40)) console.log(`FINDING ${f.kind}${f.file ? " " + f.file : ""}\n${f.detail}\n`);
if (KEEP || findings.length) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
process.exit(findings.length ? 1 : 0);
