#!/usr/bin/env bun
// Two-way trace between the written semantics (docs/semantics/milo.md) and the reference
// interpreter (src/interp*.ts), so neither can drift from the other unseen:
//   (a) every rule ID the doc defines is cited by at least one interpreter function;
//   (b) every interpreter function cites a rule, or is in ALLOW below with a reason (plumbing);
//   (c) every rule ID is exercised by a test: its ID appears in a test title in
//       tests/interp*.test.ts, or a fixture carries a `// @rule: ID` line;
//   (d) every ID the interpreter cites is defined in the doc (a typo or a deleted rule fails).
// A function "cites" a rule with `// [RULE-ID]` or `// RULE-ID` in a comment on the lines right
// above it or anywhere in its body, or by naming it in code (`stuck("R-MEM-OOB", ...)`). Rule IDs are the E-, S-, T- and R- ones; MILO-O-* names
// belong to docs/spec.md and are not traced here.
//
//   bun scripts/trace-semantics.ts            # check the real tree, exit 1 on any gap
//   bun scripts/trace-semantics.ts --list     # also print the rule -> functions map
//
// It cannot pass vacuously: fewer than 50 rules or 150 functions parsed is itself a failure
// (a parser that stopped matching would otherwise report "0 gaps").
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
// `R-TASK-*` names a family, not a rule: the lookahead keeps its prefix from matching
const ID_RE = /\b(?:[EST]-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*|R-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\b(?!-\*)/g;

// Functions that carry no semantics of their own: the host-side plumbing the rules do not describe.
// Keyed `file:function`; the reason is the point, a bare entry is not accepted.
export const ALLOW: Record<string, string> = {
  "interp.ts:unsupported": "reports InterpUnsupported, the interpreter's own limit; no Milo rule",
  "interp.ts:structFields": "type-table lookup for a struct's field list",
  "interp.ts:isLen": "syntactic probe on an expression, no run-time effect",
  "interp.ts:isPlaceExpr": "syntactic probe on an expression, no run-time effect",
  "interp.ts:chain": "syntactic walk of a field/index chain, no run-time effect",
  "interp.ts:equal": "structural equality of two values, no ownership effect",
  "interp.ts:floatOp": "IEEE arithmetic on f32/f64, no ownership or failure semantics",
  "interp.ts:wrapInt": "integer width wrap helper; the overflow decision is intOp's",
  "interp.ts:cmpBytes": "byte-string ordering helper for string comparison",
  "interp.ts:litEq": "literal-pattern equality helper for match arms",
  "interp.ts:describe": "formats a value for stuck messages",
  "interp.ts:describeExpr": "formats an expression for stuck messages",
  "interp-natives.ts:natSort": "NaN-safe stable sort helper behind Vec.sort",
  "interp-natives.ts:natCmp": "ordering of two values for sort and min/max natives",
  "interp-natives.ts:nativeFor": "native table lookup by name",
  "interp-natives.ts:renderParts": "formats print arguments into text, no rule beyond the output order",
  "interp-co.ts:swapIn": "switches the shared interpreter's frame stacks to a task, host plumbing",
  "interp-co.ts:swapOut": "switches the shared interpreter's frame stacks out of a task, host plumbing",
  "interp-co-natives.ts:taskNativeFor": "task native table lookup by name",
  "interp-co-natives.ts:lookup": "task native table lookup by name",
  "interp-run.ts:writeAll": "host stdout/stderr write, plumbing",
  "interp-run.ts:interpOptions": "parses the command-line flags",
  "interp-values.ts:fmtFloat": "float to text, the format print uses",
  "interp-sys.ts:unmodelled": "builds the InterpUnsupported message for an extern the C layer does not model",
  "interp-sys.ts:callExtern": "dispatch by C symbol; each handler in the table cites its rule",
};

export interface Fn { file: string; name: string; line: number; ids: string[] }
export interface Report { problems: string[]; rules: string[]; fns: Fn[]; cited: Map<string, string[]> }

export function parseRules(md: string): string[] {
  const out = new Set<string>();
  for (const line of md.split("\n")) {
    const b = /^\[([EST]-[A-Z][A-Z0-9-]*|R-[A-Z][A-Z0-9-]*)\]/.exec(line);
    if (b) out.add(b[1]!);
    const t = /^\| ((?:[EST]|R)-[A-Z][A-Za-z0-9-]*(?:, (?:[EST]|R)-[A-Z][A-Za-z0-9-]*)*) \|/.exec(line);
    if (t) for (const id of t[1]!.split(", ")) out.add(id);
  }
  return [...out];
}

export const MODULE = "<module-level>";
const idsIn = (text: string): string[] => text.match(ID_RE) ?? [];

// Functions of one interpreter file: top-level `function`s and the 2-space-indented methods of a
// class (the layout the generator scripts/gen-interp-co.ts also relies on). Each carries the rule
// IDs in comments directly above its head or inside its body.
export function parseFns(file: string, src: string): Fn[] {
  const lines = src.split("\n");
  const fns: Fn[] = [];
  const inFn: boolean[] = [];
  const head = /^(?:export )?(?:async )?function\*? ?([A-Za-z_$][\w$]*)|^  (?:private |static |async |get |set )?\*?([A-Za-z_$][\w$]*)(?:<[^>]*>)?\(.*\{\s*$|^  ([A-Za-z_$][\w$]*)\(.*\) \{.*\}\s*$/;
  const notHead = /^  (?:if|for|while|switch|return|else|catch|do)\b/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const m = head.exec(l);
    if (!m || notHead.test(l)) continue;
    const name = (m[1] ?? m[2] ?? m[3])!;
    if (name === "constructor") continue; // sets fields up; it has no semantics of its own
    const top = !l.startsWith(" ");
    let end = i;
    if (!/\}\s*$/.test(l) || /\{\s*$/.test(l)) { end = i + 1; while (end < lines.length && !(top ? lines[end] === "}" : /^  \}[,;]?$/.test(lines[end]!))) end++; }
    let pre = "";
    for (let k = i - 1; k >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[k]!); k--) pre += lines[k] + "\n";
    fns.push({ file, name, line: i + 1, ids: [...new Set(idsIn(pre + lines.slice(i, end + 1).join("\n")))] });
    for (let k = i; k <= end; k++) inFn[k] = true;
    i = end;
  }
  // Dispatch tables and other module-level code (the native tables, the extern table) cite rules
  // too; they count for (a) as one pseudo-function per file but are not held to (b).
  const rest = lines.filter((_, k) => !inFn[k]).join("\n");
  fns.push({ file, name: MODULE, line: 0, ids: [...new Set(idsIn(rest))] });
  return fns;
}

// Titles of the tests in a bun test file: the first string argument of each `test(`.
export function testTitles(src: string): string[] {
  return [...src.matchAll(/^\s*test(?:\.\w+)?\(\s*(?:`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gm)].map(m => m[1] ?? m[2] ?? m[3] ?? "");
}

function fixtureTags(dirs: string[]): Set<string> {
  const tags = new Set<string>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".milo")) continue;
      for (const m of readFileSync(join(d, f), "utf-8").matchAll(/^\/\/ @rule: ?(.*)$/gm)) for (const id of idsIn(m[1]!)) tags.add(id);
    }
  }
  return tags;
}

export function trace(opts: { doc: string; srcDir: string; testFiles: string[]; fixtureDirs: string[]; allow?: Record<string, string> }): Report {
  const allow = opts.allow ?? ALLOW;
  const problems: string[] = [];
  const rules = parseRules(readFileSync(opts.doc, "utf-8"));
  const defined = new Set(rules);
  const fns: Fn[] = [];
  for (const f of readdirSync(opts.srcDir).sort()) {
    if (!/^interp.*\.ts$/.test(f) || f === "interp-gen.ts") continue; // interp-gen.ts is generated twins of interp.ts
    fns.push(...parseFns(f, readFileSync(join(opts.srcDir, f), "utf-8")));
  }
  const cited = new Map<string, string[]>();
  for (const fn of fns) for (const id of fn.ids) (cited.get(id) ?? cited.set(id, []).get(id)!).push(`${fn.file}:${fn.name}`);

  for (const [k, why] of Object.entries(allow)) {
    if (!why.trim()) problems.push(`(b) allowlist entry ${k} has no reason`);
    if (!fns.some(f => `${f.file}:${f.name}` === k)) problems.push(`(b) allowlist entry ${k} names no function (stale)`);
    else if (fns.some(f => `${f.file}:${f.name}` === k && f.ids.length)) problems.push(`(b) ${k} cites a rule now, so drop it from the allowlist`);
  }
  for (const id of rules) if (!cited.has(id)) problems.push(`(a) rule ${id} is defined in the doc but no interpreter function cites it`);
  for (const fn of fns) if (fn.name !== MODULE && !fn.ids.length && !allow[`${fn.file}:${fn.name}`]) problems.push(`(b) ${fn.file}:${fn.line} ${fn.name} cites no rule and is not allowlisted`);
  for (const id of cited.keys()) if (!defined.has(id)) problems.push(`(d) ${cited.get(id)![0]} cites ${id}, which the doc does not define`);

  const tested = new Set<string>(fixtureTags(opts.fixtureDirs));
  for (const f of opts.testFiles) for (const t of testTitles(readFileSync(f, "utf-8"))) for (const id of idsIn(t)) tested.add(id);
  for (const id of rules) if (!tested.has(id)) problems.push(`(c) rule ${id} is exercised by no test title in tests/interp*.test.ts and no fixture \`// @rule:\` tag`);

  if (rules.length < 50) problems.push(`parsed only ${rules.length} rules from the doc (the parser stopped matching?)`);
  if (fns.length < 150) problems.push(`parsed only ${fns.length} interpreter functions (the parser stopped matching?)`);
  return { problems, rules, fns, cited };
}

export const realTree = () => ({
  doc: join(ROOT, "docs", "semantics", "milo.md"),
  srcDir: join(ROOT, "src"),
  testFiles: readdirSync(join(ROOT, "tests")).filter(f => /^interp.*\.test\.ts$/.test(f)).sort().map(f => join(ROOT, "tests", f)),
  fixtureDirs: [join(ROOT, "tests", "fixtures"), join(ROOT, "mlir", "test", "programs")],
});

if (import.meta.main) {
  const r = trace(realTree());
  if (process.argv.includes("--list")) for (const id of r.rules) console.log(`${id}: ${(r.cited.get(id) ?? []).join(", ")}`);
  for (const p of r.problems) console.log(p);
  console.log(`trace-semantics: ${r.rules.length} rules, ${r.fns.length} functions, ${r.problems.length} gaps`);
  process.exit(r.problems.length ? 1 : 0);
}
