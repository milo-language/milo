// Accepted (baselined) contract refutations: contracts `milo prove` reports as
// `failed` today that are NOT bugs — they are true facts the current native
// solver cannot establish (chiefly struct invariants, which prove-milo does not
// model yet — see docs/verification-roadmap.md). The gate fails on any refuted
// contract NOT listed here, so a genuinely broken contract breaks the build
// while these known solver limits do not. Burn this list down as the verifier
// gains power; the gate also flags a stale entry that has become provable.
//
// Key format: "<repo-relative-file>::<function>".
export const BASELINE: Record<string, string> = {
  "std/arena.milo::arenaLen":
    "ensures result >= 0 needs the struct invariant `live >= 0`, which prove-milo " +
    "cannot model yet (roadmap: struct invariants). `live` never actually goes " +
    "negative — free() generation-checks the handle and returns before the " +
    "decrement, so no valid double-free reaches `live = live - 1`.",
};
