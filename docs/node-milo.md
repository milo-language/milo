<!-- doc-meta
system: node-milo
purpose: public-facing page showcasing the node-milo runtime port — a Node.js runtime re-hosted on the Milo compiler
key-files: (external fork) https://github.com/cs01/node tree/milo
update-when: node-milo compat numbers change
last-verified: 2026-07-15
owner-persona: showcase
-->

# node-milo — a Node.js runtime re-hosted on Milo

A Node.js runtime re-hosted on the Milo compiler: the bindings are written in a new systems language, a ~6k-LOC native seam, and it runs real npm packages. True and, we think, worth showing.

In **[node-milo](https://github.com/cs01/node)** (fork, branch `milo`), the native binding and runtime seam of a Node.js runtime is written in Milo — the syscall bindings, the event loop, and the V8 embedding layer, roughly **6,200 lines of Milo** — sitting underneath **~19,000 lines of ported Node.js standard library** in JavaScript. It boots a real V8 isolate and runs real, pure-JS npm packages: **Express serves live**, with routing, `:id` route params, and an HTTP server+client roundtrip returning HTTP 200.

The trust boundary is the same one Bun draws with JavaScriptCore: V8 stays C++, and the memory-safe Milo layer is the seam around it. Milo doesn't make JavaScript *execution* memory-safe — that's V8's job — but the syscall and event-loop plumbing that Node writes in C++, node-milo writes in Milo. And where Node ships a hand-written C HTTP parser (the class of code behind more than one Node CVE), node-milo's **HTTP parser, HTTP/2 frame codec, and HPACK are pure JavaScript** — no hand-written C parser in that path at all.

**What's real today:**

- Boots a real V8 isolate; runs real pure-JS npm packages (Express verified end-to-end: routing, params, HTTP roundtrip, 200).
- Memory-safe Milo for the parts Node writes in C++: syscall bindings, event loop, V8 embedding seam (~6,200 lines Milo).
- JS standard library layer is JavaScript, as in real Node (~19,000 lines ported).
- HTTP/1 parser, HTTP/2 frame codec, and HPACK are pure JS.
- `fs` module passes **88%** (177/201) of its curated test set; **~40%** of a curated Node.js compat suite overall, and climbing.

**What it is not (yet):** early and in progress, not a drop-in Node replacement. It passes a *curated subset* of Node's tests, not the full suite — treat the numbers above as a snapshot, not a compatibility guarantee. The realistic ceiling is roughly **60–70%** of that curated suite, not 100% — no independent Node runtime (Bun, Deno) hits full parity either. **Native addons (`.node` / N-API) are not supported**, so ecosystem reach is limited to pure-JavaScript packages. And to be exact about the safety claim: V8 is C++, so JavaScript execution is not memory-safe — the Milo guarantee covers the runtime layer around V8, not the engine inside it.

The honest headline: **Milo self-hosts, and it has compiled a memory-safe Node.js runtime layer that runs real npm packages like Express.**
