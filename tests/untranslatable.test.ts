// The SMT translator emits an `UNSUPPORTED` marker for constructs it has no rule for.
// That marker is what keeps the prover SOUND — it poisons the formula so nothing is
// proven by accident — but it then reaches the solver as an undeclared symbol, and both
// backends used to blame themselves: std/smt reported "outside linear fragment" for a
// perfectly linear contract, z3 emitted a parse error naming a constant the user never
// wrote. Neither named the real cause.
//
// The discrimination is the point: a genuinely nonlinear contract must STILL report
// nonlinearity. Relabelling everything would just move the lie.
import { test, expect } from "bun:test";
import { untranslatable } from "../src/verify";

test("names the expression kind the translator lacks a rule for", () => {
  expect(untranslatable("(assert (= result (UNSUPPORTED IfExpr)))")).toEqual(["IfExpr expressions"]);
});

test("names an unsupported unary operator", () => {
  expect(untranslatable("(assert (UNSUPPORTED_UNARY ~))")).toEqual(["unary '~'"]);
});

test("names an unsupported binary operator", () => {
  expect(untranslatable("(assert (UNSUPPORTED_OP_>>> a b))")).toEqual(["operator '>>>'"]);
});

test("reports each distinct cause once, not per occurrence", () => {
  const smt = "(UNSUPPORTED IfExpr) (UNSUPPORTED IfExpr) (UNSUPPORTED MatchExpr)";
  expect(untranslatable(smt).sort()).toEqual(["IfExpr expressions", "MatchExpr expressions"]);
});

test("a translatable VC has nothing to report — including a nonlinear one", () => {
  // `(* x y)` is real nonlinearity: the solver's own limit, not a translator gap.
  // It must not be relabelled as untranslatable.
  expect(untranslatable("(assert (> (* x y) 0))")).toEqual([]);
});
