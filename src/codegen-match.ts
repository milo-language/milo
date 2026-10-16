// Match lowering: literal (int/char/bool/float/string) matches and the arm helpers shared with the fork-ownership logic.

import type { HIRStmt, HIRExpr, HIRPattern } from "./hir";
import { genStringCmp, type StringCtx } from "./codegen-string";
import type { ForkSlot } from "./codegen";

// Codegen's matching members are public solely to satisfy this, they are not part of its external API.
export interface MatchCtx extends StringCtx {
  emitMatchArmBody(lines: string[], body: HIRStmt[], resultSlot?: ForkSlot, armDropStart?: number): boolean;
}

export function genLiteralMatch(ctx: MatchCtx, stmt: HIRStmt & { kind: "Match" }, resultSlot?: ForkSlot): [string[], boolean] {
  const lines: string[] = [];
  const [subjLines, subjVal, subjTy] = ctx.genExpr(stmt.subject);
  lines.push(...subjLines);

  const endLabel = ctx.nextLabel("match.end");
  let allArmsTerminated = true;

  const literalArms: { label: string; nextLabel: string; arm: typeof stmt.arms[0] }[] = [];
  let wildcardArm: typeof stmt.arms[0] | null = null;

  for (const arm of stmt.arms) {
    if (arm.pattern.kind === "WildcardPattern") {
      wildcardArm = arm;
    } else {
      const label = ctx.nextLabel("match.arm");
      literalArms.push({ label, nextLabel: "", arm });
    }
  }

  // Fast path — an all-integer/char match lowers to a single LLVM `switch`
  // rather than an icmp/br comparison chain. LLVM turns the switch into a jump
  // table (O(1) dispatch instead of a linear scan) and, critically, the CFG
  // stays flat: a 250-arm opcode dispatcher was becoming a 461-branch chain
  // that -O2's superlinear passes choked on (>3 min vs seconds). Requires
  // distinct case values (LLVM rejects duplicates); anything else (string,
  // bool, float, dup values) falls through to the chain below.
  const allIntCharDistinct = (() => {
    if (literalArms.length === 0) return false;
    const seen = new Set<string>();
    for (const la of literalArms) {
      const p = la.arm.pattern;
      if (p.kind !== "LiteralPattern" || (p.literalKind !== "int" && p.literalKind !== "char")) return false;
      const key = String(p.value);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  })();

  if (allIntCharDistinct) {
    const defaultLabel = wildcardArm ? ctx.nextLabel("match.wildcard") : ctx.nextLabel("match.default");
    const cases = literalArms.map(la => {
      const p = la.arm.pattern as HIRPattern & { kind: "LiteralPattern" };
      return `${subjTy} ${p.value}, label %${la.label}`;
    }).join(" ");
    lines.push(`  switch ${subjTy} ${subjVal}, label %${defaultLabel} [${cases}]`);
    for (const la of literalArms) {
      lines.push(`${la.label}:`);
      const armTerminated = ctx.emitMatchArmBody(lines, la.arm.body, resultSlot);
      if (!armTerminated) { lines.push(`  br label %${endLabel}`); allArmsTerminated = false; }
    }
    lines.push(`${defaultLabel}:`);
    if (wildcardArm) {
      const wcTerminated = ctx.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
      if (!wcTerminated) { lines.push(`  br label %${endLabel}`); allArmsTerminated = false; }
    } else {
      lines.push(`  unreachable`);
    }
    lines.push(`${endLabel}:`);
    if (allArmsTerminated) lines.push(`  unreachable`);
    return [lines, allArmsTerminated];
  }

  // chain: compare → arm body or fall through to next comparison
  for (let i = 0; i < literalArms.length; i++) {
    const next = i + 1 < literalArms.length
      ? ctx.nextLabel("match.cmp")
      : wildcardArm
        ? ctx.nextLabel("match.wildcard")
        : ctx.nextLabel("match.default");
    literalArms[i].nextLabel = next;

    const pat = literalArms[i].arm.pattern;
    if (pat.kind !== "LiteralPattern") continue;

    let cmpVal: string;
    if (pat.literalKind === "string") {
      ctx.hasStringType = true;
      const litStr = ctx.addString(String(pat.value));
      const litVal = ctx.nextTemp();
      lines.push(`  ${litVal} = insertvalue %String undef, ptr ${litStr.label}, 0`);
      const litVal2 = ctx.nextTemp();
      lines.push(`  ${litVal2} = insertvalue %String ${litVal}, i64 ${litStr.length - 1}, 1`);
      const [, cmpResult] = genStringCmp(ctx, lines, subjVal, litVal2, true);
      cmpVal = cmpResult;
    } else if (pat.literalKind === "bool") {
      const litVal = pat.value ? "1" : "0";
      cmpVal = ctx.nextTemp();
      lines.push(`  ${cmpVal} = icmp eq i1 ${subjVal}, ${litVal}`);
    } else if (pat.literalKind === "int" || pat.literalKind === "char") {
      cmpVal = ctx.nextTemp();
      lines.push(`  ${cmpVal} = icmp eq ${subjTy} ${subjVal}, ${pat.value}`);
    } else {
      // float
      cmpVal = ctx.nextTemp();
      const fval = Number.isInteger(pat.value as number) ? (pat.value as number).toFixed(1) : String(pat.value);
      lines.push(`  ${cmpVal} = fcmp oeq ${subjTy} ${subjVal}, ${fval}`);
    }

    lines.push(`  br i1 ${cmpVal}, label %${literalArms[i].label}, label %${next}`);

    // arm body
    lines.push(`${literalArms[i].label}:`);
    const armTerminated = ctx.emitMatchArmBody(lines, literalArms[i].arm.body, resultSlot);
    if (!armTerminated) lines.push(`  br label %${endLabel}`);
    if (!armTerminated) allArmsTerminated = false;

    // next comparison block (or wildcard/default)
    if (i + 1 < literalArms.length) {
      lines.push(`${next}:`);
    }
  }

  // wildcard or default
  const lastNext = literalArms.length > 0 ? literalArms[literalArms.length - 1].nextLabel : ctx.nextLabel("match.wildcard");
  if (wildcardArm) {
    if (literalArms.length === 0) {
      lines.push(`  br label %${lastNext}`);
    }
    lines.push(`${lastNext}:`);
    const wcTerminated = ctx.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
    if (!wcTerminated) lines.push(`  br label %${endLabel}`);
    if (!wcTerminated) allArmsTerminated = false;
  } else {
    if (literalArms.length === 0) {
      lines.push(`  br label %${lastNext}`);
    }
    lines.push(`${lastNext}:`);
    lines.push(`  unreachable`);
  }

  lines.push(`${endLabel}:`);
  if (allArmsTerminated) lines.push(`  unreachable`);
  return [lines, allArmsTerminated];
}

// The value a block produces, when it produces one: a block's value is its tail
// expression, which is how genIfExpr and the match-arm emitter already read it. Anything
// else there (a Return, a loop) leaves no value for this expression to own.
export function armTailExpr(body: HIRStmt[]): HIRExpr | null {
  const last = body[body.length - 1];
  return last && last.kind === "ExprStmt" ? last.expr : null;
}

// The names a match arm declares itself: its pattern's bindings (owned unless the
// subject is matched by reference) and its top-level `let`s.
export function matchArmLocals(arm: { pattern: HIRPattern; body: HIRStmt[] }, subjectIsRef: boolean): Set<string> {
  const out = new Set<string>();
  if (arm.pattern.kind === "EnumPattern" && !subjectIsRef) for (const b of arm.pattern.bindings) out.add(b.name);
  for (const st of arm.body) if (st.kind === "Let") out.add(st.name);
  return out;
}
