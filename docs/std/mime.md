# std/mime

## std/mime

### `Mime.contentType`

```milo
fn Mime.contentType(path: &string): Option<string>
```

Full `Content-Type` header value for `path`: the media type, plus
"; charset=utf-8" when the type is textual.

The charset is not decoration. A text/html response with no declared
charset lets the browser guess, and a guess an attacker can steer (the
classic case is UTF-7) turns escaped output back into markup. Send this,
not the bare type, on anything a browser will render.

### `Mime.fromExtension`

```milo
fn Mime.fromExtension(ext: &string): Option<string>
```

Media type for `ext`, or None if the extension is not in the table.

`ext` may be spelled with or without a leading dot and in any case:
"html", ".HTML" and "HtMl" all answer text/html. The answer is the bare
type with no parameters — see contentType for a full header value.

".ts" answers video/mp2t, matching the registry and every other server, not
TypeScript source.

### `Mime.fromPath`

```milo
fn Mime.fromPath(path: &string): Option<string>
```

Media type for the extension of `path`, or None if it has no extension or
the extension is unknown.

The extension is the text after the last '.' in the last path segment, so
"/var/www/.htaccess" and "/etc/conf.d/app" have none — a leading dot is a
hidden-file marker, not an extension, and a dot in a parent directory
belongs to that directory.

### `Mime.isTextual`

```milo
fn Mime.isTextual(mediaType: &string): bool
```

Whether `mediaType` names text: any "text/..." type, or a structured
syntax that is text in practice (+json, +xml, and the handful of
application/... types that predate the suffix convention).

Accepts a bare type or a full header value — parameters after the first
';' are ignored, so "text/html" and "text/html; charset=utf-8" agree. The
match is on the type name only; it is not a claim that the bytes decode.
