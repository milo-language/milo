// std/webpush checked by an implementation that is not ours: WebCrypto (Bun's, i.e.
// BoringSSL) verifies the ES256 signature on a VAPID JWT, and decrypts a message that
// WebPush.encrypt made under a random sender key and salt, playing the browser with a
// receiver key pair generated here. The RFC 8291 known-answer test is the fixture
// tests/fixtures/webpushRfc8291.milo; this covers the paths with fresh randomness, which
// a fixed expected output cannot.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
// std/webpush links OpenSSL's libcrypto, which a Windows build has no copy of.
const SKIP = process.platform === "win32";
let dir = "";
let bin = "";

const SRC = `from "std/webpush" import { WebPush, VapidKeys }
from "std/args" import { args }

fn main(): i32 {
    let argv = args()
    let keys = VapidKeys.generate()!
    print(keys.publicKey)
    print(WebPush.vapid("https://push.example.net:8443/send/xyz", "mailto:ops@example.com", keys, 1791813600)!)
    let again = VapidKeys.fromPrivate(keys.privateKey)!
    print(again.publicKey)
    print(Base64.urlEncode(WebPush.encrypt(argv[3], argv[1], argv[2])!))
    return 0
}
`.replace(`from "std/args" import { args }`, `from "std/args" import { args }\nfrom "std/base64" import { Base64 }`);

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

beforeAll(() => {
  if (SKIP) return;
  dir = mkdtempSync(join(tmpdir(), "milo-webpush-"));
  writeFileSync(join(dir, "wp.milo"), SRC);
  bin = join(dir, "wp");
  execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build", join(dir, "wp.milo"), "-o", bin], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
}, 120000);

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// WebCrypto takes BufferSource, which since TS 5.7 excludes a SharedArrayBuffer-backed view.
type Bytes = Uint8Array<ArrayBuffer>;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

test.skipIf(SKIP)("VAPID JWT verifies under WebCrypto, and encrypt decrypts as a browser would", async () => {
  // The browser's side: a P-256 key pair and a 16-byte auth secret.
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const message = "breaking: milo ships web push";
  const out = execFileSync(bin, [b64u(uaPublic), b64u(auth), message], { encoding: "utf-8" }).trim().split("\n");
  const [publicKey, header, derived, body] = out as [string, string, string, string];

  expect(derived).toBe(publicKey);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  expect(m).not.toBeNull();
  expect(m[4]).toBe(publicKey);
  expect(JSON.parse(Buffer.from(m[1]!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
  expect(JSON.parse(Buffer.from(m[2]!, "base64url").toString()))
    .toEqual({ aud: "https://push.example.net:8443", exp: 1791813600, sub: "mailto:ops@example.com" });
  const vapidKey = await crypto.subtle.importKey("raw", unb64u(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${m[1]}.${m[2]}`);
  const sig = unb64u(m[3]!);
  expect(sig.length).toBe(64);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidKey, sig, signed)).toBe(true);
  // The control: one flipped bit in the signed bytes must not verify.
  const tampered = new Uint8Array(signed); tampered[0] ^= 1;
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidKey, sig, tampered)).toBe(false);

  // RFC 8291 decryption, step by step, from the aes128gcm header.
  const msg = unb64u(body);
  const salt = msg.slice(0, 16);
  const rs = new DataView(msg.buffer, msg.byteOffset + 16, 4).getUint32(0);
  const idlen = msg[20]!;
  const asPublic = msg.slice(21, 21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const keyInfo = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, msg.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2);
  expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(message);
}, 120000);
