#!/usr/bin/env bun
// Is the code the MAIN compiler generates memory-safe?
//
// `milo build --sanitize` has existed for a long time and nothing ran it over the corpus.
// scripts/selfhost-asan.ts asks this question of milo-self's output; nobody asked it of the
// reference compiler's, so use-after-free, out-of-bounds and double-free in generated code
// had no gate at all. The leak gate cannot see any of those — it answers a different
// question, and answers it only for blocks big enough for `leaks` to notice.
//
//   bun scripts/asan-sweep.ts                 # sweep tests/fixtures
//   bun scripts/asan-sweep.ts --examples      # sweep the examples that carry `// @run:`
//   bun scripts/asan-sweep.ts --all           # both corpora
//   bun scripts/asan-sweep.ts --filter vec    # only entries whose name contains "vec"
//   bun scripts/asan-sweep.ts --verbose       # name every entry as it runs
//
// Leak detection is OFF here on purpose: LeakSanitizer does not exist on darwin/arm64, and
// leaks are already ratcheted by scripts/leak-check.ts. This is for the errors ASan finds
// that a leak checker structurally cannot.
import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { parseKnownRed } from "../tests/annotations";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const argv = process.argv.slice(2);
const filter = argv.includes("--filter") ? argv[argv.indexOf("--filter") + 1]! : null;
const VERBOSE = argv.includes("--verbose");

const wantExamples = argv.includes("--examples") || argv.includes("--all");
const wantFixtures = !argv.includes("--examples") || argv.includes("--all");

// One entry to sweep: where its source is, and the argv it needs to run headlessly.
interface Entry { name: string; src: string; args: string[] }

function fixtureEntries(): Entry[] {
  return readdirSync(FIXTURES)
    .filter(f => f.endsWith(".milo"))
    // Same contract as the fixture lane: a fixture that does not run on this OS is not a
    // memory-safety signal here either.
    .filter(f => !readFileSync(join(FIXTURES, f), "utf8").includes("@skip-os"))
    .map(f => ({ name: f.replace(/\.milo$/, ""), src: join(FIXTURES, f), args: [] }));
}

// Only examples carrying `// @run:` — the rest are library modules with no main, or SDL
// programs that would block a headless runner forever. The annotation also carries the
// argv the program needs, which is why scripts/run-examples.ts uses the same marker.
function exampleEntries(): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".milo")) {
        const text = readFileSync(p, "utf8");
        const m = /^\s*\/\/\s*@run:(.*)$/m.exec(text);
        if (!m) continue;
        out.push({
          name: p.slice(ROOT.length + 1).replace(/\.milo$/, "").replace(/\//g, "_"),
          src: p,
          args: m[1]!.trim().split(/\s+/).filter(Boolean),
        });
      }
    }
  };
  walk(join(ROOT, "examples"));
  return out;
}

// tests/known-red.txt names fixtures that reproduce an OPEN soundness hole. The test
// driver skips their @expect comparison; this sweep does not skip anything, it only labels
// the line so an expected red reads differently from a regression. Exit status is still 1:
// a listed hole is meant to keep this gate red until the work package that closes it lands.
const KNOWN_RED = join(ROOT, "tests", "known-red.txt");
const knownRed = new Map(
  [...(existsSync(KNOWN_RED) ? parseKnownRed(readFileSync(KNOWN_RED, "utf8")) : new Map<string, string>())]
    .map(([name, why]) => [name.replace(/\.milo$/, ""), why] as const),
);

const entries = [...(wantFixtures ? fixtureEntries() : []), ...(wantExamples ? exampleEntries() : [])]
  .filter(e => !filter || e.name.includes(filter));

const dir = mkdtempSync(join(tmpdir(), "milo-asan-"));
let ran = 0, buildFailed = 0;
const errors: { name: string; detail: string }[] = [];
const unbuildable: string[] = [];

try {
  for (const entry of entries) {
    const { name, src } = entry;
    const bin = join(dir, name);
    // A fixture with a companion .c is compiled together with it, exactly as the fixture
    // lane does — without that these nine link-fail and silently leave the sweep.
    const companion = src.replace(/\.milo$/, ".c");
    const args = ["run", join(ROOT, "src", "main.ts"), "build", src, "-o", bin, "--sanitize"];
    if (existsSync(companion)) args.push(companion);
    try {
      execFileSync("bun", args, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      buildFailed++;
      unbuildable.push(name);
      continue;
    }
    let out: string;
    try {
      out = execFileSync(bin, entry.args, {
        cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
      });
    } catch (e: any) {
      out = (e.stdout ?? "") + (e.stderr ?? "");
    }
    ran++;
    const m = /ERROR: AddressSanitizer: ([^\n]*)/.exec(out);
    if (m) errors.push({ name, detail: m[1]!.slice(0, 120) });
    else if (VERBOSE) console.log(`ok   ${name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (const e of errors) {
  const why = knownRed.get(e.name);
  console.log(`ASAN  ${e.name}: ${e.detail}${why ? `\n      known-red: ${why}` : ""}`);
}
if (unbuildable.length) console.log(`\ncould not build under -fsanitize=address: ${unbuildable.join(", ")}`);
const corpus = wantExamples && wantFixtures ? "fixtures + examples" : wantExamples ? "examples" : "fixtures";
console.log(`\n${ran} ${corpus} ran under AddressSanitizer, ${buildFailed} could not build, ${errors.length} reported an error`);

// A sweep that builds nothing reports zero errors and exits 0 forever. Say so instead.
// Only on a FULL sweep: `--filter vec` is meant to run a handful.
const floor = wantFixtures ? 300 : 20;
if (!filter && ran < floor) {
  console.error(`only ${ran} ${corpus} ran (expected at least ${floor}) — the sweep is not exercising the corpus`);
  process.exit(2);
}
process.exit(errors.length ? 1 : 0);
