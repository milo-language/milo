// Unit tests for the unverified-extern lint. OFF by default and opted into with
// `--deny=unverified-extern`, because pairing an `extern struct` with a local .c peer
// (no header to name) is a legitimate FFI shape that @cLayout cannot express — this
// repo's own ABI-test fixtures do exactly that. A lint that fires on unfixable code is
// one users switch off entirely, taking the fixable cases with it.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

const CODE = "unverified-extern";

function diags(src: string, deny = true) {
  const prog = new Parser(new Lexer(src).tokenize(), src, "entry.milo").parse();
  const cfg = { denied: new Set(deny ? [CODE] : []), allowed: new Set<string>() };
  return new TypeChecker(cfg).check(prog).diagnostics;
}
const codes = (src: string, deny = true) => diags(src, deny).map(d => d.code);

test("fires on an extern struct with no @cLayout", () => {
  expect(codes(`extern struct Foo { a: i32 }`)).toContain(CODE);
});

test("silent when @cLayout pins the layout", () => {
  const src = `@cLayout("struct timespec", "time.h")\nextern struct Foo { a: i64, b: i64 }`;
  expect(codes(src)).not.toContain(CODE);
});

test("off unless denied — an unfixable local-.c-peer struct must not nag by default", () => {
  expect(codes(`extern struct Foo { a: i32 }`, false)).not.toContain(CODE);
});

test("does not fire on a plain Milo struct", () => {
  expect(codes(`struct Foo { a: i32 }`)).not.toContain(CODE);
});

test("does not fire on an opaque extern type — it has no fields to verify", () => {
  expect(codes(`extern type Handle`)).not.toContain(CODE);
});

test("denying it makes the diagnostic an error, not a warning", () => {
  const d = diags(`extern struct Foo { a: i32 }`).find(x => x.code === CODE);
  expect(d?.severity).toBe("error");
});
