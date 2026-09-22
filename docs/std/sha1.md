# std/sha1

## std/sha1

### `Sha1.bytes`

```milo
fn Sha1.bytes(input: &string): string
```

SHA-1 digest as 20 raw bytes (for HMAC-SHA1 and the WebSocket handshake).

### `Sha1.hash`

```milo
fn Sha1.hash(input: &string): string
```

SHA-1 digest as a 40-char lowercase hex string.
