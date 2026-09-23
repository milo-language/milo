// "Did you mean ...?" hints for the checker.
//
// Two independent sources, tried in order:
//   1. ALIASES — names from other languages that mean something here under a
//      different spelling. `arr.length`, `s.toUpperCase()`, `v.forEach(..)` are
//      not typos, so edit distance never finds them; they need a real table.
//   2. Edit distance against the receiver's actual members.
//
// Everything here is diagnostics-only: a stale entry costs a wrong suggestion,
// never a wrong compile. That's why the builtin member lists below are hand-kept
// rather than derived from the checker's dispatch chains.

import { existsSync, readdirSync, statSync } from "fs";
import { resolve, relative } from "path";
import { STDLIB_DIR, bundledStdPaths, readStd } from "./stdlibBundle";
import { memberNames } from "./builtin-members";

// Damerau-Levenshtein (optimal string alignment), bailing out once the best
// possible score exceeds `max`. The cap matters because this runs over every member
// of a type at error time. Transpositions count as one edit, not two: `nmae` for
// `name` is the single most common typo, and plain Levenshtein scores it 2 — past
// the threshold a 4-character name can afford.
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Three rows: i-2 is needed for the transposition step.
  let prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}

// Scaled to the name's length: one edit is a lot in `len`, three is little in
// `splitWhitespace`. Fixed thresholds either miss long typos or fire on short
// unrelated names.
function threshold(name: string): number {
  if (name.length <= 4) return 1;
  if (name.length <= 8) return 2;
  return 3;
}

// The typed name is a leading fragment or camelCase word of a longer candidate:
// `min` for `minF64`, `Json` for `parseJson`. Edit distance cannot see these (one
// letter off `sin` scores better than three letters short of `minF64`), yet a
// truncated name is the more common mistake. Three characters minimum, or `a`
// would match half of every member list.
function fragmentRank(name: string, candidate: string): number {
  if (name.length < 3 || candidate.length <= name.length) return 0;
  const lower = name.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.startsWith(lower)) return 2;
  for (let i = c.indexOf(lower, 1); i > 0; i = c.indexOf(lower, i + 1)) {
    const at = candidate[i]!;
    if (candidate[i - 1] === "_" || (at >= "A" && at <= "Z")) return 1;
  }
  return 0;
}

// Ranked suggestions for `name`, best first; empty when nothing is close. A
// case-insensitive exact match wins alone (`toUppercase` vs `toUpperCase` is the
// same name, not a near miss). Next come candidates the name is a prefix of, then
// ones it names a camelCase word of, shortest first; several are returned because
// `min` on Math means one of `minF64`/`minI32`/`minI64` and the reader must choose.
// Only when no candidate contains the name does edit distance pick a single typo fix.
export function suggestions(name: string, candidates: Iterable<string>, limit = 3): string[] {
  const max = threshold(name);
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestDist = max + 1;
  const fragments: { c: string; rank: number }[] = [];
  for (const c of candidates) {
    if (c === name) continue;
    if (c.toLowerCase() === lower) return [c];
    const rank = fragmentRank(name, c);
    if (rank > 0) { fragments.push({ c, rank }); continue; }
    const d = editDistance(name, c, max);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (fragments.length > 0) {
    fragments.sort((a, b) => b.rank - a.rank || a.c.length - b.c.length || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
    return [...new Set(fragments.map(f => f.c))].slice(0, limit);
  }
  return bestDist <= max && best !== null ? [best] : [];
}

// The single best suggestion, or null.
export function closest(name: string, candidates: Iterable<string>): string | null {
  return suggestions(name, candidates, 1)[0] ?? null;
}

// "did you mean 'a'?" / "did you mean 'a', 'b' or 'c'?", or undefined for none.
export function didYouMean(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  const quoted = names.map(n => `'${n}'`);
  const list = quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
  return `did you mean ${list}?`;
}

// Names that exist under a different spelling in Milo. Keys are what a developer
// coming from TypeScript/JavaScript, Rust, Python, C++ or Java types by reflex;
// values are the Milo spelling. Only suggested when the value is actually a
// member of the receiver, so `length` on a struct with no `len` stays quiet.
const ALIASES: ReadonlyMap<string, string> = new Map([
  // TypeScript / JavaScript
  ["length", "len"],
  ["size", "len"],
  ["count", "len"],
  ["forEach", "each"],
  ["reduce", "fold"],
  ["reduceRight", "fold"],
  ["toUpperCase", "toUpper"],
  ["toLowerCase", "toLower"],
  ["includes", "contains"],
  ["some", "any"],
  ["every", "all"],
  ["trimLeft", "trimStart"],
  ["trimRight", "trimEnd"],
  ["padLeft", "padStart"],
  ["padRight", "padEnd"],
  ["shift", "remove"],
  ["splice", "remove"],
  ["unshift", "insert"],
  ["concat", "pushStr"],
  ["at", "charAt"],
  ["substring", "substr"],
  ["findIndex", "indexOf"],
  ["search", "indexOf"],
  ["sortWith", "sortBy"],
  // Rust
  ["push_str", "pushStr"],
  ["to_string", "toString"],
  ["to_owned", "clone"],
  ["is_empty", "isEmpty"],
  ["unwrap_or", "unwrapOr"],
  ["unwrap_or_else", "unwrapOrElse"],
  ["is_some", "isSome"],
  ["is_none", "isNone"],
  ["starts_with", "startsWith"],
  ["ends_with", "endsWith"],
  ["sort_by", "sortBy"],
  ["sort_by_key", "sortByKey"],
  ["last_index_of", "lastIndexOf"],
  ["char_at", "charAt"],
  ["to_lowercase", "toLower"],
  ["to_uppercase", "toUpper"],
  // Python
  ["append", "push"],
  ["extend", "push"],
  ["upper", "toUpper"],
  ["lower", "toLower"],
  ["strip", "trim"],
  ["lstrip", "trimStart"],
  ["rstrip", "trimEnd"],
  ["startswith", "startsWith"],
  ["endswith", "endsWith"],
  ["index", "indexOf"],
  // C++ / Java
  ["push_back", "push"],
  ["pop_back", "pop"],
  ["add", "push"],
  ["put", "insert"],
  ["erase", "remove"],
  ["front", "charAt"],
]);

// Members that Milo spells as an operator rather than a method. Suggesting a
// near-miss name here would send the reader looking for a method that will never
// exist, so these carry their own hint text.
const OPERATOR_FORMS: ReadonlyMap<string, string> = new Map([
  ["unwrap", "Milo spells this as the '!' suffix: 'x!' unwraps, panicking on None/Err"],
  ["expect", "Milo spells this as the '!' suffix: 'x!' unwraps, panicking on None/Err"],
  ["unwrapOrDefault", "use '??' for a default: 'x ?? fallback'"],
  ["orElse", "use '??' for a default: 'x ?? fallback'"],
  ["getOrElse", "use '??' for a default: 'x ?? fallback'"],
  ["equals", "compare with '==' — it is structural, not a reference check"],
]);

// Builtin members per receiver, for the types whose dispatch is a hand-written
// if-chain in the checker rather than a symbol table. Names only — the signatures,
// and the single list both these and the LSP read, live in ./builtin-members.
export const VEC_MEMBERS = memberNames("vec");
export const HASHMAP_MEMBERS = memberNames("hashmap");
export const STRING_MEMBERS = memberNames("string");
export const OPTION_MEMBERS = memberNames("option");
export const RESULT_MEMBERS = memberNames("result");
export const INT_MEMBERS = memberNames("int");
export const FLOAT_MEMBERS = memberNames("float");
export const BOOL_MEMBERS = memberNames("bool");

// The hint for a member that doesn't exist on `receiver`. `candidates` is the
// receiver's real members; pass an empty list when they aren't enumerable and
// only the alias/operator tables should apply.
export function memberHint(name: string, candidates: Iterable<string>): string | undefined {
  const members = new Set(candidates);
  const alias = ALIASES.get(name);
  if (alias && members.has(alias)) return `did you mean '${alias}'?`;
  const op = OPERATOR_FORMS.get(name);
  if (op) return op;
  const near = didYouMean(suggestions(name, members));
  if (near) return near;
  // The alias target isn't a member of this receiver, but naming it still beats
  // silence — it tells the reader what Milo calls the concept.
  if (alias) return `Milo spells this '${alias}'`;
  return undefined;
}

// ── Which std module exports a name ──────────────────────────────────────────
//
// A missing import and a typo produce the same "unknown type" at the use site,
// and the fix for the first is a line the compiler can write out in full. The
// scan is lexical (same basis as `milo api`) and built at most once per process,
// on the error path only — a clean compile never touches the filesystem here.

let STD_EXPORTS: Map<string, string[]> | null = null;
// Import paths any std module answers to, for spelling suggestions on a bad import.
// Filled by the same scan as STD_EXPORTS so the two cannot disagree about what std holds.
let STD_MODULES: Set<string> | null = null;

function walkMilo(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) walkMilo(p, out);
    else if (entry.endsWith(".milo")) out.push(p);
  }
}

function stdExports(): Map<string, string[]> {
  if (STD_EXPORTS) return STD_EXPORTS;
  const index = new Map<string, string[]>();
  STD_EXPORTS = index;
  const modules = new Set<string>();
  STD_MODULES = modules;
  const stdDir = resolve(STDLIB_DIR, "std");
  const files: string[] = [];
  try {
    if (existsSync(stdDir)) walkMilo(stdDir, files);
    // bundledStdPaths resolves through the platform separator, so match on both.
    else files.push(...bundledStdPaths().filter(p => p.includes("/std/") || p.includes("\\std\\")));
  } catch { return index; }
  const decl = /^pub\s+(?:fn|struct|enum|type|const|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const f of files) {
    const src = readStd(f);
    if (src === null) continue;
    // std/platform.darwin.milo is imported as "std/platform" — the suffix picks
    // the arm at resolve time and never appears in source. Separators are forced to
    // '/' because this string goes straight into an import path the user will paste,
    // and `relative` hands back backslashes on Windows.
    const mod = relative(STDLIB_DIR, f)
      .replace(/\\/g, "/")
      .replace(/\.milo$/, "")
      .replace(/\.(darwin|linux|windows)$/, "");
    modules.add(mod);
    for (const m of src.matchAll(decl)) {
      const list = index.get(m[1]);
      if (!list) index.set(m[1], [mod]);
      else if (!list.includes(mod)) list.push(mod);
    }
  }
  return index;
}

// The import line that would bring `name` into scope, or null if no std module
// exports it. Ambiguity is reported rather than guessed at.
export function importHint(name: string): string | undefined {
  const mods = stdExports().get(name);
  if (!mods || mods.length === 0) return undefined;
  if (mods.length === 1) return `add the import: from "${mods[0]}" import { ${name} }`;
  return `'${name}' is exported by ${mods.map(m => `"${m}"`).join(", ")} — import it from one of them`;
}

// Names any std module exports, for spelling suggestions on an unknown type.
export function stdExportNames(): Iterable<string> {
  return stdExports().keys();
}

// Every importable std module path ("std/io", "std/json", …).
export function stdModuleNames(): Iterable<string> {
  stdExports();
  return STD_MODULES ?? new Set<string>();
}
