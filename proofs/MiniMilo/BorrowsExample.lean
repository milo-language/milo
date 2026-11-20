/-
The borrow rules, from both sides. Each "needed" theorem takes one rule away from the analysis,
shows that the weakened analysis accepts a small body, and exhibits a run of that body that reads
a stale view: `sound` is false for the weakened analysis, so the rule is needed for the proof,
not just for one fixture. Each is paired with a proof that the real analysis rejects the body.

Place 0 is a buffer `v`; holder 1 is a view, iterator or pointer into it.

  (a) loans end at once:           let h = v.view(); v.push(1); use(h)
  (b) elem writes ignored by loops: for x in v { v[i] = 1 }       (the loop reads its iterator again)
  (c) pointer loans by liveness:   let p = v.ptr(); v.push(1)     (p is read at scope end, outside Milo)

Then the precision the dataflow gains over a walk that holds a loan to the end of the holder's
block: a write after the holder's last use is accepted.
-/
import MiniMilo.Borrows

namespace MiniMilo.Borrows.Example
open MiniMilo.Borrows

theorem notStuck_of {g : Cfg} {s : State} (h : ∀ x, readsMilo (g s.pc).ev x = false)
    (h2 : ∀ x, (g s.pc).ev ≠ .scopeEnd x) : ¬ Stuck g s := by
  rintro ⟨x, r, _, _, h3 | ⟨h3, _⟩⟩
  · simp [h x] at h3
  · exact h2 x h3

/-- `v.push(1)`-shaped graph: node 0 opens a loan of kind `k`, node 1 writes place 0 with `w`,
node 2 is `last`, a use of the holder. -/
def body (k : Kind) (w : W) (last : Ev) : Cfg := fun n =>
  match n with
  | 0 => ⟨.loan 1 0 k, [1]⟩
  | 1 => ⟨.write 0 w, [2]⟩
  | 2 => ⟨last, []⟩
  | _ => ⟨.skip, []⟩

/-- The run that opens the loan, writes, and arrives at the last use. -/
def run3 (g : Cfg) : State := next g (next g (start 0) 1) 2

theorem body_reach {k w last} :
    Reach (body k w last) (start 0) (run3 (body k w last)) := by
  have h1 : Step (body k w last) (start 0) (next (body k w last) (start 0) 1) :=
    Step.go _ 1 (by simp [body, start]) (notStuck_of (by simp [body, start, readsMilo]) (by simp [body, start]))
  have h2 := Step.go (g := body k w last) _ 2 (by simp [body, next_pc, start]) (notStuck_of (s := next (body k w last) (start 0) 1) (by simp [body, next_pc, readsMilo]) (by simp [body, next_pc]))
  exact Reach.step (Reach.step Reach.refl h1) h2

theorem body_stuck {k w last} (hst : stale (run3 (body k w last)) ⟨0, 0, 0, k⟩ = true)
    (hlast : readsMilo last 1 = true ∨ (last = .scopeEnd 1 ∧ k = .pointer)) :
    Stuck (body k w last) (run3 (body k w last)) :=
  ⟨1, ⟨0, 0, 0, k⟩, by cases w <;> simp [run3, next, body, start, upd], hst, by simpa [run3, next_pc, body] using hlast⟩

/-- The real analysis rejects the body: the holder's use after the write makes it live at the
write (for a pointer, the scope-end read does), the loan is in force there, and the kinds conflict. -/
theorem body_rejected {k w last} (hc : conflicts k w = true)
    (hread : (if k == .pointer then readsScope last 1 else readsMilo last 1) = true)
    {live pend : Nat → Var → Bool} {force : Nat → Nat → Bool}
    (hA : Accepted (body k w last) live pend force) : False := by
  have hf := hA.isForced.opens 0 1 1 0 k (by simp [body]) (by simp [body])
  have hok := hA.noConflict.ok 1 0 w 0 1 k (by simp [body]) hf (by simp [body]) hc
  by_cases hk : k = .pointer
  · subst hk
    have h2 := hA.isPend.reads 2 1 (by simpa [body] using hread)
    have h1 := hA.isPend.flows 1 2 1 (by simp [body]) h2 (by simp [body, Ev.defs])
    simp [h1] at hok
  · have h2 := hA.isLive.reads 2 1 (by simpa [body, hk] using hread)
    have h1 := hA.isLive.flows 1 2 1 (by simp [body]) h2 (by simp [body, Ev.defs])
    simp [hk, h1] at hok

/-- The one forward set every example uses: the loan of node 0 is in force everywhere after it. -/
def forceF : Nat → Nat → Bool := fun n l => l == 0 && n != 0

theorem forceF_forced {k w last} (hlast : ∀ h p k, last ≠ .loan h p k) :
    Forced (body k w last) forceF := by
  constructor
  · intro l m h p k' hl hm
    match l with
    | 0 => simp [body] at hm; subst hm; simp [forceF]
    | 1 | _ + 3 => simp [body] at hl
    | 2 => exact absurd hl (hlast _ _ _)
  · intro n m l h p k' hf hm hl _
    match l with
    | 0 =>
      match n with
      | 0 => simp [body] at hm; subst hm; simp [forceF]
      | 1 => simp [body] at hm; subst hm; simp [forceF]
      | 2 => simp [body] at hm
      | _ + 3 => simp [body] at hm
    | 1 | _ + 3 => simp [body] at hl
    | 2 => exact absurd hl (hlast _ _ _)

/-! ### (a) Loans that end at once -/

def bodyA := body .view .call (.read 1)

/-- No holder liveness: nothing is ever live, so no loan is ever in force when a write comes. -/
theorem loansEndAtOnce_accepted :
    NoConflict conflicts bodyA (fun _ _ => false) (fun _ _ => false) forceF :=
  ⟨by intros; simp⟩

theorem loansEndAtOnce_stuck : ∃ s, Reach bodyA (start 0) s ∧ Stuck bodyA s :=
  ⟨_, body_reach, body_stuck (by simp [run3, next, body, start, upd, stale]) (Or.inl (by simp [readsMilo]))⟩

theorem loansEndAtOnce_rejected_by_real {live pend force} : ¬ Accepted bodyA live pend force :=
  fun hA => body_rejected (k := .view) (w := .call) (last := .read 1) (by simp [conflicts]) (by simp [readsMilo]) hA

/-! ### (b) An element write is no conflict with an iteration loan -/

def conflictsNoElemLoop : Kind → W → Bool
  | .iteration, .elem => false
  | k, w => conflicts k w

def bodyB := body .iteration .elem (.read 1)

theorem elemIgnored_accepted :
    Solved readsMilo bodyB (fun _ x => x == 1) ∧ Solved readsScope bodyB (fun _ x => x == 1) ∧
    Forced bodyB forceF ∧
    NoConflict conflictsNoElemLoop bodyB (fun _ x => x == 1) (fun _ x => x == 1) forceF := by
  refine ⟨⟨?_, fun _ _ _ _ h _ => h⟩, ⟨?_, fun _ _ _ _ h _ => h⟩, forceF_forced (by simp), ⟨?_⟩⟩
  · intro n x h
    match n with
    | 0 | 1 => simp [bodyB, body, readsMilo] at h
    | 2 => simpa [bodyB, body, readsMilo] using h
    | _ + 3 => simp [bodyB, body, readsMilo] at h
  · intro n x h
    match n with
    | 0 | 1 => simp [bodyB, body, readsScope] at h
    | 2 => simpa [bodyB, body, readsScope] using h
    | _ + 3 => simp [bodyB, body, readsScope] at h
  · intro n p w l h k hn _ hl hc
    match n with
    | 1 =>
      simp [bodyB, body] at hn
      obtain ⟨_, rfl⟩ := hn
      match l with
      | 0 => simp [bodyB, body] at hl; obtain ⟨_, _, rfl⟩ := hl; simp [conflictsNoElemLoop] at hc
      | 1 | 2 | _ + 3 => simp [bodyB, body] at hl
    | 0 | 2 | _ + 3 => simp [bodyB, body] at hn

theorem elemIgnored_stuck : ∃ s, Reach bodyB (start 0) s ∧ Stuck bodyB s :=
  ⟨_, body_reach, body_stuck (by simp [run3, next, body, start, upd, stale]) (Or.inl (by simp [readsMilo]))⟩

theorem elemIgnored_rejected_by_real {live pend force} : ¬ Accepted bodyB live pend force :=
  fun hA => body_rejected (k := .iteration) (w := .elem) (last := .read 1) (by simp [conflicts]) (by simp [readsMilo]) hA

/-! ### (c) A pointer loan that follows liveness, not scope -/

def bodyC := body .pointer .call (.scopeEnd 1)

/-- The weakened analysis uses the Milo liveness `live` where the real one uses `pend`. -/
theorem pointerByLiveness_accepted :
    Solved readsMilo bodyC (fun _ _ => false) ∧ Forced bodyC forceF ∧
    NoConflict conflicts bodyC (fun _ _ => false) (fun _ _ => false) forceF := by
  refine ⟨⟨?_, fun _ _ _ _ h _ => h⟩, forceF_forced (by simp), ⟨by intros; simp⟩⟩
  intro n x h
  match n with
  | 0 | 1 | 2 | _ + 3 => simp [bodyC, body, readsMilo] at h

theorem pointerByLiveness_stuck : ∃ s, Reach bodyC (start 0) s ∧ Stuck bodyC s :=
  ⟨_, body_reach, body_stuck (by simp [run3, next, body, start, upd, stale]) (Or.inr ⟨rfl, rfl⟩)⟩

theorem pointerByLiveness_rejected_by_real {live pend force} : ¬ Accepted bodyC live pend force :=
  fun hA => body_rejected (k := .pointer) (w := .call) (last := .scopeEnd 1) (by simp [conflicts]) (by simp [readsScope]) hA

/-! ### NLL precision -/

/-- `let h = v.view(); use(h); v.push(1)`: the holder is dead before the write. A walk that holds
the loan to the end of `h`'s block rejects this. -/
def nll : Cfg := fun n =>
  match n with
  | 0 => ⟨.loan 1 0 .view, [1]⟩
  | 1 => ⟨.read 1, [2]⟩
  | 2 => ⟨.write 0 .call, []⟩
  | _ => ⟨.skip, []⟩

def nllLive : Nat → Var → Bool := fun n x => n == 1 && x == 1

theorem nll_accepted : Accepted nll nllLive nllLive forceF := by
  have solved : ∀ rd : Reads, (∀ n x, rd (nll n).ev x = true → nllLive n x = true) →
      Solved rd nll nllLive := by
    intro rd hr
    refine ⟨hr, ?_⟩
    intro n m x hm hl hd
    match n with
    | 0 => simp [nll] at hm; subst hm; simp [nllLive] at hl; simp [nll, Ev.defs, hl] at hd
    | 1 => simp [nll] at hm; subst hm; simp [nllLive] at hl
    | 2 | _ + 3 => simp [nll] at hm
  have hrd : ∀ n x, (nll n).ev = .read 1 → x = 1 → nllLive n x = true := by
    intro n x h hx; subst hx
    match n with
    | 1 => simp [nllLive]
    | 0 | 2 | _ + 3 => simp [nll] at h
  refine ⟨solved _ ?_, solved _ ?_, ⟨?_, ?_⟩, ⟨?_⟩⟩
  · intro n x h
    match n with
    | 1 => simpa [nll, readsMilo, nllLive] using h
    | 0 | 2 | _ + 3 => simp [nll, readsMilo] at h
  · intro n x h
    match n with
    | 1 => simpa [nll, readsScope, nllLive] using h
    | 0 | 2 | _ + 3 => simp [nll, readsScope] at h
  · intro l m h p k hl hm
    match l with
    | 0 => simp [nll] at hm; subst hm; simp [forceF]
    | 1 | 2 | _ + 3 => simp [nll] at hl
  · intro n m l h p k hf hm hl _
    match l with
    | 0 =>
      match n with
      | 0 => simp [nll] at hm; subst hm; simp [forceF]
      | 1 => simp [nll] at hm; subst hm; simp [forceF]
      | 2 | _ + 3 => simp [nll] at hm
    | 1 | 2 | _ + 3 => simp [nll] at hl
  · intro n p w l h k hn _ _ _
    match n with
    | 2 => simp [nll, nllLive] at hn ⊢
    | 0 | 1 | _ + 3 => simp [nll] at hn

theorem nll_never_stuck {s : State} (hr : Reach nll (start 0) s) : ¬ Stuck nll s :=
  sound nll_accepted hr
