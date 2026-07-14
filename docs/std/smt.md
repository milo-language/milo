# std/smt

## std/smt

### `addAtom`

```milo
fn addAtom(p: &mut SmtProblem, row: Vec<i64>, konst: i64, strict: bool): i64
```

Register an atom  row·x + konst <op> 0 ; returns its atom index.

### `cloneRow`

```milo
fn cloneRow(row: &Vec<i64>): Vec<i64>
```

_Undocumented._

### `combine`

```milo
fn combine(p: &Constraint, n: &Constraint, k: i64): Constraint
```

Combine upper row p (coeff +a on x_k) with lower row n (coeff -b): b*p + a*n.

### `decide`

```milo
fn decide(p: &SmtProblem, root: i64): Verdict
```

_Undocumented._

### `eliminateVar`

```milo
fn eliminateVar(cs: &Vec<Constraint>, k: i64): Vec<Constraint>
```

_Undocumented._

### `evalNode`

```milo
fn evalNode(p: &SmtProblem, node: i64, mask: i64): bool
```

_Undocumented._

### `feasibleRational`

```milo
fn feasibleRational(cs0: &Vec<Constraint>, nvars: i64): bool
```

Feasible over the rationals? Eliminate every variable; a surviving constant
row that is violated proves the system UNSAT.

### `findWitness`

```milo
fn findWitness(cs: &Vec<Constraint>, nvars: i64, bound: i64, maxIters: i64): Vec<i64>
```

Odometer search for a concrete integer witness, each coordinate ranging over
zigzag steps [0, 2*bound] so nearer-zero points are tried first. Capped at
maxIters so a high-dimensional box can't blow up. Empty result = none found.

### `gcd2`

```milo
fn gcd2(a: i64, b: i64): i64
```

_Undocumented._

### `inducedConstraints`

```milo
fn inducedConstraints(p: &SmtProblem, mask: i64): Vec<Constraint>
```

Build the conjunction induced by a truth assignment: atom i as-is when its
bit is set, negated otherwise.

### `nAnd`

```milo
fn nAnd(p: &mut SmtProblem, kids: Vec<i64>): i64
```

_Undocumented._

### `nAtom`

```milo
fn nAtom(p: &mut SmtProblem, atomIdx: i64): i64
```

_Undocumented._

### `newProblem`

```milo
fn newProblem(nvars: i64): SmtProblem
```

_Undocumented._

### `nNot`

```milo
fn nNot(p: &mut SmtProblem, kid: i64): i64
```

_Undocumented._

### `nOr`

```milo
fn nOr(p: &mut SmtProblem, kids: Vec<i64>): i64
```

_Undocumented._

### `reduceConstraint`

```milo
fn reduceConstraint(c: &Constraint): Constraint
```

Divide a row by the gcd of its entries — bounds Fourier–Motzkin coefficient
growth so i64 doesn't overflow on the small systems contracts produce.

### `satisfiesAll`

```milo
fn satisfiesAll(cs: &Vec<Constraint>, x: &Vec<i64>): bool
```

_Undocumented._

### `verdictName`

```milo
fn verdictName(v: &Verdict): string
```

Decide SAT of the formula rooted at `root`. In a proof obligation the root is
(assumptions ∧ body-paths ∧ ¬goal), so:
  Proven      = UNSAT (no assignment yields a feasible conjunction)
  Violated(w) = SAT with a concrete integer counterexample w
  Unknown     = rational-feasible but no integer witness in the search box
                (the QF_LIA integer gap this Tier-1 core doesn't close)

### `witnessBound`

```milo
fn witnessBound(nvars: i64): i64
```

Per-variable box radius so the total search (2b+1)^nvars stays near a few
million points — wide in low dimensions, tight in high ones.

### `zigzag`

```milo
fn zigzag(step: i64): i64
```

Map an odometer step 0,1,2,3,4,... to values 0,-1,1,-2,2,... so the search
fans out from the origin and returns small-magnitude witnesses (a clean
counterexample like x=-1, not the box corner x=-700).
