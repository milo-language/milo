#!/usr/bin/env bun
// Compiles every example entrypoint and runs the ones marked runnable. This is
// the "always run the app" gate (AGENT_WORKFLOW.md §Run): a change that breaks
// any example must fail here, not in the user's hands.
//
// Contract:
//   - Every file with `fn main(` MUST compile (build through clang). Any failure
//     is a hard FAIL and exits non-zero.
//   - A file with a `// @run: <args>` annotation is also executed and must exit 0
//     (`// @run:` with no args = run with none). Use this for self-contained
//     examples; omit it for servers/interactive/arg-needing ones (compile-only).
//   - Files without `fn main(` are library modules — skipped (they compile
//     transitively via their importer). Logged so nothing is silently dropped.
//
// Usage: bun run scripts/run-examples.ts [--verbose]

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const verbose = process.argv.includes("--verbose");
const root = "examples";
const out = mkdtempSync(join(tmpdir(), "milo-examples-"));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (p.endsWith(".milo")) files.push(p);
  }
  return files;
}

function milo(args: string[], input?: string) {
  return spawnSync("bun", ["run", "src/main.ts", ...args], {
    encoding: "utf8",
    input,
    timeout: 60_000,
  });
}

const examples = walk(root).sort();
let compiled = 0, ran = 0, skipped = 0;
const failures: { file: string; phase: string; detail: string }[] = [];

for (const f of examples) {
  const src = await Bun.file(f).text();
  if (!/\bfn\s+main\s*\(/.test(src)) {
    skipped++;
    if (verbose) console.log(`SKIP (library)  ${f}`);
    continue;
  }

  // Compile (hard gate) — full pipeline including clang link.
  const bin = join(out, f.replace(/[\/.]/g, "_"));
  const build = milo(["build", f, "-o", bin]);
  if (build.status !== 0) {
    failures.push({ file: f, phase: "compile", detail: (build.stderr || build.stdout || "").trim().split("\n").slice(-4).join("\n") });
    console.log(`FAIL compile   ${f}`);
    continue;
  }
  compiled++;

  // Run only if opted in via `// @run:`.
  const m = src.match(/^\s*\/\/\s*@run:(.*)$/m);
  if (!m) {
    if (verbose) console.log(`OK   compile   ${f}`);
    continue;
  }
  const runArgs = m[1].trim().split(/\s+/).filter(Boolean);
  const stdinM = src.match(/^\s*\/\/\s*@stdin:(.*)$/m);
  const run = milo(["run", f, ...(runArgs.length ? ["--", ...runArgs] : [])], stdinM ? stdinM[1].trim() + "\n" : undefined);
  if (run.status !== 0) {
    failures.push({ file: f, phase: "run", detail: `exit ${run.status}: ${(run.stderr || "").trim().split("\n").slice(-3).join("\n")}` });
    console.log(`FAIL run       ${f}`);
    continue;
  }
  ran++;
  console.log(`OK   ran       ${f}  ${runArgs.join(" ")}`);
}

console.log(`\nexamples: ${compiled} compiled, ${ran} of those ran, ${skipped} library modules skipped, ${failures.length} failed`);
for (const fl of failures) console.log(`\n--- ${fl.phase} FAIL: ${fl.file} ---\n${fl.detail}`);
process.exit(failures.length ? 1 : 0);
