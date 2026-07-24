# std/http

## std/http

### `bufToStr`

```milo
pub fn bufToStr(buf: &[u8; 8192], start: i64, end: i64): string
```

_Undocumented._

### `bufToStrFromString`

```milo
pub fn bufToStrFromString(s: &string, start: i64, end: i64): string
```

_Undocumented._

### `Context.cookie`

```milo
fn Context.cookie(self: &Context, name: &string): string
```

_Undocumented._

### `Context.deleteCookie`

```milo
fn Context.deleteCookie(self: &mut Context, name: string): void
```

_Undocumented._

### `Context.header`

```milo
fn Context.header(self: &Context, name: &string): string
```

_Undocumented._

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
fn Context.param(self: &Context, name: &string): string
```

_Undocumented._

### `Context.query`

```milo
fn Context.query(self: &Context, name: &string): string
```

_Undocumented._

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

### `Drop.drop`

```milo
fn Drop.drop(self: &mut Drop): void
```

_Undocumented._

### `eqIgnoreCase`

```milo
pub fn eqIgnoreCase(a: &string, b: &string): bool
```

_Undocumented._

### `extractParamNames`

```milo
pub fn extractParamNames(pattern: &string): Vec<string>
```

_Undocumented._

### `hexNibble`

```milo
pub fn hexNibble(ch: u8): i32
```

Value of a single hex digit, or -1 if the byte isn't one.

### `matchRoute`

```milo
pub fn matchRoute(pattern: &string, paramNames: &Vec<string>, path: &string): Option<Vec<Param>>
```

_Undocumented._

### `parseContentLength`

```milo
pub fn parseContentLength(s: &string): i64
```

_Undocumented._

### `parseCookieValue`

```milo
pub fn parseCookieValue(cookieHeader: string, name: &string): string
```

_Undocumented._

### `parseQueryString`

```milo
pub fn parseQueryString(qs: &string): Vec<Param>
```

_Undocumented._

### `parseRequest`

```milo
pub fn parseRequest(buf: &[u8; 8192], n: i64): Request
```

_Undocumented._

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

### `sendRaw`

```milo
pub fn sendRaw(fd: i32, status: i32, contentType: string, body: string, extraHeaders: &Vec<Param>): void
```

_Undocumented._

### `sendResponse`

```milo
pub fn sendResponse(fd: i32, response: Response, headers: &Vec<Param>): void
```

_Undocumented._

### `serve`

```milo
pub fn serve(port: u16?, handler: (&Request) => Response): Result<void>
```

_Undocumented._

### `serveRouter`

```milo
pub fn serveRouter(port: u16?, router: &Router): Result<void>
```

Start an HTTP server using a Router (headers from Context are sent on the wire).

### `splitPath`

```milo
pub fn splitPath(path: &string): Vec<string>
```

_Undocumented._

### `statusText`

```milo
pub fn statusText(status: i32): string
```

_Undocumented._

### `toLower`

```milo
pub fn toLower(ch: u8): u8
```

_Undocumented._

### `urlDecode`

```milo
pub fn urlDecode(s: &string): string
```

Percent-decode a query component. '+' means space (form-urlencoded) and %XX
is a raw byte. A malformed escape is passed through literally rather than
dropped, so a stray '%' in user input can't truncate the value.
