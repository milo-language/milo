// Compiler-enforced safety profiles for domain-specific certification standards
import type { Program, Function, Stmt, Expr, MiloType } from "./ast";
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
  noDynamicAllocation: boolean;       // no heap allocation anywhere, including init (certifiable systems preallocate statically)
  requireContracts: boolean;          // all public functions must have requires/ensures
  noFloatingPoint: boolean;           // integer-only arithmetic
  maxFunctionComplexity: number | null; // cyclomatic complexity bound
  maxCallDepth: number | null;        // static call graph depth limit
  noUnsafe: boolean;
  noRecursiveTypes: boolean;          // no recursive struct/enum definitions
  requireFullMatchCoverage: boolean;
  noForeignCalls?: boolean;           // no calls to extern/FFI functions (unverified external code)
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
    noForeignCalls: true,
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
    noForeignCalls: true,
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
    noForeignCalls: true,
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
    noForeignCalls: true,
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
    noForeignCalls: true,
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
    noForeignCalls: true,
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
    noForeignCalls: true,
  },
};

export interface SafetyViolation {
  rule: string;
  message: string;
  span?: Span;
  severity: "error" | "warning";
}

const ALIASES: Record<string, SafetyLevel> = {
  "do178": "do178c-b",
};

export function parseSafetyLevel(s: string): SafetyLevel | null {
  if (s in PROFILES) return s as SafetyLevel;
  if (s in ALIASES) return ALIASES[s];
  return null;
}

export function getSafetyConstraints(level: SafetyLevel): SafetyConstraints {
  return PROFILES[level];
}

export function checkSafetyCompliance(program: Program, level: SafetyLevel): SafetyViolation[] {
  const constraints = PROFILES[level];
  const violations: SafetyViolation[] = [];

  const userFns = program.userFnNames;
  const userImplKeys = program.userImplKeys;

  // Body-local checks, run on free functions AND user impl methods (methods were
  // previously skipped entirely — a recursive/unsafe/allocating method passed).
  const perFn = (fn: Function, label: string, isMethod: boolean) => {
    if (constraints.requireContracts && fn.contracts.length === 0 && fn.name !== "main") {
      violations.push({ rule: "require-contracts", message: `[${level}] function '${label}' must have requires/ensures contracts`, severity: "error" });
    }
    if (constraints.requireBoundedLoops) checkUnboundedLoops(label, fn.body, violations, level);
    if (constraints.noDynamicAllocation) checkDynamicAllocation(label, fn.body, violations, level);
    if (constraints.noUnsafe) checkUnsafeBlocks(label, fn.body, violations, level);
    if (constraints.maxFunctionComplexity !== null) {
      const complexity = computeCyclomaticComplexity(fn.body);
      if (complexity > constraints.maxFunctionComplexity) {
        violations.push({ rule: "max-complexity", message: `[${level}] function '${label}' has cyclomatic complexity ${complexity} (max ${constraints.maxFunctionComplexity})`, severity: "error" });
      }
    }
    if (constraints.noFloatingPoint) checkNoFloat(fn, violations, level);
    // The whole-program cycle DFS only covers free functions (resolving a method
    // call to a specific method needs types we don't have here), so detect a
    // method that recurses on itself (`self.m(...)`) directly.
    if (constraints.noRecursion && isMethod && methodSelfRecurses(fn)) {
      violations.push({ rule: "no-recursion", message: `[${level}] method '${label}' is recursive (banned at this safety level)`, severity: "error" });
    }
  };

  for (const fn of program.functions) {
    if (fn.isExtern) continue;
    if (userFns && !userFns.has(fn.name)) continue;
    perFn(fn, fn.name, false);
  }
  for (const impl of program.impls) {
    for (const m of impl.methods) {
      if (m.isExtern) continue;
      const key = `${impl.typeName}.${m.name}`;
      if (userImplKeys && !userImplKeys.has(key)) continue;
      perFn(m, key, true);
    }
  }

  // Whole-program checks (need cross-function / cross-type visibility).
  if (constraints.noForeignCalls) {
    checkForeignCalls(program, violations, level);
  }

  if (constraints.noRecursion) {
    checkRecursionCycles(program, violations, level);
  }

  if (constraints.maxCallDepth !== null) {
    checkCallDepth(program, constraints.maxCallDepth, violations, level);
  }

  if (constraints.noRecursiveTypes) {
    checkRecursiveTypes(program, violations, level);
  }

  // Note: requireFullMatchCoverage is already enforced by the type checker's
  // exhaustiveness pass (non-exhaustive matches fail type-checking before we
  // ever reach the safety check), so no separate enforcement is needed here.

  return violations;
}

function checkUnboundedLoops(fnName: string, stmts: Stmt[], violations: SafetyViolation[], level: SafetyLevel) {
  // walkExprs reaches a `while` nested in any control structure (for/match/…),
  // not just if/while — an unbounded loop must not hide inside a for body.
  walkExprs(stmts, () => {}, (s) => {
    if (s.kind === "WhileStmt" && (!s.invariants || s.invariants.length === 0)) {
      violations.push({
        rule: "bounded-loops",
        message: `[${level}] while loop in '${fnName}' must have an invariant clause for bounded execution`,
        span: s.span,
        severity: "error",
      });
    }
  });
}

// A single expression node that allocates on the heap. Walk recursion is the
// caller's job (via walkExprs), so this only inspects one node.
function isAllocExpr(e: Expr): boolean {
  switch (e.kind) {
    case "EnumLit":
      // constructors: Vec.new, String.withCapacity, HashMap.new, BTreeMap.new
      return ["Vec", "String", "HashMap", "BTreeMap"].includes(e.enumName);
    case "Call":
      return ["Heap", "Box", "alloc", "malloc", "format"].includes(e.func);
    case "MethodCall":
      // growth / reallocation
      return ["push", "append", "insert", "extend"].includes(e.method);
    default:
      return false;
  }
}

function checkDynamicAllocation(fnName: string, stmts: Stmt[], violations: SafetyViolation[], level: SafetyLevel) {
  // walkExprs descends into every control structure (for/match/if-let/unsafe/…),
  // not just if/while — allocation hidden in a loop body must not slip through.
  walkExprs(stmts, (e) => {
    if (isAllocExpr(e)) {
      violations.push({
        rule: "no-dynamic-alloc",
        message: `[${level}] dynamic allocation in '${fnName}' is banned at this safety level`,
        span: (e as { span?: Span }).span,
        severity: "error",
      });
    }
  });
}

function checkUnsafeBlocks(fnName: string, stmts: Stmt[], violations: SafetyViolation[], level: SafetyLevel) {
  walkExprs(stmts, () => {}, (s) => {
    if (s.kind === "UnsafeBlock") {
      violations.push({
        rule: "no-unsafe",
        message: `[${level}] unsafe block in '${fnName}' is banned at this safety level`,
        span: s.span,
        severity: "error",
      });
    }
  });
}

// Each `&&`/`||` is a decision point in McCabe complexity (it short-circuits,
// creating a branch). Count them wherever they appear, not just in conditions.
function countShortCircuit(e: Expr | null | undefined): number {
  if (!e) return 0;
  switch (e.kind) {
    case "BinOp":
      return (e.op === "&&" || e.op === "||" ? 1 : 0) + countShortCircuit(e.left) + countShortCircuit(e.right);
    case "UnaryOp":
      return countShortCircuit(e.operand);
    case "Call":
      return e.args.reduce((n, a) => n + countShortCircuit(a), 0);
    case "MethodCall":
      return countShortCircuit(e.object) + e.args.reduce((n, a) => n + countShortCircuit(a), 0);
    case "FieldAccess":
      return countShortCircuit(e.object);
    case "IndexAccess":
      return countShortCircuit(e.object) + countShortCircuit(e.index);
    case "IfExpr":
      return countShortCircuit(e.cond);
    default:
      return 0;
  }
}

function computeCyclomaticComplexity(stmts: Stmt[]): number {
  let complexity = 1;
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "IfStmt":
        complexity += 1 + countShortCircuit(stmt.cond);
        complexity += computeCyclomaticComplexity(stmt.thenBody) - 1;
        if (stmt.elseBody) complexity += computeCyclomaticComplexity(stmt.elseBody) - 1;
        break;
      case "IfLetStmt":
        complexity += 1 + countShortCircuit(stmt.subject);
        complexity += computeCyclomaticComplexity(stmt.thenBody) - 1;
        if (stmt.elseBody) complexity += computeCyclomaticComplexity(stmt.elseBody) - 1;
        break;
      case "WhileStmt":
        complexity += 1 + countShortCircuit(stmt.cond);
        complexity += computeCyclomaticComplexity(stmt.body) - 1;
        break;
      case "ForInStmt":
        complexity += 1 + countShortCircuit(stmt.iterable);
        complexity += computeCyclomaticComplexity(stmt.body) - 1;
        break;
      case "MatchStmt":
        complexity += (stmt.arms.length - 1) + countShortCircuit(stmt.subject);
        for (const arm of stmt.arms) complexity += computeCyclomaticComplexity(arm.body) - 1;
        break;
      case "Return":
        complexity += countShortCircuit(stmt.value);
        break;
      case "LetDecl":
      case "VarDecl":
        complexity += countShortCircuit(stmt.value);
        break;
      case "Assign":
        complexity += countShortCircuit(stmt.value);
        break;
      case "ExprStmt":
        complexity += countShortCircuit(stmt.expr);
        break;
    }
  }
  return complexity;
}

// ── noFloatingPoint ──

const FLOAT_TYPE_NAMES = new Set(["f32", "f64", "float"]);

function typeIsFloat(t: MiloType | null | undefined): boolean {
  if (!t) return false;
  if (FLOAT_TYPE_NAMES.has(t.name)) return true;
  if (t.typeArgs?.some(typeIsFloat)) return true;
  if (t.fnRet && typeIsFloat(t.fnRet)) return true;
  if (t.fnParams?.some(typeIsFloat)) return true;
  return false;
}

function checkNoFloat(fn: Function, violations: SafetyViolation[], level: SafetyLevel) {
  const flag = (span?: Span) => violations.push({
    rule: "no-floating-point",
    message: `[${level}] function '${fn.name}' uses floating-point arithmetic (integer-only required at this safety level)`,
    span,
    severity: "error",
  });
  // Signature: parameter and return types.
  for (const p of fn.params) if (typeIsFloat(p.type)) { flag(); break; }
  if (typeIsFloat(fn.retType)) flag();
  // Body: float literals, float-typed locals, and casts to float.
  walkExprs(fn.body, (e) => {
    if (e.kind === "FloatLit") flag(e.span);
    else if (e.kind === "CastExpr" && typeIsFloat(e.targetType)) flag(e.span);
  }, (s) => {
    if ((s.kind === "LetDecl" || s.kind === "VarDecl") && typeIsFloat(s.type)) flag(s.span);
  });
}

// ── noForeignCalls ──
// At the most critical levels, a call into extern/FFI code is unverified
// external object code — exactly what certification wants surfaced and
// justified, not silent. Milo's permissive safe-extern rule (a matching-ptr,
// scalar-return extern call needs no `unsafe`) makes such calls invisible
// otherwise; this makes them loud.
function methodSelfRecurses(fn: Function): boolean {
  let found = false;
  walkExprs(fn.body, (e) => {
    if (e.kind === "MethodCall" && e.method === fn.name && e.object.kind === "Ident" && e.object.name === "self") found = true;
    else if (e.kind === "Call" && e.func === fn.name) found = true;
  });
  return found;
}

function checkForeignCalls(program: Program, violations: SafetyViolation[], level: SafetyLevel) {
  const externNames = new Set<string>();
  for (const fn of program.functions) if (fn.isExtern) externNames.add(fn.name);
  if (externNames.size === 0) return;
  const userFns = program.userFnNames;
  const userImplKeys = program.userImplKeys;
  const scan = (fn: Function, label: string) => {
    walkExprs(fn.body, (e) => {
      if (e.kind === "Call" && externNames.has(e.func)) {
        violations.push({
          rule: "no-foreign-calls",
          message: `[${level}] call to extern function '${e.func}' in '${label}' — unverified external code is banned at this safety level (justify it or wrap it behind a verified interface)`,
          span: (e as { span?: Span }).span,
          severity: "error",
        });
      }
    });
  };
  for (const fn of program.functions) {
    if (fn.isExtern || (userFns && !userFns.has(fn.name))) continue;
    scan(fn, fn.name);
  }
  for (const impl of program.impls) {
    for (const m of impl.methods) {
      const key = `${impl.typeName}.${m.name}`;
      if (m.isExtern || (userImplKeys && !userImplKeys.has(key))) continue;
      scan(m, key);
    }
  }
}

// ── noRecursion ──
// Catches ANY recursion in the user call graph — direct (f→f) and mutual
// (f→g→f, a→b→c→a). A back-edge to a function on the active DFS stack closes a
// cycle. Whole-program because mutual recursion is invisible per-function, and
// some profiles set noRecursion without a maxCallDepth bound (e.g. DO-178C C),
// so the call-depth pass can't be relied on to catch it.

function checkRecursionCycles(program: Program, violations: SafetyViolation[], level: SafetyLevel) {
  const userFns = program.userFnNames;
  const fnByName = new Map<string, Function>();
  for (const fn of program.functions) {
    if (fn.isExtern) continue;
    if (userFns && !userFns.has(fn.name)) continue;
    fnByName.set(fn.name, fn);
  }
  const callees = (fn: Function): string[] => {
    const out = new Set<string>();
    walkExprs(fn.body, (e) => { if (e.kind === "Call" && fnByName.has(e.func)) out.add(e.func); });
    return [...out];
  };

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const dfs = (name: string) => {
    color.set(name, GRAY);
    stack.push(name);
    for (const c of callees(fnByName.get(name)!)) {
      if (color.get(c) === GRAY) {
        const cycle = stack.slice(stack.indexOf(c)).concat(c);
        const key = [...new Set(cycle)].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          violations.push({
            rule: "no-recursion",
            message: `[${level}] recursion detected: ${cycle.join(" -> ")} (banned at this safety level)`,
            severity: "error",
          });
        }
      } else if ((color.get(c) ?? WHITE) === WHITE) {
        dfs(c);
      }
    }
    stack.pop();
    color.set(name, BLACK);
  };
  for (const name of fnByName.keys()) {
    if ((color.get(name) ?? WHITE) === WHITE) dfs(name);
  }
}

// ── maxCallDepth ──
// Recursion is banned at every level that sets maxCallDepth, so the user call
// graph is a DAG and longest-path is well-defined. We still guard against cycles
// (in case noRecursion is somehow disabled) by tracking the active DFS stack.

function checkCallDepth(program: Program, maxDepth: number, violations: SafetyViolation[], level: SafetyLevel) {
  const userFns = program.userFnNames;
  const fnByName = new Map<string, Function>();
  for (const fn of program.functions) {
    if (fn.isExtern) continue;
    if (userFns && !userFns.has(fn.name)) continue;
    fnByName.set(fn.name, fn);
  }

  const callees = (fn: Function): string[] => {
    const out = new Set<string>();
    walkExprs(fn.body, (e) => {
      if (e.kind === "Call" && fnByName.has(e.func)) out.add(e.func);
    });
    return [...out];
  };

  const memo = new Map<string, number>();
  const onStack = new Set<string>();
  const depth = (name: string): number => {
    if (memo.has(name)) return memo.get(name)!;
    if (onStack.has(name)) return Infinity; // cycle — treat as unbounded
    onStack.add(name);
    let max = 0;
    for (const c of callees(fnByName.get(name)!)) max = Math.max(max, depth(c));
    onStack.delete(name);
    const d = 1 + max;
    memo.set(name, d);
    return d;
  };

  let deepest = 0, deepestFn = "";
  for (const name of fnByName.keys()) {
    const d = depth(name);
    if (d > deepest) { deepest = d; deepestFn = name; }
  }
  if (deepest > maxDepth) {
    violations.push({
      rule: "max-call-depth",
      message: `[${level}] static call depth ${deepest === Infinity ? "(unbounded)" : deepest} starting at '${deepestFn}' exceeds max ${maxDepth}`,
      severity: "error",
    });
  }
}

// ── noRecursiveTypes ──
// Stricter than the checker's infinite-size rule: even Heap<Self>-style indirect
// recursion (which the checker permits) is banned, because a heap-linked list /
// tree has no compile-time bound on traversal depth — fatal for WCET.

function checkRecursiveTypes(program: Program, violations: SafetyViolation[], level: SafetyLevel) {
  const typeNames = new Set<string>([
    ...program.structs.map(s => s.name),
    ...program.enums.map(e => e.name),
  ]);

  // Referenced user-defined type names within a type, including through generic
  // args like Heap<T> / Vec<T> so indirect recursion is caught.
  const refs = (t: MiloType): string[] => {
    const out: string[] = [];
    if (typeNames.has(t.name)) out.push(t.name);
    for (const a of t.typeArgs ?? []) out.push(...refs(a));
    return out;
  };

  const edges = new Map<string, Set<string>>();
  for (const s of program.structs) {
    const set = new Set<string>();
    for (const f of s.fields) for (const r of refs(f.type)) set.add(r);
    edges.set(s.name, set);
  }
  for (const e of program.enums) {
    const set = new Set<string>();
    for (const v of e.variants) for (const ft of v.fields) for (const r of refs(ft)) set.add(r);
    edges.set(e.name, set);
  }

  const onStack = new Set<string>();
  const done = new Set<string>();
  const reported = new Set<string>();
  const dfs = (name: string) => {
    onStack.add(name);
    for (const next of edges.get(name) ?? []) {
      if (onStack.has(next)) {
        if (!reported.has(next)) {
          reported.add(next);
          violations.push({
            rule: "no-recursive-types",
            message: `[${level}] type '${next}' is recursive (banned at this safety level — recursive data has unbounded traversal depth)`,
            severity: "error",
          });
        }
      } else if (!done.has(next)) {
        dfs(next);
      }
    }
    onStack.delete(name);
    done.add(name);
  };
  for (const name of edges.keys()) if (!done.has(name)) dfs(name);
}

// Generic AST walker: visits every expr (and optionally every stmt) reachable
// from a statement list. Used by the float check and call-graph extraction.
function walkExprs(stmts: Stmt[], onExpr: (e: Expr) => void, onStmt?: (s: Stmt) => void) {
  const ex = (e: Expr | null | undefined) => {
    if (!e) return;
    onExpr(e);
    switch (e.kind) {
      case "BinOp": ex(e.left); ex(e.right); break;
      case "UnaryOp": ex(e.operand); break;
      case "Call": e.args.forEach(ex); break;
      case "MethodCall": ex(e.object); e.args.forEach(ex); break;
      case "FieldAccess": ex(e.object); break;
      case "IndexAccess": ex(e.object); ex(e.index); break;
      case "StructLit": e.fields.forEach(f => ex(f.value)); break;
      case "ArrayLit": e.elements.forEach(ex); break;
      case "ArrayRepeat": ex(e.value); break;
      case "EnumLit": e.args.forEach(ex); break;
      case "Unwrap": case "Propagate": ex(e.operand); break;
      case "DefaultValue": ex(e.operand); ex(e.default); break;
      case "CastExpr": ex(e.operand); break;
      case "Closure": st(e.body); break;
      case "RangeExpr": ex(e.start); ex(e.end); break;
      case "IsExpr": ex(e.expr); break;
      case "IfExpr": ex(e.cond); ex(e.thenBranch); ex(e.elseBranch); break;
    }
  };
  const st = (list: Stmt[]) => {
    for (const s of list) {
      onStmt?.(s);
      switch (s.kind) {
        case "LetDecl": case "VarDecl": ex(s.value); break;
        case "Assign": ex(s.target); ex(s.value); break;
        case "Return": ex(s.value); break;
        case "ExprStmt": ex(s.expr); break;
        case "IfStmt": ex(s.cond); st(s.thenBody); if (s.elseBody) st(s.elseBody); break;
        case "WhileStmt": ex(s.cond); st(s.body); break;
        case "ForInStmt": ex(s.iterable); st(s.body); break;
        case "MatchStmt": ex(s.subject); s.arms.forEach(a => st(a.body)); break;
        case "IfLetStmt": ex(s.subject); st(s.thenBody); if (s.elseBody) st(s.elseBody); break;
        case "UnsafeBlock": st(s.body); break;
        case "ParallelBlock": s.bindings.forEach(b => ex(b.value)); break;
      }
    }
  };
  st(stmts);
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
    "    do178c-c    DAL C — major (FMS, weather radar)",
    "    do178       alias for do178c-b (DAL B)\n",
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
