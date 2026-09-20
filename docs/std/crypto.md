# std/crypto

## std/crypto

### `Crypto.aesGcm128Decrypt`

```milo
fn Crypto.aesGcm128Decrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

_Undocumented._

### `Crypto.aesGcm128Encrypt`

```milo
fn Crypto.aesGcm128Encrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-128-GCM. The key is 16 bytes and the IV is 12 bytes.

### `Crypto.aesGcmDecrypt`

```milo
fn Crypto.aesGcmDecrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

_Undocumented._

### `Crypto.aesGcmEncrypt`

```milo
fn Crypto.aesGcmEncrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-256-GCM. The key is 32 bytes and the IV is 12 bytes.

### `Crypto.md5`

```milo
fn Crypto.md5(input: &string): string
```

_Undocumented._

### `Crypto.sha1`

```milo
fn Crypto.sha1(input: &string): string
```

_Undocumented._

### `Crypto.sha1Bytes`

```milo
fn Crypto.sha1Bytes(input: &string): string
```

_Undocumented._

### `Crypto.sha256`

```milo
fn Crypto.sha256(input: &string): string
```

_Undocumented._
