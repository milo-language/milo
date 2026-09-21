// Is every generic std body sound for a `T` that owns heap?
//
// Instantiates every generic pub symbol in std/ with `string` and with a Drop-counting
// struct, drives its documented happy path under AddressSanitizer, and requires that
// every value constructed is destroyed exactly once.
//
// Why this exists: H1 in docs/plans/soundness-sweep-2026-09.md. `Shard.get` did
// `unsafe { self.base[i] }`, a bitwise copy of a Drop `T`, and `Shard<string>` therefore
// double-freed at scope exit. Every existing shard fixture used f64 or i64, where a
// bitwise copy is the right thing, so nothing red was ever seen. A generic std body is
// only sound if it is sound for the `T` that owns heap, and that is the instantiation
// this script exists to make.
//
// Two instantiations per symbol. `string` is the type a user actually reaches for, and
// it is where H1 showed; the oracle for it is ASan alone (a string's release cannot be
// counted from Milo code). `Res` is a struct with an explicit `impl Drop` that bumps a
// global counter and owns a string, so the same program also reports made/gone, and a
// destructor that never runs (which ASan cannot see, since no heap is left dangling) is
// visible as an imbalance. The accounting oracle is scripts/fuzz-drops.ts's, reused
// unchanged: the program prints `made` then `gone`, and the two must agree.
//
// Symbol universe comes from `milo api --json` (docs/json-api.md), never from `src/`.
// The happy path for a method of a generic struct is derived mechanically from its
// signature where a fixture recipe for the struct exists (Arena, HashSet, Channel, ...):
// `T` becomes `mk(n)`, `Handle<T>` becomes the handle the fixture allocated, a callback
// becomes a closure that peeks at the value. Everything the deriver cannot spell
// (shatter/windows/weld, Promise await, BufReader over a BytesReader, raw pointers) sits
// in SEEDS below, keyed by symbol name. A symbol with neither is reported as uncovered
// with that reason; nothing is skipped silently. The `covered N / M` line is the gate.
//
// Accept-direction asymmetry, as in scripts/fuzz-ownership.ts: a program the checker
// REJECTS is counted and its first diagnostic shown, not investigated. `HashSet<Res>`
// is rejected because Res is not hashable, and that is the checker doing its job. A
// reject whose location is inside std/ is called out separately: it means the generic
// body is not valid for this T, which a user would meet as an error in code they did
// not write.
//
//   bun scripts/fuzz-generic-drop.ts                       # full pass
//   bun scripts/fuzz-generic-drop.ts --filter=Shard        # symbols whose name contains "Shard"
//   bun scripts/fuzz-generic-drop.ts --limit=10 --seed=3   # first 10 symbols, different sizes
//   bun scripts/fuzz-generic-drop.ts --keep                # keep the scratch dir with every program
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { guardedRun } from "./guard";

const ROOT = join(import.meta.dir, "..");
const MILO = join(ROOT, "src", "main.ts");
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: bun scripts/fuzz-generic-drop.ts [--filter=<name>] [--limit=N] [--seed=N] [--keep] [--verbose]");
  process.exit(0);
}
const FILTER = flag("filter")?.toLowerCase() ?? null;
const LIMIT = flag("limit") ? parseInt(flag("limit")!, 10) : Infinity;
const SEED = flag("seed") ? parseInt(flag("seed")!, 10) : 1;
const KEEP = argv.includes("--keep");
const VERBOSE = argv.includes("--verbose");
const REDUCE_PROBES = 40;
const REDUCE_TIMEOUT_MS = 8000;

// Seeded PRNG so a run is reproducible from the seed in the report. The seed only
// varies sizes (element counts, window counts, id offsets); the shapes are fixed.
let state = SEED >>> 0 || 1;
function rnd(): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

// ── the symbol universe ───────────────────────────────────────────────────────

interface ApiEntry {
  kind: "function" | "type";
  module: string;
  name: string;
  signature: string;
  params?: { name: string; type: string }[];
  returns?: string;
}

interface Symbol {
  name: string;          // "Shard.get" or "shatter"
  module: string;        // "std/shard"
  owner: string | null;  // "Shard" for a method, null for a free fn
  params: { name: string; type: string }[];
  returns: string;
  signature: string;
}

function universe(): { symbols: Symbol[]; genericTypes: Map<string, string> } {
  const raw = execFileSync("bun", ["run", MILO, "api", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  const api = JSON.parse(raw) as { schema: number; entries: ApiEntry[] };
  if (api.schema !== 1) throw new Error(`milo api --json schema ${api.schema}; this script reads schema 1`);
  // Generic type name -> its type-parameter list, e.g. Shard -> "T", Mapped -> "T, S".
  const genericTypes = new Map<string, string>();
  for (const e of api.entries) {
    if (e.kind !== "type") continue;
    const m = /^pub (?:struct|enum) (\w+)<([^>]+)>/.exec(e.signature);
    if (m) genericTypes.set(m[1]!, m[2]!);
  }
  const symbols: Symbol[] = [];
  for (const e of api.entries) {
    if (e.kind !== "function") continue;
    const m = /^(?:pub )?fn (\w+)(?:\.(\w+))?(<[^(]*>)?\(/.exec(e.signature);
    if (!m) throw new Error(`unparsed signature from api --json: ${e.signature}`);
    const [, first, method, typeParams] = m;
    const isMethodOfGeneric = method !== undefined && genericTypes.has(first!);
    const isGenericFn = method === undefined && typeParams !== undefined;
    if (!isMethodOfGeneric && !isGenericFn) continue;
    symbols.push({
      name: e.name, module: e.module, owner: method ? first! : null,
      params: e.params ?? [], returns: e.returns ?? "void", signature: e.signature,
    });
  }
  return { symbols, genericTypes };
}

// ── instantiations ────────────────────────────────────────────────────────────

interface Inst {
  name: "string" | "res";
  T: string;
  countsDrops: boolean;
  prelude: (n: number) => string;
}

// Both preludes expose the same vocabulary so a happy path is written once:
//   mk(n): T          a fresh heap-owning value (counted in `made`)
//   peek(x: &T): i64  observe a value without taking it
//   mkVec(n): Vec<T>  n fresh values
// The `made`/`gone` pair is the fuzz-drops oracle. For `string` there is no drop hook,
// so `gone` stays 0 and only ASan judges the run; the program still prints both so the
// two instantiations share one runner.
const STRING_INST: Inst = {
  name: "string", T: "string", countsDrops: false,
  prelude: (n) => `var made: i64 = 0
var gone: i64 = 0

fn mk(n: i64): string {
    made = made + 1
    return "s".repeat(${n} + n)
}

fn peek(x: &string): i64 {
    return x.len
}

fn mkVec(n: i64): Vec<string> {
    var v: Vec<string> = Vec.new()
    for i in 0..n {
        v.push(mk(i + 1))
    }
    return v
}
`,
};

const RES_INST: Inst = {
  name: "res", T: "Res", countsDrops: true,
  prelude: (n) => `var made: i64 = 0
var gone: i64 = 0

// Owns heap AND counts its destructor, so a bitwise copy is visible to ASan (the string
// frees twice) and a skipped destructor is visible as made != gone.
struct Res {
    id: i64,
    tag: string,
}

impl Drop for Res {
    fn drop(self: &mut Self): void {
        gone = gone + 1
    }
}

// A clone is a construction: containers that hand values out by cloning (Vec indexing
// inside Arena.get) must balance too, and a copy that bypasses this impl shows as an
// extra destruction.
impl Clone for Res {
    fn clone(self: &Self): Self {
        made = made + 1
        return Res {
            id: self.id, tag: self.tag.clone()
        }
    }
}

fn mk(n: i64): Res {
    made = made + 1
    return Res {
        id: n, tag: "r".repeat(${n} + n)
    }
}

fn peek(x: &Res): i64 {
    return x.tag.len
}

fn mkVec(n: i64): Vec<Res> {
    var v: Vec<Res> = Vec.new()
    for i in 0..n {
        v.push(mk(i + 1))
    }
    return v
}
`,
};

const INSTS = [STRING_INST, RES_INST];

// ── happy paths ───────────────────────────────────────────────────────────────

interface Path {
  imports: Record<string, string[]>;  // module -> names
  body: string[];                     // statements inside main's block, `T` spelled literally
  decls?: string;                     // top-level declarations the body needs (plain fns for parallelMap)
}

// Fixture recipe for a generic struct: how to obtain a populated value of it, and what
// the mechanical deriver may pass for each parameter type it meets. `T` is spelled
// literally and substituted per instantiation.
interface Fixture {
  imports: Record<string, string[]>;
  setup: string[];
  self: string;
  vars: Record<string, string>;
}

const FIXTURES: Record<string, Fixture> = {
  Arena: {
    imports: { "std/arena": ["Arena", "Handle"] },
    setup: ["var a: Arena<T> = Arena<T>.new()", "let h = a.alloc(mk(1))", "let h2 = a.alloc(mk(2))", "sink = sink + a.valid(h2).toString().len"],
    self: "a", vars: { "Handle<T>": "h" },
  },
  FrozenArena: {
    imports: { "std/arena": ["Arena", "FrozenArena", "Handle"] },
    setup: ["var a: Arena<T> = Arena<T>.new()", "let h = a.alloc(mk(1))", "let h2 = a.alloc(mk(2))", "sink = sink + a.valid(h2).toString().len", "let f = a.freeze()!"],
    self: "f", vars: { "Handle<T>": "h" },
  },
  GrowOnlyArena: {
    imports: { "std/arena": ["Arena", "GrowOnlyArena", "Handle"] },
    setup: ["var a: Arena<T> = Arena<T>.new()", "let h = a.alloc(mk(1))", "let h2 = a.alloc(mk(2))", "sink = sink + a.valid(h2).toString().len", "var g = a.sealGrowth()!"],
    self: "g", vars: { "Handle<T>": "h" },
  },
  HashSet: {
    imports: { "std/set": ["HashSet"] },
    setup: ["var s: HashSet<T> = HashSet<T>.new()", "s.add(mk(1))", "s.add(mk(2))", "var o: HashSet<T> = HashSet<T>.new()", "o.add(mk(2))", "o.add(mk(3))"],
    self: "s", vars: { "&HashSet<T>": "o", "Vec<T>": "mkVec(3)" },
  },
  Channel: {
    imports: { "std/sync": ["Channel"] },
    setup: ["let c = Channel<T>.new(4)!", "c.send(mk(1))!", "c.send(mk(2))!"],
    self: "c", vars: {},
  },
};

// Strip references and type arguments: "&mut Arena<T>" -> "Arena".
const bareType = (t: string) => t.replace(/^&(mut )?/, "").replace(/<.*$/, "");

// Synthesize an argument for one parameter, or return null when the deriver has no
// spelling for that type (which sends the symbol to the seed table).
function argFor(type: string, anchor: string, fixture: Fixture, pre: string[], k: number): string | null {
  if (type in fixture.vars) return fixture.vars[type]!;
  if (bareType(type) === anchor) return fixture.self;
  switch (type) {
    case "T": return `mk(${10 + k})`;
    case "&T": pre.push(`let t${k} = mk(${10 + k})`); return `t${k}`;
    case "&Vec<T>": pre.push(`let v${k} = mkVec(3)`); return `v${k}`;
    case "Vec<T>": return "mkVec(3)";
    case "i64": return "0";
    case "bool": return "true";
    case "(T) => T": return "(v: T): T => v";
    case "(&T) => void": return "(v: &T): void => {\n            sink = sink + peek(v)\n        }";
    case "(&mut T) => void": return "(v: &mut T): void => {\n            sink = sink + peek(v)\n        }";
    case "(&T) => R": return "(v: &T): i64 => peek(v)";
  }
  return null;
}

// The mechanical happy path: fixture setup, then one call spelled from the signature.
function derive(sym: Symbol): Path | null {
  const params = sym.params.filter(p => p.name !== "self");
  const selfParam = sym.params.find(p => p.name === "self");
  // A free fn is anchored on the generic struct its first parameter names.
  const anchor = sym.owner ?? (params[0] ? bareType(params[0].type) : null);
  const fixture = anchor && anchor in FIXTURES ? FIXTURES[anchor]! : null;
  if (!fixture) return null;
  const pre: string[] = [];
  const args: string[] = [];
  const isFree = sym.owner === null;
  // A `&mut T` parameter takes `&mut x` at the call (the explicit-mut rule); a fixture
  // value is always a `var`, so the spelling is the only thing the rule adds.
  const spell = (type: string, a: string) => (/^&mut /.test(type) ? `&mut ${a}` : a);
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (isFree && i === 0) { args.push(spell(p.type, fixture.self)); continue; }
    const a = argFor(p.type, anchor!, fixture, pre, i);
    if (a === null) return null;
    args.push(spell(p.type, a));
  }
  let call: string;
  if (isFree) call = `${sym.name}(${args.join(", ")})`;
  else if (selfParam) call = `${fixture.self}.${sym.name.split(".")[1]}(${args.join(", ")})`;
  else call = `${sym.owner}<T>.${sym.name.split(".")[1]}(${args.join(", ")})`;
  if (/^Result</.test(sym.returns)) call += "!";
  const stmt = sym.returns === "void" ? call : `let r = ${call}`;
  const imports = { ...fixture.imports };
  if (isFree) imports[sym.module] = [...(imports[sym.module] ?? []), sym.name.split(".")[0]!];
  return { imports, body: [...fixture.setup, ...pre, stmt] };
}

// Seeds: happy paths the deriver cannot spell, one per symbol, keyed by api name.
// Sizes come from the seeded PRNG so `--seed` changes element and window counts.
// The manual shatter/windows/weld path is private (WP3), so every Shard method is
// exercised inside a parallelMap worker. The worker is a plain fn (a closure cannot be
// copied to N threads) and must not touch globals (it runs on an OS thread), so `ops`
// see the window as `w` and the body only reads the welded result.
const SHARD_PROBE = (n: number, workers: number, ops: string[]): Path => ({
  imports: { "std/shard": ["Shard", "parallelMap"] },
  decls: `fn probe(w: Shard<T>): Shard<T> {
${ops.map(o => "    " + o).join("\n")}
    return w
}
`,
  body: [`let out = parallelMap(mkVec(${n}), ${workers}, probe)`, "sink = sink + out.len"],
});
const TOUCH_DECL = `fn touch(w: Shard<T>): Shard<T> {
    for i in 0..w.len() {
        let x = w.get(i)
        w.set(i, x)
    }
    return w
}
`;
const PROMISE_IMPORTS = { "std/runtime": ["Promise"] };

const SEEDS: Record<string, () => Path> = {
  // std/shard
  "Shard.get": () => SHARD_PROBE(between(2, 6), between(1, 2), ["let x = w.get(0)", "w.set(0, x)"]),
  "Shard.set": () => SHARD_PROBE(between(2, 6), between(1, 2), ["w.set(0, mk(9))"]),
  "Shard.len": () => SHARD_PROBE(between(2, 6), between(1, 3), ["let _n = w.len()"]),
  "Shard.index": () => SHARD_PROBE(between(2, 6), between(1, 3), ["let _i = w.index()"]),
  "Shard.start": () => SHARD_PROBE(between(2, 6), between(1, 3), ["let _s = w.start()"]),
  "parallelMap": () => ({ imports: { "std/shard": ["Shard", "parallelMap"] }, decls: TOUCH_DECL, body: [
    `let out = parallelMap(mkVec(${between(2, 8)}), ${between(1, 3)}, touch)`, "sink = sink + out.len",
  ] }),
  "parallelMapWith": () => ({ imports: { "std/shard": ["Shard", "Mapped", "parallelMapWith"] }, decls: `struct Acc {
    n: i64,
}

fn touchWith(w: Shard<T>, e: &mut Acc): Shard<T> {
    for i in 0..w.len() {
        let x = w.get(i)
        w.set(i, x)
        e.n = e.n + 1
    }
    return w
}
`, body: [
    "var states: Vec<Acc> = Vec.new()", "states.push(Acc {\n            n: 0\n        }\n        )", "states.push(Acc {\n            n: 0\n        }\n        )",
    `let out = parallelMapWith(mkVec(${between(2, 8)}), ${between(1, 4)}, states, touchWith)!`,
    "sink = sink + out.data.len + out.states.len",
  ] }),

  // std/arena: the one free fn whose T is not inferable from an argument.
  "arenaNew": () => ({ imports: { "std/arena": ["Arena", "arenaNew"] }, body: [
    "var a: Arena<T> = arenaNew()", "let h = a.alloc(mk(1))", "sink = sink + a.valid(h).toString().len",
  ] }),

  // std/runtime. `mk` bumps a global, so it may not run on the OS thread a blocking
  // worker is; the value is built here and carried into the closure by move.
  "Promise.blocking": () => ({ imports: PROMISE_IMPORTS, body: [
    "let v = mk(1)", "let p = Promise<T>.blocking(move (): T => v)", "let x = p.await()!", "sink = sink + peek(x)",
  ] }),
  "Promise.run": () => ({ imports: PROMISE_IMPORTS, body: [
    "let p = Promise<T>.run((): T => mk(1))", "let x = p.await()!", "sink = sink + peek(x)",
  ] }),
  "Promise.await": () => ({ imports: PROMISE_IMPORTS, body: [
    "let v = mk(1)", "let p = Promise<T>.blocking(move (): T => v)", "let x = p.await()!", "sink = sink + peek(x)",
  ] }),
  "Promise.channel": () => ({ imports: { ...PROMISE_IMPORTS, "std/sync": ["Channel"] }, body: [
    "let v = mk(1)", "let p = Promise<T>.blocking(move (): T => v)", "let ch = p.channel()", "sink = sink + ch.len()",
    "let x = p.await()!", "sink = sink + peek(x)",
  ] }),
  "promiseAll": () => ({ imports: { "std/runtime": ["Promise", "promiseAll"] }, body: [
    "var ps: Vec<Promise<T>> = Vec.new()",
    `for k in 0..${between(1, 4)} {`, "    let v = mk(k)", "    ps.push(Promise<T>.blocking(move (): T => v))", "}",
    "let all = promiseAll(ps).await()!", "sink = sink + all.len",
  ] }),
  "promiseRace": () => ({ imports: { "std/runtime": ["Promise", "promiseRace"] }, body: [
    "var ps: Vec<Promise<T>> = Vec.new()",
    `for k in 0..${between(1, 4)} {`, "    let v = mk(k)", "    ps.push(Promise<T>.blocking(move (): T => v))", "}",
    "let first = promiseRace(ps).await()!", "sink = sink + peek(first)",
  ] }),

  // std/sync: the fixture's two pending values make recv/next non-blocking.
  "Channel.rawPtr": () => ({ imports: { "std/sync": ["Channel"] }, body: [
    "let c = Channel<T>.new(4)!", "c.send(mk(1))!", "let p = c.rawPtr()", "sink = sink + (p as i64 != 0).toString().len",
  ] }),

  // std/select: a value already queued means wait() returns without parking.
  "selectRecv": () => ({ imports: { "std/sync": ["Channel"], "std/select": ["Select", "selectRecv"] }, body: [
    "let c = Channel<T>.new(4)!", "c.send(mk(1))!",
    "var sel = Select.new()", "selectRecv(&mut sel, c)", "sel.onTimeout(5000)", "let w = sel.wait()", "sel.destroy()",
    "sink = sink + w", "let x = c.recv()!", "sink = sink + peek(x)",
  ] }),
  "selectSend": () => ({ imports: { "std/sync": ["Channel"], "std/select": ["Select", "selectSend"] }, body: [
    "let c = Channel<T>.new(4)!",
    "var sel = Select.new()", "selectSend(&mut sel, c)", "sel.onTimeout(5000)", "let w = sel.wait()", "sel.destroy()",
    "sink = sink + w", "c.send(mk(1))!", "let x = c.recv()!", "sink = sink + peek(x)",
  ] }),

  // std/timer
  "recvTimeout": () => ({ imports: { "std/sync": ["Channel"], "std/time": ["Duration"], "std/timer": ["recvTimeout"] }, body: [
    "let c = Channel<T>.new(4)!", "c.send(mk(1))!",
    "match recvTimeout(c, Duration.millis(500)) {", "    Option.Some(x) => {", "        sink = sink + peek(x)", "    }",
    "    Option.None => {", "        sink = sink + 1", "    }", "}",
  ] }),

  // std/seal: R is the closure's return type, so T rides out of the closure.
  "sharedWith": () => ({ imports: { "std/seal": ["Sealed", "Shared", "seal", "sharedWith"] }, body: [
    "let src = seal(\"abc\".clone())", "let sh = src.share()",
    "let x = sharedWith(sh, (s: &Sealed): T => mk(s.len()))", "sink = sink + peek(x)",
  ] }),

  // std/foreign: forget then adopt is the documented round trip; the adopted owner
  // is what frees.
  "adopt": () => ({ imports: { "std/foreign": ["adopt"] }, body: [
    "let hp = Heap(mk(1))",
    "unsafe {", "    let raw = hp.ptr()", "    forget(hp)",
    "    match adopt(raw) {", "        Option.Some(box) => {", "            sink = sink + 1", "        }",
    "        Option.None => {", "            sink = sink + 2", "        }", "    }", "}",
  ] }),
  "adoptSlice": () => ({ imports: { "std/foreign": ["adoptSlice"] }, body: [
    `var src = mkVec(${between(1, 5)})`, "let n = src.len",
    "unsafe {", "    let data = src.ptr()", "    forget(src)",
    "    match adoptSlice(data, n) {", "        Option.Some(v) => {", "            sink = sink + v.len", "        }",
    "        Option.None => {", "            sink = sink + 2", "        }", "    }", "}",
  ] }),
  "withRaw": () => ({ imports: { "std/foreign": ["withRaw"] }, body: [
    `var src = mkVec(${between(1, 5)})`,
    "unsafe {", "    let data = src.ptr()",
    "    let n = withRaw(data, src.len, (xs: &[T]): i64 => xs.len)", "    sink = sink + n!", "}",
  ] }),
  "withRawMut": () => ({ imports: { "std/foreign": ["withRawMut"] }, body: [
    `var src = mkVec(${between(1, 5)})`,
    "unsafe {", "    let data = src.ptr()",
    "    let n = withRawMut(data, src.len, (xs: &mut [T]): i64 => xs.len)", "    sink = sink + n!", "}",
  ] }),

  // std/testing: T needs `==`, so only the string instantiation can be accepted.
  "assertEq": () => ({ imports: { "std/testing": ["assertEq"] }, body: ["let a = mk(1)", "let b = mk(1)", "assertEq(a, b)"] }),
  "assertNe": () => ({ imports: { "std/testing": ["assertNe"] }, body: ["let a = mk(1)", "let b = mk(2)", "assertNe(a, b)"] }),
  "assertVecEq": () => ({ imports: { "std/testing": ["assertVecEq"] }, body: ["let a = mkVec(2)", "let b = mkVec(2)", "assertVecEq(a, b)"] }),
};

// std/io's generics are bounded by Reader/Writer, not by an element type: `T` there is
// the stream, and the string/Res instantiations do not apply. Their happy path is the
// in-memory adapters, run once, and they count as covered when that program is clean.
const IO_IMPORTS = { "std/io": ["BufReader", "BufWriter", "BytesReader", "BytesWriter", "copyStream"] };
const IO_READER = ["var r = BufReader<BytesReader>.withCapacity(BytesReader.new(\"alpha\\nbeta\\ngamma\"), 4)"];
const IO_WRITER = ["var w = BufWriter<BytesWriter>.withCapacity(BytesWriter.new(), 8)"];
const IO_SEEDS: Record<string, string[]> = {
  "BufReader.new": ["var r = BufReader<BytesReader>.new(BytesReader.new(\"alpha\\nbeta\"))", "sink = sink + r.readAll()!.len"],
  "BufReader.withCapacity": [...IO_READER, "sink = sink + r.readAll()!.len"],
  "BufReader.readAll": [...IO_READER, "sink = sink + r.readAll()!.len"],
  "BufReader.readByte": [...IO_READER, "sink = sink + r.readByte()!"],
  "BufReader.readExact": [...IO_READER, "sink = sink + r.readExact(3)!.len"],
  "BufReader.readLine": [...IO_READER, "match r.readLine()! {", "    Option.Some(line) => {", "        sink = sink + line.len", "    }", "    Option.None => {", "        sink = sink + 1", "    }", "}"],
  "BufReader.readUntil": [...IO_READER, "match r.readUntil(10)! {", "    Option.Some(line) => {", "        sink = sink + line.len", "    }", "    Option.None => {", "        sink = sink + 1", "    }", "}"],
  "BufWriter.new": ["var w = BufWriter<BytesWriter>.new(BytesWriter.new())", "w.writeLine(\"abc\")!", "w.flush()!", "sink = sink + w.pending()"],
  "BufWriter.withCapacity": [...IO_WRITER, "w.writeLine(\"abc\")!", "w.flush()!", "sink = sink + w.pending()"],
  "BufWriter.writeByte": [...IO_WRITER, "w.writeByte(100)!", "w.flush()!", "sink = sink + w.pending()"],
  "BufWriter.writeLine": [...IO_WRITER, "w.writeLine(\"abcdefghijklmnop\")!", "w.flush()!", "sink = sink + w.pending()"],
  "BufWriter.pending": [...IO_WRITER, "w.writeByte(100)!", "sink = sink + w.pending()", "w.flush()!"],
  "copyStream": ["var src = BytesReader.new(\"hello world\")", "var dst = BytesWriter.new()", "sink = sink + copyStream(src, dst)!"],
};

// ── program assembly ──────────────────────────────────────────────────────────

function render(path: Path, inst: Inst, sizeSeed: number): string {
  const sub = (s: string) => s.replace(/\bT\b/g, inst.T);
  const imports = Object.entries(path.imports)
    .map(([mod, names]) => `from "${mod}" import {\n    ${[...new Set(names)].join(", ")}\n}`)
    .join("\n");
  const body = path.body.map(l => "        " + sub(l)).join("\n");
  return `${imports}

${inst.prelude(sizeSeed)}
${path.decls ? sub(path.decls) : ""}
pub fn main(): i32 {
    var sink: i64 = 0
    if true {
${body}
    }
    print(sink)
    print(made)
    print(gone)
    return 0
}
`;
}

// ── the oracles ───────────────────────────────────────────────────────────────

type Verdict =
  | { kind: "ok" }
  | { kind: "rejected"; inStd: boolean; diagnostic: string }
  | { kind: "asan"; what: string }
  | { kind: "drop-imbalance"; made: string; gone: string }
  | { kind: "crash"; detail: string }
  // A `!` on an Err the callee returned on purpose (`Channel.new(0)` refuses a
  // non-positive capacity): the program ended by a checked refusal, not a memory bug.
  // Still judged by ASan and drop accounting above, since the refusal path drops too.
  | { kind: "refused"; detail: string };

// The SUMMARY line names the bug class bare (`double-free`); the ERROR line wraps it in
// prose (`attempting double-free on 0x...`), so it is only the fallback.
const ASAN_SUMMARY = /SUMMARY: AddressSanitizer: ([a-z-]+)/;
const ASAN_REPORT = /ERROR: AddressSanitizer: ([^\n]*)/;
const ANSI = /\x1b\[[0-9;]*m/g;

async function judge(file: string, bin: string, inst: Inst, timeoutMs = 60000): Promise<Verdict> {
  try {
    execFileSync("bun", ["run", MILO, "build", file, "-o", bin, "--sanitize"], { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    const text = `${err.stderr ?? ""}${err.stdout ?? ""}`.replace(ANSI, "");
    const lines = text.split("\n");
    const errAt = lines.findIndex(l => /^error/.test(l));
    const diagnostic = (lines[errAt] ?? lines.find(l => l.trim()) ?? "build failed").trim();
    // The location line follows the message: `──> /path/std/shard.milo:87:13`.
    const loc = lines.slice(errAt, errAt + 3).find(l => /──>/.test(l)) ?? "";
    return { kind: "rejected", inStd: /\/std\/[\w.-]+\.milo:\d+/.test(loc), diagnostic: diagnostic.slice(0, 160) };
  }
  // MallocScribble under ASan, as fuzz-ownership does: a freed block that ASan somehow
  // misses still reads back as garbage rather than as the right answer.
  const r = await guardedRun(bin, [], {
    env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0", MallocScribble: "1" }, timeoutMs,
  });
  if (r.guardKill) return { kind: "crash", detail: `guard killed the program (${r.guardKill}): hang or runaway` };
  const text = r.stderr + r.stdout;
  const m = ASAN_SUMMARY.exec(text) ?? ASAN_REPORT.exec(text);
  if (m) return { kind: "asan", what: m[1]!.trim().slice(0, 80) };
  const firstErr = (r.stderr.split("\n").find(l => l.trim()) ?? "").trim();
  if (r.code !== 0 && /^error at \S+:\d+:\d+: /.test(firstErr)) return { kind: "refused", detail: firstErr.slice(0, 120) };
  if (r.code !== 0) return { kind: "crash", detail: `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}: ${firstErr.slice(0, 120)}` };
  const out = r.stdout.trim().split("\n");
  const made = out[out.length - 2] ?? "?", gone = out[out.length - 1] ?? "?";
  if (inst.countsDrops && (made !== gone || made === "?")) return { kind: "drop-imbalance", made, gone };
  return { kind: "ok" };
}

const verdictClass = (v: Verdict) => v.kind === "asan" ? `asan:${v.what}` : v.kind;
type Rejected = Extract<Verdict, { kind: "rejected" }>;
const isRejected = (v: Verdict): v is Rejected => v.kind === "rejected";

// Line-level ddmin over the happy-path body: each probe costs a clang build, so the
// unit is a statement, not a token. Interestingness is the same failure class, so the
// reducer cannot wander onto a different, shallower bug.
async function reduce(path: Path, inst: Inst, sizeSeed: number, cls: string, dir: string, tag: string): Promise<string[]> {
  let body = path.body;
  let probes = 0;
  const interesting = async (cand: string[]) => {
    if (probes >= REDUCE_PROBES) return false;
    const file = join(dir, `${tag}.reduce${probes}.milo`);
    const bin = join(dir, `${tag}.reduce${probes}`);
    probes++;
    writeFileSync(file, render({ ...path, body: cand }, inst, sizeSeed));
    // A probe that removed the statement which made a thread finish now hangs; 60s per
    // probe would turn one finding into a 40-minute reduction. Hangs are "not interesting".
    return verdictClass(await judge(file, bin, inst, REDUCE_TIMEOUT_MS)) === cls;
  };
  let n = 2;
  while (body.length >= 2 && probes < REDUCE_PROBES) {
    const chunk = Math.ceil(body.length / n);
    let shrank = false;
    for (let i = 0; i < body.length; i += chunk) {
      const cand = [...body.slice(0, i), ...body.slice(i + chunk)];
      if (cand.length === 0) continue;
      if (await interesting(cand)) { body = cand; n = Math.max(n - 1, 2); shrank = true; break; }
    }
    if (!shrank) {
      if (n >= body.length) break;
      n = Math.min(n * 2, body.length);
    }
  }
  return body;
}

// ── main ──────────────────────────────────────────────────────────────────────

interface Outcome { sym: Symbol; inst: string; verdict: Verdict; file: string }

const { symbols } = universe();
const selected = symbols
  .filter(s => !FILTER || s.name.toLowerCase().includes(FILTER))
  .slice(0, LIMIT);
const dir = mkdtempSync(join(tmpdir(), "milo-fuzz-generic-drop-"));
const outcomes: Outcome[] = [];
const uncovered: { sym: Symbol; reason: string }[] = [];
const started = Date.now();

for (const sym of selected) {
  const sizeSeed = between(20, 60);
  const tag = sym.name.replace(/\W/g, "_");
  let runs: { inst: Inst; path: Path }[];
  if (sym.name in IO_SEEDS) {
    // Reader/Writer bound: one fixed instantiation, string prelude for the vocabulary.
    runs = [{ inst: { ...STRING_INST, name: "string" }, path: { imports: IO_IMPORTS, body: IO_SEEDS[sym.name]! } }];
  } else {
    const seed = SEEDS[sym.name];
    const path = seed ? seed() : derive(sym);
    if (!path) {
      uncovered.push({ sym, reason: `no fixture recipe for ${sym.owner ?? bareType(sym.params[0]?.type ?? "")} and no seed; add one to SEEDS` });
      continue;
    }
    runs = INSTS.map(inst => ({ inst, path }));
  }
  for (const { inst, path } of runs) {
    const file = join(dir, `${tag}.${inst.name}.milo`);
    const bin = join(dir, `${tag}.${inst.name}`);
    writeFileSync(file, render(path, inst, sizeSeed));
    let verdict = await judge(file, bin, inst);
    if (verdict.kind === "asan" || verdict.kind === "drop-imbalance" || verdict.kind === "crash") {
      const cls = verdictClass(verdict);
      const smaller = await reduce(path, inst, sizeSeed, cls, dir, tag);
      if (smaller.length < path.body.length) {
        const reducedFile = join(dir, `${tag}.${inst.name}.reduced.milo`);
        writeFileSync(reducedFile, render({ ...path, body: smaller }, inst, sizeSeed));
        outcomes.push({ sym, inst: inst.name, verdict, file: reducedFile });
        continue;
      }
    }
    if (VERBOSE) console.log(`${verdict.kind.padEnd(15)} ${sym.name} <${inst.name}>${verdict.kind === "rejected" ? `  ${verdict.diagnostic}` : ""}`);
    outcomes.push({ sym, inst: inst.name, verdict, file });
  }
}

// ── report ────────────────────────────────────────────────────────────────────

const bySym = new Map<string, Outcome[]>();
for (const o of outcomes) bySym.set(o.sym.name, [...(bySym.get(o.sym.name) ?? []), o]);

// Covered means the oracle actually ran: at least one instantiation built and executed.
// A symbol every instantiation of which the checker rejected exercised nothing, with one
// exception: a `@copyOnly` symbol refuses every T this script can offer (both `string`
// and the Drop struct own memory), and that refusal at the USER's call is the verdict
// H1 asked for. It is listed separately, counted as covered, and stays a finding if the
// rejection ever lands inside std/ instead.
const covered: string[] = [];
const refusedByDesign: { sym: Symbol; diagnostic: string }[] = [];
for (const [name, os] of bySym) {
  if (os.some(o => !isRejected(o.verdict))) { covered.push(name); continue; }
  const first = os[0]!.verdict as Rejected;
  if (/is @copyOnly/.test(first.diagnostic) && os.every(o => !(o.verdict as Rejected).inStd)) {
    covered.push(name);
    refusedByDesign.push({ sym: os[0]!.sym, diagnostic: first.diagnostic });
  } else {
    uncovered.push({ sym: os[0]!.sym, reason: `every instantiation rejected: ${first.diagnostic}` });
  }
}

const rejected = outcomes.flatMap(o => isRejected(o.verdict) ? [{ ...o, verdict: o.verdict }] : []);
const rejectedInStd = rejected.filter(o => o.verdict.inStd);
const failures = outcomes.filter(o => o.verdict.kind === "asan" || o.verdict.kind === "drop-imbalance" || o.verdict.kind === "crash");

console.log(`seed ${SEED}, ${selected.length} symbols selected of ${symbols.length} generic pub std symbols, ${outcomes.length} programs, ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`oracle: ASan (+ MallocScribble) for <string>; ASan + made/gone drop accounting for <res>`);
console.log(`accepted and ran: ${outcomes.length - rejected.length}; rejected by the checker: ${rejected.length} (${rejectedInStd.length} of those inside std/)`);
const refused = outcomes.filter(o => o.verdict.kind === "refused");
if (refused.length) console.log(`refused at runtime by a checked Err (${refused.length}): ${refused.map(o => `${o.sym.name} <${o.inst}>`).join(", ")}`);
if (rejected.length && !VERBOSE) {
  for (const o of rejected) console.log(`  rejected ${o.sym.name} <${o.inst}>${o.verdict.inStd ? " [in std]" : ""}: ${o.verdict.diagnostic}`);
}

const total = FILTER || Number.isFinite(LIMIT) ? selected.length : symbols.length;
const pct = total ? Math.round((covered.length / total) * 100) : 0;
console.log(`\ncovered ${covered.length} / ${total} generic pub std symbols (${pct}%)`);
if (refusedByDesign.length) {
  console.log(`refused by @copyOnly at the call, as designed (${refusedByDesign.length}): ${refusedByDesign.map(r => r.sym.name).join(", ")}`);
}
if (uncovered.length) {
  console.log(`uncovered (${uncovered.length}):`);
  for (const u of uncovered) console.log(`  ${u.sym.name.padEnd(28)} ${u.reason}`);
}

if (failures.length) {
  console.log(`\nFINDINGS (${failures.length}):`);
  for (const o of failures) {
    const v = o.verdict;
    const detail = v.kind === "asan" ? `AddressSanitizer: ${v.what}`
      : v.kind === "drop-imbalance" ? `constructed ${v.made}, destroyed ${v.gone}`
      : v.kind === "crash" ? v.detail : v.kind;
    console.log(`  [${v.kind}] ${o.sym.name} <${o.inst}>: ${detail}`);
    console.log(`    repro: ${o.file}`);
  }
}

// Vacuity: a sweep in which nothing executed proves nothing, and must not exit 0. A
// run made only of by-design refusals did check something (the refusal), so it passes.
if (outcomes.length > 0 && covered.length === 0) {
  console.error("VACUOUS RUN: every generated program was rejected; the oracle never ran");
  process.exit(2);
}
if (!KEEP && failures.length === 0) rmSync(dir, { recursive: true, force: true });
else console.log(`\nprograms kept under ${dir}`);
if (failures.length) process.exit(1);
if (!FILTER && !Number.isFinite(LIMIT) && pct < 80) {
  console.error(`coverage ${pct}% is below the 80% gate`);
  process.exit(1);
}
console.log("every covered symbol ran ASan-clean with balanced drop accounting");
