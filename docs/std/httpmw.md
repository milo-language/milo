# std/httpmw

## std/httpmw

### `acceptsGzip`

```milo
pub fn acceptsGzip(headerVal: &string): bool
```

Substring test for "gzip" in an Accept-Encoding value. Deliberately loose: it does
not parse q-values, so `gzip;q=0` would still match — acceptable, since a client
that lists gzip at all can decode it.

### `bearerToken`

```milo
pub fn bearerToken(ctx: &Context): string
```

Token from an `Authorization: Bearer <token>` header; "" if absent or wrong
scheme. Scheme match is case-insensitive (RFC 7235 §2.1), the token is not.

### `gzip`

```milo
pub fn gzip(ctx: &mut Context, next: (&mut Context) => Response): Response
```

Middleware: gzip the response body when the client sent `Accept-Encoding: gzip`
and the body clears GZIP_MIN. Sets `Content-Encoding: gzip`; Content-Length is
recomputed from the (compressed) body downstream, so no manual length bookkeeping.

### `verifyBearer`

```milo
pub fn verifyBearer(ctx: &Context, secret: &string): bool
```

True iff the request carries a bearer token with a valid HS256 signature for
`secret`. Signature check is constant-time (see std/jwt); does not decode claims.
