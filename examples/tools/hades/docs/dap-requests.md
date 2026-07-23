# DAP request cheatsheet

What hades sends over stdio. Full spec: `/tmp/dap.txt` (DAP reference dump).

Framing: `Content-Length: N\r\n\r\n<N bytes JSON>`
- request:  `{"seq":S,"type":"request","command":C,"arguments":{…}}`
- response: `{"type":"response","request_seq":S,"command":C,"success":bool,"body":{…}}`
- event:    `{"type":"event","event":E,"body":{…}}`  (unsolicited)

Client reads frames until `request_seq` matches, dispatching events passed on the
way. Response-vs-event ordering is **not** guaranteed.

## Handshake
| command | arguments | notes |
|---|---|---|
| `initialize` | `{"adapterID":"lldb","linesStartAt1":true,"columnsStartAt1":true}` | resp.body = capabilities. Adapter then emits `initialized` event. |
| `launch` | `{"program":"/path/bin","stopOnEntry":false,"args":[…],"cwd":"…"}` | or `attach` `{"pid":N}`. Adapter defers actual start to `configurationDone`. |
| `configurationDone` | `{}` | sent AFTER breakpoints; releases the debuggee. |

## Breakpoints (set on `initialized`, before `configurationDone`)
| command | arguments |
|---|---|
| `setBreakpoints` | `{"source":{"path":"/f.c"},"breakpoints":[{"line":6},{"line":12,"condition":"x>3"}]}` |
| `setFunctionBreakpoints` | `{"breakpoints":[{"name":"add"}]}` |
| `setExceptionBreakpoints` | `{"filters":["cpp_throw","cpp_catch"]}` |

## Stop events (unsolicited)
| event | body |
|---|---|
| `stopped` | `{"reason":"breakpoint"|"step"|"exception"|"pause","threadId":N,"hitBreakpointIds":[…]}` |
| `output` | `{"category":"stdout"|"stderr"|"console","output":"text"}` |
| `terminated` / `exited` | `{}` / `{"exitCode":N}` |
| `thread` | `{"reason":"started"|"exited","threadId":N}` |

## Inspection (only while stopped)
| command | arguments | returns |
|---|---|---|
| `threads` | `{}` | body.threads = `[{id,name}]` |
| `stackTrace` | `{"threadId":N,"startFrame":0,"levels":20}` | body.stackFrames = `[{id,name,line,source}]` |
| `scopes` | `{"frameId":F}` | body.scopes = `[{name:"Locals",variablesReference:R}]` |
| `variables` | `{"variablesReference":R}` | body.variables = `[{name,value,type,variablesReference}]` — nested R>0 → expand |
| `evaluate` | `{"expression":"a+b","frameId":F,"context":"repl"|"watch"|"hover"}` | body = `{result,type,variablesReference}` |
| `setVariable` | `{"variablesReference":R,"name":"x","value":"99"}` | |

## Execution control (each resumes → new stopped/terminated)
| command | arguments |
|---|---|
| `continue` | `{"threadId":N}` |
| `next` (step over) / `stepIn` / `stepOut` | `{"threadId":N}` |
| `pause` | `{"threadId":N}` |
| `disconnect` | `{"terminateDebuggee":true}` |

## Typical session order
```
initialize → (initialized) → setBreakpoints → configurationDone
  → launch resp → stopped(breakpoint) → stackTrace → scopes → variables
  → continue → output → terminated
```

## MCP mapping (future)
One tool per command; tool args == the JSON `arguments`; tool result == resp.body.
The client already routes events, so tools stay pure request/response.
