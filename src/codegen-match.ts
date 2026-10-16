// Match lowering: literal (int/char/bool/float/string) matches and the arm helpers shared with the fork-ownership logic.

import type { HIRStmt, HIRExpr, HIRPattern } from "./hir";
import { genStringCmp, type StringCtx } from "./codegen-string";
import { LlvmTextBuilder, Ty, val, type Block, type Val } from "./ir";
import type { ForkSlot } from "./codegen";

const STRING = Ty.of("%String");

// Codegen's matching members are public solely to satisfy this, they are not part of its external API.
export interface MatchCtx extends StringCtx {
  emitMatchArmBody(lines: string[], body: HIRStmt[], resultSlot?: ForkSlot, armDropStart?: number): boolean;
}

// The builder takes case values as numbers; a literal that does not survive the round trip
// (beyond 2^53) would print differently, so it fails loudly instead of silently changing.
function caseValue(v: number | string | boolean): number {
  const n = Number(v);
  if (String(n) !== String(v)) throw new Error(`ir: switch case ${String(v)} is not exactly representable`);
  return n;
}

export function genLiteralMatch(ctx: MatchCtx, stmt: HIRStmt & { kind: "Match" }, resultSlot?: ForkSlot): [string[], boolean] {
  const lines: string[] = [];
  const [subjLines, subjVal, subjTy] = ctx.genExpr(stmt.subject);
  lines.push(...subjLines);
  const b = new LlvmTextBuilder(lines, ctx);
  const subj = val(subjVal, Ty.of(subjTy));

  const endBlock = b.newBlock("match.end");
  let allArmsTerminated = true;

  const literalArms: { block: Block; nextBlock: Block | null; arm: typeof stmt.arms[0] }[] = [];
  let wildcardArm: typeof stmt.arms[0] | null = null;

  for (const arm of stmt.arms) {
    if (arm.pattern.kind === "WildcardPattern") {
      wildcardArm = arm;
    } else {
      literalArms.push({ block: b.newBlock("match.arm"), nextBlock: null, arm });
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
    const defaultBlock = wildcardArm ? b.newBlock("match.wildcard") : b.newBlock("match.default");
    b.switch(subj, defaultBlock, literalArms.map(la => {
      const p = la.arm.pattern as HIRPattern & { kind: "LiteralPattern" };
      return [caseValue(p.value), la.block] as [number, Block];
    }));
    for (const la of literalArms) {
      b.position(la.block);
      const armTerminated = ctx.emitMatchArmBody(lines, la.arm.body, resultSlot);
      if (!armTerminated) { b.br(endBlock); allArmsTerminated = false; }
    }
    b.position(defaultBlock);
    if (wildcardArm) {
      const wcTerminated = ctx.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
      if (!wcTerminated) { b.br(endBlock); allArmsTerminated = false; }
    } else {
      b.unreachable();
    }
    b.position(endBlock);
    if (allArmsTerminated) b.unreachable();
    return [lines, allArmsTerminated];
  }

  // chain: compare → arm body or fall through to next comparison
  for (let i = 0; i < literalArms.length; i++) {
    const next = i + 1 < literalArms.length
      ? b.newBlock("match.cmp")
      : wildcardArm
        ? b.newBlock("match.wildcard")
        : b.newBlock("match.default");
    literalArms[i].nextBlock = next;

    const pat = literalArms[i].arm.pattern;
    if (pat.kind !== "LiteralPattern") continue;

    let cmp: Val;
    if (pat.literalKind === "string") {
      ctx.hasStringType = true;
      const litStr = ctx.addString(String(pat.value));
      const lit0 = b.insertvalue(val("undef", STRING), val(litStr.label, Ty.ptr), 0);
      const lit = b.insertvalue(lit0, val(String(litStr.length - 1), Ty.i64), 1);
      const [, cmpResult] = genStringCmp(ctx, lines, subjVal, lit.ref, true);
      cmp = val(cmpResult, Ty.i1);
    } else if (pat.literalKind === "bool") {
      cmp = b.icmp("eq", subj, val(pat.value ? "1" : "0", Ty.i1));
    } else if (pat.literalKind === "int" || pat.literalKind === "char") {
      cmp = b.icmp("eq", subj, val(String(pat.value), subj.ty));
    } else {
      // float
      const fval = Number.isInteger(pat.value as number) ? (pat.value as number).toFixed(1) : String(pat.value);
      cmp = b.fcmp("oeq", subj, val(fval, subj.ty));
    }

    b.condBr(cmp, literalArms[i].block, next);

    // arm body
    b.position(literalArms[i].block);
    const armTerminated = ctx.emitMatchArmBody(lines, literalArms[i].arm.body, resultSlot);
    if (!armTerminated) b.br(endBlock);
    if (!armTerminated) allArmsTerminated = false;

    // next comparison block (or wildcard/default)
    if (i + 1 < literalArms.length) {
      b.position(next);
    }
  }

  // wildcard or default
  const lastNext = literalArms.length > 0 ? literalArms[literalArms.length - 1].nextBlock! : b.newBlock("match.wildcard");
  if (wildcardArm) {
    if (literalArms.length === 0) {
      b.br(lastNext);
    }
    b.position(lastNext);
    const wcTerminated = ctx.emitMatchArmBody(lines, wildcardArm.body, resultSlot);
    if (!wcTerminated) b.br(endBlock);
    if (!wcTerminated) allArmsTerminated = false;
  } else {
    if (literalArms.length === 0) {
      b.br(lastNext);
    }
    b.position(lastNext);
    b.unreachable();
  }

  b.position(endBlock);
  if (allArmsTerminated) b.unreachable();
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
