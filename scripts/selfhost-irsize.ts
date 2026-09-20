#!/usr/bin/env bun
// How much IR does milo-self emit for its own source, and is that number drifting?
//
//   bun scripts/selfhost-irsize.ts            # census: IR lines, src LOC, expansion ratio, clang -O2 time
//   bun scripts/selfhost-irsize.ts --check    # exit 1 if IR lines exceed the baseline by more than the tolerance
//   bun scripts/selfhost-irsize.ts --write    # rebaseline (do this deliberately, after a codegen change you meant)
//   bun scripts/selfhost-irsize.ts --tolerance 5   # percent, default 10
//
// clang is ~95% of a self-build's wall clock and its cost tracks IR line count almost
// linearly (measured: 362k -> 4.68s, 512k -> 6.30s, 572k -> 7.35s at -O2). So IR size IS
// the edit-loop metric once milo-self becomes the daily compiler, and it is the kind of
// number that grows a few percent per commit and is never noticed.
//
// Two things move it and they need to be told apart, which is why the ratio is reported
// and not just the total:
//   src LOC     — src-milo genuinely growing. Fine, and not a codegen concern.
//   IR per LOC  — codegen emitting more per line of source. Drop glue, clone glue, span
//                 plumbing. This is the one worth watching: it compounds against every
//                 future line of source.
// Between 2026-08-05 and 2026-08-06 the total grew 58%: source +34% and expansion ratio
// +18% (13.67 -> 16.08), which multiply out to exactly that.
//
// Deterministic: same commit, same IR, same count — milo-self's output is bit-stable, so a
// difference here is a real change, never noise. The clang timing is NOT deterministic and
// is reported for context only; nothing gates on it.
//
// A codegen refactor that legitimately changes the shape of emitted IR should rebaseline
// with --write rather than have this fail. It is a drift detector, not a budget.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { guardedRun } from "./guard";

const MILO_ROOT = join(import.meta.dir, "..");
const MILO_SELF = join(MILO_ROOT, ".selfhost", "milo-self.bin");
const SRC_MILO = join(MILO_ROOT, "src-milo");
const BASELINE = join(MILO_ROOT, "tests", "selfhost-irsize.json");

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const write = argv.includes("--write");
const ti = argv.indexOf("--tolerance");
const tolerancePct = ti >= 0 ? Number(argv[ti + 1]) : 10;

if (!existsSync(MILO_SELF)) {
  console.error(`missing ${MILO_SELF} — run scripts/selfhost.sh first`);
  process.exit(1);
}

function srcLoc(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += srcLoc(p);
    else if (entry.name.endsWith(".milo")) total += readFileSync(p, "utf-8").split("\n").length;
  }
  return total;
}

const emit = await guardedRun(MILO_SELF, ["emit-ir", join(SRC_MILO, "main.milo")],
  { env: { ...process.env, MILO_ROOT }, timeoutMs: 600_000, memMb: 4096 });
if (emit.guardKill) {
  console.error(`NOT MEASURED — guard kill (${emit.guardKill}). Re-run with the machine idle.`);
  process.exit(1);
}
// Exit 0 with no output is a failure, not a zero-size result.
if (emit.code !== 0 || emit.stdout.length === 0) {
  console.error(`stage 2 emit FAILED — exit ${emit.code}, ${emit.stdout.length} bytes`);
  console.error(emit.stderr.trim().split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}

const irPath = join(MILO_ROOT, ".selfhost", "stage2.ll");
writeFileSync(irPath, emit.stdout);
const lines = emit.stdout.split("\n").length - 1;
const loc = srcLoc(SRC_MILO);
const ratio = lines / loc;

// Outlined helper calls vs helper bodies: glue that is emitted once and called N times is
// the cheap shape. If call sites climb while definitions stay flat, nothing is wrong; if
// bodies climb too, some helper is being emitted per instantiation.
const cloneCalls = (emit.stdout.match(/@milo\.clone\.(struct|enum)\./g) ?? []).length;
const dropCalls = (emit.stdout.match(/@milo\.drop\.(struct|enum)\./g) ?? []).length;
const helperDefs = (emit.stdout.match(/^define .*@milo\.(clone|drop)\./gm) ?? []).length;

const t0 = performance.now();
const link = Bun.spawnSync(["clang", "-O2", "-w", irPath, "-o", "/dev/null",
  ...(process.platform === "darwin"
    ? ["-lm", "-L/opt/homebrew/opt/openssl@3/lib", "-lssl", "-lcrypto",
       "-L/opt/homebrew/opt/sqlite/lib", "-lsqlite3"]
    : ["-lm", "-lssl", "-lcrypto", "-lsqlite3"])]);
const clangSecs = link.exitCode === 0 ? (performance.now() - t0) / 1000 : NaN;

console.log(`IR lines        ${lines.toLocaleString()}`);
console.log(`src-milo LOC    ${loc.toLocaleString()}`);
console.log(`IR per LOC      ${ratio.toFixed(2)}`);
console.log(`glue            ${cloneCalls} clone + ${dropCalls} drop call sites, ${helperDefs} helper definitions`);
console.log(`clang -O2       ${Number.isNaN(clangSecs) ? "FAILED TO LINK" : `${clangSecs.toFixed(2)}s (not deterministic — context only)`}`);

type Baseline = { lines: number; loc: number; ratio: number; commit: string; note: string };
const now: Baseline = {
  lines, loc, ratio: Number(ratio.toFixed(3)),
  commit: (Bun.spawnSync(["git", "-C", MILO_ROOT, "rev-parse", "--short", "HEAD"]).stdout.toString().trim()) || "unknown",
  note: "IR milo-self emits for src-milo. Rebaseline deliberately: bun scripts/selfhost-irsize.ts --write",
};

if (write) {
  writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`\nbaseline written: ${lines.toLocaleString()} lines at ${now.commit}`);
  process.exit(0);
}

if (check) {
  if (!existsSync(BASELINE)) {
    console.error(`\nno baseline at ${BASELINE} — create one with --write`);
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline;
  const growthPct = ((lines - base.lines) / base.lines) * 100;
  const ratioPct = ((ratio - base.ratio) / base.ratio) * 100;
  console.log(`\nvs baseline ${base.commit}: ${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}% IR lines, ` +
    `${ratioPct >= 0 ? "+" : ""}${ratioPct.toFixed(1)}% IR per LOC (tolerance ${tolerancePct}%)`);
  if (growthPct > tolerancePct) {
    console.error(`\nIR SIZE DRIFT: ${base.lines.toLocaleString()} → ${lines.toLocaleString()} lines. ` +
      `clang is ~95% of self-build time, so this is the edit loop getting slower.\n` +
      `  If the source grew, that is expected — check "IR per LOC" (${base.ratio.toFixed(2)} → ${ratio.toFixed(2)}), which is the codegen half.\n` +
      `  If the change was intended, rebaseline: bun scripts/selfhost-irsize.ts --write`);
    process.exit(1);
  }
  console.log("IR SIZE OK");
  process.exit(0);
}
