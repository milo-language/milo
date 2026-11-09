// Sorts every closure in the frontend files by how hard it is to make portable, using the
// TypeScript checker's symbols for what each one captures (scripts/ts-portable.ts only counts
// them). The hard tier is the number that decides the TS -> Milo port (docs/plans/ts2milo.md).
//   bun scripts/ts-closure-tiers.ts              table: tier counts per file
//   bun scripts/ts-closure-tiers.ts --list hard  every closure in one tier, with file:line
//
// Tiers, cheapest first:
//   loop     a read-only callback to an array method (map, filter, some, ...): becomes a for loop
//   hoist    captures nothing: becomes a top-level function
//   param    captures only locals that are never reassigned and never mutated through: pass them in
//   method   reads `this` but writes nothing through it: becomes a method
//   this-cb  reads `this` and is passed as an argument: hard if a method it calls writes `this`
//            (calls are not followed), so count it with hard as the upper bound
//   snapshot reads a local that is reassigned elsewhere: correct as a parameter only if the
//            closure runs before the next reassignment (each one needs a look)
//   helper   a local `const f = (...) => ...` that writes captured state: becomes a function
//            taking that state as `&mut` params
//   hard     a callback passed elsewhere or stored that writes captured state (a let, a field,
//            a push/set on a captured value): the redesign tier
// An array-method callback is `loop` even when it writes: a for loop body may write outer state.
import ts from "typescript";
import { join } from "path";
import { makeProgram } from "./ts2milo/subset";
import { frontendFiles } from "./ts-portable";

const ROOT = join(import.meta.dir, "..");
const TIERS = ["loop", "hoist", "param", "method", "this-cb", "snapshot", "helper", "hard"] as const;
type Tier = typeof TIERS[number];
const ARRAY_METHODS = new Set(["map", "filter", "some", "every", "forEach", "find", "findIndex", "reduce", "flatMap", "sort"]);
// Calls that change their receiver: a closure calling one on a captured value writes captured state.
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "set", "add", "delete", "clear", "sort", "reverse", "fill"]);

export interface Closure { file: string; line: number; tier: Tier; why: string }

export function classify(files: string[]): Closure[] {
  const program = makeProgram(ROOT, files.map((f) => join(ROOT, f)));
  const checker = program.getTypeChecker();
  const out: Closure[] = [];
  for (const f of files) {
    const sf = program.getSourceFile(join(ROOT, f))!;
    // A symbol is reassigned when any assignment anywhere in the file targets it.
    const reassigned = new Set<ts.Symbol>();
    const noteTarget = (t: ts.Expression) => {
      if (ts.isIdentifier(t)) { const s = checker.getSymbolAtLocation(t); if (s) reassigned.add(s); }
    };
    const scanAssign = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) noteTarget(n.left);
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) noteTarget(n.operand);
      ts.forEachChild(n, scanAssign);
    };
    scanAssign(sf);

    const visit = (n: ts.Node): void => {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) out.push({ file: f, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, ...tierOf(n) });
      ts.forEachChild(n, visit);
    };
    const tierOf = (fn: ts.ArrowFunction | ts.FunctionExpression): { tier: Tier; why: string } => {
      const captured = new Set<ts.Symbol>();
      let readsThis = false;
      let why = "";
      const inside = (d: ts.Node) => d.getSourceFile() === sf && d.pos >= fn.pos && d.end <= fn.end;
      // Module-level and imported names are globals, not captures.
      const isLocal = (s: ts.Symbol) => (s.declarations ?? []).some((d) => d.getSourceFile() === sf && !inside(d) && !isModuleLevel(d));
      const rootSym = (e: ts.Expression): ts.Symbol | "this" | null => {
        while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
        if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
        if (ts.isIdentifier(e)) { const s = checker.getSymbolAtLocation(e); return s && isLocal(s) ? s : null; }
        return null;
      };
      const writes = (target: ts.Expression, what: string) => {
        const r = rootSym(target);
        if (r && !why) why = `${what} ${target.getText(sf).slice(0, 40)}`;
        return r !== null;
      };
      let hard = false, readsReassigned = "";
      const walk = (n: ts.Node): void => {
        if (n.kind === ts.SyntaxKind.ThisKeyword) readsThis = true;
        if (ts.isIdentifier(n)) {
          const s = checker.getSymbolAtLocation(n);
          if (s && isLocal(s)) { captured.add(s); if (reassigned.has(s) && !readsReassigned) readsReassigned = n.text; }
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && writes(n.left, "assigns")) hard = true;
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && writes(n.operand, "increments")) hard = true;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text) && writes(n.expression.expression, `${n.expression.name.text}s`)) hard = true;
        // Writes inside a nested closure count against this one too: it carries them.
        ts.forEachChild(n, walk);
      };
      walk(fn.body);
      const p = fn.parent;
      if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ARRAY_METHODS.has(p.expression.name.text) && p.arguments.includes(fn)) return { tier: "loop", why: p.expression.name.text };
      if (hard) return { tier: ts.isVariableDeclaration(p) ? "helper" : "hard", why };
      if (readsReassigned) return { tier: "snapshot", why: `reads ${readsReassigned}` };
      if (readsThis) return ts.isCallExpression(p) && p.arguments.includes(fn) ? { tier: "this-cb", why: p.expression.getText(sf).slice(0, 40) } : { tier: "method", why: "this" };
      if (captured.size === 0) return { tier: "hoist", why: "" };
      return { tier: "param", why: [...captured].map((s) => s.name).slice(0, 4).join(", ") };
    };
    visit(sf);
  }
  return out;
}

function isModuleLevel(d: ts.Node): boolean {
  let n: ts.Node = d;
  while (n.parent && !ts.isSourceFile(n.parent)) {
    if (ts.isFunctionLike(n.parent) || ts.isClassLike(n.parent) || ts.isBlock(n.parent)) return false;
    n = n.parent;
  }
  return true;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const all = classify(frontendFiles());
  const listTier = args.includes("--list") ? args[args.indexOf("--list") + 1] : null;
  if (listTier) {
    for (const c of all.filter((c) => c.tier === listTier)) console.log(`${c.file}:${c.line}: ${c.why}`);
  } else {
    const by = new Map<string, Record<Tier, number>>();
    for (const c of all) {
      const r = by.get(c.file) ?? Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
      r[c.tier]++;
      by.set(c.file, r);
    }
    const total = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
    console.log(["file".padEnd(34), ...TIERS.map((t) => t.padStart(9))].join(""));
    for (const [f, r] of [...by].sort((a, b) => b[1].hard - a[1].hard)) {
      console.log([f.padEnd(34), ...TIERS.map((t) => String(r[t]).padStart(9))].join(""));
      for (const t of TIERS) total[t] += r[t];
    }
    console.log(["total".padEnd(34), ...TIERS.map((t) => String(total[t]).padStart(9))].join(""));
  }
}
