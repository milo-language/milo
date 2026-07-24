// std/net TLS certificate verification.
//
// This exists because the client used to verify NOTHING. It called
// SSL_CTX_set_default_verify_paths (which loads the trust store) and stopped there —
// but an OpenSSL client defaults to SSL_VERIFY_NONE, so the trust store was never
// consulted and a self-signed cert handshook fine. Loading the CAs *looked* like
// verification. A MITM was undetectable.
//
// The trap in testing this: a "TLS works" test passes whether or not verification
// happens, so it proves nothing. Each case here pins a rejection, and the hostname case
// holds the chain VALID (own CA via SSL_CERT_FILE) so it can only fail on the hostname
// — otherwise SSL_VERIFY_PEER alone would make it pass and SSL_set1_host could rot.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const PORT = 18443;
let dir = "";
let haveOpenssl = true;
const servers: ChildProcess[] = [];

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "milo-tls-"));
  try { execFileSync("openssl", ["version"], { stdio: ["pipe", "pipe", "pipe"] }); }
  catch { haveOpenssl = false; return; }

  // Self-signed: fails chain validation.
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ss.key", "-out", "ss.pem",
    "-days", "1", "-nodes", "-subj", "/CN=goodhost"]);
  // Private CA + a cert for goodhost: chain VALID once SSL_CERT_FILE points at the CA.
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.pem",
    "-days", "1", "-nodes", "-subj", "/CN=Milo Test CA"]);
  sh("openssl", ["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr",
    "-nodes", "-subj", "/CN=goodhost"]);
  writeFileSync(join(dir, "san.cnf"), "subjectAltName=DNS:goodhost\n");
  sh("openssl", ["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "srv.pem", "-days", "1", "-extfile", "san.cnf"]);

  writeFileSync(join(dir, "probe.milo"), `from "std/net" import { NetError, ip4 }
from "std/fetch" import { TlsStream }

fn main() {
    let host = "__HOST__"
    match TlsStream.connect(ip4(127, 0, 0, 1), ${PORT}, host) {
        Result.Ok(_s) => { print("CONNECTED") }
        Result.Err(e) => {
            match e {
                NetError.TlsError(m) => { print("REJECTED " + m) }
                NetError.ConnectionFailed(m) => { print("CONNFAIL " + m) }
                NetError.DnsFailure(m) => { print("DNS " + m) }
                NetError.SendFailed(m) => { print("SEND " + m) }
                NetError.Other(m) => { print("OTHER " + m) }
            }
        }
    }
}
`);
}, 120000);

afterAll(() => {
  for (const s of servers) try { s.kill("SIGKILL"); } catch {}
  if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

async function serve(key: string, cert: string): Promise<void> {
  const p = spawn("openssl", ["s_server", "-quiet", "-key", key, "-cert", cert,
    "-accept", String(PORT), "-naccept", "1"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  servers.push(p);
  await new Promise(r => setTimeout(r, 800));
}

function probe(host: string, caFile?: string): string {
  const src = join(dir, "probe.milo");
  writeFileSync(src, execFileSync("cat", [src], { encoding: "utf-8" }).replace("__HOST__", host));
  const env = { ...process.env, ...(caFile ? { SSL_CERT_FILE: join(dir, caFile) } : {}) };
  const out = execFileSync("bun", ["run", MAIN, "run", src], { cwd: ROOT, encoding: "utf-8", env, stdio: ["pipe", "pipe", "pipe"] });
  writeFileSync(src, execFileSync("cat", [src], { encoding: "utf-8" }).replace(host, "__HOST__"));
  return out.trim();
}

test("a self-signed certificate is rejected", async () => {
  if (!haveOpenssl) return;
  await serve("ss.key", "ss.pem");
  expect(probe("goodhost")).toContain("REJECTED");
}, 120000);

// The positive control: without it, a client that rejected EVERYTHING would pass the
// test above and look correct.
test("a cert from a trusted CA with a matching hostname connects", async () => {
  if (!haveOpenssl) return;
  await serve("srv.key", "srv.pem");
  expect(probe("goodhost", "ca.pem")).toBe("CONNECTED");
}, 120000);

// Same cert, same trusted CA — only the expected hostname differs. Chain validity is
// held constant, so this can only be caught by the hostname check.
test("a valid chain with the wrong hostname is rejected", async () => {
  if (!haveOpenssl) return;
  await serve("srv.key", "srv.pem");
  expect(probe("evilhost", "ca.pem")).toContain("REJECTED");
}, 120000);
