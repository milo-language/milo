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

const TLS = `from "std/net" import { TlsStream, resolve }
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
