#!/usr/bin/env bun
// Differential falsifier for the built-in HASHMAP — the open-addressing table codegen.ts
// emits, not a .milo file.
//
// HashMap is the only container whose bookkeeping lives entirely in generated LLVM IR:
// linear probing, a three-state slot byte (0 empty / 1 occupied / 2 tombstone), and a
// rehash that must drop tombstones while relocating every live entry. Nothing type-checks
// any of it. The dangerous interaction is delete-then-grow — a tombstone left in place
// across a rehash makes a probe stop early and a key that IS present read as absent.
//
// The oracle is a JS Map: every insert/get/remove/contains/len the generated program
// prints is predicted here. Iteration order is deliberately never asserted — Milo's
// HashMap seeds its hash per run, so any test that pinned an order would be testing the
// seed (see the note in AGENTS.md about never deriving output order from a map).
//
// `--owned` makes the VALUES strings as well as the keys, and emits keys built from a
// runtime value rather than as literals. Both matter for `--leaks` (macOS `leaks -atExit`):
// drop glue only exists for owned types, and a literal key never leaks because it carries
// cap 0 and owns no heap — so a literal-only generator is blind to the argument-temp class
// that shipped broken (`m.get("k" + i.toString())` lost its key on every call).
//
// Usage: bun scripts/fuzz-hashmap.ts [--cases N] [--ops N] [--seed N] [--keys N] [--owned] [--leaks] [--verbose]
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1]!, 10) : dflt;
};
const CASES = argOf("--cases", 100);
const OPS = argOf("--ops", 60);
const SEED = argOf("--seed", 1);
// A small key space is the point: it forces collisions, reuse of tombstoned slots, and
// repeated insert-over-existing, which a wide random key space almost never produces.
const KEYS = argOf("--keys", 12);
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");
const OWNED = process.argv.includes("--owned");
const LEAKS = process.argv.includes("--leaks");
if (LEAKS && process.platform !== "darwin") {
  console.error("--leaks uses macOS `leaks -atExit`; on Linux use scripts/leak-check.ts (LeakSanitizer)");
  process.exit(2);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function genCase(seed: number, stringKeys: boolean): { src: string; expect: string[] } {
  const rnd = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const model = new Map<string, number>();
  // With --owned the map holds strings; the model still stores the number behind each one
  // and renders it the same way the generated program will.
  const vLit = (n: number) => (OWNED ? `"n${n}"` : String(n));
  const vShown = (n: number) => (OWNED ? `n${n}` : String(n));
  const vStr = (e: string) => (OWNED ? e : `${e}.toString()`);
  // A key BUILT at the call site rather than written as a literal. `keyLit` stays for the
  // inserts; the lookups use this so the argument-temp path is actually exercised.
  let tempIdx = 0;
  const body: string[] = [];
  const expect: string[] = [];
  let nextVal = 1000;

  const keyOf = (i: number) => stringKeys ? `k${i}` : String(i);
  const keyLit = (k: string) => stringKeys ? `"${k}"` : k;
  // A key for a LOOKUP. In owned mode with string keys, build it from a runtime value so
  // the argument is an owned temporary — the shape that leaked. A literal owns no heap and
  // could never have shown the bug. Falls back to the literal everywhere else.
  const lookupKey = (k: string): string => {
    if (!OWNED || !stringKeys || !k.startsWith("k")) return keyLit(k);
    const q = `q${tempIdx++}`;
    body.push(`    let ${q}: i64 = ${k.slice(1)}`);
    return `"k" + ${q}.toString()`;
  };

  for (let op = 0; op < OPS; op++) {
    const kind = pick([
      "insert", "insert", "insert", "get", "get", "contains", "remove", "remove", "len", "getOrDefault",
      // A burst inserts far more than the initial capacity in one go, so a rehash happens
      // with tombstones already in the table — the interaction this is hunting.
      "burst",
    ]);
    const k = keyOf(Math.floor(rnd() * KEYS));

    if (kind === "insert") {
      const v = nextVal++;
      body.push(`    m.insert(${keyLit(k)}, ${vLit(v)})`);
      model.set(k, v);
    } else if (kind === "burst") {
      const n = 8 + Math.floor(rnd() * 24);
      for (let i = 0; i < n; i++) {
        const bk = keyOf(Math.floor(rnd() * KEYS));
        const v = nextVal++;
        body.push(`    m.insert(${keyLit(bk)}, ${vLit(v)})`);
        model.set(bk, v);
      }
    } else if (kind === "get") {
      body.push(`    match m.get(${lookupKey(k)}) {`);
      body.push(`        Option.Some(v) => { print("G" + ${vStr("v")}) }`);
      body.push(`        Option.None => { print("Gnone") }`);
      body.push(`    }`);
      expect.push(model.has(k) ? `G${vShown(model.get(k)!)}` : "Gnone");
    } else if (kind === "contains") {
      body.push(`    print("C" + (if m.contains(${lookupKey(k)}) { "1" } else { "0" }))`);
      expect.push(`C${model.has(k) ? 1 : 0}`);
    } else if (kind === "remove") {
      // remove returns void, so the observable is what the table says afterwards —
      // which is the stronger check anyway: it reads through the probe that the
      // tombstone was just written into.
      body.push(`    m.remove(${lookupKey(k)})`);
      model.delete(k);
      body.push(`    print("R" + (if m.contains(${lookupKey(k)}) { "1" } else { "0" }))`);
      expect.push("R0");
    } else if (kind === "getOrDefault") {
      body.push(`    print("D" + ${vStr(`m.getOrDefault(${lookupKey(k)}, ${vLit(-7)})`)})`);
      expect.push(`D${model.has(k) ? vShown(model.get(k)!) : vShown(-7)}`);
    } else if (kind === "len") {
      body.push(`    print("L" + m.len.toString())`);
      expect.push(`L${model.size}`);
    }
  }

  // Final sweep over every key in the space, live or not. A probe that terminates early
  // on a stale tombstone shows up here even if the random ops never happened to read the
  // one key it hid.
  for (let i = 0; i < KEYS; i++) {
    const k = keyOf(i);
    body.push(`    print("F" + (if m.contains(${lookupKey(k)}) { "1" } else { "0" }))`);
    expect.push(`F${model.has(k) ? 1 : 0}`);
  }
  body.push(`    print("L" + m.len.toString())`);
  expect.push(`L${model.size}`);
  // keys()/values() walk the slot array rather than probing, so they see tombstones the
  // probe never reaches. Counts only — HashMap seeds its hash per run, so any assertion
  // on ORDER would be testing the seed.
  body.push(`    print("K" + m.keys().len.toString() + ":" + m.values().len.toString())`);
  expect.push(`K${model.size}:${model.size}`);
  // for-in over a map is its own codegen path — it walks the slot array directly rather
  // than probing, so it sees tombstones the lookups never reach. Count and value-sum
  // only; the iteration ORDER is seed-dependent by design.
  body.push(`    var itn: i64 = 0`);
  body.push(`    var itsum: i64 = 0`);
  body.push(`    for _k, v in m {`);
  body.push(`        itn = itn + 1`);
  // With string values there is no number to add; sum their LENGTHS instead, which is
  // still a per-entry read through the iterator.
  body.push(OWNED ? `        itsum = itsum + v.len` : `        itsum = itsum + v`);
  body.push(`    }`);
  body.push(`    print("I" + itn.toString() + ":" + itsum.toString())`);
  let vsum = 0;
  for (const v of model.values()) vsum += OWNED ? vShown(v).length : v;
  expect.push(`I${model.size}:${vsum}`);

  const kt = stringKeys ? "string" : "i64";
  const src = [
    `// generated by scripts/fuzz-hashmap.ts — seed ${seed}, ${kt} keys${OWNED ? ", string values" : ""}`,
    `pub fn main(): i32 {`,
    `    var m: HashMap<${kt}, ${OWNED ? "string" : "i64"}> = HashMap.new()`,
    ...body,
    `    return 0`,
    `}`,
    ``,
  ].join("\n");
  return { src, expect };
}

const dir = mkdtempSync(join(tmpdir(), "milo-fuzzhm-"));
let failures = 0, ran = 0;
const t0 = Date.now();
try {
  for (let c = 0; c < CASES; c++) {
    const seed = SEED + c;
    // Alternate key types: string keys hash bytes and compare by content, i64 keys hash
    // the word — two different emitKeyCompare paths through the same probe.
    const { src, expect } = genCase(seed, c % 2 === 0);
    const file = join(dir, `case${seed}.milo`);
    writeFileSync(file, src);

    let out: string;
    let leaked: string | null = null;
    try {
      if (LEAKS) {
        // Two runs: once for the ANSWER, once under `leaks` for the VERDICT. `leaks` wraps
        // the program's stdout in its own headers and parsing around those is a guess.
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
        const lm = // The `s?` is required: the summary reads "1 leak for 16 total leaked bytes" in the
        // singular, and demanding the plural made a one-allocation leak look unmeasurable.
        // scripts/leak-check.ts already carried this exact comment; this did not reuse it.
        /(\d+) leaks? for (\d+) total leaked bytes/.exec(report);
        // No verdict is not evidence of cleanliness.
        if (!lm) leaked = "no leaks verdict — could not measure";
        else if (lm[1] !== "0") leaked = `${lm[1]} leaks / ${lm[2]} bytes`;
      } else {
        out = execFileSync("bun", [join(ROOT, "src", "main.ts"), "run", file], {
          cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
      }
    } catch (e: any) {
      failures++;
      console.error(`\nseed ${seed}: program failed to build or run\n${((e.stderr ?? "") + (e.stdout ?? "")).slice(0, 1200)}`);
      writeFileSync(join(ROOT, `hm-fuzz-${seed}.milo`), src);
      continue;
    }
    ran++;
    if (leaked) {
      failures++;
      console.error(`\nseed ${seed}: LEAK — ${leaked}`);
      writeFileSync(join(ROOT, `hm-fuzz-${seed}.milo`), src);
    }
    const actual = out.trim().split("\n").map(l => l.trim()).filter(l => l.length);
    if (actual.length !== expect.length || actual.some((l, i) => l !== expect[i])) {
      failures++;
      const at = actual.findIndex((l, i) => l !== expect[i]);
      console.error(`\nseed ${seed}: MODEL MISMATCH at line ${at + 1} (${c % 2 === 0 ? "string" : "i64"} keys)`);
      console.error(`  expected: ${expect.slice(Math.max(0, at - 2), at + 3).join(" | ")}`);
      console.error(`  actual:   ${actual.slice(Math.max(0, at - 2), at + 3).join(" | ")}`);
      writeFileSync(join(ROOT, `hm-fuzz-${seed}.milo`), src);
      console.error(`case written to hm-fuzz-${seed}.milo`);
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
  console.error("nothing ran — the harness is broken, not the hashmap");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
