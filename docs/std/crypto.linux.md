# std/crypto.linux

## std/crypto.linux

### `aesGcm128Decrypt`

```milo
fn aesGcm128Decrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

_Undocumented._

### `aesGcm128Encrypt`

```milo
fn aesGcm128Encrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

_Undocumented._

### `aesGcmDecrypt`

```milo
fn aesGcmDecrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

_Undocumented._

### `aesGcmEncrypt`

```milo
fn aesGcmEncrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

_Undocumented._

### `md5`

```milo
fn md5(input: &string): string
```

_Undocumented._

### `sha1`

```milo
fn sha1(input: &string): string
```

_Undocumented._

### `sha1Bytes`

```milo
fn sha1Bytes(input: &string): string
```

_Undocumented._

### `sha256`

```milo
fn sha256(input: &string): string
```

_Undocumented._
