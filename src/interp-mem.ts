// Reference interpreter, raw memory: the byte-level model behind `malloc`, `.ptr()`, `.addrOf()`,
// `string.cstr()` and every `*T` load and store (docs/semantics/mini-milo.md §5, R-MEM-*).
//
// A raw pointer is {allocation, offset}. An allocation is a byte array (malloc) or a byte *view*
// of a value the interpreter keeps structured (a Vec buffer, a fixed array, a variable): the view
// encodes elements to bytes with the compiled layout (src/layout.ts) when read and decodes them
// back when written, so the structured value stays the single source of truth and no sync step
// exists. Each allocation owns a range of a virtual address space, so `p as i64` and back to
// `*T` keeps its provenance; an address in no range is not a pointer (R-MEM-PROVENANCE).
// Undefined behaviour is a stuck state naming the rule, which also makes this a Miri-style
// checker for the unsafe code in std.
import type { HIRModule } from "./hir";
import type { Interp } from "./interp";
import { Layout } from "./layout";
import type { TypeKind } from "./types";
import type { Expr } from "./ast";
import { staticStr, type Place, type Slot, type Str, type Struct, type Value, type VecV } from "./interp-values";

export interface PtrV { k: "ptr"; a: Alloc; off: number }
export const isPtr = (v: unknown): v is PtrV => !!v && typeof v === "object" && (v as { k?: string }).k === "ptr";

interface Backing {
  size(): number;
  read(off: number, n: number): Uint8Array;
  write(off: number, b: Uint8Array): void;
  live?(): boolean; // a view over a value that can go away (a Vec buffer): false once it has
}

export class Alloc {
  live = true;
  freedBy = "";
  constructor(
    readonly id: number, readonly base: number, readonly reserve: number, readonly kind: "heap" | "static" | "view",
    readonly be: Backing, readonly ro: boolean, readonly block: number,
  ) {}
  get size(): number { return this.be.size(); }
  isLive(): boolean { return this.live && (this.be.live ? this.be.live() : true); }
}

class Raw implements Backing {
  bytes: Uint8Array;
  constructor(n: number) { this.bytes = new Uint8Array(n); }
  size() { return this.bytes.length; }
  read(off: number, n: number) { return this.bytes.subarray(off, off + n); }
  write(off: number, b: Uint8Array) { this.bytes.set(b, off); }
}

// A run of equal-typed elements the interpreter holds as Values.
export interface ElemSrc { count(): number; get(i: number): Value; set(i: number, v: Value): void; live?(): boolean }
class ElemView implements Backing {
  constructor(private m: Mem, private ty: TypeKind, private es: number, private src: ElemSrc) {}
  size() { return this.src.count() * this.es; }
  live() { return this.src.live ? this.src.live() : true; }
  private span(off: number, n: number): [number, number] {
    return [Math.floor(off / this.es), Math.max(Math.floor(off / this.es), Math.ceil((off + n) / this.es))];
  }
  read(off: number, n: number): Uint8Array {
    const [lo, hi] = this.span(off, n);
    const tmp = new Uint8Array((hi - lo) * this.es);
    const dv = new DataView(tmp.buffer);
    for (let i = lo; i < hi; i++) this.m.encode(this.src.get(i), this.ty, dv, (i - lo) * this.es);
    return tmp.subarray(off - lo * this.es, off - lo * this.es + n);
  }
  write(off: number, b: Uint8Array): void {
    const [lo, hi] = this.span(off, b.length);
    const tmp = new Uint8Array((hi - lo) * this.es);
    const dv = new DataView(tmp.buffer);
    for (let i = lo; i < hi; i++) this.m.encode(this.src.get(i), this.ty, dv, (i - lo) * this.es);
    tmp.set(b, off - lo * this.es);
    for (let i = lo; i < hi; i++) this.src.set(i, this.m.decode(this.ty, dv, (i - lo) * this.es));
  }
}

const GAP = 16;
const VIEW_RESERVE = 1 << 24;
const WILD_ALLOC = new Alloc(-1, 0, 0, "static", new Raw(0), true, -1);
WILD_ALLOC.live = false;

export class Mem {
  allocs: Alloc[] = [];
  private next = 0x10000;
  private ids = 0;
  private layoutCache: Layout | undefined;
  private views = new WeakMap<object, Map<string, Alloc>>();
  constructor(private it: Interp) {}

  // ── layout (the compiled program's sizes and offsets) ──
  get layout(): Layout {
    if (this.layoutCache) return this.layoutCache;
    const cr = this.it.cr;
    const mod = {
      structs: [...cr.structs].map(([name, s]) => ({ name, fields: s.fields.map(f => ({ name: f.name, type: f.type })) })),
      enums: [...cr.enums].map(([name, e]) => ({ name, variants: [...e.variants].map(([vn, v]) => ({ name: vn, tag: v.tag, fields: v.fields })) })),
      dropImpls: new Set<string>(),
    } as unknown as HIRModule;
    const l = new Layout();
    l.build(mod);
    return (this.layoutCache = l);
  }
  sizeOf(t: TypeKind): number { return this.layout.typeSizeOf(t); }
  alignOf(t: TypeKind): number { return this.layout.typeAlign(this.layout.llvmType(t)); }
  offsetOf(structName: string, field: string): number {
    const sl = this.layout.structLayouts.get(structName);
    const i = sl ? sl.fields.findIndex(f => f.name === field) : -1;
    if (!sl || i < 0) this.it.stuck("R-MEM-LAYOUT", `no field ${structName}.${field}`);
    return this.layout.structFieldOffset(sl.fields.map(f => f.type), i);
  }

  // ── allocations ──
  private make(kind: "heap" | "static" | "view", be: Backing, ro: boolean, block: number): Alloc {
    const size = be.size();
    const reserve = kind === "view" ? Math.max(size, VIEW_RESERVE) : size + GAP;
    const a = new Alloc(++this.ids, this.next, reserve, kind, be, ro, block);
    this.next += Math.ceil((reserve + GAP) / 16) * 16;
    this.allocs.push(a);
    return a;
  }
  ptr(a: Alloc, off = 0): PtrV { return { k: "ptr", a, off }; }
  // malloc: counted in the live-block tally like every other heap block (a compiled run counts the same)
  malloc(n: number): PtrV {
    if (n < 0 || n > 1 << 30) return this.it.unsupported(`malloc of ${n} bytes`);
    return this.ptr(this.make("heap", new Raw(n), false, this.it.alloc()));
  }
  free(p: Value): void {
    if (p === 0n) return; // free(NULL) is a no-op
    const q = this.asPtr(p, "free");
    if (q.a.kind !== "heap" || q.off !== 0) this.it.stuck("R-MEM-FREE-INVALID", `free of a pointer that malloc did not return (${this.describe(q)})`);
    if (!q.a.live) this.it.stuck("R-MEM-DOUBLE-FREE", `${this.describe(q)} was already freed`);
    q.a.live = false;
    this.it.free(q.a.block);
  }
  realloc(p: Value, n: number): Value {
    if (p === 0n) return this.malloc(n);
    const q = this.asPtr(p, "realloc");
    if (q.a.kind !== "heap" || q.off !== 0) this.it.stuck("R-MEM-FREE-INVALID", `realloc of a pointer that malloc did not return (${this.describe(q)})`);
    if (!q.a.live) this.it.stuck("R-MEM-UAF", `realloc of freed ${this.describe(q)}`);
    const np = this.malloc(n);
    (np.a.be as Raw).bytes.set(q.a.be.read(0, Math.min(n, q.a.size)));
    this.free(q);
    return np;
  }
  // bytes the interpreter hands out and nothing frees: a `cstr()` copy, a host buffer. Not a counted block.
  staticBytes(bytes: Uint8Array, ro = false): PtrV {
    const r = new Raw(bytes.length);
    r.bytes.set(bytes);
    return this.ptr(this.make("static", r, ro, -1));
  }

  // a byte view of structured values; one allocation per (owner, key) so a pointer taken twice compares equal
  viewOf(owner: object, key: string, ty: TypeKind, src: ElemSrc, ro = false): Alloc {
    let m = this.views.get(owner);
    if (!m) this.views.set(owner, (m = new Map()));
    let a = m.get(key);
    if (!a) m.set(key, (a = this.make("view", new ElemView(this, ty, this.sizeOf(ty), src), ro, -1)));
    return a;
  }
  advance(p: Value, bytes: number): Value {
    if (isPtr(p)) return { k: "ptr", a: p.a, off: p.off + bytes };
    return this.fromAddr(this.addr(p) + BigInt(bytes));
  }

  // ── pointers to the interpreter's structured values ──
  // `v.ptr()`: the buffer's elements, from the slice's first. An empty Vec owns no block, so its pointer is null.
  vecPtr(h: VecV, elem: TypeKind): Value {
    if (!h.buf) return 0n;
    const b = h.buf;
    const a = this.viewOf(b, "elems", elem, { count: () => b.elems.length, get: i => b.elems[i], set: (i, v) => { b.elems[i] = v; }, live: () => b.id < 0 || this.it.blocks.has(b.id) });
    return this.ptr(a, h.start * this.sizeOf(elem));
  }
  // `s.cstr()`: a NUL-terminated copy. Nothing frees it and the string does not see writes to it, as C's `const char *`.
  cstr(s: Str): PtrV {
    const b = new Uint8Array(s.b.bytes.length + 1);
    b.set(s.b.bytes);
    return this.staticBytes(b);
  }
  // a string's bytes as `*u8` (a literal's are read-only)
  strPtr(s: Str): Value {
    const sb = s.b;
    if (sb.bytes.length === 0) return 0n;
    const a = this.viewOf(sb, "bytes", U8, { count: () => sb.bytes.length, get: i => BigInt(sb.bytes[i]!), set: (i, v) => { sb.bytes[i] = Number(v as bigint); }, live: () => sb.id < 0 || this.it.blocks.has(sb.id) }, sb.id < 0);
    return this.ptr(a, 0);
  }
  // `x.addrOf()`: the bytes of a place. A fixed array is its elements, any other value one element of its type.
  placePtr(pl: Place, ty: TypeKind): Value {
    if (pl.slot.mem) return pl.slot.mem;
    const it = this.it;
    const key = pl.path.join("/") + "|" + ty.tag;
    if (ty.tag === "array" && ty.size !== null) {
      const arr = it.getPlace(pl) as { e: Value[] };
      const a = this.viewOf(arr, "e", ty.element, { count: () => arr.e.length, get: i => arr.e[i], set: (i, v) => { arr.e[i] = v; } });
      return this.ptr(a, 0);
    }
    if (!["int", "float", "bool", "ptr", "struct", "array"].includes(ty.tag)) return it.unsupported(`.addrOf() of a ${ty.tag}`);
    const a = this.viewOf(pl.slot, key, ty, { count: () => 1, get: () => it.getPlace(pl), set: v => it.setPlace(pl, v), live: () => !pl.slot.dead });
    return this.ptr(a, 0);
  }
  // R-MEM-DECAY: a string or fixed array (or a borrow of one) given to a `*T` parameter becomes a pointer to its bytes.
  // A string gets a NUL-terminated copy, since C reads to the NUL and a Milo string need not carry one.
  decay(v: Value, param: TypeKind | undefined): Value {
    if (param?.tag !== "ptr" || !v || typeof v !== "object") return v;
    if (v.k === "ref" || v.k === "mut") {
      const inner = this.it.deref(v);
      if (inner && typeof inner === "object" && (inner.k === "str" || inner.k === "arr")) return this.decay(inner, param);
      return v;
    }
    if (v.k === "str") return this.cstr(v);
    if (v.k === "arr") return this.castToPtr(v, { tag: "array", element: param.inner, size: v.e.length }, param);
    return v;
  }
  castToPtr(v: Value, from: TypeKind, to: TypeKind): Value {
    if (isPtr(v)) return v;
    if (typeof v === "bigint") return this.fromAddr(v);
    if (v && typeof v === "object") {
      if (v.k === "arr") {
        const arr = v;
        const el = from.tag === "array" ? from.element : U8;
        return this.ptr(this.viewOf(arr, "e", el, { count: () => arr.e.length, get: i => arr.e[i], set: (i, x) => { arr.e[i] = x; } }), 0);
      }
      if (v.k === "vec") return this.vecPtr(v, from.tag === "vec" || from.tag === "array" ? from.element : U8);
      if (v.k === "str") return this.strPtr(v);
    }
    return this.it.unsupported(`cast ${from.tag} -> ${to.tag}`);
  }

  // ── sizeOf<T>(), offsetOf<T>("f"), zeroed<T>() ──
  layoutBuiltin(e: Expr & { kind: "Call" }): Value {
    const ty = this.it.cr.sizeOfTypes.get(e);
    if (!ty) return this.it.unsupported(`${e.func} without a resolved type`);
    if (e.func === "sizeOf") return BigInt(this.sizeOf(ty));
    if (e.func === "offsetOf") return BigInt(this.offsetOf((ty as { name: string }).name, this.it.cr.offsetOfFields.get(e)!));
    return this.zero(ty);
  }
  zero(ty: TypeKind): Value {
    const it = this.it;
    switch (ty.tag) {
      case "int": return 0n;
      case "float": return 0;
      case "bool": return false;
      case "ptr": case "cfn": return 0n;
      case "string": return staticStr("");
      case "vec": return it.newVec([]);
      case "struct": { const f: Record<string, Value> = {}; for (const fd of it.structFields(ty.name)) f[fd.name] = this.zero(fd.type); return { k: "struct", name: ty.name, f }; }
      case "array": return ty.size === null ? it.unsupported("zeroed slice") : { k: "arr", e: Array.from({ length: ty.size }, () => this.zero(ty.element)) };
      case "enum": {
        const vs = [...(it.cr.enums.get(ty.name)?.variants ?? [])].sort((a, b) => a[1].tag - b[1].tag);
        const first = vs[0];
        return first ? it.mkEnum(ty.name, first[0], first[1].fields.map(f => this.zero(f))) : it.unsupported(`zeroed ${ty.name}`);
      }
    }
    return it.unsupported(`zeroed<${ty.tag}>`);
  }

  // ── pointers and integers ──
  addr(p: Value): bigint {
    if (p === 0n) return 0n;
    if (!isPtr(p)) return this.it.stuck("R-MEM-PROVENANCE", "an address was asked of something that is not a pointer");
    return BigInt(p.a.base + p.off);
  }
  fromAddr(n: bigint): Value {
    if (n === 0n) return 0n;
    const x = Number(BigInt.asUintN(64, n));
    let lo = 0, hi = this.allocs.length - 1, best: Alloc | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.allocs[mid]!.base <= x) { best = this.allocs[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (best && x < best.base + best.reserve) return this.ptr(best, x - best.base);
    // not inside any range this run handed out: it can be held and compared but never followed
    return { k: "ptr", a: WILD_ALLOC, off: x };
  }
  asPtr(p: Value, what: string): PtrV {
    if (p === 0n) return this.it.stuck("R-MEM-NULL", `${what} through a null pointer`);
    if (!isPtr(p)) return this.it.stuck("R-MEM-PROVENANCE", `${what} through a value that is not a pointer`);
    if (p.a === WILD_ALLOC) this.it.stuck("R-MEM-PROVENANCE", `${what} through address 0x${p.off.toString(16)}, which no allocation of this run owns`);
    return p;
  }
  describe(p: PtrV): string {
    return `allocation #${p.a.id} (${p.a.kind}, ${p.a.size} bytes) at offset ${p.off}`;
  }
  // The one access check: bounds, liveness, alignment, writability.
  access(p: Value, n: number, align: number, write: boolean, what: string): { be: Backing; off: number } {
    const q = this.asPtr(p, what);
    const a = q.a;
    if (!a.isLive()) this.it.stuck("R-MEM-UAF", `${what} of ${n} bytes in freed ${this.describe(q)}`);
    if (q.off < 0 || q.off + n > a.size) this.it.stuck("R-MEM-OOB", `${what} of ${n} bytes outside ${this.describe(q)}`);
    if (align > 1 && (a.base + q.off) % align !== 0) this.it.stuck("R-MEM-ALIGN", `${what} of ${n} bytes at an address not a multiple of ${align} in ${this.describe(q)}`);
    if (write && a.ro) this.it.stuck("R-MEM-WRITE-RO", `${what} writes read-only ${this.describe(q)}`);
    return { be: a.be, off: q.off };
  }

  // ── typed scalar and struct access ──
  load(p: Value, ty: TypeKind): Value {
    const n = this.sizeOf(ty);
    const { be, off } = this.access(p, n, Math.min(8, this.alignOf(ty)), false, "load");
    const b = be.read(off, n);
    return this.decode(ty, new DataView(b.buffer, b.byteOffset, b.byteLength), 0);
  }
  store(p: Value, ty: TypeKind, v: Value): void {
    const n = this.sizeOf(ty);
    const { be, off } = this.access(p, n, Math.min(8, this.alignOf(ty)), true, "store");
    const b = new Uint8Array(n);
    this.encode(v, ty, new DataView(b.buffer), 0);
    be.write(off, b);
  }
  readBytes(p: Value, n: number, what = "read"): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const { be, off } = this.access(p, n, 1, false, what);
    return Uint8Array.from(be.read(off, n));
  }
  writeBytes(p: Value, b: Uint8Array, what = "write"): void {
    if (b.length === 0) return;
    const { be, off } = this.access(p, b.length, 1, true, what);
    be.write(off, b);
  }
  // C's memcpy forbids overlap; memmove allows it. Overlapping memcpy is UB (R-MEM-OVERLAP).
  memcpy(dst: Value, src: Value, n: number, move: boolean): void {
    if (n === 0) return;
    const bytes = this.readBytes(src, n, move ? "memmove source" : "memcpy source");
    if (!move && isPtr(dst) && isPtr(src) && dst.a === src.a && dst.off < src.off + n && src.off < dst.off + n) {
      this.it.stuck("R-MEM-OVERLAP", `memcpy of ${n} bytes between overlapping ranges of ${this.describe(dst)}`);
    }
    this.writeBytes(dst, bytes, move ? "memmove destination" : "memcpy destination");
  }
  memset(dst: Value, c: number, n: number): void {
    if (n === 0) return;
    this.writeBytes(dst, new Uint8Array(n).fill(c & 255), "memset");
  }
  // the bytes of a NUL-terminated string, the NUL excluded; running off the allocation is R-MEM-OOB
  cstring(p: Value, what = "string read"): Uint8Array {
    const q = this.asPtr(p, what);
    const out: number[] = [];
    for (let i = 0; ; i++) {
      const b = this.readBytes(this.ptr(q.a, q.off + i), 1, what)[0]!;
      if (b === 0) return Uint8Array.from(out);
      out.push(b);
    }
  }

  // ── encode / decode by the compiled layout ──
  encode(v: Value, ty: TypeKind, dv: DataView, off: number): void {
    switch (ty.tag) {
      case "int": {
        const x = v === undefined ? 0n : (v as bigint);
        const u = BigInt.asUintN(ty.bits, x);
        if (ty.bits === 8) dv.setUint8(off, Number(u));
        else if (ty.bits === 16) dv.setUint16(off, Number(u), true);
        else if (ty.bits === 32) dv.setUint32(off, Number(u), true);
        else dv.setBigUint64(off, u, true);
        return;
      }
      case "float": {
        const x = v === undefined ? 0 : (v as number);
        if (ty.bits === 32) dv.setFloat32(off, x, true); else dv.setFloat64(off, x, true);
        return;
      }
      case "bool": dv.setUint8(off, v ? 1 : 0); return;
      case "ptr": case "cfn":
        if (v !== undefined && !isPtr(v) && typeof v !== "bigint") this.it.unsupported("a reference stored as a raw pointer in memory");
        dv.setBigUint64(off, v === undefined ? 0n : this.addr(v), true);
        return;
      case "struct": {
        const sl = this.layout.structLayouts.get(ty.name);
        if (!sl) return this.it.unsupported(`raw view of struct ${ty.name}`);
        const ftys = sl.fields.map(f => f.type);
        const s = v === undefined ? undefined : (v as Struct);
        sl.fields.forEach((f, i) => this.encode(s ? s.f[f.name] : undefined, f.typeKind, dv, off + this.layout.structFieldOffset(ftys, i)));
        return;
      }
      case "array": {
        if (ty.size === null) return this.it.unsupported("raw view of a slice");
        const es = this.sizeOf(ty.element);
        const arr = v === undefined ? undefined : (v as { e: Value[] }).e;
        for (let i = 0; i < ty.size; i++) this.encode(arr?.[i], ty.element, dv, off + i * es);
        return;
      }
    }
    return this.it.unsupported(`raw view of a ${ty.tag}`);
  }
  decode(ty: TypeKind, dv: DataView, off: number): Value {
    switch (ty.tag) {
      case "int": {
        const bits = ty.bits;
        let u: bigint;
        if (bits === 8) u = BigInt(dv.getUint8(off));
        else if (bits === 16) u = BigInt(dv.getUint16(off, true));
        else if (bits === 32) u = BigInt(dv.getUint32(off, true));
        else u = dv.getBigUint64(off, true);
        return ty.signed ? BigInt.asIntN(bits, u) : u;
      }
      case "float": return ty.bits === 32 ? dv.getFloat32(off, true) : dv.getFloat64(off, true);
      case "bool": return dv.getUint8(off) !== 0;
      case "ptr": case "cfn": return this.fromAddr(dv.getBigUint64(off, true));
      case "struct": {
        const sl = this.layout.structLayouts.get(ty.name);
        if (!sl) return this.it.unsupported(`raw view of struct ${ty.name}`);
        const ftys = sl.fields.map(f => f.type);
        const f: Record<string, Value> = {};
        sl.fields.forEach((fd, i) => { f[fd.name] = this.decode(fd.typeKind, dv, off + this.layout.structFieldOffset(ftys, i)); });
        return { k: "struct", name: ty.name, f };
      }
      case "array": {
        if (ty.size === null) return this.it.unsupported("raw view of a slice");
        const es = this.sizeOf(ty.element);
        return { k: "arr", e: Array.from({ length: ty.size }, (_, i) => this.decode(ty.element, dv, off + i * es)) };
      }
    }
    return this.it.unsupported(`raw view of a ${ty.tag}`);
  }
}

const U8: TypeKind = { tag: "int", bits: 8, signed: false };

// The slot a raw pointer names: reading `v` loads from memory, assigning it stores (R-MEM-LOAD, R-MEM-STORE).
export function memSlot(m: Mem, p: Value, ty: TypeKind): Slot {
  const slot = { mem: p, mty: ty } as unknown as Slot;
  Object.defineProperty(slot, "v", { get: () => m.load(p, ty), set: (v: Value) => m.store(p, ty, v), enumerable: true });
  return slot;
}
