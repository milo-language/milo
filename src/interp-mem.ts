// Reference interpreter, raw memory: the byte-level model behind `malloc`, `.ptr()`, `.addrOf()`,
// `string.cstr()` and every `*T` load and store (docs/semantics/milo.md §5, R-MEM-*).
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
import { unique } from "./interp-natives";
import { staticStr, type Place, type Ref, type Slot, type Str, type Struct, type Value, type VecV } from "./interp-values";

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
    readonly id: number, readonly base: number, readonly reserve: number, readonly kind: "heap" | "static" | "view" | "map",
    readonly be: Backing, public ro: boolean, readonly block: number,
  ) {}
  get size(): number { return this.be.size(); }
  isLive(): boolean { return this.live && (this.be.live ? this.be.live() : true); }
}

class Raw implements Backing {
  bytes: Uint8Array;
  constructor(n: number) { this.bytes = new Uint8Array(n); }
  // R-MEM-OOB
  size() { return this.bytes.length; }
  // R-MEM-LOAD
  read(off: number, n: number) { return this.bytes.subarray(off, off + n); }
  // R-MEM-STORE
  write(off: number, b: Uint8Array) { this.bytes.set(b, off); }
}

// A run of equal-typed elements the interpreter holds as Values.
export interface ElemSrc { count(): number; get(i: number): Value; set(i: number, v: Value): void; live?(): boolean }
class ElemView implements Backing {
  constructor(private m: Mem, readonly ty: TypeKind, readonly es: number, readonly src: ElemSrc) {}
  // an access of exactly one element of this view's type, on an element boundary: the Value itself, no bytes
  // R-MEM-ALIGN
  elemIndex(off: number, ty: TypeKind): number {
    const same = ty.tag === this.ty.tag && (ty.tag !== "struct" && ty.tag !== "enum" ? true : (ty as { name: string }).name === (this.ty as { name: string }).name);
    return same && off % this.es === 0 ? off / this.es : -1;
  }
  // R-MEM-OOB
  size() { return this.src.count() * this.es; }
  // R-MEM-UAF
  live() { return this.src.live ? this.src.live() : true; }
  // R-MEM-OOB
  private span(off: number, n: number): [number, number] {
    return [Math.floor(off / this.es), Math.max(Math.floor(off / this.es), Math.ceil((off + n) / this.es))];
  }
  // R-MEM-LOAD
  read(off: number, n: number): Uint8Array {
    const [lo, hi] = this.span(off, n);
    const tmp = new Uint8Array((hi - lo) * this.es);
    const dv = new DataView(tmp.buffer);
    for (let i = lo; i < hi; i++) this.m.encode(this.src.get(i), this.ty, dv, (i - lo) * this.es);
    return tmp.subarray(off - lo * this.es, off - lo * this.es + n);
  }
  // R-MEM-STORE
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

export class Mem {
  allocs: Alloc[] = [];
  private next = 0x10000;
  private ids = 0;
  private layoutCache: Layout | undefined;
  private views = new WeakMap<object, Map<string, Alloc>>();
  onAccess: ((a: Alloc) => void) | null = null; // the schedule explorer's view of shared heap (R-EXPLORE-INDEP)
  constructor(private it: Interp) {}

  // ── layout (the compiled program's sizes and offsets) ──
  // R-MEM-COPY
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
  // R-MEM-ALLOC
  private make(kind: "heap" | "static" | "view" | "map", be: Backing, ro: boolean, block: number): Alloc {
    const size = be.size();
    const reserve = kind === "view" ? Math.max(size, VIEW_RESERVE) : size + GAP;
    const a = new Alloc(++this.ids, this.next, reserve, kind, be, ro, block);
    this.next += Math.ceil((reserve + GAP) / 16) * 16;
    this.allocs.push(a);
    return a;
  }
  ptr(a: Alloc, off = 0): PtrV { return { k: "ptr", a, off }; }
  // malloc: counted in the live-block tally like every other heap block (a compiled run counts the same)
  // R-MEM-ALLOC
  malloc(n: number): PtrV {
    if (n < 0 || n > 1 << 30) return this.it.unsupported(`malloc of ${n} bytes`);
    return this.ptr(this.make("heap", new Raw(n), false, this.it.alloc()));
  }
  // R-MEM-FREE
  free(p: Value): void {
    if (p === 0n) return; // free(NULL) is a no-op
    const q = this.asPtr(p, "free");
    if (q.a.kind !== "heap" || q.off !== 0) this.it.stuck("R-MEM-FREE-INVALID", `free of a pointer that malloc did not return (${this.describe(q)})`);
    if (!q.a.live) this.it.stuck("R-MEM-DOUBLE-FREE", `${this.describe(q)} was already freed`);
    q.a.live = false;
    this.it.free(q.a.block);
  }
  // R-MEM-REALLOC
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
  // mmap: pages are not malloc blocks (a compiled run's live-block count does not see them); only munmap releases them
  // R-MEM-WRITE-RO
  map(bytes: Uint8Array, ro: boolean): PtrV {
    const r = new Raw(bytes.length);
    r.bytes.set(bytes);
    return this.ptr(this.make("map", r, ro, -1));
  }
  unmap(p: Value): void {
    const q = this.asPtr(p, "munmap");
    if (q.a.kind !== "map" || q.off !== 0) this.it.stuck("R-MEM-FREE-INVALID", `munmap of a pointer that mmap did not return (${this.describe(q)})`);
    if (!q.a.live) this.it.stuck("R-MEM-DOUBLE-FREE", `${this.describe(q)} was already unmapped`);
    q.a.live = false;
  }
  protect(p: Value, writable: boolean): void { const q = this.asPtr(p, "mprotect"); q.a.ro = !writable; }
  // bytes the interpreter hands out and nothing frees: a `cstr()` copy, a host buffer. Not a counted block.
  // R-MEM-WRITE-RO
  staticBytes(bytes: Uint8Array, ro = false): PtrV {
    const r = new Raw(bytes.length);
    r.bytes.set(bytes);
    return this.ptr(this.make("static", r, ro, -1));
  }

  // a byte view of structured values; one allocation per (owner, key) so a pointer taken twice compares equal
  // R-MEM-VECPTR
  viewOf(owner: object, key: string, ty: TypeKind, src: ElemSrc, ro = false): Alloc {
    let m = this.views.get(owner);
    if (!m) this.views.set(owner, (m = new Map()));
    let a = m.get(key);
    if (!a) m.set(key, (a = this.make("view", new ElemView(this, ty, this.sizeOf(ty), src), ro, -1)));
    return a;
  }
  // R-MEM-ADDR
  advance(p: Value, bytes: number): Value {
    if (isPtr(p)) return { k: "ptr", a: p.a, off: p.off + bytes };
    return this.fromAddr(this.addr(p) + BigInt(bytes));
  }

  // ── pointers to the interpreter's structured values ──
  // `v.ptr()`: the buffer's elements, from the slice's first. An empty Vec owns no block, so its pointer is null.
  // R-MEM-VECPTR
  vecPtr(h: VecV, elem: TypeKind): Value {
    if (!h.buf) return 0n;
    const b = h.buf;
    const a = this.viewOf(b, "elems", elem, { count: () => b.elems.length, get: i => b.elems[i], set: (i, v) => { b.elems[i] = v; }, live: () => b.id < 0 || this.it.blocks.has(b.id) });
    return this.ptr(a, h.start * this.sizeOf(elem));
  }
  // `s.cstr()`: a NUL-terminated copy. Nothing frees it and the string does not see writes to it, as C's `const char *`.
  // R-MEM-CSTR
  cstr(s: Str): PtrV {
    const b = new Uint8Array(s.b.bytes.length + 1);
    b.set(s.b.bytes);
    return this.staticBytes(b);
  }
  // The Vec header as std/vec.milo's `VecHead { _data, _len, _cap }` sees it through `v.addrOf() as *VecHead`. Reading it
  // builds the three words from the Vec; writing it sets the length and capacity back. Pointing `_data` at a different
  // buffer is not modelled: a Vec's buffer here is its structured element array.
  // R-MEM-VECPTR
  vecHeadPtr(pl: Place, key: string, elem: TypeKind): Value {
    const it = this.it;
    const name = [...it.cr.structs.keys()].find(k => k === "VecHead" || k.endsWith("$VecHead"));
    if (!name) return it.unsupported(".addrOf() of a vec (std/vec's VecHead is not in the program)");
    const cur = () => it.getPlace(pl) as VecV;
    const head: TypeKind = { tag: "struct", name };
    const a = this.viewOf(pl.slot, key, head, {
      count: () => 1,
      get: () => ({ k: "struct", name, f: { _data: this.vecPtr(cur(), elem), _len: BigInt(cur().len), _cap: BigInt(cur().cap) } }),
      set: (_i, s) => {
        const h = cur(), f = (s as Struct).f;
        if (this.addr(f._data!) !== this.addr(this.vecPtr(h, elem))) it.unsupported("a Vec header pointed at a different buffer");
        h.len = Number(f._len as bigint);
        if (Number(f._cap as bigint) !== h.cap) { h.cap = Number(f._cap as bigint); if (h.buf) h.buf.elems.length = h.start + h.cap; }
      },
      live: () => !pl.slot.dead,
    });
    return this.ptr(a, 0);
  }
  // What C is given for a string: a literal (no heap buffer) is copied into a NUL-terminated block of its own, so
  // the literal and every handle made from it stay intact; any other string is made the only handle to its buffer
  // (when it sits in a place) and C gets the buffer itself.
  // R-MEM-CSTR
  cPtr(s: Str, place?: Ref): Value {
    if (s.b.id < 0) return this.cstr(s);
    return this.strPtr(place ? unique(this.it, place) : s);
  }
  // a string's bytes as `*u8` (a literal's are read-only)
  // R-MEM-VECPTR
  strPtr(s: Str): Value {
    const sb = s.b;
    // a string is NUL-terminated in memory: the view has one byte past the content, always 0
    const a = this.viewOf(sb, "bytes", U8, {
      count: () => sb.bytes.length + 1,
      get: i => BigInt(i < sb.bytes.length ? sb.bytes[i]! : 0),
      set: (i, v) => { if (i < sb.bytes.length) sb.bytes[i] = Number(v as bigint); },
      live: () => sb.id < 0 || this.it.blocks.has(sb.id),
    }, sb.id < 0);
    return this.ptr(a, 0);
  }
  // `x.addrOf()`: the bytes of a place. A fixed array is its elements, any other value one element of its type.
  // R-MEM-ADDROF
  placePtr(pl: Place, ty: TypeKind): Value {
    if (pl.slot.mem) return pl.slot.mem;
    const it = this.it;
    const key = pl.path.join("/") + "|" + ty.tag;
    if (ty.tag === "array" && ty.size !== null) {
      const arr = it.getPlace(pl) as { e: Value[] };
      const a = this.viewOf(arr, "e", ty.element, { count: () => arr.e.length, get: i => arr.e[i], set: (i, v) => { arr.e[i] = v; } });
      return this.ptr(a, 0);
    }
    if (ty.tag === "vec") return this.vecHeadPtr(pl, key, ty.element);
    if (!["int", "float", "bool", "ptr", "struct", "array"].includes(ty.tag)) return it.unsupported(`.addrOf() of a ${ty.tag}`);
    const a = this.viewOf(pl.slot, key, ty, { count: () => 1, get: () => it.getPlace(pl), set: (_i, v) => it.setPlace(pl, v), live: () => !pl.slot.dead });
    return this.ptr(a, 0);
  }
  // R-MEM-CSTR: a string or fixed array (or a borrow of one) given to a `*T` parameter becomes a pointer to its bytes.
  // The pointer is to the string's own buffer, which a place argument first makes unique (as `cstr()` does) so a
  // write through it reaches no other handle. A string passed by value is a share the call now owns: it goes in
  // `hold`, and the caller drops it when the call is over, so the buffer outlives every use of the pointer.
  decay(v: Value, param: TypeKind | undefined, hold: Value[]): Value {
    if (!v || typeof v !== "object") return v;
    // an extern's `&T` / `&mut T` parameter is the address of the place the reference names
    if (param?.tag === "ref" && (v.k === "ref" || v.k === "mut")) return this.placePtr(this.it.derefPlace(v), param.inner);
    if (param?.tag !== "ptr") return v;
    if (v.k === "ref" || v.k === "mut") {
      const inner = this.it.deref(v);
      if (inner && typeof inner === "object" && inner.k === "str") return this.cPtr(inner, v);
      if (inner && typeof inner === "object" && inner.k === "arr") return this.decay(inner, param, hold);
      return v;
    }
    if (v.k === "str") { hold.push(v); return this.cPtr(v); }
    if (v.k === "arr") return this.castToPtr(v, { tag: "array", element: param.inner, size: v.e.length }, param);
    return v;
  }
  // R-MEM-ADDR
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
  // R-MEM-COPY
  layoutBuiltin(e: Expr & { kind: "Call" }): Value {
    const ty = this.it.cr.sizeOfTypes.get(e);
    if (!ty) return this.it.unsupported(`${e.func} without a resolved type`);
    if (e.func === "sizeOf") return BigInt(this.sizeOf(ty));
    if (e.func === "offsetOf") return BigInt(this.offsetOf((ty as { name: string }).name, this.it.cr.offsetOfFields.get(e)!));
    return this.zero(ty);
  }
  // R-MEM-COPY
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
    if (typeof p === "bigint") return p; // null, or an address no allocation owns (a task id the scheduler natives pass as a pointer)
    if (!isPtr(p)) return this.it.stuck("R-MEM-PROVENANCE", "an address was asked of something that is not a pointer");
    return BigInt(p.a.base + p.off);
  }
  // R-MEM-ADDR
  fromAddr(n: bigint): Value {
    if (n === 0n) return 0n;
    const x = Number(BigInt.asUintN(64, n));
    let lo = 0, hi = this.allocs.length - 1, best: Alloc | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.allocs[mid]!.base <= x) { best = this.allocs[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (best && x < best.base + best.reserve) return this.ptr(best, x - best.base);
    return n; // inside no range this run handed out: it can be held and compared but never followed
  }
  asPtr(p: Value, what: string): PtrV {
    if (p === 0n) return this.it.stuck("R-MEM-NULL", `${what} through a null pointer`);
    if (typeof p === "bigint") return this.it.stuck("R-MEM-PROVENANCE", `${what} through address 0x${BigInt.asUintN(64, p).toString(16)}, which no allocation of this run owns`);
    if (!isPtr(p)) return this.it.stuck("R-MEM-PROVENANCE", `${what} through a value that is not a pointer`);
    return p;
  }
  // R-MEM-PROVENANCE
  describe(p: PtrV): string {
    return `allocation #${p.a.id} (${p.a.kind}, ${p.a.size} bytes) at offset ${p.off}`;
  }
  // The one access check: bounds, liveness, alignment, writability.
  access(p: Value, n: number, align: number, write: boolean, what: string): { be: Backing; off: number } {
    const q = this.asPtr(p, what);
    const a = q.a;
    this.onAccess?.(a);
    if (!a.isLive()) this.it.stuck("R-MEM-UAF", `${what} of ${n} bytes in freed ${this.describe(q)}`);
    if (q.off < 0 || q.off + n > a.size) this.it.stuck("R-MEM-OOB", `${what} of ${n} bytes outside ${this.describe(q)}`);
    if (align > 1 && (a.base + q.off) % align !== 0) this.it.stuck("R-MEM-ALIGN", `${what} of ${n} bytes at an address not a multiple of ${align} in ${this.describe(q)}`);
    if (write && a.ro) this.it.stuck("R-MEM-WRITE-RO", `${what} writes read-only ${this.describe(q)}`);
    return { be: a.be, off: q.off };
  }

  // ── typed scalar and struct access ──
  // A type with no byte form here (a string, Vec, enum, closure...): only a view of values of exactly that type can
  // be read or written through a pointer, and the access moves the Value itself, as a bitwise copy of the header
  // words would (the library's own drop and forget calls then balance the counts, as in a compiled run).
  // R-MEM-ADDROF
  encodable(ty: TypeKind): boolean {
    switch (ty.tag) {
      case "int": case "float": case "bool": case "ptr": case "cfn": return true;
      case "array": return ty.size !== null && this.encodable(ty.element);
      case "struct": return (this.it.cr.structs.get(ty.name)?.fields ?? []).every(f => this.encodable(f.type));
    }
    return false;
  }
  // R-MEM-LOAD
  private valueView(p: Value, ty: TypeKind, write: boolean): { v: ElemView; i: number } {
    const n = this.sizeOf(ty);
    const { be, off } = this.access(p, n, 1, write, write ? "store" : "load");
    const i = be instanceof ElemView ? be.elemIndex(off, ty) : -1;
    if (!(be instanceof ElemView) || i < 0) return this.it.unsupported(`raw view of a ${ty.tag}`);
    return { v: be, i };
  }
  // R-MEM-LOAD
  load(p: Value, ty: TypeKind): Value {
    if (!this.encodable(ty)) { const { v, i } = this.valueView(p, ty, false); return v.src.get(i); }
    const n = this.sizeOf(ty);
    const { be, off } = this.access(p, n, Math.min(8, this.alignOf(ty)), false, "load");
    const b = be.read(off, n);
    return this.decode(ty, new DataView(b.buffer, b.byteOffset, b.byteLength), 0);
  }
  // R-MEM-STORE
  store(p: Value, ty: TypeKind, v: Value): void {
    if (!this.encodable(ty)) { const { v: vw, i } = this.valueView(p, ty, true); vw.src.set(i, v); return; }
    const n = this.sizeOf(ty);
    const { be, off } = this.access(p, n, Math.min(8, this.alignOf(ty)), true, "store");
    const b = new Uint8Array(n);
    this.encode(v, ty, new DataView(b.buffer), 0);
    be.write(off, b);
  }
  // R-MEM-COPY
  readBytes(p: Value, n: number, what = "read"): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const { be, off } = this.access(p, n, 1, false, what);
    return Uint8Array.from(be.read(off, n));
  }
  // R-MEM-COPY
  writeBytes(p: Value, b: Uint8Array, what = "write"): void {
    if (b.length === 0) return;
    const { be, off } = this.access(p, b.length, 1, true, what);
    be.write(off, b);
  }
  // C's memcpy forbids overlap; memmove allows it. Overlapping memcpy is UB (R-MEM-OVERLAP).
  memcpy(dst: Value, src: Value, n: number, move: boolean): void {
    if (n === 0) return;
    // two views of the same non-byte element type (Vec<string> to Vec<string>): move the Values
    const sa = isPtr(src) ? src.a.be : undefined, da = isPtr(dst) ? dst.a.be : undefined;
    if (sa instanceof ElemView && da instanceof ElemView && !this.encodable(sa.ty) && sa.ty.tag === da.ty.tag && n % sa.es === 0) {
      const s = this.valueView(src, sa.ty, false), d = this.valueView(dst, sa.ty, true), k = n / sa.es;
      this.access(src, n, 1, false, "memcpy source");
      this.access(dst, n, 1, true, "memcpy destination");
      const vals = Array.from({ length: k }, (_, j) => s.v.src.get(s.i + j));
      vals.forEach((x, j) => d.v.src.set(d.i + j, x));
      return;
    }
    const bytes = this.readBytes(src, n, move ? "memmove source" : "memcpy source");
    if (!move && isPtr(dst) && isPtr(src) && dst.a === src.a && dst.off < src.off + n && src.off < dst.off + n) {
      this.it.stuck("R-MEM-OVERLAP", `memcpy of ${n} bytes between overlapping ranges of ${this.describe(dst)}`);
    }
    this.writeBytes(dst, bytes, move ? "memmove destination" : "memcpy destination");
  }
  // R-MEM-COPY
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
  // R-MEM-STORE
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
  // R-MEM-LOAD
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
