// Exhaustiveness and unreachable-arm analysis for nested match patterns (Maranget's
// usefulness algorithm, "Warnings for pattern matching", JFP 2007).
//
// A flat match (`Some(x) => …, None => …`) is still checked by the per-variant rule in
// the checker, which predates this file and whose messages the error fixtures pin. This
// runs only when some arm nests (`Ok(Some(v))`, `Some(0)`), where "every variant has an
// arm" is no longer the question: `Ok(Some(v))` names the variant Ok and still leaves
// `Ok(None)` uncovered.
//
// Kept free of checker state: the caller describes the type space through `SpaceEnv`.

export type Pat =
  | { k: "wild" }
  // An enum variant (or `true` / `false`, which are the two constructors of bool).
  | { k: "ctor"; name: string; args: Pat[] }
  // A literal of a type with no finite constructor list (ints, floats, strings): it covers
  // exactly itself, so only a wildcard can complete a column of them.
  | { k: "lit"; key: string; text: string };

export interface SpaceEnv<T> {
  // The constructors of `ty` that can hold a value (uninhabited variants left out), or
  // null when the type's values are not enumerable (ints, strings, …).
  ctors(ty: T): { name: string; fields: T[] }[] | null;
}

const WILD: Pat = { k: "wild" };

function specialize(row: Pat[], name: string, arity: number): Pat[] | null {
  const h = row[0]!;
  if (h.k === "wild") return [...Array<Pat>(arity).fill(WILD), ...row.slice(1)];
  if (h.k === "ctor") return h.name === name ? [...h.args, ...row.slice(1)] : null;
  return null;
}

function specializeLit(row: Pat[], key: string): Pat[] | null {
  const h = row[0]!;
  if (h.k === "wild") return row.slice(1);
  if (h.k === "lit") return h.key === key ? row.slice(1) : null;
  return null;
}

// A value vector that `q` matches and no row of `rows` does, or null when every value `q`
// matches is already matched by some row (`q` is useless).
// A column whose type is `undefined` is open (nothing enumerable): a pattern can name more
// fields than its type is known to have when that type failed to resolve, and the type
// vector must stay aligned with the pattern vector regardless.
export function useful<T>(env: SpaceEnv<T>, rows: Pat[][], q: Pat[], tys: (T | undefined)[]): Pat[] | null {
  if (q.length === 0) return rows.length === 0 ? [] : null;
  const head = q[0]!;
  const ty = tys[0];
  const ctorList = ty === undefined ? null : env.ctors(ty);
  const fieldsOf = (name: string): T[] => ctorList?.find(c => c.name === name)?.fields ?? [];

  const tryCtor = (name: string, arity: number, fields: T[]): Pat[] | null => {
    const sub = rows.flatMap(r => { const s = specialize(r, name, arity); return s ? [s] : []; });
    const qs = specialize(q, name, arity)!;
    const w = useful(env, sub, qs, [...Array.from({ length: arity }, (_, i) => fields[i]), ...tys.slice(1)]);
    return w ? [{ k: "ctor", name, args: w.slice(0, arity) }, ...w.slice(arity)] : null;
  };

  if (head.k === "ctor") return tryCtor(head.name, head.args.length, fieldsOf(head.name));
  if (head.k === "lit") {
    const sub = rows.flatMap(r => { const s = specializeLit(r, head.key); return s ? [s] : []; });
    const w = useful(env, sub, q.slice(1), tys.slice(1));
    return w ? [head, ...w] : null;
  }

  // Wildcard head: split on the constructors the column already names.
  const seen = new Set<string>();
  for (const r of rows) { const h = r[0]!; if (h.k === "ctor") seen.add(h.name); }
  if (ctorList && ctorList.length > 0 && ctorList.every(c => seen.has(c.name))) {
    for (const c of ctorList) {
      const w = tryCtor(c.name, c.fields.length, c.fields);
      if (w) return w;
    }
    return null;
  }
  // Some constructor (or, for an open type, some value) no row names: only the rows with
  // a wildcard here can match it, so the rest of the vector decides.
  const defaults = rows.filter(r => r[0]!.k === "wild").map(r => r.slice(1));
  const w = useful(env, defaults, q.slice(1), tys.slice(1));
  if (!w) return null;
  const missing = ctorList?.find(c => !seen.has(c.name));
  const witness: Pat = missing ? { k: "ctor", name: missing.name, args: missing.fields.map(() => WILD) } : WILD;
  return [witness, ...w];
}

// `Ok(None)`, `Err(_)`, `Some(_)`: a witness as the user would write the pattern.
export function showPat(p: Pat): string {
  if (p.k === "wild") return "_";
  if (p.k === "lit") return p.text;
  return p.args.length === 0 ? p.name : `${p.name}(${p.args.map(showPat).join(", ")})`;
}
