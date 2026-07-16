// Verification condition generator — produces SMT-LIB2 from contract annotations
// and symbolically executes function bodies to prove postconditions.
import type { Program, Function, Contract, Expr, Stmt } from "./ast";

export interface VerificationCondition {
  fn: string;
  kind: "precondition" | "postcondition" | "loop-invariant";
  smtlib: string;
  description: string;
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
  switch (targetName) {
    case "u8": return `(mod ${operandStr} 256)`;
    case "u16": return `(mod ${operandStr} 65536)`;
    case "u32": return `(mod ${operandStr} 4294967296)`;
    default: return operandStr;
  }
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
  return null;
}

// Symbolic path through a function body
interface SymPath {
  conditions: string[];  // path conditions as SMT expressions
  result: string;        // return value expression
}

// Collect all execution paths through a function body via symbolic execution.
// Handles if/else chains and early returns — the common pattern in contract-bearing functions.
interface SymExecResult {
  paths: SymPath[];
  finalEnvs: { conditions: string[]; env: Map<string, string> }[];
  calls: CallSite[];
}

// A call reached during symbolic execution, with the path conditions that hold when it
// runs. Used to prove the caller actually satisfies the callee's `requires` — without the
// conditions, `if x >= 0 { g(x) }` would be reported as a violation of g's `requires
// x >= 0`, and a prover that cries wolf is one people stop running.
interface CallSite {
  name: string;
  args: string[];        // already lowered to SMT in the caller's environment
  conditions: string[];
}

// Every call reachable from an expression, paired with the conditions in force. Only
// direct calls to named fns matter — that is all a `requires` can hang off.
function collectCallsInExpr(expr: Expr, conds: string[], env: Map<string, string>, out: CallSite[]): void {
  if (!expr) return;
  const e = expr as any;
  if (e.kind === "Call" && typeof e.func === "string") {
    out.push({ name: e.func, args: (e.args ?? []).map((a: Expr) => exprToSmtWithEnv(a, env)), conditions: [...conds] });
  }
  for (const key of ["left", "right", "operand", "object", "index", "cond", "value", "start", "end", "default"]) {
    if (e[key] && typeof e[key] === "object" && e[key].kind) collectCallsInExpr(e[key], conds, env, out);
  }
  for (const key of ["args", "elements"]) {
    if (Array.isArray(e[key])) for (const a of e[key]) if (a && a.kind) collectCallsInExpr(a, conds, env, out);
  }
}

function collectPaths(stmts: Stmt[], env: Map<string, string>): SymExecResult {
  const paths: SymPath[] = [];
  const calls: CallSite[] = [];

  function walk(stmts: Stmt[], idx: number, pathConds: string[], localEnv: Map<string, string>): void {
    for (let i = idx; i < stmts.length; i++) {
      const stmt = stmts[i];

      if (stmt.kind === "LetDecl" || stmt.kind === "VarDecl") {
        if (stmt.value) {
          localEnv.set(stmt.name, exprToSmtWithEnv(stmt.value, localEnv));
        }
        continue;
      }

      if (stmt.kind === "Assign") {
        if (stmt.target.kind === "Ident") {
          localEnv.set(stmt.target.name, exprToSmtWithEnv(stmt.value, localEnv));
        } else if (stmt.target.kind === "FieldAccess") {
          const flat = flattenFieldAccess(stmt.target);
          if (flat) localEnv.set(flat, exprToSmtWithEnv(stmt.value, localEnv));
        }
        continue;
      }

      if (stmt.kind === "Return") {
        const val = stmt.value ? exprToSmtWithEnv(stmt.value, localEnv) : "0";
        paths.push({ conditions: [...pathConds], result: val });
        return;
      }

      if (stmt.kind === "UnsafeBlock") {
        // transparent — process inner statements but skip unhandled ones (while loops, etc.)
        for (const inner of stmt.body) {
          if (inner.kind === "Assign") {
            if (inner.target.kind === "Ident") {
              localEnv.set(inner.target.name, exprToSmtWithEnv(inner.value, localEnv));
            } else if (inner.target.kind === "FieldAccess") {
              const flat = flattenFieldAccess(inner.target);
              if (flat) localEnv.set(flat, exprToSmtWithEnv(inner.value, localEnv));
            }
          } else if (inner.kind === "LetDecl" || inner.kind === "VarDecl") {
            if (inner.value) localEnv.set(inner.name, exprToSmtWithEnv(inner.value, localEnv));
          } else if (inner.kind === "Return") {
            const val = inner.value ? exprToSmtWithEnv(inner.value, localEnv) : "0";
            paths.push({ conditions: [...pathConds], result: val });
            return;
          }
          // skip while loops, calls, etc. in unsafe — they don't affect provable state
        }
        continue;
      }

      if (stmt.kind === "IfStmt") {
        const cond = exprToSmtWithEnv(stmt.cond, localEnv);
        // then branch
        const thenEnv = new Map(localEnv);
        walk(stmt.thenBody, 0, [...pathConds, cond], thenEnv);
        // else/fall-through with negated condition
        const elseEnv = new Map(localEnv);
        const negCond = `(not ${cond})`;
        if (stmt.elseBody && stmt.elseBody.length > 0) {
          walk(stmt.elseBody, 0, [...pathConds, negCond], elseEnv);
        } else if (branchAlwaysReturns(stmt.thenBody)) {
          // then always returns → fall through rest of function with negated condition
          walk(stmts, i + 1, [...pathConds, negCond], elseEnv);
        } else {
          walk(stmts, i + 1, [...pathConds, negCond], elseEnv);
        }
        return;
      }
    }
  }

  // for void functions, we need to capture final env state
  const finalEnvs: { conditions: string[]; env: Map<string, string> }[] = [];

  const origWalk = walk;
  // patch: also capture fall-through paths (void functions)
  function walkCapture(stmts: Stmt[], idx: number, pathConds: string[], localEnv: Map<string, string>): void {
    for (let i = idx; i < stmts.length; i++) {
      const stmt = stmts[i];
      // Record calls before the statement updates the env, so an argument is lowered in
      // the state that actually holds at the call. Loops/match are not modelled by this
      // walker at all, so calls inside them are never recorded — missed coverage rather
      // than a VC built on conditions we cannot see.
      const st = stmt as any;
      for (const key of ["value", "expr", "cond", "subject"]) {
        if (st[key] && st[key].kind) collectCallsInExpr(st[key], pathConds, localEnv, calls);
      }

      if (stmt.kind === "LetDecl" || stmt.kind === "VarDecl") {
        if (stmt.value) localEnv.set(stmt.name, exprToSmtWithEnv(stmt.value, localEnv));
        continue;
      }
      if (stmt.kind === "Assign") {
        if (stmt.target.kind === "Ident") {
          localEnv.set(stmt.target.name, exprToSmtWithEnv(stmt.value, localEnv));
        } else if (stmt.target.kind === "FieldAccess") {
          const flat = flattenFieldAccess(stmt.target);
          if (flat) localEnv.set(flat, exprToSmtWithEnv(stmt.value, localEnv));
        }
        continue;
      }
      if (stmt.kind === "Return") {
        const val = stmt.value ? exprToSmtWithEnv(stmt.value, localEnv) : "0";
        paths.push({ conditions: [...pathConds], result: val });
        return;
      }
      if (stmt.kind === "UnsafeBlock") {
        for (const inner of stmt.body) {
          if (inner.kind === "Assign") {
            if (inner.target.kind === "Ident") {
              localEnv.set(inner.target.name, exprToSmtWithEnv(inner.value, localEnv));
            } else if (inner.target.kind === "FieldAccess") {
              const flat = flattenFieldAccess(inner.target);
              if (flat) localEnv.set(flat, exprToSmtWithEnv(inner.value, localEnv));
            }
          } else if (inner.kind === "LetDecl" || inner.kind === "VarDecl") {
            if (inner.value) localEnv.set(inner.name, exprToSmtWithEnv(inner.value, localEnv));
          }
        }
        continue;
      }
      if (stmt.kind === "IfStmt") {
        const cond = exprToSmtWithEnv(stmt.cond, localEnv);
        const thenEnv = new Map(localEnv);
        walkCapture(stmt.thenBody, 0, [...pathConds, cond], thenEnv);
        const elseEnv = new Map(localEnv);
        const negCond = `(not ${cond})`;
        if (stmt.elseBody && stmt.elseBody.length > 0) {
          walkCapture(stmt.elseBody, 0, [...pathConds, negCond], elseEnv);
        } else if (branchAlwaysReturns(stmt.thenBody)) {
          walkCapture(stmts, i + 1, [...pathConds, negCond], elseEnv);
        } else {
          walkCapture(stmts, i + 1, [...pathConds, negCond], elseEnv);
        }
        return;
      }
      // skip unhandled statements (while, for, etc.)
    }
    // reached end of body without return → void path
    finalEnvs.push({ conditions: [...pathConds], env: new Map(localEnv) });
  }

  walkCapture(stmts, 0, [], new Map(env));
  return { paths, finalEnvs, calls };
}

function branchAlwaysReturns(stmts: Stmt[]): boolean {
  if (stmts.length === 0) return false;
  const last = stmts[stmts.length - 1];
  if (last.kind === "Return") return true;
  if (last.kind === "IfStmt") {
    if (!last.elseBody || last.elseBody.length === 0) return false;
    return branchAlwaysReturns(last.thenBody) && branchAlwaysReturns(last.elseBody);
  }
  return false;
}

function collectFieldRefs(expr: Expr, refs: Set<string>): void {
  if (!expr) return;
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

function flattenFieldAccess(expr: Expr): string | null {
  if (expr.kind === "Ident") return expr.name;
  if (expr.kind === "FieldAccess") {
    const obj = flattenFieldAccess(expr.object);
    if (obj) return `${obj}_${expr.field}`;
  }
  return null;
}

function exprToSmtWithEnv(expr: Expr, env: Map<string, string>): string {
  if (!expr) return "0";
  if (expr.kind === "Ident") {
    const mapped = env.get(expr.name);
    if (mapped) return mapped;
    if (expr.name === "result") return "result";
    return GLOBAL_CONST_SMT.get(expr.name) ?? expr.name;
  }
  if (expr.kind === "FieldAccess") {
    const flat = flattenFieldAccess(expr);
    if (flat) {
      const mapped = env.get(flat);
      if (mapped) return mapped;
      return flat;
    }
  }
  if (expr.kind === "BinOp") {
    const left = exprToSmtWithEnv(expr.left, env);
    const bit = bitOpToSmt(expr.op, left, expr.right);
    if (bit) return bit;
    const right = exprToSmtWithEnv(expr.right, env);
    return `(${binOpToSmt(expr.op)} ${left} ${right})`;
  }
  if (expr.kind === "CastExpr") {
    return castToSmt(exprToSmtWithEnv(expr.operand, env), expr.targetType?.name ?? "i64");
  }
  if (expr.kind === "UnaryOp") {
    if (expr.op === "!") return `(not ${exprToSmtWithEnv(expr.operand, env)})`;
    if (expr.op === "-") return `(- ${exprToSmtWithEnv(expr.operand, env)})`;
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

  // Callee preconditions, for the call-site obligations below.
  const requiresByFn = new Map<string, Function>();
  for (const fn of program.functions) {
    if (fn.contracts.some(c => c.kind === "requires")) requiresByFn.set(fn.name, fn);
  }

  for (const fn of program.functions) {
    if (opts?.onlyFile && fn.sourceFile && fn.sourceFile !== opts.onlyFile) continue;
    // A fn with no contracts of its own still has to honour the ones it calls.
    const callsContracted = callsAContractedFn(fn.body, requiresByFn);
    if (fn.contracts.length === 0 && !hasLoopInvariants(fn.body) && !callsContracted) continue;

    const requires = fn.contracts.filter(c => c.kind === "requires");
    const ensures = fn.contracts.filter(c => c.kind === "ensures");
    contractCount += fn.contracts.length;

    const paramDecls = fn.params.map(p => `(declare-const ${p.name} ${miloTypeToSmt(p.type?.name ?? "i64")})`).join("\n");
    // What the type already guarantees. Without it the solver invents out-of-range inputs.
    const paramRanges = fn.params
      .map(p => intRangeAssumption(p.name, p.type?.name))
      .filter(Boolean).join("\n");

    // collect all field access references used in contracts and body, declare as SMT constants
    const fieldRefs = new Set<string>();
    for (const c of fn.contracts) collectFieldRefs(c.expr, fieldRefs);
    collectFieldRefsFromBody(fn.body, fieldRefs);
    const fieldDecls = [...fieldRefs].map(f => `(declare-const ${f} Int)`).join("\n");
    let allDecls = fieldDecls ? `${paramDecls}\n${fieldDecls}` : paramDecls;
    if (paramRanges) allDecls = `${allDecls}\n${paramRanges}`;

    const preAssumptions = requires.map(r => `(assert ${exprToSmt(r.expr)})`).join("\n");

    // Call-site obligations: the prover proves a callee's `ensures` GIVEN its `requires`,
    // and nothing proved the caller actually delivers that `requires`. Statically it was
    // an assumption. (Debug builds do assert it at entry — language-reference.md:267 —
    // so this closes the *static* half, not an unchecked hole.)
    {
      const paramEnv = new Map<string, string>();
      for (const p of fn.params) paramEnv.set(p.name, p.name);
      const { calls } = collectPaths(fn.body, paramEnv);
      for (const call of calls) {
        const callee = requiresByFn.get(call.name);
        if (!callee || callee.name === fn.name) continue;   // self-recursion: needs induction, skip
        if (call.args.length !== callee.params.length) continue;  // variadic/defaulted: can't map args to params
        // Substitute the callee's params with the caller's arg expressions.
        const subst = new Map<string, string>();
        callee.params.forEach((p, idx) => subst.set(p.name, call.args[idx]!));
        for (const req of callee.contracts.filter(c => c.kind === "requires")) {
          const obligation = exprToSmtWithEnv(req.expr, subst);
          if (/UNSUPPORTED/.test(obligation)) continue;   // untranslatable: say nothing rather than something wrong
          const guard = call.conditions.length > 0 ? `(assert (and ${call.conditions.join(" ")}))` : "";
          conditions.push({
            fn: fn.name,
            kind: "precondition",
            description: `call to ${callee.name} from ${fn.name}: ${obligation}`,
            smtlib: [
              `; Call-site precondition proof: ${fn.name} -> ${callee.name}`,
              `(set-logic ALL)`,
              allDecls,
              preAssumptions,
              guard,
              `(assert (not ${obligation}))`,
              `(check-sat)`,
            ].filter(Boolean).join("\n"),
          });
        }
      }
    }

    // Postconditions: symbolically execute body to build path constraints
    if (ensures.length > 0) {
      const paramEnv = new Map<string, string>();
      for (const p of fn.params) paramEnv.set(p.name, p.name);
      const symResult = collectPaths(fn.body, paramEnv);
      const isVoid = fn.retType.name === "void";

      for (const ens of ensures) {
        const postSmt = exprToSmt(ens.expr);

        if (!isVoid && symResult.paths.length > 0) {
          // returning function: bind result to return value on each path
          const pathAssertions = symResult.paths.map(path => {
            const pathCond = path.conditions.length > 0
              ? (path.conditions.length === 1 ? path.conditions[0] : `(and ${path.conditions.join(" ")})`)
              : "true";
            return `(and ${pathCond} (= result ${path.result}))`;
          });
          const allPaths = pathAssertions.length === 1
            ? pathAssertions[0]
            : `(or ${pathAssertions.join(" ")})`;

          conditions.push({
            fn: fn.name,
            kind: "postcondition",
            description: `postcondition of ${fn.name}: ${postSmt}`,
            smtlib: [
              `; Postcondition proof for ${fn.name}`,
              `(set-logic ALL)`,
              allDecls,
              `(declare-const result ${miloTypeToSmt(fn.retType.name)})`,
              preAssumptions,
              `(assert ${allPaths})`,
              `(assert (not ${postSmt}))`,
              `(check-sat)`,
            ].join("\n"),
          });
        } else if (isVoid && symResult.finalEnvs.length > 0) {
          // void function: postcondition references struct fields — use final env to bind them
          const pathAssertions = symResult.finalEnvs.map(fe => {
            const bindings: string[] = [];
            for (const [k, v] of fe.env) {
              if (k.includes("_")) bindings.push(`(= ${k} ${v})`);
            }
            const pathCond = fe.conditions.length > 0
              ? (fe.conditions.length === 1 ? fe.conditions[0] : `(and ${fe.conditions.join(" ")})`)
              : "true";
            if (bindings.length > 0) {
              return `(and ${pathCond} ${bindings.join(" ")})`;
            }
            return pathCond;
          });
          const allPaths = pathAssertions.length === 1
            ? pathAssertions[0]
            : `(or ${pathAssertions.join(" ")})`;

          conditions.push({
            fn: fn.name,
            kind: "postcondition",
            description: `postcondition of ${fn.name}: ${postSmt}`,
            smtlib: [
              `; Postcondition proof for ${fn.name} (void, struct state)`,
              `(set-logic ALL)`,
              allDecls,
              preAssumptions,
              `(assert ${allPaths})`,
              `(assert (not ${postSmt}))`,
              `(check-sat)`,
            ].join("\n"),
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
              `(declare-const result ${miloTypeToSmt(fn.retType.name)})`,
              preAssumptions,
              `(assert (not ${postSmt}))`,
              `(check-sat)`,
            ].join("\n"),
          });
        }
      }
    }

    loopCount += collectLoopInvariants(fn.name, fn.body, conditions);
  }

  return {
    conditions,
    stats: {
      functions: program.functions.filter(f => f.contracts.length > 0 || hasLoopInvariants(f.body)).length,
      contracts: contractCount,
      loops: loopCount,
    },
  };
}

function collectLoopInvariants(fnName: string, stmts: Stmt[], conditions: VerificationCondition[]): number {
  let count = 0;
  for (const stmt of stmts) {
    if (stmt.kind === "WhileStmt") {
      for (const inv of stmt.invariants ?? []) {
        const smt = exprToSmt(inv.expr);
        conditions.push({
          fn: fnName,
          kind: "loop-invariant",
          description: `loop invariant in ${fnName}: ${smt}`,
          smtlib: [
            `; Loop invariant check in ${fnName}`,
            `(set-logic ALL)`,
            `(assert (not ${smt}))`,
            `(check-sat)`,
          ].join("\n"),
        });
        count++;
      }
      count += collectLoopInvariants(fnName, stmt.body, conditions);
    } else if (stmt.kind === "IfStmt") {
      count += collectLoopInvariants(fnName, stmt.thenBody, conditions);
      if (stmt.elseBody) count += collectLoopInvariants(fnName, stmt.elseBody, conditions);
    }
  }
  return count;
}

function hasLoopInvariants(stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmt.kind === "WhileStmt" && stmt.invariants && stmt.invariants.length > 0) return true;
    if (stmt.kind === "WhileStmt") { if (hasLoopInvariants(stmt.body)) return true; }
    if (stmt.kind === "IfStmt") {
      if (hasLoopInvariants(stmt.thenBody)) return true;
      if (stmt.elseBody && hasLoopInvariants(stmt.elseBody)) return true;
    }
  }
  return false;
}

function exprToSmt(expr: Expr): string {
  switch (expr.kind) {
    case "IntLit": return expr.value.toString();
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
      const op = binOpToSmt(expr.op);
      return `(${op} ${left} ${right})`;
    }
    case "UnaryOp":
      if (expr.op === "!") return `(not ${exprToSmt(expr.operand)})`;
      if (expr.op === "-") return `(- ${exprToSmt(expr.operand)})`;
      return `(UNSUPPORTED_UNARY ${expr.op})`;
    case "Call":
      return `(${expr.func} ${expr.args.map(exprToSmt).join(" ")})`;
    case "FieldAccess": {
      const flat = flattenFieldAccess(expr);
      if (flat) return flat;
      return `(${exprToSmt(expr.object)}.${expr.field})`;
    }
    case "MethodCall":
      return `(${expr.method} ${exprToSmt(expr.object)} ${expr.args.map(exprToSmt).join(" ")})`;
    default:
      return `(UNSUPPORTED ${expr.kind})`;
  }
}

function binOpToSmt(op: string): string {
  switch (op) {
    case "+": return "+";
    case "-": return "-";
    case "*": return "*";
    case "/": return "div";
    case "%": return "mod";
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
// i64/u64 are deliberately absent. Their bounds (±2^63, 2^64-1) make the native std/smt
// solver return unsat for a plainly satisfiable formula — a FALSE PROOF, verified against
// z3, which says sat:
//   (declare-const x Int)
//   (assert (and (>= x (- 9223372036854775808)) (<= x 9223372036854775807)))
//   (assert (not (>= x 0)))     ; x = -1 satisfies this
// Asserting a range that is true but unusable would trade a false alarm for a false
// proof, which is the worse of the two by a distance. The narrow types carry the weight
// anyway — they are what the solver cannot otherwise know. See backlog: std/smt overflows
// on 64-bit literals.
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
  return [...out];
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

    const output = (proc.stdout ?? "").trim();
    if (output === "unsat") {
      // negation is unsat → contract always holds
      results.push({ vc, status: "proven" });
    } else if (output === "sat") {
      // negation is sat → contract can be violated
      results.push({ vc, status: "failed", detail: "counterexample exists" });
    } else if (output === "unknown") {
      results.push({ vc, status: "unknown", detail: "solver could not decide" });
    } else {
      results.push({ vc, status: "error", detail: output || proc.stderr || "z3 produced no output" });
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

export function formatProveReport(pr: ProveResult): string {
  const lines: string[] = [];
  lines.push(`verification: ${pr.results.length} conditions`);
  lines.push(`  proven: ${pr.proven}  failed: ${pr.failed}  unknown: ${pr.unknown}  errors: ${pr.errors}`);
  lines.push("");

  for (const r of pr.results) {
    const icon = r.status === "proven" ? "✓" : r.status === "failed" ? "✗" : "?";
    lines.push(`  ${icon} [${r.vc.kind}] ${r.vc.fn}: ${r.status}${r.detail ? ` — ${r.detail}` : ""}`);
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
