// The gate on the gates: each assertion fails if the differential comparison is weakened.
import { expect, test } from "bun:test";
import { compare, norm, type Diff } from "../scripts/ts2milo-parser-diff";
import { compareDiagnostics } from "../scripts/ts2milo-checker-diff";

const ast = () => ({ kind: "Program", name: "x", n: 5, items: [{ kind: "A" }, { kind: "B" }], span: { line: 3, col: 4, file: "/abs/dir/a.milo" } });
const diffs = (a: any, b: any, spans = true) => { const d: Diff[] = []; compare(norm(a, spans), norm(b, spans), "$", d); return d; };

test("identical ASTs have no diff", () => {
  expect(diffs(ast(), ast())).toEqual([]);
});
test("changed kind is reported", () => {
  const b = ast(); b.kind = "Other";
  expect(diffs(ast(), b).map((d) => d.path)).toEqual(["$.kind"]);
});
test("kind missing on the generated side is reported", () => {
  const b: any = ast(); delete b.kind;
  expect(diffs(ast(), b).map((d) => d.path)).toEqual(["$.kind"]);
});
test("kind missing on the TS side is reported", () => {
  const a: any = ast(); delete a.kind;
  expect(diffs(a, ast()).map((d) => d.path)).toEqual(["$.kind"]);
});
test("changed string, number and array length are reported", () => {
  const s = ast(); s.name = "y";
  expect(diffs(ast(), s).map((d) => d.path)).toEqual(["$.name"]);
  const n = ast(); n.n = 6;
  expect(diffs(ast(), n).map((d) => d.path)).toEqual(["$.n"]);
  const l = ast(); l.items.pop();
  expect(diffs(ast(), l).map((d) => d.path)).toEqual(["$.items.length"]);
});
test("changed span line is reported, and ignored with spans off", () => {
  const b = ast(); b.span.line = 4;
  expect(diffs(ast(), b).map((d) => d.path)).toEqual(["$.span.line"]);
  expect(diffs(ast(), b, false)).toEqual([]);
});
test("span file is compared by basename", () => {
  const b = ast(); b.span.file = "rel/a.milo";
  expect(diffs(ast(), b)).toEqual([]);
  b.span.file = "rel/b.milo";
  expect(diffs(ast(), b).map((d) => d.path)).toEqual(["$.span.file"]);
});

test("checker compare: equal lists match, a changed message or missing diagnostic does not", () => {
  const d = (message: string) => ({ severity: "error", message, line: 1, col: 2 });
  expect(compareDiagnostics([d("a")], [d("a")])).toBeNull();
  expect(compareDiagnostics([d("a")], [d("b")])?.kind).toBe("different message");
  expect(compareDiagnostics([d("a")], [])?.kind).toBe("generated misses one");
});
