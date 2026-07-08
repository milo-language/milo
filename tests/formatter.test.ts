// Formatter (TS reference impl in src/formatter.ts). The native bin/milo-fmt is
// a separate impl kept in sync from examples/cli-tools/fmt.milo.
import { test, expect } from "bun:test";
import { format } from "../src/formatter";

test("extern fn stays on one line even when source splits them", () => {
  const src = `extern

fn read(fd: i32, buf: *u8, nbyte: i64): i64

extern
fn close(fd: i32): i32

extern fn open(path: *u8, flags: i32): i32
`;
  const out = format(src);
  expect(out).toContain("extern fn read(");
  expect(out).toContain("extern fn close(");
  expect(out).toContain("extern fn open(");
  // no `extern` left dangling on its own line before an fn
  expect(out).not.toMatch(/extern\s*\n\s*(\n\s*)?fn\b/);
});

test("formatting is idempotent for extern blocks", () => {
  const src = `extern

fn read(fd: i32): i64
`;
  const once = format(src);
  expect(format(once)).toBe(once);
});
