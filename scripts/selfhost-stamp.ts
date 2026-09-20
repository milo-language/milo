#!/usr/bin/env bun
// Provenance for .selfhost/milo-self.bin: which source built it.
//
// Every selfhost harness grades a binary it did not build. Nothing forced that
// binary to correspond to the checkout being graded, and the failure is silent
// in the worst direction — a stale milo-self passes tests for bugs already
// fixed and fails ones already closed, and the run still prints a verdict. That
// happened once already (c3bf7091, the fixpoint compared stage 2 against a
// stale binary after the guard SIGKILLed the rebuild).
//
// `--version` cannot carry this: src-milo's MILO_BUILD is the literal "dev" and
// stamping it would mean rewriting tracked source for the duration of a 5-minute
// build. A sidecar answers the sharper question anyway: not "how old" but
// "built from THIS source or some other".
//
// Scope is src-milo/ + std/ — the self-hosted compiler's own sources. A src/
// change can also change the emitted binary, but src/ moves many times a day
// and milo-self takes minutes to rebuild; folding it in would mark the stamp
// stale constantly and train everyone to pass --allow-stale. The stamp catches
// the failure that actually bit us.
//
//   bun scripts/selfhost-stamp.ts --write    # after a build (selfhost.sh does this)
//   bun scripts/selfhost-stamp.ts --check    # exit 1 if stale

import { createHash } from "crypto";
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { join } from "path";

const MILO_ROOT = join(import.meta.dir, "..");
const SELFHOST_DIR = join(MILO_ROOT, ".selfhost");
const BIN = join(SELFHOST_DIR, "milo-self.bin");
const STAMP = join(SELFHOST_DIR, "milo-self.stamp");
const SOURCE_DIRS = ["src-milo", "std"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".milo")) out.push(p);
  }
  return out;
}

// Path is hashed alongside content: a file that only MOVED changes what the
// compiler resolves (platform suffix split, import paths) without changing any
// byte of content, and must invalidate.
function sourceHash(): string {
  const h = createHash("sha256");
  for (const dir of SOURCE_DIRS) {
    const abs = join(MILO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      h.update(f.slice(MILO_ROOT.length));
      h.update("\0");
      h.update(readFileSync(f));
      h.update("\0");
    }
  }
  return h.digest("hex").slice(0, 16);
}

interface Stamp {
  sourceHash: string;
  gitSha: string;
  builtAt: string;
}

function writeStamp(): Stamp {
  let gitSha = "unknown";
  try {
    gitSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: MILO_ROOT })
      .stdout.toString().trim() || "unknown";
  } catch { /* not a checkout — the source hash is the real check anyway */ }
  const stamp: Stamp = { sourceHash: sourceHash(), gitSha, builtAt: new Date().toISOString() };
  writeFileSync(STAMP, JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

function checkStamp(): { ok: boolean; reason: string } {
  if (!existsSync(BIN)) return { ok: false, reason: "no .selfhost/milo-self.bin — run: sh scripts/selfhost.sh" };
  if (!existsSync(STAMP)) {
    return { ok: false, reason: "no .selfhost/milo-self.stamp — binary predates stamping; rebuild: sh scripts/selfhost.sh" };
  }
  let stamp: Stamp;
  try {
    stamp = JSON.parse(readFileSync(STAMP, "utf8"));
  } catch {
    return { ok: false, reason: "unreadable .selfhost/milo-self.stamp — rebuild: sh scripts/selfhost.sh" };
  }
  const now = sourceHash();
  if (stamp.sourceHash !== now) {
    return {
      ok: false,
      reason: `STALE milo-self.bin: built from src-milo+std @ ${stamp.sourceHash} (${stamp.gitSha}, ${stamp.builtAt}), `
        + `checkout is @ ${now}. Grading this binary measures source you are not looking at. `
        + `Rebuild: sh scripts/selfhost.sh`,
    };
  }
  return { ok: true, reason: `milo-self.bin @ ${stamp.sourceHash} (${stamp.gitSha}) matches checkout` };
}

// Hard exit, never a warning. A warning about a stale binary scrolls past above
// 40 lines of test output and the verdict at the bottom still reads as truth.
export function requireFreshSelfhost(): void {
  const { ok, reason } = checkStamp();
  if (!ok) {
    console.error(`\nmilo-self provenance check FAILED\n  ${reason}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--write")) {
    const s = writeStamp();
    console.log(`stamped milo-self.bin: ${s.sourceHash} (${s.gitSha})`);
  } else {
    const { ok, reason } = checkStamp();
    console.log(reason);
    if (!ok) process.exit(1);
  }
}
