#!/usr/bin/env bun
// Differential falsifier for the built-in VEC — the growable array codegen.ts emits.
//
// Vec is the container Milo programs actually use (a survey of the corpus put it at 97%
// against fixed arrays), and like HashMap its bookkeeping lives in generated LLVM IR
// rather than in a .milo file: capacity doubling, the memmove that shifts a tail on
// insert/remove, truncate's drop loop, retain's compaction. Nothing type-checks any of it,
// and an off-by-one in a shift is silent — the program keeps running with a duplicated or
// dropped element.
//
// Unlike HashMap, Vec's order is fully determined, so the oracle asserts the ENTIRE
// contents after every mutation rather than a count and a checksum. That is the strongest
// oracle available here and it costs nothing extra.
//
// `--owned` switches the element type from i64 to string. That is not a cosmetic change:
// it turns on drop glue for every op, and pairs with `--leaks` (macOS `leaks -atExit`) to
// oracle something the value model cannot see at all — whether the right ANSWER was
// produced while quietly losing memory. Four real leaks were found by hand this way before
// this mode existed, all in the shape "nobody owns this temporary".
//
// Usage: bun scripts/fuzz-vec.ts [--cases N] [--ops N] [--seed N] [--owned] [--leaks] [--keep] [--verbose]
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const CASES = argOf("--cases", 150);
const OPS = argOf("--ops", 45);
const SEED = argOf("--seed", 1);
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");
const OWNED = process.argv.includes("--owned");
const LEAKS = process.argv.includes("--leaks");
if (LEAKS && process.platform !== "darwin") {
  console.error("--leaks uses macOS `leaks -atExit`; on Linux use scripts/leak-check.ts (LeakSanitizer)");
  process.exit(2);
}
// With owned elements the values are strings, so the model holds their TEXT and the
// generated program prints it. Everything else about the op sequence is identical.
const ELEM = OWNED ? "string" : "i64";
const lit = (n: number) => (OWNED ? `"e${n}"` : String(n));
const shown = (n: number) => (OWNED ? `e${n}` : String(n));
// A string is already printable; an i64 needs .toString(). Everything the generator prints
// goes through this so the two modes emit the same shape of program.
const asStr = (e: string) => (OWNED ? e : `${e}.toString()`);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function genCase(seed: number): { src: string; expect: string[] } {
  const rnd = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const model: number[] = [];
  const body: string[] = [];
  const expect: string[] = [];
  let nextVal = 10;
  let dumpId = 0;

  // Print the whole vector. This is the assertion that catches a shift that moved one
  // element too many or too few — a length check alone would not.
  const dump = () => {
    const id = dumpId++;
    body.push(`    var d${id}: string = ""`);
    body.push(`    for x in v {`);
    body.push(`        d${id} = d${id} + ${asStr("x")} + ","`);
    body.push(`    }`);
    body.push(`    print("D" + v.len.toString() + "[" + d${id} + "]")`);
    expect.push(`D${model.length}[${model.map(x => `${shown(x)},`).join("")}]`);
  };

  for (let op = 0; op < OPS; op++) {
    const kind = pick([
      "push", "push", "push", "pop", "insert", "remove", "swap", "truncate",
      "reverse", "sort", "get", "clear", "retain", "extend",
      ...(OWNED ? ["containsTemp", "indexOfTemp", "cloneLen"] : ["sortBy", "sortByKey"]),
    ]);
    const n = model.length;

    if (kind === "push") {
      const val = nextVal++;
      body.push(`    v.push(${lit(val)})`);
      model.push(val);
    } else if (kind === "pop") {
      body.push(`    match v.pop() {`);
      body.push(`        Option.Some(x) => { print("P" + ${asStr("x")}) }`);
      body.push(`        Option.None => { print("Pnone") }`);
      body.push(`    }`);
      const x = model.pop();
      expect.push(x === undefined ? "Pnone" : `P${shown(x)}`);
    } else if (kind === "insert") {
      // Valid range is 0..len inclusive; an out-of-range insert traps by design and would
      // be testing the bounds check, not the shift.
      const at = Math.floor(rnd() * (n + 1));
      const val = nextVal++;
      body.push(`    v.insert(${at}, ${lit(val)})`);
      model.splice(at, 0, val);
    } else if (kind === "remove") {
      if (n === 0) { op--; continue; }
      const at = Math.floor(rnd() * n);
      body.push(`    print("R" + ${asStr(`v.remove(${at})`)})`);
      expect.push(`R${shown(model.splice(at, 1)[0]!)}`);
    } else if (kind === "swap") {
      if (n === 0) { op--; continue; }
      const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
      body.push(`    v.swap(${a}, ${b})`);
      const t = model[a]!; model[a] = model[b]!; model[b] = t;
    } else if (kind === "truncate") {
      const to = Math.floor(rnd() * (n + 2));   // sometimes longer than len: a no-op
      body.push(`    v.truncate(${to})`);
      if (to < model.length) model.length = to;
    } else if (kind === "reverse") {
      body.push(`    v.reverse()`);
      model.reverse();
    } else if (kind === "sort") {
      // Vec<string>.sort() is lexicographic, and "e10" sorts before "e2" — the model has
      // to compare the TEXT, not the number behind it.
      body.push(`    v.sort()`);
      if (OWNED) model.sort((x, y) => (shown(x) < shown(y) ? -1 : shown(x) > shown(y) ? 1 : 0));
      else model.sort((x, y) => x - y);
    } else if (kind === "sortBy") {
      // Declared by VALUE on purpose. The checker allows it for a Copy element and
      // codegen must load; passing the pointer instead made this a no-op sort.
      body.push(`    v.sortBy((x: i64, y: i64): i32 => if x > y { 1 } else { 0 })`);
      model.sort((x, y) => x - y);
    } else if (kind === "sortByKey") {
      body.push(`    v.sortByKey((x: i64): i64 => 0 - x)`);
      model.sort((x, y) => y - x);
    } else if (kind === "containsTemp" || kind === "indexOfTemp") {
      // A needle BUILT at the call site. A literal never leaks (cap 0, owns no heap), so
      // without a computed one this harness could not see the argument-temp class at all —
      // which is the class that actually shipped broken.
      const want = n > 0 ? Math.floor(rnd() * n) : 0;
      const idxVar = `q${op}`;
      body.push(`    let ${idxVar}: i64 = ${want}`);
      const needle = `"e" + ${idxVar}.toString()`;
      const target = `e${want}`;
      if (kind === "containsTemp") {
        body.push(`    print("C" + (if v.contains(${needle}) { "1" } else { "0" }))`);
        expect.push(`C${model.some(x => shown(x) === target) ? 1 : 0}`);
      } else {
        body.push(`    print("X" + (v.indexOf(${needle}) ?? -1).toString())`);
        expect.push(`X${model.findIndex(x => shown(x) === target)}`);
      }
    } else if (kind === "cloneLen") {
      // A receiver that is a TEMPORARY: reading a scalar off it frees nothing, so the
      // whole clone leaked.
      body.push(`    print("L" + v.clone().len.toString())`);
      expect.push(`L${model.length}`);
    } else if (kind === "clear") {
      body.push(`    v.clear()`);
      model.length = 0;
    } else if (kind === "retain") {
      // Keep the even values. retain compacts in place, which is its own shift loop.
      body.push(OWNED
        ? `    v.retain((x: &string): bool => x.len > 2)`
        : `    v.retain((x: i64): bool => x % 2 == 0)`);
      const kept = OWNED ? model.filter(x => shown(x).length > 2) : model.filter(x => x % 2 === 0);
      model.length = 0;
      model.push(...kept);
    } else if (kind === "extend") {
      const m = 1 + Math.floor(rnd() * 4);
      const vals: number[] = [];
      for (let i = 0; i < m; i++) vals.push(nextVal++);
      body.push(`    let ext${op}: Vec<${ELEM}> = [${vals.map(lit).join(", ")}]`);
      body.push(`    v.extend(ext${op})`);
      model.push(...vals);
    } else if (kind === "get") {
      // Deliberately reaches past the end: get must answer None, not read off the buffer.
      const at = Math.floor(rnd() * (n + 3)) - 1;
      body.push(`    match v.get(${at}) {`);
      body.push(`        Option.Some(x) => { print("G" + ${asStr("x")}) }`);
      body.push(`        Option.None => { print("Gnone") }`);
      body.push(`    }`);
      const got = at >= 0 && at < model.length ? model[at] : undefined;
      expect.push(got === undefined ? "Gnone" : `G${shown(got)}`);
    }

    // Dump often — a corrupted element is far easier to attribute to one op than to a
    // run of forty.
    if (rnd() < 0.35) dump();
  }
  dump();

  const src = [
    `// generated by scripts/fuzz-vec.ts — seed ${seed}`,
    `pub fn main(): i32 {`,
    `    var v: Vec<${ELEM}> = []`,
    ...body,
    `    return 0`,
    `}`,
    ``,
  ].join("\n");
  return { src, expect };
}

const dir = mkdtempSync(join(tmpdir(), "milo-fuzzvec-"));
let failures = 0, ran = 0;
const t0 = Date.now();
try {
  for (let c = 0; c < CASES; c++) {
    const seed = SEED + c;
    const { src, expect } = genCase(seed);
    const file = join(dir, `case${seed}.milo`);
    writeFileSync(file, src);

    let out: string;
    let leaked: string | null = null;
    try {
      if (LEAKS) {
        // Two runs rather than one: `leaks` wraps the program's stdout in its own report
        // headers, and parsing around those is a guess that breaks with the tool's
        // formatting. Run the binary for the ANSWER, then again under leaks for the
        // VERDICT. Both matter — the right answer while losing memory is exactly the
        // failure this mode exists to catch.
        const bin = join(dir, `case${seed}.bin`);
        execFileSync("bun", [join(ROOT, "src", "main.ts"), "build", file, "-o", bin], {
          cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        out = execFileSync(bin, [], { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        // `leaks` exits NONZERO when it finds leaks, so it must not be allowed to throw
        // into the build-failure path — that reported a real leak as "failed to build or
        // run" and hid what it had actually found.
        let report: string;
        try {
          report = execFileSync("leaks", ["-atExit", "--", bin], {
            cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (le: any) {
          report = (le.stdout ?? "") + (le.stderr ?? "");
        }
        const m = // The `s?` is required: the summary reads "1 leak for 16 total leaked bytes" in the
        // singular, and demanding the plural made a one-allocation leak look unmeasurable.
        // scripts/leak-check.ts already carried this exact comment; this did not reuse it.
        /(\d+) leaks? for (\d+) total leaked bytes/.exec(report);
        // No verdict at all is not evidence of cleanliness — say so rather than pass.
        if (!m) leaked = "no leaks verdict — could not measure";
        else if (m[1] !== "0") leaked = `${m[1]} leaks / ${m[2]} bytes`;
      } else {
        out = execFileSync("bun", [join(ROOT, "src", "main.ts"), "run", file], {
          cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
      }
    } catch (e: any) {
      failures++;
      console.error(`\nseed ${seed}: program failed to build or run\n${((e.stderr ?? "") + (e.stdout ?? "")).slice(0, 1200)}`);
      writeFileSync(join(ROOT, `vec-fuzz-${seed}.milo`), src);
      continue;
    }
    ran++;
    if (leaked) {
      failures++;
      console.error(`\nseed ${seed}: LEAK — ${leaked}`);
      writeFileSync(join(ROOT, `vec-fuzz-${seed}.milo`), src);
      console.error(`case written to vec-fuzz-${seed}.milo`);
    }
    const actual = out.trim().split("\n").map(l => l.trim()).filter(l => l.length);
    if (actual.length !== expect.length || actual.some((l, i) => l !== expect[i])) {
      failures++;
      const at = actual.findIndex((l, i) => l !== expect[i]);
      console.error(`\nseed ${seed}: MODEL MISMATCH at line ${at + 1}`);
      console.error(`  expected: ${expect[at]}`);
      console.error(`  actual:   ${actual[at]}`);
      writeFileSync(join(ROOT, `vec-fuzz-${seed}.milo`), src);
      console.error(`case written to vec-fuzz-${seed}.milo`);
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
  console.error("nothing ran — the harness is broken, not Vec");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
