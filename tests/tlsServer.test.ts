// TLS *server* support: std/tls's TlsListener + std/https's serveTls/serveRouterTls.
//
// Modelled on tlsVerify.test.ts, and it carries the same trap: a "TLS works" test passes
// whether or not verification happens. Case 1 makes curl the independent oracle (a real
// client, not ours, completing a real handshake against our server), and case 3 holds the
// server constant while removing only the client's trust in the private CA — without it,
// case 2 could pass with verification disabled and prove nothing.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const PORT_SERVE = 18441;
const PORT_ROUTER = 18442;
let dir = "";
// Probed at module load, not in beforeAll: test.skipIf() is evaluated when the file is
// read, so a flag set later would always read as "openssl present" and the cases would
// run and fail instead of skipping.
const haveOpenssl = (() => {
  try { execFileSync("openssl", ["version"], { stdio: ["pipe", "pipe", "pipe"] }); return true; }
  catch { return false; }
})();
const servers: ChildProcess[] = [];

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
}

// Build once, run many: `milo run` on each probe would recompile std every time.
function build(name: string, src: string): string {
  const file = join(dir, `${name}.milo`);
  const out = join(dir, name);
  writeFileSync(file, src);
  execFileSync("bun", ["run", MAIN, "build", file, "-o", out],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

function startServer(bin: string): Promise<void> {
  const p = spawn(bin, [], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  servers.push(p);
  return new Promise(r => setTimeout(r, 900));
}

const SERVE_SRC = `from "std/https" import { serveTls }
from "std/http" import { Request, Response }

fn handle(req: &Request): Response {
    if req.path == "/hello" {
        return Response.Text("hello from milo tls")
    }
    return Response.NotFound
}

fn main() {
    let r = serveTls(Option.Some(${PORT_SERVE} as u16), "srv.pem", "srv.key", handle)
    if let Result.Err(m) = r {
        print("server error: " + m)
    }
}
`;

const ROUTER_SRC = `from "std/https" import { serveRouterTls }
from "std/http" import { Context, Router }

fn main() {
    var router = Router.new()
    router.get("/greet/:name", (c: &mut Context) => {
        return c.text("hi " + (c.param("name") ?? "?"))
    })
    let r = serveRouterTls(Option.Some(${PORT_ROUTER} as u16), "srv.pem", "srv.key", router)
    if let Result.Err(m) = r {
        print("server error: " + m)
    }
}
`;

// __CA__ is substituted per probe: "ca.pem" trusts our private CA, "" falls back to the
// system trust store (which must NOT contain it).
const CLIENT_SRC = `from "std/net" import { NetError, ip4 }
from "std/fetch" import { TlsStream }

fn main() {
    match TlsStream.connectWithCA(ip4(127, 0, 0, 1), ${PORT_SERVE}, "localhost", "__CA__") {
        Result.Ok(s) => {
            let _n = s.send("GET /hello HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n")
            print("CONNECTED " + s.recv()!)
        }
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
`;

let clientTrusting = "";
let clientUntrusting = "";

beforeAll(async () => {
  if (!haveOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), "milo-tlssrv-"));

  // Private CA + a server cert for localhost. subjectAltName is not optional: modern
  // clients (curl, OpenSSL's SSL_set1_host) ignore CN entirely.
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.pem",
    "-days", "1", "-nodes", "-subj", "/CN=Milo Test Server CA"]);
  sh("openssl", ["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr",
    "-nodes", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "san.cnf"), "subjectAltName=DNS:localhost\n");
  sh("openssl", ["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "srv.pem", "-days", "1", "-extfile", "san.cnf"]);

  await startServer(build("serve", SERVE_SRC));
  await startServer(build("router", ROUTER_SRC));
  clientTrusting = build("client_ca", CLIENT_SRC.replace("__CA__", join(dir, "ca.pem")));
  clientUntrusting = build("client_noca", CLIENT_SRC.replace("__CA__", ""));
}, 300000);

afterAll(() => {
  for (const s of servers) try { s.kill("SIGKILL"); } catch {}
  if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

function curl(args: string[]): string {
  return execFileSync("curl", ["-sS", ...args], { cwd: dir, encoding: "utf-8" });
}

// The independent oracle: curl is not our code, so a body coming back through it proves
// the handshake and the record layer are real, not that our client agrees with our server.
//
// skipIf, not an early `return`: a missing openssl would otherwise make all four cases
// report PASS while asserting nothing — a green gate that ran no input.
test.skipIf(!haveOpenssl)("curl completes a real handshake against a Milo serveTls server", () => {
  expect(curl(["--cacert", "ca.pem", `https://localhost:${PORT_SERVE}/hello`]))
    .toBe("hello from milo tls");
}, 120000);

test.skipIf(!haveOpenssl)("a Milo client trusting the same CA connects and gets the body", () => {
  const out = execFileSync(clientTrusting, [], { cwd: dir, encoding: "utf-8" });
  expect(out).toContain("CONNECTED");
  expect(out).toContain("hello from milo tls");
}, 120000);

// The control for the case above. Same server, same cert — only the client's trust in
// the private CA is removed, so this can fail on nothing but certificate verification.
test.skipIf(!haveOpenssl)("without the CA the same server is rejected — verification still bites", () => {
  const out = execFileSync(clientUntrusting, [], { cwd: dir, encoding: "utf-8" });
  expect(out).toContain("REJECTED");
  expect(out).not.toContain("CONNECTED");
}, 120000);

test.skipIf(!haveOpenssl)("serveRouterTls routes a parameterised path", () => {
  expect(curl(["--cacert", "ca.pem", `https://localhost:${PORT_ROUTER}/greet/milo`]))
    .toBe("hi milo");
}, 120000);

// incoming() consumes the stream and its pump owns the SSL state. Opening the channel in
// a helper is the shape that used to free the SSL under the pump (the stream dropped
// when the helper returned): it printed an empty body, or crashed under Guard Malloc.
const INCOMING_SRC = `from "std/net" import { ip4 }
from "std/fetch" import { TlsStream }
from "std/sync" import { Channel }

fn open(): Channel<string> {
    let s = TlsStream.connectWithCA(ip4(127, 0, 0, 1), ${PORT_SERVE}, "localhost", "ca.pem")!
    let _n = s.send("GET /hello HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n")!
    return s.incoming()
}

fn main() {
    var ch = open()
    var body = ""
    for chunk in ch {
        body = body + chunk
    }
    print("BODY " + body)
}
`;

test.skipIf(!haveOpenssl)("incoming() keeps the TLS state alive after the stream's scope ends", () => {
  const bin = build("client_incoming", INCOMING_SRC);
  const out = execFileSync(bin, [], { cwd: dir, encoding: "utf-8" });
  expect(out).toContain("hello from milo tls");
}, 120000);
