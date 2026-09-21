# std/net

<!-- api: std/net, std/fetch -->

TCP and DNS resolution. The TLS socket (`TlsStream`) and the HTTP client
(`fetch`, `FetchResponse`, `FetchOptions`) live in `std/fetch` — kept out of `std/net`
so a plain-TCP program links without OpenSSL.

```milo
from "std/net" import { resolve, TcpStream, TcpListener, NetError }
from "std/fetch" import { fetch, TlsStream, FetchResponse }
from "std/io" import { writeStdout }
```

## Types

### TcpStream

```milo
struct TcpStream {
    fd: i32,
}
```

An owned TCP socket. Closed when dropped.

### TlsStream

```milo
struct TlsStream {
    fd: i32,
    ssl: i64,
    ctx: i64,
}
```

An owned TLS connection over TCP. Freed when dropped.

### FetchResponse

```milo
struct FetchResponse {
    status: i32,
    headers: string,
    body: string,
}
```

HTTP response returned by the `fetch` functions.

#### FetchResponse.text

```milo
fn FetchResponse.text(self: &FetchResponse): string
```

Return the response body as a string.

#### FetchResponse.json

```milo
fn FetchResponse.json(self: &FetchResponse): Json
```

Parse the response body as JSON.

#### FetchResponse.ok

```milo
fn FetchResponse.ok(self: &FetchResponse): bool
```

True if status is 200-299.

#### FetchResponse.header

```milo
fn FetchResponse.header(self: &FetchResponse, name: &string): Option<string>
```

Get a response header value by name; `None` when the header is absent.

### FetchOptions

```milo
struct FetchOptions {
    method: string,
    headers: string,
    body: string,
}
```

Options for `fetchWith`. Set `headers` as `"Key: Value\r\n"` pairs.

### NetError

```milo
enum NetError {
    DnsFailure(string),
    ConnectionFailed(string),
    TlsError(string),
    SendFailed(string),
    Other(string),
}
```

## Functions

### ip4

```milo
fn ip4(a: u8, b: u8, c: u8, d: u8): u32
```

Construct an IPv4 address from octets.

### resolve

```milo
fn resolve(hostname: &string): Result<u32, NetError>
```

DNS lookup — resolve a hostname to an IPv4 address.

### TcpStream.connect

```milo
fn TcpStream.connect(addr: u32, port: u16): Result<TcpStream, NetError>
```

Open a TCP connection.

### stream.send

```milo
fn send(self: &TcpStream, data: &string): Result<i64, NetError>
```

Send data over a TCP connection. Returns bytes sent.

### stream.recv

```milo
fn recv(self: &TcpStream): Result<string, NetError>
```

Receive data from a TCP connection.

### TlsStream.connect

```milo
fn TlsStream.connect(addr: u32, port: u16, hostname: &string): Result<TlsStream, NetError>
```

Open a TLS connection. The hostname is used for SNI.

### stream.send (TLS)

```milo
fn send(self: &TlsStream, data: &string): Result<i64, NetError>
```

Send data over a TLS connection.

### stream.recv (TLS)

```milo
fn recv(self: &TlsStream): Result<string, NetError>
```

Receive data from a TLS connection.

### fetch

```milo
fn fetch(url: &string): Result<FetchResponse, NetError>
```

HTTP GET with automatic TLS and DNS resolution.

```milo
let resp = fetch("https://httpbin.org/get")!
writeStdout(resp.body)
```

### fetchWith

```milo
fn fetchWith(url: &string, opts: FetchOptions): Result<FetchResponse, NetError>
```

HTTP request with full control over method, headers, and body.

### fetchPost

```milo
fn fetchPost(url: &string, body: &string): Result<FetchResponse, NetError>
```

HTTP POST with a body.

### fetchPut

```milo
fn fetchPut(url: &string, body: &string): Result<FetchResponse, NetError>
```

HTTP PUT with a body.

### fetchDelete

```milo
fn fetchDelete(url: &string): Result<FetchResponse, NetError>
```

HTTP DELETE.

### fetchPatch

```milo
fn fetchPatch(url: &string, body: &string): Result<FetchResponse, NetError>
```

HTTP PATCH with a body.
