// Compiler-enforced safety profiles for domain-specific certification standards
import type { Program, Function, Stmt } from "./ast";
import type { Span } from "./ast";

export type SafetyLevel =
  | "do178c-a"    // DAL A — catastrophic failure condition (fly-by-wire, flight control)
  | "do178c-b"    // DAL B — hazardous (autopilot, TCAS)
  | "do178c-c"    // DAL C — major (FMS, weather radar)
  | "iso26262-a"  // ASIL A — automotive lowest
  | "iso26262-b"  // ASIL B
  | "iso26262-c"  // ASIL C
  | "iso26262-d"  // ASIL D — autonomous driving, braking
  | "nasa-a"      // NASA Class A — loss of life/vehicle (crewed spacecraft)
  | "nasa-b"      // NASA Class B — high-cost robotic missions
  | "iec61508-4"  // SIL 4 — nuclear, rail signaling
  | "iec61508-3"  // SIL 3
  | "iec62304-a"  // IEC 62304 Class A — no injury (medical device SW)
  | "iec62304-b"  // IEC 62304 Class B — non-serious injury
  | "iec62304-c"  // IEC 62304 Class C — death or serious injury (pacemakers, infusion pumps)
  ;

interface SafetyConstraints {
  noRecursion: boolean;
  requireBoundedLoops: boolean;       // all loops must have invariant or compile-time-bounded iteration
  noDynamicAllocation: boolean;       // no heap after init
  requireContracts: boolean;          // all public functions must have requires/ensures
  noFloatingPoint: boolean;           // integer-only arithmetic
  maxFunctionComplexity: number | null; // cyclomatic complexity bound
  maxCallDepth: number | null;        // static call graph depth limit
  noUnsafe: boolean;
  noRecursiveTypes: boolean;          // no recursive struct/enum definitions
  requireFullMatchCoverage: boolean;
}

const PROFILES: Record<SafetyLevel, SafetyConstraints> = {
  // DO-178C — avionics
  "do178c-a": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 20,
    maxCallDepth: 30,
    noUnsafe: true,
    noRecursiveTypes: true,
    requireFullMatchCoverage: true,
  },
  "do178c-b": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 30,
    maxCallDepth: 50,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },
  "do178c-c": {
    noRecursion: true,
    requireBoundedLoops: false,
    noDynamicAllocation: false,
    requireContracts: false,
    noFloatingPoint: false,
    maxFunctionComplexity: 50,
    maxCallDepth: null,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },

  // ISO 26262 — automotive
  "iso26262-a": {
    noRecursion: false,
    requireBoundedLoops: false,
    noDynamicAllocation: false,
    requireContracts: false,
    noFloatingPoint: false,
    maxFunctionComplexity: null,
    maxCallDepth: null,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },
  "iso26262-b": {
    noRecursion: false,
    requireBoundedLoops: false,
    noDynamicAllocation: false,
    requireContracts: false,
    noFloatingPoint: false,
    maxFunctionComplexity: 50,
    maxCallDepth: null,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },
  "iso26262-c": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: false,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 30,
    maxCallDepth: 50,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },
  "iso26262-d": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 20,
    maxCallDepth: 30,
    noUnsafe: true,
    noRecursiveTypes: true,
    requireFullMatchCoverage: true,
  },

  // NASA software classification
  "nasa-a": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 25,
    maxCallDepth: 30,
    noUnsafe: true,
    noRecursiveTypes: true,
    requireFullMatchCoverage: true,
  },
  "nasa-b": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: false,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 40,
    maxCallDepth: 50,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },

  // IEC 61508 — industrial/nuclear/rail
  "iec61508-4": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: true,
    maxFunctionComplexity: 15,
    maxCallDepth: 20,
    noUnsafe: true,
    noRecursiveTypes: true,
    requireFullMatchCoverage: true,
  },
  "iec61508-3": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 25,
    maxCallDepth: 30,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },

  // IEC 62304 — medical device software
  "iec62304-a": {
    noRecursion: false,
    requireBoundedLoops: false,
    noDynamicAllocation: false,
    requireContracts: false,
    noFloatingPoint: false,
    maxFunctionComplexity: null,
    maxCallDepth: null,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: false,
  },
  "iec62304-b": {
    noRecursion: false,
    requireBoundedLoops: false,
    noDynamicAllocation: false,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 40,
    maxCallDepth: null,
    noUnsafe: true,
    noRecursiveTypes: false,
    requireFullMatchCoverage: true,
  },
  "iec62304-c": {
    noRecursion: true,
    requireBoundedLoops: true,
    noDynamicAllocation: true,
    requireContracts: true,
    noFloatingPoint: false,
    maxFunctionComplexity: 20,
    maxCallDepth: 30,
    noUnsafe: true,
    noRecursiveTypes: true,
    requireFullMatchCoverage: true,
  },
};

export interface SafetyViolation {
  rule: string;
  message: string;
  span?: Span;
  severity: "error" | "warning";
}

export function parseSafetyLevel(s: string): SafetyLevel | null {
  return s in PROFILES ? s as SafetyLevel : null;
}

export function getSafetyConstraints(level: SafetyLevel): SafetyConstraints {
  return PROFILES[level];
}

export function checkSafetyCompliance(program: Program, level: SafetyLevel): SafetyViolation[] {
  const constraints = PROFILES[level];
  const violations: SafetyViolation[] = [];

  const userFns = program.userFnNames;
  for (const fn of program.functions) {
    if (fn.isExtern) continue;
    if (userFns && !userFns.has(fn.name)) continue;

    if (constraints.requireContracts && fn.contracts.length === 0 && fn.name !== "main") {
      violations.push({
        rule: "require-contracts",
        message: `[${level}] function '${fn.name}' must have requires/ensures contracts`,
        severity: "error",
      });
    }

    if (constraints.noRecursion) {
      if (bodyCallsSelf(fn.name, fn.body)) {
        violations.push({
          rule: "no-recursion",
          message: `[${level}] function '${fn.name}' contains recursion (banned at this safety level)`,
          severity: "error",
        });
      }
    }

    if (constraints.requireBoundedLoops) {
      checkUnboundedLoops(fn.name, fn.body, violations, level);
    }

    if (constraints.noDynamicAllocation) {
      checkDynamicAllocation(fn.name, fn.body, violations, level);
    }

    if (constraints.noUnsafe) {
      checkUnsafeBlocks(fn.name, fn.body, violations, level);
    }

    if (constraints.maxFunctionComplexity !== null) {
      const complexity = computeCyclomaticComplexity(fn.body);
      if (complexity > constraints.maxFunctionComplexity) {
        violations.push({
          rule: "max-complexity",
          message: `[${level}] function '${fn.name}' has cyclomatic complexity ${complexity} (max ${constraints.maxFunctionComplexity})`,
          severity: "error",
        });
      }
    }
  }

  return violations;
}

function bodyCallsSelf(fnName: string, stmts: Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmtCallsSelf(fnName, stmt)) return true;
  }
  return false;
}

function stmtCallsSelf(fnName: string, stmt: Stmt): boolean {
  switch (stmt.kind) {
    case "ExprStmt":
      return exprCallsSelf(fnName, stmt.expr);
    case "LetDecl":
    case "VarDecl":
      return exprCallsSelf(fnName, stmt.value);
    case "Assign":
      return exprCallsSelf(fnName, stmt.value) || exprCallsSelf(fnName, stmt.target);
    case "Return":
      return stmt.value ? exprCallsSelf(fnName, stmt.value) : false;
    case "IfStmt":
      return exprCallsSelf(fnName, stmt.cond)
        || bodyCallsSelf(fnName, stmt.thenBody)
        || (stmt.elseBody ? bodyCallsSelf(fnName, stmt.elseBody) : false);
    case "WhileStmt":
      return exprCallsSelf(fnName, stmt.cond) || bodyCallsSelf(fnName, stmt.body);
    case "ForInStmt":
      return exprCallsSelf(fnName, stmt.iterable) || bodyCallsSelf(fnName, stmt.body);
    case "MatchStmt":
      return exprCallsSelf(fnName, stmt.subject) || stmt.arms.some(a => bodyCallsSelf(fnName, a.body));
    default:
      return false;
  }
}

function exprCallsSelf(fnName: string, expr: import("./ast").Expr): boolean {
  switch (expr.kind) {
    case "Call": return expr.func === fnName || expr.args.some(a => exprCallsSelf(fnName, a));
    case "BinOp": return exprCallsSelf(fnName, expr.left) || exprCallsSelf(fnName, expr.right);
    case "UnaryOp": return exprCallsSelf(fnName, expr.operand);
    case "MethodCall": return exprCallsSelf(fnName, expr.object) || expr.args.some(a => exprCallsSelf(fnName, a));
    case "FieldAccess": return exprCallsSelf(fnName, expr.object);
    case "IndexAccess": return exprCallsSelf(fnName, expr.object) || exprCallsSelf(fnName, expr.index);
    default: return false;
  }
}

function checkUnboundedLoops(fnName: string, stmts: Stmt[], violations: SafetyViolation[], level: SafetyLevel) {
  for (const stmt of stmts) {
    if (stmt.kind === "WhileStmt") {
      if (!stmt.invariants || stmt.invariants.length === 0) {
        violations.push({
          rule: "bounded-loops",
          message: `[${level}] while loop in '${fnName}' must have an invariant clause for bounded execution`,
          span: stmt.span,
          severity: "error",
        });
      }
      checkUnboundedLoops(fnName, stmt.body, violations, level);
    }
    if (stmt.kind === "IfStmt") {
      checkUnboundedLoops(fnName, stmt.thenBody, violations, level);
      if (stmt.elseBody) checkUnboundedLoops(fnName, stmt.elseBody, violations, level);
    }
  }
}

function checkDynamicAllocation(fnName: string, stmts: Stmt[], violations: SafetyViolation[], level: SafetyLevel) {
  for (const stmt of stmts) {
    if (stmt.kind === "ExprStmt" || stmt.kind === "LetDecl" || stmt.kind === "VarDecl") {
      const expr = stmt.kind === "ExprStmt" ? stmt.expr : stmt.value;
      if (exprHasAllocation(expr)) {
        violations.push({
          rule: "no-dynamic-alloc",
          message: `[${level}] dynamic allocation in '${fnName}' is banned at this safety level`,
          span: stmt.span,
          severity: "error",
        });
      }
    }
    if (stmt.kind === "IfStmt") {
      checkDynamicAllocation(fnName, stmt.thenBody, violations, level);
      if (stmt.elseBody) checkDynamicAllocation(fnName, stmt.elseBody, violations, level);
    }
    if (stmt.kind === "WhileStmt") checkDynamicAllocation(fnName, stmt.body, violations, level);
  }
}

function exprHasAllocation(expr: import("./ast").Expr): boolean {
  switch (expr.kind) {
    case "Call":
      return ["Vec", "String", "HashMap", "BTreeMap", "Box", "alloc"].includes(expr.func)
        || expr.args.some(exprHasAllocation);
    case "MethodCall":
      return ["push", "append", "insert", "extend"].includes(expr.method)
        || exprHasAllocation(expr.object) || expr.args.some(exprHasAllocation);
    default: return false;
  }
}

function checkUnsafeBlocks(fnName: string, stmts: Stmt[], violations: SafetyViolation[], level: SafetyLevel) {
  for (const stmt of stmts) {
    if (stmt.kind === "UnsafeBlock") {
      violations.push({
        rule: "no-unsafe",
        message: `[${level}] unsafe block in '${fnName}' is banned at this safety level`,
        span: stmt.span,
        severity: "error",
      });
    }
    if (stmt.kind === "IfStmt") {
      checkUnsafeBlocks(fnName, stmt.thenBody, violations, level);
      if (stmt.elseBody) checkUnsafeBlocks(fnName, stmt.elseBody, violations, level);
    }
    if (stmt.kind === "WhileStmt") checkUnsafeBlocks(fnName, stmt.body, violations, level);
  }
}

function computeCyclomaticComplexity(stmts: Stmt[]): number {
  let complexity = 1;
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "IfStmt":
        complexity += 1;
        complexity += computeCyclomaticComplexity(stmt.thenBody) - 1;
        if (stmt.elseBody) complexity += computeCyclomaticComplexity(stmt.elseBody) - 1;
        break;
      case "WhileStmt":
      case "ForInStmt":
        complexity += 1;
        complexity += computeCyclomaticComplexity(stmt.body) - 1;
        break;
      case "MatchStmt":
        complexity += stmt.arms.length - 1;
        for (const arm of stmt.arms) complexity += computeCyclomaticComplexity(arm.body) - 1;
        break;
    }
  }
  return complexity;
}

export function formatSafetyReport(violations: SafetyViolation[], level: SafetyLevel): string {
  if (violations.length === 0) {
    return `safety check passed: ${level} — all constraints satisfied`;
  }

  const lines: string[] = [];
  lines.push(`safety check failed: ${level} — ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const loc = v.span ? `:${v.span.line}:${v.span.col}` : "";
    lines.push(`  ${v.severity}: ${v.message}${loc}`);
  }
  return lines.join("\n");
}

export function listSafetyLevels(): string {
  const lines = [
    "available safety profiles:\n",
    "  avionics (DO-178C):",
    "    do178c-a    DAL A — catastrophic (fly-by-wire, primary flight control)",
    "    do178c-b    DAL B — hazardous (autopilot, TCAS)",
    "    do178c-c    DAL C — major (FMS, weather radar)\n",
    "  automotive (ISO 26262):",
    "    iso26262-a  ASIL A — lowest automotive",
    "    iso26262-b  ASIL B",
    "    iso26262-c  ASIL C",
    "    iso26262-d  ASIL D — autonomous driving, braking\n",
    "  spacecraft (NASA):",
    "    nasa-a      Class A — crewed, loss of life/vehicle",
    "    nasa-b      Class B — high-cost robotic missions\n",
    "  industrial (IEC 61508):",
    "    iec61508-3  SIL 3 — industrial control",
    "    iec61508-4  SIL 4 — nuclear, rail signaling\n",
    "  medical devices (IEC 62304):",
    "    iec62304-a  Class A — no injury",
    "    iec62304-b  Class B — non-serious injury",
    "    iec62304-c  Class C — death or serious injury (pacemakers, infusion pumps)",
  ];
  return lines.join("\n");
}
