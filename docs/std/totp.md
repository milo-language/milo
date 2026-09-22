# std/totp

## std/totp

### `Totp.generate`

```milo
fn Totp.generate(secret: &string, unixTime: i64, step: i64, digits: i64): string
```

TOTP value for a Unix timestamp (RFC 6238): HOTP over `floor(unixTime / step)`.
Use `step = 30`, `digits = 6` for the common authenticator-app setup.

### `Totp.hotp`

```milo
fn Totp.hotp(secret: &string, counter: i64, digits: i64): string
```

HOTP value for a moving counter (RFC 4226 §5.3), `digits` long (6 to 8 is
typical), zero-padded.

### `Totp.verify`

```milo
fn Totp.verify(secret: &string, code: &string, unixTime: i64, step: i64, digits: i64, window: i64): bool
```

Check a user-supplied code against the codes valid at `unixTime`, accepting
`window` steps either side (RFC 6238 §5.2 — one step of tolerance is usual,
for the user who typed the code as it rolled over).

Exists so that nobody writes `Totp.generate(...) == code`: string equality
stops at the first wrong digit, which turns a 6-digit code into six
independent 10-way guesses. This comparison is constant-time.
