// Leak gate: compile every stdout-comparable fixture, run it, and fail if the
// process exits still holding heap it allocated.
//
//   bun scripts/leak-check.ts                  # census, print leakers
//   bun scripts/leak-check.ts --write          # rewrite tests/leak-clean.txt
//   bun scripts/leak-check.ts --check          # ratchet: exit 1 if a clean fixture regressed
//   bun scripts/leak-check.ts --filter json
//
// Why this exists: milo-self leaked EVERY owned local for months — `emitScopeDrops`
// only ran user `impl Drop` and never freed builtin heap — and the fixture sweep
// stayed green the whole time, because a fixture that leaks still prints the right
// bytes. The one fixture that leaked badly enough to die (zstdCompress) was bucketed
// `guard-memory`, which the ratchet treats as "no verdict". Nothing was watching.
//
// Two detectors, because no single one covers both hosts:
//   * Linux — build with `--sanitize` and let LeakSanitizer (bundled with ASan)
//     report at exit. This is the CI gate, and it also catches use-after-free.
//   * macOS — LSan does not exist on darwin/arm64, so shell out to `leaks -atExit`,
//     which reports unreachable blocks with per-callsite attribution.
// A leak is a leak either way; the detectors disagree only about what else they see.
//
// Every child runs under scripts/guard.ts: a leaking binary is exactly the kind
// that eats the machine, which is the situation the guard exists for.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir, platform } from "os";
import { join, basename } from "path";
import { parseExpectedError, parseExpectedRuntimeError } from "../tests/annotations";
import { guardedRun } from "./guard";

const MILO_ROOT = join(import.meta.dir, "..");
const FIXTURES_DIR = join(MILO_ROOT, "tests", "fixtures");
// One manifest PER DETECTOR. LSan and `leaks` do not agree on what counts: LSan
// reports blocks unreachable at exit from its own root set, `leaks` scans the live
// process. Sharing one list would make every CI run relitigate that difference
// instead of catching regressions.
const MANIFEST_MAC = join(MILO_ROOT, "tests", "leak-clean.txt");
const MANIFEST_LSAN = join(MILO_ROOT, "tests", "leak-clean.lsan.txt");
const CHILD_ENV = { ...process.env, MILO_ROOT };

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
const fi = args.indexOf("--filter");
const filter = fi >= 0 ? args[fi + 1] : null;
if (check && filter) {
  console.error("--check ratchets against the whole manifest; it cannot be combined with --filter");
  process.exit(2);
}

// macOS has no LeakSanitizer; `leaks` is the only detector that sees unreachable
// blocks there. Linux gets LSan, which is both cheaper and stricter.
const IS_MAC = platform() === "darwin";
const MANIFEST = IS_MAC ? MANIFEST_MAC : MANIFEST_LSAN;
const COMPILE_MEM_MB = 1536;
// ASan shadow memory and `leaks` scanning both need materially more headroom than
// a plain run of the same fixture.
const RUN_MEM_MB = 2048;

type Outcome = { name: string; ok: boolean; reason: string; detail: string };

function buildCmd(src: string, outBin: string): [string, string[]] {
  const companionC = join(FIXTURES_DIR, `${basename(src, ".milo")}.c`);
  const extra = existsSync(companionC) ? [companionC] : [];
  const sanitize = IS_MAC ? [] : ["--sanitize"];
  return ["bun", [join(MILO_ROOT, "src", "main.ts"), "build", src, "-o", outBin, ...sanitize, ...extra]];
}

// `leaks` prints a summary line per process; anything nonzero is a real leak.
// Its exit code is 1 when leaks are found and also 1 for some failures to attach,
// so parse the line rather than trusting the code.
// The `s?` is required: the summary reads "1 leak for 32 total leaked bytes" in
// the singular, and a plural-only pattern scored every single-leak fixture as
// "no verdict" — 17 of them — which the ratchet then declined to count either way.
const MAC_SUMMARY = /(\d+) leaks? for (\d+) total leaked bytes/;

// WHAT THIS GATE DOES NOT SEE: `leaks` walks from roots, and a SMALL abandoned block is
// routinely still reachable from a stale stack slot — so it is not reported. The size
// matters, not the logic. The same program that leaks one allocation per call shows
// "0 leaks" with a 20-byte string and 200 leaks with a 16 KB one.
//
// That is not hypothetical: every closure call leaked its owned argument for as long as
// closures have existed (fixed in d781fd9b), and none of the fixtures below caught it —
// 28 of them were leaking the whole time and reported clean. It was found only by scaling
// one repro to `("x" + i.toString()).repeat(4000)`.
//
// So a green run here means "no fixture leaks a block big enough for `leaks` to notice",
// which is weaker than it looks. When writing a fixture to pin a leak, allocate BIG and say
// why — see tests/fixtures/closureParamOwnership.milo.

async function checkOne(name: string, tmpDir: string): Promise<Outcome> {
  const src = join(FIXTURES_DIR, `${name}.milo`);
  const outBin = join(tmpDir, name);
  const [cmd, cmdArgs] = buildCmd(src, outBin);

  const build = await guardedRun(cmd, cmdArgs, { env: CHILD_ENV, timeoutMs: 120000, memMb: COMPILE_MEM_MB });
  if (build.code !== 0) {
    return { name, ok: false, reason: "build-failed", detail: (build.stderr + build.stdout).trim().split("\n")[0]?.slice(0, 120) ?? "" };
  }

  if (IS_MAC) {
    const r = await guardedRun("leaks", ["-atExit", "--", outBin], { env: CHILD_ENV, timeoutMs: 120000, memMb: RUN_MEM_MB });
    const out = r.stdout + r.stderr;
    const m = out.match(MAC_SUMMARY);
    // No summary line at all means `leaks` never got a verdict (it refuses on some
    // restricted processes). Report it rather than scoring it clean — a detector
    // that silently skips its input is the exact failure this gate exists to catch.
    if (!m) return { name, ok: false, reason: "no-verdict", detail: out.trim().split("\n")[0]?.slice(0, 120) ?? "" };
    const count = Number(m[1]);
    if (count > 0) {
      // Attribute to the allocating function so the report names a place to look.
      const sites = [...out.matchAll(/ROOT LEAK: <\w+ in (\w+)/g)].map(x => x[1]);
      const top = [...new Set(sites)].slice(0, 4).join(", ");
      return { name, ok: false, reason: "leaked", detail: `${m[1]} leaks / ${m[2]} bytes${top ? ` in ${top}` : ""}` };
    }
    return { name, ok: true, reason: "clean", detail: "" };
  }

  // LSan reports on a clean exit and forces a nonzero status via exitcode=23, which
  // keeps a leak distinguishable from the fixture's own failing exit code.
  const env = { ...CHILD_ENV, ASAN_OPTIONS: "detect_leaks=1:exitcode=23" };
  const r = await guardedRun(outBin, [], { env, timeoutMs: 120000, memMb: RUN_MEM_MB });
  const out = r.stdout + r.stderr;
  if (/ERROR: LeakSanitizer: detected memory leaks/.test(out)) {
    const m = out.match(/SUMMARY: AddressSanitizer: (\d+) byte\(s\) leaked in (\d+) allocation\(s\)/);
    return { name, ok: false, reason: "leaked", detail: m ? `${m[2]} allocations / ${m[1]} bytes` : "LeakSanitizer reported leaks" };
  }
  if (/ERROR: AddressSanitizer/.test(out)) {
    return { name, ok: false, reason: "asan", detail: out.match(/ERROR: AddressSanitizer: [^\n]*/)?.[0]?.slice(0, 120) ?? "" };
  }
  return { name, ok: true, reason: "clean", detail: "" };
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "milo-leak-"));
  try {
    let names = readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith(".milo"))
      .map(f => basename(f, ".milo"))
      .filter(n => {
        const s = readFileSync(join(FIXTURES_DIR, `${n}.milo`), "utf-8");
        // A fixture that asserts a compile error never produces a binary; one that
        // asserts a runtime abort dies before any detector can report at exit.
        return !parseExpectedError(s) && !parseExpectedRuntimeError(s);
      })
      .sort();
    if (filter) names = names.filter(n => n.includes(filter));

    // Both detectors scan a whole address space, so this is deliberately far below
    // the sweep's 4: N workers x RUN_MEM_MB must stay well under half of RAM, and a
    // leaking binary is exactly the kind that runs away. Serial takes ~25min on the
    // full corpus, which is too slow to gate on; 2 is the compromise. See guard.ts
    // before raising it.
    const concurrency = Number(process.env.MILO_LEAK_CONCURRENCY || 0) || 2;
    const results: Outcome[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < names.length) results.push(await checkOne(names[next++], tmpDir));
    }));
    results.sort((a, b) => a.name.localeCompare(b.name));

    const clean = results.filter(r => r.ok).map(r => r.name);
    const dirty = results.filter(r => !r.ok);
    console.log(`\n${clean.length}/${results.length} fixtures exit leak-free (${IS_MAC ? "leaks -atExit" : "LeakSanitizer"})\n`);
    for (const r of dirty) console.log(`  ${r.reason.padEnd(13)} ${r.name}: ${r.detail}`);

    if (write) {
      writeFileSync(MANIFEST, `# Fixtures that exit with no leaked heap. Regenerate: bun scripts/leak-check.ts --write\n# Gate: bun scripts/leak-check.ts --check\n${clean.join("\n")}\n`);
      console.log(`\nwrote ${clean.length} names to ${MANIFEST}`);
    }

    if (check) {
      if (!existsSync(MANIFEST)) {
        console.error(`\nmissing ${MANIFEST} — seed it with --write`);
        process.exit(1);
      }
      const claimed = readFileSync(MANIFEST, "utf-8").split("\n")
        .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      // A build failure or a missing `leaks` verdict is not evidence of a leak, and
      // failing closed on it would turn an unrelated breakage into a phantom leak
      // regression. A fixture that BUILT and RAN and leaked is the real signal.
      const unmeasured = new Set(dirty.filter(d => d.reason === "build-failed" || d.reason === "no-verdict").map(d => d.name));
      const regressed = claimed.filter(n => !clean.includes(n) && !unmeasured.has(n));
      const gained = clean.filter(n => !claimed.includes(n));
      if (unmeasured.size) console.log(`\nUNMEASURED (not counted either way): ${[...unmeasured].join(", ")}`);
      if (gained.length) console.log(`\nNEW: ${gained.length} fixture(s) now leak-free — rerun with --write to ratchet: ${gained.join(", ")}`);
      if (regressed.length) {
        console.error(`\nLEAK RATCHET FAILED: ${regressed.length} fixture(s) that used to exit clean now leak:\n  ${regressed.join("\n  ")}`);
        process.exit(1);
      }
      // Excusing an unmeasured fixture is right one at a time and catastrophic in bulk:
      // if `leaks` changes its output and the verdict regex stops matching, EVERY fixture
      // becomes "no-verdict", `regressed` is empty, and this gate passes forever having
      // measured nothing. Scattered build breaks are the case the exemption exists for;
      // most of the manifest going dark at once is a broken harness, not a clean run.
      const measured = claimed.filter(n => !unmeasured.has(n)).length;
      if (measured < Math.ceil(claimed.length * 0.9)) {
        console.error(`\nLEAK GATE BROKEN: only ${measured}/${claimed.length} manifest fixtures produced a verdict.`);
        console.error(`Too few to call this a pass — check that the '${IS_MAC ? "leaks -atExit" : "LeakSanitizer"}' output still parses.`);
        process.exit(1);
      }
      console.log(`\nLEAK RATCHET OK — ${measured}/${claimed.length} manifest fixtures measured, all still exit clean`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
