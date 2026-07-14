#!/usr/bin/env bun
// Repo linter: deterministic smell checks with auto-fix. Run by the pre-commit
// hook (`--staged --fix`) and manually (`--all`). Mechanical rules only —
// judgment-call conventions live in CONVENTIONS.md, reviewed by agent_review.sh.
//
// Usage:
//   bun run scripts/lint.ts --all            # lint all tracked files
//   bun run scripts/lint.ts --staged         # lint git-staged files
//   bun run scripts/lint.ts <file>...        # lint specific files
//   add --fix to auto-repair fixable issues
//
// Exit 0 = clean (or all issues fixed). Exit 1 = unfixable error(s) remain.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const useStaged = args.includes("--staged");
const useAll = args.includes("--all");
const explicit = args.filter((a) => !a.startsWith("--"));

function git(...a: string[]): string {
  const r = spawnSync("git", a, { encoding: "utf8" });
  return (r.stdout || "").trim();
}

function fileList(): string[] {
  if (explicit.length) return explicit;
  if (useStaged)
    return git("diff", "--cached", "--name-only", "--diff-filter=ACM")
      .split("\n")
      .filter(Boolean);
  if (useAll) return git("ls-files").split("\n").filter(Boolean);
  console.error("lint: pass --all, --staged, or explicit file paths");
  process.exit(2);
}

type Issue = { file: string; line: number; msg: string; fixable: boolean };
const errors: Issue[] = [];
const warns: Issue[] = [];
let fixedCount = 0;

const isTs = (f: string) => f.endsWith(".ts");
const isTest = (f: string) => f.endsWith(".test.ts") || f.includes("/tests/");
const isSh = (f: string) => f.endsWith(".sh");
const isDoc = (f: string) =>
  f.startsWith("docs/") && f.endsWith(".md");
const isRouterMd = (f: string) =>
  ["AGENTS.md", "AGENT_WORKFLOW.md", "CONVENTIONS.md"].includes(f);

for (const f of fileList()) {
  let text: string;
  try {
    text = await Bun.file(f).text();
  } catch {
    continue; // deleted / binary
  }
  const orig = text;
  let lines = text.split("\n");

  // R1: focused tests — .only() silently shrinks the suite. Error; fix strips it.
  if (isTs(f) && isTest(f)) {
    lines = lines.map((ln, i) => {
      if (/\b(describe|it|test)\.only\b/.test(ln)) {
        if (fix) {
          fixedCount++;
          return ln.replace(/\.only\b/g, "");
        }
        errors.push({ file: f, line: i + 1, msg: "focused test (.only) — remove before commit", fixable: true });
      }
      // .skip without an explanatory trailing comment is a silent hole — warn only (removing could enable a broken test).
      if (/\b(describe|it|test)\.skip\b/.test(ln) && !/\/\//.test(ln)) {
        warns.push({ file: f, line: i + 1, msg: "skipped test with no reason comment", fixable: false });
      }
      return ln;
    });
  }

  // R2: stray debugger — never belongs in a commit. Error; fix drops the line.
  if (isTs(f)) {
    const kept: string[] = [];
    lines.forEach((ln, i) => {
      if (/^\s*debugger\s*;?\s*$/.test(ln)) {
        if (fix) {
          fixedCount++;
          return; // drop line
        }
        errors.push({ file: f, line: i + 1, msg: "stray `debugger` statement", fixable: true });
      }
      kept.push(ln);
    });
    lines = kept;
  }

  // R3: committing code that ACTUALLY sets MILO_RUN_UNGUARDED=1 defeats the OS-crash guards (CLAUDE.md). No auto-fix.
  // Only flag a real guard-disabling assignment in an executed context — NOT help text, error strings, comments, or
  // env *reads* (`process.env.X === "1"`) that merely name the token. main.ts implements the flag, so it must name it.
  // Skip the guard-tooling files that necessarily name the token (the guard, this linter, the review driver).
  const namesGuardTokenByDesign = /(^|\/)(guard\.ts|lint\.ts|agent_review\.sh)$/.test(f);
  if ((isTs(f) || isSh(f)) && !namesGuardTokenByDesign) {
    const shSet = /(^|[;&|(]|\bexport\b|\benv\b)[ \t]*MILO_RUN_UNGUARDED=1\b/; // export/inline shell assignment
    const tsSet = /process\.env\.MILO_RUN_UNGUARDED\s*=\s*["']?1["']?/;         // process.env.X = "1"
    const tsObj = /\bMILO_RUN_UNGUARDED["']?\s*:\s*["']?1["']?/;                // env: { X: "1" }
    lines.forEach((ln, i) => {
      const isComment = /^\s*(\/\/|#|\*)/.test(ln);
      if (isComment) return;
      if ((isSh(f) && shSet.test(ln)) || (isTs(f) && (tsSet.test(ln) || tsObj.test(ln)))) {
        errors.push({ file: f, line: i + 1, msg: "MILO_RUN_UNGUARDED=1 disables memory guards — do not commit", fixable: false });
      }
    });
  }

  // R4: trailing whitespace (not .md — two trailing spaces is a hard break there).
  if (isTs(f) || isSh(f) || f.endsWith(".json")) {
    lines = lines.map((ln, i) => {
      if (/[ \t]+$/.test(ln)) {
        if (fix) {
          fixedCount++;
          return ln.replace(/[ \t]+$/, "");
        }
        warns.push({ file: f, line: i + 1, msg: "trailing whitespace", fixable: true });
        return ln;
      }
      return ln;
    });
  }

  // R6: system docs must carry a greppable doc-meta header (docs/doc-standards.md). Warn — retrofit is gradual.
  if (isDoc(f) || isRouterMd(f)) {
    if (!/<!--\s*doc-meta/.test(text.slice(0, 400))) {
      warns.push({ file: f, line: 1, msg: "missing <!-- doc-meta --> header (see docs/doc-standards.md)", fixable: false });
    }
  }

  let out = lines.join("\n");

  // R5: exactly one trailing newline on text files.
  if (isTs(f) || isSh(f) || f.endsWith(".json") || f.endsWith(".md")) {
    const normalized = out.replace(/\n*$/, "\n");
    if (normalized !== out) {
      if (fix) {
        fixedCount++;
        out = normalized;
      } else {
        warns.push({ file: f, line: lines.length, msg: "missing/extra trailing newline", fixable: true });
      }
    }
  }

  if (fix && out !== orig) {
    await Bun.write(f, out);
    // Re-stage so the fix is part of the commit, not left unstaged.
    if (useStaged) git("add", "--", f);
  }
}

for (const w of warns) console.error(`warn  ${w.file}:${w.line}  ${w.msg}`);
for (const e of errors) console.error(`ERROR ${e.file}:${e.line}  ${e.msg}`);
if (fix && fixedCount) console.error(`lint: auto-fixed ${fixedCount} issue(s)`);

if (errors.length) {
  // In --fix mode the fixable errors were already repaired, so anything left is
  // genuinely unfixable; in check mode some may just need a --fix run.
  const hint = fix ? "unfixable — needs a human" : "run with --fix or fix manually";
  console.error(`lint: ${errors.length} error(s) — commit blocked (${hint})`);
  process.exit(1);
}
process.exit(0);
