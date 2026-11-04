<!-- doc-meta
system: prove-rte
purpose: triage of `milo prove --rte` on real Milo code (milojs, tahoeroads api): totals, 30 failed and 10 unknown sampled by hand, and the prover fixes that cut the most noise
key-files: src/prove-milo.ts, src/verify.ts, scripts/rte-census.ts
update-when: the RTE prover changes enough to re-run the experiment
last-verified: 2026-11-03
status: findings, one-off experiment
-->

# `milo prove --rte` triage on real code (2026-11)

Question: is the silver prover worth pitching on real programs?

## Method

`milo prove FILE --rte --solver=z3 --json` run once per file over `~/git/milojs/src/**/*.milo` (28 files, 52.8k lines)
and `~/git/digitalocean/tahoeroads/api-milo/*.milo` (32 files). Neither repo was modified. Each file was run as its
own entry (imports are walked, obligations reported by function). Sites are deduped by `fn + description` across
files and counted at their worst verdict (failed > unknown > proven), the same rule as `scripts/rte-census.ts`.
`rte-census.ts` itself joins its targets onto the repo root, so it cannot take these absolute paths; the driver was a throwaway script.

60s limit per file. Five milojs files exceeded it and were skipped:
`engine/lexer.milo`, `engine/value.milo`, `engine/parser.milo`, `engine/eval.milo`, `engine/methods.milo`.
Their obligations are not in the numbers below (those are the largest, most interesting files).

## Totals (distinct sites)

| kind | proven | failed | unknown |
|---|---|---|---|
| bounds | 82 | 260 | 1054 |
| overflow | 469 | 159 | 995 |
| division | 2 | 1 | 3 |
| all (incl. 3 contract kinds) | 569 | 420 | 2075 |

Only about 19% of sites are proven; 14% are failed; 68% are unknown. Failed here means "counterexample exists
under the prover's model", which is not the same as reachable.

## 30 failed, hand-triaged (round-robin across files, so no file dominates)

REAL 0, SPEC 15, NOISE 15.

| # | site | expression | verdict | why |
|---|---|---|---|---|
| 0 | host.milo:53 | `st.sqliteStmts[s]` | SPEC | handle `s` valid by construction |
| 1 | modules.milo:377 | `path[i]` | NOISE | `i < len` guard present; `i >= 0` lost (no loop fact) |
| 2 | napi.milo:1651 | `_func - 1` | SPEC | only wraps at i64 MIN; napi ids are small |
| 3 | libmilojs.milo:84 | `i + 1` | NOISE | `i < n` loop counter, no loop bound fact |
| 4 | complete.milo:192 | `st.objects[cur]` | SPEC | proto chain indices valid (heap invariant) |
| 5 | uniprops.milo:51 | `k + 1` | NOISE | `k < needle.len()` in loop condition |
| 6 | repl.milo:113 | `out[3]` on `&mut [i64; 4]` | NOISE | fixed array length not modelled for a ref param |
| 7 | strutil.milo:122 | `(n - m) + j` | NOISE | has `invariant j >= 0 && j <= m`; `m <= n` guard; len >= 0 facts not used |
| 8 | bytecode.milo:1232 | `i + 1` | NOISE | loop counter, `i + 1 >= len` guard follows |
| 9 | realm.milo:250 | `st.realms[r]` | SPEC | `r` is a realm id, valid by construction |
| 10 | runtime.milo:2149 | `st.objects[obj]` | SPEC | object handle invariant |
| 11 | bigint.milo:96 | `v[k]` | NOISE | `k = len-1; while k >= 0`; upper bound `k < len` lost across iterations |
| 12 | bootstrap.milo:56 | `i + 1` | NOISE | `i < names.len()` loop counter |
| 13 | ast.milo:340 | `prog.srcNames[i]` | NOISE | `i < len` guard; `i >= 0` lost. The parallel `srcTexts[i]` on 341 is SPEC (two Vecs, same length) |
| 14 | builtins.milo:1652 | `c.pos + 1` | SPEC | `pos <= s.len` cursor invariant on the JCur struct |
| 15 | stackscan.milo:97 | `buf + 48` | SPEC | `buf` is a stack address |
| 16 | rooted.milo:129 | `i + 1` | NOISE | `while i < n`, `n = self.len()` |
| 17 | regex.milo:1360 | `s[sp]` | SPEC | callers guarantee `sp < s.len()`; unwritten precondition |
| 18 | milojs-engine.milo:91 | `argv[ai]` | NOISE | `ai < argv.len()` loop guard; `ai >= 0` lost |
| 19 | chatLimits.milo:34 | `now - burstMs` | SPEC | timestamps and constants in a sane range |
| 20 | adminReferrer.milo:14 | `url[end]` | NOISE | `end < url.len`; `start = indexOf(..)+11` needs an `indexOf` ensures |
| 21 | adminFeedback.milo:109 | `yes + no` | SPEC | counters are small |
| 22 | app.milo:196 | `outcomes[0]` | SPEC | non-empty because `path.split(",")` always yields >= 1 element; unwritten |
| 23 | forecast.milo:89 | `d[i]` | NOISE | `i < d.len` guard, `i = p + 1` with `p` from `indexOf` (no ensures) |
| 24 | auth.milo:112 | `s[i]` | SPEC | `from >= 0`, `max <= s.len` hold at both call sites, nowhere stated |
| 25 | camprobe.milo:50 | `((y*w)+x)*channels` | SPEC | `Image` width/height/channels are decoder-bounded |
| 26 | admin.milo:119 | `order[j]` | NOISE | insertion sort; `j <= i < len` needs a loop invariant on `j` |
| 27 | chatStore.milo:84 | `now - RETAIN_MS` | SPEC | timestamp range |
| 28 | pages.milo:108 | `path[end - 1]` | NOISE | `end` starts at `len` and only decreases; `end > 0` guard; upper bound lost |
| 29 | express.milo:119 | `s[i]` | SPEC | public fn with `i >= len` guard but no `i >= 0`; both callers pass `k + 1` with `k >= 0` |

No sampled failed site is a bug a user can trigger today. The nearest to REAL are #29 (a negative `i` panics, but no
caller passes one) and #22 (empty `outcomes` would panic, but `split` cannot return empty). Both are "one invariant
nobody wrote down" and are the kind of finding a spec-writing workflow turns into a precondition.
A real hit rate of 0/30 means the true rate is below roughly 10% at 95% confidence; it is not zero evidence.

Failed results carry only "counterexample exists" in the JSON; no model values are printed, so the triage reads
source by hand. Printing the counterexample would roughly halve triage time and is itself a fix (see below).

## 10 unknown, sampled

| # | site | blocker |
|---|---|---|
| 0 | host.milo:274 `buf[bi]` | method call `.readStdout` has no SMT rule |
| 1 | modules.milo:132 `spec[4]` | IndexAccess + CharLit in the guard (`spec[0] == 'n'`...) untranslated |
| 2 | napi.milo:826 `base + NAPI_PD_METHOD` | `napiLoadI64` is extern/no `ensures` |
| 3 | milojs.milo:198 `st.objects[glob]` | `newObject` has no `ensures` (should say len grows by 1, result = old len) |
| 4 | libmilojs.milo:64 `CastExpr + i` | `out_len` after loop, no invariant names it |
| 5 | complete.milo:122 `kinds[j-1]` | IndexAccess untranslated in the loop condition |
| 6 | uniprops.milo:120 `lo + vals[1]` | IndexAccess + CharLit + `upFindLine` without `ensures` |
| 7 | repl.milo:391 `i + 1` | `out_len` after two loops, no invariant |
| 8 | strutil.milo:125 `j + 1` | IndexAccess (`s[..] != sub[j]`) in the branch condition untranslated |
| 9 | bytecode.milo:1362 `pc + 2` | IndexAccess untranslated (`c.ops[pc]` match) |

## Unknown causes over the whole run

Counted as mentions in `detail`; one site can name several, so these overlap (2075 unknown sites).

| rank | cause | mentions |
|---|---|---|
| 1 | call to a function with no `ensures` (top: `vmSeedFrame` 212, `newObject` 24, `reEmit` 24, `epochMillis` 16, `schedulerCurrent` 13, `napiLoadI64` 12) | 1322 |
| 2 | IndexAccess (`v[i]`, `s[i]` as a value) not translated | 1131 |
| 3 | CharLit not translated | 452 |
| 4 | loop-exit values with no invariant (`out_len` etc.) | 210 |
| 5 | StringLit not translated | 148 |
| 6 | value after a callee with no contract (stale state havoc) | 98 |
| 7 | method calls not translated | 69 |
| 8 | DefaultValue / Unwrap / EnumLit / operators | ~35 |

Unknowns are not timeouts; the five skipped files are the timeouts.

## Conclusion

Do not pitch yet on defect finding. Of 30 failed sites, 0 were bugs; half were prover noise and half were real
invariants that nobody wrote down. Only 19% of sites were proven, so most of the value is lost before any soundness question.
What the run supports pitching is the spec-gap workflow ("every failed site names an unwritten invariant"), not
"finds crashes", and only after the fixes below. On the tahoeroads API (small files) the per-file runs finished in
2 to 10 seconds, which is already usable.

Three fixes that cut the most noise and unknown, in order:

1. Translate `IndexAccess` and `CharLit` (and `StringLit`) as uninterpreted reads: an array of `i64`/`u8` indexed by
   the translated index, with `len` facts. Removes the blocker on roughly 1100 + 450 + 150 unknown mentions, and
   stops branch conditions like `s[i] == '&'` from poisoning whole functions.
2. Seed loops with the facts that hold anyway: the loop guard (`i < n`) on entry to the body, and `i`'s sign and
   monotonicity for `var i = c; while i < n { i = i + 1 }` and `for i in a..b` (the counter stays within
   `[start, bound]`). This is the cause of NOISE #1, 3, 5, 8, 11, 12, 13, 16, 18, 23, 26, 28 (12 of 15) and also
   the 210 "after the loop" unknowns. Also assume `len() >= 0` and fixed array lengths (#6, #7).
3. Auto-model calls with no `ensures`: either infer simple ensures for small non-recursive callees (`newObject` pushes
   one element and returns the old length; `indexOf` result is `-1` or within `[0, len)`), or havoc only the
   state the callee writes instead of everything (`vmSeedFrame` alone is 212 unknowns).

Also: print the counterexample model on failed sites, and bound proving time per function so the five largest files finish.

## After the fixes (2026-11-03)

`src/verify.ts` now (1) lowers `IndexAccess` as a fresh free symbol of the element type (one per read site; never
shared, so it can make a proof but never a refutation), `CharLit` as its code point, and `StringLit` as a symbol with
a known byte length; (2) assumes `i >= start` for a counter whose every write is `i = i + K` (K a positive literal)
and `i <= start` for `i = i - K`, at the loop head and after the loop; (3) models a call with no `ensures` as a fresh
free result of its scalar return type (its `&mut` writes were already havoced field-wise; a free result is flagged
so a model over it is `unknown`, not `failed`); (4) reports `x!` as an `unwrap` obligation that is `unknown` with the
reason "unmodelled Option/Result tags". Also fixed a latent bug: a havoced bool field got an Int sort.

`scripts/rte-census.ts` (z3, examples/embedded + std; unwrap not counted there):

| kind | before p/f/u | after p/f/u |
|---|---|---|
| overflow | 165/361/1720 | 388/330/1528 |
| bounds | 166/280/1330 | 497/225/1054 |
| division | 15/21/61 | 24/21/52 |
| total | 346/662/3111 | 909/576/2634 |

The milojs + tahoeroads run (same 60 per-file limit; 5 files skipped before, 7 after; distinct sites by description):

| kind | before p/f/u | after p/f/u |
|---|---|---|
| bounds | 82/260/1161 | 327/174/810 |
| overflow | 469/159/1046 | 580/110/732 |
| division | 2/1/3 | 2/1/3 |
| unwrap (new) | n/a | 0/0/10 |

Still open: a `&mut [T; N]` parameter's fixed length, `indexOf`-style callee ensures, element-aware overflow typing
(`v[i] + 1` has no rte type), the SPEC half (unwritten invariants), method calls, and counterexample printing.
