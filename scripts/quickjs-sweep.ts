// QuickJS conformance sweep for milojs-engine.
//
// QuickJS's tests/*.js are each one file of `function test_xxx() { assert(...) }`
// definitions followed by a flat list of `test_xxx();` calls at the bottom. Running
// a whole file gives one pass/fail bit and stops at the first gap, which hides
// everything downstream. So we split: strip the trailing call list, then run the
// file body once per call. That yields a per-testcase pass rate that actually moves
// as gaps get filled, plus an error histogram to rank what to fix next.
//
//   bun scripts/quickjs-sweep.ts            # summary + top error buckets
//   bun scripts/quickjs-sweep.ts -v         # also list every failing case
//   bun scripts/quickjs-sweep.ts -f loop    # only files whose name matches
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const QJS = join(process.env.HOME!, "git/quickjs/tests");
const ENGINE = process.env.MILOJS_ENGINE ?? "/tmp/milojs-engine";
const verbose = process.argv.includes("-v");
const filterIdx = process.argv.indexOf("-f");
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] : null;

// Tests that need host facilities the engine deliberately does not provide
// (std/os modules, workers, bjson) — out of scope, not conformance gaps.
const SKIP_FILES = new Set([
  "assert.js", "microbench.js", "test_std.js", "test_worker.js",
  "test_worker_module.js", "test_bjson.js",
  "fixture_cyclic_import.js", "fixture_string_exports.js", "fixture_throwing_module.js",
]);

const tmp = mkdtempSync(join(tmpdir(), "qjs-sweep-"));

// The trailing invocation list: a bare call at column 0, optionally with a
// `.catch(...)` tail for the async cases.
const CALL_RE = /^([A-Za-z_$][\w$]*)\(\)\s*(\.catch\([^\n]*\))?\s*;?\s*$/;

type Case = { file: string; name: string; src: string };

function casesFor(file: string): Case[] {
  const text = readFileSync(join(QJS, file), "utf-8");
  const lines = text.split("\n");
  const calls: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CALL_RE.exec(lines[i]!);
    if (m) calls.push({ name: m[1]!, line: i });
  }
  // Only treat as a suite when the calls cluster at the end of the file.
  const tail = calls.filter(c => c.line > lines.length * 0.5);
  if (tail.length < 2) return [{ file, name: "<whole>", src: text }];
  const first = tail[0]!.line;
  const body = lines.slice(0, first).join("\n");
  return tail.map(c => ({ file, name: c.name, src: `${body}\n${lines[c.line]}\n` }));
}

// Classify a failure into a bucket so the histogram ranks causes, not instances.
function bucket(out: string): string {
  const s = out.trim().split("\n")[0] ?? "";
  return s
    .replace(/\|[^|]*\|/g, "|…|")               // assert payloads
    .replace(/'[^']*'/g, "'…'")
    .replace(/\b\d+\b/g, "N")
    .slice(0, 120);
}

const files = readdirSync(QJS)
  .filter(f => f.endsWith(".js") && !SKIP_FILES.has(f))
  .filter(f => !filter || f.includes(filter))
  .sort();

let pass = 0, fail = 0;
const buckets = new Map<string, string[]>();

for (const file of files) {
  for (const c of casesFor(file)) {
    const path = join(tmp, "case.js");
    writeFileSync(path, c.src);
    let out = "", ok = false;
    try {
      out = execFileSync(ENGINE, [path], { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      // The engine reports uncaught throws on stdout and still exits 0.
      ok = !/^Uncaught /m.test(out);
    } catch (e: any) {
      out = (e.stdout ?? "") + (e.stderr ?? "") || `timeout/crash (${e.signal ?? e.status})`;
    }
    if (ok) pass++;
    else {
      fail++;
      const b = bucket(out);
      (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(`${file}:${c.name}`);
    }
  }
}

const total = pass + fail;
console.log(`quickjs-sweep: ${pass}/${total} cases pass (${((pass / total) * 100).toFixed(1)}%) across ${files.length} files\n`);
const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
console.log("top causes:");
for (const [b, cases] of ranked.slice(0, verbose ? 999 : 25)) {
  console.log(`  ${String(cases.length).padStart(3)}  ${b}`);
  if (verbose) console.log(`       ${cases.join(", ")}`);
}
