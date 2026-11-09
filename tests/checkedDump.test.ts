// The checked-program dump codec (src/checked-dump.ts): what must survive encode + decode for
// the emitter to read a foreign checker's facts.
import { expect, test } from "bun:test";
import { decodeChecked, encodeChecked } from "../src/checked-dump";

const trip = <T>(v: T): T => decodeChecked(encodeChecked(v)) as T;

test("a node keying a Map is the same object as the one in the tree", () => {
  const node = { kind: "Ident", name: "x" };
  const out = trip({ body: [node], types: new Map([[node, "i64"]]), moved: new Set([node]) });
  expect(out.types.get(out.body[0])).toBe("i64");
  expect(out.moved.has(out.body[0])).toBe(true);
});

test("a key seen before its tree position still resolves to one object", () => {
  const node = { kind: "Ident" };
  const out = trip({ types: new Map([[node, 1]]), body: [node] });
  expect(out.types.get(out.body[0])).toBe(1);
});

test("two equal but distinct nodes stay distinct", () => {
  const a = { kind: "Ident", name: "x" }, b = { kind: "Ident", name: "x" };
  const out = trip({ body: [a, b], types: new Map([[a, "i64"], [b, "f64"]]) });
  expect(out.body[0]).not.toBe(out.body[1]);
  expect(out.types.get(out.body[1])).toBe("f64");
});

test("cycles, shared arrays and shared maps keep their shape", () => {
  const decl: any = { name: "S", methods: [] };
  decl.methods.push({ owner: decl });
  const shared = [1, 2];
  const m = new Map([["k", 1]]);
  const out = trip({ decl, a: shared, b: shared, m1: m, m2: m });
  expect(out.decl.methods[0].owner).toBe(out.decl);
  expect(out.a).toBe(out.b);
  expect(out.a).toEqual([1, 2]);
  expect(out.m1).toBe(out.m2);
});

test("values JSON cannot spell", () => {
  const out = trip({ big: 18446744073709551615n, nz: -0, nan: NaN, inf: -Infinity, arr: [undefined, null], m: new Map([["k", undefined]]), gone: undefined });
  expect(out.big).toBe(18446744073709551615n);
  expect(Object.is(out.nz, -0)).toBe(true);
  expect(out.nan).toBeNaN();
  expect(out.inf).toBe(-Infinity);
  expect(out.arr).toEqual([undefined, null]);
  expect(out.arr[1]).toBeNull();
  expect(out.m.has("k")).toBe(true);
  expect("gone" in out).toBe(false);
});

test("map and set order is insertion order", () => {
  const out = trip({ m: new Map([["b", 1], ["a", 2]]), s: new Set([3, 1, 2]) });
  expect([...out.m.keys()]).toEqual(["b", "a"]);
  expect([...out.s]).toEqual([3, 1, 2]);
});

test("a repeated full value with a known $id decodes to the first one", () => {
  const out = decodeChecked('{"body":[{"$id":7,"kind":"Ident"}],"types":{"$map":[[{"$id":7,"kind":"Ident"},"i64"]]}}') as any;
  expect(out.types.get(out.body[0])).toBe("i64");
});

test("a class instance or a forward $ref is refused", () => {
  class C { x = 1; }
  expect(() => encodeChecked({ c: new C() })).toThrow("cannot encode a C instance");
  expect(() => decodeChecked('{"a":{"$ref":3}}')).toThrow("$ref 3 before its $id");
});
