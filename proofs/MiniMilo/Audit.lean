/-
The audit: each headline theorem with the axioms it rests on, checked by the build. A `sorry`
anywhere under a theorem shows up here as `sorryAx` and fails `lake build`, as does any new
axiom. `propext`, `Classical.choice` and `Quot.sound` are Lean's own three; nothing here
adds one.
-/
import MiniMilo.Contracts
import MiniMilo.Example
import MiniMilo.MovesExample
import MiniMilo.BorrowsExample

/-- info: 'MiniMilo.frame' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.frame

/-- info: 'MiniMilo.sound' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.sound

/-- info: 'MiniMilo.proven_fn' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.proven_fn

/-- info: 'MiniMilo.level_irrelevant' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.level_irrelevant

/-- info: 'MiniMilo.checked_call' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.checked_call

/-- info: 'MiniMilo.Example.prog_verified' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Example.prog_verified

/-- info: 'MiniMilo.Example.countTo_one_runs' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Example.countTo_one_runs

/-- info: 'MiniMilo.Example.lies_fails_when_checked' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.Example.lies_fails_when_checked

/-- info: 'MiniMilo.Example.lies_returns_when_unchecked' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.Example.lies_returns_when_unchecked

/-- info: 'MiniMilo.Moves.sound' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Moves.sound

/-- info: 'MiniMilo.Moves.strings_never_rejected' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.Moves.strings_never_rejected

/-- info: 'MiniMilo.Moves.Example.noLend_accepted' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Moves.Example.noLend_accepted

/-- info: 'MiniMilo.Moves.Example.noLend_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Moves.Example.noLend_stuck

/-- info: 'MiniMilo.Moves.Example.lend_accepted' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Moves.Example.lend_accepted

/-- info: 'MiniMilo.Moves.Example.lend_shares' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Moves.Example.lend_shares

/-- info: 'MiniMilo.Moves.Example.lend_never_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Moves.Example.lend_never_stuck

/-- info: 'MiniMilo.Borrows.sound' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.sound

/-- info: 'MiniMilo.Borrows.Example.notStuck_of' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.notStuck_of

/-- info: 'MiniMilo.Borrows.Example.body_reach' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.body_reach

/-- info: 'MiniMilo.Borrows.Example.body_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.body_stuck

/-- info: 'MiniMilo.Borrows.Example.body_rejected' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.body_rejected

/-- info: 'MiniMilo.Borrows.Example.forceF_forced' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.forceF_forced

/-- info: 'MiniMilo.Borrows.Example.loansEndAtOnce_accepted' depends on axioms: [propext] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.loansEndAtOnce_accepted

/-- info: 'MiniMilo.Borrows.Example.loansEndAtOnce_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.loansEndAtOnce_stuck

/-- info: 'MiniMilo.Borrows.Example.loansEndAtOnce_rejected_by_real' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.loansEndAtOnce_rejected_by_real

/-- info: 'MiniMilo.Borrows.Example.elemIgnored_accepted' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.elemIgnored_accepted

/-- info: 'MiniMilo.Borrows.Example.elemIgnored_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.elemIgnored_stuck

/-- info: 'MiniMilo.Borrows.Example.elemIgnored_rejected_by_real' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.elemIgnored_rejected_by_real

/-- info: 'MiniMilo.Borrows.Example.pointerByLiveness_accepted' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.pointerByLiveness_accepted

/-- info: 'MiniMilo.Borrows.Example.pointerByLiveness_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.pointerByLiveness_stuck

/-- info: 'MiniMilo.Borrows.Example.pointerByLiveness_rejected_by_real' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.pointerByLiveness_rejected_by_real

/-- info: 'MiniMilo.Borrows.Example.nll_accepted' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.nll_accepted

/-- info: 'MiniMilo.Borrows.Example.nll_never_stuck' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms MiniMilo.Borrows.Example.nll_never_stuck
