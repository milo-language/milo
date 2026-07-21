# std/crypto

Cryptographic hashing and authenticated encryption, backed by the platform crypto library (CommonCrypto on macOS, OpenSSL on Linux).

```milo
from "std/crypto" import { sha256, sha1, md5, aesGcmEncrypt, aesGcmDecrypt }
```

For dependency-free, constant-time implementations and higher-level primitives, see the pure-Milo companions: [`std/sha256`](sha256), [`std/sha1`](sha1), [`std/hmac`](hmac), [`std/jwt`](jwt), [`std/totp`](totp), and [`std/base32`](base32).

## Hashing

### sha256

```milo
fn sha256(data: &string): string
```

SHA-256 of `data` as a 64-char lowercase hex string.

### sha1

```milo
fn sha1(data: &string): string
fn sha1Bytes(data: &string): string
```

SHA-1 as 40-char lowercase hex; `sha1Bytes` returns the raw 20-byte digest (for the WebSocket handshake, legacy protocols).

### md5

```milo
fn md5(data: &string): string
```

MD5 of `data` as a lowercase hex string.

```milo
let hash = sha256(&"hello world")
// "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
```

## AES-GCM

Authenticated encryption with a 256-bit key (`aesGcm*`) or 128-bit key (`aesGcm128*`). Every entry point returns a `Result`, so a wrong key/IV length or a failed authentication tag surfaces as an error instead of silent corruption.

```milo
struct AesGcmResult { ciphertext: string, tag: string }

fn aesGcmEncrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
fn aesGcmDecrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

- `key`: 32 bytes (256-bit); `iv`: 12 bytes. For AES-128 use `aesGcm128Encrypt` / `aesGcm128Decrypt` with a 16-byte key.
- `aad` is additional authenticated data — pass `&""` if unused.

```milo
let out = aesGcmEncrypt(&key, &iv, &"secret", &"")!
let plain = aesGcmDecrypt(&key, &iv, &out.ciphertext, &out.tag, &"")!
```
