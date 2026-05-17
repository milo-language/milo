import type { Function, Stmt, Expr, Span } from "./ast";
import { type TypeKind, typeEq, typeName, isCopy } from "./types";
import { TypeChecker } from "./checker";

TypeChecker.prototype.checkFunction = function(this: TypeChecker, fn: Function) {
  this.pushScope();
  const retType = this.resolve(fn.retType);
  this.currentFnRetType = retType;

  for (const p of fn.params) {
    const pType = this.resolve(p.type);
    this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false, borrowed: false, read: false });
  }

  for (const stmt of fn.body) this.checkStmt(stmt, retType);

  if (!fn.isExtern) {
    for (const p of fn.params) {
      const info = this.lookup(p.name);
      if (!info) continue;
      if (info.type.tag === "ref") continue;
      if (isCopy(info.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) continue;
      if (!info.moved) {
        this.warn("unused-move",
          `parameter '${p.name}' is never moved — consider taking '&${typeName(info.type)}' instead`,
          fn.span,
          `passing by reference avoids requiring callers to give up ownership`
        );
      }
    }
  }

  const scope = this.scopes[this.scopes.length - 1];
  for (const [name, info] of scope) {
    if (info.read || name.startsWith("_")) continue;
    this.warn("unused-variable", `unused variable '${name}'`, info.span,
      `prefix with underscore to silence: '_${name}'`);
  }

  this.popScope();
};

TypeChecker.prototype.checkStmt = function(this: TypeChecker, stmt: Stmt, fnRetType: TypeKind) {
  const sp = stmt.span;
  switch (stmt.kind) {
    case "LetDecl": {
      const hint = stmt.type ? this.resolve(stmt.type) : null;
      const valType = this.checkExprWithHint(stmt.value, hint);
      if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
        const optInner = this.optionInnerType(hint);
        if (optInner && typeEq(optInner, valType)) {
          this.autoWrappedOption.set(stmt.value, hint.name);
        } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
          this.arrayToVecCoercions.add(stmt.value);
        } else {
          this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp);
        }
      }
      this.declare(stmt.name, { type: hint ?? valType, mutable: false, moved: false, borrowed: false, read: false, span: sp });
      this.tryMove(stmt.value);
      break;
    }
    case "VarDecl": {
      const hint = stmt.type ? this.resolve(stmt.type) : null;
      const valType = this.checkExprWithHint(stmt.value, hint);
      if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
        const optInner = this.optionInnerType(hint);
        if (optInner && typeEq(optInner, valType)) {
          this.autoWrappedOption.set(stmt.value, hint.name);
        } else if (hint.tag === "vec" && valType.tag === "array" && typeEq(hint.element, valType.element)) {
          this.arrayToVecCoercions.add(stmt.value);
        } else {
          this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp);
        }
      }
      this.declare(stmt.name, { type: hint ?? valType, mutable: true, moved: false, borrowed: false, read: false, span: sp });
      this.tryMove(stmt.value);
      break;
    }
    case "Assign": {
      const targetInfo = this.resolveAssignTarget(stmt.target);
      if (!targetInfo) break;
      if (!targetInfo.mutable) {
        this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`, sp, `declare with 'var' instead of 'let' to make it mutable`);
        break;
      }
      const valType = this.checkExprWithHint(stmt.value, targetInfo.type);
      if (!typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
        const optInner = this.optionInnerType(targetInfo.type);
        if (optInner && typeEq(optInner, valType)) {
          this.autoWrappedOption.set(stmt.value, targetInfo.type.name);
        } else {
          this.error(`type mismatch: cannot assign ${typeName(valType)} to ${typeName(targetInfo.type)}`, sp);
        }
      }
      if (stmt.target.kind === "Ident") {
        const info = this.lookup(stmt.target.name);
        if (info) info.moved = false;
      }
      this.tryMove(stmt.value);
      break;
    }
    case "Return": {
      if (!stmt.value) {
        if (fnRetType.tag !== "void") this.error(`return without value in function returning ${typeName(fnRetType)}`, sp);
      } else {
        const prev = this.inReturnInLoop;
        if (this.loopDepth > 0) this.inReturnInLoop = true;
        const valType = this.checkExprWithHint(stmt.value, fnRetType);
        if (!typeEq(fnRetType, valType) && valType.tag !== "unknown" && fnRetType.tag !== "unknown") {
          this.error(`return type mismatch: expected ${typeName(fnRetType)}, got ${typeName(valType)}`, sp);
        }
        this.tryMove(stmt.value);
        this.inReturnInLoop = prev;
      }
      break;
    }
    case "IfStmt": {
      const condType = this.checkExpr(stmt.cond);
      if (condType.tag !== "bool" && condType.tag !== "unknown") {
        this.error(`if condition must be bool, got ${typeName(condType)}`, sp);
      }
      const preMoves = this.snapshotMoveState();
      this.pushScope();
      for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
      this.popScope();
      const thenReturns = this.bodyAlwaysReturns(stmt.thenBody);
      if (stmt.elseBody) {
        const afterThen = this.snapshotMoveState();
        this.restoreMoveState(preMoves);
        this.pushScope();
        for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
        this.popScope();
        const elseReturns = this.bodyAlwaysReturns(stmt.elseBody);
        const afterElse = this.snapshotMoveState();
        this.restoreMoveState(preMoves);
        for (const [info, m] of afterThen) {
          if (m && !thenReturns) info.moved = true;
        }
        for (const [info, m] of afterElse) {
          if (m && !elseReturns) info.moved = true;
        }
      } else if (thenReturns) {
        this.restoreMoveState(preMoves);
      }
      break;
    }
    case "WhileStmt": {
      const condType = this.checkExpr(stmt.cond);
      if (condType.tag !== "bool" && condType.tag !== "unknown") {
        this.error(`while condition must be bool, got ${typeName(condType)}`, sp);
      }
      const preMoves = this.snapshotMoveState();
      this.returnOnlyMovesStack.push(new Set());
      this.pushScope();
      this.loopDepth++;
      for (const s of stmt.body) this.checkStmt(s, fnRetType);
      this.loopDepth--;
      this.popScope();
      const returnMoves = this.returnOnlyMovesStack.pop()!;
      for (const scope of this.scopes) {
        for (const [name, info] of scope) {
          if (preMoves.get(info) === false && info.moved) {
            if (returnMoves.has(info)) { info.moved = false; }
            else { this.error(`cannot move '${name}' out of a loop`, sp); }
          }
        }
      }
      break;
    }
    case "ForInStmt": {
      if (stmt.iterable.kind === "RangeExpr") {
        const startType = this.checkExpr(stmt.iterable.start);
        const endType = this.checkExpr(stmt.iterable.end);
        if (startType.tag !== "int" && startType.tag !== "unknown") {
          this.error(`for range start must be an integer, got ${typeName(startType)}`, sp);
        }
        if (endType.tag !== "int" && endType.tag !== "unknown") {
          this.error(`for range end must be an integer, got ${typeName(endType)}`, sp);
        }
        if (stmt.varName2) {
          this.error("range for loop takes one binding, not two", sp);
        }
        let varType: TypeKind;
        if (startType.tag === "int" && endType.tag === "int") {
          varType = startType.bits >= endType.bits ? startType : endType;
        } else {
          varType = startType.tag === "int" ? startType : endType;
        }
        this.setType(stmt.iterable, varType);
        const preMoves = this.snapshotMoveState();
        this.returnOnlyMovesStack.push(new Set());
        this.pushScope();
        this.declare(stmt.varName, { type: varType, mutable: false, moved: false, borrowed: false, read: false });
        this.loopDepth++;
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.loopDepth--;
        this.popScope();
        const returnMoves = this.returnOnlyMovesStack.pop()!;
        for (const scope of this.scopes) {
          for (const [name, info] of scope) {
            if (preMoves.get(info) === false && info.moved) {
              if (returnMoves.has(info)) { info.moved = false; }
              else { this.error(`cannot move '${name}' out of a loop`, sp); }
            }
          }
        }
      } else {
        const iterType = this.checkExpr(stmt.iterable);
        if (iterType.tag === "vec") {
          const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
          if (stmt.iterable.kind === "Ident") {
            const info = this.lookup(stmt.iterable.name);
            if (info) info.borrowed = true;
          }
          const preMoves = this.snapshotMoveState();
          this.returnOnlyMovesStack.push(new Set());
          this.pushScope();
          if (stmt.varName2) {
            const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
            this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
            this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
          } else {
            this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
          }
          this.loopDepth++;
          for (const s of stmt.body) this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves = this.returnOnlyMovesStack.pop()!;
          for (const scope of this.scopes) {
            for (const [name, info] of scope) {
              if (preMoves.get(info) === false && info.moved) {
                if (returnMoves.has(info)) { info.moved = false; }
                else { this.error(`cannot move '${name}' out of a loop`, sp); }
              }
            }
          }
        } else if (iterType.tag === "string") {
          const byteType: TypeKind = { tag: "int", bits: 8, signed: false };
          const preMoves = this.snapshotMoveState();
          this.returnOnlyMovesStack.push(new Set());
          this.pushScope();
          if (stmt.varName2) {
            const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
            this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
            this.declare(stmt.varName2, { type: byteType, mutable: false, moved: false, borrowed: false, read: false });
          } else {
            this.declare(stmt.varName, { type: byteType, mutable: false, moved: false, borrowed: false, read: false });
          }
          this.loopDepth++;
          for (const s of stmt.body) this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves3 = this.returnOnlyMovesStack.pop()!;
          for (const scope of this.scopes) {
            for (const [name, info] of scope) {
              if (preMoves.get(info) === false && info.moved) {
                if (returnMoves3.has(info)) { info.moved = false; }
                else { this.error(`cannot move '${name}' out of a loop`, sp); }
              }
            }
          }
        } else if (iterType.tag === "hashmap") {
          const keyRef: TypeKind = { tag: "ref", inner: iterType.key, mutable: false };
          const valRef: TypeKind = { tag: "ref", inner: iterType.value, mutable: false };
          if (stmt.iterable.kind === "Ident") {
            const info = this.lookup(stmt.iterable.name);
            if (info) info.borrowed = true;
          }
          const preMoves = this.snapshotMoveState();
          this.returnOnlyMovesStack.push(new Set());
          this.pushScope();
          this.declare(stmt.varName, { type: keyRef, mutable: false, moved: false, borrowed: false, read: false });
          if (stmt.varName2) {
            this.declare(stmt.varName2, { type: valRef, mutable: false, moved: false, borrowed: false, read: false });
          }
          this.loopDepth++;
          for (const s of stmt.body) this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves4 = this.returnOnlyMovesStack.pop()!;
          for (const scope of this.scopes) {
            for (const [name, info] of scope) {
              if (preMoves.get(info) === false && info.moved) {
                if (returnMoves4.has(info)) { info.moved = false; }
                else { this.error(`cannot move '${name}' out of a loop`, sp); }
              }
            }
          }
        } else if (iterType.tag === "array") {
          const elemRef: TypeKind = { tag: "ref", inner: iterType.element, mutable: false };
          if (stmt.iterable.kind === "Ident") {
            const info = this.lookup(stmt.iterable.name);
            if (info) info.borrowed = true;
          }
          const preMoves = this.snapshotMoveState();
          this.returnOnlyMovesStack.push(new Set());
          this.pushScope();
          if (stmt.varName2) {
            const idxType: TypeKind = { tag: "int", bits: 64, signed: true };
            this.declare(stmt.varName, { type: idxType, mutable: false, moved: false, borrowed: false, read: false });
            this.declare(stmt.varName2, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
          } else {
            this.declare(stmt.varName, { type: elemRef, mutable: false, moved: false, borrowed: false, read: false });
          }
          this.loopDepth++;
          for (const s of stmt.body) this.checkStmt(s, fnRetType);
          this.loopDepth--;
          this.popScope();
          const returnMoves5 = this.returnOnlyMovesStack.pop()!;
          for (const scope of this.scopes) {
            for (const [name, info] of scope) {
              if (preMoves.get(info) === false && info.moved) {
                if (returnMoves5.has(info)) { info.moved = false; }
                else { this.error(`cannot move '${name}' out of a loop`, sp); }
              }
            }
          }
        } else if (iterType.tag !== "unknown") {
          this.error(`cannot iterate over type '${typeName(iterType)}'`, sp);
        }
      }
      break;
    }
    case "BreakStmt":
      if (this.loopDepth === 0) this.error("'break' outside of loop", sp);
      break;
    case "ContinueStmt":
      if (this.loopDepth === 0) this.error("'continue' outside of loop", sp);
      break;
    case "ExprStmt": {
      const exprType = this.checkExpr(stmt.expr);
      if (exprType.tag === "enum") {
        const enumInfo = this.enums.get(exprType.name);
        const base = enumInfo?.baseName;
        if (base === "Result" || base === "Option") {
          this.warn("unused-result",
            `unused ${base} value — this may contain an error that should be handled`,
            sp, `use 'let _ = ...' to discard explicitly`);
        }
      }
      break;
    }
    case "MatchStmt": {
      const subjType = this.checkExpr(stmt.subject);
      const isEnum = subjType.tag === "enum";
      const isLiteralType = subjType.tag === "int" || subjType.tag === "float" || subjType.tag === "string" || subjType.tag === "bool";
      if (!isEnum && !isLiteralType && subjType.tag !== "unknown") {
        this.error(`match subject must be an enum, integer, float, string, or bool, got ${typeName(subjType)}`, sp);
        break;
      }
      if (isLiteralType) {
        let hasWildcard = false;
        const preMoves = this.snapshotMoveState();
        const mergedMoves = new Map<any, boolean>();
        for (const arm of stmt.arms) {
          if (arm.pattern.kind === "WildcardPattern") {
            hasWildcard = true;
          } else if (arm.pattern.kind === "LiteralPattern") {
            const ps = arm.pattern.span;
            if (subjType.tag === "int" && arm.pattern.literalKind !== "int") {
              this.error(`expected integer literal in match arm`, ps);
            } else if (subjType.tag === "float" && arm.pattern.literalKind !== "float" && arm.pattern.literalKind !== "int") {
              this.error(`expected numeric literal in match arm`, ps);
            } else if (subjType.tag === "string" && arm.pattern.literalKind !== "string") {
              this.error(`expected string literal in match arm`, ps);
            } else if (subjType.tag === "bool" && arm.pattern.literalKind !== "bool") {
              this.error(`expected bool literal in match arm`, ps);
            }
          } else if (arm.pattern.kind === "EnumPattern") {
            this.error(`cannot use enum pattern when matching on ${typeName(subjType)}`, arm.pattern.span);
          }
          this.restoreMoveState(preMoves);
          this.pushScope();
          for (const s of arm.body) this.checkStmt(s, fnRetType);
          this.popScope();
          for (const [info, moved] of this.snapshotMoveState()) {
            if (moved) mergedMoves.set(info, true);
          }
        }
        this.restoreMoveState(preMoves);
        for (const [info] of mergedMoves) info.moved = true;
        if (!hasWildcard && subjType.tag === "bool") {
          const hasTrueArm = stmt.arms.some(a => a.pattern.kind === "LiteralPattern" && a.pattern.value === true);
          const hasFalseArm = stmt.arms.some(a => a.pattern.kind === "LiteralPattern" && a.pattern.value === false);
          if (!hasTrueArm || !hasFalseArm) {
            this.error(`non-exhaustive match on bool`, sp);
          }
        } else if (!hasWildcard) {
          this.error(`match on ${typeName(subjType)} requires a wildcard '_' arm`, sp);
        }
      } else if (isEnum) {
        const enumInfo = this.enums.get(subjType.name)!;
        const covered = new Set<string>();
        let hasWildcard = false;
        const preMoves = this.snapshotMoveState();
        const mergedMoves = new Map<any, boolean>();
        for (const arm of stmt.arms) {
          if (arm.pattern.kind === "WildcardPattern") {
            hasWildcard = true;
          } else if (arm.pattern.kind === "EnumPattern") {
            const ps = arm.pattern.span;
            if (arm.pattern.enumName !== subjType.name && enumInfo.baseName !== arm.pattern.enumName) {
              this.error(`pattern enum '${arm.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
            }
            const variant = enumInfo.variants.get(arm.pattern.variant);
            if (!variant) {
              this.error(`enum '${subjType.name}' has no variant '${arm.pattern.variant}'`, ps);
              continue;
            }
            if (covered.has(arm.pattern.variant)) {
              this.error(`duplicate match arm for '${arm.pattern.variant}'`, ps);
            }
            covered.add(arm.pattern.variant);
            if (arm.pattern.bindings.length !== variant.fields.length) {
              this.error(`variant '${arm.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${arm.pattern.bindings.length} bindings`, ps);
            }
          } else if (arm.pattern.kind === "LiteralPattern") {
            this.error(`cannot use literal pattern when matching on enum`, arm.pattern.span);
          }
          this.restoreMoveState(preMoves);
          this.pushScope();
          if (arm.pattern.kind === "EnumPattern") {
            const variant = enumInfo.variants.get(arm.pattern.variant);
            if (variant) {
              for (let i = 0; i < Math.min(arm.pattern.bindings.length, variant.fields.length); i++) {
                this.declare(arm.pattern.bindings[i], { type: variant.fields[i], mutable: false, moved: false, borrowed: false, read: false });
              }
            }
          }
          for (const s of arm.body) this.checkStmt(s, fnRetType);
          this.popScope();
          for (const [info, moved] of this.snapshotMoveState()) {
            if (moved) mergedMoves.set(info, true);
          }
        }
        this.restoreMoveState(preMoves);
        for (const [info] of mergedMoves) info.moved = true;
        if (!hasWildcard) {
          for (const [name] of enumInfo.variants) {
            if (!covered.has(name)) {
              this.error(`non-exhaustive match: missing variant '${name}'`, sp);
            }
          }
        }
      }
      this.tryMove(stmt.subject);
      break;
    }
    case "IfLetStmt": {
      const subjType = this.checkExpr(stmt.subject);
      if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
        this.error(`if let subject must be an enum, got ${typeName(subjType)}`, sp);
        break;
      }
      if (subjType.tag === "enum" && stmt.pattern.kind === "EnumPattern") {
        const enumInfo = this.enums.get(subjType.name)!;
        const ps = stmt.pattern.span;
        if (stmt.pattern.enumName !== subjType.name && enumInfo.baseName !== stmt.pattern.enumName) {
          this.error(`pattern enum '${stmt.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
        }
        const variant = enumInfo.variants.get(stmt.pattern.variant);
        if (!variant) {
          this.error(`enum '${subjType.name}' has no variant '${stmt.pattern.variant}'`, ps);
        } else if (stmt.pattern.bindings.length !== variant.fields.length) {
          this.error(`variant '${stmt.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${stmt.pattern.bindings.length} bindings`, ps);
        }
        this.pushScope();
        if (variant) {
          for (let i = 0; i < Math.min(stmt.pattern.bindings.length, variant.fields.length); i++) {
            this.declare(stmt.pattern.bindings[i], { type: variant.fields[i], mutable: false, moved: false, borrowed: false, read: false });
          }
        }
        for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
        this.popScope();
      } else {
        this.pushScope();
        for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
        this.popScope();
      }
      if (stmt.elseBody) {
        this.pushScope();
        for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
        this.popScope();
      }
      this.tryMove(stmt.subject);
      break;
    }
    case "UnsafeBlock": {
      this.unsafeDepth++;
      this.pushScope();
      for (const s of stmt.body) this.checkStmt(s, fnRetType);
      this.popScope();
      this.unsafeDepth--;
      break;
    }
  }
};

TypeChecker.prototype.tryMove = function(this: TypeChecker, expr: Expr) {
  if (expr.kind === "Ident") {
    const info = this.lookup(expr.name);
    if (info && !isCopy(info.type, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
      if (info.borrowed) {
        this.error(`cannot move '${expr.name}' because it is captured by a closure`, expr.span);
        return;
      }
      info.moved = true;
      this.movedExprs.add(expr);
      if (this.loopDepth > 0 && this.returnOnlyMovesStack.length > 0) {
        const cur = this.returnOnlyMovesStack[this.returnOnlyMovesStack.length - 1];
        if (this.inReturnInLoop) {
          cur.add(info);
        } else {
          cur.delete(info);
        }
      }
    }
  }
  if (expr.kind === "IndexAccess") {
    const elemType = this.exprTypes.get(expr);
    if (elemType && !isCopy(elemType, (n) => this.isAllCopyEnum(n), (n) => this.isAllCopyStruct(n))) {
      let objectIsRef = false;
      if (expr.object.kind === "Ident") {
        const info = this.lookup(expr.object.name);
        if (info && info.type.tag === "ref") objectIsRef = true;
      }
      if (objectIsRef) {
        this.borrowedExprs.add(expr);
      } else {
        this.movedExprs.add(expr);
      }
    }
  }
};

TypeChecker.prototype.resolveAssignTarget = function(this: TypeChecker, expr: Expr): { type: TypeKind; mutable: boolean } | null {
  const sp = expr.span;
  if (expr.kind === "Ident") {
    const info = this.lookup(expr.name);
    if (!info) { this.error(`undefined variable '${expr.name}'`, sp); return null; }
    if (info.type.tag === "ref" && info.type.mutable) {
      this.setType(expr, info.type.inner);
      return { type: info.type.inner, mutable: true };
    }
    if (info.type.tag === "ref" && info.mutable) {
      this.setType(expr, info.type);
      return { type: info.type, mutable: true };
    }
    const t = this.deref(info.type);
    this.setType(expr, t);
    return { type: t, mutable: info.mutable };
  }
  if (expr.kind === "FieldAccess") {
    const objType = this.checkExpr(expr.object);
    if (objType.tag === "struct") {
      const info = this.structs.get(objType.name);
      if (!info) { this.error(`unknown struct '${objType.name}'`, sp); return null; }
      const field = info.fields.find(f => f.name === expr.field);
      if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp); return null; }
      this.setType(expr, field.type);
      const rootMut = this.isRootMutable(expr.object);
      return { type: field.type, mutable: rootMut };
    }
    this.error(`cannot access field on non-struct type ${typeName(objType)}`, sp);
    return null;
  }
  if (expr.kind === "IndexAccess") {
    const objType = this.checkExpr(expr.object);
    this.checkExpr(expr.index);
    if (objType.tag === "array") {
      this.setType(expr, objType.element);
      const rootMut = this.isRootMutable(expr.object);
      return { type: objType.element, mutable: rootMut };
    }
    if (objType.tag === "vec") {
      this.setType(expr, objType.element);
      const rootMut = this.isRootMutable(expr.object);
      return { type: objType.element, mutable: rootMut };
    }
    if (objType.tag === "ptr") {
      this.setType(expr, objType.inner);
      return { type: objType.inner, mutable: true };
    }
    this.error(`cannot index non-array type ${typeName(objType)}`, sp);
    return null;
  }
  if (expr.kind === "UnaryOp" && expr.op === "*") {
    const ot = this.checkExpr(expr.operand);
    if (ot.tag === "ptr") {
      this.setType(expr, ot.inner);
      return { type: ot.inner, mutable: true };
    }
    if (ot.tag === "box") {
      this.setType(expr, ot.inner);
      return { type: ot.inner, mutable: true };
    }
    this.error(`cannot dereference type '${typeName(ot)}' for assignment`, sp);
    return null;
  }
  this.error("invalid assignment target", sp);
  return null;
};
