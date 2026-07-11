// codegen-js coverage sweep: compile every tests/fixtures/*.milo to JS via `emit-js`,
// run it, and compare (trimmed, per-line) to the fixture's `// @expect:` annotations —
// exactly as tests/run.test.ts does for the native binary. Measures how many programs
// the in-browser playground backend runs byte-identical to native.
//
//   bun scripts/js-sweep.ts          # summary + DIFF list
//   bun scripts/js-sweep.ts -v       # also list run-errors
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { parseExpected } from "../tests/annotations";

const DIR = "tests/fixtures";
const verbose = process.argv.includes("-v");
const files = readdirSync(DIR).filter(f => f.endsWith(".milo")).sort();

let pass = 0, diff = 0, cerr = 0, rerr = 0;
const diffs: string[] = [], rerrs: string[] = [];

for (const f of files) {
  const name = f.replace(".milo", "");
  const expected = parseExpected(readFileSync(join(DIR, f), "utf-8"));
  if (expected.length === 0) continue;
  let js: string;
  try { js = execSync(`bun run src/main.ts emit-js ${join(DIR, f)} 2>/dev/null`, { encoding: "utf-8" }); }
  catch { cerr++; diffs.push("COMPILE " + name); continue; }
  writeFileSync("/tmp/_jssweep.js", js);
  let out: string;
  try { out = execSync(`timeout 10 bun /tmp/_jssweep.js 2>/dev/null`, { encoding: "utf-8" }); }
  catch { rerr++; rerrs.push(name); continue; }
  const actual = out.trim().split("\n").map(l => l.trim());
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else { diff++; diffs.push("DIFF " + name); }
}

console.log(`js-sweep: ${pass} pass, ${diff} diff, ${cerr} compile-err, ${rerr} run-err (of ${files.length} fixtures)`);
if (diffs.length) console.log(diffs.join("\n"));
if (verbose && rerrs.length) console.log("run-errors (unsafe/systems/threads — out of playground scope):\n  " + rerrs.join(", "));
