// Gate: no safe public std API traffics in a raw file descriptor.
//
// A descriptor number is an i32, and an i32 is Copy: nothing stops it outliving the
// handle that owns it, after which it names whatever the kernel reused it for. The
// dapweb ws writer crash was exactly that (a task kept writing to a socket number its
// owner had closed). std's answer is owning handles (File, TcpStream, OwnedFd, Pty,
// Child, SignalPipe, ...) plus the `AsFd` trait for borrowing one, so every pub fn or
// method that still takes or returns a bare number must be `@unsafe` (the caller vouches
// for the lifetime) or sit in ALLOWED below with the reason it is safe anyway.
//
// The same holds for a public int field named like a descriptor on a pub struct: anyone
// could build the struct around a number and let its Drop close it.
//
// Detection is by name (fd, fooFd, sock, ...) and integer type, from the parsed AST of
// every std file, platform arms included. A name-based scan can rot silently, so the
// sentinel test below pins names it must keep recognizing.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import type { Function, MiloType, Program } from "../src/ast";

const STD = join(import.meta.dir, "..", "std");

// The only safe raw-fd entry points, each with why it may stay safe.
const ALLOWED: Record<string, string> = {
  // runtime.milo: byte offsets into the scheduler's node/task records, not descriptors.
  "nodeFd": "field offset constant (select node layout), not a descriptor",
  "sElFd": "field offset constant (scheduler layout), not a descriptor",
  "tWaitFd": "field offset constant (task layout), not a descriptor",
  "sSelFdHead": "field offset constant (scheduler layout), not a descriptor",
  // platform.linux.milo: the epoll_event layout event.linux fills in; plain data with no
  // methods or Drop, so a forged value does nothing until passed to an @unsafe call.
  "EpollEvent.dataFd": "epoll_event layout mirror, built by std/event.linux in another file",
};

// `wakeupId`: the event loop's wakeup handle, an eventfd on Linux.
const FD_PARAM = /^(fd|fds|sock|sockfd|socket|wakeupId)$|Fd$/;
// A function whose integer return is a descriptor: `fd`, `rawFd`, `acceptFdNb`, the
// descriptor-creating syscalls, `take` (TcpStream.take hands its fd over) and the
// event loop's wakeup handle.
const FD_RETURN = /(^fd$|Fd(?![a-z])|^(sys|replay)?(Open|Socket|Accept|Dup|open|socket|accept|dup|pipe)$|^take$|InitWakeup$)/;
const FD_FIELD = /^(fd|sock|sockFd|masterFd|kqfd|epfd)$|Fd$/;

function isInt(t: MiloType | null | undefined): boolean {
  if (!t || t.isPtr || t.isRef || t.isRefMut) return false;
  if (/^[iu](8|16|32|64)$/.test(t.name)) return true;
  // Result<i32, E> / Option<i32>: still a bare number once unwrapped.
  return (t.name === "Result" || t.name === "Option") && isInt(t.typeArgs?.[0]);
}

const isUnsafe = (f: Function) => (f.attributes ?? []).some(a => a.name === "unsafe");

export interface Violation { where: string; what: string }

export function rawFdViolations(files: { name: string; src: string }[]): { violations: Violation[]; seen: Set<string>; checked: number } {
  const violations: Violation[] = [];
  const seen = new Set<string>(); // every raw-fd API recognised, allowed or not
  let checked = 0;
  for (const { name, src } of files) {
    const prog: Program = new Parser(new Lexer(src).tokenize(), src).parse();
    const pubTypes = new Set([...prog.structs, ...prog.enums].filter((d: any) => d.isPub).map(d => d.name));
    const fns: { label: string; fn: Function }[] = [];
    for (const f of prog.functions) if (f.isPub && !f.isExtern) fns.push({ label: f.name, fn: f });
    for (const impl of prog.impls) {
      if (!pubTypes.has(impl.typeName)) continue;
      for (const m of impl.methods) fns.push({ label: `${impl.typeName}.${m.name}`, fn: m });
    }
    for (const { label, fn } of fns) {
      checked++;
      const bare = label.split(".").pop()!;
      const params = fn.params.filter(p => isInt(p.type) && FD_PARAM.test(p.name)).map(p => p.name);
      const returns = isInt(fn.retType) && FD_RETURN.test(bare);
      if (!params.length && !returns) continue;
      seen.add(label);
      if (isUnsafe(fn) || ALLOWED[label] || ALLOWED[bare]) continue;
      const what = [params.length ? `takes ${params.join(", ")}` : "", returns ? `returns ${fn.retType.name}` : ""].filter(Boolean).join(" and ");
      violations.push({ where: `${name}: ${label}`, what: `${what} — make it @unsafe, take a handle (&T: AsFd), or add it to ALLOWED with a reason` });
    }
    for (const s of prog.structs) {
      if (!(s as any).isPub) continue;
      for (const f of s.fields) {
        if (f.name.startsWith("_") || !isInt(f.type) || !FD_FIELD.test(f.name)) continue;
        checked++;
        const label = `${s.name}.${f.name}`;
        seen.add(label);
        if (ALLOWED[label]) continue;
        violations.push({ where: `${name}: ${label}`, what: `public descriptor field — name it _${f.name} so only its file can build or read it` });
      }
    }
  }
  return { violations, seen, checked };
}

function stdFiles() {
  return readdirSync(STD).filter(f => f.endsWith(".milo")).sort().map(f => ({ name: `std/${f}`, src: readFileSync(join(STD, f), "utf-8") }));
}

test("no safe pub std API takes or returns a raw descriptor", () => {
  const { violations, checked } = rawFdViolations(stdFiles());
  // A scan that stopped parsing would check nothing and pass forever.
  expect(checked).toBeGreaterThan(1000);
  expect(violations).toEqual([]);
});

test("the scan still recognises the raw-fd APIs it is meant to guard", () => {
  const { seen } = rawFdViolations(stdFiles());
  for (const name of ["sysClose", "readFd", "acceptFdNb", "sysSocket", "fdChannel", "OwnedFd.rawFd", "TcpStream.take",
    "Child.stdoutFd", "Pty.rawFd", "WsConn.view", "closeSocket", "schedulerWaitRead", "adoptFd", "fdReaderAttach",
    "eventLoopInitWakeup", "eventLoopCloseWakeup"]) {
    expect({ name, seen: seen.has(name) }).toEqual({ name, seen: true });
  }
});

test("every ALLOWED entry still names a raw-fd API (no stale exemptions)", () => {
  const { seen } = rawFdViolations(stdFiles());
  const bare = new Set([...seen].map(s => s.split(".").pop()!));
  for (const name of Object.keys(ALLOWED)) expect({ name, seen: seen.has(name) || bare.has(name) }).toEqual({ name, seen: true });
});

test("it fails on a safe raw-fd API, a raw-fd method and a public fd field", () => {
  const src = `
pub fn closeIt(fd: i32): i32 { return fd }
pub fn openIt(): i32 { return 3 }
pub struct Handle { fd: i32 }
impl Handle {
    fn rawFd(self: &Self): i32 { return self.fd }
    @unsafe
    fn fromRaw(fd: i32): Handle { return Handle { fd: fd } }
}
@unsafe
pub fn closeRaw(fd: i32): i32 { return fd }
fn privateRaw(fd: i32): i32 { return fd }
`;
  const { violations } = rawFdViolations([{ name: "synthetic.milo", src }]);
  expect(violations.map(v => v.where)).toEqual([
    "synthetic.milo: closeIt",
    "synthetic.milo: Handle.rawFd",
    "synthetic.milo: Handle.fd",
  ]);
});
