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
//   - An entrypoint that @embedFiles a generated game asset that has not been
//     fetched is skipped into its own bucket, never silently passed. Neither a
//     compile nor a failure: run scripts/fetch-assets.sh and it comes back.
//
// Usage: bun run scripts/run-examples.ts [--verbose] [--bare]
//
// `--bare` reproduces a CI runner on a dev machine: fetchable game assets count as
// absent and package resolution sees an empty cache. Run it before touching this
// harness. A dev machine has the assets fetched and the packages cached and a runner
// has neither, so a change can be green here and red there -- which happened twice in
// one day, and both diagnoses cost a CI round trip each. It changes no files.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { tmpdir } from "node:os";

const verbose = process.argv.includes("--verbose");
// Reproduce a bare CI runner on a dev machine: no fetched game assets, no package cache.
// Twice in one day a change to this harness was correct locally and wrong on the runner,
// because a dev machine has both and the runner has neither -- and each time the only way
// to see it was to hand-simulate the runner by moving files about, which is easy to get
// wrong and easier to forget to undo. `--bare` does it without touching the working tree.
const bare = process.argv.includes("--bare");
const bareCache = bare ? mkdtempSync(join(tmpdir(), "milo-bare-cache-")) : null;
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

// The game assets under these paths are downloaded, not committed
// (scripts/fetch-assets.sh). font.png sits in the bodies directory but is a
// committed bitmap font — if it is missing, that is a real breakage, not an
// unfetched asset, so it must not qualify for the skip below.
function isFetchableAsset(path: string): boolean {
  if (path.startsWith("examples/games/flight/cities/")) {
    return path.endsWith(".city") || path.endsWith(".ortho.png");
  }
  if (path.startsWith("examples/games/apsis/bodies/")) {
    return path.endsWith(".png") && !path.endsWith("/font.png");
  }
  return false;
}

const srcCache = new Map<string, string>();
function readSrc(path: string): string {
  let s = srcCache.get(path);
  if (s === undefined) {
    s = existsSync(path) ? readFileSync(path, "utf8") : "";
    srcCache.set(path, s);
  }
  return s;
}

// Every path an entrypoint bakes in with @embedFile, its own and those of every
// module it reaches through relative imports. @embedFile is resolved at compile
// time and relative to the file that writes it, so a missing one is a build
// error — walking the graph is what keeps this list from going stale when a
// game moves an embed into another module.
function embeddedAssetsOf(entry: string): string[] {
  const seen = new Set<string>();
  const assets = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    // Whole-line comments are dropped first: prose about @embedFile (fmt.milo
    // explains how `@` lexes) would otherwise register as a dependency on a
    // file that was never meant to exist.
    const src = readSrc(file).replace(/^[ \t]*\/\/.*$/gm, "");
    const dir = dirname(file);
    for (const m of src.matchAll(/@embedFile\s*\(\s*"([^"]+)"/g)) {
      assets.add(normalize(join(dir, m[1]!)));
    }
    // Package imports (std/*, gl, sdl) cannot reach these assets; only relative
    // ones are followed.
    for (const m of src.matchAll(/^\s*from\s+"(\.[^"]*)"/gm)) {
      const spec = m[1]!;
      queue.push(normalize(join(dir, spec.endsWith(".milo") ? spec : spec + ".milo")));
    }
  }
  return [...assets];
}

// flight/main.milo compiles in ~50s on a dev machine: at 60s the kill looked like a
// compile failure with an empty detail line, which is the worst kind of red.
const MILO_TIMEOUT_MS = 180_000;

function milo(args: string[], input?: string) {
  const r = spawnSync("bun", ["run", "src/main.ts", ...args], {
    encoding: "utf8",
    input,
    timeout: MILO_TIMEOUT_MS,
    // An empty XDG_CACHE_HOME is how a runner sees packages: `cacheRoot()` in src/pkg.ts
    // reads it, so pointing it at a fresh dir makes every `gl`/`sdl` import unresolvable
    // exactly as it is on CI, without disturbing the real cache.
    env: bareCache ? { ...process.env, XDG_CACHE_HOME: bareCache } : process.env,
  });
  // A timeout kill leaves stderr empty; name it so the failure line says what happened.
  if (r.signal) r.stderr = `${r.stderr ?? ""}\nkilled by ${r.signal} after ${MILO_TIMEOUT_MS / 1000}s`.trim();
  return r;
}

const examples = walk(root).sort();
let compiled = 0, ran = 0, skipped = 0, assetsMissing = 0;
const failures: { file: string; phase: string; detail: string }[] = [];

for (const f of examples) {
  const src = await Bun.file(f).text();
  if (!/\bfn\s+main\s*\(/.test(src)) {
    skipped++;
    if (verbose) console.log(`SKIP (library)  ${f}`);
    continue;
  }

  // An example whose downloaded assets are absent would fail to compile for a
  // reason that says nothing about the compiler. Skip it out loud and bucket it
  // separately: never counted as compiled (it was not), never counted as passed.
  // Only assets fetch-assets.sh can produce qualify — anything else missing is
  // a real failure and falls through to the compile gate below.
  // In --bare mode a fetchable asset counts as absent even when it is sitting right
  // there, which is what a runner sees: CI never runs scripts/fetch-assets.sh.
  const missingAssets = embeddedAssetsOf(f).filter((p) => !existsSync(p) || (bare && isFetchableAsset(p)));
  if (missingAssets.length > 0 && missingAssets.every(isFetchableAsset)) {
    assetsMissing++;
    console.log(`SKIP (assets)  ${f}`);
    console.log(`  ${missingAssets.length} generated asset(s) missing, e.g. ${missingAssets[0]}`);
    console.log(`  run scripts/fetch-assets.sh to download them, then re-run`);
    // A missing asset excuses the BUILD, not the type check: `check` never opens an
    // embedded file, so it runs perfectly well without one. Skipping outright meant a
    // type error in these was invisible to CI until someone with the assets already
    // fetched happened to build locally, which is how flyby stopped compiling for a
    // while unnoticed. A type error is not an asset problem, so it fails like any other.
    //
    // Measured 2026-08-20 by hiding the fetchable assets and running this harness: FOUR
    // entrypoints skip (apsis/main, apsis/tools/checklayout, games/atlas/main,
    // flight/main), and 27 modules totalling ~9k lines are reachable only through them.
    // That is what CI was not type-checking. Note atlas, which is easy to miss when
    // thinking of this as "the flight and apsis problem".
    const chk = milo(["check", f]);
    if (chk.status !== 0) {
      const out = (chk.stderr || chk.stdout || "").trim();
      // A package this checkout has no copy of is the same kind of excuse as a missing
      // asset, and must not read as a type error. apsis imports `gl`, which is a PACKAGE
      // (github.com/milo-language/milo-gl); a dev machine has it in the local cache and a
      // CI runner does not, so requiring `check` to pass unconditionally turned CI red on
      // a program that is perfectly well typed. Only what survives this is a real finding.
      const missingPkg = /not found in the local package cache|Import paths without a leading 'std\/'/.test(out);
      if (missingPkg) {
        console.log(`  (type check skipped: a package this checkout lacks)`);
      } else {
        failures.push({ file: f, phase: "check", detail: out.split("\n").slice(-4).join("\n") });
      }
    }
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

console.log(`\nexamples: ${compiled} compiled, ${ran} of those ran, ${skipped} library modules skipped, ${assetsMissing} skipped for missing assets, ${failures.length} failed`);
if (assetsMissing > 0) console.log(`${assetsMissing} example(s) were NOT built — run scripts/fetch-assets.sh for their assets`);
for (const fl of failures) console.log(`\n--- ${fl.phase} FAIL: ${fl.file} ---\n${fl.detail}`);

// Exiting on `failures.length` alone means this passes when it does nothing. If the
// directory walk stops finding entrypoints, or the `// @run:` regex stops matching after
// a formatter change moves the annotation, `compiled` and `ran` fall to zero, no failure
// is recorded, and CI stays green while executing nothing — which is the specific blind
// spot this script was written to close in the first place.
//
// Floors, not exact counts, so adding or retiring an example needs no edit here. An
// asset-skipped example still counts as discovered; only a compile floor would be unfair
// on a machine with no assets fetched, so that one includes them.
const COMPILE_FLOOR = 40, RUN_FLOOR = 25;
const discovered = compiled + assetsMissing;
if (discovered < COMPILE_FLOOR || ran < RUN_FLOOR) {
  console.error(`\nHARNESS BROKEN: discovered ${discovered} entrypoints (floor ${COMPILE_FLOOR}) and ran ${ran} (floor ${RUN_FLOOR}).`);
  console.error(`Too few to call this a pass — check the directory walk and the '// @run:' annotation match.`);
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);
