// Unit tests for the large-stack-array lint. A fixed-size local array is a stack
// allocation of its full size up front; big ones silently overflow the stack at
// runtime (the same trap Rust's `[T; N]` has). OFF by default (intentional
// main-thread framebuffers shouldn't nag) — opt in via `--deny=large-stack-array`.
// Default threshold 512 KiB, tunable with `--max-stack-array`.
import { test, expect } from "bun:test";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

// Opt the lint in (denied → the checker won't self-suppress it). Message text is
// identical whether it lands as warning or error, and we filter by code.
function lint(src: string, maxStackArrayBytes?: number): string[] {
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const cfg = { denied: new Set(["large-stack-array"]), allowed: new Set<string>(), maxStackArrayBytes };
  return new TypeChecker(cfg).check(prog).diagnostics
    .filter(d => d.code === "large-stack-array")
    .map(d => d.message);
}

test("off by default — no opt-in, no diagnostic", () => {
  const src = `fn main() {\n  var fb: [u32; 172800] = [0; 172800]\n  print(fb[0] as i64)\n}\n`;
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const out = new TypeChecker().check(prog).diagnostics.filter(d => d.code === "large-stack-array");
  expect(out).toEqual([]);
});

test("flags a local fixed array over the 512 KiB default", () => {
  // [u32; 172800] = 691,200 bytes ≈ 675 KiB.
  const out = lint(`fn main() {\n  var fb: [u32; 172800] = [0; 172800]\n  print(fb[0] as i64)\n}\n`);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("'fb'");
  expect(out[0]).toContain("675 KiB");
});

test("does not flag an array under the default threshold", () => {
  // [u8; 100000] ≈ 98 KiB — well under 512 KiB.
  const out = lint(`fn main() {\n  let buf: [u8; 100000] = [0; 100000]\n  print(buf[0] as i64)\n}\n`);
  expect(out).toEqual([]);
});

test("does not flag a small fixed array", () => {
  const out = lint(`fn main() {\n  var ev: [u8; 64] = [0; 64]\n  print(ev[0] as i64)\n}\n`);
  expect(out).toEqual([]);
});

test("--max-stack-array lowers the threshold to catch smaller arrays", () => {
  // [u8; 100000] ≈ 98 KiB: under the 512 KiB default, over a 64 KiB threshold.
  const src = `fn main() {\n  let buf: [u8; 100000] = [0; 100000]\n  print(buf[0] as i64)\n}\n`;
  expect(lint(src)).toEqual([]);
  const out = lint(src, 64 * 1024);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("98 KiB");
});

test("fires on `let` bindings too, not just `var`", () => {
  const out = lint(`fn main() {\n  let buf: [u32; 200000] = [0; 200000]\n  print(buf[0] as i64)\n}\n`);
  expect(out.length).toBe(1); // 800,000 bytes ≈ 781 KiB
});

test("still suppressible with --allow even when denied elsewhere", () => {
  const src = `fn main() {\n  var fb: [u32; 172800] = [0; 172800]\n  print(fb[0] as i64)\n}\n`;
  const prog = new Parser(new Lexer(src).tokenize(), src).parse();
  const cfg = { denied: new Set(["large-stack-array"]), allowed: new Set(["large-stack-array"]) };
  const out = new TypeChecker(cfg).check(prog).diagnostics.filter(d => d.code === "large-stack-array");
  expect(out).toEqual([]);
});
