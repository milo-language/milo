#!/usr/bin/env bun
// Differential falsifier for the built-in STRING methods codegen.ts emits.
//
// The string surface is ~20 methods of byte-offset arithmetic — charAt, substr, indexOf,
// indexOfFrom, lastIndexOf, trim, repeat, reverse, split, replace — and every one of them
// is generated LLVM IR doing its own index math against a length. An off-by-one there is
// silent: you get a shorter string, not a crash.
//
// Inputs are ASCII ONLY, deliberately. Milo's charAt/substr/indexOf are BYTE-indexed and
// documented as such, so a JS string model is exact for ASCII and would quietly disagree
// with the compiler on anything multibyte for reasons that are not bugs. Testing the UTF-8
// boundary behaviour needs a byte-level model and is a separate harness; what this one
// covers is the index arithmetic, which is where the off-by-ones live.
//
// Usage: bun scripts/fuzz-string.ts [--cases N] [--ops N] [--seed N] [--keep] [--verbose]
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const CASES = argOf("--cases", 120);
const OPS = argOf("--ops", 35);
const SEED = argOf("--seed", 1);
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

// A small alphabet with repeats and spaces: repeats make indexOf/lastIndexOf disagree,
// and leading/trailing spaces are what trim is for.
const ALPHABET = "ab c";

// A non-empty needle. The empty needle is a spec question rather than an arithmetic one —
// Milo answers `indexOfFrom("", 9)` on a 5-byte string with Some(9), an index past the end
// where JS and Rust both clamp to the length — and mixing that disagreement into the sweep
// would bury the off-by-ones this harness is actually looking for. Tracked separately.
function needleOf(gen: () => string): string {
  const n = gen();
  return n === "" ? "a" : n;
}

function genCase(seed: number): { src: string; expect: string[] } {
  const rnd = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const randStr = (maxLen: number) => {
    const n = Math.floor(rnd() * maxLen);
    let out = "";
    for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    return out;
  };

  const initialStr = randStr(8);
  let model = initialStr;
  const body: string[] = [];
  const expect: string[] = [];
  const q = (x: string) => `"${x}"`;
  // Printed strings are wrapped so an empty result is distinguishable from no output at
  // all, and trailing spaces survive the trim() the harness does on each line.
  const say = (tag: string, v: string) => { body.push(`    print("${tag}<" + ${v} + ">")`); };

  for (let op = 0; op < OPS; op++) {
    const kind = pick([
      "append", "len", "charAt", "substr", "indexOf", "lastIndexOf", "contains",
      "startsWith", "endsWith", "toLower", "toUpper", "trim", "repeat", "reverse",
      "indexOfFrom", "replace", "set",
    ]);
    const n = model.length;

    if (kind === "append") {
      const add = randStr(4);
      body.push(`    s = s + ${q(add)}`);
      model = model + add;
    } else if (kind === "set") {
      const v = randStr(9);
      body.push(`    s = ${q(v)}`);
      model = v;
    } else if (kind === "len") {
      body.push(`    print("L" + s.len.toString())`);
      expect.push(`L${n}`);
    } else if (kind === "charAt") {
      if (n === 0) { op--; continue; }
      const i = Math.floor(rnd() * n);
      say("C", `s.charAt(${i})`);
      expect.push(`C<${model[i]}>`);
    } else if (kind === "substr") {
      const a = Math.floor(rnd() * (n + 1));
      const b = a + Math.floor(rnd() * (n - a + 1));
      say("S", `s.substr(${a}, ${b})`);
      expect.push(`S<${model.slice(a, b)}>`);
    } else if (kind === "indexOf") {
      const needle = needleOf(() => rnd() < 0.6 && n > 0
        ? model.slice(Math.floor(rnd() * n), Math.floor(rnd() * n) + 1 + Math.floor(rnd() * 2))
        : randStr(2));
      body.push(`    print("I" + (s.indexOf(${q(needle)}) ?? -1).toString())`);
      expect.push(`I${model.indexOf(needle)}`);
    } else if (kind === "indexOfFrom") {
      const needle = needleOf(() => randStr(2));
      const from = Math.floor(rnd() * (n + 2));
      body.push(`    print("F" + (s.indexOfFrom(${q(needle)}, ${from}) ?? -1).toString())`);
      expect.push(`F${model.indexOf(needle, from)}`);
    } else if (kind === "lastIndexOf") {
      const needle = needleOf(() => randStr(2));
      body.push(`    print("J" + (s.lastIndexOf(${q(needle)}) ?? -1).toString())`);
      expect.push(`J${model.lastIndexOf(needle)}`);
    } else if (kind === "contains") {
      const needle = needleOf(() => randStr(2));
      body.push(`    print("K" + (if s.contains(${q(needle)}) { "1" } else { "0" }))`);
      expect.push(`K${model.includes(needle) ? 1 : 0}`);
    } else if (kind === "startsWith" || kind === "endsWith") {
      const needle = needleOf(() => randStr(3));
      const m = kind === "startsWith" ? "startsWith" : "endsWith";
      const tag = kind === "startsWith" ? "B" : "E";
      body.push(`    print("${tag}" + (if s.${m}(${q(needle)}) { "1" } else { "0" }))`);
      const hit = kind === "startsWith" ? model.startsWith(needle) : model.endsWith(needle);
      expect.push(`${tag}${hit ? 1 : 0}`);
    } else if (kind === "toLower") {
      say("l", "s.toLower()");
      expect.push(`l<${model.toLowerCase()}>`);
    } else if (kind === "toUpper") {
      say("u", "s.toUpper()");
      expect.push(`u<${model.toUpperCase()}>`);
    } else if (kind === "trim") {
      say("T", "s.trim()");
      expect.push(`T<${model.trim()}>`);
    } else if (kind === "repeat") {
      const k = Math.floor(rnd() * 4);
      say("R", `s.repeat(${k})`);
      expect.push(`R<${model.repeat(k)}>`);
    } else if (kind === "reverse") {
      say("V", "s.reverse()");
      expect.push(`V<${[...model].reverse().join("")}>`);
    } else if (kind === "replace") {
      const from = randStr(2);
      const to = randStr(2);
      if (from === "") { op--; continue; }   // replacing "" is not a meaningful case here
      say("P", `s.replace(${q(from)}, ${q(to)})`);
      expect.push(`P<${model.split(from).join(to)}>`);
    }
  }

  const src = [
    `// generated by scripts/fuzz-string.ts — seed ${seed}`,
    `pub fn main(): i32 {`,
    // A case whose ops never assign `s` must declare it `let`: `var` there is the
    // var-never-reassigned error, and the case would be counted as a failure.
    `    ${body.some((l) => l.startsWith("    s = ")) ? "var" : "let"} s: string = ${q(initialStr)}`,
    ...body,
    `    return 0`,
    `}`,
    ``,
  ].join("\n");
  return { src, expect };
}

const dir = mkdtempSync(join(tmpdir(), "milo-fuzzstr-"));
let failures = 0, ran = 0;
const t0 = Date.now();
try {
  for (let c = 0; c < CASES; c++) {
    const seed = SEED + c;
    const { src, expect } = genCase(seed);
    const file = join(dir, `case${seed}.milo`);
    writeFileSync(file, src);

    let out: string;
    try {
      out = execFileSync("bun", [join(ROOT, "src", "main.ts"), "run", file], {
        cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      failures++;
      console.error(`\nseed ${seed}: program failed to build or run\n${((e.stderr ?? "") + (e.stdout ?? "")).slice(0, 1200)}`);
      writeFileSync(join(ROOT, `str-fuzz-${seed}.milo`), src);
      continue;
    }
    ran++;
    const actual = out.split("\n").map(l => l.replace(/\r$/, "")).filter((l, i, a) => !(i === a.length - 1 && l === ""));
    if (actual.length !== expect.length || actual.some((l, i) => l !== expect[i])) {
      failures++;
      const at = actual.findIndex((l, i) => l !== expect[i]);
      console.error(`\nseed ${seed}: MODEL MISMATCH at line ${at + 1}`);
      console.error(`  expected: ${JSON.stringify(expect[at])}`);
      console.error(`  actual:   ${JSON.stringify(actual[at])}`);
      writeFileSync(join(ROOT, `str-fuzz-${seed}.milo`), src);
      console.error(`case written to str-fuzz-${seed}.milo`);
    } else if (VERBOSE) {
      console.log(`seed ${seed}: ${expect.length} observations agree`);
    }
  }
} finally {
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nseed ${SEED}, ${CASES} cases (${OPS} ops each) in ${secs}s: ${ran} ran, ${failures} failed`);
if (ran === 0) {
  console.error("nothing ran — the harness is broken, not the string methods");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
