// The ownership rules of Milo: when a value is moved, cloned, lent or dropped, and in what
// order. Rendered into docs/spec.md as the MILO-O- requirements by scripts/gen-spec.ts.
//
// Each rule cites the fixtures that pin it. A fixture's expected output is what makes the
// rule checkable: tests/spec.test.ts refuses a rule whose fixtures do not exist or state no
// behaviour, so a rule cannot appear here without a program that discharges it. Both
// backends implement these rules (src/codegen.ts and src/emit-mlir.ts cite them by id), and
// the core-HIR pass (docs/plans/core-hir.md) is to implement them in one place.

interface OwnershipRule {
  id: string;            // MILO-O-<name>, stable across rewording
  rule: string;          // the normative sentence(s)
  fixtures: string[];    // tests/fixtures/<name>.milo programs that pin it
}

export const OWNERSHIP_RULES: OwnershipRule[] = [
  {
    id: "MILO-O-tempStatement",
    rule: "A temporary that owns something lives until the end of the statement that made it, and is dropped there.",
    fixtures: ["blockValueOwnership", "coalesceUnboundTempDrop"],
  },
  {
    id: "MILO-O-tempFieldRead",
    rule: "An owning field read out of a temporary (a call result, a fork, a box nobody owns) is cloned, and the temporary is dropped right after the read, before the rest of the statement runs.",
    fixtures: ["tempFieldReadDrop", "forkTempReceiver", "heapTempBoxRead"],
  },
  {
    id: "MILO-O-forkOwnership",
    rule: "An if or match expression owns its result exactly when some arm yields an owned value; a place arm of such a fork is cloned (a type with a user Drop is consumed instead). A fork whose arms are only places and literals is a view and drops nothing.",
    fixtures: ["blockValueOwnership", "forkTempReceiver", "tempFieldReadDrop"],
  },
  {
    id: "MILO-O-combinatorReceiver",
    rule: "An Option or Result combinator consumes its receiver exactly when it forwards a payload that owns something (`context` always consumes). A receiver it does not consume keeps its payload; a temporary one is dropped after the call.",
    fixtures: ["combinatorRefCallbackDrop", "errorContext"],
  },
  {
    id: "MILO-O-lentClosure",
    rule: "A `move` closure passed to a plain `(T) => R` parameter is lent: the caller keeps it and drops its environment once. A temporary one is dropped right after the call, unless the callee may keep the parameter, in which case nothing drops it.",
    fixtures: ["moveClosureLentToPlainParam", "closureArgEnvOwnership", "closureArgThroughFnValue"],
  },
  {
    id: "MILO-O-returnedPlainClosure",
    rule: "A `move` closure that captures anything owns a heap environment, and a plain `(T) => R` is Copy and owns nothing, so storing or returning such a closure under a plain function type is rejected (`plain-closure-env`; the declared type must be `move (T) => R`). A closure that captures nothing stays a plain value.",
    fixtures: ["escapingClosures", "closureStoredMove"],
  },
  {
    id: "MILO-O-fieldMove",
    rule: "A field moved out of a struct is no longer dropped with it: when the field's type runs a user Drop, the struct's remaining fields drop last-first and the moved one is skipped; reassigning the field or the struct makes it owned again.",
    fixtures: ["fieldMoveDropOnce"],
  },
  {
    id: "MILO-O-structUpdate",
    rule: "A struct update `S { a: x, ..base }` consumes the base: its listed fields are dropped, its unlisted fields move into the result, so each field the base owned ends with one owner.",
    fixtures: ["structUpdate"],
  },
  {
    id: "MILO-O-consumedForIn",
    rule: "A `for` over a temporary or moved collection owns it: each iteration moves one element into the binding, and whichever way the loop ends drops exactly the elements no iteration took.",
    fixtures: ["forInConsumeExits"],
  },
  {
    id: "MILO-O-propagate",
    rule: "`?` into a `Result<T, string>` function calls the error's `message()` and drops the error; into a `Result<T, Heap<Error>>` function it boxes the error (a string as `ErrorMessage`).",
    fixtures: ["propagateErrorMessage", "errorBoxing"],
  },
  {
    id: "MILO-O-arrayRepeat",
    rule: "`[v; n]` of an owning value clones it into the first n-1 slots and moves it into the last; `[v; 0]` drops it.",
    fixtures: ["arrayRepeatDropClone"],
  },
  {
    id: "MILO-O-replaceSwap",
    rule: "`replace(p, v)` moves the old value out as its result and stores v with nothing dropped; `swap(a, b)` exchanges the two with nothing dropped.",
    fixtures: ["replaceSwap"],
  },
  {
    id: "MILO-O-viewVar",
    rule: "A `var` of a view type (`&string`, `&[T]`) holds a view and owns nothing: assigning it replaces the view and drops nothing.",
    fixtures: ["stringSliceReassign"],
  },
  {
    id: "MILO-O-keyExtractor",
    rule: "A `sortByKey` extractor may return a field of the element it borrows; the sort reads that key and never stores or drops it. A string key the extractor builds is owned by the sort, which drops it after its comparison. An extractor that returns the field on one path and a built string on another is rejected.",
    fixtures: ["sortByKeyString", "sortByKeyOwnedKey"],
  },
  {
    id: "MILO-O-globalClosureEnv",
    rule: "A by-reference closure built by a global's initializer has a static environment: the initializer's frame is gone before the global is called.",
    fixtures: ["globalRuntimeInitScalar"],
  },
];
