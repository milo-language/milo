# std/http

HTTP server with routing and response types.

```milo
from "std/http" import { Request, Response, serve }
```

## Types

### Request

```milo
struct Request {
    method: string,
    path: string,
}
```

Incoming HTTP request passed to the handler.

### Response

```milo
enum Response {
    Text(string),
    Html(string),
    Json(string),
    NotFound,
    Status(i32, string, string),
}
```

- `Text` — `text/plain` 200 response
- `Html` — `text/html` 200 response
- `Json` — `application/json` 200 response
- `NotFound` — 404
- `Status(code, contentType, body)` — custom status and content type

### Socket

```milo
struct Socket {
    fd: i32,
}
```

The listening socket (internal to `serve`).

## Functions

### serve

```milo
fn serve(port: u16?, handler: (&Request) => Response): Result<void>
```

Start an HTTP server. If `port` is omitted, defaults to `8080`. The handler is called for each request. Blocks forever.

## Example

```milo
from "std/http" import { Request, Response, serve }
from "std/json" import { jsonParse }

fn handle(req: &Request): Response {
    if req.path == "/" {
        return Response.Html("<h1>Welcome</h1>")
    }
    if req.path == "/health" {
        return Response.Json("{\"status\": \"ok\"}")
    }
    return Response.NotFound
}

fn main(): i32 {
    serve(3000, handle)
    return 0
}
```
