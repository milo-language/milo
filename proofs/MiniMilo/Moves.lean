/-
Move soundness: a program the move analysis accepts never reads a moved place and never moves
out of a borrow, on any run. This is a model of the rules in `src/move-flow.ts`, not a proof about
that file; README.md has the rule-by-rule trace and what the model leaves out.

A function body is a control-flow graph of place events, the graph move-flow builds. Branch
conditions are abstracted away: a node may step to any successor, so the theorem covers every
path, taken or not. A node with no successor ends the run (a return, or a call of type `never`).

The analysis is stated as constraints its result must meet (a liveness solution, plus the
decision and acceptance rules), not as the iteration that computes it: any solution is sound,
and move-flow's fixpoint is one.
-/

namespace MiniMilo.Moves

abbrev Var := Nat

/-- What a node does to places. -/
inductive Ev where
  /-- read or borrow `x` (E-COPY, a `&T` argument): needs `x` whole -/
  | read (x : Var)
  /-- a move position of a non-string place (E-MOVE): needs `x` whole, then `x` is moved -/
  | take (x : Var)
  /-- a move position of a string (E-STRING-SHARE): moves or shares, as decided -/
  | str (x : Var)
  /-- `x = e` or a `let`: `x` holds a fresh value again -/
  | assign (x : Var)
  /-- a call: reads the places it was lent for as long as it runs (the lend rule) -/
  | call (lent : List Var)
  | skip

structure Node where
  ev : Ev
  succ : List Nat

abbrev Cfg := Nat → Node

/-- The places an event needs whole when it runs. Parameterized so `MovesExample.lean` can show
what goes wrong without the `call` case. -/
abbrev Reads := Ev → Var → Bool

def Ev.reads : Reads
  | .read y, x | .take y, x | .str y, x => x == y
  | .call lent, x => lent.contains x
  | _, _ => false

def Ev.assigns : Ev → Var → Bool
  | .assign y, x => x == y
  | _, _ => false

/-- A run's state: the node about to run and which places are moved. -/
structure State where
  pc : Nat
  moved : Var → Bool

/-- What node `n` moves, given the string decisions `dec` (true: move, false: share). -/
def moves (g : Cfg) (dec : Nat → Bool) (n : Nat) (x : Var) : Bool :=
  match (g n).ev with
  | .take y => x == y
  | .str y => x == y && dec n
  | _ => false

def update (g : Cfg) (dec : Nat → Bool) (n : Nat) (m : Var → Bool) (x : Var) : Bool :=
  if (g n).ev.assigns x then false else m x || moves g dec n x

/-- E-STUCK and T-NO-MOVE-OUT: the node reads a moved place, or moves a place it does not own
(`borrowed`: a `&T` parameter, a view let, a pattern view of a borrowed subject, a closure
parameter; the owner frees it). -/
def Stuck (g : Cfg) (borrowed : Var → Bool) (dec : Nat → Bool) (s : State) : Prop :=
  ∃ x, ((g s.pc).ev.reads x = true ∧ s.moved x = true) ∨
       (moves g dec s.pc x = true ∧ borrowed x = true)

inductive Step (g : Cfg) (borrowed : Var → Bool) (dec : Nat → Bool) : State → State → Prop where
  | go (s : State) (m : Nat) : m ∈ (g s.pc).succ → ¬ Stuck g borrowed dec s →
      Step g borrowed dec s ⟨m, update g dec s.pc s.moved⟩

inductive Reach (g : Cfg) (borrowed : Var → Bool) (dec : Nat → Bool) (s0 : State) : State → Prop where
  | refl : Reach g borrowed dec s0 s0
  | step {s t : State} : Reach g borrowed dec s0 s → Step g borrowed dec s t → Reach g borrowed dec s0 t

/-- A liveness solution: `live n x` when some path from `n` reads `x` before assigning it.
Only the two closure conditions are required; the least solution is the precise one. -/
structure Live (rd : Reads) (g : Cfg) (live : Nat → Var → Bool) : Prop where
  reads : ∀ n x, rd (g n).ev x = true → live n x = true
  flows : ∀ n m x, m ∈ (g n).succ → live m x = true → (g n).ev.assigns x = false → live n x = true

def liveOut (g : Cfg) (live : Nat → Var → Bool) (n : Nat) (x : Var) : Bool :=
  (g n).succ.any (fun m => live m x)

/-- move-flow's string rule: move if nothing reads the place after, and the place is owned;
otherwise share. -/
def decide (g : Cfg) (borrowed : Var → Bool) (live : Nat → Var → Bool) (n : Nat) : Bool :=
  match (g n).ev with
  | .str x => !borrowed x && !liveOut g live n x
  | _ => false

/-- What the checker accepts: a non-string move with the place live after is "use of moved
variable" (or "out of a loop" when the path goes round a back edge), and a non-string move of a
borrowed place is "cannot move out of a borrow". Strings are never rejected: they share. -/
structure Accepted (rd : Reads) (g : Cfg) (borrowed : Var → Bool) (live : Nat → Var → Bool) : Prop where
  isLive : Live rd g live
  takeDead : ∀ n x, (g n).ev = .take x → liveOut g live n x = false
  takeOwned : ∀ n x, (g n).ev = .take x → borrowed x = false

def start (entry : Nat) : State := ⟨entry, fun _ => false⟩

/-- The invariant: a moved place is not live where the run stands. -/
def Inv (live : Nat → Var → Bool) (s : State) : Prop :=
  ∀ x, s.moved x = true → live s.pc x = false

theorem not_live_after {g : Cfg} {live : Nat → Var → Bool} {n m : Nat} {x : Var}
    (h : liveOut g live n x = false) (hm : m ∈ (g n).succ) : live m x = false := by
  unfold liveOut at h
  rw [List.any_eq_false] at h
  cases hl : live m x
  · rfl
  · exact absurd hl (h m hm)

theorem inv_step {g : Cfg} {borrowed : Var → Bool} {live : Nat → Var → Bool}
    (hA : Accepted Ev.reads g borrowed live) {s t : State} (hi : Inv live s)
    (hs : Step g borrowed (decide g borrowed live) s t) : Inv live t := by
  cases hs with
  | go m hm _ =>
    intro x hx
    simp only [update] at hx
    split at hx
    · cases hx
    · rename_i hna
      cases hmv : s.moved x with
      | true =>
        have hdead := hi x hmv
        cases hl : live m x
        · rfl
        · have := hA.isLive.flows _ _ _ hm hl (by simpa using hna)
          rw [hdead] at this
          cases this
      | false =>
        rw [hmv, Bool.false_or] at hx
        unfold moves at hx
        split at hx
        · rename_i y hev
          have hxy : x = y := by simpa using hx
          subst hxy
          exact not_live_after (hA.takeDead _ _ hev) hm
        · rename_i y hev
          simp only [Bool.and_eq_true, beq_iff_eq] at hx
          obtain ⟨hxy, hd⟩ := hx
          subst hxy
          simp only [decide, hev, Bool.and_eq_true, Bool.not_eq_true'] at hd
          exact not_live_after hd.2 hm
        · cases hx

theorem inv_reach {g : Cfg} {borrowed : Var → Bool} {live : Nat → Var → Bool} {entry : Nat}
    (hA : Accepted Ev.reads g borrowed live) {s : State}
    (hr : Reach g borrowed (decide g borrowed live) (start entry) s) : Inv live s := by
  induction hr with
  | refl => intro x hx; cases hx
  | step _ hs ih => exact inv_step hA ih hs

/-- **Move soundness.** On every run of an accepted body, with move-flow's string decisions,
no node reads a moved place or moves a borrowed one. -/
theorem sound {g : Cfg} {borrowed : Var → Bool} {live : Nat → Var → Bool} {entry : Nat}
    (hA : Accepted Ev.reads g borrowed live) {s : State}
    (hr : Reach g borrowed (decide g borrowed live) (start entry) s) :
    ¬ Stuck g borrowed (decide g borrowed live) s := by
  have hi := inv_reach hA hr
  intro ⟨x, h⟩
  rcases h with ⟨hrd, hmv⟩ | ⟨hmo, hb⟩
  · have := hA.isLive.reads _ _ hrd
    rw [hi x hmv] at this
    cases this
  · unfold moves at hmo
    split at hmo
    · rename_i y hev
      have hxy : x = y := by simpa using hmo
      subst hxy
      rw [hA.takeOwned _ _ hev] at hb
      cases hb
    · rename_i y hev
      simp only [Bool.and_eq_true, beq_iff_eq] at hmo
      obtain ⟨hxy, hd⟩ := hmo
      subst hxy
      simp only [decide, hev, Bool.and_eq_true, Bool.not_eq_true'] at hd
      rw [hd.1] at hb
      cases hb
    · cases hmo

/-- Strings cost no rejection: a body with no non-string moves is accepted whatever it does with
strings, given any liveness solution. -/
theorem strings_never_rejected {rd : Reads} {g : Cfg} {borrowed : Var → Bool}
    {live : Nat → Var → Bool} (hl : Live rd g live) (hno : ∀ n x, (g n).ev ≠ .take x) :
    Accepted rd g borrowed live :=
  ⟨hl, fun n x h => absurd h (hno n x), fun n x h => absurd h (hno n x)⟩

end MiniMilo.Moves
