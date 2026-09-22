// The warning names `--deny=` / `--allow=` accept, and which of them are off by default.
//
// The list existed twice — as string literals at each `this.warn("name", …)` call site in
// checker.ts, and as prose inside the `--deny-all` help text — and nothing compared them.
// A user typing `--deny=unused-varibale` got silence, and a warning added to the checker
// never reached the help. tests/langInfo.test.ts holds this file to the call sites in both
// directions, and cli-help.ts renders the help line from it.
//
// `doc`/`fix`/`example` make this the SOURCE the published warning reference is rendered
// from, rather than a second copy of it: docs/site/language/warnings-and-errors.md carries
// a generated region (scripts/gen-lang-docs.ts), `milo lang --json` carries the same text,
// and an editor or third-party linter reads it from there. The site's 26-warning surface
// was hand-written prose that mentioned 10 of them; the other 16 were undiscoverable
// outside `--help`.
interface WarningInfo {
  name: string;
  /** Off by default: not reported unless `--deny=<name>` (or `--deny-all`) asks for it. */
  offByDefault?: true;
  /**
   * What the warning means, in one or two sentences of markdown. Rendered to the site and
   * to `milo lang --json`; write it for a user who has never seen the name before.
   */
  doc?: string;
  /** What to write instead, one imperative line. */
  fix?: string;
  /**
   * A whole program that provokes the warning. Not decoration: tests/langInfo.test.ts runs
   * `milo check --deny=<name>` over it and fails unless the checker reports THIS name, so a
   * documented example cannot drift away from the rule it illustrates.
   */
  example?: string;
}

/** Warnings whose reference entry is finished. Ratchet: may only grow. */
export const DOCUMENTED_FLOOR = 2;

export const WARNINGS: WarningInfo[] = [
  // Reported when `--expect=<name>` was given and that warning never fired. On by
  // default: an expectation nobody is told about is just a quieter `--allow`.
  { name: "unfulfilled-expectation" },
  { name: "bare-embedfile" },
  { name: "bare-targetos" },
  { name: "external-linkage-not-pub" },
  { name: "borrow-that-clones" },
  {
    name: "index-clone",
    doc: "Indexing a collection of owned values (`v[0]`, `m[key]`) copies the element out, because the language has no stored references to hand back. On a `string` or a `Vec` that copy is a heap allocation per index.",
    fix: "Bind a borrow with a method that lends (`v.at(i)`), or hoist the element out once instead of indexing in a loop.",
    example: `fn main() {
  var v: Vec<string> = Vec.new()
  v.push("a")
  let m = v[0]
  print(m)
}
`,
  },
  { name: "large-stack-array", offByDefault: true },
  { name: "manual-option-default" },
  { name: "adopt-raw-fields" },
  { name: "arena-never-frees" },
  { name: "missing-interpolation" },
  // A free fn with three or more `&mut` parameters is a struct's method with the struct
  // un-bundled: every call site is a row of same-typed `&mut` markers that can be swapped
  // silently. Off by default: about 34 hits in tree today (gifdec, the plink and redline
  // world builders), so it is a census lint until those are restructured.
  { name: "mut-param-bundle", offByDefault: true },
  { name: "nan-comparison" },
  // The thread-boundary global check cannot see through a call to a function value, so it
  // is incomplete there. Off by default: every occurrence in the tree today is a callback
  // that touches nothing, and an on-by-default warning nobody can act on is noise.
  { name: "opaque-call-on-thread", offByDefault: true },
  { name: "shadows-stdlib-override" },
  { name: "single-variant-match", offByDefault: true },
  // `out += piece` inside a loop copies the whole accumulator per iteration; `pushStr`
  // is amortized. On by default since 2026-09-21, once the example corpus reached zero.
  { name: "string-concat-in-loop" },
  { name: "unused-import", offByDefault: true },
  // The census of `@copy` structs. Every hit is a deliberate annotation, so it is off by
  // default; `--deny=unowned-pointer-copy` enumerates them for an ownership audit.
  { name: "unowned-pointer-copy", offByDefault: true },
  // A `requires` on an `unsafe`-bodied fn is the last guard before C, and `-O2` drops
  // it: an AES key length and a pool block size both reached C unchecked this way
  // (backlog #27). Off by default; `--deny=unchecked-ffi-contract` audits the set.
  { name: "unchecked-ffi-contract", offByDefault: true },
  { name: "unused-move", offByDefault: true },
  { name: "unused-result" },
  { name: "unused-unsafe" },
  {
    name: "unused-variable",
    doc: "A binding nothing reads. Usually a rename that missed one site, or a value whose computation is now dead.",
    fix: "Delete the binding, or prefix the name with `_` to say the value is deliberately ignored.",
    example: `fn main() {
  let unused = 42
  print("hi")
}
`,
  },
  { name: "useless-forget" },
  { name: "unverified-extern", offByDefault: true },
];

export const WARNING_NAMES: string[] = WARNINGS.map(w => w.name);
export const OFF_BY_DEFAULT: string[] = WARNINGS.filter(w => w.offByDefault).map(w => w.name);
