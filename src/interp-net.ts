// Reference interpreter, the in-memory network, pipes, signals and threads: the C functions std
// calls for descriptors that are not files (pipe, socket and friends, poll, signal/raise/kill,
// pthread_*), implemented over the descriptor table of src/interp-sys.ts. Rules R-NET-* in
// docs/semantics/milo.md. Everything is pure memory: a socket is a pair of byte queues inside the
// program, a connect reaches only a listener of the same run (closed world), and a call that
// would block parks the calling task on the scheduler of src/interp-co.ts, to be woken by the
// peer's action. This file imports no node module (it is bundled for the browser).
//
// A handler here is `(s, args, base)` returning a value or, when it can block, a generator the
// task interpreter drives (`yield*`); `base` is the plain C-layer function of the same name, for
// the descriptors that are files.
import type { Interp } from "./interp";
import type { InterpCo, Task } from "./interp-co";
import { Sys, type Fd } from "./interp-sys";
import type { Alloc } from "./interp-mem";
import { ExitProgram, NeedTasks, enc, type Value } from "./interp-values";
import type { Native } from "./interp-natives";

type Gen<T> = Generator<unknown, T, unknown>;
export type NetFn = (s: Sys, a: Value[], base?: (s: Sys, a: Value[]) => Value) => Value | Gen<Value>;

const I32 = { tag: "int", bits: 32, signed: true } as const;
const U32 = { tag: "int", bits: 32, signed: false } as const;
const I64 = { tag: "int", bits: 64, signed: true } as const;
const U8 = { tag: "int", bits: 8, signed: false } as const;
const PTR = { tag: "ptr", inner: U8 } as never;
const n = (v: Value): number => Number(v as bigint);
const darwin = (): boolean => !(typeof process !== "undefined" && process.platform === "linux");

// errno values and socket constants, per the OS std's platform arm was chosen for
const E = () => (darwin()
  ? { EPERM: 1, ESRCH: 3, EINTR: 4, EBADF: 9, EAGAIN: 35, EINVAL: 22, EMFILE: 24, EPIPE: 32, ENOTSOCK: 38, EAFNOSUPPORT: 47, EADDRINUSE: 48, EADDRNOTAVAIL: 49, ENETUNREACH: 51, ECONNRESET: 54, EISCONN: 56, ENOTCONN: 57, ETIMEDOUT: 60, ECONNREFUSED: 61, EPROTOTYPE: 41, EDEADLK: 11, EBUSY: 16 }
  : { EPERM: 1, ESRCH: 3, EINTR: 4, EBADF: 9, EAGAIN: 11, EINVAL: 22, EMFILE: 24, EPIPE: 32, ENOTSOCK: 88, EAFNOSUPPORT: 97, EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETUNREACH: 101, ECONNRESET: 104, EISCONN: 106, ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111, EPROTOTYPE: 91, EDEADLK: 35, EBUSY: 16 });
const AF = () => ({ UNIX: 1, INET: 2, INET6: darwin() ? 30 : 10 });
const CONST = () => (darwin()
  ? { SOL_SOCKET: 0xffff, SO_ERROR: 0x1007, O_NONBLOCK: 4, SIGUSR1: 30, SIGUSR2: 31, SIGCHLD: 20, SIGURG: 16, SIGCONT: 19, SIGWINCH: 28, SIGSTOP: 17, SIGTSTP: 18, BLOCK: 1, UNBLOCK: 2, SETMASK: 3, AI_NUMERICHOST: 4 }
  : { SOL_SOCKET: 1, SO_ERROR: 4, O_NONBLOCK: 0x800, SIGUSR1: 10, SIGUSR2: 12, SIGCHLD: 17, SIGURG: 23, SIGCONT: 18, SIGWINCH: 28, SIGSTOP: 19, SIGTSTP: 20, BLOCK: 0, UNBLOCK: 1, SETMASK: 2, AI_NUMERICHOST: 4 });
const PID = 4242n;
const BUF_CAP = 65536; // what a pipe or socket buffer holds before a write blocks

// ── queues, wait lists ──
// R-NET-IO
class ByteQ {
  chunks: Uint8Array[] = [];
  len = 0;
  eof = false; // the writing end is gone: a read of an empty queue returns 0
  broken = false; // the reading end is gone: a write is EPIPE
  push(b: Uint8Array): void { this.chunks.push(b); this.len += b.length; }
  // R-NET-IO
  take(k: number): Uint8Array {
    const out = new Uint8Array(Math.min(k, this.len));
    let at = 0;
    while (at < out.length) {
      const c = this.chunks[0]!, m = Math.min(c.length, out.length - at);
      out.set(c.subarray(0, m), at);
      at += m;
      if (m === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(m);
    }
    this.len -= out.length;
    return out;
  }
}
class WaitQ { ts: Task[] = []; }

interface PipeEnd { k: "pipe"; read: boolean; q: ByteQ; nb: boolean; refs: number }
interface Addr { fam: number; ip: Uint8Array; port: number; path: string }
interface Sock {
  k: "sock"; dom: number; type: number; nb: boolean; refs: number;
  local: Addr | null; peer: Addr | null;
  rx: ByteQ; tx: ByteQ | null; // stream: bytes to read here, bytes the peer reads
  dgrams: { from: Addr | null; data: Uint8Array }[];
  listening: boolean; backlog: Sock[]; backlogMax: number;
  peerSock: Sock | null; error: number; opts: Map<string, number>; shutRd: boolean; closed: boolean;
}
// a kqueue: what it watches (R-NET-KQUEUE)
interface Watch { ident: number; filter: number; fflags: number; udata: Value; clear: boolean; oneshot: boolean; fired: boolean }
interface KQueue { k: "kq"; nb: boolean; refs: number; watches: Map<string, Watch> }
export type FdObj = PipeEnd | Sock | KQueue;

interface Mutex { owner: Task | null; q: WaitQ }
interface Cond { toks: { done: boolean }[]; q: WaitQ }
interface RwLock { writer: boolean; readers: number; q: WaitQ }
interface Thread { id: number; done: boolean; ret: Value; detached: boolean; q: WaitQ }

class Net {
  q = new WaitQ(); // every task blocked on a descriptor waits here and rechecks on any change
  socks = new Set<Sock>();
  nextPort = 49152;
  handlers = new Map<number, Value>();
  mask = 0;
  pending = new Set<number>();
  threads = new Map<number, Thread>();
  objs = new WeakMap<Alloc, Map<number, Mutex | Cond | RwLock>>();
  usedThreads = false;
}
const nets = new WeakMap<Sys, Net>();
// R-NET-FD
function netOf(s: Sys): Net { let x = nets.get(s); if (!x) nets.set(s, (x = new Net())); return x; }
const coOf = (s: Sys): InterpCo | null => ((s.it as Partial<InterpCo>).coMode ? (s.it as InterpCo) : null);
const fail = (s: Sys, e: number): bigint => s.setErrno(e);
// the function a callback argument names: a function pointer, or (for a parameter of function type) the function itself
// R-FNPTR
const calleeName = (s: Sys, v: Value): string | undefined => (v && typeof v === "object" && v.k === "fn" ? v.name : s.it.mem.fnName(v));

// R-NET-BLOCK: park the calling task until `kick` wakes the list or the timeout (virtual ms) passes; true when it timed out.
// Without a scheduler nothing can ever wake the caller: that is a stuck state, or, with a timeout, the clock moving on.
function* waitOn(s: Sys, q: WaitQ, why: string, timeoutMs?: number): Gen<boolean> {
  const it = coOf(s);
  if (!it) {
    if (timeoutMs !== undefined) { s.it.clock += timeoutMs; return true; }
    return s.it.stuck("S-DEADLOCK", `${why}: no other task exists that could make this call return`);
  }
  const me = it.cur;
  q.ts.push(me);
  let entry: { t: Task; at: number; quiet?: boolean } | undefined;
  if (timeoutMs !== undefined) { entry = { t: me, at: it.clock + timeoutMs, quiet: true }; it.sleepers.push(entry); }
  it.touch(q);
  yield* it.park(why);
  q.ts = q.ts.filter(t => t !== me);
  if (!entry) return false;
  const i = it.sleepers.indexOf(entry);
  if (i >= 0) { it.sleepers.splice(i, 1); return false; }
  return true;
}
// R-NET-BLOCK: wake every task waiting on the list; each rechecks its condition when it runs.
function kick(s: Sys, q: WaitQ): void {
  const it = coOf(s);
  if (!it) return;
  const ts = q.ts;
  q.ts = [];
  it.touch(q);
  for (const t of ts) it.unpark(t);
}

// ── addresses ──
const LOOP4 = new Uint8Array([127, 0, 0, 1]);
const LOOP6 = new Uint8Array(16).map((_, i) => (i === 15 ? 1 : 0));
const isZero = (b: Uint8Array): boolean => b.every(x => x === 0);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
// R-NET-ADDR
function decodeAddr(s: Sys, p: Value, len: number): Addr | null {
  if (len < 2) return null;
  const b = s.it.mem.readBytes(p, len, "sockaddr");
  const fam = darwin() ? b[1]! : b[0]! | (b[1]! << 8);
  const af = AF();
  if (fam === af.INET && len >= 8) return { fam, ip: b.slice(4, 8), port: (b[2]! << 8) | b[3]!, path: "" };
  if (fam === af.INET6 && len >= 24) return { fam, ip: b.slice(8, 24), port: (b[2]! << 8) | b[3]!, path: "" };
  if (fam === af.UNIX) {
    const raw = b.subarray(darwin() ? 2 : 2);
    const end = raw.indexOf(0);
    return { fam, ip: new Uint8Array(0), port: 0, path: new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end)) };
  }
  return null;
}
// R-NET-ADDR
function encodeAddr(a: Addr): Uint8Array {
  const af = AF();
  let b: Uint8Array;
  if (a.fam === af.INET) { b = new Uint8Array(16); b.set(a.ip, 4); }
  else if (a.fam === af.INET6) { b = new Uint8Array(28); b.set(a.ip, 8); }
  else { const p = enc.encode(a.path); b = new Uint8Array(2 + p.length + 1); b.set(p, 2); }
  if (darwin()) { b[0] = b.length; b[1] = a.fam; } else { b[0] = a.fam & 255; b[1] = a.fam >> 8; }
  if (a.fam !== af.UNIX) { b[2] = a.port >> 8; b[3] = a.port & 255; }
  return b;
}
// R-NET-ADDR: the address goes into the caller's buffer, truncated to its size; the length word reports the full size
function putAddr(s: Sys, buf: Value, lenp: Value, a: Addr): void {
  const m = s.it.mem, b = encodeAddr(a);
  if (buf !== 0n) {
    const cap = lenp === 0n ? b.length : n(m.load(lenp, U32));
    m.writeBytes(buf, b.subarray(0, Math.min(cap, b.length)), "sockaddr out");
  }
  if (lenp !== 0n) m.store(lenp, U32, BigInt(b.length));
}
// R-NET-ADDR: only the loopback interface and the wildcard exist in this world
const isLocalIp = (a: Addr): boolean => a.fam === AF().UNIX || isZero(a.ip) || (a.ip.length === 4 ? a.ip[0] === 127 : sameBytes(a.ip, LOOP6));
const loopFor = (fam: number): Addr => ({ fam, ip: fam === AF().INET ? LOOP4 : LOOP6, port: 0, path: "" });
// does a bound listener address accept a connect to `to`? R-NET-ADDR
function addrAccepts(bound: Addr, to: Addr): boolean {
  if (bound.fam === AF().UNIX) return to.fam === bound.fam && bound.path === to.path;
  if (bound.port !== to.port) return false;
  if (bound.fam === to.fam) return isZero(bound.ip) || sameBytes(bound.ip, to.ip) || (isZero(to.ip) && sameBytes(bound.ip, loopFor(to.fam).ip));
  return bound.fam === AF().INET6 && to.fam === AF().INET && isZero(bound.ip); // an IPv6 wildcard also takes IPv4, the OS default
}
// R-NET-ADDR
function parseIp(text: string, fam: number): Uint8Array | null {
  if (fam === AF().INET) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    if (!m || m.slice(1).some(x => Number(x) > 255)) return null;
    return Uint8Array.from(m.slice(1).map(Number));
  }
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.includes(":::")) return null;
  let head = text, tailV4: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) { const q = parseIp(v4[1]!, AF().INET); if (!q) return null; tailV4 = [...q]; head = text.slice(0, v4.index) + "0:0"; }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const grp = (t: string) => (t === "" ? [] : t.split(":"));
  const a = grp(halves[0]!), b = halves.length === 2 ? grp(halves[1]!) : [];
  if (halves.length === 1 ? a.length !== 8 : a.length + b.length > 7) return null;
  const all = halves.length === 1 ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i]!)) return null;
    const v = parseInt(all[i]!, 16);
    out[2 * i] = v >> 8; out[2 * i + 1] = v & 255;
  }
  if (tailV4.length) out.set(tailV4, 12);
  return out;
}

// ── objects behind descriptors ──
// R-NET-SOCK
function newSock(dom: number, type: number): Sock {
  return { k: "sock", dom, type, nb: false, refs: 1, local: null, peer: null, rx: new ByteQ(), tx: null, dgrams: [], listening: false, backlog: [], backlogMax: 0, peerSock: null, error: 0, opts: new Map(), shutRd: false, closed: false };
}
// R-NET-FD
function fdOf(s: Sys, fd: Value): Fd | undefined { return s.fds.get(n(fd)); }
// R-NET-FD
function objFd(s: Sys, o: FdObj): bigint { return BigInt(s.allocFd({ node: null, path: "", pos: 0, read: true, write: true, append: false, obj: o })); }
// the socket behind a descriptor: sets errno when it is none. R-NET-SOCK
function sockOf(s: Sys, fd: Value): Sock | null {
  const f = fdOf(s, fd);
  if (!f) { fail(s, E().EBADF); return null; }
  if (f.obj?.k !== "sock") { fail(s, E().ENOTSOCK); return null; }
  return f.obj;
}
// R-NET-FD: the last descriptor of an open file description closed: the peer sees the end
function release(s: Sys, o: FdObj): void {
  if (--o.refs > 0) return;
  const net = netOf(s);
  if (o.k === "kq") o.watches.clear();
  else if (o.k === "pipe") { if (o.read) o.q.broken = true; else o.q.eof = true; }
  else {
    o.closed = true;
    net.socks.delete(o);
    if (o.tx) o.tx.eof = true;
    o.rx.broken = true;
    for (const c of o.backlog) { c.rx.broken = true; if (c.tx) c.tx.eof = true; }
    o.backlog = [];
    if (o.peerSock) o.peerSock.peerSock = null;
  }
  kick(s, net.q);
}

// ── readiness (R-NET-POLL) ──
const POLLIN = 1, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;
// R-NET-POLL
function readiness(o: FdObj | undefined): number {
  if (!o) return POLLIN | POLLOUT; // a file is always ready
  if (o.k === "kq") return 0;
  if (o.k === "pipe") {
    if (o.read) return (o.q.len > 0 ? POLLIN : 0) | (o.q.eof && o.q.len === 0 ? POLLHUP : 0);
    return o.q.broken ? POLLERR : o.q.len < BUF_CAP ? POLLOUT : 0;
  }
  if (o.listening) return o.backlog.length > 0 ? POLLIN : 0;
  let r = 0;
  if (o.type === 2) return (o.dgrams.length > 0 ? POLLIN : 0) | POLLOUT;
  if (o.rx.len > 0 || o.rx.eof || o.shutRd) r |= POLLIN;
  if (o.rx.eof && o.rx.len === 0) r |= POLLHUP;
  if (o.error) r |= POLLERR | POLLOUT;
  if (!o.tx) r |= POLLOUT | (o.peer ? 0 : POLLHUP);
  else if (o.tx.broken) r |= POLLERR | POLLOUT;
  else if (o.tx.len < BUF_CAP) r |= POLLOUT;
  return r;
}

// ── read and write ──
// R-NET-IO R-NET-BLOCK
function* readObj(s: Sys, o: FdObj, buf: Value, count: number): Gen<bigint> {
  if (o.k === "kq") return fail(s, E().EINVAL);
  const q = o.k === "pipe" ? (o.read ? o.q : null) : o.rx;
  if (!q) return fail(s, E().EBADF);
  if (o.k === "sock") {
    if (o.type === 2) return yield* recvDgram(s, o, buf, count, 0n, 0n);
    if (!o.tx && !o.peer && !o.rx.eof && o.rx.len === 0) return fail(s, E().ENOTCONN);
  }
  for (;;) {
    if (q.len > 0 && count > 0) {
      const b = q.take(count);
      s.it.mem.writeBytes(buf, b, "read");
      kick(s, netOf(s).q);
      return BigInt(b.length);
    }
    if (count === 0 || q.eof || (o.k === "sock" && o.shutRd)) return 0n;
    if (o.k === "sock" && o.error) { const e = o.error; o.error = 0; return fail(s, e); }
    if (o.nb) return fail(s, E().EAGAIN);
    yield* waitOn(s, netOf(s).q, o.k === "pipe" ? "read of an empty pipe" : "read of a socket with nothing to read");
  }
}
// R-NET-IO R-NET-BLOCK
function* writeObj(s: Sys, o: FdObj, buf: Value, count: number): Gen<bigint> {
  if (o.k === "kq") return fail(s, E().EINVAL);
  const q = o.k === "pipe" ? (o.read ? null : o.q) : o.tx;
  if (o.k === "pipe" && !q) return fail(s, E().EBADF);
  if (o.k === "sock" && o.type === 2) return yield* sendDgram(s, o, buf, count, null);
  if (!q) return fail(s, o.k === "sock" && o.peer === null && !o.listening ? E().ENOTCONN : E().EPIPE);
  const bytes = s.it.mem.readBytes(buf, count, "write");
  let done = 0;
  for (;;) {
    if (q.broken) {
      if (done > 0) return BigInt(done);
      yield* raiseSignal(s, 13);
      return fail(s, E().EPIPE);
    }
    const k = Math.min(BUF_CAP - q.len, count - done);
    if (k > 0) { q.push(bytes.slice(done, done + k)); done += k; kick(s, netOf(s).q); }
    if (done === count) return BigInt(done);
    if (o.nb) return done > 0 ? BigInt(done) : fail(s, E().EAGAIN);
    yield* waitOn(s, netOf(s).q, o.k === "pipe" ? "write to a full pipe" : "write to a socket whose buffer is full");
  }
}
// R-NET-DGRAM
function* sendDgram(s: Sys, o: Sock, buf: Value, count: number, to: Addr | null): Gen<bigint> {
  const dest = to ?? o.peer;
  if (!dest) return fail(s, E().ENOTCONN);
  const bytes = s.it.mem.readBytes(buf, count, "sendto");
  const target = o.peerSock ?? [...netOf(s).socks].find(x => x.type === 2 && x.local && addrAccepts(x.local, dest));
  if (target) {
    target.dgrams.push({ from: o.local ?? { ...loopFor(dest.fam), port: autoPort(s, o) }, data: bytes });
    kick(s, netOf(s).q);
  }
  return BigInt(count); // a datagram to nobody is lost, as UDP
}
// R-NET-DGRAM
function* recvDgram(s: Sys, o: Sock, buf: Value, count: number, from: Value, fromLen: Value): Gen<bigint> {
  for (;;) {
    const d = o.dgrams.shift();
    if (d) {
      s.it.mem.writeBytes(buf, d.data.subarray(0, count), "recvfrom");
      if (from !== 0n && d.from) putAddr(s, from, fromLen, d.from);
      return BigInt(Math.min(count, d.data.length));
    }
    if (o.nb) return fail(s, E().EAGAIN);
    yield* waitOn(s, netOf(s).q, "recvfrom with no datagram");
  }
}
// R-NET-DGRAM: a datagram socket that sends before binding gets a port
function autoPort(s: Sys, o: Sock): number {
  if (!o.local) o.local = { ...loopFor(o.dom), port: allocPort(s) };
  return o.local.port;
}

// ── socket calls ──
// R-NET-SOCK
function allocPort(s: Sys): number {
  const net = netOf(s);
  for (;;) {
    const p = net.nextPort++;
    if (net.nextPort > 65535) net.nextPort = 49152;
    if (![...net.socks].some(x => x.local?.port === p)) return p;
  }
}
// R-NET-SOCK
function bindSock(s: Sys, o: Sock, a: Addr): bigint {
  if (o.local) return fail(s, E().EINVAL);
  if (a.fam !== o.dom) return fail(s, E().EAFNOSUPPORT);
  if (a.fam === AF().UNIX) {
    if (s.lookup(a.path.startsWith("/") ? a.path : s.cwd + "/" + a.path)) return fail(s, E().EADDRINUSE);
    const full = a.path.startsWith("/") ? a.path : s.cwd + "/" + a.path;
    const parent = s.lookup(full.slice(0, Math.max(full.lastIndexOf("/"), 0)) || "/");
    if (!parent?.dir) return fail(s, 2);
    s.create(full, false, 0o755);
    o.local = { ...a, path: full };
  } else {
    if (!isLocalIp(a)) return fail(s, E().EADDRNOTAVAIL);
    const port = a.port === 0 ? allocPort(s) : a.port;
    for (const x of netOf(s).socks) {
      if (x.type !== o.type || !x.local || x.local.fam !== a.fam || x.local.port !== port) continue;
      const overlap = isZero(x.local.ip) || isZero(a.ip) || sameBytes(x.local.ip, a.ip);
      if (overlap && !(x.opts.get("reuse") && o.opts.get("reuse") && !x.listening)) return fail(s, E().EADDRINUSE);
    }
    o.local = { ...a, port };
  }
  netOf(s).socks.add(o);
  return 0n;
}
// R-NET-SOCK R-NET-ADDR: connect pairs this socket with a listener of the same run; any other destination is refused or unreachable
function* connectSock(s: Sys, o: Sock, a: Addr): Gen<bigint> {
  if (o.listening) return fail(s, E().EINVAL);
  if (o.peer || o.tx) return fail(s, E().EISCONN);
  if (a.fam !== o.dom) return fail(s, E().EAFNOSUPPORT);
  if (o.type === 2) { o.peer = a; return 0n; }
  if (!isLocalIp(a)) return fail(s, E().ENETUNREACH);
  let lst: Sock | undefined;
  for (;;) {
    lst = [...netOf(s).socks].find(x => x.listening && x.type === o.type && x.local && addrAccepts(x.local, a));
    if (!lst) return fail(s, E().ECONNREFUSED);
    if (lst.backlog.length <= lst.backlogMax) break;
    if (o.nb) return fail(s, E().ECONNREFUSED);
    yield* waitOn(s, netOf(s).q, "connect to a listener whose backlog is full");
  }
  const unix = a.fam === AF().UNIX;
  const dest: Addr = unix ? lst.local! : { ...a, ip: isZero(a.ip) ? loopFor(a.fam).ip : a.ip };
  if (!o.local) o.local = unix ? { fam: a.fam, ip: new Uint8Array(0), port: 0, path: "" } : { ...loopFor(a.fam), port: allocPort(s) };
  if (!unix) netOf(s).socks.add(o);
  // the server's end, made now and queued for accept
  const srv = newSock(o.dom, o.type);
  srv.local = dest;
  srv.peer = o.local;
  srv.nb = darwin() && lst.nb; // BSD sockets inherit O_NONBLOCK from the listener
  srv.tx = o.rx; srv.rx = new ByteQ(); o.tx = srv.rx;
  srv.peerSock = o; o.peerSock = srv;
  o.peer = dest;
  lst.backlog.push(srv);
  kick(s, netOf(s).q);
  return 0n;
}
// R-NET-SOCK R-NET-BLOCK
function* acceptSock(s: Sys, o: Sock, addr: Value, lenp: Value): Gen<bigint> {
  if (!o.listening) return fail(s, E().EINVAL);
  while (o.backlog.length === 0) {
    if (o.closed) return fail(s, E().EBADF);
    if (o.nb) return fail(s, E().EAGAIN);
    yield* waitOn(s, netOf(s).q, "accept with no pending connection");
  }
  const c = o.backlog.shift()!;
  if (c.local && c.local.fam !== AF().UNIX) netOf(s).socks.add(c);
  if (addr !== 0n && c.peer) putAddr(s, addr, lenp, c.peer);
  kick(s, netOf(s).q);
  return objFd(s, c);
}
// R-NET-SOCK
function socketPair(s: Sys, dom: number, type: number, out: Value): bigint {
  if (dom !== AF().UNIX) return fail(s, E().EAFNOSUPPORT);
  const a = newSock(dom, type), b = newSock(dom, type);
  if (type === 1) { a.tx = b.rx; b.tx = a.rx; }
  a.peerSock = b; b.peerSock = a;
  const un = { fam: dom, ip: new Uint8Array(0), port: 0, path: "" };
  a.peer = un; b.peer = un;
  const m = s.it.mem, x = objFd(s, a), y = objFd(s, b);
  m.store(out, I32, x); m.store(m.advance(out, 4), I32, y);
  return 0n;
}
// R-NET-SOCK: getsockopt / setsockopt keep what the program set; SO_ERROR reports and clears a pending error
function sockOpt(s: Sys, set: boolean, a: Value[]): bigint {
  const o = sockOf(s, a[0]!);
  if (!o) return -1n;
  const key = `${n(a[1]!)}:${n(a[2]!)}`, m = s.it.mem;
  if (set) { const v = n(m.load(a[3]!, I32)); o.opts.set(key, v); if (n(a[2]!) === (darwin() ? 4 : 2) && n(a[1]!) === CONST().SOL_SOCKET) o.opts.set("reuse", v); return 0n; }
  let v = o.opts.get(key) ?? 0;
  if (n(a[1]!) === CONST().SOL_SOCKET && n(a[2]!) === CONST().SO_ERROR) { v = o.error; o.error = 0; }
  m.store(a[3]!, I32, BigInt(v));
  if (a[4] !== 0n) m.store(a[4]!, U32, 4n);
  return 0n;
}

// R-NET-ADDR: no resolver exists; localhost and numeric addresses are the whole name space
function getAddrInfo(s: Sys, node: Value, hints: Value, res: Value): bigint {
  const m = s.it.mem, af = AF();
  const EAI_NONAME = darwin() ? 8n : -2n;
  if (node === 0n) return EAI_NONAME;
  const name = new TextDecoder().decode(m.cstring(node, "getaddrinfo"));
  let want = 0, sockType = 0;
  if (hints !== 0n) { const h = m.readBytes(hints, 16, "hints"); const dv = new DataView(h.buffer); want = dv.getInt32(4, true); sockType = dv.getInt32(8, true); }
  const ips: { fam: number; ip: Uint8Array }[] = [];
  const v4 = parseIp(name, af.INET), v6 = v4 ? null : parseIp(name, af.INET6);
  if (v4) ips.push({ fam: af.INET, ip: v4 });
  else if (v6) ips.push({ fam: af.INET6, ip: v6 });
  else if (name.toLowerCase() === "localhost") { ips.push({ fam: af.INET6, ip: LOOP6 }, { fam: af.INET, ip: LOOP4 }); }
  else return EAI_NONAME;
  const keep = ips.filter(x => want === 0 || x.fam === want);
  if (keep.length === 0) return EAI_NONAME;
  const f = s.it.fns.get("addrinfoAddrOffset");
  const addrOff = f && !f.isExtern ? n(s.it.callFn(f, [])) : darwin() ? 32 : 24;
  const nameOff = darwin() ? 24 : 32;
  const infos = keep.map(x => {
    const b = new Uint8Array(48 + 32), dv = new DataView(b.buffer);
    const sa = encodeAddr({ fam: x.fam, ip: x.ip, port: 0, path: "" });
    dv.setInt32(4, x.fam, true); dv.setInt32(8, sockType || 1, true); dv.setInt32(12, 6, true); dv.setUint32(16, sa.length, true);
    b.set(sa, 48);
    return { ptr: m.staticBytes(b), dv, b };
  });
  infos.forEach((x, i) => {
    x.dv.setBigUint64(addrOff, m.addr(m.advance(x.ptr, 48)), true);
    x.dv.setBigUint64(nameOff, 0n, true);
    x.dv.setBigUint64(40, i + 1 < infos.length ? m.addr(infos[i + 1]!.ptr) : 0n, true);
    m.writeBytes(x.ptr, x.b, "addrinfo");
  });
  m.store(res, I64, m.addr(infos[0]!.ptr));
  return 0n;
}

// ── signals (R-NET-SIG) ──
const IGNORED_BY_DEFAULT = (sig: number): boolean => { const c = CONST(); return sig === c.SIGCHLD || sig === c.SIGURG || sig === c.SIGWINCH || sig === c.SIGCONT; };
// R-NET-SIG: a signal sent to this process runs its handler now, in the sending task, or its default action
function* raiseSignal(s: Sys, sig: number): Gen<void> {
  const net = netOf(s);
  if (sig <= 0 || sig > 64) return;
  const canBlock = sig !== 9 && sig !== CONST().SIGSTOP;
  if (canBlock && net.mask & (1 << (sig - 1))) { net.pending.add(sig); return; }
  const h = net.handlers.get(sig) ?? 0n;
  if (h === 1n && canBlock) return; // SIG_IGN
  if (h !== 0n && h !== 1n && canBlock) {
    const name = calleeName(s, h);
    if (!name) return s.it.stuck("R-NET-SIG", "a signal handler that is not a function pointer");
    const it = coOf(s);
    if (it) yield* it.callNamed$g(name, [BigInt(sig)]); else s.it.callNamed(name, [BigInt(sig)]);
    return;
  }
  if (IGNORED_BY_DEFAULT(sig) && canBlock) return;
  s.it.aborted = true;
  throw new ExitProgram(128 + sig, true); // the process dies of the signal
}

// ── threads and locks (R-NET-THREAD) ──
// the lock objects live beside the program's memory, keyed by the address of the pthread_*_t the program passed
function objAt<T extends Mutex | Cond | RwLock>(s: Sys, p: Value, make: () => T, fresh = false): T {
  const q = s.it.mem.asPtr(p, "pthread object");
  const net = netOf(s);
  let m = net.objs.get(q.a);
  if (!m) net.objs.set(q.a, (m = new Map()));
  let o = m.get(q.off) as T | undefined;
  if (!o || fresh) m.set(q.off, (o = make()));
  return o;
}
const newMutex = (): Mutex => ({ owner: null, q: new WaitQ() });
// R-NET-MUTEX
function* lockMutex(s: Sys, m: Mutex): Gen<void> {
  const me = coOf(s)?.cur ?? null;
  while (m.owner) yield* waitOn(s, m.q, "pthread_mutex_lock (another thread holds it)");
  m.owner = me ?? ({} as Task);
}
// R-NET-MUTEX
function unlockMutex(s: Sys, m: Mutex): void { m.owner = null; kick(s, m.q); }
// R-NET-COND
function* condWait(s: Sys, c: Cond, m: Mutex, timeoutMs?: number): Gen<bigint> {
  const tok = { done: false };
  c.toks.push(tok);
  unlockMutex(s, m);
  let timedOut = false;
  const start = coOf(s)?.clock ?? 0;
  while (!tok.done && !timedOut) {
    const left = timeoutMs === undefined ? undefined : Math.max(0, timeoutMs - ((coOf(s)?.clock ?? 0) - start));
    if (left === 0) { timedOut = true; break; }
    timedOut = yield* waitOn(s, c.q, "pthread_cond_wait", left);
  }
  if (!tok.done) c.toks = c.toks.filter(t => t !== tok);
  yield* lockMutex(s, m);
  return timedOut && !tok.done ? BigInt(E().ETIMEDOUT) : 0n;
}
// R-NET-THREAD: pthread_create runs the start routine as one more task; one task runs at a time and nothing preempts
function pthreadCreate(s: Sys, a: Value[]): bigint {
  const it = coOf(s);
  if (!it) throw new NeedTasks();
  const net = netOf(s);
  net.usedThreads = true;
  const name = calleeName(s, a[2]!);
  if (!name) return s.it.stuck("R-NET-THREAD", "pthread_create with a start routine that is not a function pointer");
  const th: Thread = { id: 0, done: false, ret: 0n, detached: false, q: new WaitQ() };
  const t = it.spawnThread(name, [a[3]!], r => { th.done = true; th.ret = r; kick(s, th.q); });
  th.id = t.id;
  net.threads.set(th.id, th);
  s.it.mem.store(a[0]!, I64, BigInt(th.id));
  return 0n;
}
// R-NET-THREAD
function* pthreadJoin(s: Sys, a: Value[]): Gen<bigint> {
  const th = netOf(s).threads.get(n(a[0]!));
  if (!th || th.detached) return BigInt(E().ESRCH);
  while (!th.done) yield* waitOn(s, th.q, "pthread_join");
  if (a[1] !== 0n) s.it.mem.store(a[1]!, PTR, th.ret);
  netOf(s).threads.delete(th.id);
  return 0n;
}
// R-NET-SLEEP: once the program has threads, a sleep gives the CPU to the others; before that it only moves the clock
function* sleepFor(s: Sys, ms: number, base: (s: Sys, a: Value[]) => Value, a: Value[]): Gen<Value> {
  const it = coOf(s);
  if (!it || !netOf(s).usedThreads) return base(s, a);
  yield* it.sleep(ms);
  return 0n;
}

// the C functions with net behaviour, by symbol
export const NET: Record<string, NetFn> = {
  // ── descriptors that may be a pipe or a socket ──
  read: (s, a, base) => { const f = fdOf(s, a[0]!); return f?.obj ? readObj(s, f.obj, a[1]!, n(a[2]!)) : base!(s, a); },
  write: (s, a, base) => { const f = fdOf(s, a[0]!); return f?.obj ? writeObj(s, f.obj, a[1]!, n(a[2]!)) : base!(s, a); },
  close: (s, a, base) => { const f = fdOf(s, a[0]!); if (!f?.obj) return base!(s, a); s.fds.delete(n(a[0]!)); release(s, f.obj); return 0n; },
  dup: (s, a, base) => { const f = fdOf(s, a[0]!); const r = base!(s, a); if (f?.obj) f.obj.refs++; return r; },
  dup2: (s, a, base) => {
    const src = fdOf(s, a[0]!), dst = fdOf(s, a[1]!);
    if (src && a[0] === a[1]) return a[1];
    if (src && dst?.obj) { s.fds.delete(n(a[1]!)); release(s, dst.obj); }
    const r = base!(s, a);
    if (src?.obj) src.obj.refs++;
    return r;
  },
  fcntl: (s, a, base) => {
    const f = fdOf(s, a[0]!);
    if (!f?.obj) return base!(s, a);
    const cmd = n(a[1]!);
    if (cmd === 3) return f.obj.nb ? BigInt(CONST().O_NONBLOCK) : 0n; // F_GETFL
    if (cmd === 4) { f.obj.nb = !!(n(a[2]!) & CONST().O_NONBLOCK); return 0n; } // F_SETFL
    return 0n;
  },
  ioctl: (s, a) => {
    const f = fdOf(s, a[0]!);
    if (!f) return fail(s, E().EBADF);
    if (f.obj && n(a[1]!) === (darwin() ? 0x8004667e : 0x5421)) { f.obj.nb = n(s.it.mem.load(a[2]!, I32)) !== 0; return 0n; } // FIONBIO
    return fail(s, 25);
  },

  // ── kqueue (darwin): level-triggered read and write readiness, and user events ──
  kqueue: s => objFd(s, { k: "kq", nb: false, refs: 1, watches: new Map() }),
  kevent: (s, a) => keventCall(s, a),

  // ── pipes ──
  pipe: (s, a) => pipeCall(s, a[0]!, 0),
  pipe2: (s, a) => pipeCall(s, a[0]!, n(a[1]!)),
  socketpair: (s, a) => socketPair(s, n(a[0]!), n(a[1]!) & 0xff, a[3]!),

  // ── sockets ──
  socket: (s, a) => {
    const dom = n(a[0]!), type = n(a[1]!) & 0xf, af = AF();
    if (dom !== af.INET && dom !== af.INET6 && dom !== af.UNIX) return fail(s, E().EAFNOSUPPORT);
    if (type !== 1 && type !== 2) return fail(s, E().EPROTOTYPE);
    const o = newSock(dom, type);
    if (n(a[1]!) & (darwin() ? 0 : 0x800)) o.nb = true; // SOCK_NONBLOCK exists on linux only
    return objFd(s, o);
  },
  bind: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    const ad = decodeAddr(s, a[1]!, n(a[2]!));
    return ad ? bindSock(s, o, ad) : fail(s, E().EAFNOSUPPORT);
  },
  listen: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    if (o.type !== 1 || o.tx) return fail(s, E().EINVAL);
    if (!o.local) {
      if (o.dom === AF().UNIX) return fail(s, E().EINVAL);
      bindSock(s, o, { fam: o.dom, ip: new Uint8Array(o.dom === AF().INET ? 4 : 16), port: 0, path: "" });
    }
    o.listening = true;
    o.backlogMax = Math.max(0, n(a[1]!));
    kick(s, netOf(s).q);
    return 0n;
  },
  accept: (s, a) => { const o = sockOf(s, a[0]!); return o ? acceptSock(s, o, a[1]!, a[2]!) : -1n; },
  connect: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    const ad = decodeAddr(s, a[1]!, n(a[2]!));
    return ad ? connectSock(s, o, ad) : fail(s, E().EAFNOSUPPORT);
  },
  setsockopt: (s, a) => sockOpt(s, true, a),
  getsockopt: (s, a) => sockOpt(s, false, a),
  getsockname: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    putAddr(s, a[1]!, a[2]!, o.local ?? { fam: o.dom, ip: new Uint8Array(o.dom === AF().INET ? 4 : 16), port: 0, path: "" });
    return 0n;
  },
  getpeername: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    if (!o.peer) return fail(s, E().ENOTCONN);
    putAddr(s, a[1]!, a[2]!, o.peer);
    return 0n;
  },
  shutdown: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    if (!o.tx && !o.peer) return fail(s, E().ENOTCONN);
    const how = n(a[1]!);
    if ((how === 1 || how === 2) && o.tx) o.tx.eof = true;
    if (how === 0 || how === 2) { o.shutRd = true; o.rx.broken = true; }
    kick(s, netOf(s).q);
    return 0n;
  },
  send: (s, a) => { const o = sockOf(s, a[0]!); return o ? writeObj(s, o, a[1]!, n(a[2]!)) : -1n; },
  recv: (s, a) => { const o = sockOf(s, a[0]!); return o ? readObj(s, o, a[1]!, n(a[2]!)) : -1n; },
  sendto: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    if (o.type !== 2 || a[4] === 0n) return writeObj(s, o, a[1]!, n(a[2]!));
    const to = decodeAddr(s, a[4]!, n(a[5]!));
    return to ? sendDgram(s, o, a[1]!, n(a[2]!), to) : fail(s, E().EAFNOSUPPORT);
  },
  recvfrom: (s, a) => {
    const o = sockOf(s, a[0]!);
    if (!o) return -1n;
    return o.type === 2 ? recvDgram(s, o, a[1]!, n(a[2]!), a[4]!, a[5]!) : readObj(s, o, a[1]!, n(a[2]!));
  },
  htons: (_s, [x]) => BigInt(((n(x!) & 255) << 8) | ((n(x!) >> 8) & 255)),
  ntohs: (_s, [x]) => BigInt(((n(x!) & 255) << 8) | ((n(x!) >> 8) & 255)),
  inet_pton: (s, [af, src, dst]) => {
    const fam = n(af!);
    if (fam !== AF().INET && fam !== AF().INET6) return fail(s, E().EAFNOSUPPORT);
    const ip = parseIp(new TextDecoder().decode(s.it.mem.cstring(src!, "inet_pton")), fam);
    if (!ip) return 0n;
    s.it.mem.writeBytes(dst!, ip, "inet_pton");
    return 1n;
  },
  getaddrinfo: (s, a) => getAddrInfo(s, a[0]!, a[2]!, a[3]!),
  freeaddrinfo: () => undefined,

  // ── waiting for descriptors ──
  poll: (s, a) => pollCall(s, a[0]!, n(a[1]!), n(a[2]!)),

  // ── signals ──
  signal: (s, [sig, h]) => {
    const net = netOf(s), k = n(sig!);
    if (k <= 0 || k > 64 || k === 9 || k === CONST().SIGSTOP) return s.setErrno(E().EINVAL);
    const old = net.handlers.get(k) ?? 0n;
    net.handlers.set(k, h!);
    return old;
  },
  raise: (s, [sig]) => (function* (): Gen<Value> { yield* raiseSignal(s, n(sig!)); return 0n; })(),
  kill: (s, [pid, sig]) => (function* (): Gen<Value> {
    const p = n(pid!);
    if (p !== Number(PID) && p !== 0 && p !== -Number(PID)) return fail(s, E().ESRCH); // no other process exists
    if (n(sig!) !== 0) yield* raiseSignal(s, n(sig!));
    return 0n;
  })(),
  sigprocmask: (s, a) => {
    const net = netOf(s), m = s.it.mem, c = CONST();
    if (a[2] !== 0n) m.store(a[2]!, U32, BigInt(net.mask >>> 0));
    if (a[1] === 0n) return 0n;
    const set = n(m.load(a[1]!, U32));
    const how = n(a[0]!);
    net.mask = how === c.BLOCK ? net.mask | set : how === c.UNBLOCK ? net.mask & ~set : set;
    return (function* (): Gen<Value> { for (const sig of [...net.pending]) if (!(net.mask & (1 << (sig - 1)))) { net.pending.delete(sig); yield* raiseSignal(s, sig); } return 0n; })();
  },

  // ── threads ──
  pthread_create: (s, a) => pthreadCreate(s, a),
  pthread_join: (s, a) => pthreadJoin(s, a),
  pthread_detach: (s, a) => { const th = netOf(s).threads.get(n(a[0]!)); if (th) th.detached = true; return 0n; },
  pthread_self: s => BigInt(coOf(s)?.cur.id ?? 1),
  sched_yield: s => (function* (): Gen<Value> { const it = coOf(s); if (it) yield* it.yieldNow(); return 0n; })(),
  pthread_mutex_init: (s, a) => { objAt(s, a[0]!, newMutex, true); return 0n; },
  pthread_mutex_destroy: (s, a) => { const q = s.it.mem.asPtr(a[0]!, "pthread_mutex_destroy"); netOf(s).objs.get(q.a)?.delete(q.off); return 0n; },
  pthread_mutex_lock: (s, a) => (function* (): Gen<Value> { yield* lockMutex(s, objAt(s, a[0]!, newMutex)); return 0n; })(),
  pthread_mutex_trylock: (s, a) => { const m = objAt(s, a[0]!, newMutex); if (m.owner) return BigInt(E().EBUSY); m.owner = coOf(s)?.cur ?? ({} as Task); return 0n; },
  pthread_mutex_unlock: (s, a) => { unlockMutex(s, objAt(s, a[0]!, newMutex)); return 0n; },
  pthread_cond_init: (s, a) => { objAt<Cond>(s, a[0]!, () => ({ toks: [], q: new WaitQ() }), true); return 0n; },
  pthread_cond_destroy: (s, a) => { const q = s.it.mem.asPtr(a[0]!, "pthread_cond_destroy"); netOf(s).objs.get(q.a)?.delete(q.off); return 0n; },
  pthread_cond_wait: (s, a) => condWait(s, objAt<Cond>(s, a[0]!, newCond), objAt(s, a[1]!, newMutex)),
  pthread_cond_timedwait_relative_np: (s, a) => {
    const m = s.it.mem, sec = Number(m.load(a[2]!, I64) as bigint), nsec = Number(m.load(m.advance(a[2]!, 8), I64) as bigint);
    return condWait(s, objAt<Cond>(s, a[0]!, newCond), objAt(s, a[1]!, newMutex), Math.max(0, sec * 1000 + nsec / 1e6));
  },
  pthread_cond_timedwait: (s, a) => {
    const m = s.it.mem, sec = Number(m.load(a[2]!, I64) as bigint), nsec = Number(m.load(m.advance(a[2]!, 8), I64) as bigint);
    return condWait(s, objAt<Cond>(s, a[0]!, newCond), objAt(s, a[1]!, newMutex), Math.max(0, sec * 1000 + nsec / 1e6 - s.now()));
  },
  pthread_cond_signal: (s, a) => { const c = objAt<Cond>(s, a[0]!, newCond); const t = c.toks.shift(); if (t) { t.done = true; kick(s, c.q); } return 0n; },
  pthread_cond_broadcast: (s, a) => { const c = objAt<Cond>(s, a[0]!, newCond); for (const t of c.toks.splice(0)) t.done = true; kick(s, c.q); return 0n; },
  pthread_rwlock_init: (s, a) => { objAt<RwLock>(s, a[0]!, newRw, true); return 0n; },
  pthread_rwlock_destroy: (s, a) => { const q = s.it.mem.asPtr(a[0]!, "pthread_rwlock_destroy"); netOf(s).objs.get(q.a)?.delete(q.off); return 0n; },
  pthread_rwlock_rdlock: (s, a) => (function* (): Gen<Value> { const l = objAt<RwLock>(s, a[0]!, newRw); while (l.writer) yield* waitOn(s, l.q, "pthread_rwlock_rdlock"); l.readers++; return 0n; })(),
  pthread_rwlock_wrlock: (s, a) => (function* (): Gen<Value> { const l = objAt<RwLock>(s, a[0]!, newRw); while (l.writer || l.readers > 0) yield* waitOn(s, l.q, "pthread_rwlock_wrlock"); l.writer = true; return 0n; })(),
  pthread_rwlock_unlock: (s, a) => { const l = objAt<RwLock>(s, a[0]!, newRw); if (l.writer) l.writer = false; else if (l.readers > 0) l.readers--; kick(s, l.q); return 0n; },

  // R-FNPTR: the comparator is a function pointer; it sees two scratch copies of the elements being compared
  qsort: (s, [base, nmemb, size, cmp]) => {
    const m = s.it.mem, name = calleeName(s, cmp!), k = n(nmemb!), w = n(size!);
    if (!name) return s.it.stuck("R-FNPTR", "qsort with a comparator that is not a function pointer");
    if (k < 2 || w === 0) return undefined;
    const all = m.readBytes(base!, k * w, "qsort");
    const elems = Array.from({ length: k }, (_, i) => all.slice(i * w, (i + 1) * w));
    const a = m.staticBytes(new Uint8Array(w)), b = m.staticBytes(new Uint8Array(w));
    elems.sort((x, y) => { m.writeBytes(a, x); m.writeBytes(b, y); return Number(s.it.callNamed(name, [a, b]) as bigint); });
    m.writeBytes(base!, Uint8Array.from(elems.flatMap(e => [...e])), "qsort");
    return undefined;
  },

  // ── sleeping with threads around ──
  usleep: (s, a, base) => sleepFor(s, n(a[0]!) / 1000, base!, a),
  sleep: (s, a, base) => sleepFor(s, n(a[0]!) * 1000, base!, a),
  nanosleep: (s, a, base) => {
    const m = s.it.mem;
    return sleepFor(s, Number(m.load(a[0]!, I64) as bigint) * 1000 + Number(m.load(m.advance(a[0]!, 8), I64) as bigint) / 1e6, base!, a);
  },
};
const newCond = (): Cond => ({ toks: [], q: new WaitQ() });
const newRw = (): RwLock => ({ writer: false, readers: 0, q: new WaitQ() });

// kevent(2): the change list is applied, then events are collected, parking until one exists or the timeout (virtual ms) passes.
// struct kevent is {u64 ident; i16 filter; u16 flags; u32 fflags; i64 data; ptr udata}, 32 bytes.
// R-NET-KQUEUE
function* keventCall(s: Sys, a: Value[]): Gen<bigint> {
  const f = fdOf(s, a[0]!);
  if (!f || f.obj?.k !== "kq") return fail(s, E().EBADF);
  const kq = f.obj, m = s.it.mem, net = netOf(s);
  const U16 = { tag: "int", bits: 16, signed: false } as const, I16 = { tag: "int", bits: 16, signed: true } as const;
  const EV_ADD = 1, EV_DELETE = 2, EV_ONESHOT = 16, EV_CLEAR = 32, NOTE_TRIGGER = 0x1000000;
  for (let i = 0; i < n(a[2]!); i++) {
    const at = m.advance(a[1]!, i * 32);
    const ident = Number(m.load(at, I64) as bigint), filter = n(m.load(m.advance(at, 8), I16)), flags = n(m.load(m.advance(at, 10), U16));
    const fflags = n(m.load(m.advance(at, 12), U32)), udata = m.load(m.advance(at, 24), PTR);
    const key = `${ident}:${filter}`;
    if (flags & EV_DELETE) { if (!kq.watches.delete(key)) return fail(s, 2); continue; }
    if (flags & EV_ADD) kq.watches.set(key, { ident, filter, fflags: 0, udata, clear: !!(flags & EV_CLEAR), oneshot: !!(flags & EV_ONESHOT), fired: false });
    const w = kq.watches.get(key);
    if (!w) return fail(s, 2);
    if (filter === -10 && fflags & NOTE_TRIGGER) { w.fired = true; kick(s, net.q); }
  }
  const cap = n(a[4]!);
  if (cap <= 0) return 0n;
  const ts = a[5] === 0n ? undefined : Number(m.load(a[5]!, I64) as bigint) * 1000 + Number(m.load(m.advance(a[5]!, 8), I64) as bigint) / 1e6;
  const collect = (): Watch[] => {
    const out: Watch[] = [];
    for (const w of kq.watches.values()) {
      const ready = w.filter === -10 ? w.fired : (() => { const g = s.fds.get(w.ident); return !!g && (readiness(g.obj) & (w.filter === -1 ? POLLIN | POLLHUP : POLLOUT | POLLERR)) !== 0; })();
      if (ready) out.push(w);
    }
    return out.slice(0, cap);
  };
  let left = ts;
  for (;;) {
    const ready = collect();
    if (ready.length > 0 || left === 0) {
      ready.forEach((w, i) => {
        const at = m.advance(a[3]!, i * 32);
        m.store(at, I64, BigInt(w.ident)); m.store(m.advance(at, 8), I16, BigInt(w.filter)); m.store(m.advance(at, 10), U16, 0n);
        m.store(m.advance(at, 12), U32, 0n); m.store(m.advance(at, 16), I64, 0n); m.store(m.advance(at, 24), PTR, w.udata);
        if (w.filter === -10) w.fired = false;
        if (w.oneshot) kq.watches.delete(`${w.ident}:${w.filter}`);
      });
      return BigInt(ready.length);
    }
    const t0 = coOf(s)?.clock ?? 0;
    const timedOut = yield* waitOn(s, net.q, "kevent with nothing ready", left);
    if (timedOut) return collect().length > 0 ? yield* keventCall(s, [a[0]!, 0n, 0n, a[3]!, a[4]!, m.staticBytes(new Uint8Array(16))]) : 0n;
    if (left !== undefined) left = Math.max(0, left - ((coOf(s)?.clock ?? 0) - t0));
  }
}
// R-NET-PIPE
function pipeCall(s: Sys, out: Value, flags: number): bigint {
  const q = new ByteQ(), nb = !!(flags & CONST().O_NONBLOCK);
  const r = objFd(s, { k: "pipe", read: true, q, nb, refs: 1 }), w = objFd(s, { k: "pipe", read: false, q, nb, refs: 1 });
  const m = s.it.mem;
  m.store(out, I32, r);
  m.store(m.advance(out, 4), I32, w);
  return 0n;
}

// poll(2): struct pollfd is {int fd; short events; short revents}, 8 bytes
// R-NET-POLL
function* pollCall(s: Sys, fds: Value, nfds: number, timeout: number): Gen<bigint> {
  const m = s.it.mem, net = netOf(s);
  const U16 = { tag: "int", bits: 16, signed: false } as const;
  const scan = (): number => {
    let ready = 0;
    for (let i = 0; i < nfds; i++) {
      const at = m.advance(fds, i * 8);
      const fd = n(m.load(at, I32)), ev = n(m.load(m.advance(at, 4), U16));
      const f = s.fds.get(fd);
      let rev = 0;
      if (fd >= 0 && !f) rev = POLLNVAL;
      else if (f) { const r = readiness(f.obj); rev = (r & (ev | POLLERR | POLLHUP)) ; }
      m.store(m.advance(at, 6), U16, BigInt(rev));
      if (rev) ready++;
    }
    return ready;
  };
  let left = timeout < 0 ? undefined : timeout;
  for (;;) {
    const r = scan();
    if (r > 0) return BigInt(r);
    if (left === 0) return 0n;
    const t0 = coOf(s)?.clock ?? 0;
    const timedOut = yield* waitOn(s, net.q, "poll with nothing ready", left);
    if (timedOut) return scan() > 0 ? BigInt(scan()) : 0n;
    if (left !== undefined) left = Math.max(0, left - ((coOf(s)?.clock ?? 0) - t0));
  }
}

// ── natives the green IO path calls ──
// R-NET-BLOCK: a green task waiting for a descriptor to be readable or writable parks until it is
function* waitFd(it: Interp, fd: number, want: number): Gen<Value> {
  (it as InterpCo).fdWaited = true;
  const s = (it.sys ??= new Sys(it, it.sysOptions));
  const net = netOf(s);
  for (;;) {
    const f = s.fds.get(fd);
    if (!f || readiness(f.obj) & (want | POLLERR | POLLHUP)) return undefined;
    yield* waitOn(s, net.q, want === POLLIN ? "schedulerWaitRead" : "schedulerWaitWrite");
  }
}
const NATIVES: Record<string, Native> = {
  schedulerWaitRead: ((it: Interp, [fd]: Value[]) => waitFd(it, n(fd!), POLLIN)) as unknown as Native,
  schedulerWaitWrite: ((it: Interp, [fd]: Value[]) => waitFd(it, n(fd!), POLLOUT)) as unknown as Native,
};
for (const k of Object.keys(NATIVES)) NATIVES[k]!.co = true;
/** The native for a std function that waits on a descriptor, or undefined. R-NET-BLOCK */
export function netNativeFor(name: string): Native | undefined { return NATIVES[name]; }

// R-NET-POLL: can a read (or write) on the descriptor go ahead now? For Select's fd arms
export function fdReady(it: Interp, fd: number, write: boolean): boolean {
  const s = (it.sys ??= new Sys(it, it.sysOptions));
  const f = s.fds.get(fd);
  return !f || (readiness(f.obj) & ((write ? POLLOUT : POLLIN) | POLLERR | POLLHUP)) !== 0;
}
// the list every task blocked on a descriptor waits on (a Select with an fd arm joins it). R-SELECT
export function netWaiters(it: Interp): { ts: Task[] } {
  return netOf((it.sys ??= new Sys(it, it.sysOptions))).q;
}

// R-TASK-PANIC: the reply a panicking connection task leaves for its client, written and closed without blocking
export function replyAndClose(it: Interp, fd: number, bytes: Uint8Array): void {
  const s = (it.sys ??= new Sys(it, it.sysOptions));
  const f = s.fds.get(fd);
  if (!f?.obj) return;
  const o = f.obj;
  const q = o.k === "kq" ? null : o.k === "pipe" ? (o.read ? null : o.q) : o.tx;
  if (q && !q.broken) q.push(bytes.slice(0, Math.max(0, BUF_CAP - q.len)));
  s.fds.delete(fd);
  release(s, o);
}
