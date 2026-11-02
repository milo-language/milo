// The value-semantics rules of Milo: how a value prints, how it is cloned, in what order it is
// dropped, and how HashMap keys compare. Rendered into docs/spec.md as the MILO-V- requirements
// by scripts/gen-spec.ts. Same contract as scripts/ownership-rules.ts: every rule cites fixtures
// whose expected output pins it, and tests/spec.test.ts refuses a rule whose fixtures do not exist.

export interface ValueRule {
  id: string;            // MILO-V-<name>, stable across rewording
  rule: string;          // the normative sentence(s)
  fixtures: string[];    // tests/fixtures/<name>.milo programs that pin it
}

export const VALUE_RULES: ValueRule[] = [
  {
    id: "MILO-V-displayScalars",
    rule: "Display (`print`, `format`, string interpolation) writes an integer in decimal, a float with the shortest digits that round-trip, and a bool as `true` or `false`. A string at top level is written as its bytes.",
    fixtures: ["displayScalarsNested", "floatRoundTrip"],
  },
  {
    id: "MILO-V-displayAggregates",
    rule: "Inside a struct, enum, Vec, array, slice or HashMap a string is written in double quotes, without escaping. A struct is `Name { f: v, g: w }` (`Name {  }` when empty), an enum is `Variant` or `Variant(a, b)`, a Vec, array or slice is `[a, b]`, and a HashMap is `{k: v, k: v}`.",
    fixtures: ["displayScalarsNested", "displayStructEnum", "printContainers", "printSlice"],
  },
  {
    id: "MILO-V-clone",
    rule: "`.clone()`, `v.get(i)` and a copy out of a container are deep: strings share their buffer by count and copy on write, and a Vec, HashMap or Heap gets its own buffer. The copy and the original change independently.",
    fixtures: ["vecClone", "hashMapCloneDeep", "structCloneOutOfContainer", "fieldCloneOutOfContainer"],
  },
  {
    id: "MILO-V-dropOrder",
    rule: "A struct runs its own Drop first, then drops its fields last to first. A Vec drops its elements in index order, then frees its buffer. The order in which a HashMap drops its entries is unspecified.",
    fixtures: ["dropOrderFieldsVec", "fieldMoveDropOnce"],
  },
  {
    id: "MILO-V-hashKey",
    rule: "Integer, bool, string and struct keys of a HashMap compare by value; a struct compares field by field. Iteration order over a HashMap is unspecified.",
    fixtures: ["hashmapBoolKey", "hashmapStringKey", "hashmapStructKey"],
  },
];
