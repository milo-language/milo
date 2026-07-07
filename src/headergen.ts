// C header generator for `milo build-lib`. Emits a `.h` that lets C code call the
// library's exported functions and use its extern (C-layout) structs.
//
// Scope: scalars, pointers, extern structs (by value in fields; by pointer in params),
// fixed arrays (decay to pointers in params), and function-pointer params. Anything
// without a stable C spelling (Vec/String/enum/HashMap, or — until define-side ABI
// lowering lands — a by-value struct param/return) is skipped with a comment so the
// header stays valid and the gap is visible.

import type { HIRModule, HIRFunction } from "./hir";
import type { TypeKind } from "./types";

function intName(bits: number, signed: boolean): string {
  const b = bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 32 ? 32 : 64;
  return `${signed ? "" : "u"}int${b}_t`;
}

// C spelling of a type in value position, or null if it has no stable C representation.
function cType(t: TypeKind): string | null {
  switch (t.tag) {
    case "int": return intName(t.bits, t.signed);
    case "float": return t.bits === 32 ? "float" : "double";
    case "bool": return "bool";
    case "void": return "void";
    case "ptr": { const inner = cType(t.inner); return inner ? `${inner}*` : null; }
    case "ref": { const inner = cType(t.inner); return inner ? `${inner}*` : null; }
    case "struct": return t.name; // typedef'd below
    default: return null; // fn (only valid as a param), array, enum, vec, string, ...
  }
}

// C spelling of a struct field (arrays keep their extent here, unlike params).
function cField(t: TypeKind, name: string): string | null {
  if (t.tag === "array" && t.size !== null) {
    const el = cType(t.element);
    return el ? `${el} ${name}[${t.size}]` : null;
  }
  const c = cType(t);
  return c ? `${c} ${name}` : null;
}

// C spelling of a function parameter (arrays decay to pointers; fn types become fn ptrs).
function cParam(t: TypeKind, name: string): string | null {
  if (t.tag === "array") {
    const el = cType(t.element);
    return el ? `${el}* ${name}` : null;
  }
  if (t.tag === "fn") {
    const ret = cType(t.ret);
    if (!ret) return null;
    const ps = t.params.map(p => cType(p));
    if (ps.some(p => p === null)) return null;
    return `${ret} (*${name})(${ps.length ? ps.join(", ") : "void"})`;
  }
  const c = cType(t);
  return c ? `${c} ${name}` : null;
}

// Order struct definitions so a by-value-embedded struct is defined before its user.
// Pointer references don't constrain order (the forward typedef covers them).
function depOrder(structs: HIRModule["structs"]): HIRModule["structs"] {
  const byName = new Map(structs.map(s => [s.name, s]));
  const out: HIRModule["structs"] = [];
  const seen = new Set<string>();
  const visit = (s: HIRModule["structs"][number]) => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    for (const f of s.fields) {
      let ft = f.type;
      while (ft.tag === "array") ft = ft.element; // by-value array of struct still embeds it
      if (ft.tag === "struct") { const dep = byName.get(ft.name); if (dep) visit(dep); }
    }
    out.push(s);
  };
  for (const s of structs) visit(s);
  return out;
}

// Does an exported fn have a by-value struct param or return? (skipped until stage 6.)
function hasByValueStruct(fn: HIRFunction): boolean {
  if (fn.retType.tag === "struct") return true;
  return fn.params.some(p => p.type.tag === "struct" && !p.isRef && !p.isRefMut);
}

export function generateHeader(module: HIRModule, headerName: string): string {
  const guard = `MILO_${headerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_H`;
  const L: string[] = [];
  L.push(`#ifndef ${guard}`);
  L.push(`#define ${guard}`);
  L.push("");
  L.push("#include <stdint.h>");
  L.push("#include <stdbool.h>");
  L.push("#include <stddef.h>");
  L.push("");
  L.push("#ifdef __cplusplus");
  L.push(`extern "C" {`);
  L.push("#endif");
  L.push("");

  const externStructs = module.structs.filter(s => s.isExtern);
  const opaque = module.opaqueTypes ?? [];

  // forward typedefs for every named struct — satisfies pointer fields in any order
  if (opaque.length || externStructs.length) {
    L.push("/* type forward declarations */");
    for (const name of opaque) L.push(`typedef struct ${name} ${name};`);
    for (const s of externStructs) L.push(`typedef struct ${s.name} ${s.name};`);
    L.push("");
  }

  // full definitions for non-opaque extern structs, dependency-ordered
  if (externStructs.length) {
    L.push("/* struct definitions */");
    for (const s of depOrder(externStructs)) {
      const fields: string[] = [];
      let skip = false;
      for (const f of s.fields) {
        const c = cField(f.type, f.name);
        if (!c) { skip = true; break; }
        fields.push(`    ${c};`);
      }
      if (skip) { L.push(`/* skipped struct ${s.name}: contains a non-C-representable field */`); continue; }
      L.push(`struct ${s.name} {`);
      L.push(...fields);
      L.push(`};`);
    }
    L.push("");
  }

  // exported function prototypes (root free functions minus main/methods/externs)
  const exported = (module.userFnNames ? [...module.userFnNames] : [])
    .filter(n => n !== "main" && !n.includes("$"));
  const fnByName = new Map(module.functions.map(f => [f.name, f]));

  const protos: string[] = [];
  for (const name of exported) {
    const fn = fnByName.get(name);
    if (!fn || fn.isExtern || fn.isVariadic) continue;
    if (hasByValueStruct(fn)) { protos.push(`/* skipped ${name}: by-value struct params/return not yet exported (needs define-side ABI lowering) */`); continue; }
    const ret = cType(fn.retType);
    if (!ret) { protos.push(`/* skipped ${name}: non-C-representable return type */`); continue; }
    const params = fn.params.map((p, i) => cParam(p.type, p.name || `arg${i}`));
    if (params.some(p => p === null)) { protos.push(`/* skipped ${name}: non-C-representable parameter */`); continue; }
    protos.push(`${ret} ${name}(${params.length ? params.join(", ") : "void"});`);
  }
  if (protos.length) {
    L.push("/* exported functions */");
    L.push(...protos);
    L.push("");
  }

  L.push("#ifdef __cplusplus");
  L.push("}");
  L.push("#endif");
  L.push(`#endif /* ${guard} */`);
  L.push("");
  return L.join("\n");
}
