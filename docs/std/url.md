# std/url

## std/url

### `Url.parse`

```milo
fn Url.parse(s: string): Result<Url>
```

Parse a URL string into its components.

### `Url.queryGet`

```milo
fn Url.queryGet(self: &Url, key: &string): Option<string>
```

The value of query parameter `key`, or None if the query has no such key.

### `Url.toString`

```milo
fn Url.toString(self: &Url): string
```

Reassemble the URL from its components.
