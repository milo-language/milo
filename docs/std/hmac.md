# std/hmac

## std/hmac

### `Hmac.sha1Bytes`

```milo
fn Hmac.sha1Bytes(key: &string, msg: &string): string
```

HMAC-SHA1, 20 raw bytes.

Needed by HOTP/TOTP (std/totp) and PBKDF2-HMAC-SHA1, both specified on SHA-1.

### `Hmac.sha256`

```milo
fn Hmac.sha256(key: &string, msg: &string): string
```

HMAC-SHA256 as 64-char lowercase hex.

### `Hmac.sha256Bytes`

```milo
fn Hmac.sha256Bytes(key: &string, msg: &string): string
```

HMAC-SHA256, 32 raw bytes.

### `Hmac.sha384Bytes`

```milo
fn Hmac.sha384Bytes(key: &string, msg: &string): string
```

HMAC-SHA384, 48 raw bytes.

### `Hmac.sha512`

```milo
fn Hmac.sha512(key: &string, msg: &string): string
```

HMAC-SHA512 as 128-char lowercase hex.

### `Hmac.sha512Bytes`

```milo
fn Hmac.sha512Bytes(key: &string, msg: &string): string
```

HMAC-SHA512, 64 raw bytes.
