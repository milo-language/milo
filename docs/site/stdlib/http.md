# std/http

HTTP server with Hono-inspired router, context, middleware, path params, query strings, and cookies.

```milo
from "std/http" import { Context, Response, Router, serveRouter }
```

The context lookups (`ctx.param`, `ctx.query`, `ctx.header`, `ctx.cookie`) return
`Option<string>` because absent and present-but-empty are different: `?q=` and a
`Cookie: sid=` are *present* with an empty value. Collapse them with `??` when the
distinction does not matter (`ctx.query("q") ?? ""`), and bind with `let ... else` when
it does.

`serveRouter` gives each connection its own green task, so a slow client or a handler
that calls the network does not stall the others, and a handler panic answers that client
500 instead of aborting the process. `serveRouterSerial` answers one connection at a time
on the calling thread: for single-threaded deterministic tests, or a program with no green
runtime (it does not serve stream or websocket routes).

`serveRouter` binds every interface (0.0.0.0). `serveRouterOn(host, port, router)` binds
one IPv4 address instead (`serveRouterSerialOn` for the serial server): pass
`"127.0.0.1"` (or `"localhost"`) for an app that only a local reverse proxy should
reach. The host must be a dotted quad or `"localhost"`; anything else fails at startup.

### Request limits

The server reads a whole request before calling the handler: the headers up to the
blank line, then the body, however many reads that takes. The body is framed by
`Content-Length` or by `Transfer-Encoding: chunked`, which is decoded (chunk extensions
and trailers are dropped). A body with `Content-Encoding: gzip`, `x-gzip` or `deflate`
(zlib, or a bare DEFLATE stream) is decompressed, and the handler sees the decoded body
with `Content-Encoding` removed and `Content-Length`, if one was sent, rewritten to the
decoded length. A client that sends `Expect: 100-continue` gets `HTTP/1.1 100 Continue`
before the body is read. Requests the server refuses without running a handler:

| Request | Answer |
|---|---|
| a request line that is not `METHOD target HTTP/1.x`, a field name that is not a token (empty, or space before the colon), a `Content-Length` that is not digits or two that disagree, bad chunk framing, `chunked` not the last transfer coding, a compressed body that does not decode | 400 |
| `Content-Length`, or the sizes chunks declare, over the router's limit (`router.setMaxBodySize(bytes)`, default 1 MiB; `serve` uses the default) | 413 |
| a compressed body that decodes past `router.setMaxInflatedSize(bytes)` (default: the max body size); decoding stops at the cap, so a zip bomb costs at most that much memory | 413 |
| a request line over 16 KiB | 414 |
| a `Content-Encoding` other than gzip, x-gzip, deflate or identity | 415 |
| request line plus headers over 16 KiB | 431 |
| a transfer coding other than `chunked` (and `identity`) | 501 |
| an HTTP version other than 1.x | 505 |

A client has `readTimeoutMs` (default 30 s) to send its whole request, headers and body;
past it the connection is closed without a response, so half-sent requests cannot hold
connection slots (slowloris). `writeTimeoutMs` (30 s) bounds one response write to a peer
that has stopped reading. 0 turns either off. Stream and websocket routes are not bound by
them once they take over the connection. Both are `ServeOptions` fields, passed to
`serveRouterWith`; `serveRouterSerial` uses the defaults.

### Static files

`ctx.file(path)` answers with the file at `path` (404 when it is not a readable regular
file), typed by `std/mime`. `fileResponse(method, headers, path, contentType)` is the same
for a server that is not built on `Context`, returning the response and its headers.
Both send validators and honor conditional and range requests:

- `ETag` is strong, built from the file's size and its modification time in nanoseconds
  (`"<size hex>-<mtime ns hex>"`), and `Last-Modified` is the mtime. Neither needs the
  file read, so a 304 costs one `stat`.
- `If-None-Match` naming the ETag (weak comparison, or `*`) is a 304; without
  `If-None-Match`, an `If-Modified-Since` not older than the mtime is a 304.
- A single `Range: bytes=` range on a GET is a 206 with `Content-Range`; one that starts
  past the end is a 416 with `Content-Range: bytes */<size>`. Several ranges, bad syntax,
  a HEAD, or an `If-Range` that names neither the current ETag nor the Last-Modified date
  get the whole file.
- `Cache-Control` is not set: how long a file may be cached is the app's call (a
  content-hashed asset can be `immutable`, an `index.html` cannot).

Nothing keeps `path` inside a directory: a handler that joins request input into it must
refuse `..` segments itself.

### Response headers

`ctx.setHeader` adds a header, and these rules apply when the response is written:

- `Content-Type` and `Server` are defaults: a handler header of the same name (any
  case) replaces the default rather than adding a second one.
- `Content-Length`, `Connection` and `Transfer-Encoding` are written by the server to
  match the bytes it sends, so a handler's copy is dropped. Every response is
  `Connection: close`.
- 1xx, 204 and 304 responses have no body, no `Content-Length` and no `Content-Type`,
  whatever the handler returned.

## Examples

### Router with path params

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn userHandler(ctx: &mut Context): Response {
    let id = ctx.param("id") ?? ""
    return ctx.json($"\{\"userId\": \"{id}\"}")
}

fn searchHandler(ctx: &mut Context): Response {
    // None only when there is no ?q= at all; `?q=` is Some("").
    let Some(q) = ctx.query("q") else {
        ctx.setStatus(400)
        return ctx.text("missing ?q=")
    }
    return ctx.text($"searching for: {q}")
}

fn main(): i32 {
    var r: Router = Router.new()
    r.get("/users/:id", userHandler)
    r.get("/search", searchHandler)
    serveRouter(8080, r)
    return 0
}
```

### Middleware

```milo
fn logMiddleware(ctx: &mut Context, next: (&mut Context) => Response): Response {
    print(ctx.req.method + " " + ctx.req.path)
    let resp = next(ctx)
    ctx.setHeader("X-Powered-By", "milo")
    return resp
}

fn main(): i32 {
    var r: Router = Router.new()
    r.use(logMiddleware)
    r.get("/", fn homeHandler(ctx: &mut Context): Response {
        return ctx.text("hello")
    })
    serveRouter(3000, r)
    return 0
}
```

### Cookies

```milo
fn loginHandler(ctx: &mut Context): Response {
    ctx.setCookieWithOptions("session", "abc123", "Path=/; HttpOnly")
    return ctx.json("{\"logged_in\": true}")
}

fn profileHandler(ctx: &mut Context): Response {
    let Some(session) = ctx.cookie("session") else {
        ctx.setStatus(401)
        return ctx.json("{\"error\": \"not authenticated\"}")
    }
    return ctx.json($"\{\"session\": \"{session}\"}")
}
```

### Server-sent events and websockets

`r.stream` and `r.ws` routes keep their connection, under `serveRouter`. The
server owns the socket: the handler gets a `Stream` or `WebSocket` to talk through, and
the socket is closed when the handler returns. Another task (a broadcast, a timer) never
touches the socket either. It keeps an `Outbox` from `conn.outbox()` or `ws.outbox()`:
a storable, cloneable sender whose messages the connection's own task writes while the
handler waits in `waitClosed` or `recv`. Once the connection has ended, `outbox.send`
returns false and writes nothing, so a broadcaster drops that outbox. A peer that leaves
1024 messages unread is disconnected rather than buffered without bound.

A stream sends its body chunked (`Transfer-Encoding: chunked`), one chunk per `send`.
`conn.respond(...)` answers with an ordinary response instead, such as a 404 for an
unknown feed.

```milo
from "std/http" import { Context, Outbox, Param, Response, Router, Stream, serveRouter }

var feeds: Vec<Outbox> = []

fn events(_ctx: &mut Context, conn: &mut Stream): void {
    conn.open("text/event-stream", [Param { name: "Cache-Control", value: "no-cache" }])
    conn.send("retry: 3000\n\n")
    feeds.push(conn.outbox())
    conn.waitClosed()
}

fn publish(ctx: &mut Context): Response {
    // Keep the outboxes that took the event; a refused send means that client left.
    var kept: Vec<Outbox> = []
    for out in feeds {
        if out.send("data: " + ctx.req.body + "\n\n") {
            kept.push(out.clone())
        }
    }
    feeds = kept
    return ctx.text($"sent to {feeds.len}")
}

fn main(): i32 {
    var r = Router.new()
    r.stream("/events", events)
    r.post("/publish", publish)
    serveRouter(8080, r)!
    return 0
}
```

A `ws` route answers the upgrade itself (a GET without `Upgrade: websocket` falls
through to the other routes). `recv` returns each text or binary message's payload and
`None` once the connection is over; ping, pong, the close handshake and a 30 s
heartbeat that drops a silent peer are handled by the server. `setMaxMessageSize`
bounds what `recv` accepts (default 1 MiB, close 1009 past it).

```milo
from "std/http" import { Context, Outbox, Router, WebSocket, serveRouter }

var room: Vec<Outbox> = []

fn chat(_ctx: &mut Context, ws: &mut WebSocket): void {
    room.push(ws.outbox())
    while true {
        let Option.Some(msg) = ws.recv() else {
            break
        }
        ws.sendText("you said: " + msg)
        var i: i64 = 0
        while i < room.len {
            if room[i].send(msg) {
                i += 1
            } else {
                room.remove(i)
            }
        }
    }
}

fn main(): i32 {
    var r = Router.new()
    r.ws("/chat", chat)
    serveRouter(8080, r)!
    return 0
}
```

## Zero-downtime restarts

A server restarts without dropping a request when systemd owns its listening socket. Every
serve function adopts the socket systemd passes in (`LISTEN_FDS` / `LISTEN_PID`, fd 3, on
Linux and macOS) instead of binding its own, and announces the port from `getsockname`.
On `SIGTERM` it stops accepting, lets requests in flight finish, closes long-lived
streams and websockets at once (a websocket gets close code 1001), and exits 0, at most
`drainMs` (default 10000) after the signal. If connections are still open then, it
prints their count to stderr and exits 1. systemd keeps its copy of the socket open,
so connections that arrive during the restart wait in the kernel backlog for the next
process.

```
# /etc/systemd/system/app.socket
[Socket]
ListenStream=127.0.0.1:3011
Backlog=1024

[Install]
WantedBy=sockets.target
```

```
# /etc/systemd/system/app.service
[Service]
ExecStart=/usr/local/bin/app
KillSignal=SIGTERM
TimeoutStopSec=15
```

`systemctl restart app` then starts the new binary on the same socket while the old one
drains. Keep `TimeoutStopSec` above `drainMs`.

`serveRouterWith(host, port, router, ServeOptions { maxConn: 512, drainMs: 10000 })`
sets the limits. At `maxConn` connections in flight the server stops calling `accept()`
until one finishes, so the excess waits in the kernel's listen backlog (1024, capped by
`somaxconn`) and past that the kernel drops SYNs and clients retransmit. Memory is
bounded by `maxConn`, and a reverse proxy in front times out the wait instead of the
server running out of memory. `serve` and `serveRouterSerialOn` answer one connection at a time
and finish the current request before exiting on `SIGTERM`.

<!-- generated:api -->
<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/http*.milo. -->

## API reference

### `Context`

```milo
pub struct Context
```

Request context passed to route handlers.

Fields: `req: Request`, `params: Vec<Param>`, `statusCode: i32`, `respHeaders: Vec<Param>`.

#### `Context.cookie`

```milo
fn Context.cookie(self: &Context, name: &string): Option<string>
```

Value of cookie `name`, or None if there is no Cookie header or it does
not carry `name`. `name=` in the header is Some("").

#### `Context.deleteCookie`

```milo
fn Context.deleteCookie(self: &mut Context, name: string): void
```

Delete a cookie on the client (`Max-Age=0`).

#### `Context.file`

```milo
fn Context.file(self: &mut Context, path: &string): Response
```

The file at `path` as the response, with validators and ranges (see fileResponse):
200, 206, 304, 416, or a 404 when it is not a readable regular file. The content
type comes from std/mime (application/octet-stream when the extension is unknown);
Cache-Control stays the handler's to set. Nothing here keeps `path` inside a
directory: a handler joining user input into it must refuse `..` itself.

#### `Context.header`

```milo
fn Context.header(self: &Context, name: &string): Option<string>
```

Value of request header `name` (case-insensitive), or None if the request
did not carry it. A header sent with an empty value is Some("").

#### `Context.html`

```milo
fn Context.html(self: &Context, body: string): Response
```

A text/html response, with the status from `setStatus`.

#### `Context.json`

```milo
fn Context.json(self: &Context, body: string): Response
```

An application/json response, with the status from `setStatus`.

#### `Context.param`

```milo
fn Context.param(self: &Context, name: &string): Option<string>
```

Value of the route parameter `name`, or None if the route has no such
parameter. A matched-but-empty segment is Some("").

#### `Context.query`

```milo
fn Context.query(self: &Context, name: &string): Option<string>
```

Value of query-string parameter `name`, or None if it was not in the URL.
`?name=` and `?name` are both present with an empty value: Some("").

#### `Context.redirect`

```milo
fn Context.redirect(self: &mut Context, url: string): Response
```

A redirect to `url`: sets the `Location` header and answers 302 Found, or the
status from `setStatus` (301, 303, 307, 308) when one was set. The URL is also the
body, for clients that show it.

#### `Context.setCookie`

```milo
fn Context.setCookie(self: &mut Context, name: string, value: string): void
```

Set a response cookie (`Set-Cookie: name=value`).

#### `Context.setCookieWithOptions`

```milo
fn Context.setCookieWithOptions(self: &mut Context, name: string, value: string, options: string): void
```

Set a response cookie with attributes, e.g. `options` = "Path=/; HttpOnly".

#### `Context.setHeader`

```milo
fn Context.setHeader(self: &mut Context, name: string, value: string): void
```

Add a response header.

#### `Context.setStatus`

```milo
fn Context.setStatus(self: &mut Context, code: i32): void
```

Set the response status code used by `text`, `json`, `html` and `redirect`.

#### `Context.text`

```milo
fn Context.text(self: &Context, body: string): Response
```

A text/plain response, with the status from `setStatus`.

### `HandledResponse`

```milo
pub struct HandledResponse
```

Fields: `response: Response`, `headers: Vec<Param>`.

### `Outbox`

```milo
pub struct Outbox
```

A storable, cloneable sender to one Stream or WebSocket, for tasks other than the
connection's own: a broadcast keeps a `Vec<Outbox>` and sends to each. Messages are
queued and written by the connection's task. It holds no descriptor, so once the
connection has ended `send` returns false and touches nothing.

#### `Outbox.clone`

```milo
fn Outbox.clone(self: &Outbox): Outbox
```

Another sender to the same connection.

#### `Outbox.close`

```milo
fn Outbox.close(self: &Outbox): void
```

End the connection once what was queued before this is written: a Stream finishes
its body, a WebSocket sends its close frame.

#### `Outbox.send`

```milo
fn Outbox.send(self: &Outbox, data: &string): bool
```

Queue `data`: one body chunk for a Stream, one text message for a WebSocket. Never
parks. False once the connection has ended, and also when the peer has 1024
messages still unwritten: a peer that far behind is not reading, so its connection
is dropped instead of buffered without bound.

### `Param`

```milo
pub struct Param
```

A name/value pair: a path parameter, query parameter, header or cookie.

Fields: `name: string`, `value: string`.

### `Request`

```milo
pub struct Request
```

A parsed HTTP request.

Fields:

- `method: string`
- `path: string`
- `queryParams: Vec<Param>`
- `rawQuery: string`: The query string exactly as sent (no '?', not percent-decoded), "" when the URL had none: what a proxy forwards or a log records, since decoded params cannot be turned back into the original bytes.
- `headers: Vec<Param>`
- `body: string`

### `Response`

```milo
pub enum Response
```

What a handler returns. `Status` carries the status code, content type and body.

Variants:

- `Text(string)`
- `Html(string)`
- `Json(string)`
- `NotFound`
- `Status(i32, string, string)`

### `Route`

```milo
pub struct Route
```

Fields: `method: string`, `pattern: string`, `paramNames: Vec<string>`, `handler: (&mut Context) => Response`.

### `Router`

```milo
pub struct Router
```

Routes requests to handlers by method and path pattern (`/users/:id`), with
middleware run around every handler.

Fields:

- `routes: Vec<Route>`
- `streams: Vec<StreamRoute>`
- `sockets: Vec<WsRoute>`
- `middleware: Vec<(&mut Context, (&mut Context) => Response) => Response>`
- `maxBodyBytes: i64`
- `maxInflatedBytes: i64`: 0: the same as maxBodyBytes

#### `Router.addRoute`

```milo
fn Router.addRoute(self: &mut Router, method: string, pattern: string, h: move (&mut Context) => Response): void
```

#### `Router.all`

```milo
fn Router.all(self: &mut Router, pattern: string, h: move (&mut Context) => Response): void
```

Register a route that matches any method.

#### `Router.delete`

```milo
fn Router.delete(self: &mut Router, pattern: string, h: move (&mut Context) => Response): void
```

Register a DELETE route.

#### `Router.get`

```milo
fn Router.get(self: &mut Router, pattern: string, h: move (&mut Context) => Response): void
```

Register a GET route. `:name` segments in `pattern` bind path parameters, read
with `ctx.param("name")`.

#### `Router.handle`

```milo
fn Router.handle(self: &Router, req: Request): HandledResponse
```

#### `Router.new`

```milo
fn Router.new(): Router
```

An empty router.

#### `Router.post`

```milo
fn Router.post(self: &mut Router, pattern: string, h: move (&mut Context) => Response): void
```

Register a POST route.

#### `Router.put`

```milo
fn Router.put(self: &mut Router, pattern: string, h: move (&mut Context) => Response): void
```

Register a PUT route.

#### `Router.setMaxBodySize`

```milo
fn Router.setMaxBodySize(self: &mut Router, bytes: i64): void
```

The largest request body this router's server accepts, in bytes (default 1 MiB).
A request declaring more is answered 413 before its body is read.

#### `Router.setMaxInflatedSize`

```milo
fn Router.setMaxInflatedSize(self: &mut Router, bytes: i64): void
```

The largest body a gzip or deflate request body may decompress to (default: the
max body size). Past it the request is answered 413, before the handler runs and
without holding more than this many decoded bytes.

#### `Router.stream`

```milo
fn Router.stream(self: &mut Router, pattern: string, h: move (&mut Context, &mut Stream) => void): void
```

Register a GET route that keeps its connection: server-sent events, a long poll.
The handler gets the request's context and the connection as a `Stream`: it
either `open`s the stream and `send`s chunks for as long as it likes, or answers
with an ordinary `respond`. Other tasks reach the client through `conn.outbox()`.
The server owns the socket and closes it when the handler returns. Middleware does
not run, and serveRouterSerial does not honour these routes, since one long-lived
stream would stall a server that answers one connection at a time.

#### `Router.use`

```milo
fn Router.use(self: &mut Router, mw: move (&mut Context, (&mut Context) => Response) => Response): void
```

Add middleware. It receives the context and `next`, the rest of the chain, and
returns the response.

#### `Router.ws`

```milo
fn Router.ws(self: &mut Router, pattern: string, h: move (&mut Context, &mut WebSocket) => void): void
```

Register a WebSocket route. A GET on `pattern` asking to upgrade (`Upgrade:
websocket`) is answered 101 by the server, which then hands the handler the
connection as a `WebSocket`; a GET that does not ask falls through to the other
routes. Ping, pong and the close handshake are the server's, and so is a heartbeat:
a peer silent for a whole 30 s ping interval is dropped. The socket is closed (after
a close frame, if none went out) when the handler returns. As with `stream`,
serveRouterSerial does not honour these routes.

### `ServeOptions`

```milo
pub struct ServeOptions
```

Knobs for the router server (serveRouterWith).

Fields:

- `maxConn: i64 = 512`: Most connections served at once. At the cap the server stops calling accept() until one finishes, so the excess waits in the kernel's listen backlog (see the backpressure note on acceptLoop).
- `drainMs: i64 = 10000`: After SIGTERM: how long requests in flight may keep running before the process exits anyway.
- `readTimeoutMs: i64 = 30000`: How long a client has to send its whole request (headers and body), counted from when the connection's task starts. Without it a client that sends half a request and stalls holds a connection slot forever, and maxConn of them stop the server (slowloris). Not applied to stream or websocket routes once they take over the connection: they have their own timeouts. 0 = no limit.
- `writeTimeoutMs: i64 = 30000`: How long one response write may wait on a peer that has stopped reading. 0 = no limit.

### `Stream`

```milo
pub struct Stream
```

A stream route's connection (see Router.stream): a 200 response whose body the
handler writes in chunks for as long as the client stays.

#### `Stream.open`

```milo
fn Stream.open(self: &mut Stream, contentType: &string, headers: &Vec<Param>): void
```

Start the response: 200, Content-Type `contentType` and `headers`, with the body
sent in chunks (Transfer-Encoding: chunked). Framing headers in `headers`
(Content-Length, Connection, Transfer-Encoding) are dropped: the stream writes its
own. No effect once the stream is open or answered.

#### `Stream.outbox`

```milo
fn Stream.outbox(self: &mut Stream): Outbox
```

A sender other tasks can keep to write to this stream (see Outbox). Once the
stream is over its `send` returns false.

#### `Stream.respond`

```milo
fn Stream.respond(self: &mut Stream, response: &Response, headers: &Vec<Param>): void
```

Answer with an ordinary response instead of a stream (a 404 for an unknown feed).
The stream is over afterwards. No effect once the stream is open or answered.

#### `Stream.send`

```milo
fn Stream.send(self: &mut Stream, data: &string): bool
```

Write `data` as one body chunk, after anything already queued in the outbox. False
before `open` and once the client is gone. An empty `data` writes nothing.

#### `Stream.waitClosed`

```milo
fn Stream.waitClosed(self: &mut Stream): void
```

Park until the client goes away or the stream is ended through its outbox, writing
what other tasks queue meanwhile. Anything the client sends is discarded.

### `StreamRoute`

```milo
pub struct StreamRoute
```

A GET route that keeps its connection (see Router.stream).

Fields: `pattern: string`, `paramNames: Vec<string>`, `handler: (&mut Context, &mut Stream) => void`.

### `WebSocket`

```milo
pub struct WebSocket
```

A ws route's connection (see Router.ws), already upgraded.

#### `WebSocket.close`

```milo
fn WebSocket.close(self: &mut WebSocket): void
```

Start the close handshake (status 1000) after what the outbox holds. `recv` then
returns None once the peer answers.

#### `WebSocket.outbox`

```milo
fn WebSocket.outbox(self: &mut WebSocket): Outbox
```

A sender other tasks can keep to write to this socket (see Outbox). Once the
connection is over its `send` returns false.

#### `WebSocket.recv`

```milo
fn WebSocket.recv(self: &mut WebSocket): Option<string>
```

The next text or binary message's payload, or None once the connection is over:
the peer closed it, broke the protocol, sent a message over the size limit, or went
silent. Pings are answered and pongs absorbed here, and what other tasks queue in
the outbox is written while this waits.

#### `WebSocket.sendText`

```milo
fn WebSocket.sendText(self: &mut WebSocket, msg: &string): bool
```

Send `msg` as a text message, after anything already queued in the outbox. False
once the connection is over or closing.

#### `WebSocket.setMaxMessageSize`

```milo
fn WebSocket.setMaxMessageSize(self: &mut WebSocket, bytes: i64): void
```

The largest message `recv` accepts, in bytes (default 1 MiB). A longer one closes
the connection with status 1009 before its payload is buffered.

### `WsRoute`

```milo
pub struct WsRoute
```

A GET route that upgrades to a WebSocket (see Router.ws).

Fields: `pattern: string`, `paramNames: Vec<string>`, `handler: (&mut Context, &mut WebSocket) => void`.

### Functions

#### `fileResponse`

```milo
pub fn fileResponse(method: &string, reqHeaders: &Vec<Param>, path: &string, contentType: &string): Option<HandledResponse>
```

The response for a GET or HEAD of the file at `path`, or None when it is not a regular
file this process can read. It carries the validators and answers conditional and
range requests (RFC 9110 sections 8.8, 13 and 14):

  ETag           strong, from the file's size and its modification time in nanoseconds
                 ("&lt;size hex>-&lt;mtime ns hex>"), so a 304 costs a stat and no read
  Last-Modified  the modification time, whole seconds
  304            If-None-Match lists the ETag (or is *); without If-None-Match,
                 If-Modified-Since is not before the modification time
  206            a single satisfiable `Range: bytes=` range on a GET, with Content-Range;
                 If-Range must name the current ETag or Last-Modified, else the whole file
  416            a range that starts past the end, with `Content-Range: bytes */<size>`

Several ranges get the whole file (200), which RFC 9110 allows. Cache-Control is left
to the caller: whether a file may be cached is the app's knowledge, not the file's.

#### `headOnly`

```milo
pub fn headOnly(wire: string): string
```

Rendered response bytes cut after the header block.

#### `parseRequest`

```milo
pub fn parseRequest(buf: &[u8; 8192], n: i64): Request
```

Parse a request out of a raw read buffer. Public so an alternate transport
(std/https) can reuse the parser without duplicating it.

#### `renderFor`

```milo
pub fn renderFor(req: &Request, response: &Response, extraHeaders: &Vec<Param>): string
```

The wire bytes for `req`: a HEAD request gets the headers a GET would (Content-Length
included) and no body (RFC 9110 9.3.2). A body after them would be read as the start
of the next response on a kept-alive connection.

#### `renderRaw`

```milo
pub fn renderRaw(status: i32, contentType: &string, body: &string, extraHeaders: &Vec<Param>): string
```

The response bytes, built but not written. Split out of sendRaw so a transport that
is not a bare fd — std/https writes through SSL_write — reuses the exact wire format
instead of reimplementing it. std/http itself stays OpenSSL-free; that separation is
why TLS lives in another module.

Header rules: Content-Type and Server are defaults a handler header of the same
name (case-insensitive) replaces; an empty `contentType` writes no Content-Type. Content-Length, Connection and Transfer-Encoding
describe the framing this function writes, so a handler's copy would contradict
the bytes on the wire and is dropped. 1xx, 204 and 304 never carry a body (RFC 9110
6.4.1): those go out with no body, no Content-Length and no Content-Type.

#### `renderResponse`

```milo
pub fn renderResponse(response: &Response, extraHeaders: &Vec<Param>): string
```

Wire bytes for a Response, including the status line and headers.

#### `serve`

```milo
pub fn serve(port: u16?, handler: (&Request) => Response): Result<Unit>
```

The simplest server: every request goes to `handler`. Good for a static file server
or a single-handler app. Answers one connection at a time, on every interface.

#### `serveRouter`

```milo
pub fn serveRouter(port: u16?, router: Router): Result<Unit>
```

Start an HTTP server using a Router (headers from Context are sent on the wire), on
every interface, with each connection handled in its own green task: a slow or stalled
client, or a handler that panics (the client gets a 500), does not take the others with
it. Stream and websocket routes are served too. See ServeOptions for the connection
cap, the request read and response write deadlines, and the SIGTERM drain.

Never returns once listening, except by exiting the process 0 after a SIGTERM drain
(ServeOptions); a listener that cannot be opened is an Err. The scheduler drives the
accept task, the handlers it spawns and any task the caller spawned earlier, exactly
as a green-threaded server's main is supposed to.

#### `serveRouterOn`

```milo
pub fn serveRouterOn(host: &string, port: u16?, router: Router): Result<Unit>
```

serveRouter bound to one IPv4 address: "127.0.0.1" (or "localhost") for a server
that only a local reverse proxy should reach, "0.0.0.0" for every interface.

#### `serveRouterSerial`

```milo
pub fn serveRouterSerial(port: u16?, router: &Router): Result<Unit>
```

serveRouter answering one connection at a time on this thread, on every interface. Pick
it for a single-threaded, deterministic test, or a program with no green runtime. In a
real server prefer serveRouter: here one stalled client delays all the others and a
handler panic aborts the process. Stream and websocket routes are not served.

#### `serveRouterSerialOn`

```milo
pub fn serveRouterSerialOn(host: &string, port: u16?, router: &Router): Result<Unit>
```

serveRouterSerial bound to one IPv4 address (see serveRouterOn).

#### `serveRouterWith`

```milo
pub fn serveRouterWith(host: &string, port: u16?, router: Router, opts: &ServeOptions): Result<Unit>
```

serveRouterOn with its limits spelled out: the connection cap and the SIGTERM
drain deadline (ServeOptions).

#### `statusText`

```milo
pub fn statusText(status: i32): string
```

The status line's code and reason phrase, e.g. "404 Not Found".

<!-- /generated:api -->
