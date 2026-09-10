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

_Undocumented._

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

_Undocumented._

### `Context.json`

```milo
fn Context.json(self: &Context, body: string): Response
```

_Undocumented._

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

_Undocumented._

### `Context.setCookie`

```milo
fn Context.setCookie(self: &mut Context, name: string, value: string): void
```

_Undocumented._

### `Context.setCookieWithOptions`

```milo
fn Context.setCookieWithOptions(self: &mut Context, name: string, value: string, options: string): void
```

_Undocumented._

### `Context.setHeader`

```milo
fn Context.setHeader(self: &mut Context, name: string, value: string): void
```

_Undocumented._

### `Context.setStatus`

```milo
fn Context.setStatus(self: &mut Context, code: i32): void
```

_Undocumented._

### `Context.text`

```milo
fn Context.text(self: &Context, body: string): Response
```

_Undocumented._

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

_Undocumented._

### `Router.delete`

```milo
fn Router.delete(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

_Undocumented._

### `Router.get`

```milo
fn Router.get(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

_Undocumented._

### `Router.handle`

```milo
fn Router.handle(self: &Router, req: Request): HandledResponse
```

_Undocumented._

### `Router.new`

```milo
fn Router.new(): Router
```

_Undocumented._

### `Router.post`

```milo
fn Router.post(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

_Undocumented._

### `Router.put`

```milo
fn Router.put(self: &mut Router, pattern: string, h: (&mut Context) => Response): void
```

_Undocumented._

### `Router.use`

```milo
fn Router.use(self: &mut Router, mw: (&mut Context, (&mut Context) => Response) => Response): void
```

_Undocumented._

### `serve`

```milo
pub fn serve(port: u16?, handler: (&Request) => Response): Result<Unit>
```

_Undocumented._

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
