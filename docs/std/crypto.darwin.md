# std/crypto.darwin

## std/crypto.darwin

### `aesGcm128Decrypt`

```milo
fn aesGcm128Decrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

Decrypt with AES-128-GCM. Key 16 bytes, IV 12 bytes, tag 16 bytes.

### `aesGcm128Encrypt`

```milo
fn aesGcm128Encrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-128-GCM. Key must be 16 bytes, IV 12 bytes. (termpair uses AES-128.)

### `aesGcmDecrypt`

```milo
fn aesGcmDecrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

Decrypt with AES-256-GCM. Key must be 32 bytes, IV 12 bytes, tag 16 bytes.

### `aesGcmEncrypt`

```milo
fn aesGcmEncrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-256-GCM. Key must be 32 bytes, IV should be 12 bytes.

### `md5`

```milo
fn md5(input: &string): string
```

Compute MD5 hash of a string. Returns 32-char lowercase hex string.

### `sha1`

```milo
fn sha1(input: &string): string
```

Compute SHA-1 hash. Returns 40-char lowercase hex string.

### `sha1Bytes`

```milo
fn sha1Bytes(input: &string): string
```

Raw 20-byte SHA-1 digest as a string (for WebSocket handshake, HMAC, etc.)

### `sha256`

```milo
fn sha256(input: &string): string
```

Compute SHA-256 hash of a string. Returns 64-char lowercase hex string.
