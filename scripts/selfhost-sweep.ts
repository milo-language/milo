// Differential sweep: run every tests/fixtures/*.milo through milo-self and
// bucket the failures. This is how the M3 manifest grows — see docs/self-hosting.md.
//
//   bun scripts/selfhost-sweep.ts              # census, print buckets
//   bun scripts/selfhost-sweep.ts --write      # also rewrite tests/selfhost-manifest.txt
//   bun scripts/selfhost-sweep.ts --filter foo # only fixtures whose name contains foo
//
// Every milo-self invocation goes through guardedRun: the binaries under test
// are untrusted (see scripts/guard.ts).
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { parseExpected, parseExpectedError, parseExpectedRuntimeError } from "../tests/annotations";
import { guardedRun } from "./guard";

const MILO_ROOT = join(import.meta.dir, "..");
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self.bin");
const FIXTURES_DIR = join(MILO_ROOT, "tests", "fixtures");
const MANIFEST = join(MILO_ROOT, "tests", "selfhost-manifest.txt");
const CHILD_ENV = { ...process.env, MILO_ROOT };
// 4 workers × 1.5GB compile cap = 6GB worst case, under the 8GB global cap on
// a 16GB machine. 8×4GB default caps could outrun the watchdog and swap-thrash.
const CONCURRENCY = 4;
const COMPILE_MEM_MB = 1536;
const RUN_MEM_MB = 512;

const args = process.argv.slice(2);
const write = args.includes("--write");
const fi = args.indexOf("--filter");
const filter = fi >= 0 ? args[fi + 1] : null;

if (!existsSync(MILO_SELF)) {
  console.error(`missing ${MILO_SELF} — run scripts/selfhost.sh first`);
  process.exit(1);
}

// Failure buckets, in match order. The first pattern that hits a fixture's
// stderr names its bucket; unmatched failures land in "other" and want triage.
const BUCKETS: [string, RegExp][] = [
  ["index-oob", /array index out of bounds/i],
  ["unknown-struct", /unknown struct/i],
  ["undefined-function", /undefined function/i],
  ["unsupported-method", /unsupported method|unknown method/i],
  ["unknown-field", /unknown field/i],
  ["unsupported-stmt", /unsupported statement|not yet supported|TODO/i],
  ["parse-error", /parse error|unexpected token/i],
  ["type-error", /type error|expected .* found/i],
  ["panic", /panic/i],
];

type Outcome = { name: string; ok: boolean; bucket: string; detail: string };

async function sweepOne(name: string, tmpDir: string): Promise<Outcome> {
  const src = join(FIXTURES_DIR, `${name}.milo`);
  const outBin = join(tmpDir, name);
  const source = readFileSync(src, "utf-8");

  const build = await guardedRun(MILO_SELF, ["build", src, "-o", outBin], { env: CHILD_ENV, timeoutMs: 60000, memMb: COMPILE_MEM_MB });
  if (build.code !== 0) {
    const err = (build.stderr + build.stdout).trim();
    const hit = BUCKETS.find(([, re]) => re.test(err));
    const bucket = build.guardKill ? `guard-${build.guardKill}`
      : build.signal ? `signal-${build.signal}`
      : hit ? hit[0]
      : "other";
    return { name, ok: false, bucket, detail: err.split("\n")[0]?.slice(0, 120) ?? `exit ${build.code}` };
  }

  const r = await guardedRun(outBin, [], { env: CHILD_ENV, timeoutMs: 30000, memMb: RUN_MEM_MB });
  const expected = parseExpected(source);
  const actual = r.stdout.trim() === "" ? [] : r.stdout.trim().split("\n").map(l => l.trim());
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return {
      name, ok: false,
      bucket: r.signal || r.guardKill ? `run-crash` : "output-mismatch",
      detail: `want ${JSON.stringify(expected.slice(0, 2))} got ${JSON.stringify(actual.slice(0, 2))}`,
    };
  }
  return { name, ok: true, bucket: "pass", detail: "" };
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "milo-sweep-"));
  try {
    let names = readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith(".milo"))
      .map(f => basename(f, ".milo"))
      .filter(n => {
        const s = readFileSync(join(FIXTURES_DIR, `${n}.milo`), "utf-8");
        // Fixtures asserting a compile/runtime *error* are not stdout-comparable.
        return !parseExpectedError(s) && !parseExpectedRuntimeError(s);
      })
      .sort();
    if (filter) names = names.filter(n => n.includes(filter));

    const results: Outcome[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < names.length) {
        const n = names[next++];
        results.push(await sweepOne(n, tmpDir));
      }
    }));
    results.sort((a, b) => a.name.localeCompare(b.name));

    const passing = results.filter(r => r.ok).map(r => r.name);
    const byBucket = new Map<string, Outcome[]>();
    for (const r of results.filter(r => !r.ok)) {
      if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, []);
      byBucket.get(r.bucket)!.push(r);
    }

    console.log(`\n${passing.length}/${results.length} fixtures pass under milo-self\n`);
    for (const [bucket, rs] of [...byBucket].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(rs.length).padStart(3)}  ${bucket}`);
      for (const r of rs.slice(0, 3)) console.log(`         ${r.name}: ${r.detail}`);
      if (rs.length > 3) console.log(`         … ${rs.length - 3} more`);
    }

    if (write) {
      const old = readFileSync(MANIFEST, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      const lost = old.filter(n => !passing.includes(n));
      if (lost.length) {
        console.error(`\nREFUSING TO WRITE: manifest would shrink — these regressed:\n  ${lost.join("\n  ")}`);
        process.exit(1);
      }
      const header = readFileSync(MANIFEST, "utf-8").split("\n").filter(l => l.startsWith("#")).join("\n");
      writeFileSync(MANIFEST, `${header}\n${passing.join("\n")}\n`);
      console.log(`\nmanifest: ${old.length} → ${passing.length} fixtures`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
