// `milo skill` is what an agent reads before writing Milo, so a stale snippet there is
// copied straight into new code. Every ```milo fence in the CLI's actual output must
// type-check, and the generated std module list must cover std/ with a summary each.
import { test, describe, expect } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import { wrapSnippet, checkSnippet } from "./snippetCheck";

const REPO_ROOT = join(import.meta.dir, "..");

const proc = Bun.spawnSync(["bun", "run", join(REPO_ROOT, "src/main.ts"), "skill"], { cwd: REPO_ROOT });
const output = proc.stdout.toString();

function milFences(text: string): { line: number; code: string }[] {
  const lines = text.split("\n");
  const out: { line: number; code: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("```milo")) continue;
    // No skip/error modes: every snippet in the guide is meant to be copied as-is.
    if (lines[i]!.trim() !== "```milo") throw new Error(`skill output line ${i + 1}: unsupported fence '${lines[i]}'`);
    const start = i + 1;
    const buf: string[] = [];
    while (++i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i]!);
    if (i >= lines.length) throw new Error(`skill output: unterminated fence at line ${start}`);
    out.push({ line: start, code: buf.join("\n") });
  }
  return out;
}

describe("milo skill", () => {
  test("command succeeds", () => {
    expect(proc.exitCode).toBe(0);
    expect(output).toContain("# Milo Language Guide");
  });

  const fences = milFences(output);
  test("has milo snippets to check", () => {
    // A fence regex that stops matching would otherwise turn this file into 0 checks.
    expect(fences.length).toBeGreaterThanOrEqual(10);
  });

  for (const f of fences) {
    test(`snippet at output line ${f.line} type-checks`, () => {
      const wrapped = wrapSnippet(f.code);
      const errors = checkSnippet(wrapped);
      if (errors.length > 0) {
        throw new Error(`skill snippet failed to compile:\n${errors.join("\n")}\n--- wrapped source ---\n${wrapped}`);
      }
    });
  }

  test("std module list covers every std module, each with a summary", () => {
    const stems = new Set(readdirSync(join(REPO_ROOT, "std"))
      .filter(f => f.endsWith(".milo") && !f.endsWith("_test.milo"))
      .map(f => f.replace(/\.milo$/, "").replace(/\.(darwin|linux|windows|wasm)$/, "")));
    const listed = [...output.matchAll(/^- `std\/([a-z0-9_]+)`: (.*)$/gm)];
    expect(listed.map(m => m[1]).sort()).toEqual([...stems].sort());
    for (const m of listed) expect(m[2]!.trim().length).toBeGreaterThan(0);
  });
});
