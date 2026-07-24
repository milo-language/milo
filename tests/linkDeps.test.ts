// Runtime link dependencies of built binaries.
//
// detectLibs() greps pre-optimization IR, which over-approximates: std/os declares the
// TLS externs and defines wrappers around them, and every program using std/io imports
// std/os transitively. So `wc` used to link OpenSSL despite needing zero SSL symbols --
// baking a hard load command on a Homebrew-only absolute path into every binary, which
// fails at dyld startup on any machine without openssl@3. The linker drops unneeded
// libraries now (-dead_strip_dylibs / --as-needed); these tests keep it that way.
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const isDarwin = process.platform === "darwin";

// Load commands (what the loader demands at startup) -- deliberately NOT the same
// question as `nm -u` (symbols the code references). The bug lived in the gap.
function loadedLibs(bin: string): string {
  const cmd = isDarwin ? `otool -L ${bin}` : `ldd ${bin}`;
  return execSync(cmd, { encoding: "utf-8" });
}

function build(name: string, src: string, flags = ""): string {
  const out = join(tmpdir(), `milo_linkdeps_${name}_${process.pid}`);
  const file = `${out}.milo`;
  writeFileSync(file, src);
  try {
    execSync(`bun run ${COMPILER} build ${file} -o ${out} ${flags}`, { stdio: "pipe" });
  } finally {
    try { unlinkSync(file); } catch {}
  }
  return out;
}

// Must import std/io, not just use prelude print: std/io is what drags in std/os and
// therefore the TLS extern declarations. A prelude-only program never triggers the bug,
// so testing one would pass whether or not the fix is present.
const PLAIN = `from "std/io" import { readFile }
fn main(): i32 {
    print("hi")
    return 0
}
`;

const TLS = `from "std/net" import { resolve }
from "std/fetch" import { TlsStream }
fn main(): i32 {
    let ip = resolve("example.com")!
    let s = TlsStream.connect(ip, 443, "example.com")!
    print(s.recv()!.len.toString())
    return 0
}
`;

test("a program that does not use TLS does not link OpenSSL", () => {
  const bin = build("plain", PLAIN);
  try {
    const libs = loadedLibs(bin);
    expect(libs).not.toContain("libssl");
    expect(libs).not.toContain("libcrypto");
    // The whole point: nothing from a package manager prefix leaks into a plain binary.
    expect(libs).not.toContain("/opt/homebrew");
  } finally {
    try { unlinkSync(bin); } catch {}
  }
});

test("a program that does use TLS still links OpenSSL", () => {
  // Guards the opposite failure: dropping libs so aggressively that real users break.
  const bin = build("tls", TLS);
  try {
    expect(loadedLibs(bin)).toContain("libssl");
  } finally {
    try { unlinkSync(bin); } catch {}
  }
});

// The Windows counterpart of the OpenSSL dead-strip tests, but a HARD link check,
// not a load-command inspection: the xwin sysroot ships no OpenSSL, so if a plain-TCP
// program still referenced any SSL_* symbol it would fail to link entirely (undefined
// symbol), not merely bake a stray load command. This is exactly why TlsStream + the
// fetch client moved from std/net to std/fetch. lld-link + MILO_WINDOWS_SDK required.
const WIN_SDK = process.env.MILO_WINDOWS_SDK;
function hasLldLink(): boolean {
  try { execSync("command -v lld-link", { stdio: "pipe" }); return true; } catch { return false; }
}
function buildWin(name: string, src: string): { ok: boolean; log: string } {
  const out = join(tmpdir(), `milo_winlink_${name}_${process.pid}.exe`);
  const file = join(tmpdir(), `milo_winlink_${name}_${process.pid}.milo`);
  writeFileSync(file, src);
  try {
    const log = execSync(`bun run ${COMPILER} build ${file} --target=windows-x64 -o ${out}`,
      { encoding: "utf-8", stdio: "pipe" });
    return { ok: true, log };
  } catch (e: any) {
    return { ok: false, log: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  } finally {
    try { unlinkSync(file); } catch {}
    try { unlinkSync(out); } catch {}
  }
}

const WIN_PLAIN = `from "std/net" import { TcpStream, TcpListener, resolve, ip4 }
fn main(): i32 {
    print(ip4(127, 0, 0, 1).toString())
    return 0
}
`;

test.skipIf(!WIN_SDK || !hasLldLink())(
  "a plain-TCP program links for Windows without OpenSSL (std/net carries no SSL)",
  () => {
    const r = buildWin("plain", WIN_PLAIN);
    // A regression (TLS coupled back into std/net) surfaces here as undefined SSL_* symbols.
    expect(r.log).not.toContain("undefined symbol: SSL");
    expect(r.ok).toBe(true);
  },
);

test.skipIf(!WIN_SDK || !hasLldLink())(
  "a TLS program still fails to link for Windows on OpenSSL symbols (xwin ships none)",
  () => {
    // The complementary guard: proves the plain-program success above is real dead-code
    // separation, not the linker silently satisfying SSL_* from somewhere.
    const r = buildWin("tls", TLS);
    expect(r.ok).toBe(false);
    expect(r.log).toContain("undefined symbol: ");
    expect(r.log).toMatch(/SSL_|TLS_client_method/);
  },
);

test.skipIf(!isDarwin || !existsSync("/opt/homebrew/opt/openssl@3/lib/libssl.a"))(
  "--static-deps produces a binary with no OpenSSL load command",
  () => {
    const bin = build("static", TLS, "--static-deps");
    try {
      const libs = loadedLibs(bin);
      expect(libs).not.toContain("libssl");
      expect(libs).not.toContain("/opt/homebrew");
    } finally {
      try { unlinkSync(bin); } catch {}
    }
  },
);
