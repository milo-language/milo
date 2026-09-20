// Verification condition generator — produces SMT-LIB2 from contract annotations
// and symbolically executes function bodies to prove postconditions.
import type { Program, Function, Contract, Expr, Stmt, MiloType } from "./ast";
import { must } from "./must";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

export interface VerificationCondition {
  fn: string;
  kind: "precondition" | "postcondition" | "loop-invariant" | "termination" | "struct-invariant" | "assert";
  smtlib: string;
  description: string;
  // Callees whose `ensures` this VC was allowed to ASSUME. Modular verification is
  // assume-guarantee: a proof here is only as good as those callees' own postcondition
  // proofs, and if one of them came back `unknown` this "proven" rests on something
  // nothing checked. Reported rather than silently trusted — see conditionalProofs.
  assumes?: string[];
  // Struct types whose `invariant` this VC was allowed to ASSUME, and — on a
  // struct-invariant VC — the type it is discharging FOR. Same assume-guarantee bookkeeping
  // as `assumes`: an invariant is in force at every use site, so a use-site proof is only as
  // good as the construction and maintenance obligations for that type.
  assumesInvariants?: string[];
  invariantOf?: string;
  // Proof cuts (`assert E`) this VC was allowed to ASSUME, named by the cut's own
  // description, and — on a cut's own VC — the name it is discharging. Same
  // assume-guarantee bookkeeping as `assumes`: a postcondition downstream of a REFUTED cut
  // proved cleanly and said nothing about it before this existed, which is the one way a
  // proof cut can turn into a false proof.
  assumesCuts?: string[];
  cutId?: string;
  // Callees modelled by an INVENTED value: a `@pure` fn with no `ensures` gets a symbol
  // that says only "this call has one fixed value per argument list". That is sound to
  // assume, but the solver is free to pick any value for it, so a counterexample built on
  // one is not reproducible — `Math.sqrt`'s `ensures result >= 0.0` was "refuted" by a
  // negative sqrt. A VC carrying these can be PROVEN (nothing false was assumed) but must
  // never be REFUTED; the verdict degrades to `unknown`, which is what the model actually
  // knows. Same rule the pre-`@pure` code enforced by refusing to model the call at all.
  opaqueCalls?: string[];
  // Mutations this VC's formula depends on that NOTHING in the program describes: a `&mut`
  // argument or method receiver havoced at a call whose callee has no `ensures` (or a
  // builtin outside BUILTIN_CONTRACTS), or a variable a loop writes that no invariant or
  // guard mentions. Each entry reads `'<name>' after <what>`. The havoc is what keeps the
  // walker sound, but the fresh symbol it mints is a free variable, and a model over a free
  // variable is not a counterexample: `v.len == old(v.len) + 1` after `v.push(x)` was
  // "refuted" with `v_len__mut1 = 0` before push had a contract. Same rule as opaqueCalls:
  // PROVEN is still meaningful, REFUTED degrades to `unknown`.
  unconstrainedHavocs?: string[];
}

// The reason a sat verdict on `vc` cannot be reported as `failed`, or null when the model
// ranges only over symbols the program constrains. Shared by both solver back ends so the
// two cannot drift on which verdicts are honest.
export function unreproducibleCounterexample(vc: VerificationCondition): string | null {
  if (vc.opaqueCalls?.length) {
    return `the value of ${vc.opaqueCalls.map(n => `'${n}'`).join(", ")} is unconstrained — it is @pure but declares no 'ensures', so any counterexample here is not reproducible`;
  }
  if (vc.unconstrainedHavocs?.length) {
    return `the value of ${vc.unconstrainedHavocs.join(", ")} is unconstrained, so any counterexample here is not reproducible`;
  }
  return null;
}

export interface VerifyResult {
  conditions: VerificationCondition[];
  stats: { functions: number; contracts: number; loops: number };
}

// Module-level immutable constants (top-level `let`), resolved once per run so
// contract expressions that reference them (e.g. `idx & VRAM_MASK`) translate to
// concrete SMT literals instead of leaking an undeclared symbol to the solver.
let GLOBAL_CONST_SMT = new Map<string, string>(); // name -> SMT literal string
let GLOBAL_CONST_NUM = new Map<string, bigint>();  // name -> numeric value

// A call inside a body or contract can't be inlined (the callee may be recursive, and
// unfolding is unbounded anyway), so each call site becomes one fresh constant standing
// for that single invocation, constrained by the callee's `ensures` — standard modular
// verification. Without this a call reached the solver as an undeclared symbol and z3
// rejected the entire query instead of returning a verdict.
//
// For a self-recursive call this is induction, which is only sound if the recursion
// terminates. Milo has no termination checker (no `decreases` clause), so a proof
// involving recursion is conditional on termination.
interface CallModel {
  ensuresByFn: Map<string, Function>;
  decls: string[];
  assumes: string[];
  n: number;
  // Every symbol the enclosing function's VCs declare. A callee contract may mention names
  // that exist only in the callee (a local, a field of its own receiver); substituting its
  // parameters does not remove those, and emitting them here would put an undeclared
  // symbol back in the query — the exact failure this call model exists to prevent.
  scope: Set<string>;
  // A body is lowered more than once per function (once for call-site obligations, once
  // per postcondition), so key on the AST node: the same call site must map to the same
  // constant. Two textually identical call sites are deliberately NOT shared — a Milo fn
  // may read mutable state, so assuming f(x) == f(x) across invocations could prove
  // something false.
  // Keyed by arg strings too: the same site lowered in two different states (loop entry vs
  // havoced body) must not reuse a constant whose assumption was built from the other
  // state's arguments — that would assume a fact about the wrong values.
  bySite: WeakMap<object, Map<string, string>>;
  // The exception to the no-sharing rule above: a `@pure` callee with no `&mut` parameter
  // is a function of its arguments alone, so `f(x)` denotes one value no matter how many
  // times it is written. Keyed by name + argument terms, and *not* by site.
  byPureKey: Map<string, string>;
  // Callee names whose postconditions were assumed while building this function's VCs.
  assumed: Set<string>;
  // Callee names modelled by an unconstrained shared symbol — see `opaqueCalls`.
  opaque: Set<string>;
}

// Scalar sorts the SMT translation models exactly. `miloTypeToSmt` falls back to `Int` for
// anything else, which is fine for a symbol constrained by an `ensures` (the constraint is
// what carries meaning) but not for an unconstrained one invented purely to be shared —
// an `Int` standing in for a struct would let the solver equate values that are not equal.
const SCALAR_RET = new Set(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool"]);
let CALL_MODEL: CallModel | null = null;

// Placeholder line in a VC's SMT-LIB, replaced with this function's accumulated call
// declarations once every VC for the function has been built. Needed because call sites
// are discovered while lowering bodies, which happens after the declaration block is
// assembled. Left as-is it is an SMT comment, so a missed substitution is inert.
const CALL_MODEL_SLOT = "; (call model)";

// SMT-LIB operators and literals that are not symbols needing a declaration.
const SMT_BUILTINS = new Set([
  "and", "or", "not", "=>", "=", "distinct", "ite", "true", "false",
  "div", "mod", "abs", "to_real", "to_int", "let", "-", "+", "*", "/",
  "<", ">", "<=", ">=",
]);

// Every free symbol in `smt` must already be declared in the enclosing function's query.
// FIELD_REFS counts: it is the set the declaration block is built from, and it is still
// open at this point — a callee's `ensures result.len == 16` rebases to a fresh
// `genKey__ret0_len` that gets declared alongside the others.
function symbolsResolve(smt: string, ctx: CallModel, extra?: string): boolean {
  for (const m of smt.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const sym = m[0];
    if (SMT_BUILTINS.has(sym)) continue;
    if (ctx.scope.has(sym)) continue;
    if (FIELD_REFS?.has(sym)) continue;
    if (sym === extra) continue;
    return false;
  }
  return true;
}

function modelCall(site: object, name: string, args: Expr[], env?: Map<string, string>): string | null {
  const ctx = CALL_MODEL;
  if (!ctx) return null;
  // A `@pure` callee with no `&mut` parameter depends on nothing but its arguments, so a
  // shared unconstrained constant is sound even with no contract to describe it: it says
  // only "this call has some fixed value", which is true. That is what lets `f(x) == f(x)`
  // be assumed, and it is why the bail-outs below are relaxed for such a callee.
  const functional = PURE_FN_NAMES.has(name) && SCALAR_RET.has(FN_TABLE.get(name)?.retType?.name ?? "");
  const callee = ctx.ensuresByFn.get(name) ?? (functional ? FN_TABLE.get(name) : undefined);
  // No contract to constrain the return value: for an impure callee an unconstrained fresh
  // constant would let the solver "violate" a postcondition using a return value the callee
  // can never produce. Report unknown rather than a counterexample the user can't reproduce.
  if (!callee || callee.params.length !== args.length) return null;
  const ensures = callee.contracts.filter(c => c.kind === "ensures");
  if (ensures.length === 0 && !functional) return null;
  // A postcondition about what the callee WROTE through a `&mut` cannot be modelled HERE:
  // the caller's post-call symbol for that argument is minted later, by the havoc. Assuming
  // it under the pre-call substitution would assert something false — see the note above.
  // Those clauses are dropped from the return-value model and picked up instead by the frame
  // assumption emitted at the call statement, which has both states in hand.
  const mutParams = new Set(callee.params.filter(p => p.type?.isRefMut || p.type?.isPtr).map(p => p.name));
  const usableEnsures = mutParams.size === 0
    ? ensures
    : ensures.filter(e => !mentionsMutParamPostState(e.expr, mutParams));
  if (usableEnsures.length === 0 && !functional) return null;

  // Lowered IN THE CALLER'S ENVIRONMENT. Without it every argument naming a local came out
  // as a bare undeclared symbol, the whole model was rejected below, and the call degraded
  // to an unknown — so `let b = clamp(end, len)` left `b` untranslatable and the loop guard
  // built from it silently vanished from the invariant's preservation query.
  const argSmt = args.map(a => (env ? exprToSmtWithEnv(a, env) : exprToSmt(a)));
  if (argSmt.some(a => /UNSUPPORTED/.test(a))) return null;
  const siteKey = argSmt.join(",");
  const pureKey = functional ? `${name}(${siteKey})` : null;
  if (pureKey) {
    const shared = ctx.byPureKey.get(pureKey);
    if (shared) return shared;
  }
  const cached = ctx.bySite.get(site)?.get(siteKey);
  if (cached) return cached;
  // The declaration block is shared by every VC of the enclosing function, but `result`
  // is only declared in postcondition VCs — an assumption mentioning it would leak an
  // undeclared symbol into the precondition ones.
  if (argSmt.some(a => /\bresult\b/.test(a))) return null;

  const retName = `${name}__ret${ctx.n++}`;
  const retType = callee.retType?.name ?? "i64";
  if (isLenBearingType(callee.retType)) LEN_BEARING.add(retName);
  const subst = env ? new Map(fieldBindings(callee.params, args, env)) : new Map<string, string>();
  callee.params.forEach((p, i) => subst.set(p.name, argSmt[i]!));
  subst.set("result", retName);
  const facts = usableEnsures
    .map(e => exprToSmtWithEnv(e.expr, subst, true))
    .filter(s => !/UNSUPPORTED/.test(s));
  // Nothing sayable about the value. For a functional callee that is still worth a symbol —
  // shared across sites, it carries `f(x) == f(x)` and nothing else, which is exactly the
  // guarantee `@pure` provides. For anyone else it is the unconstrained-unknown trap.
  if (facts.length === 0) {
    if (!pureKey) return null;
    ctx.decls.push(declareConst(retName, retType));
    const r = intRangeAssumption(retName, retType);
    if (r) ctx.assumes.push(r);
    ctx.scope.add(retName);
    ctx.byPureKey.set(pureKey, retName);
    ctx.opaque.add(name);
    return retName;
  }

  // A callee only guarantees its `ensures` when its `requires` were met, so what may be
  // assumed here is the implication, never the bare postcondition. Assuming the bare form
  // is circular: discharging `lo <= hi` at a call to clamp would get to assume clamp's
  // `lo <= result <= hi`, which entails `lo <= hi` — the obligation proves itself.
  const guards = callee.contracts
    .filter(c => c.kind === "requires")
    .map(c => exprToSmtWithEnv(c.expr, subst, true));
  // An untranslatable `requires` can't be stated as the implication's antecedent, and
  // dropping it would silently restore the circular form.
  if (guards.some(g => /UNSUPPORTED/.test(g))) return null;

  // `retName` is declared unconditionally a few lines below, but it is not in ctx.scope
  // yet — and it is the one symbol a callee's `ensures result ...` is guaranteed to
  // mention. Checking without it rejected EVERY scalar-returning callee's postcondition,
  // silently: the model was dropped, the call became an unconstrained unknown, and loop
  // guards built from it turned into UNSUPPORTED. It is passed as an allowance rather
  // than added to the scope so that bailing out below cannot leave a scope entry with no
  // matching declaration.
  if (![...facts, ...guards].every(s => symbolsResolve(s, ctx, retName))) return null;

  const conclusion = facts.length === 1 ? facts[0]! : `(and ${facts.join(" ")})`;
  const antecedent = guards.length === 0
    ? null
    : guards.length === 1 ? guards[0]! : `(and ${guards.join(" ")})`;

  ctx.decls.push(declareConst(retName, retType));
  const range = intRangeAssumption(retName, retType);
  if (range) ctx.assumes.push(range);
  ctx.assumes.push(`(assert ${antecedent ? `(=> ${antecedent} ${conclusion})` : conclusion})`);
  // This VC now leans on `name`'s postcondition being true. A builtin's is the runtime's
  // to keep, not something this run could establish, so it is not reported as conditional.
  if (!builtinConstructors().has(name)) ctx.assumed.add(name);
  ctx.scope.add(retName);   // a later call may take this one's result as an argument
  const perSite = ctx.bySite.get(site) ?? new Map<string, string>();
  perSite.set(siteKey, retName);
  ctx.bySite.set(site, perSite);
  if (pureKey) ctx.byPureKey.set(pureKey, retName);
  return retName;
}

// Splice the accumulated call declarations into every VC built for one function. Runs
// even when nothing was modelled, so the placeholder never survives into emitted SMT.
function fillCallModel(conditions: VerificationCondition[], from: number) {
  const ctx = CALL_MODEL;
  if (!ctx) return;
  const block = [...ctx.decls, ...ctx.assumes].join("\n");
  const assumed = [...ctx.assumed];
  const opaque = [...ctx.opaque];
  for (let i = from; i < conditions.length; i++) {
    conditions[i]!.smtlib = block
      ? conditions[i]!.smtlib.replace(CALL_MODEL_SLOT, block)
      : conditions[i]!.smtlib.replace(`${CALL_MODEL_SLOT}\n`, "");
    if (assumed.length) conditions[i]!.assumes = assumed;
    if (opaque.length) conditions[i]!.opaqueCalls = opaque;
  }
}

// Which contract-less havoc symbols each VC's formula actually depends on. Only the
// assertions count: a declaration, or the typing fact minted next to it, names the symbol
// without the obligation resting on it. A VC that mentions none can still be refuted with a
// real counterexample; one that does can only be proven or left unknown.
function markUnconstrainedHavocs(conditions: VerificationCondition[], from: number) {
  if (UNCONSTRAINED_HAVOCS.size === 0) return;
  for (let i = from; i < conditions.length; i++) {
    const touched = new Set<string>();
    for (const line of conditions[i]!.smtlib.split("\n")) {
      const t = line.trim();
      if (t.startsWith("(declare-") || t.startsWith(";") || HAVOC_TYPING_FACTS.has(t)) continue;
      for (const m of t.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
        const free = UNCONSTRAINED_HAVOCS.get(m[0]);
        if (free) touched.add(`'${free.place}' after ${free.why}`);
      }
    }
    if (touched.size) conditions[i]!.unconstrainedHavocs = [...touched];
  }
}

// Fold a constant expression (int literals, const globals, const arithmetic) to
// a number, or null if it isn't statically constant. Used to recognise shift
// amounts and power-of-two masks in the bitwise lowering below.
function resolveConstNum(expr: Expr): bigint | null {
  if (!expr) return null;
  if (expr.kind === "IntLit") return BigInt(expr.value);
  if (expr.kind === "Ident") return GLOBAL_CONST_NUM.get(expr.name) ?? null;
  if (expr.kind === "UnaryOp" && expr.op === "-") {
    const v = resolveConstNum(expr.operand); return v === null ? null : -v;
  }
  if (expr.kind === "CastExpr") return resolveConstNum(expr.operand);
  if (expr.kind === "BinOp") {
    const l = resolveConstNum(expr.left), r = resolveConstNum(expr.right);
    if (l === null || r === null) return null;
    switch (expr.op) {
      case "+": return l + r; case "-": return l - r; case "*": return l * r;
      case "<<": return l << r; case ">>": return l >> r;
      case "&": return l & r; case "|": return l | r; case "^": return l ^ r;
      case "/": return r === 0n ? null : l / r; case "%": return r === 0n ? null : l % r;
    }
  }
  return null;
}

function numToSmt(n: bigint): string {
  return n < 0n ? `(- ${-n})` : n.toString();
}

// An integer cast: unsigned narrowing is exact modular truncation; widening and
// i64/u64 are value-preserving in our unbounded-Int model, so identity.
function castToSmt(operandStr: string, targetName: string): string {
  const toFloat = targetName === "f32" || targetName === "f64";
  if (toFloat) {
    // Widening an integer is exact, so the cast is just a sort change. Float-to-float is
    // a no-op in this model (no rounding notion), which is why f32 narrowing is not
    // distinguished — the same unbounded-precision assumption the Int model already makes.
    return isRealSmt(operandStr) ? operandStr : `(to_real ${operandStr})`;
  }
  // The reverse direction is not a sort change to paper over: Milo's float-to-int cast
  // truncates toward zero and SMT-LIB's `to_int` is a floor, so they disagree on every
  // negative value. Truncation IS floor on the magnitude, so spell it that way rather than
  // emitting a `to_int` that models a cast the program does not perform.
  const intOperand = isRealSmt(operandStr)
    ? `(ite (>= ${operandStr} 0.0) (to_int ${operandStr}) (- (to_int (- ${operandStr}))))`
    : operandStr;
  switch (targetName) {
    case "u8": return `(mod ${intOperand} 256)`;
    case "u16": return `(mod ${intOperand} 65536)`;
    case "u32": return `(mod ${intOperand} 4294967296)`;
    default: return intOperand;
  }
}

// SMT symbols this function's query declares with sort Real. Reset per function, because
// the same Milo name is an i64 in one function and an f64 in the next, and misreading the
// sort picks the wrong division operator.
let REAL_SYMS = new Set<string>();
let NONREAL_SYMS = new Set<string>();

function declareConst(name: string, typeName: string | undefined): string {
  const sort = miloTypeToSmt(typeName ?? "i64");
  (sort === "Real" ? REAL_SYMS : NONREAL_SYMS).add(name);
  return `(declare-const ${name} ${sort})`;
}

// Is an already-emitted term real-sorted? Only the leaves matter: every arithmetic operator
// here is sort-preserving, so a term is Real exactly when it mentions a Real symbol or a
// decimal literal.
//
// A declared sort always wins. The FLOAT_FIELDS fallback is for the field paths lowering
// invents after the declaration block is assembled (`c__mut2_vx` and friends) — same rule
// fieldSort will apply to them, applied early. It is gated on the symbol looking like a
// flattened path at all, so an ordinary parameter cannot be mistaken for a struct field
// that happens to share its name.
function isRealSmt(s: string): boolean {
  for (const t of s.split(/[\s()]+/)) {
    if (!t) continue;
    if (/^\d+\.\d+$/.test(t)) return true;
    if (NONREAL_SYMS.has(t)) continue;
    if (REAL_SYMS.has(t)) return true;
    if (t.includes("_") && FLOAT_FIELDS.has(t.slice(t.lastIndexOf("_") + 1))) return true;
  }
  return false;
}

// A float literal as an SMT-LIB decimal. Anything JS renders in exponent form (1e21, and
// the infinities/NaN a constant fold could produce) has no decimal spelling, so it stays
// untranslated rather than being emitted as something the solver would read differently.
function floatLitToSmt(v: number): string {
  if (!Number.isFinite(v)) return `(UNSUPPORTED FloatLit)`;
  const mag = Math.abs(v);
  const s = Number.isInteger(mag) ? mag.toFixed(1) : String(mag);
  if (!/^\d+\.\d+$/.test(s)) return `(UNSUPPORTED FloatLit)`;
  return v < 0 ? `(- ${s})` : s;
}

// `/` is truncating integer division on ints and exact division on floats — one Milo
// operator, two SMT operators, told apart by the operand sorts.
function realDivToSmt(op: string, left: string, right: string): string | null {
  if (op !== "/") return null;
  if (!isRealSmt(left) && !isRealSmt(right)) return null;
  return `(/ ${left} ${right})`;
}

// Bitwise/shift with a constant operand lowered to linear/nonlinear integer
// arithmetic: `x << k` = x*2^k, `x >> k` = x div 2^k, and `x & (2^k-1)` = x mod
// 2^k (exact for the unsigned masking idiom). Returns null when the pattern
// isn't a constant shift/pow2-mask, so the caller falls back to the generic op.
function bitOpToSmt(op: string, leftStr: string, rightExpr: Expr): string | null {
  const c = resolveConstNum(rightExpr);
  if (c === null || c < 0n) return null;
  if (op === "<<") return `(* ${leftStr} ${numToSmt(1n << c)})`;
  if (op === ">>") return `(div ${leftStr} ${numToSmt(1n << c)})`;
  if (op === "&" && (c & (c + 1n)) === 0n) return `(mod ${leftStr} ${numToSmt(c + 1n)})`;
  // Single-bit test: `x & 0x80`. Distinct from the mask case above (0x80 is not 2^k-1), and
  // far more common — every CPU flag check in an emulator is one. Extracting bit k as
  // `2^k * ((x div 2^k) mod 2)` stays linear, and floor/Euclidean semantics give the right
  // answer for negative x too, since those are the two's-complement bits.
  if (op === "&" && c > 0n && (c & (c - 1n)) === 0n) {
    const p2 = numToSmt(c);
    return `(* ${p2} (mod (div ${leftStr} ${p2}) 2))`;
  }

  // SMT-LIB `div`/`mod` are EUCLIDEAN — the remainder is never negative, so -7 mod 3 is 2.
  // Milo's `/` and `%` truncate toward zero like C, so -7 % 3 is -1. Lowering one to the
  // other was a FALSE PROOF: `ensures result == 2` on `a % 3` with `a == -7` came back
  // proven for a function that returns -1.
  //
  // Truncation is rebuilt out of floor division, which agrees with truncation on
  // non-negative operands: trunc(a/b) = a >= 0 ? floor(a/|b|) : -floor(-a/|b|), negated
  // again when the divisor is negative. The remainder follows from `a - b*q`, which stays
  // linear because `b` is a literal here. A NON-constant divisor gets no rule at all (see
  // binOpToSmt) rather than the wrong one — unknown beats a plausible lie.
  return null;
}

// Truncating `/` and `%`, for any divisor. SMT-LIB `div`/`mod` are EUCLIDEAN — the
// remainder is never negative, so -7 mod 3 is 2 — while Milo truncates toward zero like C
// and gives -1. Lowering one onto the other was a false proof: `ensures result == 2` on
// `a % 3` came back proven for a function returning -1.
//
// Truncation is rebuilt from floor division, which agrees with truncation whenever the
// operands are non-negative, so each sign quadrant is handled explicitly. A constant
// divisor keeps the whole thing linear; a symbolic one leaves `(* b q)` in the remainder,
// which z3 can often still decide and the native linear solver reports unknown for.
function truncDivToSmt(op: string, leftStr: string, rightStr: string, rightConst: bigint | null): string | null {
  if (rightConst === 0n) return null;   // division by zero: no meaning to model
  const neg = (x: string) => `(- ${x})`;
  if (rightConst !== null) {
    const mag = numToSmt(rightConst < 0n ? -rightConst : rightConst);
    let q = `(ite (>= ${leftStr} 0) (div ${leftStr} ${mag}) ${neg(`(div ${neg(leftStr)} ${mag})`)})`;
    if (rightConst < 0n) q = neg(q);
    return op === "/" ? q : `(- ${leftStr} (* ${numToSmt(rightConst)} ${q}))`;
  }
  // Symbolic divisor: four quadrants, each reduced to floor division on non-negatives.
  const q =
    `(ite (>= ${leftStr} 0)` +
    ` (ite (> ${rightStr} 0) (div ${leftStr} ${rightStr}) ${neg(`(div ${leftStr} ${neg(rightStr)})`)})` +
    ` (ite (> ${rightStr} 0) ${neg(`(div ${neg(leftStr)} ${rightStr})`)} (div ${neg(leftStr)} ${neg(rightStr)})))`;
  return op === "/" ? q : `(- ${leftStr} (* ${rightStr} ${q}))`;
}

// Every variable a statement list assigns to, including through nested control flow.
// A loop's effect on the environment is unbounded, so these are the names that have to be
// replaced by fresh unknowns (havoc) before execution can continue past it.
// The one definition of "what is inside this node". Every walker that has to find
// something ANYWHERE beneath a node goes through here, because the alternative — each
// walker naming the fields it happens to know about — is fail-OPEN: a field nobody listed
// is silently not traversed, and in a prover "silently not traversed" is how a stale fact
// survives into a proof.
//
// This file had four different answers to the question, and three of them were wrong in
// different places. The costly one: statements nest inside EXPRESSIONS in this language
// (`IfExpr`/`MatchExpr` arms and closure bodies are all `Stmt[]`), and the assigned-vars
// walker only ever descended statement fields. So `x = 100` inside an if-expr arm was
// invisible to loop havoc, and
//     var x = 0; while .. { let d = if .. { x = 100 \n 1 } else { 0 } .. }; return x
// PROVED `ensures result == 0` for a function that returns 100.
//
// Total by construction: every own property is descended except `span` (source positions
// carry no nodes). An AST node kind added tomorrow is traversed with no edit here — which
// is the actual point. `visit` returning false prunes that subtree; anything else descends.
function walkNodes(node: unknown, visit: (n: any) => boolean | void, seen = new Set<unknown>()): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const x of node) walkNodes(x, visit, seen);
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.kind === "string" && visit(n) === false) return;
  // Read the keys AFTER visit: rewriteStaticCalls rewrites a node in place and relies on
  // the descent seeing its new shape.
  for (const key of Object.keys(n)) {
    if (key === "span") continue;
    walkNodes(n[key], visit, seen);
  }
}

function collectAssignedVars(stmts: Stmt[], out: Set<string>): void {
  walkNodes(stmts, n => {
    if (n.kind !== "Assign") return;
    if (n.target?.kind === "Ident") out.add(n.target.name);
    else {
      const flat = flattenFieldAccess(n.target);
      if (flat) out.add(flat);
    }
  });
}

// A loop that needs establishment/preservation obligations proved, captured while walking
// the enclosing body so both are stated in the environment that actually reaches the loop.
interface LoopObligation {
  entryConds: string[];             // path conditions holding at loop entry
  entryEnv: Map<string, string>;    // environment at loop entry, for establishment
  havocEnv: Map<string, string>;    // entry env with modified vars replaced by fresh consts
  guard: string;                    // loop condition, lowered in havocEnv
  invariants: Contract[];
  variants: Contract[];             // `decreases` measures — termination, not correctness
  body: Stmt[];
  bodyRun: SymExecResult;
  // A for-in loop has no assignment that advances its binding, so the post-iteration state
  // is the body's final environment with this patch applied on top (`i` → `i + 1` for a
  // counted loop). Absent for a while loop, whose body does its own advancing.
  nextPatch?: Map<string, string>;
}

// Symbolic path through a function body
interface SymPath {
  conditions: string[];  // path conditions as SMT expressions
  result: string;        // return value expression
  // State at the `return`. A postcondition names the state at exit, so `ensures n == 100`
  // on a `&mut` parameter has to read the value the path left behind, not the one it
  // started with — and `old(n)` reads the entry environment instead.
  env: Map<string, string>;
}

// A struct literal reached during symbolic execution: where its type's `invariant` clauses
// have to be discharged, since this is the point the value comes into existence.
interface StructLitSite {
  struct: string;
  fields: Map<string, string>;   // field name -> value, lowered in the env at the literal
  conditions: string[];
}

// An `assert(E)` reached during symbolic execution — the proof cut, and the practical
// substitute for the quantifiers this prover deliberately does not have (see
// docs/verification-roadmap.md). It carries two obligations in one statement: E must be
// PROVEN where it is written, and downstream it may be ASSUMED, so a user can hand the
// solver the one intermediate fact that turns a nonlinear VC into a linear one.
//
// Assuming it downstream is sound for a reason specific to `assert` and NOT available to a
// bare `assume`: codegen emits an unconditional abort on a false assert, in every build
// mode, so no execution reaches the following statement with E false. An `assume` with no
// runtime check would be a false proof with a keyword, which is why there is no such form.
//
// A cut whose own proof comes back `unknown` still feeds the assumption, exactly as a call
// to a function whose `ensures` was never discharged does — that is ordinary
// assume-guarantee, and `assumes` on the downstream VC is what records it.
interface AssertSite {
  cond: string;          // lowered to SMT in the environment at the assert
  conditions: string[];  // path conditions in force where it is written
  source: string;        // the expression as the user wrote it, for the description
  line: number;
}

// The condition of a statement that is exactly `assert(E)` — nothing else. Deliberately
// narrow: `assert` is variadic (a second argument is the failure message), and an assert
// buried in a larger expression is not a statement-level cut.
function assertCondition(stmt: Stmt): Expr | null {
  if (stmt.kind !== "ExprStmt") return null;
  const e = stmt.expr as any;
  if (e?.kind !== "Call" || e.func !== "assert") return null;
  const first = e.args?.[0];
  const inner = first?.expr ?? first;
  return inner && typeof inner === "object" && "kind" in inner ? (inner as Expr) : null;
}

// A one-line rendering of the asserted expression for the VC description. The prover has no
// access to source text, and "assert holds" with no expression names nothing when three cuts
// in one function each report a different verdict.
function exprSource(e: Expr): string {
  const n = e as any;
  switch (n.kind) {
    case "Ident": return n.name;
    case "IntLit": case "FloatLit": return String(n.value);
    case "BoolLit": return String(n.value);
    case "BinOp": return `${exprSource(n.left)} ${n.op} ${exprSource(n.right)}`;
    case "UnaryOp": return `${n.op}${exprSource(n.operand)}`;
    case "FieldAccess": return `${exprSource(n.object)}.${n.field}`;
    case "IndexAccess": return `${exprSource(n.object)}[${exprSource(n.index)}]`;
    case "Call": return `${n.func}(…)`;
    case "MethodCall": return `${exprSource(n.object)}.${n.method}(…)`;
    default: return n.kind;
  }
}

// Collect all execution paths through a function body via symbolic execution.
// Handles if/else chains and early returns — the common pattern in contract-bearing functions.
interface SymExecResult {
  paths: SymPath[];
  finalEnvs: { conditions: string[]; env: Map<string, string> }[];
  breakEnvs: { conditions: string[]; env: Map<string, string> }[];
  continueEnvs: { conditions: string[]; env: Map<string, string> }[];
  calls: CallSite[];
  // Fresh constants introduced by havoc, to be spliced into the function's declaration
  // block — path conditions reference them, so an undeclared one poisons every VC.
  havocDecls: string[];
  loops: LoopObligation[];
  structLits: StructLitSite[];
  asserts: AssertSite[];
}

interface SymExecContext {
  havocSeq: number;
  havocDecls: string[];
}

// A call reached during symbolic execution, with the path conditions that hold when it
// runs. Used to prove the caller actually satisfies the callee's `requires` — without the
// conditions, `if x >= 0 { g(x) }` would be reported as a violation of g's `requires
// x >= 0`, and a prover that cries wolf is one people stop running.
interface CallSite {
  name: string;
  args: string[];        // already lowered to SMT in the caller's environment
  // Flattened field symbols of any struct argument, in the callee's naming. See fieldBindings.
  fields: Map<string, string>;
  conditions: string[];
}

// walkNodes' totality rule, plus the path conditions in force at each node.
//
// Same reason it exists: the two collectors below each named the fields they happened to
// know about, so an obligation sitting in a field nobody listed was silently not an
// obligation at all. `Box { v: half(x) }` never checked `half`'s `requires` — the identical
// call written bare was refuted — because `fields` was not on the list.
//
// Where a subtree's conditions CANNOT be reconstructed this prunes EXPLICITLY and says why.
// That is the whole difference from the key lists it replaces: not collecting is still a
// coverage gap, but it is now a decision with a stated reason rather than a field someone
// forgot, and a node kind added to the AST is covered instead of quietly skipped.
//
// Direction of danger, since it governs every choice here: an obligation recorded with
// FEWER conditions than really hold is harder to discharge than reality, so it cries wolf
// on correct code — and a check that cries wolf gets switched off. Pruning costs coverage;
// guessing costs the check itself.
function walkGuarded(
  node: unknown,
  conds: string[],
  env: Map<string, string>,
  visit: (n: any, conds: string[]) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) walkGuarded(x, conds, env, visit);
    return;
  }
  const n = node as Record<string, any>;
  if (typeof n.kind === "string") {
    visit(n, conds);
    // A closure body runs where the closure is CALLED, under conditions and bindings that
    // are not in scope at the definition site. An obligation recorded here would be
    // attached to the wrong state entirely — worse than not recording it.
    if (n.kind === "Closure") return;
    // A match arm is guarded by a pattern test over an enum tag, which this translator has
    // no encoding for. The subject is evaluated unconditionally, so it still walks.
    if (n.kind === "MatchExpr" || n.kind === "MatchStmt") {
      walkGuarded(n.subject, conds, env, visit);
      return;
    }
    // An if-expression arm is exactly as conditional as an if-statement branch, and gets
    // the same path condition the statement walker builds for one. A guard that does not
    // translate is pruned rather than dropped: descending with the enclosing conditions
    // alone would assert the arm runs unconditionally.
    if (n.kind === "IfExpr") {
      walkGuarded(n.cond, conds, env, visit);
      const guard = exprToSmtWithEnv(n.cond, env);
      if (/UNSUPPORTED/.test(guard)) return;
      walkGuarded(n.thenBody, [...conds, guard], env, visit);
      walkGuarded(n.elseBody, [...conds, `(not ${guard})`], env, visit);
      return;
    }
  }
  for (const key of Object.keys(n)) {
    if (key === "span") continue;
    walkGuarded(n[key], conds, env, visit);
  }
}

// Every struct literal reachable from an expression. A literal is where a type's invariant
// stops being an assumption and becomes an obligation: everything downstream gets to assume
// it, so something has to establish it, and construction is that something.
function collectStructLitsInExpr(expr: Expr, conds: string[], env: Map<string, string>, out: StructLitSite[]): void {
  walkGuarded(expr, conds, env, (n, active) => {
    if (n.kind !== "StructLit" || typeof n.name !== "string" || !STRUCT_INVARIANTS.has(n.name)) return;
    const fields = new Map<string, string>();
    for (const f of n.fields ?? []) fields.set(f.name, exprToSmtWithEnv(f.value, env));
    out.push({ struct: n.name, fields, conditions: [...active] });
  });
}

// Every call reachable from an expression, paired with the conditions in force. Only
// direct calls to named fns matter — that is all a `requires` can hang off.
function collectCallsInExpr(expr: Expr, conds: string[], env: Map<string, string>, out: CallSite[]): void {
  walkGuarded(expr, conds, env, (n, active) => {
    if (n.kind !== "Call" || typeof n.func !== "string") return;
    const callee = FN_TABLE.get(n.func);
    out.push({
      name: n.func,
      args: (n.args ?? []).map((a: Expr) => exprToSmtWithEnv(a, env)),
      fields: callee ? fieldBindings(callee.params, n.args ?? [], env) : new Map(),
      conditions: [...active],
    });
  });
}

// A static/associated method call `Type.method(args)` parses as an EnumLit (the parser
// can't tell `Math.clampI64(..)` from an enum construction). The whole VC machinery keys
// off `Call` nodes with a string `func`, so rewrite every EnumLit that names a known impl
// method into `Call{func:"Type.method"}` in place — after this pass a namespaced stdlib
// call is indistinguishable from the free function it replaced, and call collection,
// call-site obligations, and postcondition modelling all work unchanged. `implKeys` is the
// set of `${typeName}.${method}`; enum-variant keys are excluded by the caller so a real
// construction that happens to share a name is never rewritten.
function rewriteStaticCalls(node: any, implKeys: Set<string>): void {
  walkNodes(node, n => {
    if (n.kind !== "EnumLit" || typeof n.enumName !== "string" || typeof n.variant !== "string") return;
    if (!implKeys.has(`${n.enumName}.${n.variant}`)) return;
    const func = `${n.enumName}.${n.variant}`;
    const args = n.args ?? [];
    for (const k of Object.keys(n)) delete n[k];
    n.kind = "Call";
    n.func = func;
    n.args = args;
  });
}

// Every function in the program, for looking up a callee's parameter modes. Set once per
// run alongside GLOBAL_CONST_*.
let FN_TABLE = new Map<string, Function>();

// Functions that provably mutate nothing: `@pure` (checker-enforced — no globals, no
// unsafe, no I/O, no impure callee) AND no `&mut`/pointer parameter to write through.
// A call to one cannot invalidate anything the walker knows, so it needs no havoc.
// `PURE_METHOD_NAMES` is keyed by the bare method name because a `MethodCall` node
// carries no receiver type here; a name is admitted only when EVERY impl method with
// that name qualifies, so an impure `Foo.reset` keeps `bar.reset()` conservative.
let PURE_FN_NAMES = new Set<string>();
let PURE_METHOD_NAMES = new Set<string>();

function mutatesNothing(f: Function): boolean {
  return !!f.attributes?.some(a => a.name === "pure")
    && !f.params.some(p => (p.type as any)?.isRefMut || (p.type as any)?.isPtr);
}

// Contracts for the builtin Vec/string methods, written in Milo exactly as each method
// would carry them if it were ordinary library code. `self` is the receiver. These are the
// ONLY facts the prover knows about a builtin container: a method absent from this table
// still havocs its receiver, and a verdict resting on that havoc is `unknown` (see
// `unconstrainedHavocs`). One table, consumed by the same frame machinery as a user `&mut`
// callee (collectMutatingCalls / emitFrameFacts), so a builtin's effect on `len` is stated
// in one place and there is no per-method arm in the walker to forget.
//
// Every clause here is ASSUMED, so each one is a soundness claim about the runtime and a
// wrong line is a false proof. `tests/prove/builtinContainerContracts.milo` executes each
// against the real runtime under `--debug`, which checks the same clauses dynamically.
//
// Deliberately absent: element contents (`v[i]` has no model), `pop`'s Option result (no
// Option model), and anything whose length effect depends on contents (`dedup`, `retain`'s
// exact count). `pop` on an empty Vec is a no-op returning null, hence the two-clause
// form rather than a `requires`: the clause must be total or the post-`pop` length is a
// free variable whenever the guard is false.
//
// Index assignment `v[i] = x` is syntax, not a method; the walker routes it here under the
// name `[]=` so its frame (`len` unchanged) lives in the same table. Out-of-range `insert`
// / `remove` / `[]=` trap, so on every path that reaches a postcondition the clause holds
// and no `requires` is needed as an antecedent.
//
// `@pure` marks a method that leaves its receiver untouched, so the receiver is not havoced
// at all. The list is every read-only Vec/string member: a name here on a string receiver
// (`s.reverse()` returns a new string) or a Vec one (`v.reverse()` is in place, length
// kept) must be right for BOTH, since the table is keyed by bare name. `ptr`/`addrOf` are
// deliberately absent: what happens through a raw pointer is not this model's to promise.
const BUILTIN_READ_ONLY = [
  "len", "isEmpty", "capacity", "get", "first", "last", "slice", "contains", "indexOf",
  "position", "join", "map", "filter", "fold", "reduce", "each", "enumerate", "find", "any",
  "all", "sum", "min", "max", "clone",
  "startsWith", "endsWith", "indexOfFrom", "lastIndexOf", "charAt", "substr", "toLower",
  "toUpper", "trim", "trimStart", "trimEnd", "repeat", "padStart", "padEnd", "replace",
  "replaceFirst", "split", "splitWords", "splitWhitespace", "lines", "splitView",
  "codePoints", "parseInt", "parseF64", "cstr",
];
const BUILTIN_CONTRACTS_SRC = `
${BUILTIN_READ_ONLY.map(n => `@pure fn ${n}(self: &Vec<i64>): i64 {}`).join("\n")}
fn push(self: &mut Vec<i64>, x: i64): void
ensures self.len == old(self.len) + 1
{}
fn pop(self: &mut Vec<i64>): void
ensures old(self.len) == 0 || self.len == old(self.len) - 1
ensures old(self.len) > 0 || self.len == 0
{}
fn clear(self: &mut Vec<i64>): void
ensures self.len == 0
{}
fn insert(self: &mut Vec<i64>, i: i64, x: i64): void
ensures self.len == old(self.len) + 1
{}
fn remove(self: &mut Vec<i64>, i: i64): void
ensures self.len == old(self.len) - 1
{}
fn truncate(self: &mut Vec<i64>, n: i64): void
ensures n < 0 || n >= old(self.len) || self.len == n
ensures n < old(self.len) || self.len == old(self.len)
{}
fn extend(self: &mut Vec<i64>, other: Vec<i64>): void
ensures self.len == old(self.len) + old(other.len)
{}
fn pushStr(self: &mut string, s: string): void
ensures self.len == old(self.len) + s.len
{}
fn retain(self: &mut Vec<i64>, keep: i64): void
ensures self.len <= old(self.len)
{}
fn reverse(self: &mut Vec<i64>): void
ensures self.len == old(self.len)
{}
fn swap(self: &mut Vec<i64>, i: i64, j: i64): void
ensures self.len == old(self.len)
{}
fn sort(self: &mut Vec<i64>): void
ensures self.len == old(self.len)
{}
fn sortBy(self: &mut Vec<i64>, cmp: i64): void
ensures self.len == old(self.len)
{}
fn sortByKey(self: &mut Vec<i64>, key: i64): void
ensures self.len == old(self.len)
{}
fn reserve(self: &mut Vec<i64>, n: i64): void
ensures self.len == old(self.len)
{}
fn indexSet(self: &mut Vec<i64>, i: i64, x: i64): void
ensures self.len == old(self.len)
{}
`;

// The table as docs/roadmap.md quotes it; tests/builtinContractsDoc.test.ts holds the doc to
// this text so the two cannot drift.
export function builtinContractsDoc(): string {
  const mutating = BUILTIN_CONTRACTS_SRC.split("\n").filter(l => !l.startsWith("@pure")).join("\n").trim();
  return [
    "```milo",
    BUILTIN_CONSTRUCTORS_SRC.trim(),
    mutating.replace(/^fn indexSet\(/m, "fn [i]=("),
    "```",
    "",
    `Read-only, so the receiver is not havoced at all: \`${BUILTIN_READ_ONLY.join("`, `")}\`.`,
  ].join("\n");
}

// Constructors, modelled as calls with an `ensures` on `result` (modelCall picks them up
// through ensuresByFn under their `Type.method` key, like any impl method).
const BUILTIN_CONSTRUCTORS_SRC = `
fn Vec.new(): Vec<i64>
ensures result.len == 0
{}
fn Vec.withCapacity(n: i64): Vec<i64>
ensures result.len == 0
{}
`;

// The method spelled `[]=` in the walker is `indexSet` in the source above, because a
// function cannot be named `[]=` in Milo.
const INDEX_SET = "[]=";

let BUILTIN_CONTRACTS: Map<string, Function> | null = null;
let BUILTIN_CONSTRUCTORS: Map<string, Function> | null = null;

function parseBuiltinContracts(src: string, rename: (n: string) => string): Map<string, Function> {
  const program = new Parser(new Lexer(src).tokenize(), src, "<builtin-contracts>").parse();
  const out = new Map<string, Function>();
  for (const fn of program.functions) out.set(rename(fn.name), { ...fn, name: rename(fn.name) });
  return out;
}

function builtinContracts(): Map<string, Function> {
  if (!BUILTIN_CONTRACTS) BUILTIN_CONTRACTS = parseBuiltinContracts(BUILTIN_CONTRACTS_SRC, n => n === "indexSet" ? INDEX_SET : n);
  return BUILTIN_CONTRACTS;
}

// `fn Vec.new()` is not parseable Milo, so the constructors are parsed under plain names and
// re-keyed to the `Type.method` spelling rewriteStaticCalls produces.
function builtinConstructors(): Map<string, Function> {
  if (!BUILTIN_CONSTRUCTORS) {
    BUILTIN_CONSTRUCTORS = parseBuiltinContracts(BUILTIN_CONSTRUCTORS_SRC.replace(/fn Vec\./g, "fn Vec__"), n => n.replace(/^Vec__/, "Vec."));
  }
  return BUILTIN_CONSTRUCTORS;
}

// The contract in force for a method call, or null when the walker has to treat the call as
// an unknown mutation. Gated on the RECEIVER: a `MethodCall` carries no type here, and a
// user struct is free to have its own `push`, so the table applies only when the receiver
// is a name this function knows to be a Vec/string/array (LEN_BEARING).
function builtinContractFor(method: string, receiver: Expr): Function | null {
  const path = flattenFieldAccess(receiver);
  if (path === null || !LEN_BEARING.has(path)) return null;
  return builtinContracts().get(method) ?? null;
}

// Every place expression in the function under analysis whose value carries a `len`:
// params and locals declared (or initialised) as Vec/string/array, the Vec/string fields
// hanging off a struct-typed one, and the results of calls returning one. Flattened paths
// (`h_count`), the same spelling FIELD_REFS uses. What it gates: `x.len >= 0` (a user struct
// may have a plain `len: i64` field that legitimately goes negative, so the fact is asserted
// only for bases that actually carry a length) and the builtin contract table above.
// Scoped per function, like FIELD_REFS; modelCall adds a callee's result symbol to it.
let LEN_BEARING = new Set<string>();
let STRUCT_FIELD_TYPES = new Map<string, Map<string, MiloType>>();

function isLenBearingType(t: MiloType | null | undefined): boolean {
  return !!t && (t.name === "string" || t.name === "Vec" || t.isArray);
}

function collectLenBearing(fn: Function): Set<string> {
  const out = new Set<string>();
  const consider = (path: string, t: MiloType | null | undefined, depth = 0) => {
    if (!t) return;
    if (isLenBearingType(t)) { out.add(path); return; }
    // A struct's Vec fields are len-bearing places too; bounded because a recursive type
    // would otherwise never terminate here.
    if (depth >= 4) return;
    for (const [f, ft] of STRUCT_FIELD_TYPES.get(t.name) ?? []) consider(`${path}_${f}`, ft, depth + 1);
  };
  // An unannotated local reveals its type through its initialiser. Only the shapes whose
  // type is certain: a builtin constructor, a literal, or a struct literal.
  const fromInit = (value: Expr | undefined): MiloType | null => {
    if (!value) return null;
    const e = value as any;
    if (e.kind === "StringLit") return { name: "string", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    if (e.kind === "ArrayLit" || e.kind === "ArrayRepeat") return { name: "array", isPtr: false, isRef: false, isRefMut: false, isArray: true, arraySize: null };
    const isVecCtor = (e.kind === "Call" && typeof e.func === "string" && builtinConstructors().has(e.func))
      || (e.kind === "EnumLit" && e.enumName === "Vec");
    if (isVecCtor) return { name: "Vec", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    if (e.kind === "StructLit" && typeof e.name === "string") return { name: e.name, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    return null;
  };
  for (const p of fn.params) consider(p.name, p.type);
  consider("result", fn.retType);
  walkNodes(fn.body, n => {
    if (n.kind === "LetDecl" || n.kind === "VarDecl") consider(n.name, n.type ?? fromInit(n.value));
  });
  return out;
}

// Is `sym` the length of a len-bearing place? Both havoc spellings count: `v_len__mut1`
// (the len ref was known when `v` was havoced) and `v__mut0_len` (it was invented afterwards
// by rebasing through the havoced base). Stripping the havoc tags recovers the place.
function lenSymbolBase(sym: string): string | null {
  const place = sym.replace(/__(mut|loop|iter)\d+/g, "");
  return place.endsWith("_len") ? place.slice(0, -"_len".length) : null;
}

function isLenSymbol(sym: string): boolean {
  const base = lenSymbolBase(sym);
  return base !== null && LEN_BEARING.has(base);
}

// Fresh symbols minted by a havoc that nothing has since described, each mapped to the place
// it stands for and what forgot it (`v_len`, `'frob(…)' (no contract)`). A frame clause,
// guard or invariant removes a symbol the moment it mentions it; whatever is left when the
// VCs are assembled becomes `unconstrainedHavocs`. A field symbol rebased THROUGH a havoced
// base (`v__mut0_len`, invented when `v.len` is read after `v` became `v__mut0`) is as free
// as the base and is entered here on invention, keyed back to the base by DERIVED_FROM so a
// frame clause about the base's call can claim it. Scoped per function.
let UNCONSTRAINED_HAVOCS = new Map<string, { place: string; why: string }>();
let DERIVED_FROM = new Map<string, string>();
// Typing facts (`>= 0`, integer ranges) emitted alongside a havoc declaration. They name the
// symbol without constraining it in any way the program stated, so the dependency scan for
// `unconstrainedHavocs` has to skip them or every VC would be tainted by its own declarations.
let HAVOC_TYPING_FACTS = new Set<string>();

// The FIELD_REFS hanging off a place, excluding symbols another havoc of the same place
// minted (`v__mut0_len` starts with `v_` but is not a field of `v`).
function fieldRefsUnder(place: string): string[] {
  return [...(FIELD_REFS ?? [])].filter(f => f.startsWith(`${place}_`) && !/^__(mut|loop|iter)\d+/.test(f.slice(place.length)));
}

// `invariant` clauses per struct name, and the field list to instantiate them over. Set
// once per run: an invariant is a property of the TYPE, so it is in force at every use.
let STRUCT_INVARIANTS = new Map<string, Contract[]>();
let STRUCT_FIELDS = new Map<string, string[]>();

// The environment as it stood at function entry, which is what `old(e)` reads. Scoped to
// one function's VC build, like FIELD_REFS.
let OLD_ENV: Map<string, string> | null = null;

// Does an expression name any of these identifiers? Used to decide whether a loop
// invariant survives past the loop, where the bindings it named no longer exist.
function mentionsAnyIdent(expr: Expr, names: Set<string>): boolean {
  if (!expr || typeof expr !== "object" || names.size === 0) return false;
  const e = expr as any;
  if (e.kind === "Ident") return names.has(e.name);
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) { if (v.some(x => x && (x as any).kind && mentionsAnyIdent(x as Expr, names))) return true; }
    else if (v && typeof v === "object" && (v as any).kind && mentionsAnyIdent(v as Expr, names)) return true;
  }
  return false;
}

function isOldCall(expr: any): boolean {
  return expr && expr.kind === "Call" && expr.func === "old" && Array.isArray(expr.args) && expr.args.length === 1;
}

// A struct invariant is written over bare field names (`chr.len > 0`). Binding each field
// name to the symbol standing for that field of a particular value is the whole
// instantiation: `chr` -> `ppu_chr` makes `chr.len` rebase to `ppu_chr_len`.
function instantiateInvariant(inv: Contract, fieldEnv: Map<string, string>): string {
  return exprToSmtWithEnv(inv.expr, fieldEnv, true);
}

// Does a callee's `ensures` talk about the FINAL value of a parameter it can write through?
// Such a clause cannot be modelled by substituting the caller's arguments: the arguments are
// the pre-call values, so `ensures n == 100` on `fn set(n: &mut i64)` would come back as the
// assumption `<arg> == 100` about the value BEFORE the call. For `set(x)` with `x == 5` that
// assumption is false, and a false assumption proves every postcondition in the function.
// `old(n)` is exempt — that is exactly the pre-call value the substitution provides.
function mentionsMutParamPostState(expr: Expr, mutParams: Set<string>): boolean {
  if (!expr || typeof expr !== "object") return false;
  const e = expr as any;
  if (isOldCall(e)) return false;
  if (e.kind === "Ident") return mutParams.has(e.name);
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) { if (v.some(x => x && (x as any).kind && mentionsMutParamPostState(x as Expr, mutParams))) return true; }
    else if (v && typeof v === "object" && (v as any).kind && mentionsMutParamPostState(v as Expr, mutParams)) return true;
  }
  return false;
}

// Field names whose declared type is `bool` in EVERY struct that has them. Field symbols
// are flattened to `recv_field` with no record of which struct the receiver was, so the
// sort has to come from the name — and only when it is unambiguous across the program.
//
// Getting it wrong emits an invalid query rather than a wrong answer: `ppu.mirrorVertical`
// declared as `Int` produced `(and ppu_mirrorVertical ...)` and z3 rejected the VC with
// "Sort mismatch at argument #1 for function (declare-fun and (Bool Bool) Bool)". Same
// class as an unannotated `var matched = true`, one level out.
let BOOL_FIELDS = new Set<string>();

// Same idea one sort over, and it is a soundness guard rather than a validity one: a float
// field left as `Int` is not rejected by z3 — it silently coerces — and std/smt would then
// apply its integer tightenings to a value that can sit between two integers. That is the
// false proof the SmtProblem comment describes, reached through a struct field instead of a
// parameter. It only became reachable when float literals started translating.
let FLOAT_FIELDS = new Set<string>();

function collectFieldsOfSort(program: Program, isSort: (t: any) => boolean): Set<string> {
  const matching = new Set<string>();
  const other = new Set<string>();
  for (const f of (program.structs ?? []).flatMap(st => st.fields as any[])) {
    (isSort(f.type) && !f.type?.isPtr && !f.type?.isArray ? matching : other).add(f.name);
  }
  for (const n of other) matching.delete(n);   // ambiguous across structs: leave it an Int
  return matching;
}

function collectBoolFields(program: Program): Set<string> {
  return collectFieldsOfSort(program, t => t?.name === "bool");
}

function collectFloatFields(program: Program): Set<string> {
  return collectFieldsOfSort(program, t => t?.name === "f32" || t?.name === "f64");
}

// Names in the function under analysis that a callee could actually write through: `var`
// locals and `&mut`/`*mut` parameters. Nothing else is a legal mutation target — `let` is
// an immutable binding and `&T` is an immutable borrow, both enforced by the checker — so
// havocing them would only throw away facts. Scoped per function, like FIELD_REFS.
let MUTABLE_NAMES = new Set<string>();

function collectMutableNames(fn: Function): Set<string> {
  const out = new Set<string>();
  for (const p of fn.params) if (p.type?.isRefMut || p.type?.isPtr) out.add(p.name);
  // Every `var`, wherever it is written. This gates havoc — a name missing here is a name
  // `collectMutations` declines to forget — so the statement-shaped scan this replaced was
  // the same false-proof shape as the assigned-vars walker: it never entered an expression,
  // and a `var` declared inside a closure body or an if-expr arm was simply not mutable.
  walkNodes(fn.body, n => { if (n.kind === "VarDecl") out.add(n.name); });
  return out;
}

// A call that writes through a `&mut` AND says something about the result in its `ensures`.
// Havocing the argument is what keeps the walker sound; this is what keeps it useful — the
// frame condition relating the post-call symbols back to the pre-call ones.
interface MutatingCall {
  callee: Function;
  args: Expr[];
  // callee parameter name -> caller-side base name it was passed. The frame substitution
  // needs both: the parameter is the name the contract is written in, the base is where the
  // post-call symbols live.
  mutTargets: Map<string, string>;
}

// The expressions a statement evaluates ITSELF. Nested statement bodies are excluded on
// purpose — walkCapture reaches those on its own, under their own path conditions — and
// they exclude themselves for free, since a body is an array and an array carries no
// `kind`. Types exclude themselves the same way (MiloType is keyed by `name`).
//
// Derived by exclusion rather than by naming the fields, which is the whole point: the
// three lists this replaced said `value, expr, cond, subject[, target]`, so a ForInStmt's
// `iterable` was on none of them and `for x in makeRange(n)` never had its callee's
// `requires` checked. A statement kind that gains an expression field is now covered
// instead of quietly skipped.
function ownExprs(stmt: any): Expr[] {
  const out: Expr[] = [];
  for (const key of Object.keys(stmt)) {
    if (key === "span") continue;
    const v = stmt[key];
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.kind === "string") out.push(v as Expr);
  }
  return out;
}

function collectMutatingCalls(node: any, out: MutatingCall[]): void {
  const record = (callee: Function, args: Expr[]) => {
    if (!callee.contracts.some(c => c.kind === "ensures") || callee.params.length !== args.length) return;
    const mutTargets = new Map<string, string>();
    callee.params.forEach((p, i) => {
      if (!p.type?.isRefMut && !p.type?.isPtr) return;
      const base = mutationBase(args[i]);
      if (base !== null && MUTABLE_NAMES.has(base)) mutTargets.set(p.name, base);
    });
    if (mutTargets.size > 0) out.push({ callee, args, mutTargets });
  };
  walkNodes(node, n => {
    if (n.kind === "Call" && typeof n.func === "string" && Array.isArray(n.args)) {
      const callee = FN_TABLE.get(n.func);
      if (callee) record(callee, n.args);
    }
    // A builtin container method is a mutating call whose contract comes from the table
    // instead of the program; the receiver is its `self` argument.
    if (n.kind === "MethodCall" && Array.isArray(n.args)) {
      const callee = builtinContractFor(n.method, n.object);
      if (callee) record(callee, [n.object, ...n.args]);
    }
  });
}

// `v[i] = x` as the table sees it: a call to `[]=` on the indexed place. Null when the
// receiver is not a place the table covers, in which case the assignment is an unknown
// mutation of that place (havoc, no contract) rather than nothing at all.
function indexAssignAsCall(target: Expr, value: Expr): { callee: Function; args: Expr[] } | null {
  if (target.kind !== "IndexAccess") return null;
  const callee = builtinContractFor(INDEX_SET, target.object);
  return callee ? { callee, args: [target.object, target.index, value] } : null;
}

// A struct argument is not one symbol on the caller side — each field it carries has its
// own. Binding the callee's flattened field prefixes to the caller's lets a contract written
// as `h.count.len` rebase onto `lencode_count_len` instead of leaking the callee's name.
// Without it, a `&Huff` parameter reached the solver as one opaque (often untranslatable)
// value and every precondition about one of its fields went unknown.
function fieldBindings(params: { name: string; type?: any }[], args: Expr[], env: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < params.length && i < args.length; i++) {
    // The argument's own flattened place: passing `a.data` binds the parameter's fields to
    // `a_data_*`, not to `a_*` (which would pair `self.len` with `a_data`'s sibling).
    const place = flattenFieldAccess(args[i]!);
    if (place === null) continue;
    for (const f of fieldRefsUnder(place)) {
      const bound = env.get(f);
      if (bound && isPlainSymbol(bound)) out.set(`${params[i]!.name}${f.slice(place.length)}`, bound);
    }
  }
  return out;
}

function mutationBase(e: any): string | null {
  if (!e || typeof e !== "object") return null;
  if (e.kind === "Ident") return e.name;
  if (e.kind === "FieldAccess") return mutationBase(e.object);
  if (e.kind === "UnaryOp" && (e.op === "&" || e.op === "&mut")) return mutationBase(e.operand);
  return null;
}

// Names a statement can mutate WITHOUT an assignment appearing anywhere in it: passing a
// variable to a `&mut`/`*mut` parameter, or calling a method that takes `&mut self`.
//
// This was a FALSE PROOF, not a missed one. `fn bump(n: &mut i64)` called as `bump(x)`
// left the walker's binding for `x` at its pre-call value, so `var x = 0; bump(x); return x`
// PROVED `ensures result == 0` for a function that returns 100. Anything the walker cannot
// see through has to become an unknown, never a stale known.
//
// A method call havocs its receiver unconditionally: resolving which `impl` a method comes
// from (and whether it takes `&mut self`) needs the checker's tables, which are not
// available here. Over-havocking costs precision; under-havocking costs correctness.
function collectMutations(node: any, out: Map<string, string>): void {
  const target = (e: any): string | null => {
    // `v.len` on a Vec/string is a scalar copy, not a place: `print(v.len)` cannot write
    // through it, and havocing `v` for it made every later fact about `v` unknown.
    if (e?.kind === "FieldAccess" && e.field === "len") {
      const place = flattenFieldAccess(e.object);
      if (place !== null && LEN_BEARING.has(place)) return null;
    }
    const n = base(e);
    return n !== null && MUTABLE_NAMES.has(n) ? n : null;
  };
  const base = (e: any): string | null => {
    if (!e || typeof e !== "object") return null;
    if (e.kind === "Ident") return e.name;
    if (e.kind === "FieldAccess") return base(e.object);
    if (e.kind === "UnaryOp" && (e.op === "&" || e.op === "&mut")) return base(e.operand);
    return null;
  };
  // The flattened path (`a_data`) when the receiver is a field of a mutable name; null when
  // it is not a plain place expression, so the caller can fall back to the whole receiver.
  const fieldPath = (e: any): string | null => {
    const root = base(e);
    if (root === null || !MUTABLE_NAMES.has(root)) return null;
    const flat = flattenFieldAccess(e as Expr);
    return flat;
  };
  walkNodes(node, n => {
    if (n.kind === "Call" && typeof n.func === "string" && Array.isArray(n.args)) {
      const callee = FN_TABLE.get(n.func);
      if (PURE_FN_NAMES.has(n.func)) {
        // Nothing to havoc — but keep walking the arguments, which may themselves contain
        // calls that do mutate.
      } else if (callee) {
        callee.params.forEach((p, i) => {
          if (!p.type?.isRefMut && !p.type?.isPtr) return;
          const name = target(n.args[i]);
          if (name) out.set(name, exprSource(n));
        });
      } else {
        // Unknown callee (function pointer, closure, unresolved): assume the worst.
        for (const a of n.args) { const name = target(a); if (name) out.set(name, exprSource(n)); }
      }
    }
    if (n.kind === "MethodCall" && !PURE_METHOD_NAMES.has(n.method) && !builtinContractFor(n.method, n.object)?.attributes?.some(a => a.name === "pure")) {
      // Havoc the FIELD PATH the method was called on, not the whole receiver: `a.data.push(v)`
      // cannot touch `a.live`, and wiping every field of `a` made a type invariant about a
      // sibling field unprovable for every function that pushes to a vec — which is most of
      // them. The root itself still goes, since the aggregate value did change.
      const path = fieldPath(n.object);
      if (path !== null) out.set(path, exprSource(n));
      else { const name = target(n.object); if (name) out.set(name, exprSource(n)); }
    }
  });
}

// What an index assignment mutates: the indexed place, under the same field-path rule as a
// method receiver. Elements have no model, so before this the walker treated `v[i] = x` as
// touching nothing; the table now states the frame (`len` unchanged) for a Vec, and a
// receiver the table does not cover is an unknown mutation like any other.
function collectIndexAssignMutation(target: Expr, out: Map<string, string>): void {
  if (target.kind !== "IndexAccess") return;
  const path = flattenFieldAccess(target.object);
  const root = mutationBase(target.object);
  if (root === null || !MUTABLE_NAMES.has(root)) return;
  out.set(path ?? root, `${exprSource(target)} = ...`);
}

// The declared type of an unannotated local, as far as its initializer reveals it. Only
// the SMT SORT matters here, so `bool` vs `i64` is the distinction that counts.
//
// Getting this wrong emits an invalid query, not a wrong answer: `var matched = true`
// havoced to an `Int` produced `(not matched__loop3)`, and z3 rejected the whole VC with
// "Sort mismatch at argument #1 for function (declare-fun not (Bool) Bool)". Found by
// running the gate over milojs, whose `jsIndexOf` is written that way.
function inferLiteralType(value: Expr | undefined): string | null {
  if (!value) return null;
  if (value.kind === "BoolLit") return "bool";
  if (value.kind === "FloatLit") return "f64";
  if (value.kind === "BinOp" && BOOL_OPS.has(value.op)) return "bool";
  if (value.kind === "UnaryOp" && value.op === "!") return "bool";
  return null;
}

const BOOL_OPS = new Set(["==", "!=", "<", ">", "<=", ">=", "&&", "||"]);

function collectPaths(stmts: Stmt[], env: Map<string, string>, types?: Map<string, string>, context?: SymExecContext): SymExecResult {
  const paths: SymPath[] = [];
  const calls: CallSite[] = [];
  const structLits: StructLitSite[] = [];
  const asserts: AssertSite[] = [];
  const ctx = context ?? { havocSeq: 0, havocDecls: [] };
  const loops: LoopObligation[] = [];
  const varTypes = new Map(types ?? []);

  // One fresh constant standing for `target` after something the walker cannot see through
  // (a loop, a call). This is the ONLY place a havoc symbol is minted, so the facts every
  // one must carry are stated here and nothing can forget them: the integer range of its
  // type, and `>= 0` for the length of a len-bearing place (the len after `v.push(x)` is as
  // much a length as the one before it, and without this a `len == -1` "counterexample"
  // was reported for a state no Vec can be in).
  function mintHavoc(target: string, tag: "mut" | "loop", why: string): string {
    const fresh = `${target.replace(/[^A-Za-z0-9_]/g, "_")}__${tag}${ctx.havocSeq++}`;
    // No annotation and no float literal to learn from means Int, matching how the rest
    // of this file treats an unknown type. A float local would be modelled as an integer
    // here, which is why floatish() also looks at the initializer.
    const typeName = varTypes.get(target) ?? "i64";
    ctx.havocDecls.push(declareConst(fresh, typeName));
    const facts = [intRangeAssumption(fresh, typeName), isLenSymbol(fresh) ? `(assert (>= ${fresh} 0))` : null];
    for (const fact of facts) {
      if (!fact) continue;
      ctx.havocDecls.push(fact);
      HAVOC_TYPING_FACTS.add(fact);
    }
    CALL_MODEL?.scope.add(fresh);
    // Every havoc starts out described by nothing. A call's frame clause, a loop's guard or
    // an invariant then claims the symbols it mentions (constrainedBy); what is never
    // claimed is a free variable the verdict must not rest on.
    UNCONSTRAINED_HAVOCS.set(fresh, { place: target, why });
    return fresh;
  }

  // The program has now stated something about every havoc symbol these terms mention.
  function constrainedBy(terms: string[]): void {
    for (const t of terms) for (const m of t.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) UNCONSTRAINED_HAVOCS.delete(m[0]);
  }

  // Replace one place, and every flattened field hanging off it (since `&mut c` may write
  // any of `c.x`, `c.y`), with fresh unknowns.
  //
  // `name` may be a field path (`a_data`), in which case only that field and what hangs
  // off it moves. The ROOT symbol is deliberately left alone: a field read resolves by
  // longest bound prefix, so havocing `a` would shadow every sibling: `a.live` would
  // rebase onto `a__mut2_live` and a type invariant about it becomes unprovable for any
  // function that merely pushes to a vec field. Leaving `a` stale costs nothing, since a
  // struct-as-scalar symbol carries no information this encoding can use.
  function havocPlace(name: string, localEnv: Map<string, string>, tag: "mut" | "loop", why: string): string[] {
    const minted: string[] = [];
    for (const target of [name, ...fieldRefsUnder(name)]) {
      const fresh = mintHavoc(target, tag, why);
      localEnv.set(target, fresh);
      minted.push(fresh);
    }
    return minted;
  }

  // Replace every place the block can write with a fresh constant. This is the only sound
  // way past a loop without unrolling it: whatever the loop did, the value afterwards is
  // *some* value, constrained only by an invariant if one was written. "Can write" means
  // assigned OR passed to a `&mut` parameter OR used as a method receiver; the walker
  // proved `ensures v.len == old(v.len)` for a loop that pushed `n` times when only
  // assignments counted.
  function havoc(block: Stmt[], localEnv: Map<string, string>, loop: Stmt): Map<string, string> {
    const assigned = new Set<string>();
    collectAssignedVars(block, assigned);
    const mods = new Map<string, string>();
    collectMutations(block, mods);
    walkNodes(block, n => { if (n.kind === "Assign") collectIndexAssignMutation(n.target, mods); });
    const out = new Map(localEnv);
    const line = (loop as any).span?.line;
    const why = `the loop${line ? ` at line ${line}` : ""} (no invariant names it)`;
    for (const name of new Set([...assigned, ...mods.keys()])) havocPlace(name, out, "loop", why);
    return out;
  }

  // Relate a mutating call's post-call symbols back to its pre-call ones, using the callee's
  // own `ensures`. Havocing the argument is what makes the walker sound; without this the
  // caller learns NOTHING from a `&mut` callee's contract, which is why
  // `construct(lencode, ...)` used to erase `lencode.count.len == 16` and every downstream
  // precondition about it was refuted for a table that is provably 16 entries long.
  //
  // The clause is lowered twice over: once against the post-call symbols (the contract's own
  // reading) and once against the pre-call ones (what `old(...)` inside it means). Asserted
  // as an implication from the callee's `requires`, never bare — the bare form would let an
  // obligation discharge itself, exactly as in modelCall.
  //
  // `minted` is the set of symbols this statement's havoc created: a clause that mentions
  // one describes it, so it leaves UNCONSTRAINED_HAVOCS. Only THOSE: the clause also names
  // the pre-call symbols, and an earlier havoc's symbol is not described by being read.
  function emitFrameFacts(mutCalls: MutatingCall[], preEnv: Map<string, string>, postEnv: Map<string, string>, minted: Set<string>): void {
    const ctx = CALL_MODEL;
    if (!ctx) return;
    for (const mc of mutCalls) {
      const subst = (env: Map<string, string>): Map<string, string> => {
        const out = new Map<string, string>();
        for (let i = 0; i < mc.callee.params.length; i++) {
          const argSmt = exprToSmtWithEnv(mc.args[i]!, env);
          // A struct argument often has no whole-value translation — `Huff { .. }` lowers to
          // an UNSUPPORTED marker — while every FIELD of it does. Leaving the parameter
          // unbound keeps a clause that names it bare untranslatable (so it is dropped) but
          // still lets `h.count.len` rebase through the field bindings below, which is the
          // only part of the frame condition that carries information.
          if (!/UNSUPPORTED/.test(argSmt)) out.set(mc.callee.params[i]!.name, argSmt);
        }
        // A `&mut` struct parameter is written field-wise, and each field has its own symbol
        // on the caller side. Binding the flattened prefixes is what lets `h.count.len`
        // rebase onto the caller's `lencode_count` rather than inventing a callee-side name.
        for (const [k, v] of fieldBindings(mc.callee.params, mc.args, env)) out.set(k, v);
        return out;
      };
      const post = subst(postEnv), pre = subst(preEnv);
      // `result` has no binding here — a statement-position call discards it, and a call in
      // value position is modelled separately by modelCall. Clauses naming it are that
      // model's business, not this one's.
      const clauses = mc.callee.contracts
        .filter(c => c.kind === "ensures" && !mentionsAnyIdent(c.expr, new Set(["result"])))
        .map(c => exprToSmtWithEnv(c.expr, post, true, pre))
        .filter(smt => !/UNSUPPORTED/.test(smt) && symbolsResolve(smt, ctx));
      if (clauses.length === 0) continue;
      const guards = mc.callee.contracts
        .filter(c => c.kind === "requires")
        .map(c => exprToSmtWithEnv(c.expr, pre, true));
      if (guards.some(g => /UNSUPPORTED/.test(g)) || !guards.every(g => symbolsResolve(g, ctx))) continue;
      const conclusion = clauses.length === 1 ? clauses[0]! : `(and ${clauses.join(" ")})`;
      const antecedent = guards.length === 0 ? null
        : guards.length === 1 ? guards[0]! : `(and ${guards.join(" ")})`;
      ctx.assumes.push(`(assert ${antecedent ? `(=> ${antecedent} ${conclusion})` : conclusion})`);
      // A builtin's contract is the runtime's, not something this run has to establish, so
      // it is not reported as an assumption the way a user callee's is.
      if (!builtinContracts().has(mc.callee.name)) ctx.assumed.add(mc.callee.name);
      for (const m of conclusion.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
        if (minted.has(m[0]) || minted.has(DERIVED_FROM.get(m[0]) ?? "")) UNCONSTRAINED_HAVOCS.delete(m[0]);
      }
    }
  }

  // for void functions, we need to capture final env state
  const finalEnvs: { conditions: string[]; env: Map<string, string> }[] = [];
  const breakEnvs: { conditions: string[]; env: Map<string, string> }[] = [];
  const continueEnvs: { conditions: string[]; env: Map<string, string> }[] = [];

  function walkCapture(stmts: Stmt[], idx: number, pathConds: string[], localEnv: Map<string, string>): void {
    for (let i = idx; i < stmts.length; i++) {
      const stmt = stmts[i];
      // Record calls before the statement updates the env, so an argument is lowered in
      // the state that actually holds at the call. Loops/match are not modelled by this
      // walker at all, so calls inside them are never recorded — missed coverage rather
      // than a VC built on conditions we cannot see.
      const st = stmt as any;
      const own = ownExprs(st);
      for (const e of own) {
        collectCallsInExpr(e, pathConds, localEnv, calls);
        collectStructLitsInExpr(e, pathConds, localEnv, structLits);
      }

      // What this statement's own expressions mutate out from under the walker. Nested
      // bodies are excluded — walkCapture reaches those statements itself.
      const mutated = new Map<string, string>();
      for (const e of own) collectMutations(e, mutated);
      const mutCalls: MutatingCall[] = [];
      for (const e of own) collectMutatingCalls(e, mutCalls);
      if (stmt.kind === "Assign") {
        collectIndexAssignMutation(stmt.target, mutated);
        const asCall = indexAssignAsCall(stmt.target, stmt.value);
        if (asCall) mutCalls.push({ ...asCall, mutTargets: new Map([["self", mutationBase((stmt.target as any).object) ?? ""]]) });
      }
      // Applied AFTER the statement's own env update, so the call's arguments are still
      // lowered in the pre-call state while everything downstream sees the unknown.
      const applyMutations = () => {
        const preEnv = mutCalls.length > 0 ? new Map(localEnv) : null;
        const minted = new Set<string>();
        for (const [name, why] of mutated) for (const sym of havocPlace(name, localEnv, "mut", `'${why}' (no contract)`)) minted.add(sym);
        if (preEnv) emitFrameFacts(mutCalls, preEnv, localEnv, minted);
      };

      if (stmt.kind === "LetDecl" || stmt.kind === "VarDecl") {
        if (stmt.type?.name) varTypes.set(stmt.name, stmt.type.name);
        else {
          const inferred = inferLiteralType(stmt.value);
          if (inferred) varTypes.set(stmt.name, inferred);
        }
        // A struct literal binds each field, not just the whole value: `Huff { count:
        // zeros(16) }` is what connects `zeros`' `ensures result.len == n` to a later
        // `h.count.len >= 16`. Without it the whole literal lowers to one UNSUPPORTED
        // marker and every field of it is a free unknown.
        if (stmt.value?.kind === "StructLit") {
          for (const f of stmt.value.fields) {
            const sym = `${stmt.name}_${f.name}`;
            FIELD_REFS?.add(sym);
            localEnv.set(sym, exprToSmtWithEnv(f.value, localEnv));
          }
        }
        if (stmt.value) localEnv.set(stmt.name, exprToSmtWithEnv(stmt.value, localEnv));
        applyMutations();
        continue;
      }
      if (stmt.kind === "Assign") {
        if (stmt.target.kind === "Ident") {
          localEnv.set(stmt.target.name, exprToSmtWithEnv(stmt.value, localEnv));
        } else if (stmt.target.kind === "FieldAccess") {
          const flat = flattenFieldAccess(stmt.target);
          if (flat) localEnv.set(flat, exprToSmtWithEnv(stmt.value, localEnv));
        }
        applyMutations();
        continue;
      }
      // `assert(E)` is the proof cut. Lowered in the PRE-mutation environment for the same
      // reason a call's arguments are (the statement's own effects have not happened yet),
      // then pushed onto the path conditions so every statement after it sees E as a fact.
      // Pushing onto `pathConds` in place is what makes the assumption reach the rest of
      // this block AND every nested body, which copy the array as they descend.
      const cut = assertCondition(stmt);
      if (cut) {
        const smt = exprToSmtWithEnv(cut, localEnv);
        // An unlowerable condition is not a fact — it is a marker. Proving it is impossible
        // and assuming it would put `UNSUPPORTED` into the solver's input, so the cut is
        // dropped entirely rather than half-applied.
        if (!/UNSUPPORTED/.test(smt)) {
          asserts.push({ cond: smt, conditions: [...pathConds], source: exprSource(cut), line: (stmt as any).span?.line ?? 0 });
          pathConds.push(smt);
        }
      }
      applyMutations();
      if (stmt.kind === "Return") {
        const val = stmt.value ? exprToSmtWithEnv(stmt.value, localEnv) : "0";
        paths.push({ conditions: [...pathConds], result: val, env: new Map(localEnv) });
        return;
      }
      if (stmt.kind === "BreakStmt") {
        breakEnvs.push({ conditions: [...pathConds], env: new Map(localEnv) });
        return;
      }
      if (stmt.kind === "ContinueStmt") {
        continueEnvs.push({ conditions: [...pathConds], env: new Map(localEnv) });
        return;
      }
      if (stmt.kind === "UnsafeBlock") {
        walkCapture([...stmt.body, ...stmts.slice(i + 1)], 0, pathConds, new Map(localEnv));
        return;
      }
      if (stmt.kind === "IfStmt") {
        const cond = exprToSmtWithEnv(stmt.cond, localEnv);
        const remainder = stmts.slice(i + 1);
        walkCapture([...stmt.thenBody, ...remainder], 0, [...pathConds, cond], new Map(localEnv));
        const negCond = `(not ${cond})`;
        walkCapture([...(stmt.elseBody ?? []), ...remainder], 0, [...pathConds, negCond], new Map(localEnv));
        return;
      }
      if (stmt.kind === "WhileStmt") {
        // Establishment is checked against the state that reaches the loop, so it has to be
        // recorded before the havoc wipes it.
        const havocEnv = havoc(stmt.body, localEnv, stmt);
        const guard = exprToSmtWithEnv(stmt.cond, havocEnv);
        const assumed = (stmt.invariants ?? [])
          .filter(inv => inv.kind === "invariant")
          .map(inv => exprToSmtWithEnv(inv.expr, havocEnv))
          .filter(s => !/UNSUPPORTED/.test(s));
        constrainedBy([guard, ...assumed]);
        const bodyRun = collectPaths(stmt.body, havocEnv, varTypes, ctx);
        structLits.push(...bodyRun.structLits);
        asserts.push(...bodyRun.asserts);
        const active = [...pathConds, ...assumed, ...(/UNSUPPORTED/.test(guard) ? [] : [guard])];
        loops.push({
          entryConds: [...pathConds],
          entryEnv: new Map(localEnv),
          havocEnv: new Map(havocEnv),
          guard,
          invariants: (stmt.invariants ?? []).filter(c => c.kind === "invariant"),
          variants: (stmt.invariants ?? []).filter(c => c.kind === "decreases"),
          body: stmt.body,
          bodyRun,
        });
        loops.push(...bodyRun.loops.map(nested => ({
          ...nested,
          entryConds: [...active, ...nested.entryConds],
        })));
        for (const path of bodyRun.paths) {
          paths.push({ ...path, conditions: [...active, ...path.conditions] });
        }
        for (const call of bodyRun.calls) {
          calls.push({ ...call, conditions: [...active, ...call.conditions] });
        }
        // Past the loop, all that is known is: the invariant still holds (it was proved to,
        // by the two VCs above) and the guard is false. Everything the loop touched is now
        // one of the fresh constants. Assuming the invariant here is what makes a loop
        // provable at all; without it the walker used to carry the *pre-loop* values
        // forward and certify postconditions that the function violates at runtime.
        const remainder = stmts.slice(i + 1);
        const normalExit = [...pathConds, ...assumed, ...(/UNSUPPORTED/.test(guard) ? [] : [`(not ${guard})`])];
        walkCapture(remainder, 0, normalExit, new Map(havocEnv));
        for (const exit of bodyRun.breakEnvs) {
          walkCapture(remainder, 0, [...active, ...exit.conditions], new Map(exit.env));
        }
        return;
      }
      if (stmt.kind === "ForInStmt") {
        // A for-loop may run any number of times, so like a while loop it is crossed by
        // induction, not unrolling. What is different is that nothing in the body advances
        // the binding — the loop form owns that — so the index has to be modelled here:
        // fresh at an arbitrary iteration, bounded by the range, and bumped by one for the
        // preservation obligation.
        const invariants = (stmt.invariants ?? []).filter(c => c.kind === "invariant");
        const variants = (stmt.invariants ?? []).filter(c => c.kind === "decreases");
        const havocEnv = havoc(stmt.body, localEnv, stmt);
        const entryEnv = new Map(localEnv);
        const nextPatch = new Map<string, string>();
        // The membership predicate for the current index. Used exactly as a while loop's
        // guard is: a path condition on body-derived paths and an assumption in the
        // preservation query. An empty range makes it unsatisfiable, which is the right
        // answer — the body never runs, so everything downstream of it is unreachable.
        let guard = "";
        const idxName = stmt.varName;
        const freshIdx = () => {
          const fresh = `${idxName.replace(/[^A-Za-z0-9_]/g, "_")}__iter${ctx.havocSeq++}`;
          ctx.havocDecls.push(`(declare-const ${fresh} Int)`);
          CALL_MODEL?.scope.add(fresh);
          return fresh;
        };
        // Bindings the body introduces that are not assignments: the loop variable, and the
        // element binding of an indexed `for i, x in v`. Havoced so the body reads an
        // arbitrary iteration rather than a stale outer value of the same name.
        for (const extra of [stmt.varName, stmt.varName2].filter(Boolean) as string[]) {
          havocEnv.set(extra, freshIdx());
          // Distinct from the iteration symbol: at loop entry the binding has no value yet.
          // Leaving it unbound would emit the bare source name as an undeclared symbol and
          // the solver would reject the whole establishment query.
          entryEnv.set(extra, freshIdx());
        }
        let postLoopEnv = new Map(havocEnv);
        if (stmt.iterable.kind === "RangeExpr") {
          const lo = exprToSmtWithEnv(stmt.iterable.start, localEnv);
          const hi = exprToSmtWithEnv(stmt.iterable.end, localEnv);
          const i0 = must(havocEnv, idxName, "havoc env");
          if (!/UNSUPPORTED/.test(lo) && !/UNSUPPORTED/.test(hi)) {
            guard = `(and (>= ${i0} ${lo}) (< ${i0} ${hi}))`;
            entryEnv.set(idxName, lo);
            nextPatch.set(idxName, `(+ ${i0} 1)`);
            // After the loop the index sits one past the last one executed — or never moved
            // at all, if the range was empty. Establishment gives the invariant at `lo` and
            // preservation carries it up to `hi`, so this `ite` is precisely the index the
            // induction actually reached, and assuming the invariant there is sound.
            postLoopEnv.set(idxName, `(ite (> ${hi} ${lo}) ${hi} ${lo})`);
          }
        } else if (stmt.varName2 && stmt.iterable.kind === "Ident") {
          // `for i, x in v` — the index is in range even though the element is opaque.
          const base = exprToSmtWithEnv(stmt.iterable, localEnv);
          if (isPlainSymbol(base)) {
            const lenSym = `${base}_len`;
            FIELD_REFS?.add(lenSym);
            const i0 = must(havocEnv, idxName, "havoc env");
            guard = `(and (>= ${i0} 0) (< ${i0} ${lenSym}))`;
            entryEnv.set(idxName, "0");
            nextPatch.set(idxName, `(+ ${i0} 1)`);
            postLoopEnv.set(idxName, `(ite (> ${lenSym} 0) ${lenSym} 0)`);
          }
        }
        // An invariant naming the loop variable of an UNCOUNTED loop says nothing after the
        // loop: the next element bears no relation to the last one. Carrying it forward
        // would assume a fact about a value the induction never established.
        const boundNames = [stmt.varName, ...(stmt.varName2 ? [stmt.varName2] : [])];
        const carried = invariants.filter(inv =>
          nextPatch.size > 0 ? !mentionsAnyIdent(inv.expr, new Set(stmt.varName2 ? [stmt.varName2] : []))
                             : !mentionsAnyIdent(inv.expr, new Set(boundNames)));
        const assumed = invariants
          .map(inv => exprToSmtWithEnv(inv.expr, havocEnv))
          .filter(s => !/UNSUPPORTED/.test(s));
        constrainedBy([guard, ...assumed]);
        const bodyRun = collectPaths(stmt.body, havocEnv, varTypes, ctx);
        structLits.push(...bodyRun.structLits);
        asserts.push(...bodyRun.asserts);
        const active = [...pathConds, ...assumed, ...(guard && !/UNSUPPORTED/.test(guard) ? [guard] : [])];
        loops.push({
          entryConds: [...pathConds],
          entryEnv,
          havocEnv: new Map(havocEnv),
          guard,
          invariants,
          variants,
          body: stmt.body,
          bodyRun,
          nextPatch,
        });
        loops.push(...bodyRun.loops.map(nested => ({
          ...nested,
          entryConds: [...active, ...nested.entryConds],
        })));
        for (const path of bodyRun.paths) {
          paths.push({ ...path, conditions: [...active, ...path.conditions] });
        }
        for (const call of bodyRun.calls) {
          calls.push({ ...call, conditions: [...active, ...call.conditions] });
        }
        const remainder = stmts.slice(i + 1);
        const exitAssumed = carried
          .map(inv => exprToSmtWithEnv(inv.expr, postLoopEnv))
          .filter(s => !/UNSUPPORTED/.test(s));
        walkCapture(remainder, 0, [...pathConds, ...exitAssumed], new Map(postLoopEnv));
        for (const exit of bodyRun.breakEnvs) {
          walkCapture(remainder, 0, [...active, ...exit.conditions], new Map(exit.env));
        }
        return;
      }
      if (stmt.kind === "MatchStmt" || stmt.kind === "IfLetStmt" || stmt.kind === "LetElseStmt") {
        // Pattern predicates are not translated yet. Explore every possible arm so an exit
        // can make a proof fail, but never disappear and make an invalid proof pass.
        const branches: Stmt[][] = stmt.kind === "MatchStmt"
          ? stmt.arms.map(arm => arm.body)
          : stmt.kind === "IfLetStmt"
            ? [stmt.thenBody, stmt.elseBody ?? []]
            : [[], stmt.elseBody];
        const remainder = stmts.slice(i + 1);
        for (const branch of branches) {
          walkCapture([...branch, ...remainder], 0, pathConds, new Map(localEnv));
        }
        return;
      }
      // skip unhandled statements
    }
    // reached end of body without return → void path
    finalEnvs.push({ conditions: [...pathConds], env: new Map(localEnv) });
  }

  walkCapture(stmts, 0, [], new Map(env));
  return { paths, finalEnvs, breakEnvs, continueEnvs, calls, havocDecls: ctx.havocDecls, loops, structLits, asserts };
}

// `x.len` on a string/Vec/array can never be negative, and the solver has no way to know
// that on its own — without it, `requires key.len == 16` is refuted by a counterexample
// where the key is -1 bytes long.
//
// Deliberately NOT applied to every symbol ending in `_len`: a user struct may have a
// plain `len: i64` field that legitimately goes negative, and asserting a false fact about
// it would be a false PROOF, not a missed one. Only bases whose declared type actually
// carries a length qualify, so an unknown-typed base gets nothing.
// Havoc symbols get theirs at minting (mintHavoc); this covers the symbols the declaration
// block is built from, including the ones lowering invented by rebasing.
function lengthNonNeg(refs: Set<string>): string[] {
  return [...refs].filter(isLenSymbol).map(r => `(assert (>= ${r} 0))`);
}

// `if c { a } else { b }` as a VALUE, which is `ite` in SMT. Both arms must be a single
// expression statement — an arm that computes anything (a `let`, a loop, an early return)
// has no `ite` translation, and inventing one would state something the code does not do.
// Milo uses this form constantly, so without a rule whole postconditions went unknown for
// a construct that maps onto the theory exactly.
function ifExprArm(body: Stmt[]): Expr | null {
  if (body.length !== 1) return null;
  const only = body[0] as any;
  if (only.kind === "Return" && only.value) return only.value as Expr;
  if (only.kind === "ExprStmt" && only.expr) return only.expr as Expr;
  return null;
}

// `x.len()` rewritten as `x.len`, so one code path handles both spellings. Zero-arg and
// name-checked: `v.len()` is a pure length, `v.pop()` is not.
function lenMethodAsField(expr: any): Expr | null {
  if (expr.kind !== "MethodCall" || expr.method !== "len") return null;
  if (expr.args && expr.args.length > 0) return null;
  return { kind: "FieldAccess", object: expr.object, field: "len", span: expr.span } as Expr;
}

function collectFieldRefs(expr: Expr, refs: Set<string>): void {
  if (!expr) return;
  if (expr.kind === "MethodCall") {
    const asLen = lenMethodAsField(expr);
    if (asLen) { collectFieldRefs(asLen, refs); return; }
    return;
  }
  if (expr.kind === "FieldAccess") {
    const flat = flattenFieldAccess(expr);
    if (flat && flat.includes("_")) refs.add(flat);
    return;
  }
  if (expr.kind === "BinOp") { collectFieldRefs(expr.left, refs); collectFieldRefs(expr.right, refs); return; }
  if (expr.kind === "UnaryOp") { collectFieldRefs(expr.operand, refs); return; }
}

function collectFieldRefsFromBody(stmts: Stmt[], refs: Set<string>): void {
  for (const stmt of stmts) {
    if (stmt.kind === "Assign") {
      if (stmt.target.kind === "FieldAccess") {
        const flat = flattenFieldAccess(stmt.target);
        if (flat && flat.includes("_")) refs.add(flat);
      }
      collectFieldRefs(stmt.value, refs);
    } else if (stmt.kind === "LetDecl" || stmt.kind === "VarDecl") {
      if (stmt.value) collectFieldRefs(stmt.value, refs);
    } else if (stmt.kind === "Return" && stmt.value) {
      collectFieldRefs(stmt.value, refs);
    } else if (stmt.kind === "IfStmt") {
      collectFieldRefs(stmt.cond, refs);
      collectFieldRefsFromBody(stmt.thenBody, refs);
      if (stmt.elseBody) collectFieldRefsFromBody(stmt.elseBody, refs);
    } else if (stmt.kind === "UnsafeBlock") {
      collectFieldRefsFromBody(stmt.body, refs);
    }
  }
}

// Is this lowered term a bare symbol a field can be hung off (`v__mut0` → `v__mut0_len`),
// as opposed to an expression or a marker? `.` is admitted because a call-model symbol
// carries the callee's qualified name (`Vec.new__ret0`) and SMT-LIB allows it in a simple
// symbol; this must agree with the symbol syntax symbolsResolve scans for.
function isPlainSymbol(term: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(term);
}

function flattenFieldAccess(expr: Expr): string | null {
  if (expr.kind === "Ident") return expr.name;
  if (expr.kind === "FieldAccess") {
    const obj = flattenFieldAccess(expr.object);
    if (obj) return `${obj}_${expr.field}`;
  }
  return null;
}

// Substitute a field access through its BASE identifier. At a call site the env maps the
// callee's parameter (`key`) to the caller's argument, never the flattened `key_len` — so
// lowering `requires key.len == 16` against the flat name alone emitted the CALLEE's
// symbol into the CALLER's query, where nothing declares it. Both solvers then reported an
// error about a constant the user never wrote, and the precondition went unchecked: 13 of
// the tree's translator errors were this one bug (`key_len`, `iv_len`, `s_len`).
//
// Only a base that maps to a plain symbol can be rebased — `f(a + b).len` has no name to
// hang a field on, and inventing one would silently check a different obligation.
// Null when the base can't carry a field: not a plain identifier at the root, not
// substituted, or substituted to an expression rather than a symbol (`let iv =
// ivFromCount(count)` maps `iv` to a call-model constant or an UNSUPPORTED marker — there
// is nothing to append `_len` to). The caller decides what null means in its scope.
function rebaseFieldAccess(expr: Expr, env: Map<string, string>): { kind: "rebased"; name: string } | { kind: "no" } {
  const fields: string[] = [];
  let node: Expr = expr;
  while (node.kind === "FieldAccess") {
    fields.unshift(node.field);
    node = node.object;
  }
  if (node.kind !== "Ident") return { kind: "no" };
  // Longest bound prefix wins. `lencode.count.len` has no binding as a whole, but
  // `lencode_count` does (from the struct literal), and hanging `_len` off that symbol is
  // what lets `zeros`' postcondition reach this obligation. Falls back to the base itself,
  // which is the call-site substitution case.
  for (let take = fields.length; take >= 0; take--) {
    const key = [node.name, ...fields.slice(0, take)].join("_");
    const bound = env.get(key);
    if (bound === undefined || !isPlainSymbol(bound)) continue;
    const name = [bound, ...fields.slice(take)].join("_");
    // The reconstructed place may itself be bound (a havoc moved `v_len` while `v` still
    // maps to `v`): the binding is the current value, the reconstruction is the stale one.
    const current = env.get(name);
    if (current && isPlainSymbol(current)) return { kind: "rebased", name: current };
    FIELD_REFS?.add(name);   // the query has to declare what this substitution invented
    const base = UNCONSTRAINED_HAVOCS.get(bound);
    if (base && !UNCONSTRAINED_HAVOCS.has(name) && !DERIVED_FROM.has(name)) {
      UNCONSTRAINED_HAVOCS.set(name, { place: [base.place, ...fields.slice(take)].join("_"), why: base.why });
      DERIVED_FROM.set(name, bound);
    }
    return { kind: "rebased", name };
  }
  return { kind: "no" };
}

// Field symbols invented during lowering, collected so the enclosing function's
// declaration block can declare them. Scoped to one function's VC build, like CALL_MODEL.
let FIELD_REFS: Set<string> | null = null;

// `foreign` marks lowering of a CALLEE's contract under a parameter substitution, where
// every name belongs to the callee's scope, not this query's. There a name the
// substitution doesn't cover (the callee's own local, a field of its receiver) has no
// meaning here: emitting it raw puts an undeclared symbol in the query — which both
// solvers report as an error naming a constant the user never wrote — or, worse, collides
// with an unrelated caller-side name and checks a different obligation than the one asked.
// In the caller's own body env the same flat names ARE this scope's, and declared.
function exprToSmtWithEnv(expr: Expr, env: Map<string, string>, foreign = false, oldEnv?: Map<string, string>): string {
  if (!expr) return "0";
  // `old(e)` names the value `e` held at entry. In a FOREIGN lowering the substitution map
  // usually binds each parameter to the caller's argument as it stood at the call, so there
  // the pre-state is `env` itself — that is what makes a callee's `ensures result == old(n)
  // + 1` usable at the call site. The exception is the frame assumption below, where `env`
  // deliberately binds the POST-call symbols and `oldEnv` carries the pre-call ones.
  if (isOldCall(expr)) {
    const pre = oldEnv ?? (foreign ? env : OLD_ENV);
    if (!pre) return `(UNSUPPORTED old)`;
    return exprToSmtWithEnv((expr as any).args[0]!, pre, foreign, oldEnv);
  }
  if (expr.kind === "Ident") {
    const mapped = env.get(expr.name);
    if (mapped) return mapped;
    if (expr.name === "result") return "result";
    const konst = GLOBAL_CONST_SMT.get(expr.name);
    if (konst) return konst;   // module-level const: shared by both scopes
    return foreign ? `(UNSUPPORTED Ident)` : expr.name;
  }
  if (expr.kind === "FieldAccess") {
    const flat = flattenFieldAccess(expr);
    if (flat) {
      const mapped = env.get(flat);
      if (mapped) return mapped;
      const r = rebaseFieldAccess(expr, env);
      if (r.kind === "rebased") return r.name;
      return foreign ? `(UNSUPPORTED FieldAccess)` : flat;
    }
  }
  if (expr.kind === "BinOp") {
    const left = exprToSmtWithEnv(expr.left, env, foreign, oldEnv);
    const bit = bitOpToSmt(expr.op, left, expr.right);
    if (bit) return bit;
    const right = exprToSmtWithEnv(expr.right, env, foreign, oldEnv);
    const rdiv = realDivToSmt(expr.op, left, right);
    if (rdiv) return rdiv;
    if (expr.op === "/" || expr.op === "%") {
      const t = truncDivToSmt(expr.op, left, right, resolveConstNum(expr.right));
      if (t) return t;
    }
    return `(${binOpToSmt(expr.op)} ${left} ${right})`;
  }
  if (expr.kind === "CastExpr") {
    return castToSmt(exprToSmtWithEnv(expr.operand, env, foreign, oldEnv), expr.targetType?.name ?? "i64");
  }
  if (expr.kind === "UnaryOp") {
    if (expr.op === "!") return `(not ${exprToSmtWithEnv(expr.operand, env, foreign, oldEnv)})`;
    if (expr.op === "-") return `(- ${exprToSmtWithEnv(expr.operand, env, foreign, oldEnv)})`;
  }
  if (expr.kind === "IfExpr") {
    const t = ifExprArm(expr.thenBody), e = ifExprArm(expr.elseBody);
    if (t && e) {
      return `(ite ${exprToSmtWithEnv(expr.cond, env, foreign, oldEnv)} ` +
             `${exprToSmtWithEnv(t, env, foreign, oldEnv)} ${exprToSmtWithEnv(e, env, foreign, oldEnv)})`;
    }
    return `(UNSUPPORTED IfExpr)`;
  }
  if (expr.kind === "MethodCall") {
    const asLen = lenMethodAsField(expr);
    if (asLen) return exprToSmtWithEnv(asLen, env, foreign, oldEnv);
  }
  if (expr.kind === "Call" && typeof expr.func === "string") {
    const modeled = modelCall(expr, expr.func, expr.args, env);
    if (modeled) return modeled;
    return `(UNSUPPORTED_CALL ${expr.func})`;
  }
  return exprToSmt(expr);
}

// onlyFile: restrict VCs to functions declared in that absolute path (the entry
// file). Functions with no sourceFile (single-file program, no imports) are always
// kept. Without it, imported stdlib contracts flood the report with unmodeled-theory noise.
// Whether a body calls anything with a `requires`, so a contract-free fn is still visited
// for its call-site obligations. Deliberately shallow-but-broad: over-reporting here only
// costs a walk that finds nothing.
function callsAContractedFn(stmts: Stmt[], contracted: Map<string, Function>): boolean {
  let found = false;
  const seen = new Set<any>();
  const scan = (node: any) => {
    if (!node || typeof node !== "object" || found || seen.has(node)) return;
    seen.add(node);
    if (node.kind === "Call" && typeof node.func === "string" && contracted.has(node.func)) { found = true; return; }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === "object") scan(v);
    }
  };
  stmts.forEach(scan);
  return found;
}

// Whether a body builds a struct that carries an invariant. Such a function owes the
// establishment obligation even with no contract of its own.
function constructsInvariantStruct(stmts: Stmt[]): boolean {
  let found = false;
  const seen = new Set<any>();
  const scan = (node: any) => {
    if (!node || typeof node !== "object" || found || seen.has(node)) return;
    seen.add(node);
    if (node.kind === "StructLit" && STRUCT_INVARIANTS.has(node.name)) { found = true; return; }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === "object") scan(v);
    }
  };
  stmts.forEach(scan);
  return found;
}

export function generateVerificationConditions(program: Program, opts?: { onlyFile?: string }): VerifyResult {
  const conditions: VerificationCondition[] = [];
  let contractCount = 0;
  let loopCount = 0;

  // Resolve immutable top-level constants once, in source order (a global may
  // reference an earlier one), so contracts can inline them as SMT literals.
  GLOBAL_CONST_SMT = new Map();
  GLOBAL_CONST_NUM = new Map();
  for (const g of program.globals ?? []) {
    if (g.mutable) continue;
    const num = resolveConstNum(g.value);
    if (num !== null) {
      GLOBAL_CONST_NUM.set(g.name, num);
      GLOBAL_CONST_SMT.set(g.name, numToSmt(num));
    } else {
      GLOBAL_CONST_SMT.set(g.name, exprToSmt(g.value));
    }
  }

  // Impl methods are verified like free functions, under their qualified `Type.method`
  // name — the same key `rewriteStaticCalls` produces for their call sites. The stdlib
  // reorg moved contracts (e.g. std/math's `requires x >= 0`) onto `impl` methods; without
  // this they'd carry no VCs and every caller's `Math.foo()` would havoc.
  const implMethods: Function[] = [];
  for (const im of program.impls ?? []) {
    for (const m of im.methods) implMethods.push({ ...m, name: `${im.typeName}.${m.name}` });
  }
  const allFns = [...program.functions, ...implMethods];

  // Rewrite `Type.method(..)` EnumLits to Calls across every body and contract, excluding
  // any key that is actually an enum variant (a real construction must not be rewritten).
  // The builtin constructors join the impl methods so `Vec.new()` is rewritten to a Call
  // and modelled through its `ensures result.len == 0` like any contracted callee.
  const implKeys = new Set([...implMethods.map(m => m.name), ...builtinConstructors().keys()]);
  const enumVariantKeys = new Set<string>();
  for (const en of program.enums ?? []) for (const v of en.variants) enumVariantKeys.add(`${en.name}.${v.name}`);
  for (const k of enumVariantKeys) implKeys.delete(k);
  for (const fn of allFns) {
    rewriteStaticCalls(fn.body, implKeys);
    for (const c of fn.contracts) rewriteStaticCalls(c.expr, implKeys);
  }

  FN_TABLE = new Map(allFns.map(f => [f.name, f]));
  PURE_FN_NAMES = new Set(allFns.filter(mutatesNothing).map(f => f.name));
  PURE_METHOD_NAMES = new Set<string>();
  {
    const byBareName = new Map<string, Function[]>();
    for (const m of implMethods) {
      const bare = m.name.slice(m.name.indexOf(".") + 1);
      (byBareName.get(bare) ?? byBareName.set(bare, []).get(bare)!).push(m);
    }
    for (const [bare, ms] of byBareName) if (ms.every(mutatesNothing)) PURE_METHOD_NAMES.add(bare);
  }
  BOOL_FIELDS = collectBoolFields(program);
  FLOAT_FIELDS = collectFloatFields(program);
  STRUCT_INVARIANTS = new Map();
  STRUCT_FIELDS = new Map();
  STRUCT_FIELD_TYPES = new Map();
  for (const st of program.structs ?? []) {
    STRUCT_FIELDS.set(st.name, (st.fields as any[]).map(f => f.name));
    STRUCT_FIELD_TYPES.set(st.name, new Map((st.fields as any[]).map(f => [f.name, f.type])));
    const invs = (st.invariants ?? []).filter(c => c.kind === "invariant");
    if (invs.length > 0) STRUCT_INVARIANTS.set(st.name, invs);
  }

  // Callee preconditions, for the call-site obligations below.
  const requiresByFn = new Map<string, Function>();
  // Callee postconditions, for modelling calls that appear inside a body or contract.
  const ensuresByFn = new Map<string, Function>();
  for (const fn of allFns) {
    if (fn.contracts.some(c => c.kind === "requires")) requiresByFn.set(fn.name, fn);
    if (fn.contracts.some(c => c.kind === "ensures")) ensuresByFn.set(fn.name, fn);
  }
  for (const [name, fn] of builtinConstructors()) {
    if (!FN_TABLE.has(name)) { FN_TABLE.set(name, fn); ensuresByFn.set(name, fn); }
  }

  for (const fn of allFns) {
    if (opts?.onlyFile && fn.sourceFile && fn.sourceFile !== opts.onlyFile) continue;
    // A fn with no contracts of its own still has to honour the ones it calls.
    const callsContracted = callsAContractedFn(fn.body, requiresByFn);
    // A constructor may carry no contract of its own and still owe one: every reader of the
    // struct it builds gets to assume that type's invariant. So may a mutator — skipping a
    // function that can write through a `&mut S` would leave S's invariant assumed
    // everywhere and maintained nowhere, which is a hole, not a gap in coverage.
    const touchesInvariantStruct = STRUCT_INVARIANTS.size > 0 &&
      (constructsInvariantStruct(fn.body) ||
       fn.params.some(p => (p.type?.isRefMut || p.type?.isPtr) && p.type?.name && STRUCT_INVARIANTS.has(p.type.name)));
    if (fn.contracts.length === 0 && !hasLoopInvariants(fn.body) && !callsContracted && !touchesInvariantStruct) continue;

    const requires = fn.contracts.filter(c => c.kind === "requires");
    const ensures = fn.contracts.filter(c => c.kind === "ensures");
    const decreases = fn.contracts.filter(c => c.kind === "decreases");
    contractCount += fn.contracts.length;

    CALL_MODEL = { ensuresByFn, decls: [], assumes: [], n: 0, bySite: new WeakMap<object, Map<string, string>>(), byPureKey: new Map(), scope: new Set(), assumed: new Set(), opaque: new Set() };
    const vcStart = conditions.length;

    // Sorts are per-function: the same Milo name is an i64 here and an f64 in the next
    // function. `result` is seeded rather than left to its own declaration further down,
    // because `ensures` is lowered before that point and lowering is what needs the sort.
    REAL_SYMS = new Set();
    NONREAL_SYMS = new Set();
    if (fn.retType?.name) (miloTypeToSmt(fn.retType.name) === "Real" ? REAL_SYMS : NONREAL_SYMS).add("result");

    const paramDecls = fn.params.map(p => declareConst(p.name, p.type?.name ?? "i64")).join("\n");
    // What the type already guarantees. Without it the solver invents out-of-range inputs.
    const paramRanges = fn.params
      .map(p => intRangeAssumption(p.name, p.type?.name))
      .filter(Boolean).join("\n");

    // collect all field access references used in contracts and body, declare as SMT constants
    const fieldRefs = new Set<string>();
    for (const c of fn.contracts) collectFieldRefs(c.expr, fieldRefs);
    collectFieldRefsFromBody(fn.body, fieldRefs);
    // Lowering below (body walk, call-site obligations) invents more of these by
    // substitution, so the set stays open until the declaration block is assembled.
    FIELD_REFS = fieldRefs;
    MUTABLE_NAMES = collectMutableNames(fn);
    LEN_BEARING = collectLenBearing(fn);
    UNCONSTRAINED_HAVOCS = new Map();
    DERIVED_FROM = new Map();
    HAVOC_TYPING_FACTS = new Set();
    // Must be set before any contract or body expression is lowered — that is when call
    // modelling runs and needs to know which symbols this function's query declares.
    CALL_MODEL.scope = new Set([...fn.params.map(p => p.name), ...fieldRefs, "result"]);

    // One symbolic run, shared by every VC below. It has to happen before the declaration
    // block is assembled: walking the body is what discovers the havoc constants, and each
    // one has to be declared in the same block the path conditions referencing it land in.
    const paramEnv = new Map<string, string>();
    const paramTypes = new Map<string, string>();
    for (const p of fn.params) {
      paramEnv.set(p.name, p.name);
      if (p.type?.name) paramTypes.set(p.name, p.type.name);
    }
    // `old(e)` reads this and nothing else. It must be a snapshot: the walker mutates its
    // own environments in place, and an `old` that followed those edits would be the
    // current state under another name.
    OLD_ENV = new Map(paramEnv);
    const symResult = collectPaths(fn.body, paramEnv, paramTypes);

    // Call-site obligations: the prover proves a callee's `ensures` GIVEN its `requires`,
    // and nothing proved the caller actually delivers that `requires`. Statically it was
    // an assumption. (Debug builds do assert it at entry — language-reference.md:267 —
    // so this closes the *static* half, not an unchecked hole.)
    //
    // Lowered BEFORE the declaration block is assembled: substituting the callee's params
    // for the caller's arguments is what invents symbols like `key_len`, and they have to
    // reach `fieldRefs` in time to be declared.
    const callObligations: { callee: string; obligation: string; guard: string; conds: string[] }[] = [];
    for (const call of symResult.calls) {
      const callee = requiresByFn.get(call.name);
      if (!callee || callee.name === fn.name) continue;   // self-recursion: needs induction, skip
      if (call.args.length !== callee.params.length) continue;  // variadic/defaulted: can't map args to params
      // Substitute the callee's params with the caller's arg expressions.
      const subst = new Map<string, string>(call.fields);
      callee.params.forEach((p, idx) => subst.set(p.name, call.args[idx]!));
      for (const req of callee.contracts.filter(c => c.kind === "requires")) {
        const obligation = exprToSmtWithEnv(req.expr, subst, true);
        // An untranslatable obligation is KEPT, marker and all: the marker makes it report
        // `unknown` with the reason attached. Dropping it here (what this did before) made
        // an unchecked precondition indistinguishable from a checked one — the call simply
        // wasn't in the report, so nothing said the guarantee was resting on nothing.
        const guard = call.conditions.length > 0 ? `(assert (and ${call.conditions.join(" ")}))` : "";
        callObligations.push({ callee: callee.name, obligation, guard, conds: call.conditions });
      }
    }

    // A struct invariant is a property of the type, so every value of that type satisfies it
    // wherever it is observed — including a parameter on entry. This is what makes
    // `prg.len >= 16384` usable inside a function that never checks it: the loader
    // established it, and the type carries it. What establishes it is the obligation at each
    // struct literal below; without that half this would be an unchecked assumption.
    const structAssumptions: string[] = [];
    const assumedInvariants = new Set<string>();
    const invariantParams = fn.params.filter(p => p.type?.name && STRUCT_INVARIANTS.has(p.type.name));
    for (const p of invariantParams) {
      for (const inv of must(STRUCT_INVARIANTS, p.type!.name, "s t r u c t  i n v a r i a n t s")) {
        const fieldEnv = new Map<string, string>();
        for (const f of STRUCT_FIELDS.get(p.type!.name) ?? []) {
          const sym = `${p.name}_${f}`;
          fieldRefs.add(sym);
          fieldEnv.set(f, sym);
        }
        const smt = instantiateInvariant(inv, fieldEnv);
        if (!/UNSUPPORTED/.test(smt)) { structAssumptions.push(`(assert ${smt})`); assumedInvariants.add(p.type!.name); }
      }
    }

    const fieldSort = (f: string) => {
      const leaf = f.slice(f.lastIndexOf("_") + 1);
      if (BOOL_FIELDS.has(leaf)) return "Bool";
      if (FLOAT_FIELDS.has(leaf)) return "Real";
      return "Int";
    };
    const fieldDecls = [...fieldRefs].map(f => {
      const sort = fieldSort(f);
      if (sort === "Real") REAL_SYMS.add(f);
      return `(declare-const ${f} ${sort})`;
    }).join("\n");
    const lenFacts = lengthNonNeg(fieldRefs).join("\n");
    FIELD_REFS = null;

    let allDecls = fieldDecls ? `${paramDecls}\n${fieldDecls}` : paramDecls;
    if (paramRanges) allDecls = `${allDecls}\n${paramRanges}`;
    if (lenFacts) allDecls = `${allDecls}\n${lenFacts}`;
    if (symResult.havocDecls.length > 0) allDecls = `${allDecls}\n${symResult.havocDecls.join("\n")}`;
    allDecls = `${allDecls}\n${CALL_MODEL_SLOT}`;

    const preAssumptions = [
      ...requires.map(r => `(assert ${exprToSmt(r.expr)})`),
      ...structAssumptions,
    ].join("\n");

    // Built before any VC is emitted so a cut can name an EARLIER cut it leaned on: the
    // conditions arrays already carry the earlier cut's SMT, and this is what turns that
    // string back into the name the report uses. Identical facts asserted twice collapse to
    // one name, which is right — they are the same fact.
    const cutName = new Map<string, string>();
    for (const a of symResult.asserts) {
      const name = `assert ${a.source}${a.line ? ` (line ${a.line})` : ""}`;
      if (!cutName.has(a.cond)) cutName.set(a.cond, name);
    }
    const cutsIn = (conds: string[]): string[] => {
      const seen = new Set<string>();
      for (const c of conds) { const n = cutName.get(c); if (n) seen.add(n); }
      return [...seen];
    };

    for (const o of callObligations) {
      const leansOn = cutsIn(o.conds);
      conditions.push({
        fn: fn.name,
        kind: "precondition",
        ...(leansOn.length ? { assumesCuts: leansOn } : {}),
        description: `call to ${o.callee} from ${fn.name}: ${o.obligation}`,
        smtlib: [
          `; Call-site precondition proof: ${fn.name} -> ${o.callee}`,
          `(set-logic ALL)`,
          allDecls,
          preAssumptions,
          o.guard,
          `(assert (not ${o.obligation}))`,
          `(check-sat)`,
        ].filter(Boolean).join("\n"),
      });
    }

    // Each `assert(E)` is proven where it is written, under the path conditions that reach
    // it and under the cuts BEFORE it — `assert a; assert b` lets the second lean on the
    // first, which is the whole point of a decomposition. The conditions array already
    // carries the earlier cuts, because they were pushed onto it as the walker passed them.

    for (const a of symResult.asserts) {
      const guard = a.conditions.length > 0 ? `(assert (and true ${a.conditions.join(" ")}))` : "";
      const leansOn = cutsIn(a.conditions);
      conditions.push({
        fn: fn.name,
        kind: "assert",
        cutId: cutName.get(a.cond),
        ...(leansOn.length ? { assumesCuts: leansOn } : {}),
        description: `assert in ${fn.name}${a.line ? `:${a.line}` : ""}: ${a.source}`,
        smtlib: [
          `; Proof cut: ${fn.name} asserts ${a.source}`,
          `(set-logic ALL)`,
          allDecls,
          preAssumptions,
          guard,
          `(assert (not ${a.cond}))`,
          `(check-sat)`,
        ].filter(Boolean).join("\n"),
      });
    }

    // Postconditions: symbolically execute body to build path constraints
    if (ensures.length > 0) {
      const isVoid = fn.retType.name === "void";

      for (const ens of ensures) {
        const postSmt = exprToSmt(ens.expr);

        // A postcondition names the state at EXIT, so it is lowered once per exit, in that
        // exit's environment — not once against the entry symbols. That is what makes a
        // clause about a `&mut` parameter mean anything: `ensures n == old(n) + 1` reads the
        // post-state for `n` and the entry state for `old(n)`, and the two are different
        // symbols only because the lowering happens here. Binding the flat entry symbol to
        // the final value instead (what this did before) would also silently overwrite the
        // struct-invariant assumptions above, which are stated about entry.
        const exits: { conditions: string[]; env: Map<string, string>; result?: string }[] =
          !isVoid && symResult.paths.length > 0
            ? symResult.paths.map(p => ({ conditions: p.conditions, env: p.env, result: p.result }))
            : isVoid ? symResult.finalEnvs.map(fe => ({ conditions: fe.conditions, env: fe.env }))
            : [];

        if (exits.length > 0) {
          const violations = exits.map(exit => {
            const post = exprToSmtWithEnv(ens.expr, exit.env);
            const parts = [
              ...exit.conditions,
              ...(exit.result !== undefined ? [`(= result ${exit.result})`] : []),
              `(not ${post})`,
            ];
            return `(and true ${parts.join(" ")})`;
          });
          const violated = violations.length === 1 ? violations[0] : `(or ${violations.join(" ")})`;
          // A postcondition is the usual downstream consumer of a cut: the exit conditions
          // it is proved under are exactly the path conditions the walker left behind, cuts
          // included. Without naming them, a postcondition proved off a REFUTED cut came
          // back a clean tick.
          const leansOn = cutsIn(exits.flatMap(e => e.conditions));
          conditions.push({
            fn: fn.name,
            kind: "postcondition",
            ...(leansOn.length ? { assumesCuts: leansOn } : {}),
            description: `postcondition of ${fn.name}: ${postSmt}`,
            smtlib: [
              `; Postcondition proof for ${fn.name}`,
              `(set-logic ALL)`,
              allDecls,
              ...(isVoid ? [] : [declareConst("result", fn.retType.name)]),
              preAssumptions,
              `(assert ${violated})`,
              `(check-sat)`,
            ].filter(Boolean).join("\n"),
          });
        } else {
          // no paths extracted — fall back to unconstrained check
          conditions.push({
            fn: fn.name,
            kind: "postcondition",
            description: `postcondition of ${fn.name}: ${postSmt}`,
            smtlib: [
              `; Postcondition check for ${fn.name} (no body analysis)`,
              `(set-logic ALL)`,
              allDecls,
              declareConst("result", fn.retType.name),
              preAssumptions,
              `(assert (not ${postSmt}))`,
              `(check-sat)`,
            ].join("\n"),
          });
        }
      }
    }

    // Struct invariants, the establishing half. Every use site above gets to ASSUME the
    // invariant of a value it receives; construction is where that has to be earned.
    for (const lit of symResult.structLits) {
      const fieldEnv = new Map(lit.fields);
      for (const inv of STRUCT_INVARIANTS.get(lit.struct) ?? []) {
        const smt = instantiateInvariant(inv, fieldEnv);
        const guard = lit.conditions.length > 0 ? `(assert (and true ${lit.conditions.join(" ")}))` : "";
        conditions.push({
          fn: fn.name,
          kind: "struct-invariant",
          invariantOf: lit.struct,
          description: `invariant of ${lit.struct} holds at construction in ${fn.name}: ${exprToSmt(inv.expr)}`,
          smtlib: [
            `; Struct invariant establishment: ${lit.struct} built in ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            guard,
            `(assert (not ${smt}))`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
      }
    }

    // ...and the maintaining half. A function that can write through a `&mut S` can also
    // break S's invariant, and every later reader assumes it. Only `&mut` parameters need
    // this: a by-value parameter is the callee's own copy, and `&S` cannot be written at all.
    for (const p of invariantParams) {
      if (!p.type?.isRefMut && !p.type?.isPtr) continue;
      const fields = STRUCT_FIELDS.get(p.type.name) ?? [];
      for (const inv of must(STRUCT_INVARIANTS, p.type.name, "s t r u c t  i n v a r i a n t s")) {
        // Every exit, not just the fall-through ones: a mutator that ends in `return true`
        // has no final env at all, and reading only those would have silently checked
        // nothing for exactly the functions most likely to break the invariant.
        const exits = [
          ...symResult.paths.map(pt => ({ conditions: pt.conditions, env: pt.env })),
          ...symResult.finalEnvs,
        ];
        const violations: string[] = [];
        for (const fe of exits) {
          const fieldEnv = new Map<string, string>();
          for (const f of fields) fieldEnv.set(f, fe.env.get(`${p.name}_${f}`) ?? `${p.name}_${f}`);
          const after = instantiateInvariant(inv, fieldEnv);
          violations.push(`(and true ${[...fe.conditions, `(not ${after})`].join(" ")})`);
        }
        if (violations.length === 0) continue;   // no completing path: nothing to maintain
        conditions.push({
          fn: fn.name,
          kind: "struct-invariant",
          invariantOf: p.type.name,
          description: `invariant of ${p.type.name} maintained by ${fn.name}: ${exprToSmt(inv.expr)}`,
          smtlib: [
            `; Struct invariant maintenance: ${p.name}: &mut ${p.type.name} in ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            `(assert ${violations.length === 1 ? violations[0] : `(or ${violations.join(" ")})`})`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
      }
    }

    // Termination. A self-recursive call is modelled by ASSUMING this function's own
    // `ensures` — that is induction, and induction over a recursion that may not terminate
    // proves anything. `decreases` supplies the well-founded measure the induction needs:
    // non-negative at entry, and strictly smaller at every self-call.
    for (const dec of decreases) {
      const atEntry = exprToSmt(dec.expr);
      const selfCalls = symResult.calls.filter(c => c.name === fn.name && c.args.length === fn.params.length);
      for (const call of selfCalls) {
        const subst = new Map<string, string>();
        fn.params.forEach((p, idx) => subst.set(p.name, call.args[idx]!));
        const atCall = exprToSmtWithEnv(dec.expr, subst, true);
        const guard = call.conditions.length > 0 ? `(assert (and true ${call.conditions.join(" ")}))` : "";
        conditions.push({
          fn: fn.name,
          kind: "termination",
          description: `recursion of ${fn.name} decreases: ${atCall} < ${atEntry} and ${atEntry} >= 0`,
          smtlib: [
            `; Termination measure for the self-call in ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            guard,
            `(assert (not (and (>= ${atEntry} 0) (< ${atCall} ${atEntry}))))`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
      }
      // A `decreases` on a function that never calls itself has nothing to discharge. Say so
      // rather than silently reporting a clause as proven that was never used for anything.
      if (selfCalls.length === 0) {
        conditions.push({
          fn: fn.name,
          kind: "termination",
          description: `decreases on ${fn.name} is vacuous: no self-recursive call was found`,
          smtlib: [
            `; Vacuous termination measure in ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            `(assert (not (>= ${atEntry} 0)))`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
      }
    }

    // Loop invariants, the two halves of the induction. Both are stated in the same
    // declaration block as everything else, so the fresh havoc constants they quantify over
    // are actually declared — the previous stub emitted a bare `(assert (not INV))` with no
    // declarations at all, which z3 rejected outright and std/smt reported as unknown.
    for (const loop of symResult.loops) {
      const entryCond = loop.entryConds.length > 0 ? `(assert (and true ${loop.entryConds.join(" ")}))` : "";
      for (const inv of loop.invariants) {
        // Establishment: the invariant has to hold on the way in, in the pre-loop state.
        // Emitted even when it will not translate — the marker makes it report `unknown`
        // with the reason. Skipping it (what this did before) hid an obligation the same
        // way the preservation half did, and an invariant whose two halves both vanish is
        // reported as a clean pass over a loop nothing checked.
        const atEntry = exprToSmtWithEnv(inv.expr, loop.entryEnv);
        conditions.push({
          fn: fn.name,
          kind: "loop-invariant",
          description: `loop invariant holds on entry in ${fn.name}: ${atEntry}`,
          smtlib: [
            `; Loop invariant establishment for ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            entryCond,
            `(assert (not ${atEntry}))`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
        loopCount++;
      }

      // Preservation: assuming every invariant and the guard, one pass through the body
      // has to re-establish them. Body paths that `return` leave the loop, so only the
      // fall-through environments have anything to preserve.
      const bodyRun = loop.bodyRun;
      const assumed = loop.invariants
        .map(inv => exprToSmtWithEnv(inv.expr, loop.havocEnv))
        .filter(s => !/UNSUPPORTED/.test(s));
      // A nested loop inside the body mints its own havoc constants; without these
      // declarations the preservation query would reference undeclared symbols.
      for (const inv of loop.invariants) {
        const violations: string[] = [];
        const nextIterationEnvs = [...bodyRun.finalEnvs, ...bodyRun.continueEnvs];
        let untranslatable = "";
        for (const fe of nextIterationEnvs) {
          // A for-in loop's binding is advanced by the loop form, not by the body, so the
          // state one iteration on is the body's exit state with that advance patched in.
          // Without it `invariant i <= n` over `for i in 0..n` would be asked to prove
          // itself about the SAME index it just assumed, which is trivially true and checks
          // nothing about the loop moving forward.
          const after = exprToSmtWithEnv(inv.expr, patched(fe.env, loop.nextPatch));
          if (/UNSUPPORTED/.test(after)) { untranslatable = after; break; }
          const conds = fe.conditions.length > 0 ? `(and true ${fe.conditions.join(" ")})` : "true";
          violations.push(`(and ${conds} (not ${after}))`);
        }
        // A body with no completing path (every route returns or breaks) has nothing to
        // preserve — vacuous, and correctly silent.
        if (!untranslatable && nextIterationEnvs.length === 0) continue;
        // FALSE PROOF otherwise. This used to `continue` when the post-iteration state
        // wouldn't translate, so the preservation obligation VANISHED and the invariant
        // was reported `proven` off its establishment VC alone:
        //
        //     while i < v.len  invariant total == 0  { total = total + v[i]; i = i + 1 }
        //
        // came back "1 condition, proven: 1, unknown: 0" for a loop whose invariant is
        // false on the first iteration — `v[i]` is an IndexAccess the translator has no
        // rule for, and the obligation that would have caught it was dropped rather than
        // reported. Emitting the marker turns it into `unknown` with the reason attached,
        // which is the same discipline the rest of the translator follows: silence must
        // never render as a checkmark.
        const violated = untranslatable
          ? `(not ${untranslatable})`
          : (violations.length === 1 ? violations[0] : `(or ${violations.join(" ")})`);
        const guardAssume = !loop.guard || /UNSUPPORTED/.test(loop.guard) ? "" : `(assert ${loop.guard})`;
        conditions.push({
          fn: fn.name,
          kind: "loop-invariant",
          description: `loop invariant preserved by body in ${fn.name}: ${exprToSmt(inv.expr)}`,
          smtlib: [
            `; Loop invariant preservation for ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            ...assumed.map(a => `(assert ${a})`),
            guardAssume,
            `(assert ${violated})`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
        loopCount++;
      }

      // A loop `decreases` is the same well-founded-measure obligation as the recursive
      // one: non-negative while the loop is still running, and strictly smaller after one
      // pass. Unlike the function-level measure this is not needed for soundness — a
      // non-terminating loop makes the postcondition vacuously true rather than provable
      // from nothing — so it buys total correctness, not the absence of a false proof.
      const guardForVariant = !loop.guard || /UNSUPPORTED/.test(loop.guard) ? "" : `(assert ${loop.guard})`;
      for (const dec of loop.variants) {
        const before = exprToSmtWithEnv(dec.expr, loop.havocEnv);
        const nextIterationEnvs = [...bodyRun.finalEnvs, ...bodyRun.continueEnvs];
        if (nextIterationEnvs.length === 0) continue;
        const violations = nextIterationEnvs.map(fe => {
          const after = exprToSmtWithEnv(dec.expr, patched(fe.env, loop.nextPatch));
          return `(and true ${[...fe.conditions, `(not (and (>= ${before} 0) (< ${after} ${before})))`].join(" ")})`;
        });
        conditions.push({
          fn: fn.name,
          kind: "termination",
          description: `loop measure decreases in ${fn.name}: ${exprToSmt(dec.expr)}`,
          smtlib: [
            `; Loop termination measure for ${fn.name}`,
            `(set-logic ALL)`,
            allDecls,
            preAssumptions,
            ...assumed.map(a => `(assert ${a})`),
            guardForVariant,
            `(assert ${violations.length === 1 ? violations[0] : `(or ${violations.join(" ")})`})`,
            `(check-sat)`,
          ].filter(Boolean).join("\n"),
        });
      }
    }

    fillCallModel(conditions, vcStart);
    markUnconstrainedHavocs(conditions, vcStart);
    if (assumedInvariants.size > 0) {
      for (let i = vcStart; i < conditions.length; i++) {
        // The type's own obligations are not conditional on themselves.
        if (conditions[i]!.invariantOf) continue;
        conditions[i]!.assumesInvariants = [...assumedInvariants];
      }
    }
    CALL_MODEL = null;
  }

  return {
    conditions,
    stats: {
      functions: allFns.filter(f => f.contracts.length > 0 || hasLoopInvariants(f.body)).length,
      contracts: contractCount,
      loops: loopCount,
    },
  };
}

// An environment with a loop form's own advance applied on top.
function patched(env: Map<string, string>, patch: Map<string, string> | undefined): Map<string, string> {
  if (!patch || patch.size === 0) return env;
  const out = new Map(env);
  for (const [k, v] of patch) out.set(k, v);
  return out;
}

// Whether the function is worth building VCs for at all. A miss here is not a wrong answer
// but no answer: the caller `continue`s past the function entirely, so an invariant written
// inside an expression-nested loop was silently never checked.
function hasLoopInvariants(stmts: Stmt[]): boolean {
  let found = false;
  walkNodes(stmts, n => {
    if ((n.kind === "WhileStmt" || n.kind === "ForInStmt") && n.invariants?.length > 0) found = true;
  });
  return found;
}

function exprToSmt(expr: Expr): string {
  switch (expr.kind) {
    case "IntLit": return expr.value.toString();
    case "FloatLit": return floatLitToSmt(expr.value);
    case "BoolLit": return expr.value ? "true" : "false";
    case "Ident":
      if (expr.name === "result") return "result";
      return GLOBAL_CONST_SMT.get(expr.name) ?? expr.name;
    case "CastExpr":
      return castToSmt(exprToSmt(expr.operand), expr.targetType?.name ?? "i64");
    case "BinOp": {
      const left = exprToSmt(expr.left);
      const bit = bitOpToSmt(expr.op, left, expr.right);
      if (bit) return bit;
      const right = exprToSmt(expr.right);
      const rdiv = realDivToSmt(expr.op, left, right);
      if (rdiv) return rdiv;
      if (expr.op === "/" || expr.op === "%") {
        const t = truncDivToSmt(expr.op, left, right, resolveConstNum(expr.right));
        if (t) return t;
      }
      const op = binOpToSmt(expr.op);
      return `(${op} ${left} ${right})`;
    }
    case "UnaryOp":
      if (expr.op === "!") return `(not ${exprToSmt(expr.operand)})`;
      if (expr.op === "-") return `(- ${exprToSmt(expr.operand)})`;
      return `(UNSUPPORTED_UNARY ${expr.op})`;
    case "Call": {
      if (isOldCall(expr)) {
        return OLD_ENV ? exprToSmtWithEnv((expr as any).args[0]!, OLD_ENV) : `(UNSUPPORTED old)`;
      }
      if (typeof expr.func === "string") {
        const modeled = modelCall(expr, expr.func, expr.args);
        if (modeled) return modeled;
        return `(UNSUPPORTED_CALL ${expr.func})`;
      }
      return `(UNSUPPORTED Call)`;
    }
    case "FieldAccess": {
      const flat = flattenFieldAccess(expr);
      if (flat) return flat;
      return `(${exprToSmt(expr.object)}.${expr.field})`;
    }
    case "IfExpr": {
      const t = ifExprArm(expr.thenBody), e = ifExprArm(expr.elseBody);
      if (t && e) return `(ite ${exprToSmt(expr.cond)} ${exprToSmt(t)} ${exprToSmt(e)})`;
      return `(UNSUPPORTED IfExpr)`;
    }
    case "MethodCall": {
      // `.len()` is the same quantity as the `.len` field, just spelled as a call — milo's
      // own std uses the field, milojs uses the method. Everything else has no modular
      // model yet (no receiver encoding), and emitting the bare application would hand the
      // solver an undeclared symbol.
      const asLen = lenMethodAsField(expr);
      if (asLen) return exprToSmt(asLen);
      return `(UNSUPPORTED_METHOD ${expr.method})`;
    }
    default:
      return `(UNSUPPORTED ${expr.kind})`;
  }
}

function binOpToSmt(op: string): string {
  switch (op) {
    case "+": return "+";
    case "-": return "-";
    case "*": return "*";
    // Handled by truncDivToSmt, which needs the operand strings; reaching this arm means
    // the caller did not route through it.
    case "/": return "UNSUPPORTED_OP_div";
    case "%": return "UNSUPPORTED_OP_mod";
    case "==": return "=";
    case "!=": return "distinct";
    case "<": return "<";
    case ">": return ">";
    case "<=": return "<=";
    case ">=": return ">=";
    case "&&": return "and";
    case "||": return "or";
    default: return `UNSUPPORTED_OP_${op}`;
  }
}

// An integer type's real range, as an SMT assumption. Every int lowers to an unbounded
// mathematical `Int`, so without this the solver is free to pick i32 = -10^18 and
// "refute" a contract like `requires a >= -2147483648` that no i32 can actually violate.
// It is an assumption about the inputs, so it only ever makes a proof easier — it cannot
// turn a proven VC into a failing one.
// i64/u64 are deliberately absent, and it is a usability call, not a soundness one:
// std/smt's Fourier-Motzkin multiplies constants, so bounds at ±2^63 overflow during
// elimination. That used to yield a FALSE PROOF (unsat for a satisfiable formula); it now
// yields `unknown`, because combine() detects the overflow — but `unknown` for every i64
// contract is worse than no range at all, since the refutations go with it. Verified: with
// i64 ranges on, a genuinely broken call reports `unknown` instead of its counterexample.
// The narrow types carry the weight anyway — they are what the solver cannot otherwise
// know. Retire this when the solver's arithmetic is widened (backlog).
const INT_RANGES: Record<string, [string, string]> = {
  i8: ["(- 128)", "127"],
  i16: ["(- 32768)", "32767"],
  i32: ["(- 2147483648)", "2147483647"],
  u8: ["0", "255"],
  u16: ["0", "65535"],
  u32: ["0", "4294967295"],
};

function intRangeAssumption(name: string, typeName: string | undefined): string | null {
  const r = INT_RANGES[typeName ?? ""];
  return r ? `(assert (and (>= ${name} ${r[0]}) (<= ${name} ${r[1]})))` : null;
}

function miloTypeToSmt(name: string): string {
  switch (name) {
    case "i8": case "i16": case "i32": case "i64":
    case "u8": case "u16": case "u32": case "u64":
      return "Int";
    case "f32": case "f64":
      return "Real";
    case "bool":
      return "Bool";
    default:
      return "Int";
  }
}

export interface SolverResult {
  vc: VerificationCondition;
  status: "proven" | "failed" | "unknown" | "error";
  detail?: string;
}

export interface ProveResult {
  results: SolverResult[];
  proven: number;
  failed: number;
  unknown: number;
  errors: number;
}

// Invoke z3 on all verification conditions and return proof results.
// What the SMT translator couldn't express, read back out of the generated VC.
//
// exprToSmt emits an `UNSUPPORTED` marker rather than dropping the term — which is what
// keeps the prover sound (the marker poisons the formula, so nothing gets proven by
// accident). But the marker then reaches the solver as an undeclared symbol, and both
// backends blame themselves for it: std/smt reports "outside linear fragment" about a
// perfectly linear contract, and z3 emits a raw parse error naming a constant the user
// never wrote. Neither points at the actual cause, so both send you off optimizing a
// contract that was never the problem.
export function untranslatable(smtlib: string): string[] {
  const out = new Set<string>();
  for (const m of smtlib.matchAll(/\(UNSUPPORTED (\w+)\)/g)) out.add(`${m[1]} expressions`);
  for (const m of smtlib.matchAll(/\(UNSUPPORTED_UNARY (\S+?)\)/g)) out.add(`unary '${m[1]}'`);
  for (const m of smtlib.matchAll(/UNSUPPORTED_OP_(\S+?)[\s)]/g)) out.add(`operator '${m[1]}'`);
  for (const m of smtlib.matchAll(/\(UNSUPPORTED_CALL (\S+?)\)/g)) out.add(`calls to '${m[1]}' (it declares no 'ensures' to model its result by)`);
  for (const m of smtlib.matchAll(/\(UNSUPPORTED_METHOD (\S+?)\)/g)) out.add(`method calls ('.${m[1]}')`);
  return [...out];
}

// Which `proven` verdicts are only conditionally proven: they assumed a callee's `ensures`
// that the same run could not establish. The assumption may still be true — `rd`'s "every
// read yields a byte" is true but sits behind an IndexAccess the translator cannot model —
// but a reader deserves to know the difference between a proof and a proof-modulo-an-
// unchecked-claim. A callee with no postcondition VC at all (not analyzed in this run,
// e.g. filtered out by --onlyFile) counts as unestablished for the same reason.
export function conditionalProofs(pr: ProveResult): Map<SolverResult, string[]> {
  const postconditionsByFn = new Map<string, SolverResult[]>();
  for (const r of pr.results) {
    if (r.vc.kind !== "postcondition") continue;
    const list = postconditionsByFn.get(r.vc.fn) ?? [];
    list.push(r);
    postconditionsByFn.set(r.vc.fn, list);
  }
  const established = (fn: string) => {
    const posts = postconditionsByFn.get(fn);
    return posts !== undefined && posts.length > 0 && posts.every(p => p.status === "proven");
  };
  // A SELF-recursive call is assumed the same way, and there the assumption is induction:
  // sound only if the recursion bottoms out. That is what `decreases` establishes, so a
  // proof that leaned on itself without a discharged measure is conditional on termination.
  const terminationByFn = new Map<string, SolverResult[]>();
  for (const r of pr.results) {
    if (r.vc.kind !== "termination") continue;
    const list = terminationByFn.get(r.vc.fn) ?? [];
    list.push(r);
    terminationByFn.set(r.vc.fn, list);
  }
  const terminates = (fn: string) => {
    const t = terminationByFn.get(fn);
    return t !== undefined && t.length > 0 && t.every(x => x.status === "proven");
  };
  // A struct invariant is assumed at every use site, so it is only as good as the
  // construction/maintenance obligations discharged for that type across this run.
  const invariantResults = new Map<string, SolverResult[]>();
  for (const r of pr.results) {
    if (!r.vc.invariantOf) continue;
    const list = invariantResults.get(r.vc.invariantOf) ?? [];
    list.push(r);
    invariantResults.set(r.vc.invariantOf, list);
  }
  const invariantHolds = (name: string) => {
    const rs = invariantResults.get(name);
    return rs !== undefined && rs.length > 0 && rs.every(x => x.status === "proven");
  };
  // A proof cut holds only if its own VC was discharged. Keyed by the cut's name, and a
  // name with no result at all counts as NOT held — a missing proof is not a proof.
  const cutResults = new Map<string, SolverResult[]>();
  for (const r of pr.results) {
    if (!r.vc.cutId) continue;
    const list = cutResults.get(r.vc.cutId) ?? [];
    list.push(r);
    cutResults.set(r.vc.cutId, list);
  }
  const cutHolds = (name: string) => {
    const rs = cutResults.get(name);
    return rs !== undefined && rs.length > 0 && rs.every(x => x.status === "proven");
  };
  const out = new Map<SolverResult, string[]>();
  for (const r of pr.results) {
    if (r.status !== "proven") continue;
    const weakCuts = (r.vc.assumesCuts ?? []).filter(name => !cutHolds(name));
    const weak = (r.vc.assumes ?? []).filter(fn => (fn === r.vc.fn ? !terminates(fn) : !established(fn)));
    const weakInv = (r.vc.assumesInvariants ?? [])
      .filter(name => !invariantHolds(name))
      .map(name => `${name}'s invariant`);
    if (weak.length || weakInv.length || weakCuts.length) out.set(r, [...weak, ...weakInv, ...weakCuts]);
  }
  return out;
}

// Solver diagnostics land in a one-line-per-VC report; a raw multi-line message would
// interleave with the next verdict.
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function untranslatableDetail(kinds: string[]): string {
  return `the SMT translator has no rule for ${kinds.join(", ")} — the contract is not the problem`;
}

export function proveWithZ3(result: VerifyResult): ProveResult {
  const { spawnSync } = require("child_process") as typeof import("child_process");

  // check z3 is available
  const which = spawnSync("which", ["z3"], { encoding: "utf-8" });
  if (which.status !== 0) {
    return {
      results: result.conditions.map(vc => ({ vc, status: "error" as const, detail: "z3 not found in PATH" })),
      proven: 0, failed: 0, unknown: 0, errors: result.conditions.length,
    };
  }

  const results: SolverResult[] = [];
  for (const vc of result.conditions) {
    // Don't hand z3 a formula containing a marker it can't parse — it would come back as
    // an opaque parse error about a symbol the user never wrote.
    const cant = untranslatable(vc.smtlib);
    if (cant.length) { results.push({ vc, status: "unknown", detail: untranslatableDetail(cant) }); continue; }
    const proc = spawnSync("z3", ["-in", "-T:5"], {
      input: vc.smtlib,
      encoding: "utf-8",
      timeout: 10000,
    });

    // z3 keeps going after a bad command, so a rejected query prints `(error ...)` AND a
    // verdict for the remaining assertions. That verdict describes a formula z3 didn't
    // fully accept, so an error anywhere invalidates the whole run — and its text must be
    // flattened to one line or it breaks the report layout.
    const output = (proc.stdout ?? "").trim();
    const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
    const errLine = lines.find(l => l.startsWith("(error"));
    if (errLine) {
      results.push({ vc, status: "error", detail: oneLine(errLine) });
    } else if (output === "unsat") {
      // negation is unsat → contract always holds
      results.push({ vc, status: "proven" });
    } else if (output === "sat") {
      // negation is sat → contract can be violated. Unless the model ranges over a value
      // nothing constrains (an invented call result, a contract-less havoc): then the
      // witness may be a state the program never reaches, and `unknown` is the honest
      // verdict. Mirrors the std/smt path.
      const why = unreproducibleCounterexample(vc);
      if (why) {
        results.push({ vc, status: "unknown", detail: why });
      } else {
        results.push({ vc, status: "failed", detail: "counterexample exists" });
      }
    } else if (output === "unknown") {
      results.push({ vc, status: "unknown", detail: "solver could not decide" });
    } else {
      results.push({ vc, status: "error", detail: oneLine(output || proc.stderr || "z3 produced no output") });
    }
  }

  return {
    results,
    proven: results.filter(r => r.status === "proven").length,
    failed: results.filter(r => r.status === "failed").length,
    unknown: results.filter(r => r.status === "unknown").length,
    errors: results.filter(r => r.status === "error").length,
  };
}

// Machine-readable proof report (schema 1). A certification workflow, a CI dashboard or a
// ratchet wants the per-obligation verdict as data, not a rendered table — and parsing the
// table is how a consumer ends up depending on its column widths. The SMT-LIB text of each
// obligation is deliberately NOT included: it is large, it is an implementation detail of
// the translator, and `--emit-smt` already prints it for anyone who wants it.
export const PROVE_JSON_SCHEMA = 1;

export function proveJson(pr: ProveResult): string {
  return JSON.stringify({
    schema: PROVE_JSON_SCHEMA,
    proven: pr.proven,
    failed: pr.failed,
    unknown: pr.unknown,
    errors: pr.errors,
    // `unknown` is not `failed`: the prover could not decide, which is a different fact
    // about the program and must stay distinguishable to whatever gates on this.
    ok: pr.failed === 0 && pr.errors === 0,
    obligations: pr.results.map(r => ({
      fn: r.vc.fn,
      kind: r.vc.kind,
      description: r.vc.description,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.vc.assumes?.length ? { assumes: r.vc.assumes } : {}),
      ...(r.vc.assumesInvariants?.length ? { assumesInvariants: r.vc.assumesInvariants } : {}),
      ...(r.vc.assumesCuts?.length ? { assumesCuts: r.vc.assumesCuts } : {}),
    })),
  }, null, 2) + "\n";
}

export function formatProveReport(pr: ProveResult): string {
  const lines: string[] = [];
  lines.push(`verification: ${pr.results.length} conditions`);
  lines.push(`  proven: ${pr.proven}  failed: ${pr.failed}  unknown: ${pr.unknown}  errors: ${pr.errors}`);
  lines.push("");

  const conditional = conditionalProofs(pr);
  for (const r of pr.results) {
    const icon = r.status === "proven" ? "✓" : r.status === "failed" ? "✗" : "?";
    const weak = conditional.get(r);
    const selfAssumed = weak?.includes(r.vc.fn);
    const invariants = weak?.filter(f => f.endsWith("'s invariant")) ?? [];
    // A cut reads nothing like a callee: "assumes assert x >= 0, whose own postcondition is
    // not established" names a postcondition a cut does not have. Split out by the prefix
    // the cut names carry.
    const cuts = weak?.filter(f => f.startsWith("assert ")) ?? [];
    const others = weak?.filter(f => f !== r.vc.fn && !f.endsWith("'s invariant") && !f.startsWith("assert ")) ?? [];
    // Two different gaps read the same in the tally but not to a reader: a function with no
    // `decreases` at all was never asked to terminate, while one whose measure came back
    // unproven was asked and could not answer.
    const hasMeasure = pr.results.some(x => x.vc.kind === "termination" && x.vc.fn === r.vc.fn);
    const termNote = hasMeasure
      ? `that ${r.vc.fn}'s recursion terminates, which its 'decreases' measure did not establish`
      : `that ${r.vc.fn}'s recursion reaches a base case, which nothing proved (add a 'decreases' clause)`;
    const parts: string[] = [];
    if (others.length) parts.push(`${others.join(", ")}, whose own postcondition is not established`);
    if (selfAssumed) parts.push(termNote);
    if (invariants.length) parts.push(`${invariants.join(", ")}, which this run did not establish at every construction and mutation`);
    if (cuts.length) parts.push(`the proof ${cuts.length === 1 ? "cut" : "cuts"} ${cuts.join(", ")}, which this run did not discharge`);
    const note = parts.length === 0 ? "" : ` — conditional: assumes ${parts.join("; and ")}`;
    lines.push(`  ${icon} [${r.vc.kind}] ${r.vc.fn}: ${r.status}${r.detail ? ` — ${r.detail}` : ""}${note}`);
  }
  if (conditional.size > 0) {
    lines.push("");
    lines.push(`  ${conditional.size} of ${pr.proven} proofs are conditional on something this run did not establish.`);
  }

  return lines.join("\n");
}

export function formatVerifyReport(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`verification conditions: ${result.conditions.length}`);
  lines.push(`  functions with contracts: ${result.stats.functions}`);
  lines.push(`  contract clauses: ${result.stats.contracts}`);
  lines.push(`  loop invariants: ${result.stats.loops}`);
  lines.push("");

  for (const vc of result.conditions) {
    lines.push(`── ${vc.kind} ── ${vc.fn} ──`);
    lines.push(vc.description);
    lines.push(vc.smtlib);
    lines.push("");
  }

  return lines.join("\n");
}
