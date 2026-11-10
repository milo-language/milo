/-
Contract soundness for Mini-Milo: what `milo prove` reporting "proven" means, and what a build
does with a contract nobody proved. Three theorems, all at the end of this file:

  sound             a proven program never fails a contract clause, at any check level, and a
                    call that returns satisfies its `ensures`
  level_irrelevant  for a proven program every check level has exactly the same runs, so
                    dropping the checks changes nothing
  checked_call      for ANY program, proven or not, a build that checks boundaries only
                    returns from a call whose `requires` and `ensures` both held

Mini-Milo is the contract-carrying core: i64 variables, checked arithmetic, `if`, `while` with
an invariant, and calls to functions with `requires`/`ensures`. proofs/README.md lists what the
model leaves out and how each definition here lines up with the compiler.
-/
namespace MiniMilo

abbrev Var := String
abbrev State := Var → Int

def State.set (s : State) (x : Var) (v : Int) : State := fun y => if y = x then v else s y

/-- Checked i64 arithmetic: a result outside the range is a trap, never a wrapped value. -/
def i64 (v : Int) : Option Int := if -(2 ^ 63 : Int) ≤ v ∧ v < 2 ^ 63 then some v else none

inductive Expr where
  | lit (n : Int)
  | var (x : Var)
  | add (a b : Expr)
  | sub (a b : Expr)
  | mul (a b : Expr)
  | div (a b : Expr)

/-- `none` is a trap (overflow, division by zero). -/
def Expr.eval : Expr → State → Option Int
  | .lit n, _ => some n
  | .var x, s => some (s x)
  | .add a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y => i64 (x + y)
  | .sub a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y => i64 (x - y)
  | .mul a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y => i64 (x * y)
  | .div a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y =>
      if y = 0 then none else i64 (Int.tdiv x y)

inductive BExpr where
  | lt (a b : Expr)
  | le (a b : Expr)
  | eq (a b : Expr)
  | not (a : BExpr)
  | and (a b : BExpr)
  | or (a b : BExpr)

/-- `and`/`or` short-circuit, so a trap in the right operand needs the left one to reach it. -/
def BExpr.eval : BExpr → State → Option Bool
  | .lt a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y => some (decide (x < y))
  | .le a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y => some (decide (x ≤ y))
  | .eq a b, s => (a.eval s).bind fun x => (b.eval s).bind fun y => some (decide (x = y))
  | .not a, s => (a.eval s).map (!·)
  | .and a b, s => (a.eval s).bind fun x => if x then b.eval s else some false
  | .or a b, s => (a.eval s).bind fun x => if x then some true else b.eval s

/-- A loop invariant is a predicate on the state: what z3 is asked about, not its syntax. -/
inductive Stmt where
  | skip
  | assign (x : Var) (e : Expr)
  | seq (a b : Stmt)
  | ite (c : BExpr) (t e : Stmt)
  | while (c : BExpr) (inv : State → Prop) (body : Stmt)
  | call (x : Var) (f : String) (args : List Expr)

/-- A function takes its arguments by value. `requires` reads the argument values; `ensures`
reads them too (they are the entry values, which is what `old(e)` names) and `result`. -/
structure Fn where
  params : List Var
  requires : List Int → Prop
  ensures : List Int → Int → Prop
  body : Stmt
  ret : Expr

abbrev Prog := String → Option Fn

/-- A callee's first state: its parameters bound, every other variable 0. -/
def entry : List Var → List Int → State
  | x :: xs, v :: vs => (entry xs vs).set x v
  | _, _ => fun _ => 0

def evalArgs (args : List Expr) (s : State) : Option (List Int) := args.mapM (·.eval s)

inductive Outcome where
  | ok (s : State)
  /-- Overflow or division by zero: the run aborts. -/
  | trap
  /-- A contract clause was checked and was false: the run aborts with `clause violated`. -/
  | fail

def Outcome.stopped : Outcome → Prop
  | .ok _ => False
  | _ => True

/-- `o` does not fail a clause, and if it is a normal end then `Q` holds there. -/
def Outcome.meets (o : Outcome) (Q : State → Prop) : Prop :=
  match o with
  | .ok s => Q s
  | .trap => True
  | .fail => False

theorem Outcome.stopped_ne_ok {o : Outcome} {s : State} (h : o.stopped) : o ≠ .ok s := by
  intro e; subst e; exact h

theorem Outcome.meets_of_stopped {o : Outcome} {Q Q' : State → Prop} (hst : o.stopped)
    (h : o.meets Q') : o.meets Q := by
  cases o with
  | ok s => exact False.elim hst
  | trap => trivial
  | fail => exact h

/-- Which clauses a build checks at run time. `ContractChecks` in src/emit-mlir.ts:
"none" = ⟨false, false⟩, "boundary" (the default) = ⟨true, false⟩, "all" = ⟨true, true⟩. -/
structure Level where
  boundary : Bool
  loops : Bool

/-- Big-step runs of a build at check level `k`. A clause the level does not check is not
looked at; a checked clause that is false ends the run in `fail`. -/
inductive Exec (P : Prog) (k : Level) : Stmt → State → Outcome → Prop where
  | skip {s : State} : Exec P k .skip s (.ok s)
  | assign {s : State} {x : Var} {e : Expr} {v : Int} (he : e.eval s = some v) :
      Exec P k (.assign x e) s (.ok (s.set x v))
  | assignTrap {s : State} {x : Var} {e : Expr} (he : e.eval s = none) :
      Exec P k (.assign x e) s .trap
  | seq {s s₁ : State} {a b : Stmt} {o : Outcome}
      (ha : Exec P k a s (.ok s₁)) (hb : Exec P k b s₁ o) : Exec P k (.seq a b) s o
  | seqStop {s : State} {a b : Stmt} {o : Outcome}
      (ha : Exec P k a s o) (hst : o.stopped) : Exec P k (.seq a b) s o
  | iteTrue {s : State} {c : BExpr} {t e : Stmt} {o : Outcome}
      (hc : c.eval s = some true) (ht : Exec P k t s o) : Exec P k (.ite c t e) s o
  | iteFalse {s : State} {c : BExpr} {t e : Stmt} {o : Outcome}
      (hc : c.eval s = some false) (he : Exec P k e s o) : Exec P k (.ite c t e) s o
  | iteTrap {s : State} {c : BExpr} {t e : Stmt}
      (hc : c.eval s = none) : Exec P k (.ite c t e) s .trap
  -- R-CONTRACT-LOOP: the invariant is checked before the condition each time, so also on exit.
  | whileInvFail {s : State} {c : BExpr} {inv : State → Prop} {body : Stmt}
      (hk : k.loops = true) (hni : ¬ inv s) : Exec P k (.while c inv body) s .fail
  | whileTrap {s : State} {c : BExpr} {inv : State → Prop} {body : Stmt}
      (hi : k.loops = true → inv s) (hc : c.eval s = none) :
      Exec P k (.while c inv body) s .trap
  | whileDone {s : State} {c : BExpr} {inv : State → Prop} {body : Stmt}
      (hi : k.loops = true → inv s) (hc : c.eval s = some false) :
      Exec P k (.while c inv body) s (.ok s)
  | whileStep {s s₁ : State} {c : BExpr} {inv : State → Prop} {body : Stmt} {o : Outcome}
      (hi : k.loops = true → inv s) (hc : c.eval s = some true)
      (hb : Exec P k body s (.ok s₁)) (hw : Exec P k (.while c inv body) s₁ o) :
      Exec P k (.while c inv body) s o
  | whileStop {s : State} {c : BExpr} {inv : State → Prop} {body : Stmt} {o : Outcome}
      (hi : k.loops = true → inv s) (hc : c.eval s = some true)
      (hb : Exec P k body s o) (hst : o.stopped) : Exec P k (.while c inv body) s o
  | callArgsTrap {s : State} {x : Var} {f : String} {args : List Expr}
      (ha : evalArgs args s = none) : Exec P k (.call x f args) s .trap
  -- R-CONTRACT-ENTRY: `requires` is checked before the body runs.
  | callReqFail {s : State} {x : Var} {f : String} {args : List Expr} {fn : Fn} {vs : List Int}
      (hf : P f = some fn) (ha : evalArgs args s = some vs)
      (hk : k.boundary = true) (hnr : ¬ fn.requires vs) : Exec P k (.call x f args) s .fail
  | callStop {s : State} {x : Var} {f : String} {args : List Expr} {fn : Fn} {vs : List Int}
      {o : Outcome}
      (hf : P f = some fn) (ha : evalArgs args s = some vs)
      (hr : k.boundary = true → fn.requires vs)
      (hb : Exec P k fn.body (entry fn.params vs) o) (hst : o.stopped) :
      Exec P k (.call x f args) s o
  | callRetTrap {s s₁ : State} {x : Var} {f : String} {args : List Expr} {fn : Fn}
      {vs : List Int}
      (hf : P f = some fn) (ha : evalArgs args s = some vs)
      (hr : k.boundary = true → fn.requires vs)
      (hb : Exec P k fn.body (entry fn.params vs) (.ok s₁)) (hret : fn.ret.eval s₁ = none) :
      Exec P k (.call x f args) s .trap
  -- R-CONTRACT-EXIT: `ensures` is checked at the return, with `result` the value returned.
  | callEnsFail {s s₁ : State} {x : Var} {f : String} {args : List Expr} {fn : Fn}
      {vs : List Int} {r : Int}
      (hf : P f = some fn) (ha : evalArgs args s = some vs)
      (hr : k.boundary = true → fn.requires vs)
      (hb : Exec P k fn.body (entry fn.params vs) (.ok s₁)) (hret : fn.ret.eval s₁ = some r)
      (hk : k.boundary = true) (hne : ¬ fn.ensures vs r) : Exec P k (.call x f args) s .fail
  | callOk {s s₁ : State} {x : Var} {f : String} {args : List Expr} {fn : Fn}
      {vs : List Int} {r : Int}
      (hf : P f = some fn) (ha : evalArgs args s = some vs)
      (hr : k.boundary = true → fn.requires vs)
      (hb : Exec P k fn.body (entry fn.params vs) (.ok s₁)) (hret : fn.ret.eval s₁ = some r)
      (he : k.boundary = true → fn.ensures vs r) : Exec P k (.call x f args) s (.ok (s.set x r))

/-- The variables a statement can assign: what a loop's proof forgets about the state. -/
def mods : Stmt → List Var
  | .skip => []
  | .assign x _ => [x]
  | .seq a b => mods a ++ mods b
  | .ite _ t e => mods t ++ mods e
  | .while _ _ body => mods body
  | .call x _ _ => [x]

/-- The verification conditions, as the weakest precondition of `Q`. A trap needs no proof
(the run aborts, it does not go on wrong), so each case assumes evaluation succeeded.
  while: the invariant holds on entry; then from ANY state that keeps the invariant and differs
         from the entry state only in variables the body assigns, one iteration keeps the
         invariant and leaving the loop gives `Q`. The loop is never unrolled.
  call:  the callee's `requires` holds, and `Q` follows from its `ensures` alone. The callee's
         body is not looked at. -/
def wp (P : Prog) : Stmt → (State → Prop) → State → Prop
  | .skip, Q, s => Q s
  | .assign x e, Q, s => ∀ v, e.eval s = some v → Q (s.set x v)
  | .seq a b, Q, s => wp P a (wp P b Q) s
  | .ite c t e, Q, s => (c.eval s = some true → wp P t Q s) ∧ (c.eval s = some false → wp P e Q s)
  | .while c inv body, Q, s =>
      inv s ∧ ∀ s', (∀ x, x ∉ mods body → s' x = s x) → inv s' →
        (c.eval s' = some true → wp P body inv s') ∧ (c.eval s' = some false → Q s')
  | .call x f args, Q, s =>
      ∀ vs, evalArgs args s = some vs → ∀ fn, P f = some fn →
        fn.requires vs ∧ ∀ r, fn.ensures vs r → Q (s.set x r)

/-- What `milo prove` discharges for one function: from `requires`, the body establishes
`ensures` at the return. -/
def Fn.Verified (fn : Fn) (P : Prog) : Prop :=
  ∀ vs, fn.requires vs →
    wp P fn.body (fun s => ∀ r, fn.ret.eval s = some r → fn.ensures vs r) (entry fn.params vs)

/-- Every function proven, each against the others' contracts only (recursion included). -/
def Prog.Verified (P : Prog) : Prop := ∀ f fn, P f = some fn → fn.Verified P

/-- A run changes only the variables its statement assigns. This is what lets a loop's proof
keep facts about the other variables. -/
theorem frame {P : Prog} {k : Level} {c : Stmt} {s : State} {o : Outcome} (h : Exec P k c s o) :
    ∀ s', o = .ok s' → ∀ x, x ∉ mods c → s' x = s x := by
  induction h with
  | skip => intro s' h x _; cases h; rfl
  | assign he => intro s' h y hy; cases h; simp [mods] at hy; simp [State.set, hy]
  | assignTrap he => intro _ h; cases h
  | seq ha hb iha ihb =>
      intro s' h x hx; simp [mods] at hx
      exact (ihb s' h x hx.2).trans (iha _ rfl x hx.1)
  | seqStop ha hst iha => intro _ h; exact absurd h (Outcome.stopped_ne_ok hst)
  | iteTrue hc ht ih => intro s' h x hx; simp [mods] at hx; exact ih s' h x hx.1
  | iteFalse hc he ih => intro s' h x hx; simp [mods] at hx; exact ih s' h x hx.2
  | iteTrap hc => intro _ h; cases h
  | whileInvFail hk hni => intro _ h; cases h
  | whileTrap hi hc => intro _ h; cases h
  | whileDone hi hc => intro s' h x _; cases h; rfl
  | whileStep hi hc hb hw ihb ihw =>
      intro s' h x hx
      exact (ihw s' h x hx).trans (ihb _ rfl x hx)
  | whileStop hi hc hb hst ihb => intro _ h; exact absurd h (Outcome.stopped_ne_ok hst)
  | callArgsTrap ha => intro _ h; cases h
  | callReqFail hf ha hk hnr => intro _ h; cases h
  | callStop hf ha hr hb hst ih => intro _ h; exact absurd h (Outcome.stopped_ne_ok hst)
  | callRetTrap hf ha hr hb hret ih => intro _ h; cases h
  | callEnsFail hf ha hr hb hret hk hne ih => intro _ h; cases h
  | callOk hf ha hr hb hret he ih =>
      intro s' h y hy; cases h; simp [mods] at hy; simp [State.set, hy]

/-- **Proven means proven.** In a program whose every function is proven, a statement run from
a state that satisfies its verification conditions never fails a contract clause, whatever the
build checks, and if it ends normally the postcondition holds. -/
theorem sound {P : Prog} {k : Level} (hP : P.Verified) {c : Stmt} {s : State} {o : Outcome}
    (h : Exec P k c s o) : ∀ Q, wp P c Q s → o.meets Q := by
  induction h with
  | skip => intro Q hw; exact hw
  | assign he => intro Q hw; simp only [wp] at hw; exact hw _ he
  | assignTrap he => intro Q _; trivial
  | seq ha hb iha ihb => intro Q hw; simp only [wp] at hw; exact ihb Q (iha _ hw)
  | seqStop ha hst iha =>
      intro Q hw; simp only [wp] at hw; exact Outcome.meets_of_stopped hst (iha _ hw)
  | iteTrue hc ht ih => intro Q hw; simp only [wp] at hw; exact ih Q (hw.1 hc)
  | iteFalse hc he ih => intro Q hw; simp only [wp] at hw; exact ih Q (hw.2 hc)
  | iteTrap hc => intro Q _; trivial
  | whileInvFail hk hni => intro Q hw; simp only [wp] at hw; exact hni hw.1
  | whileTrap hi hc => intro Q _; trivial
  | whileDone hi hc =>
      intro Q hw; simp only [wp] at hw; exact (hw.2 _ (fun _ _ => rfl) hw.1).2 hc
  | whileStep hi hc hb hwh ihb ihw =>
      intro Q hw; simp only [wp] at hw
      have hi1 := ihb _ ((hw.2 _ (fun _ _ => rfl) hw.1).1 hc)
      refine ihw Q ?_
      simp only [wp]
      exact ⟨hi1, fun s' hfr hi' =>
        hw.2 s' (fun x hx => (hfr x hx).trans (frame hb _ rfl x hx)) hi'⟩
  | whileStop hi hc hb hst ihb =>
      intro Q hw; simp only [wp] at hw
      exact Outcome.meets_of_stopped hst (ihb _ ((hw.2 _ (fun _ _ => rfl) hw.1).1 hc))
  | callArgsTrap ha => intro Q _; trivial
  | callReqFail hf ha hk hnr => intro Q hw; simp only [wp] at hw; exact hnr (hw _ ha _ hf).1
  | callStop hf ha hr hb hst ih =>
      intro Q hw; simp only [wp] at hw
      exact Outcome.meets_of_stopped hst (ih _ (hP _ _ hf _ (hw _ ha _ hf).1))
  | callRetTrap hf ha hr hb hret ih => intro Q _; trivial
  | callEnsFail hf ha hr hb hret hk hne ih =>
      intro Q hw; simp only [wp] at hw
      exact hne (ih _ (hP _ _ hf _ (hw _ ha _ hf).1) _ hret)
  | callOk hf ha hr hb hret he ih =>
      intro Q hw; simp only [wp] at hw
      exact (hw _ ha _ hf).2 _ (ih _ (hP _ _ hf _ (hw _ ha _ hf).1) _ hret)

/-- `sound`, read at a function: called with arguments that satisfy `requires`, a proven
function never fails a clause, and the value it returns satisfies `ensures`. -/
theorem proven_fn {P : Prog} {k : Level} (hP : P.Verified) {f : String} {fn : Fn}
    (hf : P f = some fn) {vs : List Int} (hreq : fn.requires vs) {o : Outcome}
    (h : Exec P k fn.body (entry fn.params vs) o) :
    o ≠ .fail ∧ ∀ s' r, o = .ok s' → fn.ret.eval s' = some r → fn.ensures vs r := by
  have hm := sound hP h _ (hP _ _ hf _ hreq)
  constructor
  · intro e; subst e; exact hm
  · intro s' r e hr; subst e; exact hm _ hr

/-- **Proven checks are dead code.** For a proven program, a run at one check level is a run
at every other: the checks never fire, so a build without them does exactly the same. -/
theorem level_irrelevant {P : Prog} (hP : P.Verified) {k k' : Level} {c : Stmt} {s : State}
    {o : Outcome} (h : Exec P k c s o) : ∀ Q, wp P c Q s → Exec P k' c s o := by
  induction h with
  | skip => intro _ _; exact .skip
  | assign he => intro _ _; exact .assign he
  | assignTrap he => intro _ _; exact .assignTrap he
  | seq ha hb iha ihb =>
      intro Q hw; simp only [wp] at hw
      exact .seq (iha _ hw) (ihb Q (sound hP ha _ hw))
  | seqStop ha hst iha => intro Q hw; simp only [wp] at hw; exact .seqStop (iha _ hw) hst
  | iteTrue hc ht ih => intro Q hw; simp only [wp] at hw; exact .iteTrue hc (ih Q (hw.1 hc))
  | iteFalse hc he ih => intro Q hw; simp only [wp] at hw; exact .iteFalse hc (ih Q (hw.2 hc))
  | iteTrap hc => intro _ _; exact .iteTrap hc
  | whileInvFail hk hni => intro Q hw; simp only [wp] at hw; exact absurd hw.1 hni
  | whileTrap hi hc => intro Q hw; simp only [wp] at hw; exact .whileTrap (fun _ => hw.1) hc
  | whileDone hi hc => intro Q hw; simp only [wp] at hw; exact .whileDone (fun _ => hw.1) hc
  | whileStep hi hc hb hwh ihb ihw =>
      intro Q hw; simp only [wp] at hw
      have hbody := (hw.2 _ (fun _ _ => rfl) hw.1).1 hc
      have hi1 := sound hP hb _ hbody
      refine .whileStep (fun _ => hw.1) hc (ihb _ hbody) (ihw Q ?_)
      simp only [wp]
      exact ⟨hi1, fun s' hfr hi' =>
        hw.2 s' (fun x hx => (hfr x hx).trans (frame hb _ rfl x hx)) hi'⟩
  | whileStop hi hc hb hst ihb =>
      intro Q hw; simp only [wp] at hw
      exact .whileStop (fun _ => hw.1) hc (ihb _ ((hw.2 _ (fun _ _ => rfl) hw.1).1 hc)) hst
  | callArgsTrap ha => intro _ _; exact .callArgsTrap ha
  | callReqFail hf ha hk hnr => intro Q hw; simp only [wp] at hw; exact absurd (hw _ ha _ hf).1 hnr
  | callStop hf ha hr hb hst ih =>
      intro Q hw; simp only [wp] at hw
      have hq := (hw _ ha _ hf).1
      exact .callStop hf ha (fun _ => hq) (ih _ (hP _ _ hf _ hq)) hst
  | callRetTrap hf ha hr hb hret ih =>
      intro Q hw; simp only [wp] at hw
      have hq := (hw _ ha _ hf).1
      exact .callRetTrap hf ha (fun _ => hq) (ih _ (hP _ _ hf _ hq)) hret
  | callEnsFail hf ha hr hb hret hk hne ih =>
      intro Q hw; simp only [wp] at hw
      exact absurd (sound hP hb _ (hP _ _ hf _ (hw _ ha _ hf).1) _ hret) hne
  | callOk hf ha hr hb hret he ih =>
      intro Q hw; simp only [wp] at hw
      have hq := (hw _ ha _ hf).1
      exact .callOk hf ha (fun _ => hq) (ih _ (hP _ _ hf _ hq)) hret
        (fun _ => sound hP hb _ (hP _ _ hf _ hq) _ hret)

/-- **Unproven means checked.** No proof is assumed here. In a build that checks boundaries
(the default), a call that returns had its `requires` true on entry and its `ensures` true of
the value it returned: a violated clause cannot be returned from, only aborted on. -/
theorem checked_call {P : Prog} {k : Level} {x : Var} {f : String} {args : List Expr}
    {s s' : State} (hk : k.boundary = true) (h : Exec P k (.call x f args) s (.ok s')) :
    ∃ fn vs r, P f = some fn ∧ evalArgs args s = some vs ∧ fn.requires vs ∧ fn.ensures vs r ∧
      s' = s.set x r := by
  cases h with
  | callStop hf ha hr hb hst => exact absurd rfl (Outcome.stopped_ne_ok hst)
  | callOk hf ha hr hb hret he => exact ⟨_, _, _, hf, ha, hr hk, he hk, rfl⟩

end MiniMilo
