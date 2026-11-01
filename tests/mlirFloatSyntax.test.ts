// src/mlir-backend.ts rewrites LLVM 23's float constant spellings into the classic hex form
// older clangs parse. Each expectation is what LLVM itself prints for the same bits in the
// classic syntax, so a wrong NaN payload or a lost sign shows up as a value change here.
import { test, expect } from "bun:test";
import { oldFloatSyntax } from "../src/mlir-backend";

const cases: [string, string][] = [
  ["store double +inf, ptr %p", "store double 0x7FF0000000000000, ptr %p"],
  ["store double -inf, ptr %p", "store double 0xFFF0000000000000, ptr %p"],
  ["store double +qnan, ptr %p", "store double 0x7FF8000000000000, ptr %p"],
  ["store double -qnan, ptr %p", "store double 0xFFF8000000000000, ptr %p"],
  ["store double +nan(0x1), ptr %p", "store double 0x7FF8000000000001, ptr %p"],
  ["store double +snan(0x1), ptr %p", "store double 0x7FF0000000000001, ptr %p"],
  ["store double f0x400921FB54442D18, ptr %p", "store double 0x400921FB54442D18, ptr %p"],
  ["store float +inf, ptr %p", "store float 0x7FF0000000000000, ptr %p"],
  ["store float f0x40490FDB, ptr %p", "store float 0x400921FB60000000, ptr %p"],
  ["store float -nan(0x1), ptr %p", "store float 0xFFF8000020000000, ptr %p"],
  ["store float 1.401300e-45, ptr %p", "store float 0x36A0000000000000, ptr %p"],
  ["%3 = fcmp oeq double %0, +inf", "%3 = fcmp oeq double %0, 0x7FF0000000000000"],
  // Untouched: exact decimals, and names that merely contain the words.
  ["store double 1.500000e+00, ptr %p", "store double 1.500000e+00, ptr %p"],
  ["store float 2.500000e-01, ptr %p", "store float 2.500000e-01, ptr %p"],
  ["call void @inf.nan(ptr %qnan)", "call void @inf.nan(ptr %qnan)"],
];

for (const [input, want] of cases) {
  test(input, () => expect(oldFloatSyntax(input)).toBe(want));
}

test("a NaN payload with no single float type on the line is an error", () => {
  expect(() => oldFloatSyntax("%x = fpext float +nan(0x1) to double")).toThrow();
});
