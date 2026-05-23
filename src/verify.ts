// Verification condition generator — produces SMT-LIB2 from contract annotations
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

export function generateVerificationConditions(program: Program): VerifyResult {
  const conditions: VerificationCondition[] = [];
  let contractCount = 0;
  let loopCount = 0;

  for (const fn of program.functions) {
    if (fn.contracts.length === 0 && !hasLoopInvariants(fn.body)) continue;

    const requires = fn.contracts.filter(c => c.kind === "requires");
    const ensures = fn.contracts.filter(c => c.kind === "ensures");
    contractCount += fn.contracts.length;

    const paramDecls = fn.params.map(p => `(declare-const ${p.name} ${miloTypeToSmt(p.type?.name ?? "i64")})`).join("\n");

    for (const req of requires) {
      const smt = exprToSmt(req.expr);
      conditions.push({
        fn: fn.name,
        kind: "precondition",
        description: `precondition of ${fn.name}: ${smt}`,
        smtlib: [
          `; Precondition check for ${fn.name}`,
          `(set-logic QF_LIA)`,
          paramDecls,
          `(assert (not ${smt}))`,
          `(check-sat)`,
          `; sat = precondition can be violated, unsat = always holds`,
        ].join("\n"),
      });
    }

    for (const ens of ensures) {
      const smt = exprToSmt(ens.expr);
      const preAssumptions = requires.map(r => `(assert ${exprToSmt(r.expr)})`).join("\n");
      conditions.push({
        fn: fn.name,
        kind: "postcondition",
        description: `postcondition of ${fn.name}: ${smt}`,
        smtlib: [
          `; Postcondition check for ${fn.name}`,
          `(set-logic QF_LIA)`,
          paramDecls,
          `(declare-const result ${miloTypeToSmt(fn.retType.name)})`,
          preAssumptions,
          `(assert (not ${smt}))`,
          `(check-sat)`,
          `; sat = postcondition can be violated, unsat = always holds`,
        ].join("\n"),
      });
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
    case "FieldAccess":
      return `(${exprToSmt(expr.object)}.${expr.field})`;
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
