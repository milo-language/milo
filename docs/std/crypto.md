# std/crypto

## std/crypto

### `Crypto.aesGcm128Decrypt`

```milo
fn Crypto.aesGcm128Decrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

Decrypt and authenticate with AES-128-GCM: 16-byte key, 12-byte IV, 16-byte
`tag`. A tag that does not verify is an `Err`.

### `Crypto.aesGcm128Encrypt`

```milo
fn Crypto.aesGcm128Encrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-128-GCM. The key is 16 bytes and the IV is 12 bytes.

`aad` is additional authenticated data; pass "" if unused.

### `Crypto.aesGcmDecrypt`

```milo
fn Crypto.aesGcmDecrypt(key: &string, iv: &string, ciphertext: &string, tag: &string, aad: &string): Result<string, string>
```

Decrypt and authenticate with AES-256-GCM: 32-byte key, 12-byte IV, and the
16-byte `tag` from encryption. A tag that does not verify is an `Err`, never
corrupted plaintext.

### `Crypto.aesGcmEncrypt`

```milo
fn Crypto.aesGcmEncrypt(key: &string, iv: &string, plaintext: &string, aad: &string): Result<AesGcmResult, string>
```

Encrypt with AES-256-GCM. The key is 32 bytes and the IV is 12 bytes.

`aad` is additional authenticated data; pass "" if unused. The key and IV lengths
are preconditions (`requires`), not runtime errors.

### `Crypto.md5`

```milo
fn Crypto.md5(input: &string): string
```

MD5 as a 32-char lowercase hex string.

### `Crypto.sha1`

```milo
fn Crypto.sha1(input: &string): string
```

SHA-1 as a 40-char lowercase hex string.

### `Crypto.sha1Bytes`

```milo
fn Crypto.sha1Bytes(input: &string): string
```

SHA-1 as the raw 20-byte digest (the WebSocket handshake, legacy protocols).

### `Crypto.sha256`

```milo
fn Crypto.sha256(input: &string): string
```

SHA-256 as a 64-char lowercase hex string.
