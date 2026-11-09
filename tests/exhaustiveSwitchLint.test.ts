// No switch over an AST or HIR node union may fall out of the switch silently.
//
// This exists because the same bug was found six times in two days, in unrelated places,
// and every instance reported SUCCESS: a prover walker that never descended into
// expressions proved `ensures result == 0` for a function returning 100; the contract gate
// silently skipped 11 files; `safety.ts` passed a DO-178C DAL A profile on an `unsafe`
// block inside `let .. else`; the cyclomatic-complexity counter measured a function 35%
// over the DAL A bound as complexity 2; `wcet.ts` emitted flow facts describing a bounded
// program that contained an unbounded loop; and the JS backend dropped statements it had
// no arm for. None of them failed a test — a walker that does not look finds nothing, and
// finding nothing reads as "nothing wrong".
//
// The rule is deliberately about SILENCE, not exhaustiveness. Plenty of these switches are
// partial on purpose: a lowering that answers "is this translatable" returns UNSUPPORTED
// for everything it does not know, which is a safe stated default. What is forbidden is
// having no answer at all — control simply leaving the switch with nothing said about the
// kind that got there. So a switch passes if it does any one of:
//
//   - binds the scrutinee to `never` (inside a `default:`, or after a switch whose every
//     arm returns) — the strongest form, since a new kind becomes a COMPILE error;
//   - has an explicit `default:` arm — the fallback is stated, even if it is a no-op;
//   - throws immediately after the switch — a stated, loud fallback.
//
// Value-returning switches get exhaustiveness from TypeScript for free (falling out would
// be "not all code paths return a value"), which is why the dangerous ones are almost
// always the `void` walkers.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "src");

// Switches allowed to stay silent, each with a reason. Declining to handle a kind should
// be a decision on the record, not a field someone forgot.
const ALLOWED: Record<string, string> = {
  // A fact collector, not a dispatcher: kinds that carry no closure or literal have nothing to
  // record. The file is ported by ts2milo, whose portable subset has no `default:` arm.
  "checker-escaping-closures-host.ts:66": "fact collector in a ts2milo-ported file",
};

// Every `kind` string in a node union, read from source. Hardcoding these lists would be
// the same fail-open shape the lint exists to forbid.
function unionKinds(file: string, name: string): Set<string> {
  const txt = readFileSync(join(SRC, file), "utf-8");
  const body = txt.match(new RegExp(`^export type ${name} =(.*?)(?:;\\s*$|\\n\\n)`, "ms"));
  expect(body).not.toBeNull();
  const kinds = new Set([...body![1].matchAll(/kind: "([A-Za-z]+)"/g)].map(m => m[1]!));
  for (const n of body![1].match(/\b[A-Z][A-Za-z]*\b/g) ?? []) {
    const decl = txt.match(new RegExp(`export interface ${n}\\s*\\{[^}]*?kind: "([A-Za-z]+)"`, "s"));
    if (decl) kinds.add(decl[1]!);
  }
  return kinds;
}

// The kinds of src/emit-forms.ts's Form union, each member spelled `F<"Kind" | ..., {...}>`.
function formKinds(): Set<string> {
  const txt = readFileSync(join(SRC, "emit-forms.ts"), "utf-8");
  const body = txt.match(/^export type Form =(.*?);\n/ms);
  expect(body).not.toBeNull();
  return new Set([...body![1].matchAll(/F<((?:"[A-Za-z]+"\s*\|?\s*)+),/g)].flatMap(m => [...m[1]!.matchAll(/"([A-Za-z]+)"/g)].map(x => x[1]!)));
}

test("no switch over a node union falls through silently", () => {
  const unions: Record<string, Set<string>> = {
    Expr: unionKinds("ast.ts", "Expr"),
    Stmt: unionKinds("ast.ts", "Stmt"),
    Form: formKinds(),
  };
  for (const [name, k] of Object.entries(unions)) {
    expect(k.size, `${name} kinds failed to parse`).toBeGreaterThan(10);
  }

  const offenders: string[] = [];
  let examined = 0;

  for (const file of readdirSync(SRC).filter(f => f.endsWith(".ts"))) {
    const src = readFileSync(join(SRC, file), "utf-8").split("\n");
    for (let i = 0; i < src.length; i++) {
      if (!/switch \(\s*[\w.?]*\bkind\s*\)/.test(src[i]!)) continue;
      const indent = " ".repeat(src[i]!.length - src[i]!.trimStart().length);
      const closes = new RegExp(`^${indent}\\}`);

      const labels = new Set<string>();
      let guarded = false, hasDefault = false, end = src.length - 1;
      for (let j = i + 1; j < src.length; j++) {
        if (closes.test(src[j]!)) { end = j; break; }
        for (const m of src[j]!.matchAll(/case "([A-Za-z]+)"/g)) labels.add(m[1]!);
        if (/:\s*never\b/.test(src[j]!)) guarded = true;
        if (new RegExp(`^${indent}  default:`).test(src[j]!)) hasDefault = true;
      }
      // A `never` guard or a throw may also sit just AFTER the switch, which is the
      // house style when every arm returns.
      for (let j = end + 1; j < Math.min(end + 7, src.length); j++) {
        if (/:\s*never\b/.test(src[j]!)) guarded = true;
        if (/^\s*throw /.test(src[j]!)) hasDefault = true;
      }

      // Attribute the switch to whichever union it overlaps most — Stmt and HIRStmt share
      // four names, so "first match wins" misfiles HIR switches as AST ones.
      let best = "", overlap = 0;
      for (const [name, kinds] of Object.entries(unions)) {
        const n = [...labels].filter(l => kinds.has(l)).length;
        if (n > overlap) { overlap = n; best = name; }
      }
      if (overlap < 4) continue;
      examined++;

      if (!guarded && !hasDefault && !(`${file}:${i + 1}` in ALLOWED)) {
        offenders.push(`${file}:${i + 1} — ${overlap} ${best} kinds, no never-guard and no default`);
      }
    }
  }

  expect(examined, "switch scan found nothing — the detector is broken").toBeGreaterThan(20);
  expect(offenders.join("\n")).toBe("");
});
