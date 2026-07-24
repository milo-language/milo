# std/base64

## std/base64

### `b64DecodeChar`

```milo
fn b64DecodeChar(ch: u8): u8
```

_Undocumented._

### `b64EncodeChar`

```milo
fn b64EncodeChar(val: u8): u8
```

_Undocumented._

### `base64Decode`

```milo
pub fn base64Decode(input: &string): string
```

Decode a base64 string.

### `base64Encode`

```milo
pub fn base64Encode(input: &string): string
```

Encode a string to base64.

### `base64UrlEncode`

```milo
pub fn base64UrlEncode(input: &string): string
```

URL-safe base64, no padding (RFC 4648 §5): '+' → '-', '/' → '_', drop '='.
Used for embedding binary data in URL fragments.
