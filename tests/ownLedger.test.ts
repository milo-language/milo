// The ownership-ledger verifier's copy-intent findings, each on the smallest IR that shows
// it, so a verifier change that stops reporting one goes red here rather than silently
// shrinking what `scripts/own-ledger.ts --check` can see.
import { test, expect } from "bun:test";
import { verifyOwnLedger } from "../src/own-ledger";

const MAKE = (id: number) => `  call void @__milo_own_make(i64 ${id}) ; own t L1`;
const END = (id: number, kind: number) => `  call void @__milo_own_end(i64 ${id}, i32 ${kind})`;
const VIEW = (id: number, src: number) => `  call void @__milo_own_view(i64 ${id}, i64 ${src}) ; own view:x L1`;
const DROP = 0, MOVE = 1, STORE = 4;

function kinds(body: string[]): string[] {
  const ir = ["define void @f() {", "entry:", ...body, "  ret void", "}"];
  return verifyOwnLedger(ir).map(f => `${f.id} ${f.kind}`);
}

test("a view that is never ended is clean", () => {
  expect(kinds([MAKE(1), VIEW(2, 1), END(1, DROP)])).toEqual([]);
});

test("dropping a view is drop-of-view", () => {
  expect(kinds([MAKE(1), VIEW(2, 1), END(2, DROP), END(1, DROP)])).toEqual(["2 drop-of-view"]);
});

test("handing a view to an owner is own-of-view", () => {
  expect(kinds([MAKE(1), VIEW(2, 1), END(2, STORE), END(1, DROP)])).toEqual(["2 own-of-view"]);
});

test("ending an ID after it was moved away is end-after-move", () => {
  expect(kinds([MAKE(1), END(1, MOVE), END(1, DROP)])).toEqual(["1 end-after-move"]);
});

test("a second drop is still double-end", () => {
  expect(kinds([MAKE(1), END(1, DROP), END(1, DROP)])).toEqual(["1 double-end"]);
});

test("viewing a moved source is use-after-move; a dropped one use-after-drop", () => {
  expect(kinds([MAKE(1), END(1, MOVE), VIEW(2, 1)])).toEqual(["2 use-after-move"]);
  expect(kinds([MAKE(1), END(1, DROP), VIEW(2, 1)])).toEqual(["2 use-after-drop"]);
});

test("a view of an owner outside the frame (source 0) makes no claim", () => {
  expect(kinds([VIEW(2, 0)])).toEqual([]);
});

test("a view that may have been dropped on one path is reported at the join", () => {
  const ir = [
    "define void @f(i1 %c) {", "entry:", MAKE(1), VIEW(2, 1), "  br i1 %c, label %a, label %b",
    "a:", END(2, DROP), "  br label %b",
    "b:", END(1, DROP), "  ret void", "}",
  ];
  expect(verifyOwnLedger(ir).map(f => `${f.id} ${f.kind}`)).toEqual(["2 drop-of-view"]);
});

const PART = (pid: number, fid: number) => `  call void @__milo_own_part(i64 ${pid}, i64 ${fid})`;
const DROPF = 7;

test("dropping a parent whole after a field left it is part-double-drop", () => {
  expect(kinds([MAKE(1), PART(1, 2), END(1, DROP)])).toEqual(["2 part-double-drop"]);
});

test("a field-by-field drop that skips the moved field is clean", () => {
  expect(kinds([MAKE(1), PART(1, 2), END(1, DROPF)])).toEqual([]);
});

test("a part moved on one path and dropped whole at the join is reported", () => {
  const ir = [
    "define void @f(i1 %c) {", "entry:", MAKE(1), "  br i1 %c, label %a, label %b",
    "a:", PART(1, 2), "  br label %b",
    "b:", END(1, DROP), "  ret void", "}",
  ];
  expect(verifyOwnLedger(ir).map(f => `${f.id} ${f.kind}`)).toEqual(["2 part-double-drop"]);
});

test("a part guarded by its flag and dropped on the live edge is clean", () => {
  const ir = [
    "define void @f(i1 %c) {", "entry:", MAKE(1), "  br i1 %c, label %a, label %b",
    "a:", PART(1, 2), "  br label %b",
    "b:", "  %f = load i1, ptr %flag", "  call void @__milo_own_guard(i64 2, i1 %f)", "  br i1 %f, label %live, label %done",
    "live:", END(2, DROP), "  br label %done",
    "done:", END(1, DROPF), "  ret void", "}",
  ];
  expect(verifyOwnLedger(ir).map(f => `${f.id} ${f.kind}`)).toEqual([]);
});
