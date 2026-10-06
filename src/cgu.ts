// Split one emitted LLVM module into N codegen units so clang can optimize them in
// parallel processes. clang is ~95% of build time (profiled: self-host at 20k LOC is
// 0.38s frontend against 7.3s clang -O2) and parallelises near-linearly here, while we
// hand it one module and one process.
//
// This is a BACKEND split: it runs on finished IR, after monomorphization, so it needs
// none of the per-module-incremental machinery the flat resolver blocks (docs/backlog.md
// T2 #11). What it costs is cross-unit inlining, which is why release builds keep one
// unit and this is a dev-loop optimization.
//
// Fail-closed by construction: anything this parser does not positively recognize makes
// `splitModule` return null, and the caller compiles the single module it already had.
// A splitter that silently dropped an unrecognized top-level item would produce a module
// that links and is missing code — the exact silent-success shape the compiler keeps
// getting bitten by.

// LLVM identifiers are either bare (`@foo.bar`) or quoted (`@"has spaces"`).
const IDENT = String.raw`(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._][-a-zA-Z$._0-9]*)`;

// Linkage/visibility words that make a definition local to its module. These are exactly
// the ones that must be promoted when a symbol is referenced from another unit.
const LOCAL_LINKAGE = /^(?:private|internal)\b/;

export type Func = {
  name: string;
  /** the `define ... {` line, used to synthesize a cross-unit `declare` */
  header: string;
  text: string;
  lineCount: number;
  local: boolean;
};

export type Global = {
  name: string;
  text: string;
  local: boolean;
};

export type Module = {
  header: string[];
  typedefs: string[];
  declares: string[];
  globals: Global[];
  funcs: Func[];
  metadata: string[];
  attrs: string[];
};

// One pass that alternates between "an opaque string payload" and "a symbol reference".
// The string alternative comes FIRST so a `@` inside `c"...@..."` is consumed as data:
// those bytes are the program's own string constants, and rewriting one would corrupt it.
// `c` is required to start a token so an identifier merely ending in `c` cannot open a
// byte string. That rule used to be a `(?<!...)` lookbehind, which drops JSC off its regex
// JIT and made the scan ~35x slower (101ms vs 3ms on redline's 4.7MB module); `forEachRef`
// checks the preceding byte by hand instead and, on a rejected string, resumes one char
// later, exactly where the lookbehind form would have resumed.
const SCAN_SOURCE = String.raw`[c!]"(?:[^"\\]|\\.)*"|@(${IDENT})`;
const IDENT_CHAR = /[-a-zA-Z$._0-9]/;

/** Calls `fn(start, end, rawName)` for every `@symbol` in `text`, in order. */
function forEachRef(text: string, fn: (start: number, end: number, raw: string) => void): void {
  // Fresh per call: a shared /g regex carries lastIndex between callers.
  const re = new RegExp(SCAN_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name === undefined) {
      if (m.index > 0 && IDENT_CHAR.test(text[m.index - 1]!)) re.lastIndex = m.index + 1;
      continue;
    }
    fn(m.index, re.lastIndex, name);
  }
}

/**
 * Rewrite every `@symbol` reference in `text` through `map` (undefined = leave alone).
 * A char-at-a-time walk here cost 708ms on a 135k-line module, so this stays a native
 * regex pass. Returns `text` itself when nothing was renamed.
 */
export function mapSymbols(text: string, map: (name: string) => string | undefined): string {
  let out: string[] | null = null;
  let last = 0;
  forEachRef(text, (start, end, raw) => {
    const replaced = map(unquote(raw));
    if (replaced === undefined) return;
    (out ??= []).push(text.slice(last, start), `@${quoteIfNeeded(replaced)}`);
    last = end;
  });
  if (out === null) return text;
  (out as string[]).push(text.slice(last));
  return (out as string[]).join("");
}

export function unquote(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

export function quoteIfNeeded(name: string): string {
  return /^[-a-zA-Z$._][-a-zA-Z$._0-9]*$/.test(name) ? name : `"${name}"`;
}

/**
 * Split a global's text around its byte-string payload, if it has one. An `@embedFile`
 * asset lands here as a single `c"..."` line that can be tens of megabytes — one flight
 * build emits a 37MB line in a 147MB module — and scanning it costs more than the
 * parallelism the split is buying. The payload cannot contain a symbol reference, and
 * `escapeCString` renders `"` as `\22`, so the next quote always closes it.
 */
function aroundBytePayload(text: string): [string, string, string] {
  const open = text.indexOf('c"');
  if (open === -1) return [text, "", ""];
  const close = text.indexOf('"', open + 2);
  if (close === -1) return [text, "", ""];
  return [text.slice(0, open), text.slice(open, close + 1), text.slice(close + 1)];
}

/** `mapSymbols` that skips a global's byte-string payload instead of scanning through it. */
export function mapGlobalSymbols(text: string, map: (name: string) => string | undefined): string {
  const [head, payload, tail] = aroundBytePayload(text);
  if (!payload) return mapSymbols(head, map);
  return mapSymbols(head, map) + payload + mapSymbols(tail, map);
}

/** Every distinct `@symbol` referenced anywhere in `text`. */
export function referencedSymbols(text: string): Set<string> {
  const found = new Set<string>();
  forEachRef(text, (_s, _e, raw) => { found.add(unquote(raw)); });
  return found;
}

/** `referencedSymbols` for a global, skipping its byte-string payload. */
export function referencedInGlobal(text: string): Set<string> {
  const [head, payload, tail] = aroundBytePayload(text);
  if (!payload) return referencedSymbols(head);
  const found = referencedSymbols(head);
  for (const s of referencedSymbols(tail)) found.add(s);
  return found;
}

const DEFINE_HEADER = new RegExp(`^define\\s+(.*?)@(${IDENT})\\s*\\(`);
const GLOBAL_LINE = new RegExp(`^@(${IDENT})\\s*=\\s*(.*)$`);

export function parseModule(ir: string): Module | null {
  const mod: Module = { header: [], typedefs: [], declares: [], globals: [], funcs: [], metadata: [], attrs: [] };
  const lines = ir.split("\n");
  // Offset of lines[i] in `ir`, so a function's text is one slice instead of a re-join.
  let offset = 0;

  for (let i = 0; i < lines.length; offset += lines[i]!.length + 1, i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    if (line.startsWith("define")) {
      // Our emitter always closes a function with `}` in column 0, and never emits a
      // nested column-0 `}`; anything else means the shape changed under us, so bail.
      const start = i, startOffset = offset;
      while (i < lines.length && lines[i] !== "}") offset += lines[i++]!.length + 1;
      if (i >= lines.length) return null;
      const text = ir.slice(startOffset, offset + 1);
      const header = lines[start]!;
      const m = DEFINE_HEADER.exec(header);
      if (!m) return null;
      mod.funcs.push({
        name: unquote(m[2]!),
        header,
        text,
        lineCount: i - start + 1,
        local: LOCAL_LINKAGE.test(m[1]!.trim()),
      });
      continue;
    }

    if (line.startsWith("declare")) { mod.declares.push(line); continue; }
    if (line.startsWith("attributes")) { mod.attrs.push(line); continue; }
    if (line.startsWith("!")) { mod.metadata.push(line); continue; }
    if (line.startsWith("target ") || line.startsWith("source_filename")) { mod.header.push(line); continue; }
    if (/^%\S* = type\b/.test(line)) { mod.typedefs.push(line); continue; }

    if (line.startsWith("@")) {
      const m = GLOBAL_LINE.exec(line);
      if (!m) return null;
      // An alias or ifunc aliases a symbol we may be about to move; not emitted today,
      // and getting it wrong is silent, so decline the split instead of guessing.
      if (/^\s*(?:alias|ifunc)\b/.test(m[2]!)) return null;
      mod.globals.push({
        name: unquote(m[1]!),
        text: line,
        local: LOCAL_LINKAGE.test(m[2]!),
      });
      continue;
    }

    // Unrecognized top-level construct (module asm, comdat, a `define` shape we did not
    // match). Decline rather than drop it.
    return null;
  }
  return mod;
}

/** Module a function belongs to: `json$jsonParseValue` -> `json`. A bare name is its own module. */
function moduleKey(name: string): string {
  const i = name.indexOf("$");
  return i === -1 ? name : name.slice(0, i);
}

// A module whose body exceeds this many times the ideal per-unit share is not placed
// whole. Measured on std/json at 8 units: 1.25 leaves the 13.9k-line `json` module (1.9x
// the share) split, 2.0 keeps it whole at +14% build time for +7% runtime.
const OVERSIZE_GROUP_FACTOR = 1.25;

/**
 * Greedy largest-first bin packing over body size, one MODULE at a time. Functions are
 * grouped by `moduleKey` and each group goes whole onto the least-loaded unit. Intra-module
 * calls are the hot ones (a parser calling its own skipWs and scratchPush helpers), and
 * clang can only inline a callee it can see: packing by size alone scattered std/json's
 * helpers across all 8 units and made the json benchmark 30% slower at the default build
 * than at MILO_CGUS=1.
 *
 * Wall-clock is the SLOWEST unit, not the average, so a group larger than
 * `ceil(total / units) * OVERSIZE_GROUP_FACTOR` is not placed whole: its functions are
 * placed individually. Whole groups and loose functions share one largest-first order, so
 * a 4000-line function among 900 small ones still lands on an empty unit rather than on
 * top of a full one (placing loose functions after all groups cost milojs 8% of build time
 * that way: its 579k-line `callBuiltin` stacked onto a 113k-line unit).
 */
/**
 * The previous build's placement, keyed the way `packFunctions` keys its items (a module
 * key, or a function name for one placed alone). With it, an item keeps its unit across
 * edits, so the object cache (src/objcache.ts) still hits on every unit the edit did not
 * touch: size-driven packing alone re-shuffled all 8 units of milojs for a one-line edit.
 * Ignored, and rebuilt from scratch, when keeping the old placement leaves the slowest
 * unit more than STICKY_TOLERANCE over what a fresh packing would give.
 */
export type Placement = Map<string, number>;
const STICKY_TOLERANCE = 1.25;

function packFunctions(funcs: Func[], units: number, prev?: Placement, out?: { placement?: Placement }): number[] {
  const fresh = packItems(funcs, units, undefined);
  if (!prev || prev.size === 0) { out && (out.placement = fresh.placement); return fresh.home; }
  const sticky = packItems(funcs, units, prev);
  const freshMax = Math.max(...fresh.load), stickyMax = Math.max(...sticky.load);
  const chosen = stickyMax <= freshMax * STICKY_TOLERANCE ? sticky : fresh;
  if (out) out.placement = chosen.placement;
  return chosen.home;
}

function packItems(funcs: Func[], units: number, prev: Placement | undefined): { home: number[]; load: number[]; placement: Placement } {
  const load = new Array<number>(units).fill(0);
  const home = new Array<number>(funcs.length).fill(0);
  const placement: Placement = new Map();

  const groups = new Map<string, number[]>();
  let total = 0;
  funcs.forEach((f, i) => {
    total += f.lineCount;
    const key = moduleKey(f.name);
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });
  const oversize = Math.ceil(total / units) * OVERSIZE_GROUP_FACTOR;

  const items: { key: string; idxs: number[]; lines: number }[] = [];
  for (const [key, idxs] of groups) {
    const lines = idxs.reduce((n, i) => n + funcs[i]!.lineCount, 0);
    if (lines > oversize) for (const i of idxs) items.push({ key: funcs[i]!.name, idxs: [i], lines: funcs[i]!.lineCount });
    else items.push({ key, idxs, lines });
  }
  items.sort((a, b) => b.lines - a.lines);
  // Items with a remembered unit go there first; the rest fill the least-loaded units in
  // largest-first order, as before.
  const place = (it: typeof items[number], u: number) => {
    for (const idx of it.idxs) home[idx] = u;
    load[u]! += it.lines;
    placement.set(it.key, u);
  };
  const loose: typeof items = [];
  for (const it of items) {
    const u = prev?.get(it.key);
    if (u !== undefined && u >= 0 && u < units) place(it, u); else loose.push(it);
  }
  for (const it of loose) {
    let best = 0;
    for (let u = 1; u < units; u++) if (load[u]! < load[best]!) best = u;
    place(it, best);
  }
  return { home, load, placement };
}

/**
 * The hot unit. A one-line edit recompiles the edited function's whole unit, so its cost
 * scales with what shares that unit, not with the edit. Functions that changed in recent
 * builds are pulled out into one extra unit (index `units`), so the second and later
 * edits to the same function recompile only that small unit. The first edit still
 * recompiles the function's old home (which lost it) alongside the hot unit, in parallel.
 *
 * `hashes` is every function's IR-text hash from the previous build; `hot` is the hot
 * set, most recently changed last. An array, not a Set, because eviction order must be a
 * function of the persisted state alone.
 */
export type HotState = { hashes: Map<string, string>; hot: string[] };

// Bounds on the hot set. The hot unit only pays while it compiles faster than the unit it
// left, so its body is capped at half the per-unit share; past that the oldest hot
// functions return to their homes. Measured on redline at 8 units (16k-line share, clang
// -O2): its `main` (4.1k lines, the function a UI edit usually lands in) alone takes
// 0.09s against 0.18s for its home unit; 5.3k-line `invert` takes 0.04s; a one-line
// function 0.024s, which is the per-unit floor (process start plus the repeated
// preamble). A cap of 2% of the program would have excluded `main`. The count cap bounds
// the declarations the hot unit repeats.
const HOT_MAX_FNS = 64;
const HOT_SHARE = 0.5;

export function textHash(text: string): string {
  return Bun.hash(text).toString(36);
}

/**
 * Next hot state from this build's functions and the previous state. A function is newly
 * hot when its text hash changed or it did not exist in the previous build; with no
 * previous state (first build, or unreadable state) nothing is hot. When one build changes
 * more than the bounds allow (a branch switch, a mass rename) there is no single edit to
 * follow, so the hot set is cleared rather than filled with an arbitrary slice.
 */
export function selectHot(funcs: { name: string; text: string; lineCount: number }[], units: number, prev: HotState | null): HotState {
  const hashes = new Map<string, string>();
  const lines = new Map<string, number>();
  let total = 0;
  for (const f of funcs) {
    hashes.set(f.name, textHash(f.text));
    lines.set(f.name, f.lineCount);
    total += f.lineCount;
  }
  if (!prev) return { hashes, hot: [] };
  const cap = Math.ceil(total / units * HOT_SHARE);

  const changed: string[] = [];
  let changedLines = 0;
  for (const f of funcs) {
    if (prev.hashes.get(f.name) === hashes.get(f.name)) continue;
    changed.push(f.name);
    changedLines += f.lineCount;
  }
  if (changed.length > HOT_MAX_FNS || changedLines > cap) return { hashes, hot: [] };

  // A re-edited function moves to the back (most recent); deleted functions drop out.
  const fresh = new Set(changed);
  const hot = prev.hot.filter(n => lines.has(n) && !fresh.has(n)).concat(changed);
  let hotLines = hot.reduce((n, name) => n + lines.get(name)!, 0);
  let drop = 0;
  while (hot.length - drop > HOT_MAX_FNS || hotLines > cap) hotLines -= lines.get(hot[drop++]!)!;
  return { hashes, hot: hot.slice(drop) };
}

/**
 * Turn a `define` header into a `declare` for units that only call the function.
 * Parameter names and `#N` attribute groups are legal on a declaration and the byval /
 * sret / coerce attributes MUST survive: codegen requires the same attribute rendering
 * at the declaration and at every call, or the ABI silently disagrees.
 */
export function declareFor(header: string): string {
  let d = header
    .replace(/^define\s+/, "")
    .replace(/\s*\{\s*$/, "");
  // Definition-only trailers. A `!dbg` attachment on a declaration refers to a
  // DISubprogram that describes a body this unit does not have.
  d = d.replace(/\s*!dbg\s+![0-9]+/g, "").replace(/\s*(?:personality|prefix|prologue)\s+.*$/, "");
  d = d.replace(new RegExp(`^(?:${["private", "internal", "external", "available_externally", "linkonce", "linkonce_odr", "weak", "weak_odr", "appending", "common", "extern_weak"].join("|")})\\s+`), "");
  return `declare ${d.trim()}`;
}

/** Strip module-local linkage so a promoted symbol is visible to the other units. */
function promoteDefinition(text: string): string {
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? "" : text.slice(nl);
  return first.replace(/^define\s+(?:private|internal)\s+/, "define ")
              .replace(/^(@\S+\s*=\s*)(?:private|internal)\s+/, "$1") + rest;
}

/**
 * End index of the LLVM type starting at `start`, tracking bracket depth so aggregate
 * types survive intact. A plain `\S+` scan stops inside `[19 x i8]` at the space and
 * yields `[19`, which is accepted nowhere and is the kind of truncation that shows up as
 * a parse error hundreds of lines away.
 */
function endOfType(text: string, start: number): number {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "[" || c === "{" || c === "<" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ">" || c === ")") depth--;
    else if (/\s/.test(c) && depth === 0) break;
  }
  return i;
}

/** A global's definition rewritten as a declaration for units that only read it. */
export function externDeclFor(text: string): string | null {
  // `@g = [linkage] [quals] {global|constant} <type> <init>` becomes the same prefix with
  // `external` linkage and the initializer dropped.
  const m = /^(@\S+\s*=\s*)(?:private\s+|internal\s+|external\s+|weak\s+|weak_odr\s+|linkonce\s+|linkonce_odr\s+|common\s+|appending\s+)?((?:unnamed_addr\s+|local_unnamed_addr\s+|thread_local(?:\([^)]*\))?\s+|dso_local\s+|dso_preemptable\s+|externally_initialized\s+|constant\s+|global\s+)*)/.exec(text);
  if (!m) return null;
  const quals = m[2]!.replace(/\b(?:unnamed_addr|local_unnamed_addr|dso_local|dso_preemptable)\s+/g, "").trim();
  if (!/\b(?:global|constant)\b/.test(quals)) return null;
  const typeStart = m[0]!.length;
  const type = text.slice(typeStart, endOfType(text, typeStart)).trim();
  if (!type) return null;
  return `${m[1]}external ${quals} ${type}`;
}

export type SplitStats = { units: number; promoted: number; placement?: Placement; hot?: HotState };

/**
 * Hot-unit input: the previous build's state (null when there is none or it could not be
 * read) and whether to place hot functions at all. Disabled still records hashes, with an
 * empty hot set, so the next enabled build starts from this one.
 */
export type HotOptions = { prev: HotState | null; enabled: boolean };

/**
 * Split `ir` into `units` self-contained LLVM modules that link to the same program.
 * Returns null when the module cannot be split safely or is too small to be worth it —
 * the caller then compiles the original module unchanged.
 */
export function splitModule(ir: string, units: number, stats?: { out?: SplitStats }, prev?: Placement, hotOpts?: HotOptions): string[] | null {
  if (units < 2) return null;
  const mod = parseModule(ir);
  if (!mod) return null;
  // Below this the per-process clang startup and the duplicated preamble cost more than
  // the parallelism returns.
  if (mod.funcs.length < units * 4) return null;

  let hotState: HotState | undefined;
  if (hotOpts) {
    hotState = selectHot(mod.funcs, units, hotOpts.prev);
    if (!hotOpts.enabled) hotState.hot = [];
  }
  const hotSet = new Set(hotState?.hot ?? []);
  const packed: { placement?: Placement } = {};
  let home: number[];
  let totalUnits = units;
  if (hotSet.size === 0) {
    home = packFunctions(mod.funcs, units, prev, packed);
  } else {
    // Hot functions sit out the packing entirely, so everything else keeps the sticky
    // placement it had.
    const coldIdx: number[] = [];
    mod.funcs.forEach((f, i) => { if (!hotSet.has(f.name)) coldIdx.push(i); });
    const coldHome = packFunctions(coldIdx.map(i => mod.funcs[i]!), units, prev, packed);
    home = new Array<number>(mod.funcs.length).fill(units);
    coldIdx.forEach((i, k) => { home[i] = coldHome[k]!; });
    totalUnits = units + 1;
    // Remember where a hot function lived, so when it is evicted it returns to that unit
    // and the unit's IR (and cached object) can come back byte-identical.
    if (prev && packed.placement) {
      for (const name of hotSet) {
        for (const key of [moduleKey(name), name]) {
          const u = prev.get(key);
          if (u !== undefined && !packed.placement.has(key)) packed.placement.set(key, u);
        }
      }
    }
  }
  const funcHome = new Map<string, number>();
  mod.funcs.forEach((f, i) => funcHome.set(f.name, home[i]!));

  // Which unit references which symbol. A global's initializer can name another global,
  // so those count as references too and are attributed to the referencing global's unit
  // once that is known — resolved by giving every multiply-referenced global unit 0.
  const refs = new Map<string, Set<number>>();
  const noteRef = (name: string, unit: number) => {
    let s = refs.get(name);
    if (!s) refs.set(name, (s = new Set()));
    s.add(unit);
  };
  const funcRefs = mod.funcs.map(f => referencedSymbols(f.text));
  funcRefs.forEach((syms, i) => {
    for (const sym of syms) noteRef(sym, home[i]!);
  });

  const globalByName = new Map(mod.globals.map(g => [g.name, g]));
  // A global naming another global forces both to unit 0: the reference is not inside any
  // function, so there is no unit that can privately own the pair.
  const forcedToZero = new Set<string>();
  const globalRefs = mod.globals.map(g => referencedInGlobal(g.text));
  for (const [gi, g] of mod.globals.entries()) {
    for (const sym of globalRefs[gi]!) {
      if (sym !== g.name && globalByName.has(sym)) { forcedToZero.add(sym); forcedToZero.add(g.name); }
    }
  }

  const globalHome = new Map<string, number>();
  for (const g of mod.globals) {
    const seen = refs.get(g.name);
    if (forcedToZero.has(g.name) || !seen || seen.size !== 1) globalHome.set(g.name, 0);
    else globalHome.set(g.name, [...seen][0]!);
  }
  // A global's initializer can name a function (a trait object's itable), which makes that
  // function referenced from the global's unit. Missing this left the unit with an
  // undefined symbol, so every program with a trait object fell back to one module.
  const funcNames = new Set(mod.funcs.map(f => f.name));
  for (const [gi, g] of mod.globals.entries()) {
    for (const sym of globalRefs[gi]!) if (funcNames.has(sym)) noteRef(sym, globalHome.get(g.name)!);
  }

  // Promotion set: module-local symbols reachable from a unit that is not their home.
  // Renaming them is not cosmetic — an `internal` Milo function may share a name with a
  // libc symbol (`read`, `open`), and making it externally visible under that name would
  // let the linker resolve someone else's call to it. The prefix makes collision
  // impossible while keeping the name stable across every unit that refers to it.
  const rename = new Map<string, string>();
  const promote = new Set<string>();
  const crossUnit = (name: string, ownUnit: number | undefined) => {
    const seen = refs.get(name);
    if (!seen || ownUnit === undefined) return false;
    for (const u of seen) if (u !== ownUnit) return true;
    return false;
  };
  for (const f of mod.funcs) {
    if (f.local && crossUnit(f.name, funcHome.get(f.name))) {
      promote.add(f.name);
      rename.set(f.name, `__milo_cgu.${f.name}`);
    }
  }
  for (const g of mod.globals) {
    if (g.local && crossUnit(g.name, globalHome.get(g.name))) {
      promote.add(g.name);
      rename.set(g.name, `__milo_cgu.${g.name}`);
    }
  }

  const applyRename = (text: string) => rename.size === 0 ? text : mapSymbols(text, n => rename.get(n));
  const applyGlobalRename = (text: string) => rename.size === 0 ? text : mapGlobalSymbols(text, n => rename.get(n));
  const renamed = (name: string) => rename.get(name) ?? name;
  const touchesRename = (syms: Set<string>) => {
    if (rename.size === 0) return false;
    for (const s of syms) if (rename.has(s)) return true;
    return false;
  };

  // Everything below that every unit repeats is computed once, not once per unit.
  const declares = mod.declares.map(applyRename);
  const metadata = mod.metadata.map(applyRename);
  const externDeclOfFn: (string | undefined)[] = new Array(mod.funcs.length);
  const externDeclOfGlobal: (string | null | undefined)[] = new Array(mod.globals.length);

  const out: string[] = [];
  for (let u = 0; u < totalUnits; u++) {
    const parts: string[] = [];
    parts.push(...mod.header, "");
    if (mod.typedefs.length) parts.push(...mod.typedefs, "");
    if (declares.length) parts.push(...declares, "");

    // Functions defined elsewhere but called here.
    const externFns: string[] = [];
    for (let i = 0; i < mod.funcs.length; i++) {
      const f = mod.funcs[i]!;
      if (funcHome.get(f.name) === u) continue;
      if (!refs.get(f.name)?.has(u)) continue;
      externFns.push(externDeclOfFn[i] ??= applyRename(declareFor(f.header)));
    }
    if (externFns.length) parts.push(...externFns, "");

    for (let gi = 0; gi < mod.globals.length; gi++) {
      const g = mod.globals[gi]!;
      const gh = globalHome.get(g.name)!;
      if (gh === u) {
        parts.push(applyGlobalRename(promote.has(g.name) ? promoteDefinition(g.text) : g.text));
      } else if (refs.get(g.name)?.has(u)) {
        let decl = externDeclOfGlobal[gi];
        if (decl === undefined) {
          const d = externDeclFor(g.text);
          decl = externDeclOfGlobal[gi] = d === null ? null : applyRename(d);
        }
        if (decl === null) return null;
        parts.push(decl);
      }
    }
    parts.push("");

    for (let i = 0; i < mod.funcs.length; i++) {
      const f = mod.funcs[i]!;
      if (home[i] !== u) continue;
      const text = promote.has(f.name) ? promoteDefinition(f.text) : f.text;
      // promoteDefinition only drops a linkage word, so the scan's symbol set still holds.
      parts.push(touchesRename(funcRefs[i]!) ? applyRename(text) : text, "");
    }

    // Attribute groups and metadata are replicated: a `#0` or `!dbg` attachment that
    // survived into any unit has to resolve there. Unused entries are legal.
    if (mod.attrs.length) parts.push(...mod.attrs);
    if (metadata.length) parts.push(...metadata);
    out.push(parts.join("\n") + "\n");
  }

  // Every function must land in exactly one unit — the whole failure mode of a splitter
  // is emitting a program that links with code missing, so check rather than trust.
  const emitted = new Set<string>();
  for (const f of mod.funcs) emitted.add(renamed(f.name));
  if (emitted.size !== mod.funcs.length) return null;

  if (stats) stats.out = { units: totalUnits, promoted: promote.size, placement: packed.placement, hot: hotState };
  return out;
}
