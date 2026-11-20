// The in-scope borrow-error message templates, shared by scripts/borrow-shadow.ts (corpus) and
// scripts/borrow-fuzz.ts (generated programs): one list, so both judge the same set of messages.
// The list lives in src/borrow-diagnostics.ts, where the checker drops the walk's copies by it.
export { TEMPLATES, templateOf } from "../src/borrow-diagnostics";
