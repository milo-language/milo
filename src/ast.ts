export interface MiloType {
  name: string; // "i32", "u8", "bool", "void", etc.
  isPtr: boolean;
}

export interface Param {
  name: string;
  type: MiloType;
  isRef: boolean;
}

// ── Expressions ──

export interface IntLit { kind: "IntLit"; value: number }
export interface BoolLit { kind: "BoolLit"; value: boolean }
export interface StringLit { kind: "StringLit"; value: string }
export interface Ident { kind: "Ident"; name: string }
export interface BinOp { kind: "BinOp"; op: string; left: Expr; right: Expr }
export interface UnaryOp { kind: "UnaryOp"; op: string; operand: Expr }
export interface Call { kind: "Call"; func: string; args: Expr[] }

export type Expr = IntLit | BoolLit | StringLit | Ident | BinOp | UnaryOp | Call;

// ── Statements ──

export interface LetDecl { kind: "LetDecl"; name: string; type: MiloType | null; value: Expr }
export interface VarDecl { kind: "VarDecl"; name: string; type: MiloType | null; value: Expr }
export interface Assign { kind: "Assign"; name: string; value: Expr }
export interface Return { kind: "Return"; value: Expr | null }
export interface IfStmt { kind: "IfStmt"; cond: Expr; thenBody: Stmt[]; elseBody: Stmt[] | null }
export interface WhileStmt { kind: "WhileStmt"; cond: Expr; body: Stmt[] }
export interface ExprStmt { kind: "ExprStmt"; expr: Expr }

export type Stmt = LetDecl | VarDecl | Assign | Return | IfStmt | WhileStmt | ExprStmt;

// ── Top-level ──

export interface Function {
  kind: "Function";
  name: string;
  params: Param[];
  retType: MiloType;
  body: Stmt[];
  isExtern: boolean;
  isVariadic: boolean;
}

export interface Program {
  functions: Function[];
}
