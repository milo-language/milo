# std/http

## std/http

### `Context.cookie`

```milo
fn Context.cookie(self: &Context, name: &string): Option<string>
```

Value of cookie `name`, or None if there is no Cookie header or it does
not carry `name`. `name=` in the header is Some("").

### `Context.deleteCookie`

```milo
fn Context.deleteCookie(self: &mut Context, name: string): void
```

Delete a cookie on the client (`Max-Age=0`).

### `Context.header`

```milo
fn Context.header(self: &Context, name: &string): Option<string>
```

Value of request header `name` (case-insensitive), or None if the request
did not carry it. A header sent with an empty value is Some("").

### `Context.html`

```milo
fn Context.html(self: &Context, body: string): Response
```

A text/html response, with the status from `setStatus`.

### `Context.json`

```milo
fn Context.json(self: &Context, body: string): Response
```

An application/json response, with the status from `setStatus`.

### `Context.param`

```milo
fn Context.param(self: &Context, name: &string): Option<string>
```

Value of the route parameter `name`, or None if the route has no such
parameter. A matched-but-empty segment is Some("").

### `Context.query`

```milo
fn Context.query(self: &Context, name: &string): Option<string>
```

Value of query-string parameter `name`, or None if it was not in the URL.
`?name=` and `?name` are both present with an empty value: Some("").

### `Context.redirect`

```milo
fn Context.redirect(self: &Context, url: string): Response
```

A 302 Found response with `url` as its body. It does not set a `Location` header;
add one with `setHeader("Location", url)`.

### `Context.setCookie`

```milo
fn Context.setCookie(self: &mut Context, name: string, value: string): void
```

Set a response cookie (`Set-Cookie: name=value`).

### `Context.setCookieWithOptions`

```milo
fn Context.setCookieWithOptions(self: &mut Context, name: string, value: string, options: string): void
```

Set a response cookie with attributes, e.g. `options` = "Path=/; HttpOnly".

### `Context.setHeader`

```milo
fn Context.setHeader(self: &mut Context, name: string, value: string): void
```

Add a response header.

### `Context.setStatus`

```milo
fn Context.setStatus(self: &mut Context, code: i32): void
```

Set the response status code used by `text`, `json`, `html` and `redirect`.

### `Context.text`

```milo
fn Context.text(self: &Context, body: string): Response
```

A text/plain response, with the status from `setStatus`.

### `parseRequest`

```milo
pub fn parseRequest(buf: &[u8; 8192], n: i64): Request
```

Parse a request out of a raw read buffer. Public so an alternate transport
(std/https) can reuse the parser without duplicating it.

### `renderRaw`

```milo
pub fn renderRaw(status: i32, contentType: &string, body: &string, extraHeaders: &Vec<Param>): string
```

The response bytes, built but not written. Split out of sendRaw so a transport that
is not a bare fd — std/https writes through SSL_write — reuses the exact wire format
instead of reimplementing it. std/http itself stays OpenSSL-free; that separation is
why TLS lives in another module.

### `renderResponse`

```milo
pub fn renderResponse(response: &Response, extraHeaders: &Vec<Param>): string
```

Wire bytes for a Response, including the status line and headers.

### `Router.addRoute`

```milo
fn Router.addRoute(self: &mut Router, method: string, pattern: string, h: (&mut Context) => Response): void
```

_Undocumented._

### `Router.all`

```milo
fn Router.all(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

Register a route that matches any method.

### `Router.delete`

```milo
fn Router.delete(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

Register a DELETE route.

### `Router.get`

```milo
fn Router.get(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

Register a GET route. `:name` segments in `pattern` bind path parameters, read
with `ctx.param("name")`.

### `Router.handle`

```milo
fn Router.handle(self: &Router, req: Request): HandledResponse
```

_Undocumented._

### `Router.new`

```milo
fn Router.new(): Router
```

An empty router.

### `Router.post`

```milo
fn Router.post(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

Register a POST route.

### `Router.put`

```milo
fn Router.put(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

Register a PUT route.

### `Router.use`

```milo
fn Router.use(self: &mut Router, mw: (&mut Context, (&mut Context) => Response) => Response): void
```

Add middleware. It receives the context and `next`, the rest of the chain, and
returns the response.

### `serve`

```milo
pub fn serve(port: u16?, handler: (&Request) => Response): Result<Unit>
```

The simplest server: every request goes to `handler`. Good for a static file server
or a single-handler app. Answers one connection at a time.

### `serveRouter`

```milo
pub fn serveRouter(port: u16?, router: &Router): Result<Unit>
```

Start an HTTP server using a Router (headers from Context are sent on the wire).

### `serveRouterConcurrent`

```milo
pub fn serveRouterConcurrent(port: u16?, router: Router): Result<Unit>
```

Like serveRouter, but each connection is handled in its own green task.

serveRouter answers one connection at a time, which is fine while every
handler is pure computation over embedded data. It stops being fine the
moment a handler talks to the network: one slow upstream then stalls every
other client for the whole round trip. Handlers that fetch need this loop.

Never returns: the scheduler drives the accept task and the handlers it
spawns, exactly as a green-threaded server's main is supposed to.

### `statusText`

```milo
pub fn statusText(status: i32): string
```

_Undocumented._
