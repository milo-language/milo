import { test, expect, describe, afterAll } from "bun:test";
import { readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// Retry execution once on signal-based failures (resource pressure under full suite)
function execWithRetry(cmd: string, opts: Record<string, any>): string {
  try {
    return execSync(cmd, opts);
  } catch (e: any) {
    if (e.signal) {
      return execSync(cmd, opts);
    }
    throw e;
  }
}

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const ERRORS_DIR = join(import.meta.dir, "errors");
const RUNTIME_ERRORS_DIR = join(import.meta.dir, "runtime-errors");
const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

const binaries: string[] = [];
afterAll(() => {
  for (const bin of binaries) {
    try { unlinkSync(bin); } catch {}
  }
});

function parseExpected(source: string): string[] {
  return source.split("\n")
    .filter(l => l.startsWith("// @expect:"))
    .map(l => l.replace("// @expect:", "").trim());
}

function parseExpectedError(source: string): string | null {
  const line = source.split("\n").find(l => l.startsWith("// @error:"));
  return line ? line.replace("// @error:", "").trim() : null;
}

function parseExpectedRuntimeError(source: string): string | null {
  const line = source.split("\n").find(l => l.startsWith("// @runtime-error:"));
  return line ? line.replace("// @runtime-error:", "").trim() : null;
}

describe("fixtures (compile + run)", () => {
  const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".milo"));

  for (const file of files) {
    test(file.replace(".milo", ""), () => {
      const path = join(FIXTURES_DIR, file);
      const source = readFileSync(path, "utf-8");
      const expected = parseExpected(source);

      const outBin = join(FIXTURES_DIR, file.replace(".milo", ""));
      binaries.push(outBin);

      // a companion `<name>.c` (C ABI test peers) is linked into the build so Milo
      // and clang agree on struct layout / by-value calling convention
      const companionC = path.replace(/\.milo$/, ".c");
      const cArg = existsSync(companionC) ? ` ${companionC}` : "";

      execWithRetry(`bun run ${COMPILER} build ${path} -o ${outBin}${cArg}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const result = execWithRetry(outBin, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const actual = result.trim().split("\n").map(l => l.trim());

      expect(actual).toEqual(expected);
    });
  }
});

describe("errors (type checker rejects)", () => {
  const files = readdirSync(ERRORS_DIR).filter(f => f.endsWith(".milo"));

  for (const file of files) {
    test(file.replace(".milo", ""), () => {
      const path = join(ERRORS_DIR, file);
      const source = readFileSync(path, "utf-8");
      const expectedError = parseExpectedError(source);

      let stderr = "";
      let failed = false;
      try {
        execSync(`bun run ${COMPILER} build ${path} -o /dev/null`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e: any) {
        failed = true;
        stderr = e.stderr?.toString() ?? "";
      }

      expect(failed).toBe(true);
      if (expectedError) {
        expect(stderr).toContain(expectedError);
      }
    });
  }
});

describe("runtime errors (debug mode traps)", () => {
  let files: string[] = [];
  try { files = readdirSync(RUNTIME_ERRORS_DIR).filter(f => f.endsWith(".milo")); } catch {}

  for (const file of files) {
    test(file.replace(".milo", ""), () => {
      const path = join(RUNTIME_ERRORS_DIR, file);
      const source = readFileSync(path, "utf-8");
      const expectedError = parseExpectedRuntimeError(source);

      const outBin = join(RUNTIME_ERRORS_DIR, file.replace(".milo", ""));
      binaries.push(outBin);

      execWithRetry(`bun run ${COMPILER} build ${path} --debug -o ${outBin}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let failed = false;
      try {
        stdout = execSync(outBin, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      } catch (e: any) {
        failed = true;
        stdout = e.stdout?.toString() ?? "";
      }

      expect(failed).toBe(true);
      if (expectedError) {
        expect(stdout).toContain(expectedError);
      }
    });
  }
});
