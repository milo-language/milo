// Compile-time folding of module-global initializers: the one place that decides which
// globals get a static initializer and what it is. Codegen asks `isFullyConstInit` to split
// static globals from the run-time-initialized ones; emit-mlir turns `globalInit` into the
// `milo.global.def` init attribute (types and layout come from the MLIR side, so a folded
// value carries none).
import type { HIRExpr, HIRGlobal } from "./hir";

export type ConstVal =
  | { k: "int"; v: bigint }
  | { k: "float"; v: number }
  | { k: "zero" }
  /** A struct's fields in layout order, or an array's elements. */
  | { k: "agg"; items: ConstVal[] }
  /** `[v; n]`: one element for all of the array type's. */
  | { k: "splat"; item: ConstVal };

export type FoldLayouts = Map<string, { fields: { name: string }[] }>;

// Fold a compile-time-constant numeric expression (literals + arithmetic on
// them) to an int/float value. The checker's isConstGlobalInit already admits
// BinOp/UnaryOp of constants as valid global initializers, but without this
// fold a global `let x: f64 = a / b` was silently zeroed. Int math stays in bigint to
// preserve i64 precision; float math promotes to Number.
function numeric(expr: HIRExpr): { kind: "int"; v: bigint } | { kind: "float"; v: number } | null {
  switch (expr.kind) {
    case "IntLit": return { kind: "int", v: BigInt(expr.value) };
    case "FloatLit": return { kind: "float", v: expr.value };
    case "BoolLit": return { kind: "int", v: expr.value ? 1n : 0n };
    case "UnaryOp": {
      const o = numeric(expr.operand);
      if (!o) return null;
      if (expr.op === "-") return o.kind === "float" ? { kind: "float", v: -o.v } : { kind: "int", v: -o.v };
      if (expr.op === "~" && o.kind === "int") return { kind: "int", v: -o.v - 1n }; // two's-complement bitwise-not
      if (expr.op === "!" && o.kind === "int") return { kind: "int", v: o.v === 0n ? 1n : 0n };
      return null;
    }
    case "Cast": {
      const o = numeric(expr.operand);
      if (!o) return null;
      if (expr.targetType.tag === "float") return { kind: "float", v: o.kind === "float" ? o.v : Number(o.v) };
      if (expr.targetType.tag === "int") return { kind: "int", v: o.kind === "float" ? BigInt(Math.trunc(o.v)) : o.v };
      return null;
    }
    case "BinOp": {
      const l = numeric(expr.left);
      const r = numeric(expr.right);
      if (!l || !r) return null;
      const asFloat = expr.type.tag === "float" || l.kind === "float" || r.kind === "float";
      if (asFloat) {
        const a = l.kind === "float" ? l.v : Number(l.v);
        const b = r.kind === "float" ? r.v : Number(r.v);
        switch (expr.op) {
          case "+": return { kind: "float", v: a + b };
          case "-": return { kind: "float", v: a - b };
          case "*": return { kind: "float", v: a * b };
          case "/": return { kind: "float", v: a / b };
          default: return null;
        }
      }
      const a = l.v as bigint, b = r.v as bigint;
      switch (expr.op) {
        case "+": return { kind: "int", v: a + b };
        case "-": return { kind: "int", v: a - b };
        case "*": return { kind: "int", v: a * b };
        case "/": return b === 0n ? null : { kind: "int", v: a / b };  // bigint / truncates toward zero, matches sdiv
        case "%": return b === 0n ? null : { kind: "int", v: a % b };
        case "<<": return { kind: "int", v: a << b };
        case ">>": return { kind: "int", v: a >> b };
        case "&": return { kind: "int", v: a & b };
        case "|": return { kind: "int", v: a | b };
        case "^": return { kind: "int", v: a ^ b };
        default: return null;
      }
    }
    default: return null;
  }
}

const num = (n: NonNullable<ReturnType<typeof numeric>>): ConstVal => n.kind === "float" ? { k: "float", v: n.v } : { k: "int", v: n.v };

export function foldConst(expr: HIRExpr, layouts: FoldLayouts): ConstVal | null {
  switch (expr.kind) {
    case "IntLit":
    case "FloatLit":
    case "BoolLit":
    case "BinOp":
    case "UnaryOp": {
      const n = numeric(expr);
      return n === null ? null : num(n);
    }
    case "Cast": {
      if (expr.type.tag === "ptr") return { k: "zero" };
      if (expr.type.tag !== "int" && expr.type.tag !== "float") return null;
      const n = numeric(expr);
      return n === null ? null : num(n);
    }
    case "StructLit": {
      const layout = layouts.get(expr.name);
      // A struct-update base is a run-time value even when every field is listed.
      if (!layout || expr.base) return null;
      const items: ConstVal[] = [];
      for (const lf of layout.fields) {
        const ef = expr.fields.find(f => f.name === lf.name);
        if (!ef) return null;
        const v = foldConst(ef.value, layouts);
        if (v === null) return null;
        items.push(v);
      }
      return { k: "agg", items };
    }
    case "ArrayLit": {
      if (expr.type.tag !== "array" || expr.type.size === null) return null;
      const items: ConstVal[] = [];
      for (const elem of expr.elements) {
        const v = foldConst(elem, layouts);
        if (v === null) return null;
        items.push(v);
      }
      return { k: "agg", items };
    }
    case "ArrayRepeat": {
      const item = foldConst(expr.value, layouts);
      if (item === null) return null;
      const isZero = item.k === "zero" || (item.k === "int" && item.v === 0n);
      return isZero ? { k: "zero" } : { k: "splat", item };
    }
    default:
      return null;
  }
}

// A struct literal with a non-const field is only a *partial* constant (that field zeroed),
// so it still needs the run-time pass: this is the check that decides which globals are
// filled at run time, and answering "yes" for a partial init is how a field silently stays
// empty. Fields a partial literal leaves out count as const: they are zero.
export function isFullyConstInit(g: HIRGlobal, layouts: FoldLayouts): boolean {
  if (foldConst(g.value, layouts) !== null) return true;
  if (g.value?.kind !== "StructLit" || g.value.base) return false;
  const layout = layouts.get(g.type.tag === "struct" ? g.type.name : "");
  if (!layout) return false;
  const byName = new Map(g.value.fields.map(f => [f.name, f.value]));
  return layout.fields.every(f => {
    const e = byName.get(f.name);
    return !e || foldConst(e, layouts) !== null;
  });
}

/**
 * The static initializer of `g`: its folded value, or for a struct literal with run-time
 * fields the constant fields with the rest zeroed (the run-time pass fills them), else zero.
 */
export function globalInit(g: HIRGlobal, layouts: FoldLayouts): ConstVal {
  const whole = foldConst(g.value, layouts);
  if (whole !== null) return whole;
  const value = g.value;
  if (!value || value.kind !== "StructLit" || value.base || g.type.tag !== "struct") return { k: "zero" };
  const layout = layouts.get(g.type.name);
  if (!layout) return { k: "zero" };
  const byName = new Map(value.fields.map(f => [f.name, f.value]));
  return {
    k: "agg",
    items: layout.fields.map(f => {
      const e = byName.get(f.name);
      return (e && foldConst(e, layouts)) || { k: "zero" as const };
    }),
  };
}
