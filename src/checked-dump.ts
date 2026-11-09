// Graph codec for the checker's output (Program + CheckResult): the seam where a checker that
// is not this process's (the generated Milo one) hands its facts to the emitter.
// `milo emit-checked` writes it, `milo emit-mlir --from-checked` reads it.
// Format: JSON, plus
//   {"$map": [[k, v], ...]}   Map, insertion order
//   {"$set": [v, ...]}        Set, insertion order
//   {"$arr": [...]}           an array that carries a $id
//   {"$id": n, ...}           a value referenced again, or one that keys a Map or Set
//   {"$ref": n}               that value again: the same object after decode
//   {"$big": "123"}           bigint
//   {"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}
//   {"$undef": 1}             undefined where JSON cannot omit it (array slot, Map value)
// An object field holding undefined is omitted. A $ref may come before its $id in the document
// (a table keyed by nodes of a declaration that is written after it). A full value whose $id
// already appeared resolves to the first one, so an encoder whose values have no identity
// (copies that carry an id) may repeat a node in full.

export function encodeChecked(root: unknown): string {
  // References per object. A Map/Set key counts twice: it needs an id even when seen once,
  // because the tables are keyed by identity.
  const refs = new Map<object, number>();
  const count = (v: unknown, weight: number): void => {
    if (v === null || typeof v !== "object") return;
    const n = refs.get(v) ?? 0;
    refs.set(v, n + weight);
    if (n > 0) return;
    if (v instanceof Map) for (const [k, x] of v) { count(k, 2); count(x, 1); }
    else if (v instanceof Set) for (const k of v) count(k, 2);
    else if (Array.isArray(v)) for (const x of v) count(x, 1);
    else for (const k in v) count((v as Record<string, unknown>)[k], 1);
  };
  count(root, 1);

  const ids = new Map<object, number>();
  const enc = (v: unknown): unknown => {
    switch (typeof v) {
      case "undefined": return { $undef: 1 };
      case "bigint": return { $big: v.toString() };
      case "number": return Number.isFinite(v) && !Object.is(v, -0) ? v : { $num: Object.is(v, -0) ? "-0" : String(v) };
      case "string": case "boolean": return v;
      case "object": break;
      default: throw new Error(`checked dump: cannot encode a ${typeof v}`);
    }
    if (v === null) return null;
    const had = ids.get(v);
    if (had !== undefined) return { $ref: had };
    const out: Record<string, unknown> = {};
    const shared = refs.get(v)! > 1;
    if (shared) { out.$id = ids.size; ids.set(v, ids.size); }
    if (v instanceof Map) { out.$map = [...v].map(([k, x]) => [enc(k), enc(x)]); return out; }
    if (v instanceof Set) { out.$set = [...v].map((x) => enc(x)); return out; }
    if (Array.isArray(v)) {
      const a = v.map((x) => enc(x));
      if (!shared) return a;
      out.$arr = a;
      return out;
    }
    // A class instance would come back without its methods; refuse rather than emit one.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`checked dump: cannot encode a ${proto.constructor?.name ?? "class"} instance`);
    for (const k in v) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = enc(x);
    }
    return out;
  };
  return JSON.stringify(enc(root)) + "\n";
}

export function decodeChecked(text: string): unknown {
  // Pass 1 makes the empty object of every $id (the first full value with that id defines it),
  // pass 2 fills them: a $ref then resolves wherever its $id sits, and cycles need no care.
  const byId = new Map<number, unknown>();
  const definers = new Set<object>();
  const scan = (j: any): void => {
    if (j === null || typeof j !== "object") return;
    if (Array.isArray(j)) { for (const x of j) scan(x); return; }
    if (j.$id !== undefined && !byId.has(j.$id)) {
      byId.set(j.$id, "$map" in j ? new Map() : "$set" in j ? new Set() : "$arr" in j ? [] : {});
      definers.add(j);
    }
    for (const k in j) scan(j[k]);
  };
  const dec = (j: any): unknown => {
    if (j === null || typeof j !== "object") return j;
    if (Array.isArray(j)) return j.map((x) => dec(x));
    if ("$ref" in j) {
      if (!byId.has(j.$ref)) throw new Error(`checked dump: $ref ${j.$ref} has no $id`);
      return byId.get(j.$ref);
    }
    if ("$undef" in j) return undefined;
    if ("$big" in j) return BigInt(j.$big);
    if ("$num" in j) return j.$num === "-0" ? -0 : Number(j.$num);
    const id: number | undefined = j.$id;
    if (id !== undefined && !definers.has(j)) return byId.get(id);
    const shell = id === undefined ? undefined : byId.get(id);
    if ("$map" in j) {
      const m = (shell as Map<unknown, unknown>) ?? new Map<unknown, unknown>();
      for (const [k, x] of j.$map) m.set(dec(k), dec(x));
      return m;
    }
    if ("$set" in j) {
      const s = (shell as Set<unknown>) ?? new Set<unknown>();
      for (const x of j.$set) s.add(dec(x));
      return s;
    }
    if ("$arr" in j) {
      const a = (shell as unknown[]) ?? [];
      for (const x of j.$arr) a.push(dec(x));
      return a;
    }
    const o = (shell as Record<string, unknown>) ?? {};
    for (const k in j) if (k !== "$id") o[k] = dec(j[k]);
    return o;
  };
  const root = JSON.parse(text);
  scan(root);
  return dec(root);
}
