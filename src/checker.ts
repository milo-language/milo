import type { Program, Function, Stmt, Expr, MiloType } from "./ast";
import { TypeKind, typeFromName, typeEq, typeName, isNumeric, isInteger, isFloat } from "./types";

// variable state for move checking
interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  moved: boolean;
  moveLine?: number;
  declLine: number;
}

interface FnSig {
  params: TypeKind[];
  ret: TypeKind;
}

class CheckError {
  constructor(public message: string) {}
}

export class TypeChecker {
  private errors: string[] = [];
  private functions = new Map<string, FnSig>();
  private scopes: Map<string, VarInfo>[] = [];

  private error(msg: string) {
    this.errors.push(msg);
  }

  private resolve(ty: MiloType): TypeKind {
    return typeFromName(ty.name, ty.isPtr);
  }

  private pushScope() { this.scopes.push(new Map()); }
  private popScope() { this.scopes.pop(); }

  private declare(name: string, info: VarInfo) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) {
      this.error(`variable '${name}' already declared in this scope`);
      return;
    }
    scope.set(name, info);
  }

  private lookup(name: string): VarInfo | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const info = this.scopes[i].get(name);
      if (info) return info;
    }
    return null;
  }

  check(program: Program): string[] {
    // register all function signatures first
    for (const fn of program.functions) {
      const params = fn.params.map(p => this.resolve(p.type));
      const ret = this.resolve(fn.retType);
      this.functions.set(fn.name, { params, ret });
    }

    // check non-extern function bodies
    for (const fn of program.functions) {
      if (!fn.isExtern) this.checkFunction(fn);
    }

    return this.errors;
  }

  private checkFunction(fn: Function) {
    this.pushScope();
    const retType = this.resolve(fn.retType);

    for (const p of fn.params) {
      this.declare(p.name, {
        type: this.resolve(p.type),
        mutable: false,
        moved: false,
        declLine: 0,
      });
    }

    for (const stmt of fn.body) {
      this.checkStmt(stmt, retType);
    }

    this.popScope();
  }

  private checkStmt(stmt: Stmt, fnRetType: TypeKind) {
    switch (stmt.kind) {
      case "LetDecl": {
        const valType = this.checkExpr(stmt.value);
        if (stmt.type) {
          const declared = this.resolve(stmt.type);
          if (!typeEq(declared, valType) && valType.tag !== "unknown") {
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(declared)} but got ${typeName(valType)}`);
          }
        }
        this.declare(stmt.name, {
          type: stmt.type ? this.resolve(stmt.type) : valType,
          mutable: false,
          moved: false,
          declLine: 0,
        });
        break;
      }
      case "VarDecl": {
        const valType = this.checkExpr(stmt.value);
        if (stmt.type) {
          const declared = this.resolve(stmt.type);
          if (!typeEq(declared, valType) && valType.tag !== "unknown") {
            this.error(`type mismatch: '${stmt.name}' declared as ${typeName(declared)} but got ${typeName(valType)}`);
          }
        }
        this.declare(stmt.name, {
          type: stmt.type ? this.resolve(stmt.type) : valType,
          mutable: true,
          moved: false,
          declLine: 0,
        });
        break;
      }
      case "Assign": {
        const info = this.lookup(stmt.name);
        if (!info) { this.error(`undefined variable '${stmt.name}'`); break; }
        if (!info.mutable) { this.error(`cannot assign to immutable variable '${stmt.name}' (declared with 'let')`); break; }
        const valType = this.checkExpr(stmt.value);
        if (!typeEq(info.type, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: cannot assign ${typeName(valType)} to '${stmt.name}' of type ${typeName(info.type)}`);
        }
        // reassignment un-moves the variable
        info.moved = false;
        break;
      }
      case "Return": {
        if (!stmt.value) {
          if (fnRetType.tag !== "void") {
            this.error(`return without value in function returning ${typeName(fnRetType)}`);
          }
        } else {
          const valType = this.checkExpr(stmt.value);
          if (!typeEq(fnRetType, valType) && valType.tag !== "unknown") {
            this.error(`return type mismatch: expected ${typeName(fnRetType)}, got ${typeName(valType)}`);
          }
        }
        break;
      }
      case "IfStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`if condition must be bool, got ${typeName(condType)}`);
        }
        this.pushScope();
        for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
        this.popScope();
        if (stmt.elseBody) {
          this.pushScope();
          for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
          this.popScope();
        }
        break;
      }
      case "WhileStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`while condition must be bool, got ${typeName(condType)}`);
        }
        this.pushScope();
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.popScope();
        break;
      }
      case "ExprStmt":
        this.checkExpr(stmt.expr);
        break;
    }
  }

  private checkExpr(expr: Expr): TypeKind {
    switch (expr.kind) {
      case "IntLit":
        return { tag: "int", bits: 32, signed: true };
      case "BoolLit":
        return { tag: "bool" };
      case "StringLit":
        return { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
      case "Ident": {
        const info = this.lookup(expr.name);
        if (!info) { this.error(`undefined variable '${expr.name}'`); return { tag: "unknown" }; }
        if (info.moved) {
          this.error(`use of moved variable '${expr.name}'`);
          return info.type;
        }
        return info.type;
      }
      case "BinOp": {
        const lt = this.checkExpr(expr.left);
        const rt = this.checkExpr(expr.right);
        const arithOps = ["+", "-", "*", "/", "%"];
        const cmpOps = ["==", "!=", "<", ">", "<=", ">="];

        if (arithOps.includes(expr.op)) {
          if (!isNumeric(lt) && lt.tag !== "unknown") {
            this.error(`operator '${expr.op}' requires numeric type, got ${typeName(lt)}`);
          }
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") {
            this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`);
          }
          return lt;
        }
        if (cmpOps.includes(expr.op)) {
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") {
            this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`);
          }
          return { tag: "bool" };
        }
        this.error(`unknown operator '${expr.op}'`);
        return { tag: "unknown" };
      }
      case "UnaryOp": {
        const ot = this.checkExpr(expr.operand);
        if (expr.op === "-") {
          if (!isNumeric(ot) && ot.tag !== "unknown") {
            this.error(`unary '-' requires numeric type, got ${typeName(ot)}`);
          }
          return ot;
        }
        if (expr.op === "!") {
          if (ot.tag !== "bool" && ot.tag !== "unknown") {
            this.error(`unary '!' requires bool, got ${typeName(ot)}`);
          }
          return { tag: "bool" };
        }
        return { tag: "unknown" };
      }
      case "Call": {
        const sig = this.functions.get(expr.func);
        if (!sig) {
          this.error(`undefined function '${expr.func}'`);
          return { tag: "unknown" };
        }
        if (expr.args.length !== sig.params.length) {
          this.error(`function '${expr.func}' expects ${sig.params.length} args, got ${expr.args.length}`);
        }
        for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(sig.params[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(sig.params[i])}, got ${typeName(argType)}`);
          }
        }
        return sig.ret;
      }
    }
  }
}
