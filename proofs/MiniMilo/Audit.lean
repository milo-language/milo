/-
The audit: each headline theorem with the axioms it rests on, checked by the build. A `sorry`
anywhere under a theorem shows up here as `sorryAx` and fails `lake build`, as does any new
axiom. `propext`, `Classical.choice` and `Quot.sound` are Lean's own three; nothing here
adds one.
-/
import MiniMilo.Contracts
import MiniMilo.Example

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
