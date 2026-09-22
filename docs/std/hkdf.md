# std/hkdf

## std/hkdf

### `Hkdf.expandSha1`

```milo
fn Hkdf.expandSha1(prk: &string, info: &string, length: i64): Result<string>
```

HKDF-Expand with SHA-1. `length` may not exceed 255*20.

### `Hkdf.expandSha256`

```milo
fn Hkdf.expandSha256(prk: &string, info: &string, length: i64): Result<string>
```

HKDF-Expand with SHA-256. `length` is in bytes and may not exceed 255*32.
`info` binds the output to a purpose; pass "" only when there is exactly one.

### `Hkdf.expandSha512`

```milo
fn Hkdf.expandSha512(prk: &string, info: &string, length: i64): Result<string>
```

HKDF-Expand with SHA-512. `length` may not exceed 255*64.

### `Hkdf.extractSha1`

```milo
fn Hkdf.extractSha1(salt: &string, ikm: &string): string
```

HKDF-Extract with SHA-1: a 20-byte PRK. Present because RFC 5869's own test
vectors cover it and older protocols specify it; prefer the SHA-256 pair.

### `Hkdf.extractSha256`

```milo
fn Hkdf.extractSha256(salt: &string, ikm: &string): string
```

HKDF-Extract with SHA-256: a 32-byte pseudorandom key.

An empty `salt` is the RFC's default of HashLen zero bytes — HMAC zero-pads a
short key to the block size, so the two inputs produce the same PRK. A salt
need not be secret, and a random one is what makes the extract step provably
a randomness extractor rather than just a hash.

An empty `salt` is the RFC's default of HashLen zero bytes. A salt need not be
secret; a random one is what makes extract a randomness extractor rather than
just a hash.

### `Hkdf.extractSha512`

```milo
fn Hkdf.extractSha512(salt: &string, ikm: &string): string
```

HKDF-Extract with SHA-512: a 64-byte pseudorandom key.

### `Hkdf.sha1`

```milo
fn Hkdf.sha1(salt: &string, ikm: &string, info: &string, length: i64): Result<string>
```

Extract then expand, SHA-1.

### `Hkdf.sha256`

```milo
fn Hkdf.sha256(salt: &string, ikm: &string, info: &string, length: i64): Result<string>
```

Extract then expand, SHA-256. The usual entry point.

### `Hkdf.sha512`

```milo
fn Hkdf.sha512(salt: &string, ikm: &string, info: &string, length: i64): Result<string>
```

Extract then expand, SHA-512.
