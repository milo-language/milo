/-
Borrow soundness: a body the borrow analysis accepts never reads a stale view, on any run. This is a
model of the rules in `src/borrow-flow.ts` (the graph is built in `src/place-cfg.ts`), not a proof
about those files; README.md has the rule-by-rule trace and what the model leaves out.

The dynamic side is E-BORROW of `docs/semantics/milo.md`: a view records the generation of the
buffer it points into, a write that can reallocate bumps that generation, and reading a view whose
recorded generation differs is stuck. A function body is the control-flow graph of place events
that the borrow builder makes; branch conditions are dropped, so the theorem covers every path.

The analysis is stated as the constraints its result meets (a liveness solution for holders, a
forward set of loans in force, the acceptance rule), not as the iteration that computes it: any
solution is sound, and borrow-flow's fixpoint is one. Places and holders are whole variables.
-/

namespace MiniMilo.Borrows

abbrev Var := Nat

inductive Kind where
  | view | iteration | pointer
  deriving DecidableEq

/-- The kinds of write the builder emits. `elem` is an assignment through an index (`v[i] = x`). -/
inductive W where
  | call | assign | elem | move
  deriving DecidableEq

inductive Ev where
  /-- holder `h` borrows place `p`; also redefines `h` -/
  | loan (h p : Var) (k : Kind)
  | write (p : Var) (w : W)
  /-- a Milo use of holder `x` -/
  | read (x : Var)
  /-- `x` is redefined: it holds no borrow any more -/
  | redef (x : Var)
  /-- end of the block of `x`: a pointer holder is read here by code outside Milo (a worker, C) -/
  | scopeEnd (x : Var)
  | skip

structure Node where
  ev : Ev
  succ : List Nat

abbrev Cfg := Nat → Node

abbrev Reads := Ev → Var → Bool

/-- The Milo reads of a holder: what liveness of a view or iteration holder follows. -/
def readsMilo : Reads
  | .read y, x => x == y
  | _, _ => false

/-- Milo reads plus the external read at scope end: what a pointer holder's loan follows. -/
def readsScope : Reads
  | .read y, x | .scopeEnd y, x => x == y
  | _, _ => false

def Ev.defs : Ev → Var → Bool
  | .redef y, x | .loan y _ _, x => x == y
  | _, _ => false

structure Rec where
  place : Var
  gen : Nat
  egen : Nat
  kind : Kind

/-- `gen` counts reallocation-class writes of a place, `egen` its element writes. -/
structure State where
  pc : Nat
  gen : Var → Nat
  egen : Var → Nat
  bor : Var → Option Rec

/-- A view or pointer is stale when its buffer was reallocated; an iteration is also stale after an
element write (the implementation ends a loop over `v` at `v[i] = x`, a view survives it). -/
def stale (s : State) (r : Rec) : Bool :=
  s.gen r.place != r.gen || (r.kind == .iteration && s.egen r.place != r.egen)

def upd {α : Type} (f : Var → α) (x : Var) (v : α) : Var → α := fun y => if y == x then v else f y

/-- The state after the node at `s.pc` runs and control moves to `m`. -/
def next (g : Cfg) (s : State) (m : Nat) : State :=
  match (g s.pc).ev with
  | .loan h p k => { s with pc := m, bor := upd s.bor h (some ⟨p, s.gen p, s.egen p, k⟩) }
  | .write p .elem => { s with pc := m, egen := upd s.egen p (s.egen p + 1) }
  | .write p _ => { s with pc := m, gen := upd s.gen p (s.gen p + 1) }
  | .redef x => { s with pc := m, bor := upd s.bor x none }
  | _ => { s with pc := m }

theorem next_pc (g : Cfg) (s : State) (m : Nat) : (next g s m).pc = m := by
  unfold next; split <;> rfl

theorem readsMilo_le (e : Ev) (x : Var) (h : readsMilo e x = true) : readsScope e x = true := by
  cases e <;> simp_all [readsMilo, readsScope]

/-- E-BORROW: the node reads a holder whose view is stale. Only a pointer is read at scope end. -/
def Stuck (g : Cfg) (s : State) : Prop :=
  ∃ x r, s.bor x = some r ∧ stale s r = true ∧
    (readsMilo (g s.pc).ev x = true ∨ ((g s.pc).ev = .scopeEnd x ∧ r.kind = .pointer))

inductive Step (g : Cfg) : State → State → Prop where
  | go (s : State) (m : Nat) : m ∈ (g s.pc).succ → ¬ Stuck g s → Step g s (next g s m)

def start (entry : Nat) : State := ⟨entry, fun _ => 0, fun _ => 0, fun _ => none⟩

inductive Reach (g : Cfg) (s0 : State) : State → Prop where
  | refl : Reach g s0 s0
  | step {s t : State} : Reach g s0 s → Step g s t → Reach g s0 t

/-- A liveness solution for holders under the reads `rd`. -/
structure Solved (rd : Reads) (g : Cfg) (live : Nat → Var → Bool) : Prop where
  reads : ∀ n x, rd (g n).ev x = true → live n x = true
  flows : ∀ n m x, m ∈ (g n).succ → live m x = true → (g n).ev.defs x = false → live n x = true

/-- A forward set of loans in force, a loan being named by its node: `force n l` says the loan
opened at node `l` reaches node `n` with its holder not redefined since. Any superset of the least
solution will do. -/
structure Forced (g : Cfg) (force : Nat → Nat → Bool) : Prop where
  opens : ∀ l m h p k, (g l).ev = .loan h p k → m ∈ (g l).succ → force m l = true
  flows : ∀ n m l h p k, force n l = true → m ∈ (g n).succ → (g l).ev = .loan h p k →
    (g n).ev.defs h = false → force m l = true

/-- Which writes a loan of a kind forbids. A view survives an element write (no reallocation);
an iteration and a pointer survive nothing. -/
def conflicts : Kind → W → Bool
  | .view, .elem => false
  | _, _ => true

/-- The checker's rule: no write where a loan of an incompatible kind on the same place is in
force. A view or iteration is in force while its holder is live, a pointer until its scope ends
(`pend`, the liveness that also counts the scope-end read). Parameterized so `BorrowsExample.lean`
can drop one rule at a time. -/
structure NoConflict (cf : Kind → W → Bool) (g : Cfg) (live pend : Nat → Var → Bool)
    (force : Nat → Nat → Bool) : Prop where
  ok : ∀ n p w l h k, (g n).ev = .write p w → force n l = true → (g l).ev = .loan h p k →
    cf k w = true → (if k == .pointer then pend n h else live n h) = false

structure Accepted (g : Cfg) (live pend : Nat → Var → Bool) (force : Nat → Nat → Bool) : Prop where
  isLive : Solved readsMilo g live
  isPend : Solved readsScope g pend
  isForced : Forced g force
  noConflict : NoConflict conflicts g live pend force

/-- The liveness a loan of kind `k` follows, false at `n` for holder `h`. -/
def Dead (live pend : Nat → Var → Bool) (n : Nat) (h : Var) (k : Kind) : Prop :=
  (k = .pointer → pend n h = false) ∧ (k ≠ .pointer → live n h = false)

/-- While the run stands at `s`, a stale holder is dead there, by the liveness its kind follows;
and every holder's loan is one the forward set has in force. -/
structure Inv (g : Cfg) (live pend : Nat → Var → Bool) (force : Nat → Nat → Bool) (s : State) : Prop where
  dead : ∀ h r, s.bor h = some r → stale s r = true → Dead live pend s.pc h r.kind
  linked : ∀ h r, s.bor h = some r → ∃ l, force s.pc l = true ∧ (g l).ev = .loan h r.place r.kind

theorem dead_flow {rd : Reads} {g : Cfg} {live : Nat → Var → Bool} (hl : Solved rd g live)
    {n m : Nat} {h : Var} (hm : m ∈ (g n).succ) (hd : (g n).ev.defs h = false)
    (hn : live n h = false) : live m h = false := by
  cases hc : live m h
  · rfl
  · have := hl.flows n m h hm hc hd
    rw [hn] at this
    cases this

theorem Dead.flow {g : Cfg} {live pend : Nat → Var → Bool} {force : Nat → Nat → Bool}
    (hA : Accepted g live pend force) {n m : Nat} {h : Var} {k : Kind}
    (hm : m ∈ (g n).succ) (hd : (g n).ev.defs h = false) (hn : Dead live pend n h k) :
    Dead live pend m h k :=
  ⟨fun hk => dead_flow hA.isPend hm hd (hn.1 hk), fun hk => dead_flow hA.isLive hm hd (hn.2 hk)⟩

theorem inv_step {g : Cfg} {live pend : Nat → Var → Bool} {force : Nat → Nat → Bool}
    (hA : Accepted g live pend force) {s : State} {m : Nat} (hm : m ∈ (g s.pc).succ)
    (hi : Inv g live pend force s) : Inv g live pend force (next g s m) := by
  -- a holder that the node does not redefine keeps its record, and its loan stays in force
  have carry : ∀ h r, s.bor h = some r → (g s.pc).ev.defs h = false → stale s r = true →
      Dead live pend m h r.kind := fun h r hb hd hst => (hi.dead h r hb hst).flow hA hm hd
  have link : ∀ h r, s.bor h = some r → (g s.pc).ev.defs h = false →
      ∃ l, force m l = true ∧ (g l).ev = .loan h r.place r.kind := by
    intro h r hb hd
    obtain ⟨l, hf, hl⟩ := hi.linked h r hb
    exact ⟨l, hA.isForced.flows _ _ _ _ _ _ hf hm hl hd, hl⟩
  cases hev : (g s.pc).ev with
  | loan h0 p k =>
    constructor
    · intro h r hb hst
      simp only [next, hev, upd] at hb hst ⊢
      by_cases hh : h = h0
      · subst hh
        simp at hb
        subst hb
        simp [stale] at hst
      · simp [hh] at hb
        have := carry h r hb (by simp [Ev.defs, hev, hh]) (by simpa [stale] using hst)
        simpa using this
    · intro h r hb
      simp only [next, hev, upd] at hb ⊢
      by_cases hh : h = h0
      · subst hh
        simp at hb
        subst hb
        exact ⟨s.pc, hA.isForced.opens _ _ _ _ _ hev hm, hev⟩
      · simp [hh] at hb
        simpa using link h r hb (by simp [Ev.defs, hev, hh])
  | write p w =>
    have hb : ∀ h r, (next g s m).bor h = some r → s.bor h = some r := by
      intro h r hb
      cases w <;> simpa [next, hev] using hb
    have hd : (g s.pc).ev.defs = fun _ => false := by
      funext x; simp [hev, Ev.defs]
    constructor
    · intro h r hb' hst
      have hbs := hb h r hb'
      by_cases hs : stale s r = true
      · rw [next_pc]; simpa using carry h r hbs (by simp [hd]) hs
      · obtain ⟨l, hf, hl⟩ := hi.linked h r hbs
        have key : p = r.place ∧ conflicts r.kind w = true := by
          cases w <;> cases hk : r.kind <;>
            simp_all [stale, next, upd, conflicts]
        have hok := hA.noConflict.ok s.pc p w l h r.kind hev hf (by rw [hl, ← key.1]) key.2
        have hdead : Dead live pend s.pc h r.kind := by
          constructor
          · intro hk; simpa [hk] using hok
          · intro hk; simpa [hk] using hok
        rw [next_pc]; simpa using hdead.flow hA hm (by simp [hd])
    · intro h r hb'
      rw [next_pc]; simpa using link h r (hb h r hb') (by simp [hd])
  | redef x =>
    constructor
    · intro h r hb hst
      simp only [next, hev, upd] at hb hst ⊢
      by_cases hh : h = x
      · subst hh; simp at hb
      · simp [hh] at hb
        have := carry h r hb (by simp [Ev.defs, hev, hh]) (by simpa [stale] using hst)
        simpa using this
    · intro h r hb
      simp only [next, hev, upd] at hb ⊢
      by_cases hh : h = x
      · subst hh; simp at hb
      · simp [hh] at hb
        simpa using link h r hb (by simp [Ev.defs, hev, hh])
  | read x =>
    constructor
    · intro h r hb hst
      simpa [next, hev, stale] using carry h r (by simpa [next, hev] using hb) (by simp [Ev.defs, hev]) (by simpa [next, hev, stale] using hst)
    · intro h r hb
      simpa [next, hev] using link h r (by simpa [next, hev] using hb) (by simp [Ev.defs, hev])
  | scopeEnd x =>
    constructor
    · intro h r hb hst
      simpa [next, hev, stale] using carry h r (by simpa [next, hev] using hb) (by simp [Ev.defs, hev]) (by simpa [next, hev, stale] using hst)
    · intro h r hb
      simpa [next, hev] using link h r (by simpa [next, hev] using hb) (by simp [Ev.defs, hev])
  | skip =>
    constructor
    · intro h r hb hst
      simpa [next, hev, stale] using carry h r (by simpa [next, hev] using hb) (by simp [Ev.defs, hev]) (by simpa [next, hev, stale] using hst)
    · intro h r hb
      simpa [next, hev] using link h r (by simpa [next, hev] using hb) (by simp [Ev.defs, hev])

theorem inv_reach {g : Cfg} {live pend : Nat → Var → Bool} {force : Nat → Nat → Bool}
    {entry : Nat} (hA : Accepted g live pend force) {s : State}
    (hr : Reach g (start entry) s) : Inv g live pend force s := by
  induction hr with
  | refl => exact ⟨fun h r hb => by simp [start] at hb, fun h r hb => by simp [start] at hb⟩
  | step _ hs ih => cases hs with | go m hm _ => exact inv_step hA hm ih

/-- **Borrow soundness.** On every run of an accepted body, no node reads a stale view. -/
theorem sound {g : Cfg} {live pend : Nat → Var → Bool} {force : Nat → Nat → Bool}
    {entry : Nat} (hA : Accepted g live pend force) {s : State}
    (hr : Reach g (start entry) s) : ¬ Stuck g s := by
  have hi := inv_reach hA hr
  intro ⟨x, r, hb, hst, h⟩
  have hd := hi.dead x r hb hst
  rcases h with hrd | ⟨hse, hk⟩
  · have hl := hA.isLive.reads _ _ hrd
    by_cases hk : r.kind = .pointer
    · have hp := hA.isPend.reads _ _ (readsMilo_le _ _ hrd)
      rw [hd.1 hk] at hp; cases hp
    · rw [hd.2 hk] at hl; cases hl
  · have hp := hA.isPend.reads _ x (by rw [hse]; simp [readsScope])
    rw [hd.1 hk] at hp; cases hp

end MiniMilo.Borrows
