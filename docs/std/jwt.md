# std/jwt

## std/jwt

### `constEq`

```milo
fn constEq(a: &string, b: &string): bool
```

Byte-for-byte string equality that does not short-circuit on the first mismatch,
so verification does not leak where a forged signature diverges.

### `hs256Header`

```milo
fn hs256Header(): string
```

Fixed compact header for HS256; matches the {"alg":"HS256","typ":"JWT"} that
mainstream libraries emit, so signatures line up byte-for-byte. A function rather
than a module-scope `let` because Milo disallows runtime global initializers.

### `jwtSignHS256`

```milo
pub fn jwtSignHS256(payload: &string, secret: &string): string
```

Sign a JSON payload string with HS256, returning a compact JWS.

### `jwtVerifyHS256`

```milo
pub fn jwtVerifyHS256(token: &string, secret: &string): bool
```

Verify a compact HS256 JWS against the secret. Returns true iff the token has the
exact header.payload.signature shape and the signature matches.

### `signingInput`

```milo
fn signingInput(payload: &string): string
```

_Undocumented._
