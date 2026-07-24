# std/crypto.windows

## std/crypto.windows

### `aesGcm128Decrypt`

```milo
pub fn aesGcm128Decrypt(_key: &string, _iv: &string, _ciphertext: &string, _tag: &string, _aad: &string): Result<string, string>
```

_Undocumented._

### `aesGcm128Encrypt`

```milo
pub fn aesGcm128Encrypt(_key: &string, _iv: &string, _plaintext: &string, _aad: &string): Result<AesGcmResult, string>
```

_Undocumented._

### `aesGcmDecrypt`

```milo
pub fn aesGcmDecrypt(_key: &string, _iv: &string, _ciphertext: &string, _tag: &string, _aad: &string): Result<string, string>
```

_Undocumented._

### `aesGcmEncrypt`

```milo
pub fn aesGcmEncrypt(_key: &string, _iv: &string, _plaintext: &string, _aad: &string): Result<AesGcmResult, string>
```

_Undocumented._

### `md5`

```milo
pub fn md5(input: &string): string
```

Compute MD5 hash of a string. Returns 32-char lowercase hex string.

### `sha1`

```milo
pub fn sha1(input: &string): string
```

Compute SHA-1 hash. Returns 40-char lowercase hex string.

### `sha1Bytes`

```milo
pub fn sha1Bytes(input: &string): string
```

Raw 20-byte SHA-1 digest as a string (for WebSocket handshake, HMAC, etc.)

### `sha256`

```milo
pub fn sha256(input: &string): string
```

Compute SHA-256 hash of a string. Returns 64-char lowercase hex string.
