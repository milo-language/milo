# std/totp

## std/totp

### `hotp`

```milo
fn hotp(secret: &string, counter: i64, digits: i64): string
```

HOTP value for a moving counter (RFC 4226 §5.3), `digits` long (6–8 typical).

### `totp`

```milo
fn totp(secret: &string, unixTime: i64, step: i64, digits: i64): string
```

TOTP value for a Unix timestamp (RFC 6238): HOTP over floor(time / step).
