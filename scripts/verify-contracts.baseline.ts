// Accepted (baselined) contract refutations.
//
// These are contracts `milo prove` reports as
// `failed` today that are NOT bugs — they are true facts the current native
// solver cannot establish (chiefly struct invariants, which the translator does not
// model yet — see docs/verification-roadmap.md). The gate fails on any refuted
// contract NOT listed here, so a genuinely broken contract breaks the build
// while these known solver limits do not. Burn this list down as the verifier
// gains power; the gate also flags a stale entry that has become provable.
//
// Key format: "<repo-relative-file>::<function>".
export const BASELINE: Record<string, string> = {
  "examples/assured/pid/pid_bad_caller.milo::controlTickUnclamped":
    "the planted mistake in the requirements demo: the caller hands pidStep a raw sensor " +
    "value, violating its LLR-3 `requires`. The refutation IS the demo (the matrix shows a " +
    "FAILED call site); pid.milo's controlTick is the fixed version and proves clean.",
  "std/mem.milo::Bump.remaining":
    "bumpRemaining requires `used <= cap` and ensures `result >= 0`. That's a true " +
    "Bump invariant — every constructor/alloc maintains used <= cap — but the caller " +
    "(the Bump.remaining wrapper) holds an arbitrary &Bump the solver won't assume the " +
    "invariant for, so it refutes with used=1,cap=0. Propagating `requires used <= cap` " +
    "onto the wrapper would be tautological ceremony on a getter; retire this once " +
    "the translator models struct invariants (docs/verification-roadmap.md).",
  "std/arena.milo::arenaAlloc":
    "the runtime capacity guard `assert(idx <= 2147483647)`, now a proof obligation " +
    "because `assert` became a proof cut (docs/verification-roadmap.md). `idx` is " +
    "`a.data.len`, which the model knows only to be non-negative — nothing bounds a Vec's " +
    "length above, so the solver refutes with len = 2^31. That is the assert doing its " +
    "job: it exists precisely because the bound cannot be established statically, and it " +
    "aborts at runtime if it is ever reached. Retiring this needs a length bound in the " +
    "model, not a change to the code.",
  "examples/embedded/pidStep.milo::pidStep":
    "call-site preconditions for fpMul(kp, error) / fpMul(ki, newIntegral) / " +
    "fpMul(kd, derivative). fpMul requires its args >= i32::MIN, which no i32 can " +
    "violate — but only PARAMS carry a range assumption, not intermediate arithmetic. " +
    "`error = setpoint - measured` is a subtraction of two i32s, so the unbounded-Int " +
    "model lets it reach -2^32 and refutes. In the real program that subtraction would " +
    "trap on overflow in a debug build long before fpMul is reached, so the values are " +
    "always in range. Needs range-carrying arithmetic (or a bitvector model) to retire.",
};
