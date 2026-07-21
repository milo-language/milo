# std/jwt

## std/jwt

### `jwtSignHS256`

```milo
fn jwtSignHS256(payload: &string, secret: &string): string
```

Sign a JSON payload string with HS256, returning a compact JWS.

### `jwtVerifyHS256`

```milo
fn jwtVerifyHS256(token: &string, secret: &string): bool
```

Verify a compact HS256 JWS against the secret. Returns true iff the token has the
exact header.payload.signature shape and the signature matches.
