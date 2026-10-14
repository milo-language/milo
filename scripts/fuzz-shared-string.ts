#!/usr/bin/env bun
// Differential falsifier for shared (reference-counted, copy-on-write) strings.
//
// A heap string buffer is reference counted, copying a string out of a borrow is a count
// increment, and every in-place write copies a buffer whose count is above 1 first
// (codegen.ts strRt). The claim under test is that this is unobservable: a string handle behaves exactly like a value. JS strings are
// values, so a JS model of the same operations is an exact oracle.
//
// A generated program holds four string handles (`h0`..`h3`), a Vec<string>, and a struct
// array, and runs a random mix of
//   share   a handle from another one by every spelling that shares a buffer: .clone(), a
//           copy out of a `&string` param, out of a field behind `&Row`, out of a payload
//           bound through `&E`, `v[i]`, a field of an element, a global
//   write   every in-place mutator on one handle (push, pushStr of another handle or of
//           itself, +=, `x = x + y`, pushInt, an interpolated append, truncate, clear,
//           setByte), on a Vec element and on a struct field
//   drop    a handle reassigned or a Vec element replaced
// and prints every handle after each step. Two oracles:
//   model  stdout must equal the JS model's: a handle that saw another's write, or a
//          stale read of a freed buffer, prints something else
//   ASan   the build is `--sanitize`; any report (use after free, double free, a free of
//          a pointer that is not a block start, which is what a missed count header
//          looks like) is a failure
//
// Usage: bun scripts/fuzz-shared-string.ts [--cases N] [--ops N] [--seed N] [--jobs N] [--keep] [--verbose]
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const CASES = argOf("--cases", 60);
const OPS = argOf("--ops", 60);
const SEED = argOf("--seed", 1);
const JOBS = argOf("--jobs", 3);
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const ALPHABET = "abcxyz";
const H = 4;

function genCase(seed: number): { src: string; expect: string[] } {
  const rnd = rng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(xs: T[]): T => xs[int(xs.length)]!;
  const randStr = (max: number) => {
    let out = "";
    for (let i = 0, n = int(max); i < n; i++) out += ALPHABET[int(ALPHABET.length)];
    return out;
  };
  // Mostly heap strings (repeat() allocates); sometimes a bare literal (cap 0, no header).
  const fresh = (): { code: string; val: string } => {
    const base = randStr(5) || "q";
    if (rnd() < 0.2) return { code: `"${base}"`, val: base };
    const k = 1 + int(3);
    return { code: `"${base}".repeat(${k})`, val: base.repeat(k) };
  };

  const h: string[] = [];
  const body: string[] = [];
  const expect: string[] = [];
  const say = (code: string, val: string) => { body.push(`    print("<" + ${code} + ">")`); expect.push(`<${val}>`); };

  const init: string[] = [];
  for (let i = 0; i < H; i++) {
    const f = fresh();
    init.push(`    var h${i}: string = ${f.code}`);
    h.push(f.val);
  }
  const v: string[] = [];
  for (let i = 0; i < 3; i++) {
    const f = fresh();
    init.push(`    v.push(${f.code})`);
    v.push(f.val);
  }
  const rows: string[] = [];
  const rowInit: string[] = [];
  for (let i = 0; i < 2; i++) {
    const f = fresh();
    rowInit.push(`Row { name: ${f.code}, e: E.A(${f.code}) }`);
    rows.push(f.val);
  }
  init.push(`    var rows = [${rowInit.join(", ")}]`);
  // The payload starts equal to the name and is never written, so the model is `rows`.
  const payload = [...rows];

  for (let op = 0; op < OPS; op++) {
    const d = int(H);
    const s = int(H);
    const kind = pick([
      "clone", "param", "field", "payload", "index", "elemField", "global",
      "push", "pushStr", "pushSelf", "plusEq", "concat", "pushInt", "fmt", "truncate", "clear", "setByte",
      "vecWrite", "vecSet", "rowWrite", "fresh", "print",
    ]);
    switch (kind) {
      case "clone": body.push(`    h${d} = h${s}.clone()`); h[d] = h[s]!; break;
      case "param": body.push(`    h${d} = viaParam(h${s})`); h[d] = h[s]!; break;
      case "field": { const r = int(2); body.push(`    h${d} = viaField(rows[${r}])`); h[d] = rows[r]!; break; }
      case "payload": { const r = int(2); body.push(`    h${d} = viaPayload(rows[${r}].e)`); h[d] = payload[r]!; break; }
      case "index": { const i = int(3); body.push(`    h${d} = v[${i}]`); h[d] = v[i]!; break; }
      case "elemField": { const r = int(2); body.push(`    h${d} = rows[${r}].name`); h[d] = rows[r]!; break; }
      case "global": body.push(`    h${d} = G`); h[d] = "global-text"; break;
      case "push": { const c = ALPHABET.charCodeAt(int(ALPHABET.length)); body.push(`    h${d}.push(${c})`); h[d] += String.fromCharCode(c); break; }
      case "pushStr": body.push(`    h${d}.pushStr(h${s})`); h[d] = h[d]! + h[s]!; break;
      case "pushSelf": body.push(`    h${d}.pushStr(h${d})`); h[d] = h[d]! + h[d]!; break;
      case "plusEq": { const t = randStr(4); body.push(`    h${d} += "${t}"`); h[d] += t; break; }
      case "concat": body.push(`    h${d} = h${d} + h${s}`); h[d] = h[d]! + h[s]!; break;
      case "pushInt": { const n = int(1000); body.push(`    h${d}.pushInt(${n})`); h[d] += String(n); break; }
      case "fmt": body.push(`    h${d}.pushStr($"[{h${s}}|{h${d}}]")`); h[d] = h[d]! + `[${h[s]}|${h[d]}]`; break;
      case "truncate": { const n = int(h[d]!.length + 2); body.push(`    h${d}.truncate(${n})`); h[d] = h[d]!.slice(0, n); break; }
      case "clear": body.push(`    h${d}.clear()`); h[d] = ""; break;
      case "setByte": {
        if (h[d]!.length === 0) { op--; continue; }
        const i = int(h[d]!.length);
        const c = ALPHABET.charCodeAt(int(ALPHABET.length)).toString();
        body.push(`    h${d}.setByte(${i}, ${c})`);
        h[d] = h[d]!.slice(0, i) + String.fromCharCode(Number(c)) + h[d]!.slice(i + 1);
        break;
      }
      case "vecWrite": { const i = int(3); body.push(`    v[${i}].pushStr(h${s})`); v[i] = v[i]! + h[s]!; break; }
      case "vecSet": { const i = int(3); body.push(`    v[${i}] = h${s}.clone()`); v[i] = h[s]!; break; }
      case "rowWrite": { const r = int(2); body.push(`    rows[${r}].name.push(122)`); rows[r] = rows[r]! + "z"; break; }
      case "fresh": { const f = fresh(); body.push(`    h${d} = ${f.code}`); h[d] = f.val; break; }
      case "print": break;
    }
    for (let i = 0; i < H; i++) say(`h${i}`, h[i]!);
  }
  for (let i = 0; i < 3; i++) say(`v[${i}]`, v[i]!);
  for (let r = 0; r < 2; r++) say(`rows[${r}].name`, rows[r]!);

  const src = [
    `// generated by scripts/fuzz-shared-string.ts — seed ${seed}`,
    `struct Row { name: string, e: E }`,
    `enum E { A(string), B(i64) }`,
    `let G: string = "global-".repeat(1) + "text"`,
    `fn viaParam(s: &string): string { return s }`,
    `fn viaField(r: &Row): string { return r.name }`,
    `fn viaPayload(e: &E): string {`,
    `    match e {`,
    `        E.A(s) => { return s }`,
    `        E.B(n) => { return "" }`,
    `    }`,
    `}`,
    `pub fn main(): i32 {`,
    `    var v: Vec<string> = Vec.new()`,
    ...init,
    ...body,
    `    return 0`,
    `}`,
    ``,
  ].join("\n");
  return { src, expect };
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(res => {
    const p = spawn(cmd, args, { cwd: ROOT });
    let out = "", err = "";
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("close", code => res({ code, out, err }));
  });
}

// The compiler as `./milo` runs it, not a `bun build --compile` binary: on 2026-10-13 the
// compiled binary threw "enum payload accessed without its variant's offsets" on an array
// literal of structs holding an enum, where `bun src/main.ts` compiles it fine.
const dir = mkdtempSync(join(tmpdir(), "milo-fuzzshared-"));
const MAIN = join(ROOT, "src", "main.ts");
let failures = 0, ran = 0;
const t0 = Date.now();

async function one(c: number) {
  const seed = SEED + c;
  const { src, expect } = genCase(seed);
  const file = join(dir, `case${seed}.milo`);
  const bin = join(dir, `case${seed}`);
  writeFileSync(file, src);
  const b = await run("bun", [MAIN, "build", "--sanitize", file, "-o", bin]);
  if (b.code !== 0) {
    failures++;
    console.error(`\nseed ${seed}: failed to build\n${(b.err + b.out).slice(0, 1500)}`);
    writeFileSync(join(ROOT, `shared-str-fuzz-${seed}.milo`), src);
    return;
  }
  const r = await run(bin, []);
  ran++;
  const actual = r.out.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  const asan = r.err.includes("AddressSanitizer");
  if (r.code !== 0 || asan || actual.length !== expect.length || actual.some((l, i) => l !== expect[i])) {
    failures++;
    const at = actual.findIndex((l, i) => l !== expect[i]);
    console.error(`\nseed ${seed}: ${asan ? "ASAN REPORT" : r.code !== 0 ? `exit ${r.code}` : "MODEL MISMATCH"}${at >= 0 ? ` at line ${at + 1}` : ""}`);
    if (at >= 0) console.error(`  expected: ${JSON.stringify(expect[at])}\n  actual:   ${JSON.stringify(actual[at])}`);
    if (r.err) console.error(r.err.slice(0, 2000));
    writeFileSync(join(ROOT, `shared-str-fuzz-${seed}.milo`), src);
    console.error(`case written to shared-str-fuzz-${seed}.milo`);
  } else if (VERBOSE) {
    console.log(`seed ${seed}: ${expect.length} observations agree`);
  }
}

try {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, JOBS) }, async () => {
    while (next < CASES) await one(next++);
  }));
} finally {
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nseed ${SEED}, ${CASES} cases (${OPS} ops each) in ${secs}s: ${ran} ran, ${failures} failed`);
if (ran === 0) {
  console.error("nothing ran — the harness is broken, not the strings");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
