# std/sha1

Pure-Milo SHA-1 (FIPS 180-4) — no platform crypto dependency. Same constant-time, fixed-round shape as [`std/sha256`](sha256).

> SHA-1 is broken for collision resistance — do **not** use it for signatures or adversarial dedup. It remains the content-address of git objects and the digest in the WebSocket handshake and legacy TLS, which is what a pure-Milo implementation is for.

```milo
from "std/sha1" import { sha1, sha1Bytes }
```

## Functions

### sha1

```milo
fn sha1(input: &string): string
```

SHA-1 digest as a 40-char lowercase hex string.

### sha1Bytes

```milo
fn sha1Bytes(input: &string): string
```

SHA-1 digest as 20 raw bytes (for HMAC-SHA1 and the WebSocket handshake).
