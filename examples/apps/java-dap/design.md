# java-dap — a JVM Debug Adapter in Milo

A standalone DAP adapter for Java, written in Milo. Speaks DAP (JSON over stdio)
to any DAP client — Hades first — and JDWP (binary over TCP) to the JVM. No
Eclipse, no jdt.ls, no JVM-side code: the debug agent ships inside every JVM
(`-agentlib:jdwp`), so the entire adapter is a protocol translator.

```
Hades ⇄ DAP (Content-Length JSON, stdio) ⇄ java-dap ⇄ JDWP (binary, TCP) ⇄ JVM
```

Why this is tractable: JDWP is a stable (~25 years), fully documented,
length-prefixed binary protocol. The adapter is one codec, one event loop, and
a mapping table. The DAP half already exists in this repo — hades'
`framing.milo` is reusable verbatim (Content-Length framing is shared
transport, not hades-specific).

## Integration with Hades

java-dap is a stdio adapter: hades spawns it via the existing dialect registry
(`hades/src/dap/session.milo`). New dialect entry, roughly:

- `adapterId: "java"`, probes: `["java-dap"]` (the built Milo binary on PATH or
  resolved relative to the repo)
- launch keys (VS Code `java` dialect compatible where cheap):
  - `mainClass` (string, required for launch)
  - `classPaths` (array of strings)
  - `args`, `vmArgs` (strings)
  - attach mode: `hostName`, `port`

## JDWP primer (the whole protocol in one page)

Transport: TCP. Debuggee started with

```
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=5005 -cp <cp> <mainClass>
```

`suspend=y` parks the VM before `main` so breakpoints can be set first.

**Handshake:** client sends the 14 ASCII bytes `JDWP-Handshake`; server echoes
the same 14 bytes. Then packets flow both directions asynchronously.

**Packet header (11 bytes, all big-endian):**

```
length  u32   total length including this header
id      u32   client-chosen; reply carries the same id
flags   u8    0x80 = reply packet
-- command packet:            -- reply packet:
cmdSet  u8                    errorCode  u16   (0 = success)
cmd     u8
```

The JVM also sends *commands* to us: event packets (cmdSet 64, cmd 100,
"Composite"). Everything else we receive is a reply to something we sent.

**Wire types:**

- `string`: u32 length + UTF-8 bytes
- `location`: u8 typeTag + classID + methodID + u64 index (bytecode offset)
- `value`: u8 tag + payload; tags are ASCII: `I`=int `J`=long `Z`=boolean
  `B`=byte `S`=short `C`=char `F`=float `D`=double `V`=void, `L`=object,
  `s`=String, `t`=thread, `[`=array
- IDs (objectID, threadID, classID/referenceTypeID, methodID, fieldID,
  frameID): **variable width**. First real command after handshake MUST be
  `VirtualMachine.IDSizes (1,7)` — reply gives 5 sizes (field, method, object,
  referenceType, frame). HotSpot uses 8 for all, but read them anyway and
  parameterize the codec. Store IDs as `i64` internally.
- Class signatures are JNI format: `Lcom/example/Main;`

**Command subset for the MVP** (cmdSet, cmd):

| Command | Use |
|---|---|
| VirtualMachine.IDSizes (1,7) | first call; sizes for codec |
| VirtualMachine.Version (1,1) | banner / sanity |
| VirtualMachine.AllThreads (1,4) | DAP `threads` |
| VirtualMachine.Suspend/Resume (1,8/9) | `pause` / `continue` |
| VirtualMachine.ClassesBySignature (1,2) | is class loaded yet? |
| VirtualMachine.Dispose (1,6) | `disconnect` (leave JVM running) |
| VirtualMachine.Exit (1,10) | `terminate` |
| ReferenceType.Signature (2,1) | classID → name |
| ReferenceType.SourceFile (2,7) | classID → `Main.java` |
| ReferenceType.Methods (2,5) | method list for line lookup |
| ReferenceType.Fields (2,4) | object member names |
| Method.LineTable (6,1) | line ↔ bytecode index |
| Method.VariableTable (6,2) | locals: names, slots, liveness ranges |
| ObjectReference.ReferenceType (9,1) | dynamic type of a value |
| ObjectReference.GetValues (9,2) | field values |
| StringReference.Value (10,1) | java.lang.String → text |
| ThreadReference.Name (11,1) | thread names |
| ThreadReference.Frames (11,6) | DAP `stackTrace` |
| ArrayReference.Length/GetValues (13,1/2) | array expansion |
| EventRequest.Set (15,1) | breakpoints, steps, class-prepare |
| EventRequest.Clear (15,2) | remove breakpoints / cancel steps |
| StackFrame.GetValues (16,1) | locals by slot |
| StackFrame.ThisObject (16,3) | `this` scope |
| Event.Composite (64,100) | ← everything the JVM tells us |

**Event kinds:** SINGLE_STEP=1, BREAKPOINT=2, EXCEPTION=4, THREAD_START=6,
THREAD_DEATH=7, CLASS_PREPARE=8, VM_START=90, VM_DEATH=99.
**Suspend policy:** 0=none, 1=event thread, 2=all (we request 2 — matches
DAP's stopped-world model that hades presents).
**EventRequest modifiers (the ones we use):** Count=1, ClassMatch=5,
LocationOnly=7, Step=10. **Step:** depth INTO=0 OVER=1 OUT=2, size LINE=1.

## Codec sketch (Milo)

Binary strings are just owned byte buffers in Milo — same trick as `std/hex`.
Writer builds with `push`, reader walks a cursor. Big-endian throughout.

```milo
struct PacketWriter { buf: string }

fn PacketWriter.u8(self: &mut PacketWriter, v: u8): void { self.buf.push(v) }
fn PacketWriter.u16(self: &mut PacketWriter, v: i64): void {
    self.buf.push(((v >> 8) & 255) as u8)
    self.buf.push((v & 255) as u8)
}
fn PacketWriter.u32(self: &mut PacketWriter, v: i64): void { ... }
fn PacketWriter.u64(self: &mut PacketWriter, v: i64): void { ... }
// id width comes from IDSizes — codec is parameterized, not hardcoded 8
fn PacketWriter.objectId(self: &mut PacketWriter, v: i64, sizes: &IdSizes): void { ... }
fn PacketWriter.str(self: &mut PacketWriter, s: &string): void {
    self.u32(s.len)
    self.buf = self.buf + s.clone()
}

struct PacketReader { buf: string, pos: i64 }
// mirror: u8/u16/u32/u64/objectId/str, each advancing pos
```

Socket reads go through `FdReader` (`std/io`) attached to the raw fd from
`TcpStream.take()` — `readExact(4)` for the length word, then
`readExact(length - 4)` for the rest. No chunk-reassembly code needed; that's
exactly the pattern hades' DAP framing already uses.

## Concurrency model

Three green tasks, hades-style:

1. **DAP loop (main):** `readFrame(stdin)` → dispatch request → write response.
2. **JDWP reader task:** loop `readExact` packets off the socket. Replies
   (flag 0x80) go into a pending-reply map keyed by packet id; event packets
   (64,100) go onto an event `Channel`.
3. **Event pump task:** drains the event channel, translates each JDWP event
   into DAP events (`stopped`, `thread`, `exited`, `terminated`), and runs the
   deferred-breakpoint logic on CLASS_PREPARE.

JDWP request/reply from the DAP loop is synchronous-over-async: send packet,
park on a per-request channel until the reader task delivers the reply
(`Channel<string>` per in-flight id; `std/runtime` Task + Channel — all
already shipped in the async-orthogonality work).

Plus a **stdout forwarder** in launch mode: the JVM child's stdout/stderr are
pumped into DAP `output` events (same pattern as hades' pty handling, but a
plain pipe suffices — no pty needed for MVP).

## Breakpoint lifecycle (the one genuinely fiddly part)

DAP `setBreakpoints` gives `{source: "src/Main.java", lines: [12, 30]}`. JDWP
wants `(classID, methodID, bytecodeIndex)`. Resolution:

1. **File → class name:** parse the `package` declaration from the source file
   (one regex-free scan), join with the filename stem:
   `src/Main.java` + `package com.example;` → `com.example.Main`.
   Inner/anonymous classes come later via ClassMatch pattern `com.example.Main*`.
2. **Loaded?** `ClassesBySignature("Lcom/example/Main;")`.
   - **Yes:** `Methods` → for each method `LineTable` → find the method whose
     table contains the line → `EventRequest.Set(BREAKPOINT, suspend=ALL,
     [LocationOnly(loc)])`. Reply's requestID is our handle for Clear.
   - **No (the common case — VM is suspended pre-main):** register
     `EventRequest.Set(CLASS_PREPARE, [ClassMatch("com.example.Main*")])`,
     stash the pending lines, answer DAP with `verified: false`. When the
     CLASS_PREPARE event fires, run the "yes" path and emit DAP
     `breakpoint` (changed, `verified: true`) events. Resume the event thread.
3. Re-`setBreakpoints` for a file = clear that file's old requestIDs, set anew
   (DAP semantics: the list replaces).

## Stack, scopes, variables

- `stackTrace`: `ThreadReference.Frames` → per frame `(frameID, location)`;
  location → `ReferenceType.SourceFile` + `Method.LineTable` reverse lookup
  (bytecode index → nearest line ≤ index). Source path: report
  `sourceDir + package path + SourceFile`; take a `sourceRoots` launch key.
- `scopes`: two — Locals (frameID) and This.
- `variables` for Locals: `Method.VariableTable` gives (name, slot, signature,
  liveness); filter to slots live at current bytecode index;
  `StackFrame.GetValues(frameID, slots)` → tagged values.
- Rendering values: primitives formatted directly; tag `s` →
  `StringReference.Value`; tag `L` → `ObjectReference.ReferenceType` +
  `Signature` for the type name, children via `Fields` + `GetValues`; tag `[`
  → `ArrayReference.Length` + paged `GetValues`.
- `variablesReference` handles: adapter-local map i64 → (kind, objectID/frameID),
  reset on each stop (DAP allows invalidation on resume).

## DAP request mapping (MVP)

| DAP | JDWP |
|---|---|
| initialize | none — reply with capabilities (no conditional bp, no eval, supportsConfigurationDoneRequest) |
| launch | spawn `java -agentlib:jdwp=...,server=y,suspend=y,address=<port>` via `Child.spawn`, poll-connect TCP, handshake, IDSizes, then DAP `initialized` |
| attach | TCP connect to `hostName:port`, handshake, IDSizes, `initialized` |
| setBreakpoints | lifecycle above |
| configurationDone | `VirtualMachine.Resume` (releases suspend=y) |
| threads | AllThreads + Name each |
| stackTrace / scopes / variables | above |
| continue | Resume; emit `continued` |
| pause | Suspend; synthesize `stopped(reason=pause)` |
| next / stepIn / stepOut | EventRequest.Set(SINGLE_STEP, [Step(thread, LINE, depth), Count(1)]); auto-cleared on fire (Count) |
| evaluate | MVP: dotted-path lookup against locals/this only (`foo.bar.baz`); no compilation |
| disconnect | Dispose (attach) / Exit or kill child (launch) |

JDWP threadIDs are u64; DAP wants small ints — keep a bidirectional map,
allocate DAP ids 1..N as threads appear.

## Milestones

- **M1 — wire:** codec, handshake, IDSizes, Version; CLI `java-dap --attach
  localhost:5005 --smoke` prints VM version and thread list. Proves codec
  against a real JVM.
- **M2 — stop machine:** attach, reader/event tasks, breakpoint lifecycle,
  continue/step; DAP over stdio; drive from hades CLI against a fixture.
- **M3 — inspection:** stackTrace/scopes/variables, string/object/array
  rendering, evaluate-as-path.
- **M4 — launch mode:** spawn JVM, stdout→output events, exit propagation
  (VM_DEATH → `terminated`).
- **M5 — polish:** exception breakpoints (EXCEPTION events + ExceptionOnly
  modifier), inner-class ClassMatch, hades dialect entry + docs page,
  showcase entry in examples.

## Testing

- `tests/fixtures/`: a couple of tiny `.java` files (loop + method calls +
  object graph). Test script compiles with `javac` (skip suite cleanly if no
  JDK on PATH — same pattern as other env-dependent example tests).
- Scripted DAP session runner: feed a canned request sequence over stdio,
  assert on the event/response stream (hades' test approach reused).
- Codec unit tests are pure Milo fixtures: golden hex for packets
  (hexEncode from `std/hex` makes assertions readable).

## Non-goals (deliberate)

- Expression evaluation beyond variable paths (java-debug needs the entire JDT
  compiler for this; out of scope, maybe forever)
- Hot code replace
- Maven/Gradle classpath resolution — user supplies `classPaths`; a thin
  `--classpath-from-gradle` helper can shell out later
- JVMTI / native agents — JDWP socket only
- Remote debugging niceties (source mapping across hosts) beyond `sourceRoots`

## References

- JDWP spec: https://docs.oracle.com/javase/8/docs/platform/jpda/jdwp/jdwp-protocol.html
- JDWP transport docs: https://docs.oracle.com/javase/8/docs/technotes/guides/jpda/jdwp-spec.html
- DAP spec: https://microsoft.github.io/debug-adapter-protocol/specification
- Prior art: microsoft/java-debug (JDI-based, jdt.ls-hosted), kotlin-debug-adapter (standalone JDI)
