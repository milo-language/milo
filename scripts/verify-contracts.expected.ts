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
  "examples/assured/pid/pid.milo": { proven: 24, unknown: 0, errors: 0 },
  "examples/assured/pid/pid_bad_caller.milo": { proven: 8, unknown: 0, errors: 0 },
  "examples/basics/kvstore.milo": { proven: 4, unknown: 19, errors: 0 },
  "examples/embedded/flightController.milo": { proven: 64, unknown: 2, errors: 0 },
  "examples/embedded/pidStep.milo": { proven: 8, unknown: 0, errors: 0 },
  "examples/games/neon/director.milo": { proven: 3, unknown: 0, errors: 0 },
  "examples/net/termpair/encryption.milo": { proven: 2, unknown: 4, errors: 0 },
  "std/arena.milo": { proven: 9, unknown: 2, errors: 0 },
  "std/crypto.milo": { proven: 10, unknown: 0, errors: 0 },
  "std/inflate.milo": { proven: 64, unknown: 11, errors: 0 },
  "std/math.milo": { proven: 4, unknown: 1, errors: 0 },
  "std/mem.milo": { proven: 4, unknown: 2, errors: 0 },
  "std/pool.milo": { proven: 16, unknown: 1, errors: 0 },
  "std/process.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/process.windows.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/pty.darwin.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/pty.windows.milo": { proven: 0, unknown: 0, errors: 0 },
  "std/sort.milo": { proven: 4, unknown: 0, errors: 0 },
  "std/string.milo": { proven: 21, unknown: 13, errors: 0 },
  "std/sync.milo": { proven: 0, unknown: 0, errors: 0 },
};
