// Every combinator that describes a callback must also check the callback it got.
//
// A combinator builds a `cbHint` saying what it will pass, hands it to
// `checkExprWithHint`, and — before this gate — was free to ignore the answer. Twenty of
// them did, so a closure could declare any parameter type it liked and be handed something
// else:
//
//     var v: Vec<i64> = …
//     v.each((x: &string) => print(x.len))              // printed a POINTER value
//     v.fold(0, (acc: i64, x: &string) => acc + x.len)  // folded garbage
//
// That is a type confusion the checker waved through, and with a smaller allocation it
// reads past the end of the buffer rather than into the neighbouring element.
//
// Fixing the twenty sites does nothing about the twenty-first. This gate is what makes the
// check the default: build a `cbHint` and you must consult `checkCallbackSig` about it, or
// say at the site why this one is different. It found `fold` immediately — the only
// combinator whose callback is `args[1]` rather than `args[0]`, which is exactly how a
// mechanical fix misses a sibling.
//
// Same shape as tests/placeRuleCoverage.test.ts and tests/ownedTempCoverage.test.ts.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const CHECKER = join(import.meta.dir, "..", "src", "checker.ts");

test("every cbHint site checks the callback's signature", () => {
  const lines = readFileSync(CHECKER, "utf8").split("\n");
  const unchecked: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/const cbHint(:| =)/.test(lines[i])) continue;
    // Bounded by the ARM, not by a line count. The check may sit anywhere in the block
    // that consumes the hint, and the widest today is 8 lines — but a fixed window is a
    // constant nobody rechecks, and one that silently stops reaching is how a site goes
    // unnoticed. The next `expr.method === "…"` starts a different combinator, so it is
    // the honest end of this one.
    let end = i + 1;
    while (end < lines.length && end < i + 60 && !/expr\.method === "/.test(lines[end])) end++;
    const window = lines.slice(i, end).join("\n");
    if (window.includes("checkCallbackSig(")) continue;
    if (window.includes("cbhint-ok:")) continue;
    // Name the method so the failure says which combinator, not just a line number.
    let method = "?";
    for (let j = i; j > Math.max(0, i - 40); j--) {
      const m = /expr\.method === "(\w+)"/.exec(lines[j]);
      if (m) { method = m[1]; break; }
    }
    unchecked.push(`checker.ts:${i + 1}: '${method}' builds a cbHint and never checks the callback against it`);
  }

  expect({
    unchecked,
    fix: unchecked.length
      ? "call this.checkCallbackSig(cbType, cbHint, method, sp) after checking the argument, or mark the site `cbhint-ok: <why>`"
      : "",
  }).toEqual({ unchecked: [], fix: "" });
});
