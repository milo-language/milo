# std/cryptosys.windows

## std/cryptosys.windows

### `gcmDecryptRaw`

```milo
pub fn gcmDecryptRaw(_keyBits: i64, _key: &string, _iv: &string, _ciphertext: &string, _tag: &string, _aad: &string): Result<string, string>
```

AES-GCM decrypt.

### `gcmEncryptRaw`

```milo
pub fn gcmEncryptRaw(_keyBits: i64, _key: &string, _iv: &string, _plaintext: &string, _aad: &string): Result<string, string>
```

AES-GCM encrypt; would return ciphertext with the 16-byte tag appended.

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
