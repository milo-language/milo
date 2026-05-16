# std/crypto

Cryptographic hashing functions.

```milo
from "std/crypto" import { sha256, md5 }
```

## Functions

### sha256

```milo
fn sha256(data: &string): string
```

Returns the SHA-256 hash of `data` as a lowercase hex string.

### md5

```milo
fn md5(data: &string): string
```

Returns the MD5 hash of `data` as a lowercase hex string.

```milo
let hash = sha256(&"hello world")
// "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
```
