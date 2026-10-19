// src/ir.ts: the text backend's invariant checks, and that it prints today's spelling.
import { test, expect, describe } from "bun:test";
import { LlvmTextBuilder, Ty, val } from "../src/ir";

function builder(lines: string[] = [], entryAllocas?: string[]) {
  let t = 0, l = 0;
  return new LlvmTextBuilder(lines, { nextTemp: () => `%t.${t++}`, nextLabel: (p = "L") => `${p}${l++}`, entryAllocas });
}

describe("LlvmTextBuilder invariants", () => {
  test("switch prints both spellings, ends the block, and rejects bad scrutinees and cases", () => {
    const one: string[] = [];
    const b = builder(one);
    const [d, x, y] = [b.newBlock("d"), b.newBlock("x"), b.newBlock("y")];
    b.switch(val("%tag", Ty.i32), d, [[0, x], [2, y]]);
    expect(one).toEqual(["  switch i32 %tag, label %d0 [i32 0, label %x1 i32 2, label %y2]"]);
    expect(() => b.binop("add", val("1", Ty.i64), val("2", Ty.i64))).toThrow("after terminator");

    const multi: string[] = [];
    const m = builder(multi);
    const [md, mx] = [m.newBlock("d"), m.newBlock("x")];
    m.switch(val("%tag", Ty.i32), md, [[1, mx]], true);
    expect(multi).toEqual(["  switch i32 %tag, label %d0 [", "    i32 1, label %x1", "  ]"]);
    expect(() => m.br(md)).toThrow("after terminator");

    const c = builder();
    const cd = c.newBlock("d");
    expect(() => c.switch(val("%p", Ty.ptr), cd, [])).toThrow("non-integer");
    expect(() => c.switch(val("%t", Ty.i32), cd, [[1, cd], [1, cd]])).toThrow("appears twice");
    expect(() => c.switch(val("%t", Ty.i32), cd, [[1.5, cd]])).toThrow("not an integer");
    // bigint cases print exactly past 2^53, and 1 and 1n are the same case
    const big: string[] = [];
    const g = builder(big);
    const [gd, gx] = [g.newBlock("d"), g.newBlock("x")];
    g.switch(val("%v", Ty.i64), gd, [[9007199254740993n, gx]]);
    expect(big).toEqual(["  switch i64 %v, label %d0 [i64 9007199254740993, label %x1]"]);
    expect(() => c.switch(val("%t", Ty.i32), cd, [[1, cd], [1n, cd]])).toThrow("appears twice");
  });

  test("entryAlloca writes to the entry block, not the body, and checks its slot", () => {
    const body: string[] = [], entry: string[] = [];
    const b = builder(body, entry);
    const p = b.entryAlloca("%x.addr", Ty.i64);
    expect(p).toEqual(val("%x.addr", Ty.ptr));
    b.entryAlloca("%alive.1.addr", Ty.i1, val("0", Ty.i1));
    expect(entry).toEqual(["  %x.addr = alloca i64", "  %alive.1.addr = alloca i1", "  store i1 0, ptr %alive.1.addr"]);
    expect(body).toEqual([]);
    expect(() => b.entryAlloca("%x.addr", Ty.i64)).toThrow("already defined");
    expect(() => b.entryAlloca("%t.3", Ty.i64)).toThrow("not a named local");
    expect(() => b.entryAlloca("x.addr", Ty.i64)).toThrow("not a named local");
    expect(() => b.entryAlloca("%v.addr", Ty.void)).toThrow("of void");
    expect(() => b.entryAlloca("%y.addr", Ty.i64, val("0", Ty.i1))).toThrow("initialized with");
    expect(() => builder().entryAlloca("%z.addr", Ty.i64)).toThrow("no function entry block");
  });

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
    expect(() => b.select(val("%c", Ty.i8), val("1", Ty.i64), val("2", Ty.i64))).toThrow("not i1");
    expect(() => b.select(val("%c", Ty.i1), val("1", Ty.i64), val("2", Ty.i32))).toThrow("operand types differ");
    expect(() => b.select(val("%c", Ty.i1), val("%a", Ty.void), val("%b", Ty.void))).toThrow("select of void");
  });

  test("load align and atomic acquire load check type, pointer and alignment", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const p = val("%p", Ty.ptr);
    b.load(Ty.i64, p, 8);
    b.loadAcquire(Ty.i64, p, 8);
    expect(lines).toEqual(["  %t.0 = load i64, ptr %p, align 8", "  %t.1 = load atomic i64, ptr %p acquire, align 8"]);
    expect(() => b.load(Ty.i64, p, 3)).toThrow("not a power of two");
    expect(() => b.load(Ty.i64, p, 0)).toThrow("not a power of two");
    expect(() => b.loadAcquire(Ty.i64, p, 6)).toThrow("not a power of two");
    expect(() => b.loadAcquire(Ty.i64, val("%x", Ty.i64), 8)).toThrow("non-pointer");
    expect(() => b.loadAcquire(Ty.void, p, 8)).toThrow("atomic load of void");
    expect(() => b.loadAcquire(Ty.of("%String"), p, 8)).toThrow("atomic load of %String");
  });

  test("ret prints its operand, rejects a void value, and terminates the block", () => {
    const lines: string[] = [];
    const b = builder(lines);
    b.ret();
    expect(lines).toEqual(["  ret void"]);
    expect(() => b.ret()).toThrow("after terminator");
    expect(() => b.alloca(Ty.i64)).toThrow("after terminator");
    const l2: string[] = [];
    const b2 = builder(l2);
    b2.ret(val("%t.0", Ty.i32));
    expect(l2).toEqual(["  ret i32 %t.0"]);
    expect(() => builder().ret(val("%v", Ty.void))).toThrow("ret of void");
  });

  test("defineFn prints the header and entry label, endFn closes only a terminated block", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const [s, n] = b.defineFn({ name: "f", ret: Ty.i32, internal: true, dbg: 7, params: [{ name: "s", ty: Ty.ptr, attrs: " noalias" }, { name: "n", ty: Ty.i64 }] });
    expect(s).toEqual(val("%s", Ty.ptr));
    expect(n).toEqual(val("%n", Ty.i64));
    expect(() => b.endFn()).toThrow("does not end in a terminator");
    b.ret(val("0", Ty.i32));
    b.endFn();
    expect(lines).toEqual(["define internal i32 @f(ptr noalias %s, i64 %n) !dbg !7 {", "entry.bb:", "  ret i32 0", "}"]);
    expect(() => b.endFn()).toThrow("no open function");
    expect(() => b.defineFn({ name: "g", ret: Ty.void, params: [] })).toThrow("already closed its function");

    // a label with nothing after it is an empty, unterminated block
    const e = builder();
    e.defineFn({ name: "e", ret: Ty.void, params: [] });
    e.position(e.newBlock("x"));
    expect(() => e.endFn()).toThrow("does not end in a terminator");

    const a: string[] = [];
    builder(a).defineFn({ name: "fail", ret: Ty.void, internal: true, attrs: " noreturn cold noinline", dbg: 3, params: [{ name: "line", ty: Ty.i32 }] });
    expect(a[0]).toBe("define internal void @fail(i32 %line) noreturn cold noinline !dbg !3 {");
    expect(() => builder().defineFn({ name: "d", ret: Ty.void, params: [{ name: "a", ty: Ty.i32 }, { name: "a", ty: Ty.i32 }] })).toThrow("appears twice");
    expect(() => builder().defineFn({ name: "v", ret: Ty.void, params: [{ name: "a", ty: Ty.void }] })).toThrow("is void");
    expect(() => builder().endFn()).toThrow("no open function");
  });

  test("unreachable terminates the block", () => {
    const lines: string[] = [];
    const b = builder(lines);
    b.unreachable();
    expect(lines).toEqual(["  unreachable"]);
    expect(() => b.unreachable()).toThrow("after terminator");
    expect(() => b.alloca(Ty.i64)).toThrow("after terminator");
  });

  test("phi checks incoming types and can print the padded spelling", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const a = b.newBlock("a"), c = b.newBlock("c");
    expect(() => b.phi(Ty.void, [])).toThrow("phi of void");
    expect(() => b.phi(Ty.ptr, [[val("1", Ty.i64), a]])).toThrow("incoming 1 is i64");
    b.phi(Ty.ptr, [[val("%x", Ty.ptr), a], [val("%y", Ty.ptr), c]], true);
    expect(lines).toEqual(["  %t.0 = phi ptr [ %x, %a0 ], [ %y, %c1 ]"]);
  });

  test("phi and insertvalue define a reserved name and check its type", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const a = b.newBlock("a");
    const i = b.reserveNamed("%i", Ty.i64);
    b.phi(Ty.i64, [[val("0", Ty.i64), a], [i, a]], false, i);
    const s = b.reserveTemp(Ty.of("%String"));
    b.insertvalue(val("undef", Ty.of("%String")), val("null", Ty.ptr), 0, s);
    expect(lines).toEqual([
      "  %i = phi i64 [0, %a0], [%i, %a0]",
      "  %t.0 = insertvalue %String undef, ptr null, 0",
    ]);
    expect(() => b.phi(Ty.i64, [], false, b.reserveNamed("%j", Ty.i32))).toThrow("but the result is i64");
    expect(() => b.insertvalue(val("undef", Ty.of("%String")), val("null", Ty.ptr), 0, val("%t.9", Ty.of("%String")))).toThrow("not a reserved temp");
  });

  test("fcmp needs matching float operands", () => {
    const b = builder();
    expect(() => b.fcmp("ogt", val("%a", Ty.i64), val("%b", Ty.i64))).toThrow("non-float");
    expect(() => b.fcmp("ogt", val("%a", Ty.of("double")), val("%b", Ty.of("float")))).toThrow("operand types differ");
    const lines: string[] = [];
    const r = builder(lines).fcmp("ogt", val("%a", Ty.of("double")), val("%b", Ty.of("double")));
    expect(r.ty.ll).toBe("i1");
    expect(lines).toEqual(["  %t.0 = fcmp ogt double %a, %b"]);
  });

  test("named alloca prints the given slot and draws no temp; icmp/fcmp can define a reserved temp", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const a = b.alloca(Ty.ptr, "%x.3.addr");
    expect(a).toEqual({ ref: "%x.3.addr", ty: Ty.ptr });
    expect(() => b.alloca(Ty.void, "%y")).toThrow("alloca of void");
    expect(() => b.alloca(Ty.i64, "x")).toThrow("not a named local");
    expect(() => b.alloca(Ty.i64, "%t.5")).toThrow("not a named local");
    const r = b.reserveTemp(Ty.i1);
    const n = b.alloca(Ty.i64);
    expect(n.ref).toBe("%t.1");
    expect(b.icmp("eq", val("%a", Ty.i32), val("3", Ty.i32), r)).toBe(r);
    expect(() => b.icmp("eq", val("%a", Ty.i32), val("3", Ty.i32), r)).toThrow("not a reserved temp");
    expect(() => b.fcmp("oeq", val("%a", Ty.of("double")), val("1.0", Ty.of("double")), val("%nope", Ty.i1))).toThrow("not a reserved temp");
    const r8 = b.reserveTemp(Ty.i8);
    expect(() => b.icmp("eq", val("%a", Ty.i32), val("3", Ty.i32), r8)).toThrow("but the result is i1");
    const f = b.reserveTemp(Ty.i1);
    b.fcmp("oeq", val("%d", Ty.of("double")), val("1.0", Ty.of("double")), f);
    expect(lines).toEqual(["  %x.3.addr = alloca ptr", "  %t.1 = alloca i64", "  %t.0 = icmp eq i32 %a, 3", `  ${f.ref} = fcmp oeq double %d, 1.0`]);
  });

  test("call into a reserved temp keeps the early name, once, with matching type", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const env = val("%env", Ty.ptr);
    expect(() => b.call(Ty.i1, "%f", [env], val("%nope", Ty.i1))).toThrow("not a reserved temp");
    const d = b.reserveTemp(Ty.i1);
    expect(() => b.call(Ty.i64, "%f", [env], d)).toThrow("but the result is i64");
    const load = b.load(Ty.i64, val("%p", Ty.ptr));
    b.call(Ty.i1, "%f", [env, load], d);
    expect(() => b.call(Ty.i1, "%f", [env], d)).toThrow("not a reserved temp");
    expect(() => b.call(Ty.void, "%f", [env], d)).toThrow("returns void");
    expect(lines).toEqual(["  %t.1 = load i64, ptr %p", "  %t.0 = call i1 %f(ptr %env, i64 %t.1)"]);
  });

  test("fadd takes float operands only, of one type", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const d = Ty.of("double");
    expect(() => b.binop("fadd", val("%a", Ty.i64), val("%b", Ty.i64))).toThrow("fadd on non-float");
    expect(() => b.binop("fadd", val("%a", d), val("%b", Ty.of("float")))).toThrow("operand types differ");
    b.binop("fadd", val("%a", d), val("%b", d));
    expect(lines).toEqual(["  %t.0 = fadd double %a, %b"]);
  });

  test("integer binops take integer operands only", () => {
    const b = builder([]);
    const d = Ty.of("double");
    expect(() => b.binop("add", val("%a", d), val("%b", d))).toThrow("add on non-integer");
    expect(() => b.binop("mul", val("%a", Ty.ptr), val("%b", Ty.ptr))).toThrow("mul on non-integer");
  });

  test("binop into a reserved temp keeps the early name, once, with matching type", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const x = val("%x", Ty.i1), y = val("%y", Ty.i1);
    expect(() => b.binop("and", x, y, val("%nope", Ty.i1))).toThrow("not a reserved temp");
    const d = b.reserveTemp(Ty.i1);
    expect(() => b.binop("and", x, y, { ref: d.ref, ty: Ty.i8 })).toThrow("but the result is i1");
    b.binop("and", x, y, d);
    expect(() => b.binop("and", x, y, d)).toThrow("not a reserved temp");
    expect(() => b.binop("and", x, val("%z", Ty.i8))).toThrow("operand types differ");
    expect(lines).toEqual(["  %t.0 = and i1 %x, %y"]);
  });

  test("load and gep into a reserved temp keep the early name, once, with matching type", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const p = val("%p", Ty.ptr);
    expect(() => b.load(Ty.i64, p, undefined, undefined, val("%nope", Ty.i64))).toThrow("not a reserved temp");
    expect(() => b.gep(Ty.i8, p, [val("0", Ty.i64)], val("%nope", Ty.ptr))).toThrow("not a reserved temp");
    const l = b.reserveTemp(Ty.i64);
    const g = b.reserveTemp(Ty.ptr);
    expect(() => b.load(Ty.i32, p, undefined, undefined, l)).toThrow("but the result is i32");
    expect(() => b.gep(Ty.i8, p, [val("0", Ty.i64)], { ref: g.ref, ty: Ty.i64 })).toThrow("but the result is ptr");
    b.gep(Ty.i8, p, [val("0", Ty.i64)], g);
    b.load(Ty.i64, g, undefined, undefined, l);
    expect(() => b.load(Ty.i64, p, undefined, undefined, l)).toThrow("not a reserved temp");
    expect(() => b.gep(Ty.i8, p, [val("0", Ty.i64)], g)).toThrow("not a reserved temp");
    expect(lines).toEqual(["  %t.1 = getelementptr i8, ptr %p, i64 0", "  %t.0 = load i64, ptr %t.1"]);
  });

  test("select into a reserved temp keeps the early name, once, with matching type", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const c = val("%c", Ty.i1), x = val("%x", Ty.i64), y = val("%y", Ty.i64);
    expect(() => b.select(c, x, y, val("%nope", Ty.i64))).toThrow("not a reserved temp");
    expect(() => b.reserveTemp(Ty.void)).toThrow("reserveTemp of void");
    const d = b.reserveTemp(Ty.i64);
    const other = b.icmp("ult", x, y);
    expect(() => b.select(c, x, y, { ref: d.ref, ty: Ty.i32 })).toThrow("operands are i64");
    b.select(c, x, y, d);
    expect(() => b.select(c, x, y, d)).toThrow("not a reserved temp");
    expect(other.ref).toBe("%t.1");
    expect(lines).toEqual(["  %t.1 = icmp ult i64 %x, %y", "  %t.0 = select i1 %c, i64 %x, i64 %y"]);
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
  b.select(r, x, val("-1", Ty.i64));
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
    "  %t.5 = select i1 %t.4, i64 %t.1, i64 -1",
    "  %t.6 = insertvalue %HashMap undef, i1 %t.4, 3",
    "  %t.7 = extractvalue %HashMap %t.6, 3",
  ]);
});

test("load prints range metadata after align, and only for integer loads", () => {
  const lines: string[] = [];
  const b = builder(lines);
  const p = val("%p", Ty.ptr);
  b.load(Ty.i8, p, undefined, { range: 4, noundef: 5 });
  b.load(Ty.i32, p, 4, { range: 6, noundef: 7 });
  expect(lines).toEqual(["  %t.0 = load i8, ptr %p, !range !4, !noundef !5", "  %t.1 = load i32, ptr %p, align 4, !range !6, !noundef !7"]);
  expect(() => b.load(Ty.ptr, p, undefined, { range: 1, noundef: 2 })).toThrow("only integer loads");
  expect(() => b.load(Ty.of("%String"), p, undefined, { range: 1, noundef: 2 })).toThrow("only integer loads");
});

describe("named locals and atomics", () => {
  test("reserveNamed draws no temp, defines a fixed name once, and rejects temp-shaped or repeated names", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const p = val("%p", Ty.ptr);
    const old = b.load(Ty.i64, p, 8, undefined, b.reserveNamed("%old", Ty.i64));
    expect(old.ref).toBe("%old");
    expect(b.load(Ty.i64, p).ref).toBe("%t.0");
    expect(lines).toEqual(["  %old = load i64, ptr %p, align 8", "  %t.0 = load i64, ptr %p"]);
    expect(() => b.reserveNamed("%old", Ty.i64)).toThrow("already reserved");
    expect(() => b.reserveNamed("%t.5", Ty.i64)).toThrow("not a named local");
    expect(() => b.reserveNamed("old", Ty.i64)).toThrow("not a named local");
    expect(() => b.reserveNamed("%v", Ty.void)).toThrow("of void");
    const r = b.reserveNamed("%wrong", Ty.i32);
    expect(() => b.load(Ty.i64, p, 8, undefined, r)).toThrow("but the result is i64");
  });

  test("cast and extractvalue define into a reserved name", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const a = b.cast("ptrtoint", val("@g", Ty.ptr), Ty.i64, b.reserveNamed("%a", Ty.i64));
    const w = b.extractvalue(val("%pair", Ty.of("{ i64, i1 }")), 1, Ty.i1, b.reserveNamed("%won", Ty.i1));
    expect([a.ref, w.ref]).toEqual(["%a", "%won"]);
    expect(lines).toEqual(["  %a = ptrtoint ptr @g to i64", "  %won = extractvalue { i64, i1 } %pair, 1"]);
    expect(() => b.cast("zext", val("%x", Ty.i1), Ty.i64, val("%t.9", Ty.i64))).toThrow("not a reserved temp");
  });

  test("store align, release store and cmpxchg print atomic spellings and check operands", () => {
    const lines: string[] = [];
    const b = builder(lines);
    const p = val("%p", Ty.ptr);
    const [z, one] = [val("0", Ty.i64), val("1", Ty.i64)];
    b.store(one, p, 8);
    b.storeRelease(one, p, 8);
    const pair = b.cmpxchg(p, z, one, 8, b.reserveNamed("%pair", Ty.of("{ i64, i1 }")));
    expect(pair.ty.ll).toBe("{ i64, i1 }");
    b.loadAcquire(Ty.i64, p, 8, b.reserveNamed("%o", Ty.i64));
    expect(lines).toEqual([
      "  store i64 1, ptr %p, align 8",
      "  store atomic i64 1, ptr %p release, align 8",
      "  %pair = cmpxchg ptr %p, i64 0, i64 1 acq_rel acquire, align 8",
      "  %o = load atomic i64, ptr %p acquire, align 8",
    ]);
    expect(() => b.store(one, p, 3)).toThrow("not a power of two");
    expect(() => b.storeRelease(one, p, 6)).toThrow("not a power of two");
    expect(() => b.storeRelease(one, one, 8)).toThrow("non-pointer");
    expect(() => b.storeRelease(val("%s", Ty.of("%String")), p, 8)).toThrow("atomic store of %String");
    expect(() => b.storeRelease(val("%v", Ty.void), p, 8)).toThrow("atomic store of void");
    expect(() => b.cmpxchg(one, z, one, 8)).toThrow("non-pointer");
    expect(() => b.cmpxchg(p, z, one, 3)).toThrow("not a power of two");
    expect(() => b.cmpxchg(p, z, val("1", Ty.i32), 8)).toThrow("operand types differ");
    expect(() => b.cmpxchg(p, val("%s", Ty.of("%String")), val("%u", Ty.of("%String")), 8)).toThrow("cmpxchg of %String");
  });
});
