// A rule that resolves a variable by matching `Ident` covers one spelling of a place and
// silently exempts the rest.
//
// That single habit produced every use-after-free found in this checker in safe code. The
// for-in freeze was keyed to a bare `Ident`, so `for x in b.items { b.items.push(..) }`
// reallocated the buffer the loop was reading. Three more sites hand-rolled the same walk
// one step deeper — `while (root.kind === "FieldAccess" || root.kind === "IndexAccess")`
// — which is narrower but the same shape: each knew a fixed set of ways to reach a root,
// so a place spelled any other way resolved to nothing and the rule did not run.
//
// `placesOf` is the answer and is already total over the expression grammar with no
// `default:` arm, so a new `Expr` kind is a tsc error until it is classified. But a total
// walker does nothing for a rule that never calls it. This gate is what makes routing
// through it the default: matching `Ident` to find a variable is allowed only where the
// rule is genuinely about a NAME rather than about storage, and only with the reason
// written down at the site.
//
// To add an exemption, put `ident-ok:` and a reason on the line or just above it. To
// remove one, route the rule through `accessPath`/`placesOf` instead.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const CHECKER = join(import.meta.dir, "..", "src", "checker.ts");

test("resolving a variable by matching Ident is exempted only with a written reason", () => {
  const lines = readFileSync(CHECKER, "utf8").split("\n");
  const unexplained: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Two spellings of the same habit, and the first version of this gate caught only the
    // first — which is the very defect it exists to prevent, committed in the gate:
    //
    //   1. deciding WHICH variable an expression names, then looking it up
    //   2. hand-rolling the walk to a root by stepping over the node kinds someone
    //      remembered — `while (e.kind === "FieldAccess" || e.kind === "IndexAccess")`
    //
    // The second is the one that produced the use-after-free: such a walk knows exactly
    // two ways to reach a place, so anything spelled differently (an unwrap, a cast, the
    // tail of a fork) resolves to no root and the rule silently does not run. Note both
    // `===` and `!==` count: `if (root.kind !== "Ident") return` is the same decision.
    const identTest = /\.kind (===|!==) "Ident"/.test(lines[i])
      && lines.slice(i, i + 4).join("\n").includes("this.lookup(");
    const handRolledWalk = /while \([^)]*kind === "FieldAccess"[^)]*kind === "IndexAccess"/.test(lines[i]);
    if (!identTest && !handRolledWalk) continue;
    // A line that only DESCRIBES the pattern (this file's own prose lives in checker.ts's
    // comments too) is not an instance of it.
    if (/^\s*(\/\/|\*)/.test(lines[i])) continue;
    // The reason may sit on the line itself or in the comment block just above it.
    const window = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
    if (window.includes("ident-ok:")) continue;
    unexplained.push(`checker.ts:${i + 1}: ${lines[i].trim().slice(0, 90)}`);
  }

  expect({
    unexplained,
    fix: unexplained.length
      ? "route it through accessPath/placesOf, or mark it `ident-ok: <why this rule is about a NAME, not a place>`"
      : "",
  }).toEqual({ unexplained: [], fix: "" });
});
