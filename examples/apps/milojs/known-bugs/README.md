# Known-failing cases

Reproductions of open bugs. Not wired into `tests/run.sh` — the suite is kept
green, and a failing fixture there would stop being informative. Run them by
hand.

## promiseAllGcRoot.js — a live promise chain is collected

    milojs known-bugs/promiseAllGcRoot.js            # ReferenceError: out is not defined
    MILOJS_GC_THRESHOLD=100000000 milojs known-bugs/promiseAllGcRoot.js   # passes

`out` is not in the test. It is the accumulator inside the prelude's
self-hosted `Promise.all`:

    var out = [];
    ...
    out[idx] = v;

So the closure a promise reaction captured has been collected while the chain
was still live, and the callback resumes with its captured scope gone.

Deterministic, and it needs all three of: nested async calls, a fire-and-forget
async call whose promise nobody holds, and enough allocation to trigger a
collection. Any one alone passes.

What is known:

- Reactions are marked only when their promise object is marked
  (`runtime.milo`, `markObject`, the `promiseState >= 0` branch).
- There is no root pass for pending promises. A pending promise is reachable
  only through whatever will settle it — for a timer-backed promise that is the
  timer callback's closure, which reaches the resolver native, which roots the
  promise. Somewhere in the `Promise.all` case that chain does not hold.

Why it matters: this is the same failure class as the `ReferenceError: value is
not defined` seen from the tahoeroads app, and it reproduces on committed main
with no await-suspension work involved. It is a strong candidate for the app's
remaining flakiness.
