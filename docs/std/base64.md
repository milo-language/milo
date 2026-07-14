# std/base64

## std/base64

### `base64Decode`

```milo
fn base64Decode(input: &string): string
```

Decode a base64 string.

### `base64Encode`

```milo
fn base64Encode(input: &string): string
```

Encode a string to base64.

### `base64UrlEncode`

```milo
fn base64UrlEncode(input: &string): string
```

URL-safe base64, no padding (RFC 4648 §5): '+' → '-', '/' → '_', drop '='.
Used for embedding binary data in URL fragments.
