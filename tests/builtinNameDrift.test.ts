// Gate: the builtin function names written by hand in the checker, the interpreter
// (src/interp-natives.ts) and codegen (src/mlir-ctx.ts) must agree. Nothing else
// compares these lists, so a builtin added in one place silently fails in the others.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { BUILTIN_FNS, NATIVES } from "../src/interp-natives";
import { BUILTINS } from "../src/mlir-ctx";

function checkerNames(): Set<string> {
  const src = "fn main() {}";
  const checker = new TypeChecker({ denied: new Set(), allowed: new Set() });
  checker.check(new Parser(new Lexer(src).tokenize(), src).parse());
  // Option/Result/Heap ride along in the same set as builtin TYPES.
  return new Set([...checker.builtinNames].filter(n => !["Option", "Result", "Heap"].includes(n)));
}

// isNull is typed specially in the checker's call path and never registered in `functions`.
const CHECKER_SPECIAL_CASES = new Set(["isNull"]);
// Checker-registered intrinsics with no interpreter native (src/interp-natives.ts): the
// interpreter does not implement them. Implementing one must remove it here.
const INTERP_MISSING_INTRINSICS = ["_callClosureVoid", "_panicHookSet", "_schedulerGet", "_schedulerSet"];

const pub = (s: Iterable<string>) => [...s].filter(n => !n.startsWith("_")).sort();
const under = (s: Iterable<string>) => [...s].filter(n => n.startsWith("_")).sort();

const checker = checkerNames();
const interp = new Set(BUILTIN_FNS);
const interpNatives = new Set(NATIVES.keys());
const codegen = new Set(BUILTINS);

test("lists are non-empty", () => {
  expect(pub(checker).length).toBeGreaterThanOrEqual(9);
  expect(under(checker).length).toBeGreaterThan(0);
  expect(interp.size).toBeGreaterThan(0);
  expect(codegen.size).toBeGreaterThan(0);
});

test("every public checker builtin is known to the interpreter and codegen", () => {
  const problems: string[] = [];
  for (const n of pub(checker)) {
    if (!interp.has(n)) problems.push(`'${n}' is registered by the checker but missing from BUILTIN_FNS in src/interp-natives.ts`);
    if (!codegen.has(n)) problems.push(`'${n}' is registered by the checker but missing from BUILTINS in src/mlir-ctx.ts`);
  }
  expect(problems).toEqual([]);
});

test("every public interpreter and codegen builtin is registered by the checker", () => {
  const problems: string[] = [];
  for (const n of pub(interp)) {
    if (!checker.has(n) && !CHECKER_SPECIAL_CASES.has(n)) problems.push(`'${n}' is in BUILTIN_FNS (src/interp-natives.ts) but the checker does not register it (src/checker.ts)`);
  }
  for (const n of pub(codegen)) {
    if (!checker.has(n)) problems.push(`'${n}' is in BUILTINS (src/mlir-ctx.ts) but the checker does not register it (src/checker.ts)`);
  }
  expect(problems).toEqual([]);
});

test("every underscore intrinsic of the checker is known to codegen, and codegen has no extras", () => {
  const problems: string[] = [];
  for (const n of under(checker)) {
    if (!codegen.has(n)) problems.push(`'${n}' is registered by the checker but missing from BUILTINS in src/mlir-ctx.ts`);
  }
  for (const n of under(codegen)) {
    if (!checker.has(n)) problems.push(`'${n}' is in BUILTINS (src/mlir-ctx.ts) but the checker does not register it (src/checker.ts)`);
  }
  expect(problems).toEqual([]);
});

test("interpreter natives cover the checker intrinsics except the known gaps", () => {
  const missing = under(checker).filter(n => !interpNatives.has(n));
  expect(missing).toEqual(INTERP_MISSING_INTRINSICS);
});
