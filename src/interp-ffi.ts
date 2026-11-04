// Reference interpreter, foreign code for the CLI only: the `extern fn`s of a wrapped C library (sqlite3_*, the
// CommonCrypto CC_* calls) and of a companion `foo.c` beside the program are run by the real library, through
// bun:ffi. Bun-only, like src/interp-hostfs.ts is Node-only: the browser bundle never imports this file, and
// without it those externs stay `InterpUnsupported` (src/interp-sys.ts). The driver (src/interp-run.ts) hands
// the Foreign in through SysOptions.
//
// The interpreter's memory is not real memory (src/interp-mem.ts), so a pointer argument is marshalled: the
// bytes from the pointer to the end of its allocation are copied into a native buffer for the length of the
// call and copied back after it (an out-parameter, a context struct the library keeps in the caller's memory).
// An address that no interpreter allocation owns (a sqlite3*, a statement) goes through as the integer it is.
// A pointer the library returns to a C string is copied into a read-only interpreter allocation; one that
// points into an argument's buffer is turned back into a pointer into the argument.
import { dlopen, FFIType, ptr as nativePtr, toArrayBuffer } from "bun:ffi";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Function as AstFn } from "./ast";
import type { Interp } from "./interp";
import { isPtr, type PtrV } from "./interp-mem";
import type { Foreign } from "./interp-sys";
import type { TypeKind } from "./types";
import type { Value } from "./interp-values";

const LIB = process.platform === "darwin"
  ? { sqlite3: "libsqlite3.dylib", system: "libSystem.B.dylib", cf: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation" }
  : { sqlite3: "libsqlite3.so.0", system: "libc.so.6", cf: "" };
// functions whose pointer result is a NUL-terminated C string the library owns
const C_STRING_RESULT = new Set(["sqlite3_column_text", "sqlite3_column_name", "sqlite3_errmsg", "sqlite3_errstr", "sqlite3_libversion", "sqlite3_sql", "sqlite3_column_decltype", "sqlite3_db_filename"]);
const SQLITE_TRANSIENT = (1n << 64n) - 1n;

type FfiType = (typeof FFIType)[keyof typeof FFIType];
// the C ABI class of a Milo extern type; null when the type cannot cross bun:ffi (a struct by value)
// R-FFI-CALL
function ffiType(t: TypeKind | undefined): FfiType | null {
  switch (t?.tag) {
    case "int": return t.bits === 64 ? (t.signed ? FFIType.i64 : FFIType.u64) : t.bits === 32 ? (t.signed ? FFIType.i32 : FFIType.u32) : t.bits === 16 ? (t.signed ? FFIType.i16 : FFIType.u16) : (t.signed ? FFIType.i8 : FFIType.u8);
    case "float": return t.bits === 32 ? FFIType.f32 : FFIType.f64;
    case "bool": return FFIType.bool;
    case "ptr": case "ref": return FFIType.u64; // a pointer is an integer in a register; u64 also carries SQLITE_TRANSIENT, (-1) as a pointer
    case "void": return FFIType.void;
  }
  return null;
}

interface Marshalled { base: bigint; size: number; orig: PtrV; buf: Buffer; before: Uint8Array }

export class BunForeign implements Foreign {
  private fns = new Map<string, ((...a: unknown[]) => unknown) | null>();
  private dbRoot: string | undefined;
  private keep: Buffer[] = []; // native buffers a call's arguments point into stay alive for the run
  // R-FFI-SQLITE-PATH: the interpreter's filesystem is in memory, so a database file named by a path of it lives under a
  // private directory of the host's temp dir (removed when the process exits), at the same path; `:memory:`, "" and
  // `file:` URIs go to sqlite as they are
  private databasePath(it: Interp, name: string): string {
    let target = name;
    if (name !== "" && name !== ":memory:" && !name.startsWith("file:")) {
      if (!this.dbRoot) {
        this.dbRoot = mkdtempSync(join(tmpdir(), "milo-sqlite-"));
        process.on("exit", () => { try { rmSync(this.dbRoot!, { recursive: true, force: true }); } catch { /* best effort */ } });
      }
      const abs = name.startsWith("/") ? name : join(it.sys?.cwd ?? "/", name);
      target = join(this.dbRoot, abs);
      mkdirSync(dirname(target), { recursive: true });
    }
    return target;
  }
  // R-FFI-SQLITE-PATH: a database file sqlite made is visible at its path in the interpreter's filesystem, and deleting it there deletes it
  mirror(path: string): { size: number; dir: boolean; mtimeMs: number; data: Uint8Array } | null {
    if (!this.dbRoot) return null;
    try {
      const real = join(this.dbRoot, path), st = statSync(real);
      return { size: st.size, dir: st.isDirectory(), mtimeMs: st.mtimeMs, data: st.isDirectory() ? new Uint8Array(0) : new Uint8Array(readFileSync(real)) };
    } catch { return null; }
  }
  // R-FFI-SQLITE-PATH
  unlink(path: string): void {
    if (this.dbRoot) rmSync(join(this.dbRoot, path), { force: true, recursive: true });
  }
  // R-FFI-CALL
  private nativeString(text: string): bigint {
    const buf = Buffer.from(text + "\0");
    this.keep.push(buf);
    return BigInt(nativePtr(buf));
  }
  // R-FFI-SQLITE-PATH: the file a statement names (`ATTACH '...'`, `VACUUM INTO '...'`) is mapped the same way
  private mapSqlPaths(it: Interp, sql: string): string {
    return sql.replace(/(\b(?:ATTACH(?:\s+DATABASE)?|VACUUM(?:\s+\w+)?\s+INTO)\s+)'((?:[^']|'')*)'/gi, (_m, head: string, p: string) => `${head}'${this.databasePath(it, p.replace(/''/g, "'")).replace(/'/g, "''")}'`);
  }
  // companionC: the program's `foo.c`, compiled to a shared library the first time one of its functions is called
  constructor(private companionC?: string) {}

  private companionLib: string | null | undefined;
  // R-FFI-COMPANION
  private companion(): string | null {
    if (this.companionLib !== undefined) return this.companionLib;
    if (!this.companionC) return (this.companionLib = null);
    const out = join(mkdtempSync(join(tmpdir(), "milo-ffi-")), "companion" + (process.platform === "darwin" ? ".dylib" : ".so"));
    const cc = spawnSync(process.platform === "darwin" ? "xcrun" : "cc", process.platform === "darwin" ? ["clang", "-shared", "-fPIC", "-o", out, this.companionC] : ["-shared", "-fPIC", "-o", out, this.companionC], { encoding: "utf8" });
    if (cc.status !== 0) throw new Error(`companion C file ${this.companionC} did not compile:\n${cc.stderr}`);
    return (this.companionLib = out);
  }
  // R-FFI-LIB
  private libFor(sym: string): string | null {
    if (/^sqlite3_/.test(sym)) return LIB.sqlite3;
    if (/^(CC_|CCCrypt|CCKey|CCHmac)/.test(sym)) return LIB.system;
    if (/^CF[A-Z]/.test(sym) && LIB.cf) return LIB.cf;
    return this.companionC ? this.companion() : null;
  }
  // R-FFI-LIB
  handles(sym: string): boolean {
    if (/^sqlite3_/.test(sym)) return true;
    if (/^(CC_|CCCrypt|CCKey|CCHmac|CF[A-Z])/.test(sym)) return process.platform === "darwin";
    return !!this.companionC;
  }
  // R-FFI-LIB
  private fn(sym: string, params: FfiType[], ret: FfiType): ((...a: unknown[]) => unknown) | null {
    const key = `${sym}:${params.join(",")}:${ret}`;
    if (this.fns.has(key)) return this.fns.get(key)!;
    let f: ((...a: unknown[]) => unknown) | null = null;
    const path = this.libFor(sym);
    if (path) {
      try { f = dlopen(path, { [sym]: { args: params, returns: ret } }).symbols[sym] as (...a: unknown[]) => unknown; } catch { f = null; }
    }
    this.fns.set(key, f);
    return f;
  }

  // R-FFI-CALL
  call(it: Interp, sym: string, fn: AstFn, args: Value[]): Value {
    const sig = it.cr.functions.get(fn.name);
    const ptypes = (sig?.params ?? []).map(p => ffiType(p.type));
    const rtype = ffiType(sig?.ret ?? { tag: "void" });
    if (!sig || ptypes.some(t => t === null) || rtype === null || args.length !== ptypes.length) return it.unsupported(`extern ${sym} (a struct by value, a variadic call or an unresolvable signature cannot cross bun:ffi)`);
    const native = this.fn(sym, ptypes as FfiType[], rtype);
    if (!native) return it.unsupported(`extern ${sym} (not found in the system library)`);
    const bound: Marshalled[] = [];
    if (/^sqlite3_open/.test(sym) && isPtr(args[0])) args = [this.nativeString(this.databasePath(it, new TextDecoder().decode(it.mem.cstring(args[0], "sqlite3_open filename")))), ...args.slice(1)];
    if (/^sqlite3_(prepare|exec)/.test(sym) && isPtr(args[1])) {
      const sql = new TextDecoder().decode(it.mem.cstring(args[1], "sqlite3 statement"));
      const mapped = this.mapSqlPaths(it, sql);
      if (mapped !== sql) args = args.map((a, i) => (i === 1 ? this.nativeString(mapped) : i === 2 && /^sqlite3_prepare/.test(sym) ? -1n : a));
    }
    const callArgs = args.map((a, i) => {
      const t = ptypes[i]!;
      if (t === FFIType.u64 && sig.params[i]!.type.tag !== "int") return this.pointerArg(it, sym, i, a, bound);
      if (t === FFIType.bool) return !!a;
      if (t === FFIType.f32 || t === FFIType.f64) return Number(a);
      return a as bigint; // an integer: bun:ffi takes a bigint for i64 / u64 and truncates to the C width itself
    });
    const callNumbers = callArgs.map((a, i) => (typeof a === "bigint" && ptypes[i] !== FFIType.i64 && ptypes[i] !== FFIType.u64 ? Number(a) : a));
    const raw = native(...callNumbers);
    for (const m of bound) this.copyBack(it, m);
    return this.result(it, sym, sig.ret, raw, bound, args);
  }

  // A pointer argument: an interpreter pointer is copied to a native buffer, anything else is an integer address
  private pointerArg(it: Interp, sym: string, idx: number, a: Value, bound: Marshalled[]): bigint {
    // R-FFI-CALL: sqlite is told the text is transient, since a static buffer would be the temporary copy made here
    if (/^sqlite3_bind_(text|blob)/.test(sym) && idx === 4 && a === 0n) return SQLITE_TRANSIENT;
    if (a === undefined || a === 0n) return 0n;
    if (typeof a === "bigint") return BigInt.asUintN(64, a);
    if (!isPtr(a)) return it.stuck("R-MEM-PROVENANCE", `extern ${sym}: argument ${idx + 1} is not a pointer`);
    const n = a.a.size - a.off;
    const before = n > 0 ? it.mem.readBytes(a, n, `extern ${sym} argument`).slice() : new Uint8Array(0);
    const buf = Buffer.alloc(Math.max(before.length, 1));
    buf.set(before);
    const base = BigInt(nativePtr(buf));
    bound.push({ base, size: before.length, orig: a, buf, before });
    return base;
  }
  // R-FFI-CALL: what the library wrote into an argument's buffer goes back to the interpreter's memory
  private copyBack(it: Interp, m: Marshalled): void {
    const now = m.buf.subarray(0, m.size);
    if (m.size === 0 || Buffer.compare(now, m.before) === 0) return;
    it.mem.writeBytes(m.orig, new Uint8Array(now), "extern argument");
  }
  // R-FFI-CALL
  private result(it: Interp, sym: string, rt: TypeKind | undefined, raw: unknown, bound: Marshalled[], args: Value[]): Value {
    switch (rt?.tag) {
      case "void": return undefined;
      case "bool": return !!raw;
      case "float": return Number(raw);
      case "int": return BigInt.asIntN(rt.bits, BigInt(raw as number | bigint));
      case "ptr": case "ref": {
        const addr = BigInt.asUintN(64, BigInt(raw as number | bigint));
        if (addr === 0n) return 0n;
        const inArg = bound.find(m => addr >= m.base && addr < m.base + BigInt(Math.max(m.size, 1)));
        if (inArg) return it.mem.advance(inArg.orig, Number(addr - inArg.base));
        if (sym === "sqlite3_column_text") { // the text may hold NUL bytes: its length is what sqlite3_column_bytes says
          const bytes = this.fn("sqlite3_column_bytes", [FFIType.u64, FFIType.i32], FFIType.i32)!(args[0], Number(args[1])) as number;
          return this.copyBytes(it, addr, bytes);
        }
        if (C_STRING_RESULT.has(sym)) return this.copyCString(it, addr);
        return addr; // an opaque handle: held and compared, never followed (R-MEM-PROVENANCE)
      }
    }
    return undefined;
  }
  // R-FFI-CALL
  private copyBytes(it: Interp, addr: bigint, n: number): Value {
    const view = new Uint8Array(toArrayBuffer(Number(addr) as never, 0, Math.max(n, 1)));
    return it.mem.staticBytes(new Uint8Array([...view.subarray(0, n), 0]), true);
  }
  // R-FFI-CALL
  private copyCString(it: Interp, addr: bigint): Value {
    const view = new Uint8Array(toArrayBuffer(Number(addr) as never, 0, 1 << 24));
    let n = 0;
    while (view[n] !== 0 && n < view.length) n++;
    return it.mem.staticBytes(new Uint8Array([...view.subarray(0, n), 0]), true);
  }
}
