// The builtin method surface, for the receivers whose dispatch is a hand-written
// if-chain in checker.ts rather than a symbol table.
//
// This file is the only place that list lives. It previously existed three times —
// the checker's dispatch, suggest.ts's did-you-mean names, and lsp.ts's completion
// signatures — and they drifted: twelve methods the checker accepted were missing
// from completion, and all sixteen integer arithmetic builtins were missing from
// both. A member here is not automatically implemented; tests/builtinMembers.test.ts
// compiles a probe per row so a lie in this table fails the build, and greps the
// dispatch so a method added there without a row here fails too.
//
// `sig` is what the LSP shows after the name. `note` is a caveat appended to it —
// use it for the rules a signature can't express (Copy-only, for-in only, consumes
// the receiver).

export interface BuiltinMember {
  name: string;
  sig: string;
  note?: string;
  // The receiver keeps the argument after the call returns. checkEscapingClosures and
  // retainsParam read this: a closure handed to such a method has escaped into the
  // collection, and `map`/`each`/`sortBy` (called and dropped within the call) must not
  // be confused with it. Derived here so the two checker sites cannot drift apart.
  retainsArg?: true;
  // The call may reallocate the receiver's buffer. safety.ts's no-dynamic-allocation
  // rule reads this; the value-only judgment lives beside `retainsArg` so a new growing
  // builtin is classified once, in its own row.
  grows?: true;
}

export type BuiltinReceiver =
  | "string" | "vec" | "hashmap" | "option" | "result"
  | "heap" | "int" | "float" | "bool" | "any";

export const BUILTIN_MEMBERS: Record<BuiltinReceiver, BuiltinMember[]> = {
  // Callable on any receiver at all, so they belong to no single table.
  any: [
    { name: "addrOf", sig: "(): *T", note: "raw address of an lvalue; requires 'unsafe'" },
  ],

  string: [
    { name: "len", sig: ": i64" },
    { name: "isEmpty", sig: "(): bool" },
    { name: "contains", sig: "(needle: string): bool" },
    { name: "startsWith", sig: "(prefix: string): bool" },
    { name: "endsWith", sig: "(suffix: string): bool" },
    { name: "indexOf", sig: "(needle: string): Option<i64>" },
    { name: "indexOfFrom", sig: "(needle: string, from: i64): Option<i64>" },
    { name: "lastIndexOf", sig: "(needle: string): Option<i64>" },
    { name: "charAt", sig: "(i: i64): string", note: "the whole character starting at BYTE offset i: charAt(1) of \"aéb\" is \"é\"; an offset inside a multibyte character aborts. Iterate with `for c in s.codePoints()` for characters" },
    { name: "substr", sig: "(start: i64, end: i64): string", note: "BYTE offsets — a bound inside a multibyte character splits it and yields invalid UTF-8, silently" },
    { name: "slice", sig: "(start: i64, end: i64): &string", note: "a view, not a copy — the receiver is frozen while it lives. BYTE offsets, like substr" },
    { name: "toLower", sig: "(): string", note: "ASCII only — \"AÉB\" lowercases to \"aÉb\"" },
    { name: "toUpper", sig: "(): string", note: "ASCII only — \"aéb\" uppercases to \"AéB\"" },
    { name: "trim", sig: "(): string" },
    { name: "trimStart", sig: "(): string" },
    { name: "trimEnd", sig: "(): string" },
    { name: "repeat", sig: "(n: i64): string" },
    { name: "reverse", sig: "(): string", note: "code-point aware, unlike charAt/substr — \"日本語\" reverses to \"語本日\"" },
    { name: "padStart", sig: "(targetLen: i64, pad: string): string", note: "targetLen counts characters (code points), so \"café\" and \"cafe\" pad to the same column; the pad string is cycled by character" },
    { name: "padEnd", sig: "(targetLen: i64, pad: string): string", note: "targetLen counts characters, like padStart" },
    { name: "replace", sig: "(old: string, new: string): string" },
    { name: "replaceFirst", sig: "(old: string, new: string): string" },
    { name: "split", sig: "(sep: string): Vec<string>" },
    { name: "splitWords", sig: "(): Vec<string>" },
    { name: "splitWhitespace", sig: "(): Vec<string>" },
    { name: "lines", sig: "(): &string pieces", note: "for-in only — yields views into the receiver, never owned copies" },
    { name: "splitView", sig: "(sep: string): &string pieces", note: "for-in only — yields views into the receiver, never owned copies" },
    { name: "codePoints", sig: "(): i32 code points", note: "for-in only — a parser desugar, not a value you can bind" },
    { name: "parseInt", sig: "(): Option<i64>" },
    { name: "parseF64", sig: "(): Option<f64>" },
    { name: "push", sig: "(c: u8)", grows: true },
    { name: "pushStr", sig: "(s: &string)", grows: true },
    { name: "cstr", sig: "(): *u8", note: "NUL-terminated view; the string must outlive the pointer" },
    { name: "clone", sig: "(): string" },
  ],

  vec: [
    { name: "len", sig: ": i64" },
    { name: "isEmpty", sig: "(): bool" },
    { name: "capacity", sig: "(): i64" },
    { name: "reserve", sig: "(extra: i64)", grows: true },
    { name: "push", sig: "(value: T)", retainsArg: true, grows: true },
    { name: "pop", sig: "(): Option<T>" },
    { name: "get", sig: "(index: i64): Option<T>" },
    { name: "first", sig: "(): Option<T>" },
    { name: "last", sig: "(): Option<T>" },
    { name: "insert", sig: "(index: i64, value: T)", retainsArg: true, grows: true },
    { name: "remove", sig: "(index: i64): T" },
    { name: "swap", sig: "(a: i64, b: i64)" },
    { name: "truncate", sig: "(len: i64)" },
    { name: "clear", sig: "()" },
    { name: "extend", sig: "(other: Vec<T>)", note: "moves other in", retainsArg: true, grows: true },
    { name: "retain", sig: "(pred)", note: "in-place filter" },
    { name: "reverse", sig: "()" },
    { name: "sort", sig: "()" },
    { name: "sortBy", sig: "(cmp)" },
    { name: "sortByKey", sig: "(key)" },
    { name: "slice", sig: "(start: i64, end: i64): &[T]" },
    { name: "contains", sig: "(value: T): bool" },
    { name: "indexOf", sig: "(value: T): Option<i64>" },
    { name: "position", sig: "(pred): Option<i64>" },
    { name: "join", sig: "(sep: string): string", note: "Vec<string> only" },
    { name: "map", sig: "(f): Vec<U>" },
    { name: "filter", sig: "(pred): Vec<T>" },
    { name: "fold", sig: "(init: A, f: (A, &T) => A): A" },
    { name: "reduce", sig: "(init: A, f: (A, &T) => A): A", note: "alias of fold" },
    { name: "each", sig: "(f)" },
    { name: "enumerate", sig: "(f)" },
    { name: "find", sig: "(pred): Option<T>" },
    { name: "any", sig: "(pred): bool" },
    { name: "all", sig: "(pred): bool" },
    { name: "sum", sig: "(): T" },
    { name: "min", sig: "(): Option<T>" },
    { name: "max", sig: "(): Option<T>" },
    { name: "ptr", sig: "(): *T", note: "backing data pointer; the Vec stays live in the caller" },
    { name: "clone", sig: "(): Vec<T>" },
  ],

  // A `Heap<T>` resolves everything else on T, so this table is only what the box itself
  // answers.
  heap: [
    { name: "ptr", sig: "(): *T", note: "the box pointer; the Heap stays live in the caller, and a user 'ptr' method on T wins" },
  ],

  hashmap: [
    { name: "len", sig: ": i64" },
    { name: "isEmpty", sig: "(): bool" },
    { name: "insert", sig: "(key: K, value: V)", retainsArg: true, grows: true },
    { name: "get", sig: "(key: K): Option<V>" },
    { name: "getOrDefault", sig: "(key: K, fallback: V): V" },
    { name: "modify", sig: "(key: K, f: (&mut V) => void): bool", note: "f runs on the value in place; false when the key is absent" },
    { name: "getOrInsertWith", sig: "(key: K, init: () => V): bool", note: "inserts init() when the key is absent; true when it did" },
    { name: "contains", sig: "(key: K): bool" },
    { name: "remove", sig: "(key: K)" },
    { name: "keys", sig: "(): Vec<K>" },
    { name: "values", sig: "(): Vec<V>" },
    { name: "clear", sig: "()" },
    { name: "clone", sig: "(): HashMap<K, V>" },
  ],

  // The Option and Result lists differ only where the types genuinely differ:
  // `mapErr` has no Option analogue because None carries no payload to map.
  // Everything else is deliberately symmetric — see docs/language-reference.md
  // §Option Combinators.
  option: [
    { name: "isSome", sig: "(): bool" },
    { name: "isNone", sig: "(): bool" },
    { name: "unwrapOr", sig: "(default: T): T", note: "Copy T only; '??' has no such limit" },
    { name: "unwrapOrElse", sig: "(f: () => T): T", note: "Copy T only; f runs only on None" },
    { name: "map", sig: "(f: (&T) => U): Option<U>" },
    { name: "andThen", sig: "(f: (&T) => Option<U>): Option<U>" },
    { name: "orElse", sig: "(f: () => Option<T>): Option<T>", note: "consumes a non-Copy receiver" },
  ],

  result: [
    { name: "isOk", sig: "(): bool" },
    { name: "isErr", sig: "(): bool" },
    { name: "unwrapOr", sig: "(default: T): T", note: "Copy T only; '??' has no such limit" },
    { name: "unwrapOrElse", sig: "(f: (&E) => T): T", note: "Copy T only; f runs only on Err" },
    { name: "map", sig: "(f: (&T) => U): Result<U, E>" },
    { name: "mapErr", sig: "(f: (&E) => F): Result<T, F>" },
    { name: "andThen", sig: "(f: (&T) => Result<U, E>): Result<U, E>" },
    { name: "orElse", sig: "(f: (&E) => Result<T, F>): Result<T, F>" },
  ],

  // Arithmetic that opts out of the default overflow trap, plus bit twiddling.
  // See docs/language-reference.md §Overflow — the trap is the default and there
  // is no flag to disable it globally, so these methods are the whole escape hatch.
  int: [
    { name: "toString", sig: "(): string" },
    { name: "wrappingAdd", sig: "(rhs: T): T" },
    { name: "wrappingSub", sig: "(rhs: T): T" },
    { name: "wrappingMul", sig: "(rhs: T): T" },
    { name: "wrappingNeg", sig: "(): T" },
    { name: "saturatingAdd", sig: "(rhs: T): T" },
    { name: "saturatingSub", sig: "(rhs: T): T" },
    { name: "saturatingMul", sig: "(rhs: T): T" },
    { name: "checkedAdd", sig: "(rhs: T): Option<T>" },
    { name: "checkedSub", sig: "(rhs: T): Option<T>" },
    { name: "checkedMul", sig: "(rhs: T): Option<T>" },
    { name: "checkedDiv", sig: "(rhs: T): Option<T>" },
    { name: "checkedRem", sig: "(rhs: T): Option<T>" },
    { name: "checkedNeg", sig: "(): Option<T>" },
    { name: "rotateLeft", sig: "(n: T): T" },
    { name: "rotateRight", sig: "(n: T): T" },
    { name: "reverseBits", sig: "(): T" },
    { name: "countOnes", sig: "(): i64" },
    { name: "leadingZeros", sig: "(): i64" },
    { name: "trailingZeros", sig: "(): i64" },
  ],

  float: [
    { name: "toString", sig: "(): string" },
  ],

  bool: [
    { name: "toString", sig: "(): string" },
  ],
};

// Names only, for "did you mean" candidate sets. Universal members are folded in
// so a typo of `addrOf` gets a suggestion on any receiver.
export function memberNames(receiver: BuiltinReceiver): string[] {
  return [...BUILTIN_MEMBERS[receiver], ...(receiver === "any" ? [] : BUILTIN_MEMBERS.any)]
    .map(m => m.name);
}

// Method names carrying a flag, across every receiver. Name-level because the consumers
// (retainsParam, checkEscapingClosures, safety.ts) match a MethodCall by name before the
// receiver is known to be a builtin at all; a user method of the same name is treated the
// same way, which is the fail-closed direction for both flags.
function namesWith(flag: "retainsArg" | "grows"): ReadonlySet<string> {
  const out = new Set<string>();
  for (const members of Object.values(BUILTIN_MEMBERS)) for (const m of members) if (m[flag]) out.add(m.name);
  return out;
}
export const RETAINING_MEMBERS: ReadonlySet<string> = namesWith("retainsArg");
export const GROWING_MEMBERS: ReadonlySet<string> = namesWith("grows");

// Builtins that may realloc, free, or shift collection memory — illegal on a
// receiver with a live borrow (slice or active for-in). Read-only and in-place
// element ops are intentionally absent. A literal list rather than a flag because the
// checker reads it on any receiver type (vec, hashmap, string) before the receiver's
// member table is consulted; it lives here so checker.ts and the whole-program passes
// share one copy without importing each other.
export const MUTATING_COLLECTION_METHODS: ReadonlySet<string> = new Set([
  "push", "pushStr", "pop", "insert", "remove", "reverse", "swap", "sort", "sortBy", "sortByKey",
  "clear", "truncate", "extend", "retain", "reserve", "modify", "getOrInsertWith",
]);

// The one-line detail an editor shows next to the name.
export function memberDetail(m: BuiltinMember): string {
  return m.note ? `${m.sig} — ${m.note}` : m.sig;
}
