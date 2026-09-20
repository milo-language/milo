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

// The annotation may lead its own line or trail the offending statement — ten fixtures
// use the trailing form because it points at the line that must fail, and a parser that
// only matched the leading form found nothing in them. run.test.ts then skipped the
// message assertion entirely, leaving "the compiler rejected this for SOME reason" as
// the whole test.
export function parseExpectedError(source: string): string | null {
  for (const raw of source.split("\n")) {
    // trim() first: a CRLF checkout leaves `\r` on every line, and `.` does not match a
    // line terminator, so `(.+)$` failed on ALL of them — every error fixture on the
    // Windows runner reported "no annotation" while macOS and Linux were fine.
    const m = /\/\/\s*@error:\s*(.+)$/.exec(raw.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

export function parseExpectedRuntimeError(source: string): string | null {
  const line = source.split("\n").map(l => l.trim()).find(l => l.startsWith("// @runtime-error:"));
  return line ? line.replace("// @runtime-error:", "").trim() : null;
}

// tests/known-red.txt: fixtures that reproduce an OPEN soundness hole and are expected to
// fail today (docs/plans/soundness-sweep-2026-09.md). One filename per line, text after
// `#` is the reason. Keys are filenames with the `.milo` extension. Three readers share
// this parser so they cannot disagree about what is listed: tests/run.test.ts skips the
// @expect comparison, scripts/gen-spec.ts leaves the program out of the spec (a listed
// program is one the language must eventually REJECT, so "shall accept" would be a false
// requirement), and scripts/asan-sweep.ts labels the entry but still runs it.
export function parseKnownRed(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const hash = raw.indexOf("#");
    const name = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!name) continue;
    out.set(name, hash >= 0 ? raw.slice(hash + 1).trim() : "no reason given");
  }
  return out;
}
