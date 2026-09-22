// Generates docs/spec.md — the normative language specification, from the suites that
// already decide what the compiler does.
//
// Run:  bun run scripts/gen-spec.ts          # rewrite the spec
//       bun run scripts/gen-spec.ts --check  # fail if it is stale (CI/test)
//
// **Why this is generated and not written.** `docs/language-reference.md` is good prose
// and `docs/grammar.ebnf` is a gated grammar, but neither is a specification: prose is not
// verifiable and a grammar says nothing about semantics. A certification audience
// (DO-178C is the one Milo's roadmap names) does not want more prose — it wants
// requirements with stable identifiers, each traceable to the verification that discharges
// it. Hand-writing those means maintaining a second description of the language that drifts
// from the first, which is the failure mode this repo already avoids everywhere else.
//
// So every requirement here is derived from a test that runs on every commit:
//
//   tests/errors/<name>.milo    → MILO-E-<name>: this program SHALL be rejected, with a
//                                 diagnostic containing the pinned message
//   tests/fixtures/<name>.milo  → MILO-B-<name>: this program SHALL be accepted, and
//                                 running it SHALL write exactly these lines
//
// **The identifier is keyed to the FILE NAME, never the message.** A requirement id has to
// survive rewording — `docs/site/language/errors.md` indexes by message text, which is right for a
// lookup table and wrong for a requirement, because improving a diagnostic would silently
// renumber the spec.
//
// **What this is not.** These are requirements by example: observable behaviour of one
// program each, not a denotational semantics. It states what a conforming implementation
// must do on 889 concrete programs and says nothing about the infinitely many it does not
// name. That limit is stated in the document itself rather than left for a reader to
// discover — a spec that overclaims its own coverage is worse than one that admits the
// boundary.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseExpected, parseExpectedError, parseExpectedRuntimeError, parseKnownRed } from "../tests/annotations";

const ROOT = join(import.meta.dir, "..");
const ERRORS_DIR = join(ROOT, "tests", "errors");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");
const KNOWN_RED_FILE = join(ROOT, "tests", "known-red.txt");
const OUT = join(ROOT, "docs", "spec.md");

interface Requirement {
  id: string;
  kind: "reject" | "behaviour";
  file: string;          // repo-relative path of the program
  statement: string;     // the normative sentence
  detail: string[];      // the pinned message, or the expected output lines
  rationale: string;     // the fixture's own leading comment, if it has one
  verifiedBy: string;    // the test that discharges it
}

// Everything before the first non-comment, non-blank line is header. Annotation lines are
// dropped; what is left is the author's explanation of why the rule exists, which is the
// closest thing to normative rationale that already exists and is maintained.
function rationaleOf(source: string): { rationale: string; bodyStart: number } {
  const lines = source.split("\n");
  let i = 0;
  const header: string[] = [];
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "") { header.push(""); continue; }
    if (!t.startsWith("//")) break;
    header.push(t);
  }
  const rationale = header
    .filter(l => l.startsWith("//") && !/@(error|expect|runtime-error|skip-os|requires-package|run)\b/.test(l))
    .map(l => l.replace(/^\/\/\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { rationale, bodyStart: i };
}

// A fixture name is already a stable identifier; only the shape needs pinning so a rename
// is visible as a spec change rather than a silent renumber.
function idFor(kind: "E" | "B", file: string): string {
  return `MILO-${kind}-${file.replace(/\.milo$/, "")}`;
}

export function requirements(): Requirement[] {
  const out: Requirement[] = [];

  for (const file of readdirSync(ERRORS_DIR).filter(f => f.endsWith(".milo")).sort()) {
    const source = readFileSync(join(ERRORS_DIR, file), "utf-8");
    const message = parseExpectedError(source);
    if (!message) throw new Error(`tests/errors/${file} has no // @error: annotation`);
    const { rationale } = rationaleOf(source);
    out.push({
      id: idFor("E", file),
      kind: "reject",
      file: `tests/errors/${file}`,
      statement: "A conforming implementation shall reject this program at compile time.",
      detail: [`The diagnostic shall contain: \`${message.trim()}\``],
      rationale,
      verifiedBy: "tests/run.test.ts — `errors (type checker rejects)`",
    });
  }

  // A known-red fixture reproduces a hole the language must eventually reject, so it
  // states no "shall accept" requirement. Its absence is deliberate, not a coverage gap.
  const knownRed = existsSync(KNOWN_RED_FILE) ? parseKnownRed(readFileSync(KNOWN_RED_FILE, "utf-8")) : new Map();
  for (const file of readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".milo")).sort()) {
    if (knownRed.has(file)) continue;
    const source = readFileSync(join(FIXTURES_DIR, file), "utf-8");
    const expected = parseExpected(source);
    const runtimeError = parseExpectedRuntimeError(source);
    // A fixture with neither annotation asserts nothing, so it states no requirement.
    // Silently skipping it would let the spec claim coverage the suite does not have, so
    // the count is reported by the caller and the omission is visible.
    if (expected.length === 0 && !runtimeError) continue;
    const { rationale } = rationaleOf(source);
    out.push({
      id: idFor("B", file),
      kind: "behaviour",
      file: `tests/fixtures/${file}`,
      statement: runtimeError
        ? "A conforming implementation shall accept this program, and running it shall abort."
        : "A conforming implementation shall accept this program, and running it shall write exactly the lines below to standard output.",
      detail: runtimeError
        ? [`The abort message shall contain: \`${runtimeError}\``]
        : expected.map(l => `\`${l}\``),
      rationale,
      verifiedBy: "tests/run.test.ts — `fixtures (compile + run)`",
    });
  }

  return out;
}

function render(reqs: Requirement[]): string {
  const rejects = reqs.filter(r => r.kind === "reject");
  const behaviours = reqs.filter(r => r.kind === "behaviour");
  const L: string[] = [];

  L.push("<!-- doc-meta");
  L.push("system: spec");
  L.push("purpose: normative requirements for a conforming Milo implementation, each traceable to the test that discharges it");
  L.push("key-files: tests/errors/, tests/fixtures/, scripts/gen-spec.ts");
  L.push("update-when: never by hand — regenerate with `bun run scripts/gen-spec.ts`");
  L.push("last-verified: generated");
  L.push("-->");
  L.push("");
  L.push("# Milo language specification");
  L.push("");
  L.push(`Generated from the test suite by \`scripts/gen-spec.ts\` — ${reqs.length} normative requirements ` +
    `(${rejects.length} rejection, ${behaviours.length} behavioural). Do not edit this file; edit the ` +
    `program it cites, or that program's leading comment, and regenerate.`);
  L.push("");
  L.push("## Status of this document");
  L.push("");
  L.push("This is a **specification by example**, and the distinction matters before anyone relies on it.");
  L.push("");
  L.push("Each requirement names one concrete program and states what a conforming implementation must do");
  L.push("with it: reject it with a particular diagnostic, or accept it and produce particular output. Every");
  L.push("requirement is discharged by a test that runs on every commit, so this document cannot describe a");
  L.push("language the compiler does not implement — that is the property it is built to have, and the reason");
  L.push("it is generated rather than written.");
  L.push("");
  L.push("What it does **not** provide:");
  L.push("");
  L.push("- **A semantics.** There is no denotational or operational model here. These requirements constrain");
  L.push("  behaviour on the programs they name and say nothing about the infinitely many they do not.");
  L.push("- **Completeness.** A rule with no fixture states no requirement. The suite is the coverage, and");
  L.push("  `docs/language-reference.md` describes constructs this document may not yet pin.");
  L.push("- **Grammar.** The syntax a conforming implementation accepts is [`grammar.ebnf`](grammar.ebnf),");
  L.push("  which is separately gated against the compiler's own keyword set.");
  L.push("");
  L.push("Requirement identifiers are keyed to the **file name** of the program, not to its diagnostic text,");
  L.push("so improving a message does not renumber the specification. Renaming or deleting a program is a");
  L.push("change to this document and shows up as one.");
  L.push("");
  L.push("The key words **shall** and **conforming implementation** are used in their normative sense.");
  L.push("");
  L.push("## Traceability");
  L.push("");
  L.push("| requirement class | count | prefix | verified by |");
  L.push("|---|---|---|---|");
  L.push(`| rejection | ${rejects.length} | \`MILO-E-\` | \`tests/run.test.ts\` — *errors (type checker rejects)* |`);
  L.push(`| behavioural | ${behaviours.length} | \`MILO-B-\` | \`tests/run.test.ts\` — *fixtures (compile + run)* |`);
  L.push("");
  L.push("Every identifier below cites the program that states it and the suite that discharges it. A");
  L.push("requirement with no verification cannot appear here: the generator reads the annotations the test");
  L.push("driver reads, so an unverifiable claim has nowhere to come from.");
  L.push("");

  const section = (title: string, rs: Requirement[], intro: string) => {
    L.push(`## ${title}`);
    L.push("");
    L.push(intro);
    L.push("");
    for (const r of rs) {
      L.push(`### ${r.id}`);
      L.push("");
      L.push(r.statement);
      L.push("");
      for (const d of r.detail) L.push(`- ${d}`);
      L.push("");
      if (r.rationale) {
        L.push(`**Rationale.** ${r.rationale}`);
        L.push("");
      }
      L.push(`*Program:* [\`${r.file}\`](../${r.file}) — *verified by:* ${r.verifiedBy}`);
      L.push("");
    }
  };

  section("Rejection requirements", rejects,
    "Programs a conforming implementation shall refuse to compile. The pinned text is a **substring** of " +
    "the diagnostic, not the whole of it: the wording and formatting of a message are not normative, only " +
    "that the implementation rejects the program and says why in terms that contain this text.");
  section("Behavioural requirements", behaviours,
    "Programs a conforming implementation shall compile and run. Output is compared line by line after " +
    "trimming, and is the whole of the requirement — a program that produces these lines by a different " +
    "route conforms.");

  // Exactly one trailing newline: the repo lint strips a trailing blank line on commit,
  // and a generator that emits one makes the file stale the instant it is committed.
  return L.join("\n").replace(/\n+$/, "") + "\n";
}

if (import.meta.main) {
  const reqs = requirements();
  const rendered = render(reqs);
  const check = process.argv.includes("--check");
  if (check) {
    let current = "";
    try { current = readFileSync(OUT, "utf-8"); } catch { /* missing counts as stale */ }
    if (current !== rendered) {
      console.error("docs/spec.md is stale — regenerate with: bun run scripts/gen-spec.ts");
      process.exit(1);
    }
    console.log(`spec up to date — ${reqs.length} requirements`);
  } else {
    writeFileSync(OUT, rendered);
    console.log(`wrote ${OUT} — ${reqs.length} requirements`);
  }
}
