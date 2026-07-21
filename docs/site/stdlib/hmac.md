# std/hmac

HMAC (RFC 2104 / FIPS 198-1) over the pure-Milo SHA-256 and SHA-1. The key is normalized to the 64-byte block (hashed if longer, zero-padded otherwise). Used for JWT (HS256), AWS SigV4, webhook signatures, and TOTP.

```milo
from "std/hmac" import { hmacSha256, hmacSha256Bytes, hmacSha1Bytes }
```

## Functions

### hmacSha256

```milo
fn hmacSha256(key: &string, msg: &string): string
```

HMAC-SHA256 as a 64-char lowercase hex string.

### hmacSha256Bytes

```milo
fn hmacSha256Bytes(key: &string, msg: &string): string
```

HMAC-SHA256 as 32 raw digest bytes (no hex round-trip when feeding further bytes).

### hmacSha1Bytes

```milo
fn hmacSha1Bytes(key: &string, msg: &string): string
```

HMAC-SHA1 as 20 raw digest bytes. Needed by HOTP/TOTP ([`std/totp`](totp)), which are specified on HMAC-SHA1.
