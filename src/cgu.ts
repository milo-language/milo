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

type Func = {
  name: string;
  /** the `define ... {` line, used to synthesize a cross-unit `declare` */
  header: string;
  text: string;
  lineCount: number;
  local: boolean;
};

type Global = {
  name: string;
  text: string;
  local: boolean;
};

type Module = {
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
// byte string. Must be rebuilt per call — a shared /g regex carries lastIndex between
// callers and would silently skip the head of the next module.
function scanner(): RegExp {
  return new RegExp(String.raw`(?<![-a-zA-Z$._0-9])[c!]"(?:[^"\\]|\\.)*"|@(${IDENT})`, "g");
}

/**
 * Rewrite every `@symbol` reference in `text` through `map` (undefined = leave alone).
 * A char-at-a-time walk here cost 708ms on a 135k-line module — enough to eat the
 * parallelism it exists to enable — so this stays a single native regex pass.
 */
function mapSymbols(text: string, map: (name: string) => string | undefined): string {
  return text.replace(scanner(), (whole, name?: string) => {
    if (name === undefined) return whole;
    const replaced = map(unquote(name));
    return replaced === undefined ? whole : `@${quoteIfNeeded(replaced)}`;
  });
}

function unquote(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

function quoteIfNeeded(name: string): string {
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
function mapGlobalSymbols(text: string, map: (name: string) => string | undefined): string {
  const [head, payload, tail] = aroundBytePayload(text);
  if (!payload) return mapSymbols(head, map);
  return mapSymbols(head, map) + payload + mapSymbols(tail, map);
}

/** Every distinct `@symbol` referenced anywhere in `text`. */
function referencedSymbols(text: string): Set<string> {
  const found = new Set<string>();
  mapSymbols(text, (name) => { found.add(name); return undefined; });
  return found;
}

/** `referencedSymbols` for a global, skipping its byte-string payload. */
function referencedInGlobal(text: string): Set<string> {
  const [head, payload, tail] = aroundBytePayload(text);
  if (!payload) return referencedSymbols(head);
  const found = referencedSymbols(head);
  for (const s of referencedSymbols(tail)) found.add(s);
  return found;
}

function parseModule(ir: string): Module | null {
  const mod: Module = { header: [], typedefs: [], declares: [], globals: [], funcs: [], metadata: [], attrs: [] };
  const lines = ir.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    if (line.startsWith("define")) {
      // Our emitter always closes a function with `}` in column 0, and never emits a
      // nested column-0 `}`; anything else means the shape changed under us, so bail.
      const start = i;
      while (i < lines.length && lines[i] !== "}") i++;
      if (i >= lines.length) return null;
      const text = lines.slice(start, i + 1).join("\n");
      const header = lines[start]!;
      const m = new RegExp(`^define\\s+(.*?)@(${IDENT})\\s*\\(`).exec(header);
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
      const m = new RegExp(`^@(${IDENT})\\s*=\\s*(.*)$`).exec(line);
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
function packFunctions(funcs: Func[], units: number): number[] {
  const load = new Array<number>(units).fill(0);
  const home = new Array<number>(funcs.length).fill(0);

  const groups = new Map<string, number[]>();
  let total = 0;
  funcs.forEach((f, i) => {
    total += f.lineCount;
    const key = moduleKey(f.name);
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });
  const oversize = Math.ceil(total / units) * OVERSIZE_GROUP_FACTOR;

  const items: { idxs: number[]; lines: number }[] = [];
  for (const idxs of groups.values()) {
    const lines = idxs.reduce((n, i) => n + funcs[i]!.lineCount, 0);
    if (lines > oversize) for (const i of idxs) items.push({ idxs: [i], lines: funcs[i]!.lineCount });
    else items.push({ idxs, lines });
  }
  items.sort((a, b) => b.lines - a.lines);
  for (const it of items) {
    let best = 0;
    for (let u = 1; u < units; u++) if (load[u]! < load[best]!) best = u;
    for (const idx of it.idxs) home[idx] = best;
    load[best]! += it.lines;
  }
  return home;
}

/**
 * Turn a `define` header into a `declare` for units that only call the function.
 * Parameter names and `#N` attribute groups are legal on a declaration and the byval /
 * sret / coerce attributes MUST survive: codegen requires the same attribute rendering
 * at the declaration and at every call, or the ABI silently disagrees.
 */
function declareFor(header: string): string {
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
function externDeclFor(text: string): string | null {
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

export type SplitStats = { units: number; promoted: number };

/**
 * Split `ir` into `units` self-contained LLVM modules that link to the same program.
 * Returns null when the module cannot be split safely or is too small to be worth it —
 * the caller then compiles the original module unchanged.
 */
export function splitModule(ir: string, units: number, stats?: { out?: SplitStats }): string[] | null {
  if (units < 2) return null;
  const mod = parseModule(ir);
  if (!mod) return null;
  // Below this the per-process clang startup and the duplicated preamble cost more than
  // the parallelism returns.
  if (mod.funcs.length < units * 4) return null;

  const home = packFunctions(mod.funcs, units);
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
  mod.funcs.forEach((f, i) => {
    for (const sym of referencedSymbols(f.text)) noteRef(sym, home[i]!);
  });

  const globalByName = new Map(mod.globals.map(g => [g.name, g]));
  // A global naming another global forces both to unit 0: the reference is not inside any
  // function, so there is no unit that can privately own the pair.
  const forcedToZero = new Set<string>();
  for (const g of mod.globals) {
    for (const sym of referencedInGlobal(g.text)) {
      if (sym !== g.name && globalByName.has(sym)) { forcedToZero.add(sym); forcedToZero.add(g.name); }
    }
  }

  const globalHome = new Map<string, number>();
  for (const g of mod.globals) {
    const seen = refs.get(g.name);
    if (forcedToZero.has(g.name) || !seen || seen.size !== 1) globalHome.set(g.name, 0);
    else globalHome.set(g.name, [...seen][0]!);
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

  const out: string[] = [];
  for (let u = 0; u < units; u++) {
    const parts: string[] = [];
    parts.push(...mod.header, "");
    if (mod.typedefs.length) parts.push(...mod.typedefs, "");
    if (mod.declares.length) parts.push(...mod.declares.map(applyRename), "");

    // Functions defined elsewhere but called here.
    const externFns: string[] = [];
    for (const f of mod.funcs) {
      if (funcHome.get(f.name) === u) continue;
      if (!refs.get(f.name)?.has(u)) continue;
      externFns.push(applyRename(declareFor(f.header)));
    }
    if (externFns.length) parts.push(...externFns, "");

    for (const g of mod.globals) {
      const gh = globalHome.get(g.name)!;
      if (gh === u) {
        parts.push(applyGlobalRename(promote.has(g.name) ? promoteDefinition(g.text) : g.text));
      } else if (refs.get(g.name)?.has(u)) {
        const decl = externDeclFor(g.text);
        if (!decl) return null;
        parts.push(applyRename(decl));
      }
    }
    parts.push("");

    for (let i = 0; i < mod.funcs.length; i++) {
      const f = mod.funcs[i]!;
      if (home[i] !== u) continue;
      parts.push(applyRename(promote.has(f.name) ? promoteDefinition(f.text) : f.text), "");
    }

    // Attribute groups and metadata are replicated: a `#0` or `!dbg` attachment that
    // survived into any unit has to resolve there. Unused entries are legal.
    if (mod.attrs.length) parts.push(...mod.attrs);
    if (mod.metadata.length) parts.push(...mod.metadata.map(applyRename));
    out.push(parts.join("\n") + "\n");
  }

  // Every function must land in exactly one unit — the whole failure mode of a splitter
  // is emitting a program that links with code missing, so check rather than trust.
  const emitted = new Set<string>();
  for (const f of mod.funcs) emitted.add(renamed(f.name));
  if (emitted.size !== mod.funcs.length) return null;

  if (stats) stats.out = { units, promoted: promote.size };
  return out;
}
