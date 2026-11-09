// Census of writes to AST nodes after the parser: every assignment or mutating call in the frontend whose
// target is a property declared in src/ast.ts, as scripts/ts2milo/written-props.ts sees it (the same scan
// that decides whether the generated Milo frontend may copy a node). The AST is meant to be immutable once
// parsed, so the number for the checker and later stages is the one to drive to zero.
//   bun scripts/ast-writes.ts            every write site, grouped by stage, and the totals
//   bun scripts/ast-writes.ts --check    exit 1 when a stage after the resolver writes a node
import { join, relative } from "path";
import { frontendFiles } from "./ts-portable";
import { makeProgram } from "./ts2milo/subset";
import { buildImmutability, type WriteSite } from "./ts2milo/written-props";

const ROOT = join(import.meta.dir, "..");

export type AstWrite = { stage: string; file: string; line: number; prop: string; text: string };

const stageOf = (f: string): string => (/\/(tokens|lexer|parser(-.*)?)\.ts$/.test(f) ? "parse" : /\/resolver\.ts$/.test(f) ? "resolve" : /\/(checker(-.*)?|mutability-scan)\.ts$/.test(f) ? "check" : /\/(backend-program|emit-.*|mlir-.*|scaffold)\.ts$/.test(f) ? "emit" : "any");

export function astWrites(): AstWrite[] {
  const files = frontendFiles().map((f) => join(ROOT, f));
  const program = makeProgram(ROOT, files);
  const sites: WriteSite[] = [];
  buildImmutability(program, program.getTypeChecker(), files, sites);
  const astFile = program.getSourceFile(join(ROOT, "src/ast.ts"))!.fileName;
  const seen = new Set<string>();
  const out: AstWrite[] = [];
  for (const { decl, at } of sites) {
    if (decl.getSourceFile().fileName !== astFile) continue;
    const sf = at.getSourceFile();
    const stage = stageOf(sf.fileName);
    if (stage === "parse") continue;
    const owner = (decl.parent as { name?: { getText(): string } }).name?.getText() ?? "";
    const prop = `${owner ? owner + "." : ""}${(decl as { name?: { getText(): string } }).name?.getText() ?? "?"}`;
    const line = sf.getLineAndCharacterOfPosition(at.getStart()).line + 1;
    const key = `${sf.fileName}:${at.pos}:${prop}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ stage, file: relative(ROOT, sf.fileName), line, prop, text: at.getText().replace(/\s+/g, " ").slice(0, 80) });
  }
  return out.sort((a, b) => a.stage.localeCompare(b.stage) || a.file.localeCompare(b.file) || a.line - b.line || a.prop.localeCompare(b.prop));
}

if (import.meta.main) {
  const writes = astWrites();
  const sitesOf = (stage: string) => new Set(writes.filter((w) => w.stage === stage).map((w) => `${w.file}:${w.line}`)).size;
  let last = "";
  for (const w of writes) {
    const at = `${w.file}:${w.line}`;
    // One line per write site: a whole-node write names every property of the node, which is noise here.
    if (at === last) continue;
    last = at;
    const props = writes.filter((x) => `${x.file}:${x.line}` === at).map((x) => x.prop);
    console.log(`${w.stage.padEnd(8)} ${at.padEnd(34)} ${props.length > 3 ? `${props.length} properties` : props.join(", ")}   ${w.text}`);
  }
  const stages = ["resolve", "check", "emit", "any"];
  console.log(stages.map((s) => `${s} ${sitesOf(s)}`).join(", "));
  const late = sitesOf("check") + sitesOf("emit") + sitesOf("any");
  console.log(`AST WRITE SITES AFTER THE RESOLVER: ${late}`);
  if (process.argv.includes("--check") && late > 0) process.exit(1);
}
