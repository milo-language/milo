# std/cryptosys.darwin

## std/cryptosys.darwin

### `gcmDecryptRaw`

```milo
pub fn gcmDecryptRaw(keyBits: i64, key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

AES-GCM decrypt; Err on authentication failure.

### `gcmEncryptRaw`

```milo
pub fn gcmEncryptRaw(keyBits: i64, key: &string, iv: &string, plaintext: &string, aad: &string): Result<string, string>
```

AES-GCM encrypt; returns ciphertext with the 16-byte tag appended. Lengths are the
caller's to guarantee: std/crypto checks them before calling.

### `md5Raw`

```milo
pub fn md5Raw(input: &string): string
```

Raw 16-byte MD5 digest.

### `sha1Raw`

```milo
pub fn sha1Raw(input: &string): string
```

Raw 20-byte SHA-1 digest.

### `sha256Raw`

```milo
pub fn sha256Raw(input: &string): string
```

Raw 32-byte SHA-256 digest.
