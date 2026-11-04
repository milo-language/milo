// Reference interpreter, the C layer: the functions std declares `extern` and calls, implemented over
// the byte memory of src/interp-mem.ts the way WASI or Emscripten implement libc's bottom layer. std's
// own Milo code (fs, io, time, random, env, mem, os) runs on top unchanged; nothing here knows what
// std/fs or std/time are for. Files live in an in-memory filesystem; the host's is reachable only
// through an injected read-only HostFs (the CLI passes one, the browser playground passes none),
// so this file imports no node module and bundles for the browser.
//
// Pipes, sockets, signals and threads are in src/interp-net.ts (NET, looked up before SYS).
// Not modelled, reported as unsupported with the function's name: process spawning, dynamic loading,
// pty/terminal control, TLS and the other C libraries std wraps.
import type { Function as AstFn } from "./ast";
import type { Interp } from "./interp";
import { wrapInt } from "./interp";
import { ExitProgram, enc, type Value } from "./interp-values";
import { LIBC } from "./interp-libc";
import { NET, type FdObj } from "./interp-net";
import type { Native } from "./interp-natives";

// What the interpreter may read of the real filesystem. Read-only by construction: there is no write method.
export interface HostFs {
  readFile(path: string): Uint8Array | null;
  readdir(path: string): { name: string; dir: boolean }[] | null;
  stat(path: string): { size: number; dir: boolean; mtimeMs: number } | null;
}
// Code outside the interpreter that runs some externs for real (a wrapped C library, the program's companion C file).
// The CLI driver injects one under Bun (src/interp-ffi.ts); the browser bundle has none and those externs stay unsupported.
export interface Foreign {
  handles(sym: string): boolean;
  call(it: Interp, sym: string, fn: AstFn, args: Value[]): Value;
  // a file the foreign code made at a path of the interpreter's filesystem (a database file), so the program can stat, read and delete it
  mirror?(path: string): { size: number; dir: boolean; mtimeMs: number; data: Uint8Array } | null;
  unlink?(path: string): void;
}
export interface SysOptions {
  foreign?: Foreign;
  hostFs?: HostFs;
  // host paths the program may read: its own directory by default, "/" under --host-fs
  hostRoots?: string[];
  cwd?: string;
  stdin?: () => Uint8Array; // read on the first read(0), so a program that never reads stdin never waits for it
  env?: Record<string, string>;
  argv0?: string;
}

interface Node { link?: string; dir: boolean; data: Uint8Array; size: number; mode: number; mtimeMs: number; dev?: "null" | "zero" | "random" }
export interface Fd { node: Node | null; path: string; pos: number; read: boolean; write: boolean; append: boolean; std?: 0 | 1 | 2; obj?: FdObj }
interface DirStream { names: { name: string; dir: boolean; link?: boolean }[]; i: number; ent: Value }

const ERRNO = { EPERM: 1, ENOENT: 2, EBADF: 9, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOSPC: 28, ESPIPE: 29, ERANGE: 34 };
const platform = (): "darwin" | "linux" => (typeof process !== "undefined" && process.platform === "linux" ? "linux" : "darwin");
const ENOTEMPTY = () => (platform() === "darwin" ? 66 : 39);
// open(2) flag bits, per the OS std's own platform arm was chosen for
const OFLAGS = () => (platform() === "darwin"
  ? { creat: 0x200, trunc: 0x400, append: 0x8, excl: 0x800, directory: 0x100000 }
  : { creat: 0x40, trunc: 0x200, append: 0x400, excl: 0x80, directory: 0x10000 });

const norm = (cwd: string, p: string): string => {
  const parts: string[] = [];
  for (const s of (p.startsWith("/") ? p : cwd + "/" + p).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") parts.pop(); else parts.push(s);
  }
  return "/" + parts.join("/");
};
const parentOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0)) || "/";

export class Sys {
  files = new Map<string, Node>();
  gone = new Set<string>(); // host paths unlinked in this run: the host copy no longer shows
  fds = new Map<number, Fd>();
  dirs = new Map<number, DirStream>();
  cwd: string;
  env: Map<string, string>;
  errnoCell: Value | undefined;
  envCells = new Map<string, Value>();
  sleptMs = 0; // R-SYS-CLOCK: sleeping moves the clock instead of waiting
  stdinPos = 0;
  stdinBuf: Uint8Array | undefined;
  constructor(public it: Interp, public o: SysOptions) {
    this.cwd = o.cwd ?? "/";
    this.env = new Map(Object.entries(o.env ?? {}));
    for (const d of ["/", "/tmp", "/var", "/var/tmp"]) this.files.set(d, { dir: true, data: new Uint8Array(0), size: 0, mode: d === "/tmp" ? 0o777 : 0o755, mtimeMs: 0 });
    for (const d of ["/dev", "/dev/fd", "/proc", "/proc/self", "/proc/self/fd"]) this.files.set(d, { dir: true, data: new Uint8Array(0), size: 0, mode: 0o755, mtimeMs: 0 });
    for (const [name, dev] of [["null", "null"], ["zero", "zero"], ["urandom", "random"], ["random", "random"]] as const) {
      this.files.set("/dev/" + name, { dir: false, data: new Uint8Array(0), size: 0, mode: 0o666, mtimeMs: 0, dev });
    }
    initStdio(this);
  }

  // ── errno ──
  // R-SYS-FD
  setErrno(e: number): bigint {
    if (!this.errnoCell) this.errnoCell = this.it.mem.staticBytes(new Uint8Array(4));
    this.it.mem.store(this.errnoCell, I32, BigInt(e));
    return -1n;
  }

  // ── paths ──
  private hostAllowed(p: string): boolean { return !!this.o.hostFs && (this.o.hostRoots ?? []).some(r => p === r || p.startsWith(r === "/" ? "/" : r + "/")); }
  // R-SYS-FS
  lookup(p: string): Node | null {
    const hit = this.files.get(p);
    if (hit) return hit;
    if (this.gone.has(p)) return null;
    const mirrored = this.o.foreign?.mirror?.(p);
    if (mirrored) {
      const node: Node = { dir: mirrored.dir, data: mirrored.data, size: mirrored.size, mode: 0o644, mtimeMs: mirrored.mtimeMs };
      this.files.set(p, node);
      return node;
    }
    if (!this.hostAllowed(p)) return null;
    const st = this.o.hostFs!.stat(p);
    if (!st) return null;
    // a host file is copied in when first touched; later reads see the copy, so a run never sees the host change under it
    const n: Node = st.dir ? { dir: true, data: new Uint8Array(0), size: 0, mode: 0o755, mtimeMs: st.mtimeMs } : { dir: false, data: this.o.hostFs!.readFile(p) ?? new Uint8Array(0), size: st.size, mode: 0o644, mtimeMs: st.mtimeMs };
    this.files.set(p, n);
    return n;
  }
  // R-SYS-SYMLINK: the path a chain of symbolic links ends at (a link is relative to its own directory); a loop of more than 8 stops where it is
  follow(p: string): string {
    for (let i = 0; i < 8; i++) {
      const l = this.files.get(p)?.link;
      if (l === undefined) return p;
      p = norm(parentOf(p), l);
    }
    return p;
  }
  // R-SYS-FS
  list(p: string): { name: string; dir: boolean; link?: boolean }[] {
    // R-NET-FD: the directory of open descriptors lists this run's table (a leak shows as growth)
    if (p === "/dev/fd" || p === "/proc/self/fd") return [...this.fds.keys()].map(k => ({ name: String(k), dir: false }));
    const out = new Map<string, { dir: boolean; link?: boolean }>();
    if (this.hostAllowed(p)) for (const e of this.o.hostFs!.readdir(p) ?? []) if (!this.gone.has(norm(p, e.name))) out.set(e.name, { dir: e.dir });
    for (const [k, n] of this.files) if (k !== p && parentOf(k) === p) out.set(k.slice(p === "/" ? 1 : p.length + 1), { dir: n.dir, link: n.link !== undefined });
    return [...out].map(([name, v]) => ({ name, ...v }));
  }
  // R-SYS-FS
  create(p: string, dir: boolean, mode: number): Node {
    const n: Node = { dir, data: new Uint8Array(0), size: 0, mode, mtimeMs: this.now() };
    this.files.set(p, n);
    this.gone.delete(p);
    return n;
  }
  now(): number { return Date.now() + this.sleptMs + this.it.clock; }
  // R-SYS-FS
  grow(n: Node, size: number): void {
    if (size > n.data.length) { const d = new Uint8Array(Math.max(size, n.data.length * 2, 64)); d.set(n.data.subarray(0, n.size)); n.data = d; }
    if (size > n.size) n.data.fill(0, n.size, size);
    n.size = size;
  }
  allocFd(f: Fd): number { let n = 3; while (this.fds.has(n)) n++; this.fds.set(n, f); return n; }
}

const I32 = { tag: "int", bits: 32, signed: true } as const;
const I64 = { tag: "int", bits: 64, signed: true } as const;
const U16 = { tag: "int", bits: 16, signed: false } as const;
const U8 = { tag: "int", bits: 8, signed: false } as const;

type SysFn = (s: Sys, a: Value[]) => Value;
const n = (v: Value): number => Number(v as bigint);
const cstr = (s: Sys, p: Value): string => new TextDecoder().decode(s.it.mem.cstring(p, "C string read"));
const path = (s: Sys, p: Value): string => norm(s.cwd, cstr(s, p));


// R-SYS-FS
function statInto(s: Sys, node: Node, buf: Value): void {
  const m = s.it.mem, plat = platform();
  const bufSize = plat === "darwin" ? 144 : (process.arch === "arm64" ? 128 : 144);
  m.writeBytes(buf, new Uint8Array(bufSize), "stat");
  const at = (name: string, dflt: number) => { const f = s.it.fns.get(name); return f && !f.isExtern ? n(s.it.callFn(f, [])) : dflt; };
  const modeOff = at("statModeOffset", plat === "darwin" ? 4 : (process.arch === "arm64" ? 16 : 24));
  const sizeOff = at("statSizeOffset", plat === "darwin" ? 96 : 48);
  const mtimeOff = at("statMtimeOffset", plat === "darwin" ? 48 : 88);
  const nsecOff = at("statMtimeNsecOffset", plat === "darwin" ? 56 : 96);
  const mode = (node.link !== undefined ? 0o120000 : node.dir ? 0o040000 : 0o100000) | node.mode;
  m.store(m.advance(buf, modeOff), plat === "darwin" ? U16 : { tag: "int", bits: 32, signed: false }, BigInt(mode));
  m.store(m.advance(buf, sizeOff), I64, BigInt(node.size));
  if (mtimeOff >= 0) m.store(m.advance(buf, mtimeOff), I64, BigInt(Math.floor(node.mtimeMs / 1000)));
  if (nsecOff >= 0) m.store(m.advance(buf, nsecOff), I64, BigInt(Math.floor((node.mtimeMs % 1000) * 1e6)));
}

// R-SYS-FD
function readFd(s: Sys, fd: Fd, buf: Value, count: number): bigint {
  if (!fd.read) return s.setErrno(ERRNO.EBADF);
  if (fd.std === 0) {
    const inp = (s.stdinBuf ??= s.o.stdin?.() ?? new Uint8Array(0));
    const k = Math.min(count, inp.length - s.stdinPos);
    s.it.mem.writeBytes(buf, inp.subarray(s.stdinPos, s.stdinPos + k), "read");
    s.stdinPos += k;
    return BigInt(k);
  }
  if (!fd.node || fd.node.dir) return s.setErrno(ERRNO.EISDIR);
  if (fd.node.dev) {
    const k = fd.node.dev === "null" ? 0 : count;
    s.it.mem.writeBytes(buf, fd.node.dev === "zero" ? new Uint8Array(k) : randomBytes(k), "read");
    return BigInt(k);
  }
  const k = Math.max(0, Math.min(count, fd.node.size - fd.pos));
  s.it.mem.writeBytes(buf, fd.node.data.subarray(fd.pos, fd.pos + k), "read");
  fd.pos += k;
  return BigInt(k);
}
// R-SYS-FD
function writeFd(s: Sys, fd: Fd, buf: Value, count: number): bigint {
  if (!fd.write) return s.setErrno(ERRNO.EBADF);
  const bytes = s.it.mem.readBytes(buf, count, "write");
  if (fd.std === 1) { for (const b of bytes) s.it.out.push(b); return BigInt(count); }
  if (fd.std === 2) { for (const b of bytes) s.it.err.push(b); return BigInt(count); }
  if (!fd.node) return s.setErrno(ERRNO.EBADF);
  if (fd.node.dev) return BigInt(count); // /dev/null and friends swallow writes
  if (fd.append) fd.pos = fd.node.size;
  s.grow(fd.node, Math.max(fd.node.size, fd.pos + count));
  fd.node.data.set(bytes, fd.pos);
  fd.pos += count;
  fd.node.mtimeMs = s.now();
  return BigInt(count);
}
// R-SYS-FD R-SYS-FS
function openPath(s: Sys, p: string, flags: number, mode: number): bigint {
  const O = OFLAGS(), acc = flags & 3;
  let node = s.lookup(p);
  if (node && (flags & O.creat) && (flags & O.excl)) return s.setErrno(ERRNO.EEXIST);
  if (!node) {
    if (!(flags & O.creat)) return s.setErrno(ERRNO.ENOENT);
    const parent = s.lookup(parentOf(p));
    if (!parent || !parent.dir) return s.setErrno(ERRNO.ENOENT);
    node = s.create(p, false, mode & 0o777);
  } else if (node.dir && acc !== 0) return s.setErrno(ERRNO.EISDIR);
  else if ((flags & O.directory) && !node.dir) return s.setErrno(ERRNO.ENOTDIR);
  if ((flags & O.trunc) && !node.dir && acc !== 0) { node.size = 0; node.mtimeMs = s.now(); }
  return BigInt(s.allocFd({ node, path: p, pos: 0, read: acc !== 1, write: acc !== 0, append: !!(flags & O.append) }));
}
// R-SYS-FS
function mkdirSys(s: Sys, p: string, mode: number): bigint {
  if (s.lookup(p)) return s.setErrno(ERRNO.EEXIST);
  const parent = s.lookup(parentOf(p));
  if (!parent || !parent.dir) return s.setErrno(ERRNO.ENOENT);
  s.create(p, true, mode & 0o777);
  return 0n;
}
// R-SYS-FS
function unlinkSys(s: Sys, p: string, dirOnly: boolean): bigint {
  const node = s.lookup(p);
  if (!node) return s.setErrno(ERRNO.ENOENT);
  if (node.dir !== dirOnly) return s.setErrno(dirOnly ? ERRNO.ENOTDIR : ERRNO.EISDIR);
  if (dirOnly && s.list(p).length) return s.setErrno(ENOTEMPTY());
  s.files.delete(p);
  s.gone.add(p);
  s.o.foreign?.unlink?.(p);
  return 0n;
}

const STRERROR: Record<number, string> = { 1: "Operation not permitted", 2: "No such file or directory", 9: "Bad file descriptor", 13: "Permission denied", 17: "File exists", 20: "Not a directory", 21: "Is a directory", 22: "Invalid argument", 28: "No space left on device", 29: "Illegal seek", 34: "Result too large" };

// R-SYS-RANDOM
function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(len, i + 65536)));
  return out;
}

// the C functions, by symbol name
export const SYS: Record<string, SysFn> = {
  // ── heap (R-MEM-*) ──
  malloc: (s, [sz]) => s.it.mem.malloc(n(sz)),
  calloc: (s, [c, sz]) => s.it.mem.malloc(n(c) * n(sz)),
  realloc: (s, [p, sz]) => s.it.mem.realloc(p!, n(sz)),
  free: (s, [p]) => { s.it.mem.free(p!); return undefined; },
  memcpy: (s, [d, src, k]) => { s.it.mem.memcpy(d!, src!, n(k), false); return d; },
  memmove: (s, [d, src, k]) => { s.it.mem.memcpy(d!, src!, n(k), true); return d; },
  memset: (s, [d, c, k]) => { s.it.mem.memset(d!, n(c), n(k)); return d; },
  memcmp: (s, [a, b, k]) => {
    const x = s.it.mem.readBytes(a!, n(k), "memcmp"), y = s.it.mem.readBytes(b!, n(k), "memcmp");
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return BigInt(x[i]! - y[i]!);
    return 0n;
  },
  memchr: (s, [p, c, k]) => {
    const x = s.it.mem.readBytes(p!, n(k), "memchr");
    const i = x.indexOf(n(c) & 255);
    return i < 0 ? 0n : s.it.mem.advance(p!, i);
  },
  // A private mapping is a copy: anonymous pages are zeroed, a file's are its bytes (zero-padded to the page).
  // A mapping without PROT_WRITE is read-only, so a store into it is stuck where the binary takes SIGSEGV.
  mmap: (s, [_addr, len, prot, _flags, fd, off]) => {
    const size = n(len);
    let bytes = new Uint8Array(size);
    if (n(fd) >= 0) {
      const f = s.fds.get(n(fd));
      if (!f?.node) return s.setErrno(ERRNO.EBADF);
      bytes.set(f.node.data.subarray(n(off), Math.min(f.node.size, n(off) + size)));
    }
    return s.it.mem.map(bytes, !(n(prot) & 2));
  },
  munmap: (s, [p]) => { s.it.mem.unmap(p!); return 0n; },
  mprotect: (s, [p, _len, prot]) => { s.it.mem.protect(p!, !!(n(prot) & 2)); return 0n; },
  fflush: () => 0n,
  // R-SYS-SYMLINK
  readlink: (s, [p, buf, size]) => {
    const node = s.lookup(path(s, p!));
    if (!node) return s.setErrno(ERRNO.ENOENT);
    if (node.link === undefined) return s.setErrno(ERRNO.EINVAL);
    const b = enc.encode(node.link).subarray(0, n(size));
    s.it.mem.writeBytes(buf!, b, "readlink");
    return BigInt(b.length);
  },
  // R-SYS-SYMLINK: a link is a node holding its target path; stat, open, access, opendir and chdir follow it, lstat and unlink do not
  symlink: (s, [target, p]) => {
    const q = path(s, p!);
    if (s.lookup(q)) return s.setErrno(ERRNO.EEXIST);
    const parent = s.lookup(parentOf(q));
    if (!parent || !parent.dir) return s.setErrno(ERRNO.ENOENT);
    const t = cstr(s, target!);
    const node = s.create(q, false, 0o777);
    node.link = t;
    node.size = enc.encode(t).length;
    return 0n;
  },
  // R-SYS-SYMLINK
  chmod: (s, [p, mode]) => { const node = s.lookup(s.follow(path(s, p!))); if (!node) return s.setErrno(ERRNO.ENOENT); node.mode = n(mode) & 0o7777; return 0n; },
  strlen: (s, [p]) => BigInt(s.it.mem.cstring(p!, "strlen").length),
  strcmp: (s, [a, b]) => {
    const x = s.it.mem.cstring(a!, "strcmp"), y = s.it.mem.cstring(b!, "strcmp");
    for (let i = 0; i <= Math.min(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return BigInt((x[i] ?? 0) - (y[i] ?? 0));
    return 0n;
  },
  strncmp: (s, [a, b, k]) => {
    const x = s.it.mem.cstring(a!, "strncmp"), y = s.it.mem.cstring(b!, "strncmp");
    for (let i = 0; i < n(k); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return BigInt((x[i] ?? 0) - (y[i] ?? 0));
    return 0n;
  },
  strerror: (s, [e]) => s.it.mem.staticBytes(new Uint8Array([...enc.encode(STRERROR[n(e)] ?? `Unknown error ${n(e)}`), 0]), true),

  // ── file descriptors (R-SYS-FD) ──
  read: (s, [fd, buf, k]) => { const f = s.fds.get(n(fd)); return f ? readFd(s, f, buf!, n(k)) : s.setErrno(ERRNO.EBADF); },
  write: (s, [fd, buf, k]) => { const f = s.fds.get(n(fd)); return f ? writeFd(s, f, buf!, n(k)) : s.setErrno(ERRNO.EBADF); },
  open: (s, [p, flags, mode]) => openPath(s, s.follow(path(s, p!)), n(flags), mode === undefined ? 0o666 : n(mode)),
  close: (s, [fd]) => (s.fds.delete(n(fd)) ? 0n : s.setErrno(ERRNO.EBADF)),
  lseek: (s, [fd, off, wh]) => {
    const f = s.fds.get(n(fd));
    if (!f) return s.setErrno(ERRNO.EBADF);
    if (!f.node) return s.setErrno(ERRNO.ESPIPE);
    const base = n(wh) === 0 ? 0 : n(wh) === 1 ? f.pos : f.node.size;
    const pos = base + n(off);
    if (pos < 0) return s.setErrno(ERRNO.EINVAL);
    f.pos = pos;
    return BigInt(pos);
  },
  fstat: (s, [fd, buf]) => {
    const f = s.fds.get(n(fd));
    if (!f) return s.setErrno(ERRNO.EBADF);
    statInto(s, f.node ?? { dir: false, data: new Uint8Array(0), size: 0, mode: 0o620, mtimeMs: s.now() }, buf!);
    return 0n;
  },
  stat: (s, [p, buf]) => { const node = s.lookup(s.follow(path(s, p!))); if (!node) return s.setErrno(ERRNO.ENOENT); statInto(s, node, buf!); return 0n; },
  lstat: (s, [p, buf]) => { const node = s.lookup(path(s, p!)); if (!node) return s.setErrno(ERRNO.ENOENT); statInto(s, node, buf!); return 0n; },
  access: (s, [p]) => (s.lookup(s.follow(path(s, p!))) ? 0n : s.setErrno(ERRNO.ENOENT)),
  ftruncate: (s, [fd, len]) => { const f = s.fds.get(n(fd)); if (!f?.node || !f.write) return s.setErrno(ERRNO.EBADF); s.grow(f.node, n(len)); return 0n; },
  truncate: (s, [p, len]) => { const node = s.lookup(path(s, p!)); if (!node || node.dir) return s.setErrno(ERRNO.ENOENT); s.grow(node, n(len)); return 0n; },
  fsync: (s, [fd]) => (s.fds.has(n(fd)) ? 0n : s.setErrno(ERRNO.EBADF)),
  fdatasync: (s, [fd]) => SYS.fsync!(s, [fd]),
  fcntl: (s, [fd]) => (s.fds.has(n(fd)) ? 0n : s.setErrno(ERRNO.EBADF)),
  isatty: () => 0n,
  dup: (s, [fd]) => { const f = s.fds.get(n(fd)); return f ? BigInt(s.allocFd({ ...f })) : s.setErrno(ERRNO.EBADF); },
  dup2: (s, [a, b]) => { const f = s.fds.get(n(a)); if (!f) return s.setErrno(ERRNO.EBADF); s.fds.set(n(b), { ...f }); return b as bigint; },
  unlink: (s, [p]) => unlinkSys(s, path(s, p!), false),
  rmdir: (s, [p]) => unlinkSys(s, path(s, p!), true),
  mkdir: (s, [p, mode]) => mkdirSys(s, path(s, p!), n(mode)),
  rename: (s, [a, b]) => {
    const from = path(s, a!), to = path(s, b!), node = s.lookup(from);
    if (!node) return s.setErrno(ERRNO.ENOENT);
    s.files.set(to, node);
    s.gone.delete(to);
    s.files.delete(from);
    s.gone.add(from);
    return 0n;
  },
  getcwd: (s, [buf, size]) => {
    const b = new Uint8Array([...enc.encode(s.cwd), 0]);
    if (b.length > n(size)) { s.setErrno(ERRNO.ERANGE); return 0n; }
    s.it.mem.writeBytes(buf!, b, "getcwd");
    return buf;
  },
  chdir: (s, [p]) => { const q = s.follow(path(s, p!)), node = s.lookup(q); if (!node || !node.dir) return s.setErrno(ERRNO.ENOENT); s.cwd = q; return 0n; },
  mkdtemp: (s, [tmpl]) => {
    const t = s.it.mem.cstring(tmpl!, "mkdtemp");
    const name = new TextDecoder().decode(t).replace(/X+$/, m => Array.from(randomBytes(m.length), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""));
    if (mkdirSys(s, norm(s.cwd, name), 0o700) !== 0n) return 0n;
    s.it.mem.writeBytes(tmpl!, new Uint8Array([...enc.encode(name), 0]), "mkdtemp");
    return tmpl;
  },
  mkstemp: (s, [tmpl]) => {
    const name = new TextDecoder().decode(s.it.mem.cstring(tmpl!, "mkstemp")).replace(/X+$/, m => Array.from(randomBytes(m.length), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""));
    const fd = openPath(s, norm(s.cwd, name), 2 | OFLAGS().creat | OFLAGS().excl, 0o600);
    if (fd >= 0n) s.it.mem.writeBytes(tmpl!, new Uint8Array([...enc.encode(name), 0]), "mkstemp");
    return fd;
  },
  opendir: (s, [p]) => {
    const q = s.follow(path(s, p!)), node = s.lookup(q);
    if (!node) { s.setErrno(ERRNO.ENOENT); return 0n; }
    if (!node.dir) { s.setErrno(ERRNO.ENOTDIR); return 0n; }
    const handle = s.it.mem.staticBytes(new Uint8Array(8));
    const names = [{ name: ".", dir: true }, { name: "..", dir: true }, ...s.list(q)];
    s.dirs.set(Number(s.it.mem.addr(handle)), { names, i: 0, ent: s.it.mem.staticBytes(new Uint8Array(1024)) });
    return handle;
  },
  readdir: (s, [d]) => {
    const st = s.dirs.get(Number(s.it.mem.addr(d!)));
    if (!st) { s.setErrno(ERRNO.EBADF); return 0n; }
    const e = st.names[st.i++];
    if (!e) return 0n;
    const m = s.it.mem;
    const typeOff = platform() === "darwin" ? 20 : 18, nameOff = platform() === "darwin" ? 21 : 19;
    const at = (name: string, dflt: number) => { const f = s.it.fns.get(name); return f && !f.isExtern ? n(s.it.callFn(f, [])) : dflt; };
    m.writeBytes(st.ent, new Uint8Array(1024), "readdir");
    m.store(m.advance(st.ent, at("direntTypeOffset", typeOff)), U8, e.link ? 10n : e.dir ? 4n : 8n);
    m.writeBytes(m.advance(st.ent, at("direntNameOffset", nameOff)), new Uint8Array([...enc.encode(e.name), 0]), "readdir");
    return st.ent;
  },
  closedir: (s, [d]) => (s.dirs.delete(Number(s.it.mem.addr(d!))) ? 0n : s.setErrno(ERRNO.EBADF)),

  // ── environment (R-SYS-ENV) ──
  getenv: (s, [name]) => {
    const k = cstr(s, name!), v = s.env.get(k);
    if (v === undefined) return 0n;
    let cell = s.envCells.get(k + "=" + v);
    if (!cell) s.envCells.set(k + "=" + v, (cell = s.it.mem.staticBytes(new Uint8Array([...enc.encode(v), 0]))));
    return cell;
  },
  setenv: (s, [name, value, over]) => { const k = cstr(s, name!); if (n(over) || !s.env.has(k)) s.env.set(k, cstr(s, value!)); return 0n; },
  unsetenv: (s, [name]) => { s.env.delete(cstr(s, name!)); return 0n; },
  getpid: () => 4242n,
  getppid: () => 1n,
  getuid: () => 1000n, geteuid: () => 1000n, getgid: () => 1000n, getegid: () => 1000n,
  __error: s => { if (!s.errnoCell) s.setErrno(0); return s.errnoCell; },
  __errno_location: s => SYS.__error!(s, []),
  sysconf: (_s, [name]) => (n(name) === 29 || n(name) === 30 ? 16384n : -1n), // _SC_PAGESIZE on darwin / linux
  tzset: () => undefined,

  // ── time (R-SYS-CLOCK): the wall clock plus whatever the program has slept ──
  gettimeofday: (s, [tv]) => {
    const m = s.it.mem, t = s.now();
    m.store(tv!, I64, BigInt(Math.floor(t / 1000)));
    m.store(m.advance(tv!, 8), platform() === "darwin" ? I32 : I64, BigInt(Math.floor((t % 1000) * 1000)));
    return 0n;
  },
  clock_gettime: (s, [_clk, ts]) => {
    const m = s.it.mem, t = s.now();
    m.store(ts!, I64, BigInt(Math.floor(t / 1000)));
    m.store(m.advance(ts!, 8), I64, BigInt(Math.floor((t % 1000) * 1e6)));
    return 0n;
  },
  time: (s, [p]) => { const t = BigInt(Math.floor(s.now() / 1000)); if (p !== 0n) s.it.mem.store(p!, I64, t); return t; },
  usleep: (s, [us]) => { s.sleptMs += n(us) / 1000; return 0n; },
  sleep: (s, [sec]) => { s.sleptMs += n(sec) * 1000; return 0n; },
  nanosleep: (s, [req]) => {
    const m = s.it.mem;
    s.sleptMs += Number(m.load(req!, I64) as bigint) * 1000 + Number(m.load(m.advance(req!, 8), I64) as bigint) / 1e6;
    return 0n;
  },

  // ── entropy ──
  arc4random: () => BigInt(new DataView(randomBytes(4).buffer).getUint32(0, true)),
  arc4random_uniform: (_s, [ub]) => { const u = n(ub); return u <= 1 ? 0n : BigInt(Math.floor(new DataView(randomBytes(4).buffer).getUint32(0, true) / 2 ** 32 * u)); },
  arc4random_buf: (s, [buf, k]) => { s.it.mem.writeBytes(buf!, randomBytes(n(k)), "arc4random_buf"); return undefined; },
  getentropy: (s, [buf, k]) => { s.it.mem.writeBytes(buf!, randomBytes(n(k)), "getentropy"); return 0n; },
  getrandom: (s, [buf, k]) => { s.it.mem.writeBytes(buf!, randomBytes(n(k)), "getrandom"); return k; },

  // ── process ──
  // R-SYS-EXIT
  exit: (s, [c]) => { s.it.aborted = true; throw new ExitProgram(n(c) & 255); },
  _exit: (s, [c]) => SYS.exit!(s, [c]),

  // ── conversion and stdio ──
  atof: (s, [p]) => {
    const m = /^\s*([+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf(?:inity)?|nan))/i.exec(cstr(s, p!));
    if (!m) return 0;
    const t = m[1]!.toLowerCase().replace(/^([+-]?)inf(inity)?$/, "$1Infinity");
    return t.endsWith("nan") ? NaN : Number(t);
  },
  atoi: (s, [p]) => { const m = /^\s*([+-]?\d+)/.exec(cstr(s, p!)); return m ? BigInt.asIntN(32, BigInt(m[1]!)) : 0n; },
  abs: (_s, [x]) => { const v = x as bigint; return v < 0n ? -v : v; },
  puts: (s, [p]) => { for (const b of s.it.mem.cstring(p!, "puts")) s.it.out.push(b); s.it.out.push(10); return 1n; },

  // ── libm: JS's Math is the same IEEE-754 results for these ──
  sqrt: (_s, [x]) => Math.sqrt(x as number), fabs: (_s, [x]) => Math.abs(x as number), floor: (_s, [x]) => Math.floor(x as number),
  ceil: (_s, [x]) => Math.ceil(x as number), round: (_s, [x]) => { const v = x as number; return v < 0 ? -Math.round(-v) : Math.round(v); },
  sin: (_s, [x]) => Math.sin(x as number), cos: (_s, [x]) => Math.cos(x as number), tan: (_s, [x]) => Math.tan(x as number),
  asin: (_s, [x]) => Math.asin(x as number), acos: (_s, [x]) => Math.acos(x as number), atan: (_s, [x]) => Math.atan(x as number),
  atan2: (_s, [y, x]) => Math.atan2(y as number, x as number), exp: (_s, [x]) => Math.exp(x as number), log: (_s, [x]) => Math.log(x as number),
  log2: (_s, [x]) => Math.log2(x as number), log10: (_s, [x]) => Math.log10(x as number), pow: (_s, [x, y]) => Math.pow(x as number, y as number),
  fmod: (_s, [x, y]) => (x as number) % (y as number),
};

// Why an extern has no implementation, when it belongs to a group that is left out on purpose
function unmodelled(sym: string): string {
  if (/^(epoll_.*|eventfd|select)$/.test(sym)) return " (event queues are not modelled)";
  if (/^(swapcontext|makecontext|getcontext)$/.test(sym)) return " (user-space context switches are not modelled)";
  if (/^(fork|exec.*|waitpid|posix_spawn.*|system|setsid|dlopen|dlsym|dlclose|dlerror)$/.test(sym)) return " (processes and dynamic loading are not modelled)";
  if (/^(sqlite3_.*|SSL_.*|TLS_.*|EVP_.*|EC_.*|BN_.*|CC_.*|CCCrypt.*|SHA.*|MD5)$/.test(sym)) return " (wrapped C libraries are not modelled)";
  return "";
}

// The extern `fn` as a native, so a call that blocks (a pipe read, accept, pthread_join) parks its task
// through runNative. The value is the result, or a generator the task interpreter drives.
// R-NET-BLOCK
const externNatives = new WeakMap<AstFn, Native>();
// R-NET-BLOCK
export function externNative(fn: AstFn): Native {
  let nat = externNatives.get(fn);
  if (!nat) {
    nat = ((it: Interp, args: Value[]) => callExtern(it, fn, args)) as Native;
    nat.maybeCo = true;
    externNatives.set(fn, nat);
  }
  return nat;
}
const isGen = (v: unknown): v is Generator<unknown, Value, unknown> => !!v && typeof v === "object" && typeof (v as { next?: unknown }).next === "function";

export function callExtern(it: Interp, fn: AstFn, args: Value[]): Value {
  const sym = fn.linkName ?? fn.name;
  const net = (NET as Record<string, (typeof NET)[string] | undefined>)[sym], base = (SYS[sym] ?? LIBC[sym]) as SysFn | undefined;
  const foreign = net || base ? undefined : it.sysOptions.foreign;
  if (!net && !base && !foreign?.handles(sym)) return it.unsupported(`extern ${sym}${unmodelled(sym)}`);
  const s = (it.sys ??= new Sys(it, it.sysOptions));
  const sig = it.cr.functions.get(fn.name);
  const held: Value[] = [];
  if (!net && !base) { // R-FFI-CALL
    const r = foreign!.call(it, sym, fn, args.map((a, i) => it.mem.decay(a, sig?.params[i]?.type, held)));
    for (const h of held) it.dropValue(h);
    return r;
  }
  // a variadic argument has no declared type: a string or array there is passed as the pointer C would be given
  const argv = args.map((a, i) => it.mem.decay(a, sig?.params[i]?.type ?? { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, held));
  const r = net ? net(s, argv, base) : base!(s, argv);
  const rt = sig?.ret;
  const done = (v: Value): Value => {
    for (const h of held) it.dropValue(h);
    return typeof v === "bigint" && rt?.tag === "int" ? wrapInt(v, rt) : v;
  };
  if (!isGen(r)) return done(r);
  // a call that blocks: the task interpreter parks the task in it; without tasks nothing could ever wake it (src/interp-net.ts waitOn)
  if (it.coMode) return (function* () { return done(yield* r); })() as unknown as Value;
  const st = r.next();
  return st.done ? done(st.value) : it.stuck("S-DEADLOCK", `${sym} blocks and no other task exists to wake it`);
}

// fds 0, 1 and 2 exist from the start: the program's stdin, stdout and stderr
// R-SYS-FD
export function initStdio(s: Sys): void {
  s.fds.set(0, { node: null, path: "", pos: 0, read: true, write: false, append: false, std: 0 });
  s.fds.set(1, { node: null, path: "", pos: 0, read: false, write: true, append: false, std: 1 });
  s.fds.set(2, { node: null, path: "", pos: 0, read: false, write: true, append: false, std: 2 });
}
