// Every HIR expression kind must have a stated answer to "does discarding this result
// leak?".
//
// `isOwnedTempExpr` decides whether a discarded expression owns something that nothing
// else will free. It is a list of node kinds, and a list of node kinds is exactly the
// shape that loses a sibling: `VecPop` was in it, `VecRemove` was not, and the two are the
// same operation ("take an element out of the buffer"). So `v.remove(0)` as a statement
// destroyed nothing — the element's destructor never ran and its heap went with it, while
// the identical `v.pop()` was correct.
//
// The bug was not that someone chose wrong. It is that a newly added HIR node inherits
// `false` by falling off the bottom of a switch, so nobody ever had to choose at all. This
// gate removes the implicit answer: a kind must appear either in `isOwnedTempExpr` (owned,
// so drop it) or in `NOT_OWNED_TEMP` (a scalar, a void, a view, or a place someone else
// owns). Adding a node to `hir.ts` without deciding fails here.
//
// Same medicine as tests/placeRuleCoverage.test.ts, applied outside the checker.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { NOT_OWNED_TEMP } from "../src/codegen";

const ROOT = join(import.meta.dir, "..");

function hirExprKinds(): string[] {
  const src = readFileSync(join(ROOT, "src", "hir.ts"), "utf8");
  const m = /export type HIRExpr\s*=(.*?);\n/s.exec(src);
  if (!m) throw new Error("could not find the HIRExpr union in src/hir.ts");
  return [...new Set([...m[1].matchAll(/kind: "([A-Za-z]+)"/g)].map(x => x[1]))].sort();
}

function classified(): { owned: Set<string>; neutral: Set<string> } {
  const src = readFileSync(join(ROOT, "src", "codegen.ts"), "utf8");
  const start = src.indexOf("private isOwnedTempExpr");
  if (start < 0) throw new Error("could not find isOwnedTempExpr in src/codegen.ts");
  // Brace-matched to the method's real end rather than sliced at a fixed width. The
  // window was 4200 characters against a body already 3834 long: the first case label
  // added past that point would have fallen outside the scan, been read as unclassified,
  // and — because the neutral list is the other half of this comparison — could equally
  // have been read as classified when it was not. A gate whose reach depends on a
  // constant nobody rechecks is the same silent-coverage failure it exists to catch.
  const body = (() => {
    let depth = 0, seen = false;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") { depth++; seen = true; }
      else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error("isOwnedTempExpr is not brace-balanced; the scan cannot be trusted");
  })();
  const owned = new Set([
    ...[...body.matchAll(/case "([A-Za-z]+)":/g)].map(x => x[1]),
    ...[...body.matchAll(/expr\.kind === "([A-Za-z]+)"/g)].map(x => x[1]),
  ]);
  // Imported rather than scraped: that keeps the list referenced code instead of a
  // comment nobody is obliged to keep, and a rename shows up as a type error here.
  return { owned, neutral: new Set(NOT_OWNED_TEMP) };
}

test("every HIRExpr kind is classified as owned-temp or not", () => {
  const kinds = hirExprKinds();
  const { owned, neutral } = classified();

  const unclassified = kinds.filter(k => !owned.has(k) && !neutral.has(k));
  // Both lists claiming a kind means the two answers disagree and whichever the switch
  // reaches first silently wins.
  const both = kinds.filter(k => owned.has(k) && neutral.has(k));
  // A name in NOT_OWNED_TEMP that no longer exists is a rename nobody followed through,
  // and it would keep the count looking right while covering nothing.
  const stale = [...neutral].filter(k => !kinds.includes(k));

  expect({
    unclassified, both, stale,
    fix: unclassified.length
      ? "add it to isOwnedTempExpr if discarding it leaks, otherwise to NOT_OWNED_TEMP"
      : "",
  }).toEqual({ unclassified: [], both: [], stale: [], fix: "" });
});
