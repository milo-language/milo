// Fixture annotation parsing, shared by tests/run.test.ts (TS compiler) and
// tests/selfhost.test.ts (milo-self). Both must agree on what a fixture expects,
// otherwise the self-host ratchet measures the wrong thing.
//
// Annotations are matched after trimming: the formatter indents comments to
// their enclosing block, so requiring column 0 would make `milo fmt` break
// every fixture whose annotation sits inside a function body.

export function parseExpected(source: string): string[] {
  return source.split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("// @expect:"))
    .map(l => l.replace("// @expect:", "").trim());
}

export function parseExpectedError(source: string): string | null {
  const line = source.split("\n").map(l => l.trim()).find(l => l.startsWith("// @error:"));
  return line ? line.replace("// @error:", "").trim() : null;
}

export function parseExpectedRuntimeError(source: string): string | null {
  const line = source.split("\n").map(l => l.trim()).find(l => l.startsWith("// @runtime-error:"));
  return line ? line.replace("// @runtime-error:", "").trim() : null;
}
