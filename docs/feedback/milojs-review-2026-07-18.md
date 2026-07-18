# milojs review findings (2026-07-18), commits ecda9c9..332af30

From an independent review of the last six commits. Every item below was
**reproduced locally** before being recorded — claims that could not be
reproduced are in the last section.

## Confirmed by repro

### 1. GC: values held across a nested call are unrooted → silent corruption

`runtime.milo` claims collection is safe at `execBlock` statement boundaries
because every live value is then in a scope binding. That is false: `execBlock`
nests, so a statement boundary inside a callee is *mid-expression* of its caller,
and `maybeGc` fires at every statement of every body.

Holes: `evalArgs` (`out: Vec<JSValue>` is a plain local), `Expr.Bin` (`va` held
across evaluating `b`), `Expr.Index`/`SetMember` (`ov` held across key/value).

Repro — `f([1,2,3], alloc())` where `alloc` allocates:

    gcThreshold=1024 (default):  3:1:1225   correct
    gcThreshold=1:               2:49:1225  CORRUPTED (bun: 3:1:1225)

The array is swept while `alloc()` runs and its slot reused, so arg 1 arrives as a
different object — wrong length and wrong contents, no crash. Latent at the
default threshold on small programs; it will fire constantly at express scale and
present as unreproducible corruption inside a bundle we do not own.

Note: running the *existing* fixture suite at `gcThreshold=1` passes 16/16 — no
fixture has the `f(literal, call())` shape, so the sweep alone does not catch
this. A targeted fixture is required.

### 2. No strict equality — `===` lexes as `==`, and loose is also wrong

    expr                milojs   bun
    null === undefined  true     false
    "1" === 1           true     false
    [] == 0             false    true

So neither operator is correct: `===` gets coercing semantics, and `==` lacks
ToPrimitive. TS output is overwhelmingly `===`, so the common case has the wrong
semantics. `x !== null` when `x` is `undefined` takes the wrong branch — that is
precisely how zod discriminates `nullable()` from `optional()`. `switch` inherits
it (`case 0` matches `""`).

Strict equality is the *easier* one to implement (same tag, same payload, no
coercion). Do it before executing the bundle.

### 3. A `.then` on a pending promise is dropped, not deferred

    let r; const p = new Promise(res => { r = res; });
    p.then(v => console.log("handler ran", v));
    r(42);
    // bun: "after resolve" then "handler ran 42"
    // milojs: "after resolve" only — handler silently lost

Commit 356cfe1 claims "only interleaving order differs". That is wrong and the
message should be treated as inaccurate. Combined with `await pending` yielding
`undefined` (rather than throwing), the failure mode is silent garbage rather
than a visible hang.

### 4. `class X extends Error` is broken

    class MyErr extends Error { constructor(m) { super(m); this.name = "MyErr"; } }
    new MyErr("boom")   milojs: undefined false MyErr
                        bun:    boom      true  MyErr

A native base gives `funcHandle == -1`, so no prototype link; `super(m)` reaches
`callNative`, which mints a *new* error object and discards `this`, so
`this.message` is never set and `instanceof Error` is false. `TRPCError` and
`ZodError` both extend `Error` — this breaks the target's whole error path.

## Reported but NOT yet reproduced — verify before acting

- Resolver-native lifetime bug: `markValue` treats `Native` as rootless, so
  `Native(NATIVE_RESOLVER_BASE + h*2)` does not keep promise slot `h` alive; a
  stale resolver could settle a *reused* slot's promise. Mechanism is sound on
  inspection and the fix is 3 lines, but no repro was constructed.
- Object rest in patterns (`{a, ...rest}`) and assignment-position patterns
  (`({a} = x)`) silently producing wrong bindings rather than erroring.
- Per-iteration `let` capture in `for`/`for-of` (one loop scope reused).
- Class fields and getters silently dropped.

## Caveat on "0 parse errors"

The parser is deliberately forgiving, so unsupported syntax becomes a silently
wrong AST rather than an error. Some of the zero is object-rest, assignment
patterns, and dropped class fields parsing "successfully". Expect the count to
reopen as execution errors.

## Priority order

1. GC rooting of in-flight values (`evalArgs`, `Bin`, `Index`/`SetMember`)
2. Strict equality as a distinct operator
3. Make pending-await and pending-`.then` loud instead of silent
4. `extends Error`, `super.method`, `Object.defineProperty` getters
5. Missing globals: `Array` (no `Array.isArray`!), `process`, `setTimeout`,
   `Symbol`, `Buffer`
6. Backfill fixtures — nothing since 69edfed has one
7. Event loop + promise reaction queue as ONE milestone with `http`

Prisma is out of reach regardless: `@prisma/client` loads a native napi query
engine. Either stub it at the resolver or scope the milestone to non-DB routes.
