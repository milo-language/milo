// Reads z3 models back into source-level values: the counterexample `milo prove` prints for a
// failed obligation. Split from verify.ts, which builds the queries.

type Sexp = string | Sexp[];

function readSexp(text: string): Sexp[] {
  const toks = text.match(/[()]|[^\s()]+/g) ?? [];
  let i = 0;
  const read = (): Sexp => {
    const t = toks[i++]!;
    if (t !== "(") return t;
    const list: Sexp[] = [];
    while (i < toks.length && toks[i] !== ")") list.push(read());
    i++;
    return list;
  };
  const out: Sexp[] = [];
  while (i < toks.length) { if (toks[i] === ")") { i++; continue; } out.push(read()); }
  return out;
}

// A model value as the user would write it: `(- 5)` is -5, `(/ 1.0 3.0)` is 1.0/3.0 (kept
// as a ratio, a decimal would round it). Anything else (an algebraic number) prints as z3
// wrote it.
function modelValue(v: Sexp): string {
  if (typeof v === "string") return v;
  if (v.length === 2 && v[0] === "-") return `-${modelValue(v[1]!)}`;
  if (v.length === 3 && v[0] === "/") return `${modelValue(v[1]!)}/${modelValue(v[2]!)}`;
  return `(${v.map(modelValue).join(" ")})`;
}

// The values in z3's answer to (get-model) that a reader can check against the source.
// Ordered as the query declares them (parameters first), not as z3 lists them. A symbol
// the query declares but never asserts anything about is a placeholder (a struct-typed
// parameter stands in as an Int), and z3's value for it means nothing. A call result
// (`f__ret0`) is left out: the model picks it freely within the callee's `ensures`.
export function readModel(query: string, z3Output: string): [string, string][] {
  const values = new Map<string, string>();
  const visit = (e: Sexp) => {
    if (typeof e === "string") return;
    if (e[0] === "define-fun" && typeof e[1] === "string" && Array.isArray(e[2]) && e[2].length === 0 && e.length === 5) values.set(e[1], modelValue(e[4]!));
    else for (const k of e) visit(k);
  };
  for (const e of readSexp(z3Output.replace(/^sat\s*/, ""))) visit(e);
  const asserted = new Set<string>();
  const collect = (e: Sexp) => { if (typeof e === "string") asserted.add(e); else for (const k of e) collect(k); };
  const declared: string[] = [];
  for (const e of readSexp(query.replace(/^\s*;.*$/gm, ""))) {
    if (typeof e === "string") continue;
    if (e[0] === "declare-const" && typeof e[1] === "string") declared.push(e[1]);
    else if (e[0] === "assert") collect(e);
  }
  const out: [string, string][] = [];
  for (const name of declared) {
    const v = values.get(name);
    if (v === undefined || !asserted.has(name)) continue;
    const m = /^(.+)__(loop|mut|iter)\d+$/.exec(name);
    if (m) out.push([`${m[1]} (after the ${m[2] === "mut" ? "call" : "loop"})`, v]);
    else if (!name.includes("__")) out.push([name, v]);
  }
  return out;
}

export function formatModel(model: [string, string][]): string {
  return model.map(([n, v]) => `${n} = ${v}`).join(", ");
}

// Asked as a second query, after the verdict: (get-model) on an unsat query prints an
// `(error ...)` line, and the verdict path treats any error line as an invalid run.
export function counterexampleOf(smtlib: string): [string, string][] {
  const { spawnSync } = require("child_process") as typeof import("child_process");
  const proc = spawnSync("z3", ["-in", "-T:5"], { input: smtlib + "\n(get-model)\n", encoding: "utf-8", timeout: 10000 });
  const out = (proc.stdout ?? "").trim();
  if (!out.startsWith("sat") || out.includes("(error")) return [];
  return readModel(smtlib, out);
}
