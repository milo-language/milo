// Reference interpreter, library behaviour: what the compiled runtime does for print,
// strings (a counted buffer, copy on write), Vec, Option/Result combinators and the integer
// intrinsics. The std bodies for strings and Vec are written against raw pointers, which the
// interpreter has no model of, so each is replaced here by a native keyed by its function name.
import type { Expr } from "./ast";
import { ARRAY_COMBINATORS, SLICE_COMBINATORS, type TypeKind } from "./types";
import { NOT_NATIVE, isStr, strip, wrapInt, type CallE, type Interp, type MethodE } from "./interp";
import { taskNativeFor } from "./interp-co-natives";
import { ExitProgram, MOVED, enc, fmtFloat, strText, type MapV, type ClosureV, type EnumV, type Ref, type Str, type Value, type VecV } from "./interp-values";

export type Native = ((it: Interp, args: Value[], e?: Expr) => Value) & { co?: true };

// ── display ──
export function display(it: Interp, v: Value, ty: TypeKind, nested = false): string {
  ty = strip(ty);
  if (v === MOVED) it.stuck("E-STUCK", "display of a moved value");
  if (v === undefined) return "";
  if (typeof v === "bigint" || typeof v === "boolean") return String(v);
  if (typeof v === "number") return fmtFloat(v, ty.tag === "float" ? ty.bits : 64);
  switch (v.k) {
    case "str": return nested ? JSON.stringify(strText(v)) : strText(v);
    case "struct": {
      const name = it.displayName(v.name);
      const fs = it.structFields(v.name).map(f => `${f.name}: ${display(it, v.f[f.name]!, f.type, true)}`);
      return fs.length ? `${name} { ${fs.join(", ")} }` : name;
    }
    case "enum": {
      const decl = it.cr.enums.get(v.en)?.variants.get(v.variant);
      const args = v.a.map((x, i) => display(it, x, decl?.fields[i] ?? { tag: "unknown" }, true));
      return args.length ? `${v.variant}(${args.join(", ")})` : v.variant;
    }
    case "vec": case "arr": {
      const el = ty.tag === "vec" || ty.tag === "array" ? ty.element : { tag: "unknown" } as TypeKind;
      const xs = v.k === "arr" ? v.e : v.buf ? v.buf.elems.slice(v.start, v.start + v.len) : [];
      return `[${xs.map(x => display(it, x, el, true)).join(", ")}]`;
    }
    case "box": return display(it, v.cell.v, ty.tag === "heap" ? ty.inner : { tag: "unknown" }, nested);
  }
  return it.unsupported(`display of ${v.k}`);
}

// ── strings ──
// E-STRING-SHARE
export function concat(it: Interp, a: Str, b: Str): Str { return it.newStr([...a.b.bytes, ...b.b.bytes]); }
// Make the string in `r` the only handle to a heap buffer (copy on write), then return it.
// E-STRING-SHARE
export function unique(it: Interp, r: Ref): Str {
  const s = it.deref(r) as Str;
  if (s.b.id >= 0 && s.b.rc === 1) return s;
  const copy = it.newStr([...s.b.bytes]);
  it.setPlace(it.derefPlace(r), copy);
  it.dropValue(s);
  return copy;
}
// E-STRING-SHARE
export function appendTo(it: Interp, r: Ref, bytes: number[]): void {
  if (bytes.length === 0) return;
  const s = unique(it, r);
  if (s.b.id < 0) { it.setPlace(it.derefPlace(r), it.newStr([...s.b.bytes, ...bytes])); return; }
  s.b.bytes.push(...bytes);
}
// S-PANIC-ABORT
export function strRange(it: Interp, s: Str, a: bigint, b: bigint): [number, number] {
  if (a < 0n || b < a || b > BigInt(s.b.bytes.length)) it.panic(`string range ${a}..${b} out of bounds (len ${s.b.bytes.length})`);
  return [Number(a), Number(b)];
}

// ── Vec ──
const vecOf = (it: Interp, r: Value) => it.deref(r) as VecV;
// size in bytes of a value of type t (the compiled layout), which decides a Vec's first capacity
// R-MEM-COPY
export function sizeOf(it: Interp, t: TypeKind): number {
  switch (t.tag) {
    case "int": case "float": return t.bits / 8;
    case "bool": return 1;
    case "string": case "vec": return 24;
    case "fn": return 16;
    case "array": return (t.size ?? 0) * sizeOf(it, t.element);
    case "struct": {
      let off = 0, align = 1;
      for (const f of it.cr.structs.get(t.name)?.fields ?? []) { const s = sizeOf(it, f.type), a = Math.min(8, Math.max(1, s)); off = Math.ceil(off / a) * a + s; align = Math.max(align, a); }
      return Math.ceil(off / align) * align;
    }
    case "enum": {
      let max = 0;
      for (const v of it.cr.enums.get(t.name)?.variants.values() ?? []) max = Math.max(max, v.fields.reduce((n, f) => Math.ceil(n / 8) * 8 + sizeOf(it, f), 0));
      return max === 0 ? 4 : 8 + Math.ceil(max / 8) * 8;
    }
    default: return 8;
  }
}
const elemSize = (it: Interp, e: Expr | undefined): number => {
  const obj = !e ? undefined : e.kind === "MethodCall" ? e.object : e.kind === "Call" ? e.args[0] : undefined;
  const t = obj ? it.T(obj) : undefined;
  return t && (t.tag === "vec" || t.tag === "array") ? sizeOf(it, t.element) : 8;
};
// E-VEC
function setCap(it: Interp, h: VecV, cap: number): void {
  if (!h.buf) h.buf = it.newBuf(cap);
  else h.buf.elems.length = h.start + cap;
  h.cap = cap;
}
// std/vec vecGrowOne: the first buffer holds 8 elements (64 bytes' worth when they are bigger), then doubles
// E-VEC
function growOne(it: Interp, h: VecV, size: number): void {
  if (h.len < h.cap) return;
  setCap(it, h, h.cap === 0 ? (size > 8 ? Math.max(1, Math.floor(64 / size)) : 8) : h.cap * 2);
}
// std/vec vecReserveTotal: room for `need` elements in all, doubling when that suffices
// E-VEC
function reserveTotal(it: Interp, h: VecV, need: number): void {
  if (h.cap >= need) return;
  setCap(it, h, h.cap * 2 > need ? h.cap * 2 : need);
}
export const NONE = Symbol("none");
export const opt = (it: Interp, e: Expr | undefined, v: Value | typeof NONE): Value => {
  const name = (it.T(e!) as { name: string }).name;
  return v === NONE ? it.mkEnum(name, "None", []) : it.mkEnum(name, "Some", [v]);
};
const idx = (it: Interp, v: Value, n: number, inclusive = false): number => {
  const i = v as bigint;
  if (i < 0n || i > BigInt(n) || (!inclusive && i === BigInt(n))) it.panic(`array index out of bounds: ${i}/${n}`);
  return Number(i);
};
// the Vec header behind a Vec, a slice or a fixed array (a fixed array is viewed whole)
export const asVec = (it: Interp, v: Value): VecV => (v && typeof v === "object" && v.k === "arr" ? sliceView(it, v, 0n, BigInt(v.e.length)) : (v as VecV));
// E-VEC
export function sliceView(it: Interp, v: VecV | { k: "arr"; e: Value[] }, lo: bigint, hi: bigint): VecV {
  const n = v.k === "arr" ? v.e.length : v.len;
  if (lo < 0n || hi < lo || hi > BigInt(n)) it.panic(`slice ${lo}..${hi} out of bounds (len ${n})`);
  const base = v.k === "arr" ? { id: -1, elems: v.e } : v.buf;
  return { k: "vec", buf: base, start: (v.k === "arr" ? 0 : v.start) + Number(lo), len: Number(hi - lo), cap: Number(hi - lo), view: true };
}
function natCmp(it: Interp, a: Value, b: Value): number {
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (isStr(a) && isStr(b)) return it.binValues("<", a, b, { tag: "string" }, { tag: "bool" }) ? -1 : it.equal(a, b) ? 0 : 1;
  return it.unsupported("sort of this element type");
}

// ── function natives, keyed by instantiated name (without a $atN call-site suffix) ──
export const NATIVES: Map<string, Native> = new Map();
export const nat = (n: string, f: Native) => NATIVES.set(n, f);

nat("string$push", (it, [self, b]) => { appendTo(it, self as Ref, [Number(b as bigint)]); return undefined; });
nat("string$clone", (it, [self]) => it.newStr([...(it.deref(self) as Str).b.bytes]));
nat("string$clear", (it, [self]) => { const s = unique(it, self as Ref); s.b.bytes.length = 0; return undefined; });
nat("string$truncate", (it, [self, n]) => {
  const s = unique(it, self as Ref); const k = Number(n as bigint);
  if (k >= 0 && k < s.b.bytes.length && (s.b.bytes[k]! & 192) === 128) it.panic(`milo: truncate(${k}) lands inside a multibyte UTF-8 character`); if (k < s.b.bytes.length) s.b.bytes.length = Math.max(k, 0); return undefined; });
nat("string$setByte", (it, [self, i, b]) => {
  const s = unique(it, self as Ref);
  s.b.bytes[idx(it, i, s.b.bytes.length)] = Number(b as bigint);
  return undefined;
});
nat("string$substr", (it, [self, a, b]) => {
  const s = it.deref(self) as Str;
  const [lo, hi] = strRange(it, s, a as bigint, b as bigint);
  return it.newStr(s.b.bytes.slice(lo, hi));
});
// The compiler's own memory builtins (src/checker.ts registers them; src/emit-mlir.ts lowers them to a load or a copy).
// Each reads or writes through the byte memory of src/interp-mem.ts; a string or array argument decays to a pointer first.
const PTR_U8: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
// R-MEM-LOAD
function withPtr<T>(it: Interp, p: Value, f: (q: Value) => T): T {
  const held: Value[] = [];
  try { return f(it.mem.decay(p, PTR_U8, held)); } finally { for (const h of held) it.dropValue(h); }
}
nat("_loadU8", (it, [p]) => withPtr(it, p!, q => it.mem.load(q, { tag: "int", bits: 8, signed: false })));
nat("_loadI32", (it, [p]) => withPtr(it, p!, q => it.mem.load(q, { tag: "int", bits: 32, signed: true })));
nat("_bytesToString", (it, [p, n]) => withPtr(it, p!, q => it.newStr([...it.mem.readBytes(q, Number(n as bigint), "_bytesToString")])));
nat("_cstrToString", (it, [p]) => withPtr(it, p!, q => it.newStr([...it.mem.cstring(q, "_cstrToString")])));
nat("_strDataPtr", (it, [s]) => it.mem.strPtr(it.deref(s!) as Str));
nat("_putByte", (it, [b]) => { it.out.push(Number(b as bigint)); return undefined; });
nat("_miloArgCount", () => 1n);
nat("_miloArgAt", (it, [i]) => (i === 0n ? it.newStr([...enc.encode(it.entryFile || "main")]) : it.panic("argument index out of range")));
// rawSlice(p, len) / rawSliceMut(p, len) (std/foreign): a slice whose elements are the memory at p, read and written in place
for (const name of ["rawSlice", "rawSliceMut"]) {
  nat(name, (it, [p, len], e) => {
    const t = it.T(e!);
    const el = t.tag === "array" || t.tag === "vec" ? t.element : { tag: "unknown" as const };
    const n = Number(len as bigint), es = it.mem.sizeOf(el);
    if (n < 0) it.panic("rawSlice: negative length");
    if (n === 0) return it.newVec([]);
    const at = (i: number) => it.mem.advance(p!, i * es);
    const elems = new Proxy([] as Value[], {
      get: (tg, k, r) => (k === "length" ? n : typeof k === "string" && /^\d+$/.test(k) ? it.mem.load(at(Number(k)), el) : Reflect.get(tg, k, r)),
      set: (tg, k, v, r) => { if (typeof k === "string" && /^\d+$/.test(k)) { it.mem.store(at(Number(k)), el, v as Value); return true; } return k === "length" || Reflect.set(tg, k, v, r); },
    });
    return { k: "vec", buf: { id: -1, elems }, start: 0, len: n, cap: n, view: true } as VecV;
  });
}
nat("strWithCapacity", (it, [n]) => { const s = it.newStr([]); if ((n as bigint) > 0n) s.b.id = it.alloc(); return s; });

// R-ATOMIC: one task runs at a time, so an atomic is a plain read-modify-write of the place its pointer names.
// R-REPLAY-OFF: the interpreter runs with record/replay off, as a binary does when neither MILO_RECORD nor MILO_REPLAY is set.
nat("replay$replayModeNow", () => 1n);
nat("replayOff", () => true);
nat("replayActive", () => false);
nat("replayRecording", () => false);
for (const [w, bits] of [["I64", 64], ["I32", 32], ["Bool", 0]] as const) {
  const wrap = (v: bigint) => (bits ? BigInt.asIntN(bits, v) : v);
  const ty: TypeKind = bits ? { tag: "int", bits, signed: true } : { tag: "bool" };
  const atom = (it: Interp, p: Value) => it.memPlace(p, ty);
  nat(`_atomicLoad${w}`, (it, [p]) => it.getPlace(atom(it, p)));
  nat(`_atomicStore${w}`, (it, [p, v]) => { it.setPlace(atom(it, p), v); return undefined; });
  nat(`_atomicSwap${w}`, (it, [p, v]) => { const pl = atom(it, p); const old = it.getPlace(pl); it.setPlace(pl, v); return old; });
  nat(`_atomicCas${w}`, (it, [p, want, to]) => { const pl = atom(it, p); const old = it.getPlace(pl); if (old === want) it.setPlace(pl, to); return old; });
  if (bits) {
    nat(`_atomicAdd${w}`, (it, [p, v]) => { const pl = atom(it, p); const old = it.getPlace(pl) as bigint; it.setPlace(pl, wrap(old + (v as bigint))); return old; });
    nat(`_atomicSub${w}`, (it, [p, v]) => { const pl = atom(it, p); const old = it.getPlace(pl) as bigint; it.setPlace(pl, wrap(old - (v as bigint))); return old; });
  }
}

const copyOut = (it: Interp, x: Value): Value => (it.copyable(x) || isStr(x) ? it.share(x, "copy") : it.deepClone(x));
const VEC: Record<string, Native> = {
  push: (it, [self, x], e) => { const h = vecOf(it, self); growOne(it, h, elemSize(it, e)); h.buf!.elems[h.start + h.len++] = x; return undefined; },
  // first / last are copies of the element (get yields a view of it), as E-INDEX-COPY reads one
  first: (it, [self], e) => { const h = asVec(it, it.deref(self)); return h.len === 0 ? opt(it, e, NONE) : opt(it, e, copyOut(it, h.buf!.elems[h.start]!)); },
  last: (it, [self], e) => { const h = asVec(it, it.deref(self)); return h.len === 0 ? opt(it, e, NONE) : opt(it, e, copyOut(it, h.buf!.elems[h.start + h.len - 1]!)); },
  pop: (it, [self], e) => {
    const h = vecOf(it, self);
    return h.len === 0 ? opt(it, e, NONE) : opt(it, e, h.buf!.elems[h.start + --h.len]!);
  },
  insert: (it, [self, i, x], e) => {
    const h = vecOf(it, self); const k = idx(it, i, h.len, true);
    growOne(it, h, elemSize(it, e));
    h.buf!.elems.splice(h.start + k, 0, x); h.buf!.elems.length = h.start + h.cap; h.len++;
    return undefined;
  },
  remove: (it, [self, i]) => {
    const h = vecOf(it, self); const k = idx(it, i, h.len);
    const [v] = h.buf!.elems.splice(h.start + k, 1); h.buf!.elems.length = h.start + h.cap; h.len--;
    return v;
  },
  truncate: (it, [self, n]) => {
    const h = vecOf(it, self); const k = Number(n as bigint);
    const keep = Math.max(k, 0);
    if (keep < h.len) { for (let i = keep; i < h.len; i++) it.dropValue(h.buf!.elems[h.start + i]!); h.len = keep; } // first to last
    return undefined;
  },
  clear: (it, [self]) => { const h = vecOf(it, self); for (let i = 0; i < h.len; i++) it.dropValue(h.buf!.elems[h.start + i]!); h.len = 0; return undefined; },
  reserve: (it, [self, n]) => { const h = vecOf(it, self); if ((n as bigint) < 0n) it.panic("negative capacity"); reserveTotal(it, h, h.len + Number(n)); return undefined; },
  swap: (it, [self, a, b]) => {
    const h = vecOf(it, self); const i = idx(it, a, h.len), j = idx(it, b, h.len);
    const el = h.buf!.elems; [el[h.start + i], el[h.start + j]] = [el[h.start + j]!, el[h.start + i]!];
    return undefined;
  },
  reverse: (it, [self]) => {
    const h = vecOf(it, self);
    const s = h.buf ? h.buf.elems.slice(h.start, h.start + h.len).reverse() : [];
    s.forEach((x, i) => { h.buf!.elems[h.start + i] = x; });
    return undefined;
  },
  extend: (it, [self, other]) => {
    const h = vecOf(it, self), o = other as VecV;
    if (o.len) { reserveTotal(it, h, h.len + o.len); for (let i = 0; i < o.len; i++) h.buf!.elems[h.start + h.len++] = o.buf!.elems[o.start + i]!; }
    if (o.buf && !o.view) it.free(o.buf.id);
    return undefined;
  },
  sort: (it, [self]) => {
    const h = vecOf(it, self);
    const xs = h.buf ? h.buf.elems.slice(h.start, h.start + h.len).sort((a, b) => natCmp(it, a!, b!)) : [];
    xs.forEach((x, i) => { h.buf!.elems[h.start + i] = x; });
    return undefined;
  },
};
for (const [m, f] of Object.entries(VEC)) nat(`Vec$${m}`, f);

// Vec_<elem>$method -> Vec$method
const MAPS: Record<string, Native> = {
  insert: (it, [self, key, val]) => { it.mapPut(it.deref(self) as MapV, key, val); return undefined; },
  remove: (it, [self, key]) => {
    const m = it.deref(self) as MapV, k = it.keyOf(it.deref(key)), ent = m.m.get(k);
    if (ent) { m.m.delete(k); it.dropValue(ent.key.v); it.dropValue(ent.val.v); }
    return undefined;
  },
  contains: (it, [self, key]) => (it.deref(self) as MapV).m.has(it.keyOf(it.deref(key))),
  isEmpty: (it, [self]) => (it.deref(self) as MapV).m.size === 0,
  get: (it, [self, key], e) => {
    const ent = (it.deref(self) as MapV).m.get(it.keyOf(it.deref(key)));
    return opt(it, e, ent ? it.deepClone(ent.val.v) : NONE);
  },
  getOrDefault: (it, [self, key, fallback]) => {
    const ent = (it.deref(self) as MapV).m.get(it.keyOf(it.deref(key)));
    if (!ent) return fallback;
    it.dropValue(fallback);
    return it.deepClone(ent.val.v);
  },
  keys: (it, [self]) => it.newVec([...(it.deref(self) as MapV).m.values()].map(x => it.deepClone(x.key.v))),
  values: (it, [self]) => it.newVec([...(it.deref(self) as MapV).m.values()].map(x => it.deepClone(x.val.v))),
  clear: (it, [self]) => {
    const m = it.deref(self) as MapV;
    for (const x of m.m.values()) { it.dropValue(x.key.v); it.dropValue(x.val.v); }
    m.m.clear();
    return undefined;
  },
  clone: (it, [self]) => it.deepClone(it.deref(self)),
  modify: (it, [self, key, f]) => {
    const ent = (it.deref(self) as MapV).m.get(it.keyOf(it.deref(key)));
    if (!ent) { it.dropValue(f); return false; }
    it.callValue(f, [{ k: "mut", slot: ent.val, path: [] } as Ref]);
    it.dropValue(f);
    return true;
  },
  getOrInsertWith: (it, [self, key, init]) => {
    const m = it.deref(self) as MapV;
    if (m.m.has(it.keyOf(key))) { it.dropValue(key); it.dropValue(init); return false; }
    const v = it.callValue(init, []);
    it.dropValue(init);
    it.mapPut(m, key, v);
    return true;
  },
};
export function nativeFor(name: string): Native | undefined {
  const tk = taskNativeFor(name);
  if (tk) return tk;
  if (/(^|\$)(mapNew|mapWithCapacity|mapWithSlots)/.test(name)) return () => ({ k: "map", buf: null, m: new Map() });
  const hm = /^HashMap_.+?\$([A-Za-z0-9_]+)$/.exec(name);
  if (hm && MAPS[hm[1]!]) return MAPS[hm[1]!];
  if (/(^|\$)strWithCapacity$/.test(name)) return NATIVES.get("strWithCapacity");
  if (/(^|\$)vecWithCapacity/.test(name)) return (it, [n]) => { const h = it.newVec([]); if ((n as bigint) > 0n) { h.buf = it.newBuf(Number(n)); h.cap = Number(n); } return h; };
  if (/(^|\$)vecFilled/.test(name)) return (it, [n, x]) => { const h = it.newVec([]); const k = Number(n as bigint); if (k > 0) { h.buf = it.newBuf(k); h.cap = k; for (let i = 0; i < k; i++) h.buf.elems[i] = it.share(x, "filled"); h.len = k; } return h; };
  const m = /^Vec_.+?\$([A-Za-z0-9_]+)$/.exec(name);
  return NATIVES.get(m ? `Vec$${m[1]}` : name);
}

// ── builtin functions (print, format, exit, assert, ...) ──
export const BUILTIN_FNS = new Set(["print", "eprint", "format", "flush", "exit", "assert", "todo", "max", "min"]);
// Unless the parts are one format(), a string part ends a chunk: the chunk is written as soon as
// that part is evaluated, so output from evaluating a later part comes after it (print-order).
function renderParts(it: Interp, e: CallE, sink?: number[]): number[] {
  let args = e.args;
  const only = args.length === 1 ? args[0]! : null;
  const formatted = !!only && only.kind === "Call" && only.func === "format" && !it.fns.has("format");
  if (formatted) args = only!.args;
  const out: number[] = [];
  for (const a of args) {
    const v = it.peek(a);
    out.push(...(isStr(v) ? v.b.bytes : enc.encode(display(it, v, it.T(a)))));
    if (sink && !formatted && isStr(v)) { sink.push(...out); out.length = 0; }
  }
  return out;
}
// S-PANIC-ABORT
export function builtinCall(it: Interp, e: CallE): Value {
  switch (e.func) {
    case "print": case "eprint": {
      const dest = e.func === "print" ? it.out : it.err;
      const bytes = renderParts(it, e, dest);
      bytes.push(10);
      dest.push(...bytes);
      return undefined;
    }
    case "format": return it.newStr(renderParts(it, e));
    case "flush": return undefined;
    case "exit": { const code = Number(it.ev(e.args[0]!) as bigint); it.aborted = true; throw new ExitProgram(code); }
    case "assert": {
      if (it.peek(e.args[0]!) === true) return undefined;
      const msg = e.args[1] ? strText(it.peek(e.args[1]) as Str) : "";
      return it.panic(`assertion failed${msg ? ": " + msg : ""}`);
    }
    case "todo": return it.panic("not yet implemented");
    case "max": case "min": {
      const a = it.peek(e.args[0]!), b = it.peek(e.args[1]!);
      const lt = it.binValues("<", a, b, it.T(e), it.T(e));
      return e.func === "max" ? (lt ? b : a) : (lt ? a : b);
    }
  }
  return it.unsupported(`call of ${e.func}`);
}

// ── methods the compiler handles without a std body (src/lower.ts MethodCall) ──
export const STR_METHODS: Record<string, string> = {
  contains: "strContains", startsWith: "strStartsWith", endsWith: "strEndsWith", split: "strSplit", trim: "strTrim",
  trimStart: "strTrimStart", trimEnd: "strTrimEnd", toLower: "strToLower", toUpper: "strToUpper", reverse: "strReverse",
  replace: "strReplace", replaceFirst: "strReplaceFirst", repeat: "strRepeat", padStart: "strPadStart", padEnd: "strPadEnd",
  isEmpty: "strIsEmpty", charAt: "strCharAt", parseInt: "strParseInt", parseF64: "strParseF64",
  splitWords: "strSplitWords", splitWhitespace: "strSplitWhitespace",
};
export const INT_ARITH: Record<string, string> = {
  wrappingAdd: "+", wrappingSub: "-", wrappingMul: "*", saturatingAdd: "+", saturatingSub: "-", saturatingMul: "*",
  checkedAdd: "+", checkedSub: "-", checkedMul: "*", checkedDiv: "/", checkedRem: "%",
};

// A closure parameter that is `&T` gets a reference to the value, otherwise the value itself.
// E-CLOSURE
function callWith(it: Interp, f: Value, payload: Value[]): Value {
  const c = f as ClosureV;
  const args = payload.map((p, i) => (c.paramRefs?.[i] ? ({ k: "ref", slot: it.tempOwn(p), path: [] } as Ref) : p));
  return it.callValue(f, args);
}
export const take = (v: EnumV): Value => { const p = v.a[0]; v.a[0] = MOVED; return p; };

export function methodNative(it: Interp, e: MethodE, ot0: TypeKind): Value | typeof NOT_NATIVE {
  const m = e.method;
  const rawO = it.rawT(e.object);
  const objRaw = rawO ? strip(rawO) : ot0;
  const ot: TypeKind = objRaw.tag === "array" && (objRaw.size === null ? SLICE_COMBINATORS.has(m) : ARRAY_COMBINATORS.has(m)) ? { tag: "vec", element: objRaw.element } : objRaw;
  const type = it.T(e);
  const base = ot.tag === "enum" ? it.cr.enums.get(ot.name)?.baseName : undefined;
  // R-MEM-ADDROF, R-MEM-VECPTR: the address of a place, and the first element of a Vec or the cell of a Heap
  if (m === "addrOf" && e.args.length === 0) return it.mem.placePtr(it.resolve(e.object), ot);
  if (m === "ptr" && ot.tag === "vec") return it.mem.vecPtr(asVec(it, it.peek(e.object)), ot.element);
  if (m === "ptr" && ot.tag === "heap") return it.unsupported(".ptr() of a Heap");
  if ((ot.tag === "int" || ot.tag === "float") && m === "toString") return it.newStr([...enc.encode(display(it, it.peek(e.object), ot))]);
  if (base === "Option" && m === "take") {
    const none = it.mkEnum((ot as { name: string }).name, "None", []);
    return it.memReplace(e.object, none);
  }
  if (base === "Option" || base === "Result") {
    const r = optionMethod(it, e, ot as TypeKind & { name: string }, base, type);
    if (r !== NOT_NATIVE) return r;
  }
  if (ot.tag === "int") {
    const t = ot;
    switch (m) {
      case "countOnes": return BigInt([...BigInt.asUintN(t.bits, it.peek(e.object) as bigint).toString(2)].filter(c => c === "1").length);
      case "leadingZeros": return BigInt(t.bits - BigInt.asUintN(t.bits, it.peek(e.object) as bigint).toString(2).replace(/^0+$/, "").length);
      case "trailingZeros": { const x = BigInt.asUintN(t.bits, it.peek(e.object) as bigint); if (x === 0n) return BigInt(t.bits); let n = 0; while (((x >> BigInt(n)) & 1n) === 0n) n++; return BigInt(n); }
      case "wrappingNeg": return wrapInt(-(it.peek(e.object) as bigint), t);
    }
    const op = INT_ARITH[m];
    if (op) {
      const a = it.peek(e.object) as bigint, b = it.peek(e.args[0]!) as bigint;
      if (m.endsWith("Div") || m.endsWith("Rem")) {
        if (b === 0n) return opt(it, e, NONE);
        if (t.signed && b === -1n && a === -(1n << BigInt(t.bits - 1))) return opt(it, e, NONE);
      }
      const r = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : a % b;
      const lo = t.signed ? -(1n << BigInt(t.bits - 1)) : 0n, hi = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
      if (m.startsWith("wrapping")) return wrapInt(r, t);
      if (m.startsWith("saturating")) return r < lo ? lo : r > hi ? hi : r;
      return r < lo || r > hi ? opt(it, e, NONE) : opt(it, e, r);
    }
    if (["reverseBits", "rotateLeft", "rotateRight", "checkedNeg"].includes(m)) return it.unsupported(`int .${m}()`);
  }
  if ((ot.tag === "vec" || ot.tag === "array") && m === "slice") {
    const v = it.peek(e.object) as VecV | { k: "arr"; e: Value[] };
    return sliceView(it, v, it.ev(e.args[0]!) as bigint, it.ev(e.args[1]!) as bigint);
  }
  if (ot.tag === "array" && ot.size === null && m === "len") return BigInt(asVec(it, it.peek(e.object)).len);
  if (ot.tag === "vec") {
    if (m === "len") return BigInt(asVec(it, it.peek(e.object)).len);
    if (m === "capacity") return BigInt(asVec(it, it.peek(e.object)).cap);
    if (m === "get") {
      const v = asVec(it, it.peek(e.object)), i = it.ev(e.args[0]!) as bigint;
      if (i < 0n || i >= BigInt(v.len)) return opt(it, e, NONE);
      return opt(it, e, it.viewOf(v.buf!.elems[v.start + Number(i)]!)); // Option<&T>: a view of the element
    }
  }
  if (ot.tag === "hashmap" && m === "len") return it.unsupported("hashmap");
  if (ot.tag === "string") {
    switch (m) {
      case "pushStr": appendTo(it, it.refTo(it.resolve(e.object), true), (it.peek(e.args[0]!) as Str).b.bytes); return undefined;
      case "pushInt": appendTo(it, it.refTo(it.resolve(e.object), true), [...enc.encode(String(it.ev(e.args[0]!)))]); return undefined;
      case "slice": { // a view: borrows the bytes, owns nothing
        const s = it.peek(e.object) as Str;
        const [lo, hi] = strRange(it, s, it.ev(e.args[0]!) as bigint, it.ev(e.args[1]!) as bigint);
        return { k: "str", b: { bytes: s.b.bytes.slice(lo, hi), rc: 1, id: -1 } };
      }
      case "len": return BigInt((it.peek(e.object) as Str).b.bytes.length);
      // R-MEM-CSTR: C may write through the pointer, so the string first becomes the only handle to its buffer (copy on write); the pointer is the buffer itself
      case "cstr": return it.isPlaceExpr(e.object) ? it.mem.cPtr(it.peek(e.object) as Str, it.refTo(it.resolve(e.object), true)) : it.mem.cPtr(it.peek(e.object) as Str);
    }
    const fn = STR_METHODS[m];
    if (fn) return it.callResolved(fn, e.args, e, undefined, e.object);
  }
  return NOT_NATIVE;
}

// E-MOVE
function optionMethod(it: Interp, e: MethodE, ot: TypeKind & { name: string }, base: string, type: TypeKind): Value | typeof NOT_NATIVE {
  const m = e.method;
  const isOpt = base === "Option";
  const okV = isOpt ? "Some" : "Ok";
  const resName = (type as { name?: string }).name ?? ot.name;
  switch (m) {
    case "isSome": case "isOk": return (it.peek(e.object) as EnumV).variant === okV;
    case "isNone": case "isErr": return (it.peek(e.object) as EnumV).variant !== okV;
  }
  const arg0 = () => it.ev(e.args[0]!);
  // A named receiver the checker did not move is not consumed (it forwards only Copy
  // payloads, [MILO-O-combinatorReceiver]): the combinator reads a view and the variable
  // keeps its payload until scope exit, as the compiled match-in-place does.
  const inPlace = it.isPlaceExpr(e.object) && !it.cr.movedExprs.has(e.object);
  const recv = () => receiverOf(it, e.object, inPlace);
  switch (m) {
    case "unwrapOr": {
      const v = recv(), d = arg0();
      if (v.variant === okV) { it.dropValue(d); const p = take(v); it.dropValue(v); return p; }
      it.dropValue(v);
      return d;
    }
    case "unwrapOrElse": {
      const v = recv(), f = arg0();
      let r: Value;
      if (v.variant === okV) { r = take(v); it.dropValue(v); } else r = callWith(it, f, isOpt ? [] : [take(v)]);
      it.dropValue(f);
      return r;
    }
    case "map": {
      const v = recv(), f = arg0();
      let r: Value;
      if (v.variant === okV) { r = it.mkEnum(resName, okV, [callWith(it, f, [take(v)])]); it.dropValue(v); }
      else r = isOpt ? (it.dropValue(v), it.mkEnum(resName, "None", [])) : it.mkEnum(resName, "Err", v.a);
      it.dropValue(f);
      return r;
    }
    case "mapErr": {
      if (isOpt) return NOT_NATIVE;
      const v = recv(), f = arg0();
      const r = v.variant === okV ? it.mkEnum(resName, "Ok", v.a) : it.mkEnum(resName, "Err", [callWith(it, f, [take(v)])]);
      it.dropValue(f);
      return r;
    }
    case "andThen": {
      const v = recv(), f = arg0();
      let r: Value;
      if (v.variant === okV) { r = callWith(it, f, [take(v)]); it.dropValue(v); }
      else r = isOpt ? (it.dropValue(v), it.mkEnum(resName, "None", [])) : it.mkEnum(resName, "Err", v.a);
      it.dropValue(f);
      return r;
    }
    case "orElse": {
      const v = recv(), f = arg0();
      let r: Value;
      if (v.variant === okV) r = v;
      else r = isOpt ? (it.dropValue(v), callWith(it, f, [])) : callWith(it, f, [take(v)]);
      it.dropValue(f);
      return r;
    }
  }
  return NOT_NATIVE;
}

// A combinator's receiver: a view when it isn't consumed (MILO-O-combinatorReceiver), else its
// value. A function of its own so the task twin can suspend inside it (gen-interp-co.ts only
// rewrites an arrow whose whole body is one call).
// E-MOVE
function receiverOf(it: Interp, obj: Expr, inPlace: boolean): EnumV {
  return (inPlace ? it.viewOf(it.peek(obj)) : it.ev(obj)) as EnumV;
}
