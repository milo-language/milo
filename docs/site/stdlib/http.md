# std/http

HTTP server with Hono-inspired router, context, middleware, path params, query strings, and cookies.

```milo
from "std/http" import { Context, Response, Router, serveRouter }
```

## Types

### Request

```milo
struct Request {
    method: string,
    path: string,
    queryParams: Vec<Param>,
    headers: Vec<Param>,
    body: string,
}
```

### Param

```milo
struct Param {
    name: string,
    value: string,
}
```

Used for path params, query params, headers, and cookies.

### Context

```milo
struct Context {
    req: Request,
    params: Vec<Param>,
    statusCode: i32,
    respHeaders: Vec<Param>,
}
```

Context is passed to route handlers and provides access to request data and response building.

#### Context Methods

| Method | Description |
|--------|-------------|
| `ctx.param("name")` | Extract path parameter (`:name` in pattern) |
| `ctx.query("key")` | Extract query string value (`?key=value`) |
| `ctx.header("name")` | Read request header (case-insensitive) |
| `ctx.cookie("name")` | Read cookie value from request |
| `ctx.req.body` | Access raw request body |
| `ctx.setStatus(code)` | Set response status code |
| `ctx.setHeader(name, value)` | Add response header |
| `ctx.setCookie(name, value)` | Set response cookie |
| `ctx.setCookieWithOptions(name, value, opts)` | Set cookie with options (`"Path=/; HttpOnly"`) |
| `ctx.deleteCookie(name)` | Delete cookie (Max-Age=0) |
| `ctx.text(body)` | Return text/plain response |
| `ctx.json(body)` | Return application/json response |
| `ctx.html(body)` | Return text/html response |
| `ctx.redirect(url)` | Return 302 redirect |

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

### Router

```milo
struct Router {
    routes: Vec<Route>,
    middleware: Vec<...>,
}
```

#### Router Methods

| Method | Description |
|--------|-------------|
| `Router.new()` | Create a new router |
| `r.get(pattern, handler)` | Register GET route |
| `r.post(pattern, handler)` | Register POST route |
| `r.put(pattern, handler)` | Register PUT route |
| `r.delete(pattern, handler)` | Register DELETE route |
| `r.all(pattern, handler)` | Register route for any method |
| `r.use(middleware)` | Add middleware |

## Functions

### serve

```milo
fn serve(port: u16?, handler: (&Request) => Response): Result<void>
```

Simple server — takes a port and handler function. Good for static file servers or single-handler apps.

### serveRouter

```milo
fn serveRouter(port: u16?, router: &Router): Result<void>
```

Start an HTTP server using a Router. Context `respHeaders` are sent on the wire.

## Examples

### Router with path params

```milo
from "std/http" import { Context, Response, Router, serveRouter }

fn userHandler(ctx: &mut Context): Response {
    let id = ctx.param("id")
    return ctx.json($"\{\"userId\": \"{id}\"}")
}

fn searchHandler(ctx: &mut Context): Response {
    let q = ctx.query("q")
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
    let session = ctx.cookie("session")
    if session.len == 0 {
        ctx.setStatus(401)
        return ctx.json("{\"error\": \"not authenticated\"}")
    }
    return ctx.json($"\{\"session\": \"{session}\"}")
}
```
