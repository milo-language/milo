// Per-file prove-verdict ratchet. The refutation baseline next door answers "is any
// contract PROVEN FALSE"; this answers the quieter question "is any contract still
// proven at all". Without it, a contract that degrades from `proven` to `unknown` —
// someone adds a float literal, drops an `ensures` off a callee, rewrites a loop past
// the invariant — leaves the build green, because `unknown` was never a failure. The
// contract text stays in the source looking like a guarantee while nothing checks it.
// That is how unproven contracts accumulate as false confidence.
//
// Direction of each bound:
//   proven  — floor, GATES.   Losing a proof fails the build.
//   errors  — ceiling, GATES. A translator/solver error means an invalid query, always a bug.
//   unknown — recorded, does NOT gate. It rises both when a contract stops being
//             discharged and when previously-invisible obligations start being emitted,
//             and the tally cannot tell those apart. The first case already trips the
//             proven floor, so gating here would only punish coverage improvements.
// Any drift is reported and the numbers should be refreshed to match:
// `bun scripts/verify-contracts.ts --update`.
//
// A file absent from this map is reported but does not fail — a new example must not
// break CI on arrival. Add it when it lands. Platform variants only appear for the host
// that proves them (`.darwin.` here, `.linux.` on a Linux runner), so both sets coexist.
export interface Expected {
  proven: number;
  unknown: number;
  errors: number;
}

export const EXPECTED: Record<string, Expected> = {
  // Was 0 proven / 64 unknown — every VC in the file died on the first float literal,
  // which the SMT translator had no rule for. With `FloatLit` translating and `Pid`
  // carrying `invariant outMin < outMax`, the contracts are checked rather than decorative.
  // The remaining unknowns are `readKey`/`clampF64` postconditions this run cannot see
  // (they live in std, outside the entry file), not a solver limit.
  "examples/embedded/flightController.milo": { proven: 11, unknown: 55, errors: 0 },
  // 3 refuted here are baselined (unbounded-Int model of `setpoint - measured`).
  "examples/embedded/pidStep.milo": { proven: 8, unknown: 0, errors: 0 },
  // neon's stage-pacing rules. Both functions are shaped to stay inside what the
  // bundled Fourier-Motzkin solver decides (<= 3 branches); the four-arm staircase
  // they replaced reported `no integer witness (rational-only)` and needed z3.
  "examples/games/neon/director.milo": { proven: 3, unknown: 0, errors: 0 },
  // Both AES-128 key-length preconditions into std/crypto, proven at the call site.
  "examples/net/termpair/encryption.milo": { proven: 2, unknown: 4, errors: 0 },
  // `Arena`'s `invariant live >= 0` is discharged by construction and by the alloc paths;
  // the free/set/modify paths cannot discharge it (they are gated by an IndexAccess the
  // translator has no rule for), so `arenaLen` reports as a CONDITIONAL proof rather than
  // a clean one. The `live`-delta postconditions on the mutators are what give a CALLER
  // any fact at all about `live` after a call, since a `&mut` arg is otherwise havoced:
  // arenaClear's `live == 0` proves, while arenaAlloc's (StructLit on the return path) and
  // arenaFree's (IndexAccess in the generation check) are true but untranslatable, and are
  // reported as assumed-callee conditionals wherever a caller leans on them.
  "std/arena.milo": { proven: 5, unknown: 6, errors: 0 },
  // The `impl Crypto` namespace wrappers restate the AES key/iv/tag-length `requires` of
  // the private free fns they forward to, so each wrapper's call into the free fn proves
  // its precondition at the wrapper's own call site (10 = 2 aesGcm + 2 aesGcm128 wrappers'
  // encrypt/decrypt obligations across the length checks). The platform arms
  // (std/cryptosys.*) carry no contracts; the facade holds them once for every platform.
  "std/crypto.milo": { proven: 10, unknown: 0, errors: 0 },
  // `fixed` was refuted here until `construct` grew frame conditions (`ensures h.count.len
  // == old(h.count.len)`); the +6 proven is that baseline retiring.
  "std/inflate.milo": { proven: 31, unknown: 44, errors: 0 },
  // `impl Math` static-method postconditions (abs/clamp `ensures result >= ...`); a
  // `Type.method()` call is normalized to a plain Call so the method's contracts verify
  // exactly as the free fns they replaced did.
  "std/math.milo": { proven: 4, unknown: 1, errors: 0 },
  "std/mem.milo": { proven: 4, unknown: 2, errors: 0 },
  // 15 = free-fn VCs plus the `impl Pool` wrappers, which restate poolLive/poolAvailable's
  // liveCount preconditions (Pool has no struct invariant to supply them).
  "std/pool.milo": { proven: 22, unknown: 1, errors: 0 },
  "std/process.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/process.windows.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/pty.darwin.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/pty.windows.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/sort.milo": { proven: 4, unknown: 0, errors: 0 },
  "std/string.milo": { proven: 9, unknown: 21, errors: 0 },
  "std/sync.milo": { proven: 0, unknown: 0, errors: 0 },
};
