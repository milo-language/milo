/-
The lend rule, from both sides. 5dbc074a fixed this program, which move-flow accepted and the
interpreter got stuck on:

    fn f(a: &string, b: string): i64 { ... }
    f(s, s)

The first argument lends `s` to the call; the second is a move position. As a graph:
node 0 is the move position of `s` (a string), node 1 the call, which reads `s` through `a`
while it runs.

Without the lend rule (liveness that ignores what a call reads), the analysis accepts this body
and decides the string move moves, and the run is stuck at the call: `sound` is false for that
analysis, and Lean says so. With the rule, `s` is live after node 0, the decision is a share,
and `sound` applies.
-/
import MiniMilo.Moves

namespace MiniMilo.Moves.Example
open MiniMilo.Moves

def g : Cfg := fun n =>
  match n with
  | 0 => ⟨.str 0, [1]⟩
  | 1 => ⟨.call [0], []⟩
  | _ => ⟨.skip, []⟩

def owned : Var → Bool := fun _ => false

/-- The reads of an analysis without the lend rule: a call reads nothing. -/
def readsNoLend : Reads
  | .call _, _ => false
  | ev, x => ev.reads x

def liveNoLend : Nat → Var → Bool := fun n x => n == 0 && x == 0
def liveLend : Nat → Var → Bool := fun n x => (n == 0 || n == 1) && x == 0

theorem noLend_accepted : Accepted readsNoLend g owned liveNoLend := by
  refine strings_never_rejected ⟨?_, ?_⟩ ?_
  · intro n x h
    match n with
    | 0 => simpa [g, readsNoLend, Ev.reads, liveNoLend] using h
    | 1 => simp [g, readsNoLend] at h
    | _ + 2 => simp [g, readsNoLend, Ev.reads] at h
  · intro n m x hm hl _
    match n with
    | 0 => simp [g] at hm; subst hm; simp [liveNoLend] at hl
    | 1 => simp [g] at hm
    | _ + 2 => simp [g] at hm
  · intro n x
    match n with
    | 0 => simp [g]
    | 1 => simp [g]
    | _ + 2 => simp [g]

/-- Without the lend rule the accepted body gets stuck: the string moved at node 0, the call
reads it at node 1. -/
theorem noLend_stuck :
    ∃ s, Reach g owned (decide g owned liveNoLend) (start 0) s ∧
      Stuck g owned (decide g owned liveNoLend) s := by
  have hstep : Step g owned (decide g owned liveNoLend) (start 0)
      ⟨1, update g (decide g owned liveNoLend) 0 (fun _ => false)⟩ := by
    refine Step.go (start 0) 1 (by simp [g, start]) ?_
    intro ⟨x, h⟩
    rcases h with ⟨_, hm⟩ | ⟨_, hb⟩
    · simp [start] at hm
    · simp [owned] at hb
  refine ⟨_, Reach.step Reach.refl hstep, 0, Or.inl ⟨?_, ?_⟩⟩
  · simp [g, Ev.reads]
  · simp [update, g, Ev.assigns, moves, decide, liveOut, liveNoLend, owned]

theorem lend_accepted : Accepted Ev.reads g owned liveLend := by
  refine strings_never_rejected ⟨?_, ?_⟩ ?_
  · intro n x h
    match n with
    | 0 => simpa [g, Ev.reads, liveLend] using h
    | 1 => simpa [g, Ev.reads, liveLend] using h
    | _ + 2 => simp [g, Ev.reads] at h
  · intro n m x hm hl _
    match n with
    | 0 => simp [g] at hm; subst hm; simpa [liveLend] using hl
    | 1 => simp [g] at hm
    | _ + 2 => simp [g] at hm
  · intro n x
    match n with
    | 0 => simp [g]
    | 1 => simp [g]
    | _ + 2 => simp [g]

/-- With the lend rule the second argument shares. -/
theorem lend_shares : decide g owned liveLend 0 = false := by
  simp [decide, g, liveOut, liveLend, owned]

theorem lend_never_stuck {s : State}
    (hr : Reach g owned (decide g owned liveLend) (start 0) s) :
    ¬ Stuck g owned (decide g owned liveLend) s :=
  sound lend_accepted hr

end MiniMilo.Moves.Example
