# std/smt

## std/smt

### `addAtom`

```milo
pub fn addAtom(p: &mut SmtProblem, row: Vec<i64>, konst: i64, strict: bool): i64
```

Register an atom  row·x + konst <op> 0 ; returns its atom index.

### `cloneRow`

```milo
pub fn cloneRow(row: &Vec<i64>): Vec<i64>
```

_Undocumented._

### `combine`

```milo
pub fn combine(p: &Constraint, n: &Constraint, k: i64): Option<Constraint>
```

Combine upper row p (coeff +a on x_k) with lower row n (coeff -b): b*p + a*n.
None when the arithmetic overflows — see combineTerm.

### `combineTerm`

```milo
pub fn combineTerm(b: i64, pj: i64, a: i64, nj: i64): Option<i64>
```

b*p[j] + a*n[j], or None if any step overflows i64.

This is the soundness seam. Fourier-Motzkin multiplies constants together, so a konst
anywhere near 2^62 overflows on the first combine. Wrapping (the -O2 behaviour) flips
the sign, the row becomes nonsense, the system looks infeasible, and `decide` reports
UNSAT — i.e. **proven**. A false proof is the worst answer a prover can give, so an
overflow must reach the caller as "cannot decide" and never as a verdict.

### `decide`

```milo
pub fn decide(p: &SmtProblem, root: i64): Verdict
```

_Undocumented._

### `eliminateVar`

```milo
pub fn eliminateVar(cs: &Vec<Constraint>, k: i64): Option<Vec<Constraint>>
```

None when any combine overflows — the caller must not read that as infeasible.

### `evalNode`

```milo
pub fn evalNode(p: &SmtProblem, node: i64, mask: i64): bool
```

_Undocumented._

### `feasibleRational`

```milo
pub fn feasibleRational(cs0: &Vec<Constraint>, nvars: i64): Option<bool>
```

Feasible over the rationals? Eliminate every variable; a surviving constant
row that is violated proves the system UNSAT.
None = the elimination overflowed, so feasibility is undecided here. Returning `false`
(infeasible) in that case is what produced false proofs.

### `findWitness`

```milo
pub fn findWitness(cs: &Vec<Constraint>, nvars: i64, bound: i64, maxIters: i64): Vec<i64>
```

Odometer search for a concrete integer witness, each coordinate ranging over
zigzag steps [0, 2*bound] so nearer-zero points are tried first. Capped at
maxIters so a high-dimensional box can't blow up. Empty result = none found.

### `gcd2`

```milo
pub fn gcd2(a: i64, b: i64): i64
```

_Undocumented._

### `inducedConstraints`

```milo
pub fn inducedConstraints(p: &SmtProblem, mask: i64): Vec<Constraint>
```

Build the conjunction induced by a truth assignment: atom i as-is when its
bit is set, negated otherwise.

### `nAnd`

```milo
pub fn nAnd(p: &mut SmtProblem, kids: Vec<i64>): i64
```

_Undocumented._

### `nAtom`

```milo
pub fn nAtom(p: &mut SmtProblem, atomIdx: i64): i64
```

_Undocumented._

### `newProblem`

```milo
pub fn newProblem(nvars: i64): SmtProblem
```

_Undocumented._

### `nNot`

```milo
pub fn nNot(p: &mut SmtProblem, kid: i64): i64
```

_Undocumented._

### `nOr`

```milo
pub fn nOr(p: &mut SmtProblem, kids: Vec<i64>): i64
```

_Undocumented._

### `reduceConstraint`

```milo
pub fn reduceConstraint(c: &Constraint): Constraint
```

Divide a row by the gcd of its entries — bounds Fourier–Motzkin coefficient
growth so i64 doesn't overflow on the small systems contracts produce.

### `satisfiesAll`

```milo
pub fn satisfiesAll(cs: &Vec<Constraint>, x: &Vec<i64>): bool
```

_Undocumented._

### `verdictName`

```milo
pub fn verdictName(v: &Verdict): string
```

Decide SAT of the formula rooted at `root`. In a proof obligation the root is
(assumptions ∧ body-paths ∧ ¬goal), so:
  Proven      = UNSAT (no assignment yields a feasible conjunction)
  Violated(w) = SAT with a concrete integer counterexample w
  Unknown     = rational-feasible but no integer witness in the search box
                (the QF_LIA integer gap this Tier-1 core doesn't close)

### `witnessBound`

```milo
pub fn witnessBound(nvars: i64): i64
```

Per-variable box radius so the total search (2b+1)^nvars stays near a few
million points — wide in low dimensions, tight in high ones.

### `zigzag`

```milo
pub fn zigzag(step: i64): i64
```

Map an odometer step 0,1,2,3,4,... to values 0,-1,1,-2,2,... so the search
fans out from the origin and returns small-magnitude witnesses (a clean
counterexample like x=-1, not the box corner x=-700).
