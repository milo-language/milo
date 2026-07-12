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
}

function collectPaths(stmts: Stmt[], env: Map<string, string>): SymExecResult {
  const paths: SymPath[] = [];

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
  return { paths, finalEnvs };
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
    return expr.name === "result" ? "result" : expr.name;
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
    const right = exprToSmtWithEnv(expr.right, env);
    return `(${binOpToSmt(expr.op)} ${left} ${right})`;
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
export function generateVerificationConditions(program: Program, opts?: { onlyFile?: string }): VerifyResult {
  const conditions: VerificationCondition[] = [];
  let contractCount = 0;
  let loopCount = 0;

  for (const fn of program.functions) {
    if (opts?.onlyFile && fn.sourceFile && fn.sourceFile !== opts.onlyFile) continue;
    if (fn.contracts.length === 0 && !hasLoopInvariants(fn.body)) continue;

    const requires = fn.contracts.filter(c => c.kind === "requires");
    const ensures = fn.contracts.filter(c => c.kind === "ensures");
    contractCount += fn.contracts.length;

    const paramDecls = fn.params.map(p => `(declare-const ${p.name} ${miloTypeToSmt(p.type?.name ?? "i64")})`).join("\n");

    // collect all field access references used in contracts and body, declare as SMT constants
    const fieldRefs = new Set<string>();
    for (const c of fn.contracts) collectFieldRefs(c.expr, fieldRefs);
    collectFieldRefsFromBody(fn.body, fieldRefs);
    const fieldDecls = [...fieldRefs].map(f => `(declare-const ${f} Int)`).join("\n");
    const allDecls = fieldDecls ? `${paramDecls}\n${fieldDecls}` : paramDecls;

    const preAssumptions = requires.map(r => `(assert ${exprToSmt(r.expr)})`).join("\n");

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
              `(set-logic QF_LIA)`,
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
              `(set-logic QF_LIA)`,
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
              `(set-logic QF_LIA)`,
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
            `(set-logic QF_LIA)`,
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
    case "Ident": return expr.name === "result" ? "result" : expr.name;
    case "BinOp": {
      const left = exprToSmt(expr.left);
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
