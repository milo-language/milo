# std/crypto.linux

## std/crypto.linux

### `aesGcm128Decrypt`

```milo
pub fn aesGcm128Decrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

Decrypt with AES-128-GCM. Key 16 bytes, IV 12 bytes, tag 16 bytes.

### `aesGcm128Encrypt`

```milo
pub fn aesGcm128Encrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-128-GCM. Key 16 bytes, IV 12 bytes. (termpair uses AES-128.)

### `aesGcmDecrypt`

```milo
pub fn aesGcmDecrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

Decrypt with AES-256-GCM. Key must be 32 bytes, IV 12 bytes, tag 16 bytes.

### `aesGcmEncrypt`

```milo
pub fn aesGcmEncrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-256-GCM. Key must be 32 bytes, IV should be 12 bytes.

### `bytesToHex`

```milo
pub fn bytesToHex(buf: &[u8; 32], n: i64): string
```

_Undocumented._

### `evpCtrlGcmGetTag`

```milo
fn evpCtrlGcmGetTag(): i32
```

EVP_CTRL_GCM_SET_TAG = 0x11, EVP_CTRL_GCM_GET_TAG = 0x10

### `evpCtrlGcmSetTag`

```milo
fn evpCtrlGcmSetTag(): i32
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
