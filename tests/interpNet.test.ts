// The reference interpreter's in-memory network, pipes, signals and threads (src/interp-net.ts) against
// docs/semantics/milo.md "The network, pipes, signals and threads": small programs whose output pins one
// rule each, run through the interpreter, plus real fixtures compared with their recorded compiled runs.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { Interp } from "../src/interp";
import { InterpCo, runChecked } from "../src/interp-co";
import { InterpStuck } from "../src/interp-values";
import type { Program } from "../src/ast";
import type { CheckResult } from "../src/checker";
import { compareOne } from "../scripts/interp-coverage";

const dir = mkdtempSync(join(tmpdir(), "milo-interp-net-"));
let n = 0;
const checkedOf = new Map<Program, CheckResult>();
function check(src: string): { program: Program; interp: Interp } {
  const path = join(dir, `t${n++}.milo`);
  writeFileSync(path, src);
  const parsed = new Parser(new Lexer(src).tokenize(), src, path).parse();
  const program = resolveImports(parsed, dirname(path), getHostTarget(), path);
  const result = new TypeChecker().check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  if (errors.length) throw new Error(`checker rejected the test program: ${errors.map(e => e.message).join("; ")}`);
  checkedOf.set(program, result);
  return { program, interp: new Interp(program, result) };
}
const runTasks = (src: string) => {
  const { program } = check(src);
  const { it, result: r } = runChecked(program, checkedOf.get(program)!, {});
  return { out: new TextDecoder().decode(r.stdout), code: r.code, live: r.live, co: it instanceof InterpCo };
};
// the stuck message of a program the interpreter cannot finish
const stuckOf = (src: string): string => {
  try { runTasks(src); } catch (e) { if (e instanceof InterpStuck) return e.message; throw e; }
  return "";
};

const PIPE_IMPORTS = `
from "std/platform" import { pipe, read, write, close, usleep, getpid }
from "std/signal" import { onSignal, ignoreSignal, resetSignal }
from "std/os" import { kill }
`;

test("R-FNPTR, R-NET-SIG: a handler passed as a function pointer runs at raise/kill with the signal number, in the sender", () => {
  const r = runTasks(`${PIPE_IMPORTS}
pub var seen: i32 = 0
pub fn handler(sig: i32): void { seen = sig; print("in handler ", sig) }
pub fn main() {
    unsafe { onSignal(10, handler as *u8) }
    print("before")
    kill(getpid(), 10)
    print("after ", seen)
}`);
  expect(r.out).toBe("before\nin handler 10\nafter 10\n");
  expect(r.code).toBe(0);
});

test("R-NET-SIG: SIG_IGN does nothing, SIG_DFL on a terminating signal kills the program with status 128 + signal", () => {
  const ign = runTasks(`${PIPE_IMPORTS}
pub fn main() { ignoreSignal(15); kill(getpid(), 15); print("survived") }`);
  expect(ign.out).toBe("survived\n");
  const dfl = runTasks(`${PIPE_IMPORTS}
pub fn main() { print("one"); kill(getpid(), 15); print("never") }`);
  expect(dfl.out).toBe("one\n");
  expect(dfl.code).toBe(143);
  const back = runTasks(`${PIPE_IMPORTS}
pub fn h(sig: i32): void { print("handled") }
pub fn main() { unsafe { onSignal(15, h as *u8) }; kill(getpid(), 15); resetSignal(15); kill(getpid(), 15); print("never") }`);
  expect(back.out).toBe("handled\n");
  expect(back.code).toBe(143);
  const gone = runTasks(`${PIPE_IMPORTS}
pub fn main() { print(kill(99, 15)) }`);
  expect(gone.out).toBe("-1\n");
});

test("R-NET-PIPE, R-NET-FD: bytes written to a pipe are read back; EOF once the write end closes; EPIPE once the read end is closed", () => {
  const r = runTasks(`${PIPE_IMPORTS}
pub fn main() {
    unsafe {
        let fds: [i32; 2] = [0; 2]
        pipe(fds as *i32)
        let msg: [u8; 3] = [104, 105, 33]
        print(write(fds[1], msg as *u8, 3))
        let buf: [u8; 8] = [0; 8]
        print(read(fds[0], buf as *u8, 8))
        print(buf[0], " ", buf[2])
        close(fds[1])
        print(read(fds[0], buf as *u8, 8))
        close(fds[0])
        let g: [i32; 2] = [0; 2]
        pipe(g as *i32)
        ignoreSignal(13)
        close(g[0])
        print(write(g[1], msg as *u8, 3))
    }
}`);
  expect(r.out).toBe("3\n3\n104 33\n0\n-1\n");
});

test("R-NET-PIPE: a write to a pipe nobody reads, with SIGPIPE at its default, kills the program with status 141", () => {
  const r = runTasks(`${PIPE_IMPORTS}
pub fn main() {
    unsafe {
        let g: [i32; 2] = [0; 2]
        pipe(g as *i32)
        close(g[0])
        let msg: [u8; 1] = [1]
        write(g[1], msg as *u8, 1)
        print("never")
    }
}`);
  expect(r.out).toBe("");
  expect(r.code).toBe(141);
});

test("R-NET-BLOCK, R-NET-IO: a read of an empty pipe parks until the other task writes; a full pipe parks the writer", () => {
  const r = runTasks(`${PIPE_IMPORTS}
from "std/runtime" import { Task, schedulerRunToCompletion }
from "std/os" import { readFd, writeFd }
pub fn main() {
    unsafe {
        let fds: [i32; 2] = [0; 2]
        pipe(fds as *i32)
        let rfd = fds[0]
        let wfd = fds[1]
        Task.spawn(move(): void => {
            let buf: [u8; 4096] = [0; 4096]
            var got: i64 = 0
            while got < 100000 { got += readFd(rfd, buf as *u8, 4096) }
            print("read ", got)
        })
        Task.spawn(move(): void => {
            let big: [u8; 4096] = [7; 4096]
            var sent: i64 = 0
            while sent < 100000 { sent += writeFd(wfd, big as *u8, 4096) }
            print("wrote all")
        })
        schedulerRunToCompletion()
    }
}`);
  // the writer parks each time 64 KiB are queued and the reader, which parks on an empty pipe, drains it
  expect(r.out.split("\n").sort().join(",")).toBe(",read 102400,wrote all");
});

test("S-DEADLOCK, R-NET-BLOCK: under the plain interpreter a read nothing can satisfy is a stuck state, not a hang", () => {
  const msg = stuckOf(`${PIPE_IMPORTS}
pub fn main() {
    unsafe {
        let fds: [i32; 2] = [0; 2]
        pipe(fds as *i32)
        let buf: [u8; 4] = [0; 4]
        read(fds[0], buf as *u8, 4)
    }
}`);
  expect(msg).toContain("S-DEADLOCK");
});

const THREAD_IMPORTS = `
from "std/platform" import { pthread_create, pthread_join, pthread_mutex_init, pthread_mutex_lock, pthread_mutex_unlock, pthread_cond_init, pthread_cond_wait, pthread_cond_signal, usleep }
`;

test("R-NET-THREAD, R-NET-MUTEX: pthread_create runs the routine as a task; join returns its value; a mutex serialises the counter", () => {
  const r = runTasks(`${THREAD_IMPORTS}
pub var counter: i64 = 0
pub var mu: [u8; 64] = [0; 64]
pub fn worker(arg: *u8): *u8 {
    unsafe {
        var i = 0
        while i < 100 {
            pthread_mutex_lock(mu as *u8)
            let c = counter
            usleep(1)
            counter = c + 1
            pthread_mutex_unlock(mu as *u8)
            i += 1
        }
    }
    unsafe { return 7 as *u8 }
}
pub fn main() {
    unsafe {
        pthread_mutex_init(mu as *u8, 0 as *u8)
        var a: i64 = 0
        var b: i64 = 0
        pthread_create((a.addrOf()) as *u8, 0 as *u8, worker as *u8, 0 as *u8)
        pthread_create((b.addrOf()) as *u8, 0 as *u8, worker as *u8, 0 as *u8)
        var ret: *u8 = 0 as *u8
        pthread_join(a, (ret.addrOf()) as *u8)
        pthread_join(b, 0 as *u8)
        print(counter, " ", ret as i64)
    }
}`);
  expect(r.out).toBe("200 7\n");
});

test("R-NET-COND, R-NET-SLEEP: a condition wait releases the mutex and wakes on signal; sleeping gives the other thread the CPU", () => {
  const r = runTasks(`${THREAD_IMPORTS}
pub var mu: [u8; 64] = [0; 64]
pub var cv: [u8; 64] = [0; 64]
pub var ready: bool = false
pub fn producer(arg: *u8): *u8 {
    unsafe {
        usleep(5000)
        pthread_mutex_lock(mu as *u8)
        ready = true
        print("signalling")
        pthread_cond_signal(cv as *u8)
        pthread_mutex_unlock(mu as *u8)
    }
    unsafe { return 0 as *u8 }
}
pub fn main() {
    unsafe {
        pthread_mutex_init(mu as *u8, 0 as *u8)
        pthread_cond_init(cv as *u8, 0 as *u8)
        var t: i64 = 0
        pthread_create((t.addrOf()) as *u8, 0 as *u8, producer as *u8, 0 as *u8)
        pthread_mutex_lock(mu as *u8)
        while !ready { pthread_cond_wait(cv as *u8, mu as *u8) }
        pthread_mutex_unlock(mu as *u8)
        print("woken")
        pthread_join(t, 0 as *u8)
    }
}`);
  expect(r.out).toBe("signalling\nwoken\n");
});

test("R-NET-SOCK, R-NET-IO, R-NET-ADDR: a loopback listener and client in one program exchange bytes; a connect nobody listens on is refused", () => {
  const r = runTasks(`
from "std/net" import { TcpListener, TcpStream, ip4 }
from "std/runtime" import { Task, schedulerRunToCompletion }
from "std/io" import { BufReader, BufWriter, FdStream }
pub fn main() {
    let lis = TcpListener.bind(0)!
    let port = lis.port() as u16
    print(port > 1023)
    Task.spawn(move(): void => {
        let conn = lis.accept()!
        var rd = BufReader<FdStream>.new(conn.stream())
        var wr = BufWriter<FdStream>.new(conn.stream())
        let line = rd.readLine()! ?? ""
        wr.writeLine("echo " + line)!
        wr.flush()!
    })
    let cli = TcpStream.connect(ip4(127, 0, 0, 1), port)!
    var wr = BufWriter<FdStream>.new(cli.stream())
    wr.writeLine("hi")!
    wr.flush()!
    schedulerRunToCompletion()
    var rd = BufReader<FdStream>.new(cli.stream())
    print(rd.readLine()! ?? "none")
    print(TcpStream.connect(ip4(127, 0, 0, 1), 1).isErr())
    print(TcpStream.connect(ip4(10, 1, 2, 3), 80).isErr())
}`);
  expect(r.out).toBe("true\necho hi\ntrue\ntrue\n");
});

test("R-NET-DGRAM, R-NET-FD: datagrams keep their boundaries and a dup'd descriptor keeps the socket open until the last close", () => {
  const r = runTasks(`${PIPE_IMPORTS}
extern fn socketpair(domain: i32, ty: i32, proto: i32, sv: *i32): i32
extern fn dup(fd: i32): i32
pub fn main() {
    unsafe {
        let sv: [i32; 2] = [0; 2]
        print(socketpair(1, 2, 0, sv as *i32))
        let a: [u8; 3] = [1, 2, 3]
        let b: [u8; 2] = [9, 9]
        write(sv[0], a as *u8, 3)
        write(sv[0], b as *u8, 2)
        let buf: [u8; 16] = [0; 16]
        print(read(sv[1], buf as *u8, 16))
        print(read(sv[1], buf as *u8, 16))
        let d = dup(sv[0])
        close(sv[0])
        write(d, a as *u8, 3)
        print(read(sv[1], buf as *u8, 16))
        let sp: [i32; 2] = [0; 2]
        socketpair(1, 1, 0, sp as *i32)
        let e = dup(sp[0])
        close(sp[0])
        write(e, a as *u8, 2)
        close(e)
        print(read(sp[1], buf as *u8, 16), " ", read(sp[1], buf as *u8, 16))
    }
}`);
  expect(r.out).toBe("0\n3\n2\n3\n2 0\n");
});

test("R-NET-POLL: poll reports a readable pipe at once, times out on virtual time when nothing is ready", () => {
  const r = runTasks(`${PIPE_IMPORTS}
extern fn poll(fds: *u8, nfds: u64, timeout: i32): i32
pub fn main() {
    unsafe {
        let fds: [i32; 2] = [0; 2]
        pipe(fds as *i32)
        let pf: [i32; 2] = [fds[0], 1]
        print(poll(pf as *u8, 1, 50))
        let msg: [u8; 1] = [1]
        write(fds[1], msg as *u8, 1)
        print(poll(pf as *u8, 1, 50), " ", (pf[1] >> 16) & 1)
    }
}`);
  expect(r.out).toBe("0\n1 1\n");
});

test("R-SELECT: the first ready arm wins, a timer arm fires on the virtual clock, a send makes a recv arm ready", () => {
  const r = runTasks(`
from "std/runtime" import { Task, schedulerRunToCompletion }
from "std/sync" import { Channel }
from "std/select" import { Select }
pub fn main() {
    let ch = Channel<i64>.new(1)!
    let tx = ch.clone()
    Task.spawn(move(): void => { tx.send(5)! })
    var s1 = Select.new()
    s1.onRecv(ch)
    s1.onTimeout(1000)
    print(s1.wait())
    print(ch.recv()!)
    var s2 = Select.new()
    s2.onRecv(ch)
    s2.onTimeout(30)
    print(s2.wait())
    schedulerRunToCompletion()
}`);
  expect(r.out).toBe("0\n5\n1\n");
});

const FIXTURES = [
  // R-NET-SOCK R-NET-ADDR: addresses, ports, families
  "socketBind", "tcpIpv6", "unixSocket", "netResolveAll",
  // R-NET-PIPE R-NET-SIG: descriptors and signals
  // R-FNPTR: function pointers called from C and held in structs
  "fnToPtr", "typedFnPtr",
  "sigpipeIgnored", "signalSigchld", "greenIoPipe", "fdWaitSharedFd",
  // The interpreter models kqueue, not epoll, so on Linux these two have no oracle yet.
  ...(process.platform === "darwin" ? ["eventLoop", "httpWorkers"] : []),
  // R-SELECT: waiting on several sources
  "selectChannelVsTimeout", "selectFdVsChannel",
  // R-NET-IO R-NET-BLOCK: a connection served and answered
  "ioSocketStream", "greenThreadEcho",
];
test("R-FNPTR, R-NET-SOCK, R-NET-PIPE, R-NET-SIG, R-NET-KQUEUE, R-SELECT: fixtures that use them are the same as the compiled run", async () => {
  const results = [];
  for (const name of FIXTURES) results.push(await compareOne({ path: join(import.meta.dir, "fixtures", `${name}.milo`), name, kind: "fixtures" }, dir));
  expect(results.filter(r => r.verdict !== "same").map(r => `${r.name}: ${r.verdict} ${r.detail}`)).toEqual([]);
}, 600_000);
