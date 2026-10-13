// src/ir.ts: the text backend's invariant checks, and that it prints today's spelling.
import { test, expect, describe } from "bun:test";
import { LlvmTextBuilder, Ty, val } from "../src/ir";

function builder(lines: string[] = []) {
  let t = 0, l = 0;
  return new LlvmTextBuilder(lines, { nextTemp: () => `%t.${t++}`, nextLabel: (p = "L") => `${p}${l++}` });
}

describe("LlvmTextBuilder invariants", () => {
  test("void alloca, load and store throw", () => {
    const b = builder();
    expect(() => b.alloca(Ty.void)).toThrow("alloca of void");
    expect(() => b.load(Ty.void, val("%p", Ty.ptr))).toThrow("load of void");
    expect(() => b.store(val("%v", Ty.void), val("%p", Ty.ptr))).toThrow("store of void");
  });

  test("load, store and gep need a ptr operand", () => {
    const b = builder();
    const notPtr = val("%x", Ty.i64);
    expect(() => b.load(Ty.i64, notPtr)).toThrow("non-pointer");
    expect(() => b.store(val("1", Ty.i64), notPtr)).toThrow("non-pointer");
    expect(() => b.gep(Ty.i8, notPtr, [val("0", Ty.i64)])).toThrow("non-pointer");
  });

  test("an instruction after a terminator throws, a label reopens the block", () => {
    const b = builder();
    const next = b.newBlock("next");
    b.br(next);
    expect(() => b.binop("add", val("1", Ty.i64), val("2", Ty.i64))).toThrow("after terminator");
    b.position(next);
    expect(() => b.binop("add", val("1", Ty.i64), val("2", Ty.i64))).not.toThrow();
  });

  test("a terminator pushed by unmigrated string code is seen too", () => {
    const b = builder(["  ret void", "  ; trailing comment"]);
    expect(() => b.alloca(Ty.i64)).toThrow("after terminator");
  });

  test("operand type mismatch throws", () => {
    const b = builder();
    expect(() => b.binop("xor", val("%a", Ty.i64), val("%b", Ty.i32))).toThrow("operand types differ");
    expect(() => b.condBr(val("%c", Ty.i8), b.newBlock("t"), b.newBlock("f"))).toThrow("not i1");
  });
});

test("prints the same text the string codegen did", () => {
  const lines: string[] = [];
  const b = builder(lines);
  const p = b.alloca(Ty.i64);
  b.store(val("0", Ty.i64), p);
  const x = b.load(Ty.i64, p);
  const g = b.gep(Ty.i8, val("%s", Ty.ptr), [x]);
  const done = b.newBlock("done");
  b.condBr(b.icmp("ult", x, val("8", Ty.i64)), done, done);
  b.position(done);
  const r = b.phi(Ty.i1, [[val("true", Ty.i1), done]]);
  b.callDiscard(Ty.ptr, "@memset", [g, val("0", Ty.i32), x]);
  const m = b.insertvalue(val("undef", Ty.of("%HashMap")), r, 3);
  b.extractvalue(m, 3, Ty.i1);
  expect(lines).toEqual([
    "  %t.0 = alloca i64",
    "  store i64 0, ptr %t.0",
    "  %t.1 = load i64, ptr %t.0",
    "  %t.2 = getelementptr i8, ptr %s, i64 %t.1",
    "  %t.3 = icmp ult i64 %t.1, 8",
    "  br i1 %t.3, label %done0, label %done0",
    "done0:",
    "  %t.4 = phi i1 [true, %done0]",
    "  call ptr @memset(ptr %t.2, i32 0, i64 %t.1)",
    "  %t.5 = insertvalue %HashMap undef, i1 %t.4, 3",
    "  %t.6 = extractvalue %HashMap %t.5, 3",
  ]);
});
