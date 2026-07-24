// Audit every `extern fn` in std/ against the real C headers — no annotations needed.
//
// `@cSig` verifies a signature exactly, but it's opt-in and you must write the C
// signature by hand. This checks the one thing that needs no signature: `sizeof(f(0,0))`
// is unevaluated and yields C's actual return type, and the Milo declaration already
// supplies the arity and the claimed width. So every extern fn whose return is a scalar
// gets its width and signedness checked for free.
//
// Scope, stated plainly:
//   - HOST ONLY. It reads this machine's headers, so on macOS it says nothing about
//     std/*.linux.milo or std/*.windows.milo (and so on). CI runs it on all three.
//   - Return types only. Parameters need a C parser (see @cSig's docs).
//   - Skips pointer/void returns (no width is claimed) and any fn the headers below
//     don't declare. openssl/sqlite3/mach/CommonCrypto are probed and used when present;
//     when they're missing those decls stay unchecked (and say so) rather than fail.
//
// Usage: bun run scripts/audit-extern-returns.ts
// Exits non-zero if any declaration disagrees with C.
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const SIZES: Record<string, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, f32: 4, f64: 8, bool: 1 };
const SIGNED = new Set(["i8", "i16", "i32", "i64"]);
const UNSIGNED = new Set(["u8", "u16", "u32", "u64"]);

// Enough of libc to declare most of what std binds. A fn missing from these is skipped,
// not reported — see the "undeclared" guard below. Each header is probed individually
// and dropped if absent, so listing POSIX and Windows headers together is safe: the
// POSIX ones vanish on Windows and vice versa. Order still matters where it's kept —
// winsock2.h must precede ws2tcpip.h (they use types only winsock2.h declares), so it
// is listed first here and the probe filter preserves array order.
const HEADERS = ["stdio.h", "stdlib.h", "string.h", "time.h", "errno.h", "math.h", "signal.h",
  // POSIX
  "unistd.h", "fcntl.h", "dirent.h", "pthread.h", "sys/stat.h", "sys/mman.h", "sys/time.h",
  "sys/socket.h", "sys/resource.h", "sys/wait.h", "netinet/in.h", "arpa/inet.h", "netdb.h",
  "termios.h", "poll.h", "spawn.h", "sys/ioctl.h", "regex.h", "sys/sysctl.h", "sys/utsname.h",
  "pwd.h", "grp.h", "libgen.h", "sys/select.h", "sys/uio.h",
  // Windows (UCRT + SDK): io.h holds _read/_write/_open/_close/_lseeki64/_access;
  // process.h _getpid; winsock2.h the socket layer; libloaderapi.h LoadLibrary/GetProcAddress.
  "winsock2.h", "ws2tcpip.h", "afunix.h", "io.h", "process.h", "direct.h", "windows.h", "libloaderapi.h"];

// Non-libc bindings: hand-written, so likelier to drift than libc, but their headers
// aren't guaranteed present. Each group is probed once and used only if it compiles —
// a missing openssl just means those decls stay skipped, not a broken audit.
const OPTIONAL: { name: string; headers: string[]; flags: string }[] = [
  { name: "openssl", headers: ["openssl/ssl.h", "openssl/evp.h", "openssl/err.h"], flags: opensslInclude() },
  { name: "sqlite3", headers: ["sqlite3.h"], flags: "" },
  { name: "mach", headers: ["mach/mach.h", "mach/mach_host.h"], flags: "" },
  { name: "commoncrypto", headers: ["CommonCrypto/CommonCrypto.h", "CommonCrypto/CommonCryptor.h"], flags: "" },
  // Linux-only. These must be probed, not unconditional: <sys/epoll.h> doesn't exist on
  // macOS, and one missing include fails every compile — skipping the whole audit rather
  // than one group.
  { name: "linux-event", headers: ["sys/epoll.h", "sys/eventfd.h", "sys/inotify.h"], flags: "" },
];

function opensslInclude(): string {
  for (const p of ["/opt/homebrew/opt/openssl@3.6", "/opt/homebrew/opt/openssl@3", "/opt/homebrew/opt/openssl", "/usr/local/opt/openssl@3", "/usr"]) {
    try { if (readFileSync(`${p}/include/openssl/ssl.h`)) return `-I${p}/include`; } catch {}
  }
  return "";
}

type Decl = { name: string; arity: number; ret: string; file: string };

// std splits platform code by filename suffix (platform.darwin.milo / platform.linux.milo)
// and the resolver picks per host. The audit must too: checking a darwin-only decl against
// glibc is meaningless, and worse than meaningless when the name exists on both with
// different signatures (`sysctl`) — that reports drift where there is none.
function isForeignPlatform(file: string): boolean {
  const m = file.match(/\.(darwin|linux|windows)\.milo$/);
  if (!m) return false;
  const host = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return m[1] !== host;
}

function declsFrom(dir: string): Decl[] {
  const out: Decl[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".milo")) continue;
    if (isForeignPlatform(f)) continue;
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      // `pub` is optional on a decl (visibility); an extern may be written either way.
      const m = line.match(/^(?:pub )?extern fn ([A-Za-z_0-9]+)\((.*)\):\s*(.+?)\s*$/);
      if (!m) continue;
      const [, name, params, ret] = m;
      const inner = params!.replace(/,?\s*\.\.\./, "").trim();
      out.push({ name: name!, arity: inner === "" ? 0 : inner.split(",").length, ret: ret!, file: f });
    }
  }
  return out;
}

const tmpC = join(tmpdir(), `milo_audit_${crypto.randomUUID().slice(0, 8)}.c`);
const findings: string[] = [];
let checked = 0, skipped = 0;

// `cc` is the POSIX spelling; the Windows CI runner has clang (choco llvm) and no `cc`.
// Pick whichever answers, so this one script covers all three platforms.
function detectCC(): string {
  for (const c of ["cc", "clang"]) {
    try {
      writeFileSync(tmpC, "int main(void){return 0;}\n");
      execSync(`${c} -fsyntax-only ${tmpC}`, { stdio: ["pipe", "pipe", "pipe"] });
      return c;
    } catch {}
  }
  return "";
}
const CC = detectCC();

// Every check here IS a compile, so no compiler means nothing is verified. Without this
// probe that failure is invisible: each decl's compile throws, none of the errors match
// the "undeclared" patterns, and every one falls through to `skipped` — so the audit
// reports "checked 0" and exits 0. A green run that verified nothing is worse than a red
// one. (Found by running this in a bun container, which ships no cc.)
if (!CC) {
  console.error("error: no C compiler on PATH (tried `cc`, `clang`) — this audit is nothing but compiles, so it can verify nothing without one");
  try { unlinkSync(tmpC); } catch {}
  process.exit(2);
}

// Probe each optional group once rather than per-decl.
const available: { headers: string[]; flags: string }[] = [];
for (const g of OPTIONAL) {
  writeFileSync(tmpC, g.headers.map(h => `#include <${h}>`).join("\n") + "\nint main(void){return 0;}\n");
  try {
    execSync(`${CC} -fsyntax-only ${g.flags} ${tmpC}`, { stdio: ["pipe", "pipe", "pipe"] });
    available.push({ headers: g.headers, flags: g.flags });
  } catch { console.log(`note: ${g.name} headers not found — its decls stay unchecked`); }
}
const allFlags = available.map(g => g.flags).filter(Boolean).join(" ");

// Probe the base headers individually and keep only what this host actually has. One
// missing header fails EVERY compile — and since a failed compile just marks the decl
// "skipped", that silently reduces the audit to checking nothing while still exiting 0.
// That's exactly what `sys/sysctl.h` did on Linux (glibc dropped it in 2.32), and what
// a hardcoded per-platform list would keep doing every time an OS moves a header.
// Probing beats maintaining the list.
const allHeaders = [...HEADERS, ...available.flatMap(g => g.headers)].filter(h => {
  writeFileSync(tmpC, `#include <${h}>\n`);
  try { execSync(`${CC} -fsyntax-only ${allFlags} ${tmpC}`, { stdio: ["pipe", "pipe", "pipe"] }); return true; }
  catch { return false; }
});

try {
  for (const d of declsFrom("std")) {
    const size = SIZES[d.ret];
    if (size === undefined) { skipped++; continue; }  // pointer/void/struct return: no width claimed
    const args = Array(d.arity).fill("0").join(", ");
    // Opaque handles (Win32 HANDLE/LPVOID, returned by CreateThread/CreateFiber) are held
    // as i64 on the Milo side — a pointer, deliberately, not an integer. WIDTH still holds
    // (pointer == 8 == i64) so a genuinely wrong width like i32 is still caught, but the
    // SIGN check on a pointer would report drift where there is none. `__builtin_classify_type`
    // returns 5 for a pointer; guard the sign asserts to pass on that.
    const notPtr = `__builtin_classify_type(${d.name}(${args})) != 5`;
    const src = [
      ...allHeaders.map(h => `#include <${h}>`),
      `_Static_assert(sizeof(${d.name}(${args})) == ${size}, "WIDTH");`,
      SIGNED.has(d.ret) ? `_Static_assert(!(${notPtr}) || (__typeof__(${d.name}(${args})))-1 < 0, "SIGN");` : "",
      UNSIGNED.has(d.ret) ? `_Static_assert(!(${notPtr}) || (__typeof__(${d.name}(${args})))-1 > 0, "SIGN");` : "",
    ].filter(Boolean).join("\n");
    writeFileSync(tmpC, src + "\n");
    try {
      execSync(`${CC} -fsyntax-only ${allFlags} ${tmpC}`, { stdio: ["pipe", "pipe", "pipe"] });
      checked++;
    } catch (e: any) {
      const err = e.stderr?.toString() ?? "";
      // An undeclared fn still "compiles": C assumes it returns int, so the width assert
      // fails too — a finding about a function these headers never declared. Likewise a
      // wrong arity guess. Neither is drift; skip rather than invent a bug.
      if (/undeclared function|undeclared identifier|implicit declaration|too few arguments|too many arguments/.test(err)) { skipped++; continue; }
      // Only a real assert failure counts. clang echoes the offending source line, which
      // contains the literal "WIDTH"/"SIGN", so testing the whole stderr for those
      // strings matches unrelated errors and invents findings.
      const failed = err.split("\n").filter((l: string) => l.includes("static assertion failed"));
      if (failed.some((l: string) => l.includes("WIDTH"))) findings.push(`${d.file}: ${d.name} — Milo returns ${d.ret} (${size}B), C's return is a different width`);
      else if (failed.some((l: string) => l.includes("SIGN"))) findings.push(`${d.file}: ${d.name} — Milo declares ${SIGNED.has(d.ret) ? "signed" : "unsigned"} ${d.ret}, C disagrees`);
      else { skipped++; continue; }
      checked++;
    }
  }
} finally {
  try { unlinkSync(tmpC); } catch {}
}

console.log(`checked ${checked} extern fn return types against this host's headers (${skipped} skipped: pointer/void return, or not declared by the headers above)`);
for (const f of findings) console.log(`  ${f}`);
// "Everything skipped" is indistinguishable from "everything passed" in the exit code,
// and std always has scalar-returning externs — so zero means the audit broke, not that
// the code is clean.
if (checked === 0) {
  console.error(`\nerror: verified nothing — every declaration was skipped. The audit is broken, not the code.`);
  process.exit(2);
}
if (findings.length) {
  console.log(`\n${findings.length} declaration(s) disagree with C. Add @cSig to pin the signature — see docs/language-reference.md.`);
  process.exit(1);
}
