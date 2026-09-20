// The warning names `--deny=` / `--allow=` accept, and which of them are off by default.
//
// The list existed twice — as string literals at each `this.warn("name", …)` call site in
// checker.ts, and as prose inside the `--deny-all` help text — and nothing compared them.
// A user typing `--deny=unused-varibale` got silence, and a warning added to the checker
// never reached the help. tests/warnings.test.ts holds this file to the call sites in both
// directions, and cli-help.ts renders the help line from it.
interface WarningInfo {
  name: string;
  /** Off by default: not reported unless `--deny=<name>` (or `--deny-all`) asks for it. */
  offByDefault?: true;
  /** An error by default: `--allow=<name>` is the only way to silence it. A rule the
   *  language requires, kept in this table so the same flags and project lints reach it. */
  errorByDefault?: true;
}

export const WARNINGS: WarningInfo[] = [
  // Reported when `--expect=<name>` was given and that warning never fired. On by
  // default: an expectation nobody is told about is just a quieter `--allow`.
  { name: "unfulfilled-expectation" },
  { name: "bare-embedfile" },
  { name: "bare-targetos" },
  { name: "external-linkage-not-pub" },
  { name: "borrow-that-clones" },
  { name: "index-clone" },
  // A bare argument bound to a `&mut` parameter. The language rule since 2026-09-20
  // (docs/plans/local-reasoning-2026-09.md, track A): `f(&mut x)` is mandatory, and the
  // hint names the fixer. `--allow=implicit-mut-borrow` is the escape hatch for a tree
  // mid-migration.
  { name: "implicit-mut-borrow", errorByDefault: true },
  { name: "large-stack-array", offByDefault: true },
  { name: "manual-option-default" },
  { name: "adopt-raw-fields" },
  { name: "arena-never-frees" },
  { name: "missing-interpolation" },
  { name: "nan-comparison" },
  // The thread-boundary global check cannot see through a call to a function value, so it
  // is incomplete there. Off by default: every occurrence in the tree today is a callback
  // that touches nothing, and an on-by-default warning nobody can act on is noise.
  { name: "opaque-call-on-thread", offByDefault: true },
  { name: "shadows-stdlib-override" },
  { name: "single-variant-match", offByDefault: true },
  { name: "unused-import", offByDefault: true },
  // The census of `@copy` structs. Every hit is a deliberate annotation, so it is off by
  // default; `--deny=unowned-pointer-copy` enumerates them for an ownership audit.
  { name: "unowned-pointer-copy", offByDefault: true },
  { name: "unused-move", offByDefault: true },
  { name: "unused-result" },
  { name: "unused-unsafe" },
  { name: "unused-variable" },
  { name: "useless-forget" },
  { name: "unverified-extern", offByDefault: true },
];

export const WARNING_NAMES: string[] = WARNINGS.map(w => w.name);
export const OFF_BY_DEFAULT: string[] = WARNINGS.filter(w => w.offByDefault).map(w => w.name);
export const ERROR_BY_DEFAULT: string[] = WARNINGS.filter(w => w.errorByDefault).map(w => w.name);
