// The compile-pool budget for tests/run.test.ts, and the margin warning that fires before
// the budget becomes a failure.
//
// Extracted from the test file for one reason: a warning nobody can trigger is a gate that
// cannot fail. Driving it through the real pool means tuning a timeout until the compile
// lands in the 80-to-100 percent band, which is a coin flip on a loaded machine; as a pure
// function it is three assertions. See tests/poolBudget.test.ts.
//
// Why it scales at all: the budget used to be a flat 300s on posix, and at 683 fixtures a
// linux CI runner crossed it. Bun reports a blown `beforeAll` as `(unnamed) [300003ms]`,
// naming no fixture, so a corpus that had simply grown read as a hang in whichever commit
// happened to tip it over. tests/run.test.ts now stops starting compiles at the budget and
// gives the hook headroom past it, so an overrun fails the unreached fixtures by name with
// the slowest compiles listed, not the whole lane as `(unnamed)`.

/** Milliseconds a compile pool of `n` fixtures gets before the hook is killed. */
export function poolTimeoutMs(n: number, isWindows: boolean): number {
  // Windows CI runners are ~4 cores and clang-on-COFF is slower than the mac/linux path,
  // so both the floor and the per-fixture allowance are larger there.
  if (isWindows) return Math.max(1_500_000, n * 2_200);
  // Generous against the ~0.2s a warm compile takes on a dev machine: the number that has
  // to fit is the slowest runner in CI, not the fastest laptop. ubuntu-latest (4 vCPU, so
  // 2 compile jobs) measured 754ms a fixture at 907 fixtures (684s), past the 700 that
  // used to be here; 1000 puts that run at 75%, under the margin warning.
  return Math.max(300_000, n * 1000);
}

/**
 * The line to warn with when a pool finished uncomfortably close to its budget, or null
 * when there is nothing to say. Returned rather than printed so a test can read it.
 */
export function poolMarginWarning(lane: string, elapsedMs: number, budgetMs: number): string | null {
  if (budgetMs <= 0) return null;
  // Compare the raw ratio and round only for display: rounding first makes 79.7% warn
  // while the message says 80%, which is a surprise for whoever tries to reproduce it.
  if (elapsedMs / budgetMs < 0.8) return null;
  const pct = Math.round((elapsedMs / budgetMs) * 100);
  return `[pool] ${lane}: compiled in ${(elapsedMs / 1000).toFixed(0)}s of a ${(budgetMs / 1000).toFixed(0)}s budget (${pct}%) — raise the per-fixture allowance in tests/pool-budget.ts before the fixtures it cannot reach fail as not compiled`;
}
