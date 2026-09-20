// Gate on src/builtin-members.ts, the single source of truth for the method surface
// of receivers the checker dispatches by hand (string, Vec, HashMap, Option, Result,
// int, float, bool).
//
// The table used to exist three times — checker dispatch, suggest.ts names, lsp.ts
// signatures — and nothing compared them, so twelve methods the checker accepted were
// invisible to completion and all sixteen integer arithmetic builtins were missing
// from both other copies. Both directions are checked here:
//
//   forward  — every row compiles: a row naming a method the checker does not
//              dispatch is a lie the editor would offer as a completion.
//   backward — every name the dispatch mentions has a row: a method added to
//              checkMethodCallExpr without a row silently never reaches the LSP.
//
// The forward direction only asserts the name RESOLVES; probes are called with no
// arguments, so "expects 1 argument" is a pass. Anything stricter would mean encoding
// each signature twice. A control probe per receiver asserts the bogus-name path
// really does report `has no method`, so a harness that stopped producing diagnostics
// fails instead of passing everything vacuously.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";
import { BUILTIN_MEMBERS, RETAINING_MEMBERS, GROWING_MEMBERS, type BuiltinReceiver, type BuiltinMember } from "../src/builtin-members";

function errorsOf(src: string): string[] {
  let prog;
  // A probe that will not even parse must fail loudly. Letting the ParseError escape
  // would abort the whole test rather than name the row that produced it.
  try { prog = new Parser(new Lexer(src).tokenize(), src).parse(); }
  catch (e: any) { return [`probe did not parse: ${e.message}`]; }
  return new TypeChecker()
    .check({ ...prog, entryFile: "builtinMembers.milo" } as any)
    .diagnostics.filter(d => d.severity === "error")
    .map(d => d.message);
}

// A receiver declaration per table. `any` piggybacks on an int receiver — its
// members are callable on everything, so any concrete type proves dispatch.
const RECEIVER_DECL: Record<BuiltinReceiver, string> = {
  any: `var r: i64 = 1`,
  string: `var r: string = "ab"`,
  vec: `var r: Vec<i64> = Vec.new()`,
  hashmap: `var r: HashMap<string, i64> = HashMap.new()`,
  heap: `var r: Heap<i64> = Heap(1)`,
  option: `var r: Option<i64> = Option.Some(1)`,
  result: `var r: Result<i64, string> = Result.Ok(1)`,
  int: `var r: i64 = 1`,
  float: `var r: f64 = 1.0`,
  bool: `var r: bool = true`,
};

// `lines`/`splitView`/`codePoints` yield borrowed views and only exist as the head of
// a for-in; codePoints is a pure parser desugar with no expression form at all, so
// probing it as a value would report a missing method that is genuinely there.
function probeSource(decl: string, m: BuiltinMember): string {
  const call = m.sig.startsWith(":") ? `r.${m.name}` : `r.${m.name}()`;
  const body = m.note?.startsWith("for-in only")
    ? `for _p in ${call} { }`
    : `let _x = ${call}`;
  return `fn main() {\n  ${decl}\n  unsafe { ${body} }\n}`;
}

const RECEIVERS = Object.keys(BUILTIN_MEMBERS) as BuiltinReceiver[];

test("the bogus-name control really reports a missing method on every receiver", () => {
  // Without this the forward test passes for free if diagnostics stop being produced.
  for (const recv of RECEIVERS) {
    const errs = errorsOf(probeSource(RECEIVER_DECL[recv], { name: "zzzNotAMethod", sig: "()" }));
    expect(errs.some(e => e.includes("has no method 'zzzNotAMethod'"))).toBe(true);
  }
});

test("every builtin member in the table is dispatched by the checker", () => {
  const missing: string[] = [];
  for (const recv of RECEIVERS) {
    for (const m of BUILTIN_MEMBERS[recv]) {
      const errs = errorsOf(probeSource(RECEIVER_DECL[recv], m));
      if (errs.some(e => e.includes(`has no method '${m.name}'`))) missing.push(`${recv}.${m.name}`);
    }
  }
  expect(missing).toEqual([]);
});

// `json` is dispatched inside checkMethodCallExpr but is not a builtin member: it is
// the auto-stringify coercion for an http context's `ctx.json(struct)` ARGUMENT, and
// the receiver is a user type with its own impl block.
const NOT_MEMBERS = new Set(["json"]);

// Every method name the dispatch mentions, from both forms it uses: direct
// `expr.method === "x"` comparisons and the `[...].includes(expr.method)` lists.
function dispatchedNames(): string[] {
  const src = readFileSync(join(import.meta.dir, "..", "src", "checker.ts"), "utf-8").split("\n");
  const start = src.findIndex(l => l.includes("private checkMethodCallExpr("));
  expect(start).toBeGreaterThan(-1);
  let end = src.length;
  for (let i = start + 1; i < src.length; i++) {
    if (/^ {2}(private |public )?[a-zA-Z_]+\(/.test(src[i]!)) { end = i; break; }
  }
  const body = src.slice(start, end).join("\n");
  expect(end).toBeGreaterThan(start + 100); // the range must be the real function, not a stray match

  const names = new Set<string>();
  for (const m of body.matchAll(/expr\.method === "([a-zA-Z0-9_]+)"/g)) names.add(m[1]!);
  // `const xMethods = ["a", "b"]; ... xMethods.includes(expr.method)`
  for (const decl of body.matchAll(/const (\w+) = \[((?:\s*"[a-zA-Z0-9_]+",?)+)\]/g)) {
    if (!body.includes(`${decl[1]}.includes(expr.method)`)) continue;
    for (const n of decl[2]!.matchAll(/"([a-zA-Z0-9_]+)"/g)) names.add(n[1]!);
  }
  return [...names].sort();
}

test("every method the checker dispatches has a row in the table", () => {
  const tabled = new Set(Object.values(BUILTIN_MEMBERS).flat().map(m => m.name));
  const undocumented = dispatchedNames().filter(n => !tabled.has(n) && !NOT_MEMBERS.has(n));
  expect(undocumented).toEqual([]);
});

test("the dispatch scan finds the arithmetic lists, not just the direct comparisons", () => {
  // Pins the `.includes` half of dispatchedNames: it is the only thing covering the
  // wrapping/saturating/checked families, and a regex that silently stopped matching
  // would make the backward test vacuous for them.
  const found = dispatchedNames();
  for (const n of ["wrappingAdd", "saturatingMul", "checkedRem"]) expect(found).toContain(n);
});

test("no member is listed twice for one receiver", () => {
  for (const recv of RECEIVERS) {
    const names = BUILTIN_MEMBERS[recv].map(m => m.name);
    expect(names.length).toBe(new Set(names).size);
  }
});

// The `retainsArg` / `grows` flags replaced three literal name lists (checker.ts
// retainsParam and checkEscapingClosures both held `["push","insert","set"]`; safety.ts
// held `["push","append","insert","extend"]`). Pinned here as the exact derived sets so
// a flag dropped from a row, or a new growing builtin added without one, is visible.
// `set` and `append` were in the old literals and are in neither set: no builtin
// receiver dispatches either name, so they matched nothing but a user method that
// happened to share the name. `pushStr` and `reserve` were missing from the old growth
// list and do reallocate.
test("the retains/grows flags derive exactly the sets the old literal lists meant", () => {
  expect([...RETAINING_MEMBERS].sort()).toEqual(["extend", "insert", "push"]);
  expect([...GROWING_MEMBERS].sort()).toEqual(["extend", "insert", "push", "pushStr", "reserve"]);
  // A flagged row is a real member: a name flagged on no row would be a phantom again.
  for (const name of [...RETAINING_MEMBERS, ...GROWING_MEMBERS]) {
    expect(RECEIVERS.some(r => BUILTIN_MEMBERS[r].some(m => m.name === name))).toBe(true);
  }
});

// --- signature verification -------------------------------------------------
//
// The forward test above only proves a name resolves. That is not enough: the
// table inherited three signatures from lsp.ts that were simply wrong —
// indexOf/indexOfFrom/lastIndexOf were documented as returning `i64` when all
// three return `Option<i64>`, so the editor told you to write the one thing that
// does not compile. This pins the declared return type against the checker by
// assigning the call to a binding of that type; a wrong type is a mismatch error.
//
// Generic parameters are instantiated per receiver (Vec<i64>, HashMap<string,i64>,
// Option<i64>, Result<i64,string>). Rows whose signature mentions a callback, a
// raw pointer, a borrowed slice, or a for-in-only pseudo-type are SKIPPED — they
// have no single-expression probe. The skip list is asserted below so the set can
// only shrink deliberately, never silently.

const TYPE_ARGS: Partial<Record<BuiltinReceiver, Record<string, string>>> = {
  vec: { T: "i64" },
  hashmap: { K: "string", V: "i64" },
  option: { T: "i64" },
  result: { T: "i64", E: "string" },
  int: { T: "i64" },
  float: { T: "f64" },
};

// A value of each concrete type, for filling in call arguments.
const LITERAL: Record<string, string> = {
  "i64": "1", "u8": "1", "f64": "1.0", "bool": "true", "string": `"a"`,
  "&string": `"a"`, "Vec<i64>": "Vec.new()",
};

// Rows whose receiver has to be more specific than the generic one above.
// `join` exists only on Vec<string>, so probing it against Vec<i64> would report
// a restriction, not a signature mismatch.
const PROBE_OVERRIDE: Record<string, { decl: string; args: Record<string, string> }> = {
  "vec.join": { decl: `var r: Vec<string> = Vec.new()`, args: { T: "string" } },
};

function substitute(t: string, recv: BuiltinReceiver): string {
  const args = TYPE_ARGS[recv] ?? {};
  return t.replace(/\b[A-Z]\b/g, m => args[m] ?? m);
}

// Signatures we cannot build a probe for. Anything matching stays untested here;
// its existence is still covered by the forward test.
function unprobeable(m: BuiltinMember): boolean {
  // for-in-only members have no expression form, so there is nothing to assign.
  if (m.note?.startsWith("for-in only")) return true;
  // A callback parameter is written bare (`(pred)`, `(cmp)`) or as a fn type, and a
  // raw pointer / borrowed slice return has no literal to compare against. Note this
  // inspects the parsed PARAMETERS, not the whole string: matching `key` against the
  // raw signature also hit HashMap's `(key: K)`, silently skipping five real rows.
  if (/=>|\*|&\[|\bU\b|\bF\b/.test(m.sig)) return true;
  const parsed = parseSig(m.sig);
  return parsed === null || parsed.params.some(p => p === "");
}

interface ParsedSig { params: string[]; ret: string | null }

function parseSig(sig: string): ParsedSig | null {
  if (sig.startsWith(":")) return { params: [], ret: sig.slice(1).trim() }; // property, e.g. len
  const m = /^\(([^)]*)\)(?::\s*(.+))?$/.exec(sig);
  if (!m) return null;
  // `name: Type` -> "Type"; a bare `pred` (callback) has no colon and yields "".
  const params = (m[1] ?? "").trim() === "" ? [] : m[1]!.split(",").map(p => p.includes(":") ? p.split(":").slice(1).join(":").trim() : "");
  return { params, ret: m[2]?.trim() ?? null };
}

test("every probeable signature's return type matches what the checker infers", () => {
  const wrong: string[] = [];
  const skipped: string[] = [];
  for (const recv of RECEIVERS) {
    for (const m of BUILTIN_MEMBERS[recv]) {
      if (unprobeable(m)) { skipped.push(`${recv}.${m.name}`); continue; }
      const parsed = parseSig(m.sig);
      if (!parsed) { wrong.push(`${recv}.${m.name}: unparseable sig '${m.sig}'`); continue; }
      const override = PROBE_OVERRIDE[`${recv}.${m.name}`];
      const subst = (t: string) => override
        ? t.replace(/\b[A-Z]\b/g, x => override.args[x] ?? x)
        : substitute(t, recv);
      const args = parsed.params.map(p => LITERAL[subst(p)]);
      if (args.some(a => a === undefined)) { skipped.push(`${recv}.${m.name}`); continue; }
      const call = m.sig.startsWith(":") ? `r.${m.name}` : `r.${m.name}(${args.join(", ")})`;
      const body = parsed.ret === null ? call : `let _x: ${subst(parsed.ret)} = ${call}`;
      const decl = override?.decl ?? RECEIVER_DECL[recv];
      const errs = errorsOf(`fn main() {\n  ${decl}\n  unsafe { ${body} }\n}`);
      if (errs.length > 0) wrong.push(`${recv}.${m.name} (${m.sig}): ${errs[0]}`);
    }
  }
  expect(wrong).toEqual([]);
  // Pin the untestable set: a new row landing here silently would be a signature
  // nothing checks. Shrinking it is good; growing it must be a deliberate edit.
  expect(skipped.sort()).toEqual([
    "any.addrOf",
    // Like vec.ptr: a raw-pointer return has no literal to compare against.
    "heap.ptr",
    "option.andThen", "option.map", "option.orElse", "option.unwrapOrElse",
    "result.andThen", "result.map", "result.mapErr", "result.orElse", "result.unwrapOrElse",
    "string.codePoints", "string.cstr", "string.lines", "string.splitView",
    "vec.all", "vec.any", "vec.each", "vec.enumerate", "vec.filter", "vec.find", "vec.fold",
    "vec.map", "vec.position", "vec.ptr", "vec.reduce", "vec.retain", "vec.slice",
    "vec.sortBy", "vec.sortByKey",
  ].sort());
});
