// Gate on the docs-site stdlib pages: every signature and struct listing they publish
// must match the real std API.
//
// docs/std/*.md is generated and cannot drift; docs/site/stdlib/*.md is hand-written and
// had drifted into publishing APIs that do not exist. The argparse page documented a
// free-function API (`addString(parser, ...)`) against real methods on `ArgParser`, and
// gave `getI64` an `Option<i64>` return it has never had; the net page documented a
// `Response` type that is `FetchResponse`; the json page published
// `struct Json { raw, start, end }` against a real six-field parse tree; `s.indexOf` was
// documented as returning `-1` when it returns `Option<i64>`. Nothing compared a line of
// it to the compiler, and it is the page a new user reads first.
import { test, expect } from "bun:test";
import { check, comparedCount, COMPARED_FLOOR, NOT_YET_MATCHING } from "../scripts/check-api-docs";

test("no site page documents a signature or struct std does not have", () => {
  const problems = check().filter(p => !NOT_YET_MATCHING.has(p.module));
  const report = problems.map(p => `docs/site/stdlib/${p.module}.md:${p.line}: ${p.detail}`);
  expect(report).toEqual([]);
  // An empty report is only evidence when signatures were actually compared: a fence
  // detector that matches nothing reports every page clean.
  expect(comparedCount).toBeGreaterThanOrEqual(COMPARED_FLOOR);
});

test("the checker actually reads the pages", () => {
  // A scan that matched nothing would report a clean bill of health for a wrong page.
  // Feed it a deliberate lie and require it to be caught.
  const { checkOne } = require("../scripts/check-api-docs");
  expect(typeof checkOne).toBe("function");
  expect(checkOne("json", "```milo\nfn Json.noSuchMethod(self: &Json): i64\n```").length).toBe(1);
  expect(checkOne("json", "```milo\nfn Json.str(self: &Json, key: &string): Option<string>\n```").length).toBe(0);
});
