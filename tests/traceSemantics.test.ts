// scripts/trace-semantics.ts: the two-way trace between docs/semantics/milo.md and src/interp*.ts.
// The real tree must be clean; each planted gap, in a temp copy, must make the gate fail with the
// check that names it (a gate that cannot fail is the thing this guards against).
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MODULE, parseFns, parseRules, realTree, testTitles, trace } from "../scripts/trace-semantics";

const real = realTree();

// a copy of the tree the gate reads, to damage
function copyTree() {
  const root = mkdtempSync(join(tmpdir(), "milo-trace-"));
  const t = { doc: join(root, "milo.md"), srcDir: join(root, "src"), testFiles: [join(root, "interp.test.ts")], fixtureDirs: real.fixtureDirs }; // read-only: the gate never writes them
  cpSync(real.doc, t.doc);
  cpSync(real.testFiles.find(f => f.endsWith("/interp.test.ts"))!, t.testFiles[0]!);
  cpSync(real.srcDir, t.srcDir, { recursive: true, filter: p => !p.includes("/src/") || /\/src\/interp[^/]*\.ts$|\/src$/.test(p) });
  return t;
}
const edit = (path: string, f: (s: string) => string) => writeFileSync(path, f(readFileSync(path, "utf-8")));

test("the real tree is clean: every rule is cited and tested, every interpreter function cites a rule or is allowlisted", () => {
  const r = trace(real);
  expect(r.problems).toEqual([]);
  expect(r.rules.length).toBeGreaterThan(80);
  expect(r.fns.length).toBeGreaterThan(200);
});

test("planted gap: a rule in the doc that no function cites and no test covers fails (a) and (c)", () => {
  const t = copyTree();
  edit(t.doc, s => s.replace("| R-SYS-EXIT |", "| R-FAKE-RULE | A rule nothing implements. |\n| R-SYS-EXIT |"));
  const p = trace(t).problems;
  expect(p.some(x => x.startsWith("(a)") && x.includes("R-FAKE-RULE"))).toBe(true);
  expect(p.some(x => x.startsWith("(c)") && x.includes("R-FAKE-RULE"))).toBe(true);
});

test("planted gap: removing every citation of a rule from the code fails (a), and the function left bare fails (b)", () => {
  const t = copyTree();
  edit(join(t.srcDir, "interp-sys.ts"), s => s.split("R-SYS-RANDOM").join(""));
  const p = trace(t).problems;
  expect(p.some(x => x.startsWith("(a)") && x.includes("R-SYS-RANDOM"))).toBe(true);
  expect(p.some(x => x.startsWith("(b)") && x.includes("randomBytes"))).toBe(true);
});

test("planted gap: a new interpreter function with no citation fails (b)", () => {
  const t = copyTree();
  edit(join(t.srcDir, "interp-values.ts"), s => s + "\nexport function newSemantics(x: number): number {\n  return x + 1;\n}\n");
  expect(trace(t).problems.some(x => x.startsWith("(b)") && x.includes("newSemantics"))).toBe(true);
});

test("planted gap: a citation of a rule the doc does not define fails (d)", () => {
  const t = copyTree();
  edit(join(t.srcDir, "interp-values.ts"), s => s + "\n// R-NOT-A-RULE\nexport function typo(x: number): number {\n  return x;\n}\n");
  expect(trace(t).problems.some(x => x.startsWith("(d)") && x.includes("R-NOT-A-RULE"))).toBe(true);
});

test("planted gap: a rule whose test tag is removed fails (c)", () => {
  const t = copyTree();
  edit(t.testFiles[0]!, s => s.split("R-ATOMIC and R-WG").join("atomics and wait groups"));
  const p = trace(t).problems.filter(x => x.startsWith("(c)"));
  expect(p.some(x => x.includes("R-ATOMIC"))).toBe(true);
  expect(p.some(x => x.includes("R-WG"))).toBe(true);
});

test("an allowlist entry without a reason, or naming no function, fails (b)", () => {
  expect(trace({ ...real, allow: { "interp.ts:unsupported": " " } }).problems.some(x => x.includes("has no reason"))).toBe(true);
  expect(trace({ ...real, allow: { "interp.ts:noSuchFunction": "x" } }).problems.some(x => x.includes("stale"))).toBe(true);
});

test("the parsers see what they should", () => {
  expect(parseRules("[E-COPY]  x\n| T-LET, T-MOVED | y |\n| not a rule | z |\n").sort()).toEqual(["E-COPY", "T-LET", "T-MOVED"]);
  expect(testTitles("test(\"R-A: x\", () => {})\n  test(`R-B and R-C: y`, () => {})\n").join("|")).toBe("R-A: x|R-B and R-C: y");
  const fns = parseFns("x.ts", "export class C {\n  // R-MEM-OOB\n  a(): void {\n  }\n  b(): void {\n    // [E-COPY]\n  }\n}\nfunction c() {\n}\n");
  expect(fns.filter(f => f.name !== MODULE).map(f => [f.name, f.ids.join()])).toEqual([["a", "R-MEM-OOB"], ["b", "E-COPY"], ["c", ""]]);
  expect(readdirSync(real.srcDir).filter(f => /^interp.*\.ts$/.test(f)).length).toBeGreaterThan(8);
});
