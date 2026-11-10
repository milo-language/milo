/-
One proven program, so the theorems in Contracts.lean are not about an empty set: a hypothesis
like `P.Verified` that nothing satisfies would make every theorem true and worthless.

    fn countTo(n: i64): i64
    requires 0 <= n
    ensures result == n
    {
        var i = 0
        while i < n
        invariant 0 <= i && i <= n
        { i = i + 1 }
        return i
    }

The proof needs the loop frame: `n` is not assigned in the body, so it still holds its entry
value after the loop.
-/
import MiniMilo.Contracts

namespace MiniMilo.Example
open MiniMilo

def countTo : Fn where
  params := ["n"]
  requires := fun vs => ∃ n, vs = [n] ∧ 0 ≤ n
  ensures := fun vs r => ∃ n, vs = [n] ∧ r = n
  body :=
    .seq (.assign "i" (.lit 0))
      (.while (.lt (.var "i") (.var "n")) (fun s => 0 ≤ s "i" ∧ s "i" ≤ s "n")
        (.assign "i" (.add (.var "i") (.lit 1))))
  ret := .var "i"

def prog : Prog := fun f => if f = "countTo" then some countTo else none

theorem i64_some {a v : Int} (h : i64 a = some v) : v = a := by
  unfold i64 at h
  split at h
  · exact (Option.some.inj h).symm
  · cases h

theorem countTo_verified : countTo.Verified prog := by
  intro vs hreq
  obtain ⟨n, rfl, hn⟩ := hreq
  simp only [countTo, wp, Expr.eval, BExpr.eval, mods, entry]
  intro v hv
  cases hv
  refine ⟨by simp [State.set, hn], ?_⟩
  intro s' hfr hinv
  have hn' : s' "n" = n := by
    have := hfr "n" (by simp)
    simpa [State.set] using this
  refine ⟨?_, ?_⟩
  · intro hc v hv
    simp at hc
    have hv' := i64_some (by simpa using hv)
    simp [State.set]
    omega
  · intro hc r hr
    simp at hc hr
    exact ⟨n, rfl, by omega⟩

theorem prog_verified : prog.Verified := by
  intro f fn hf
  unfold prog at hf
  split at hf
  · cases hf; exact countTo_verified
  · cases hf

/-- The semantics has runs: at the default check level `countTo(1)` returns 1. -/
theorem countTo_one_runs (s : State) :
    Exec prog ⟨true, false⟩ (.call "r" "countTo" [.lit 1]) s (.ok (s.set "r" 1)) := by
  refine Exec.callOk (fn := countTo) (vs := [1])
    (s₁ := ((entry ["n"] [1]).set "i" 0).set "i" 1)
    (by simp [prog]) (by simp [evalArgs, Expr.eval]) (fun _ => ⟨1, rfl, by decide⟩) ?_
    (by simp [countTo, Expr.eval, State.set]) (fun _ => ⟨1, rfl, rfl⟩)
  refine Exec.seq (Exec.assign rfl) ?_
  refine Exec.whileStep (fun h => by simp at h)
    (by simp [BExpr.eval, Expr.eval, State.set, entry, countTo])
    (Exec.assign (v := 1) (by simp [Expr.eval, State.set, i64]))
    (Exec.whileDone (fun h => by simp at h) (by simp [BExpr.eval, Expr.eval, State.set, entry, countTo]))

/-- A function whose `ensures` is false, as in mlir/test/programs/contractsDefault.milo. -/
def lies : Fn where
  params := []
  requires := fun _ => True
  ensures := fun _ r => r = 1
  body := .skip
  ret := .lit 0

def liar : Prog := fun _ => some lies

/-- A false clause that is checked ends the run in `fail`. The outcome is reachable, so
"never fails" in `sound` rules something out. -/
theorem lies_fails_when_checked (s : State) :
    Exec liar ⟨true, false⟩ (.call "r" "lies" []) s .fail :=
  Exec.callEnsFail (fn := lies) (vs := []) (r := 0) (s₁ := entry [] []) rfl rfl
    (fun _ => trivial) Exec.skip rfl rfl (by simp [lies])

/-- The same call with the checks dropped returns the value the contract ruled out. This is
the build `--no-contract-checks` gives an unproven program. -/
theorem lies_returns_when_unchecked (s : State) :
    Exec liar ⟨false, false⟩ (.call "r" "lies" []) s (.ok (s.set "r" 0)) :=
  Exec.callOk (fn := lies) (vs := []) (s₁ := entry [] []) rfl rfl
    (fun h => by simp at h) Exec.skip rfl (fun h => by simp at h)

end MiniMilo.Example
