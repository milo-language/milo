// Concurrent TLS reads on green tasks must each get their whole body.
//
// OpenSSL's error queue is per OS thread and every green task shares that thread. A
// failed handshake on one connection leaves entries in it; when another task's
// SSL_read then hits WANT_READ, SSL_get_error saw the stale entry, reported a fatal
// error, and that body ended early at whatever record boundary it had reached. Live
// fetches of Caltrans' feeds came back truncated this way (there the entries come from
// peers that close without close_notify). Here a green task keeps a stale entry on the
// queue the whole time, by failing to load a missing CA file between every park.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const BODY_BYTES = 300_000;
let dir = "";
let server: ReturnType<typeof Bun.serve> | null = null;
const haveOpenssl = (() => {
  try { execFileSync("openssl", ["version"], { stdio: ["pipe", "pipe", "pipe"] }); return true; }
  catch { return false; }
})();

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
}

beforeAll(() => {
  if (!haveOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), "milo-tlsconc-"));
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key", "-out", "ca.pem",
    "-days", "1", "-nodes", "-subj", "/CN=Milo Test CA"]);
  sh("openssl", ["req", "-newkey", "rsa:2048", "-keyout", "srv.key", "-out", "srv.csr",
    "-nodes", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  sh("openssl", ["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "srv.pem", "-days", "1", "-extfile", "ext.cnf"]);
  const body = "x".repeat(BODY_BYTES - 1) + "!";
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: readFileSync(join(dir, "srv.pem")), key: readFileSync(join(dir, "srv.key")) },
    // Trickled out, so every client parks on WANT_READ many times mid-body.
    fetch() {
      const stream = new ReadableStream({
        async start(c) {
          for (let i = 0; i < body.length; i += 16384) {
            c.enqueue(new TextEncoder().encode(body.slice(i, i + 16384)));
            await Bun.sleep(5);
          }
          c.close();
        },
      });
      return new Response(stream, { headers: { "Content-Length": String(body.length), Connection: "close" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!haveOpenssl)("six concurrent TLS reads each get the whole body", async () => {
  const port = server!.port;
  const src = `from "std/fetch" import { TlsStream }
from "std/net" import { ip4 }
from "std/runtime" import { Task }
from "std/sync" import { Channel }
from "std/openssl" import { TLS_client_method, SSL_CTX_new, SSL_CTX_free, SSL_CTX_load_verify_locations }
from "std/time" import { sleepMs }

var reading: i64 = 6

// Leaves an error on this OS thread's OpenSSL queue, which every green task shares.
fn poison(): void {
    unsafe {
        let ctx = SSL_CTX_new(TLS_client_method())
        SSL_CTX_load_verify_locations(ctx, "/nonexistent/ca.pem", 0 as *u8)
        SSL_CTX_free(ctx)
    }
}

fn get(ca: string): string {
    match TlsStream.connectWithCA(ip4(127, 0, 0, 1), ${port} as u16, "localhost", ca) {
        Result.Ok(s) => {
            let _ = s.send("GET / HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n")
            let raw = s.recv() ?? ""
            let Option.Some(i) = raw.indexOf("\\r\\n\\r\\n") else {
                return "no header end"
            }
            // Bun sends the stream chunked, so count body characters, not bytes.
            var n: i64 = 0
            for j in i + 4..raw.len {
                if raw[j] == 'x' || raw[j] == '!' {
                    n += 1
                }
            }
            return n.toString()
        }
        Result.Err(_e) => {
            return "handshake failed"
        }
    }
}

pub fn main(): i32 {
    let done = Channel<string>.new(16)!
    for _i in 0..6 {
        let ch = done.clone()
        Task.spawn(move(): void => {
            let _ = ch.send(get("${join(dir, "ca.pem")}"))
            reading -= 1
        })
    }
    Task.spawn(move(): void => {
        while reading > 0 {
            poison()
            sleepMs(1)
        }
    })
    for _i in 0..6 {
        print(done.recv()!)
    }
    return 0
}
`;
  const file = join(dir, "conc.milo");
  const out = join(dir, "conc");
  writeFileSync(file, src);
  execFileSync("bun", ["run", MAIN, "build", file, "-o", out], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  for (let run = 0; run < 3; run++) {
    // Async: the HTTPS server lives in this process's event loop, which a sync spawn
    // would block, and the clients would wait on it forever.
    const p = Bun.spawn([out], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    await p.exited;
    const lines = text.trim().split("\n").sort();
    expect(lines).toEqual(Array(6).fill(String(BODY_BYTES)));
  }
}, 120000);
