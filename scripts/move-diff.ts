#!/usr/bin/env bun
// Shadow gate for src/move-flow.ts (docs/plans/move-dataflow.md): checks each program in-process and
// compares the dataflow pass's move-or-share decision for every string move position with the
// checker's own (movedExprs / sharedStringExprs). "old move, new share" is a place the checker moves
// although a later read needs it, the class of 23ddb7ac; "old share, new move" is a share the
// dataflow finds unnecessary or one the checker takes for a local reason (a borrow, a global).
// Per program it also compares use-after-move: the checker's flow errors (use of a moved variable,
// a move out of a loop) against the dataflow's reports. Rejected programs are compared too.
//   bun scripts/move-diff.ts [files or dirs...] [--show N]   (default: tests/fixtures tests/errors)
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { moveFlow } from "../src/move-flow";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const showAt = argv.indexOf("--show");
const show = showAt >= 0 ? Number(argv[showAt + 1]) : 15;
const inputs = argv.filter((a, i) => !a.startsWith("--") && (showAt < 0 || i !== showAt + 1));
const files: string[] = [];
for (const a of inputs.length ? inputs : [join(ROOT, "tests/fixtures"), join(ROOT, "tests/errors")]) {
  if (statSync(a).isDirectory()) for (const f of readdirSync(a).sort()) { if (f.endsWith(".milo")) files.push(join(a, f)); }
  else files.push(a);
}

const tally = { checked: 0, rejected: 0, crashed: 0, same: 0, oldMoveNewShare: 0, oldShareNewMove: 0, oldNone: 0, uamAgree: 0, uamOnlyOld: 0, uamOnlyNew: 0 };
const FLOW_ERROR = /use of moved|out of a loop|used after its source|was already moved out of it|is incomplete/;
const cases: { kind: string; at: string; text: string }[] = [];
for (const path of files) {
  const src = readFileSync(path, "utf-8");
  let cr;
  let program;
  const tc = new TypeChecker();
  try {
    program = resolveImports(new Parser(new Lexer(src).tokenize(), src, path).parse(), dirname(path), getHostTarget(), path);
    cr = tc.check(program);
  } catch { tally.crashed++; continue; }
  let flow;
  try { flow = moveFlow(program, cr, { isCopy: t => tc.isCopyType(t) }); } catch (e) { tally.crashed++; cases.push({ kind: "move-flow crash", at: relative(ROOT, path), text: String(e).slice(0, 90) }); continue; }
  const oldFlow = cr.diagnostics.some(d => d.severity === "error" && FLOW_ERROR.test(d.message));
  const newFlow = flow.useAfterMove.length > 0;
  if (oldFlow && newFlow) tally.uamAgree++;
  else if (oldFlow) { tally.uamOnlyOld++; cases.push({ kind: "use after move: checker only", at: relative(ROOT, path), text: cr.diagnostics.find(d => FLOW_ERROR.test(d.message))!.message.slice(0, 90) }); }
  else if (newFlow) {
    tally.uamOnlyNew++;
    const u = flow.useAfterMove[0]!;
    cases.push({ kind: "use after move: dataflow only", at: `${relative(ROOT, u.use.span?.file ?? path)}:${u.use.span?.line}`, text: `${u.place} moved at line ${u.movedAt.span?.line}` });
  }
  if (cr.diagnostics.some(d => d.severity === "error")) { tally.rejected++; continue; }
  tally.checked++;
  for (const [e, now] of flow.stringDecisions) {
    const was = cr.movedExprs.has(e) ? "move" : cr.sharedStringExprs.has(e) ? "share" : "none";
    if (was === now) { tally.same++; continue; }
    const file = e.span?.file ?? path;
    const at = `${relative(ROOT, file)}:${e.span?.line ?? "?"}:${e.span?.col ?? "?"}`;
    const text = e.span ? (readFileSync(file, "utf-8").split("\n")[e.span.line - 1] ?? "").trim().slice(0, 90) : "";
    if (was === "none") tally.oldNone++;
    else if (was === "move") { tally.oldMoveNewShare++; cases.push({ kind: "old move, new share", at, text }); }
    else { tally.oldShareNewMove++; cases.push({ kind: "old share, new move", at, text }); }
  }
}
console.log(JSON.stringify(tally));
for (const kind of ["move-flow crash", "use after move: checker only", "use after move: dataflow only", "old move, new share", "old share, new move"]) {
  const ks = cases.filter(c => c.kind === kind);
  if (ks.length) console.log(`${kind} (${ks.length}):\n  ${ks.slice(0, show).map(c => `${c.at}  ${c.text}`).join("\n  ")}`);
}
