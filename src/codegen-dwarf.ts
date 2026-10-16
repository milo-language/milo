// DWARF debug metadata for `-g` builds: files, subprograms, locations and variable types,
// interned as `!N = ...` nodes and attached in one final text pass over the module.
// Extracted from codegen.ts; it reads codegen only through `DwarfHost` (names and layout).
import { resolve, dirname, basename } from "path";
import type { HIRFunction } from "./hir";
import type { TypeKind } from "./types";
import type { StructLayout, EnumLayout } from "./codegen";
import { HASHMAP_FIELDS } from "./codegen-map";

export interface DwarfHost {
  displayName(s: string): string;
  filePath(): string | undefined;
  structLayouts: Map<string, StructLayout>;
  enumLayouts: Map<string, EnumLayout>;
  llvmType(t: TypeKind): string;
  typeSize(ty: string): number;
  typeSizeOf(t: TypeKind): number;
  structFieldOffset(fieldTypes: string[], fieldIdx: number): number;
  structPayloadSize(fieldTypes: string[]): number;
  variantFieldOffsets(fieldTypes: string[]): number[];
}

// Tag every instruction line (2-space indented, non-comment) with a deferred source
// marker. Nested stmts recurse first and mark their own lines; the outer stmt's marker
// then only lands on its own lines (skip-if-marked). Resolved to real !dbg in DwarfEmitter.apply.
export function markDbg(lines: string[], line: number, col: number): void {
  const marker = ` ;MILODBG ${line} ${col | 0}`;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length < 2 || l[0] !== " " || l[1] !== " ") continue;
    const t = l.trimStart();
    if (t.length === 0 || t[0] === ";") continue;
    if (l.includes(";MILODBG") || l.includes("!dbg")) continue;
    lines[i] = l + marker;
  }
}

// Used only when codegen's `emitDebug` is on. All metadata is interned here and rendered
// as trailing `!N = ...` nodes by apply(). LLVM permits forward metadata references, so
// mint order is irrelevant. Scope is resolved lazily in that final text pass rather than
// threaded through the recursive emitters, which sidesteps every closure/trampoline
// state-save landmine.
export class DwarfEmitter {
  // Also minted for codegen's other metadata (range, noundef) through mintId(): one `!N`
  // id space per module.
  private metaCounter = 0;
  private diNodes: string[] = [];
  private diFiles = new Map<string, number>();
  private diSubprograms = new Map<string, number>();
  private diSubprogramLine = new Map<number, number>();
  private diLocations = new Map<string, number>();
  private diCompileUnitId = -1;
  private diSubroutineTypeId = -1;
  private diTypes = new Map<string, number>();

  constructor(private host: DwarfHost) {}

  mintId(): number { return this.metaCounter++; }

  diEsc(s: string): string { return s.replace(/\\/g, "\\5C").replace(/"/g, "\\22"); }
  // A DWARF display name: what a debugger shows. The per-module pass renames a private
  // name, and that rename is a symbol concern only; a `frame variable` or a breakpoint
  // listing must still read `tone`, not `gfx$tone`. No `linkageName` is emitted on
  // purpose: lldb DISPLAYS the linkage name in every backtrace frame when it is present,
  // which is exactly the surface this keeps clean. The DIE is matched to code by
  // DW_AT_low_pc, not by name, and the mangled symbol is still in the symbol table.
  private diName(s: string): string { return this.diEsc(this.host.displayName(s)); }

  diFile(path: string): number {
    const key = path || "<unknown>";
    const cached = this.diFiles.get(key);
    if (cached !== undefined) return cached;
    const id = this.metaCounter++;
    const abs = resolve(key);
    this.diNodes.push(`!${id} = !DIFile(filename: "${this.diEsc(basename(abs))}", directory: "${this.diEsc(dirname(abs))}")`);
    this.diFiles.set(key, id);
    return id;
  }

  private diCompileUnit(): number {
    if (this.diCompileUnitId >= 0) return this.diCompileUnitId;
    const fileId = this.diFile(this.host.filePath() ?? "<unknown>");
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = distinct !DICompileUnit(language: DW_LANG_C99, file: !${fileId}, producer: "milo", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug)`);
    this.diCompileUnitId = id;
    return id;
  }

  // M1 has no per-parameter type info yet; `types: !{null}` = void/unspecified, shared by all fns.
  private diSubroutineType(): number {
    if (this.diSubroutineTypeId >= 0) return this.diSubroutineTypeId;
    const typesId = this.metaCounter++;
    this.diNodes.push(`!${typesId} = !{null}`);
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = !DISubroutineType(types: !${typesId})`);
    this.diSubroutineTypeId = id;
    return id;
  }

  diSubprogram(fn: HIRFunction): number {
    const cached = this.diSubprograms.get(fn.name);
    if (cached !== undefined) return cached;
    const fileId = this.diFile(fn.sourceFile ?? this.host.filePath() ?? "<unknown>");
    const cu = this.diCompileUnit();
    const subT = this.diSubroutineType();
    const line = fn.line ?? 0;
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = distinct !DISubprogram(name: "${this.diName(fn.name)}", scope: !${fileId}, file: !${fileId}, line: ${line}, type: !${subT}, scopeLine: ${line}, spFlags: DISPFlagDefinition, unit: !${cu})`);
    this.diSubprograms.set(fn.name, id);
    this.diSubprogramLine.set(id, line);
    return id;
  }

  private diLocation(line: number, col: number, scope: number): number {
    const key = `${line}:${col}:${scope}`;
    const cached = this.diLocations.get(key);
    if (cached !== undefined) return cached;
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = !DILocation(line: ${line}, column: ${col}, scope: !${scope})`);
    this.diLocations.set(key, id);
    return id;
  }

  // ── DWARF variable types (M2) ──
  // Structural key so pointers/refs (whose llvmType collapses to "ptr") still cache
  // distinctly by pointee.
  private diTypeKey(t: TypeKind): string {
    switch (t.tag) {
      case "int": return `i${t.bits}${t.signed ? "s" : "u"}`;
      case "float": return `f${t.bits}`;
      case "ptr": case "heap": return `p:${this.diTypeKey(t.inner)}`;
      case "ref": return `r:${this.diTypeKey(t.inner)}`;
      case "struct": return `s:${t.name}`;
      case "enum": return `e:${t.name}`;
      case "vec": return `v:${this.diTypeKey(t.element)}`;
      case "hashmap": return `m:${this.diTypeKey(t.key)}:${this.diTypeKey(t.value)}`;
      case "array": return `a:${this.diTypeKey(t.element)}:${t.size}`;
      default: return t.tag;
    }
  }

  private diPointer(base: number | null): number {
    const id = this.metaCounter++;
    // baseType is required; a void/opaque pointer must spell it `null`, not omit it.
    this.diNodes.push(`!${id} = !DIDerivedType(tag: DW_TAG_pointer_type, baseType: ${base !== null ? "!" + base : "null"}, size: 64)`);
    return id;
  }

  private diBasic(name: string, sizeBits: number, encoding: string): number {
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = !DIBasicType(name: "${name}", size: ${sizeBits}, encoding: ${encoding})`);
    return id;
  }

  // Composite from LLVM field types — offsets/sizes come from the same layout math the
  // struct codegen uses, so DWARF member offsets match the emitted %Struct exactly.
  // `placed` overrides that math with explicit byte offsets and size (an enum variant).
  private diComposite(name: string, fieldLlvm: string[], fieldNames: string[], fieldKinds: TypeKind[], key: string,
    placed?: { offsets: number[]; size: number }): number {
    // A field list that drifts from the real layout must fail here, by name, not as a
    // TypeError deep in diType (the HashMap list once lost its last kind this way).
    if (fieldNames.length !== fieldLlvm.length || fieldKinds.length !== fieldLlvm.length)
      throw new Error(`dwarf: ${name} has ${fieldLlvm.length} fields, ${fieldNames.length} names, ${fieldKinds.length} kinds`);
    const id = this.metaCounter++;
    this.diTypes.set(key, id); // reserve before recursing into members (breaks self-reference cycles)
    const memberIds: number[] = [];
    for (let i = 0; i < fieldLlvm.length; i++) {
      const ft = this.diType(fieldKinds[i]);
      if (ft === null) continue;
      const mid = this.metaCounter++;
      const off = (placed ? placed.offsets[i] : this.host.structFieldOffset(fieldLlvm, i)) * 8;
      const sz = this.host.typeSize(fieldLlvm[i]) * 8;
      this.diNodes.push(`!${mid} = !DIDerivedType(tag: DW_TAG_member, name: "${this.diEsc(fieldNames[i])}", baseType: !${ft}, size: ${sz}, offset: ${off})`);
      memberIds.push(mid);
    }
    const tuple = this.metaCounter++;
    this.diNodes.push(`!${tuple} = !{${memberIds.map(m => "!" + m).join(", ")}}`);
    const totBits = (placed ? placed.size : this.host.structPayloadSize(fieldLlvm)) * 8;
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_structure_type, name: "${this.diName(name)}", size: ${totBits}, elements: !${tuple})`);
    return id;
  }

  // The `tag` field of an enum, described as a real DWARF enumeration so debuggers
  // print `tag = Rect` rather than `tag = 1`.
  private diEnumeration(name: string, layout: EnumLayout): number {
    const base = this.diType({ tag: "int", bits: 32, signed: true })!;
    const enumerators: number[] = [];
    for (const [vname, v] of layout.variants) {
      const eid = this.metaCounter++;
      this.diNodes.push(`!${eid} = !DIEnumerator(name: "${this.diEsc(vname)}", value: ${v.tag})`);
      enumerators.push(eid);
    }
    const tuple = this.metaCounter++;
    this.diNodes.push(`!${tuple} = !{${enumerators.map(e => "!" + e).join(", ")}}`);
    const id = this.metaCounter++;
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_enumeration_type, name: "${this.diName(name)}", size: 32, baseType: !${base}, elements: !${tuple})`);
    return id;
  }

  // A Milo enum is `{ i32 tag, union payload }`. Describe it as the classic C
  // tagged union — enumerated tag + union of per-variant payload structs — which every
  // debugger renders natively. DW_TAG_variant_part would be more faithful but lldb
  // shows it as `$variant$0`/`$discr$` noise without a synthetic provider.
  private diEnum(layout: EnumLayout, key: string): number {
    // fieldless enum: the whole value *is* the tag, so no phantom payload slots
    if (layout.size === 0) {
      const only = this.diEnumeration(layout.name, layout);
      this.diTypes.set(key, only);
      return only;
    }
    const id = this.metaCounter++;
    this.diTypes.set(key, id); // reserve before recursing into payloads (Heap<Self> variants)

    // A niche enum has no tag word: it is the payload, and the fieldless variant is the
    // niche value. Shown as a struct with one member whose name says which value is None,
    // since a debugger has no other way to learn the encoding.
    if (layout.niche) {
      const niche = layout.niche;
      const some = [...layout.variants].find(([, v]) => v.tag === niche.someTag);
      const baseId = some ? this.diType(some[1].fieldTypeKinds[0]) : null;
      const bits = this.host.typeSize(niche.payloadTy) * 8;
      const members: number[] = [];
      if (some && baseId !== null) {
        const mid = this.metaCounter++;
        this.diNodes.push(`!${mid} = !DIDerivedType(tag: DW_TAG_member, name: "${this.diEsc(`${some[0]} (${[...layout.variants].find(([, v]) => v.tag === niche.noneTag)?.[0] ?? "None"} = ${niche.value})`)}", baseType: !${baseId}, size: ${bits}, offset: 0)`);
        members.push(mid);
      }
      const tuple = this.metaCounter++;
      this.diNodes.push(`!${tuple} = !{${members.map(m => "!" + m).join(", ")}}`);
      this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_structure_type, name: "${this.diName(layout.name)}", size: ${bits}, elements: !${tuple})`);
      return id;
    }

    const tagId = this.diEnumeration(`${layout.name}$tag`, layout);
    // Each variant's fields sit at their own offsets (variantFieldOffsets). The union
    // starts at the shallowest first field, so a single-field variant starting there binds
    // the field type directly (`Some = 42`); any other variant is a positional struct
    // whose member offsets are its real ones, relative to the union.
    const totalBytes = this.host.typeSize(`%${layout.name}`);
    const payloadVariants = [...layout.variants.values()].filter(v => v.fieldTypes.length > 0);
    const unionStart = Math.min(...payloadVariants.map(v => this.host.variantFieldOffsets(v.fieldTypes)[0]));
    const payloadBits = (totalBytes - unionStart) * 8;
    const payloadOffBits = unionStart * 8;
    const totalBits = totalBytes * 8;

    const unionMembers: number[] = [];
    for (const [vname, v] of layout.variants) {
      if (v.fieldTypes.length === 0) continue;
      const rel = this.host.variantFieldOffsets(v.fieldTypes).map(o => o - unionStart);
      let baseId: number | null;
      let sizeBits: number;
      if (v.fieldTypes.length === 1 && rel[0] === 0) {
        baseId = this.diType(v.fieldTypeKinds[0]);
        sizeBits = this.host.typeSize(v.fieldTypes[0]) * 8;
      } else {
        const size = this.host.structPayloadSize(["i32", ...v.fieldTypes]) - unionStart;
        baseId = this.diComposite(`${layout.name}::${vname}`, v.fieldTypes,
          v.fieldTypes.map((_, i) => `_${i}`), v.fieldTypeKinds, `ev:${layout.name}:${vname}`, { offsets: rel, size });
        sizeBits = size * 8;
      }
      if (baseId === null) continue; // unmodellable payload — omit rather than emit bad metadata
      const mid = this.metaCounter++;
      this.diNodes.push(`!${mid} = !DIDerivedType(tag: DW_TAG_member, name: "${this.diEsc(vname)}", baseType: !${baseId}, size: ${sizeBits}, offset: 0)`);
      unionMembers.push(mid);
    }
    const utuple = this.metaCounter++;
    this.diNodes.push(`!${utuple} = !{${unionMembers.map(m => "!" + m).join(", ")}}`);
    const unionId = this.metaCounter++;
    this.diNodes.push(`!${unionId} = distinct !DICompositeType(tag: DW_TAG_union_type, name: "${this.diName(layout.name)}$payload", size: ${payloadBits}, elements: !${utuple})`);

    const tagMember = this.metaCounter++;
    this.diNodes.push(`!${tagMember} = !DIDerivedType(tag: DW_TAG_member, name: "tag", baseType: !${tagId}, size: 32, offset: 0)`);
    const payloadMember = this.metaCounter++;
    // the union starts at the shallowest variant's first field (see above)
    this.diNodes.push(`!${payloadMember} = !DIDerivedType(tag: DW_TAG_member, name: "payload", baseType: !${unionId}, size: ${payloadBits}, offset: ${payloadOffBits})`);
    const tuple = this.metaCounter++;
    this.diNodes.push(`!${tuple} = !{!${tagMember}, !${payloadMember}}`);
    this.diNodes.push(`!${id} = distinct !DICompositeType(tag: DW_TAG_structure_type, name: "${this.diName(layout.name)}", size: ${totalBits}, elements: !${tuple})`);
    return id;
  }

  // Translate a Milo type to a DIType node id. Returns null for types we don't model
  // yet (fn/interface/void/unknown/slices) — callers then skip the variable rather
  // than emit metadata the verifier would reject.
  diType(t: TypeKind): number | null {
    const key = this.diTypeKey(t);
    const cached = this.diTypes.get(key);
    if (cached !== undefined) return cached;
    let id: number | null = null;
    switch (t.tag) {
      case "int":
        id = this.diBasic(`${t.signed ? "i" : "u"}${t.bits}`, t.bits, t.signed ? "DW_ATE_signed" : "DW_ATE_unsigned");
        break;
      case "float":
        id = this.diBasic(`f${t.bits}`, t.bits, "DW_ATE_float");
        break;
      case "bool":
        id = this.diBasic("bool", 8, "DW_ATE_boolean"); // i1 occupies a byte in an alloca
        break;
      case "ptr": case "heap": case "ref":
        id = this.diPointer(this.diType(t.inner));
        break;
      case "string":
        id = this.diComposite("string", ["ptr", "i64", "i64"], ["data", "len", "cap"],
          [{ tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, { tag: "int", bits: 64, signed: true }, { tag: "int", bits: 64, signed: true }], key);
        break;
      case "vec": {
        const el = this.host.llvmType(t.element);
        id = this.diComposite(`Vec<${el}>`, ["ptr", "i64", "i64"], ["data", "len", "cap"],
          [{ tag: "ptr", inner: t.element }, { tag: "int", bits: 64, signed: true }, { tag: "int", bits: 64, signed: true }], key);
        break;
      }
      case "hashmap": {
        const i64: TypeKind = { tag: "int", bits: 64, signed: true };
        id = this.diComposite("HashMap", ["ptr", ...Array(HASHMAP_FIELDS - 1).fill("i64")], ["data", "len", "cap", "seed", "tombstones"],
          [{ tag: "ptr", inner: { tag: "unknown" } }, ...Array(HASHMAP_FIELDS - 1).fill(i64)], key);
        break;
      }
      case "struct": {
        const layout = this.host.structLayouts.get(t.name);
        if (!layout) return null;
        id = this.diComposite(t.name, layout.fields.map(f => f.type), layout.fields.map(f => f.name), layout.fields.map(f => f.typeKind), key);
        break;
      }
      case "enum": {
        const layout = this.host.enumLayouts.get(t.name);
        if (!layout) return null;
        id = this.diEnum(layout, key);
        break;
      }
      case "array": {
        if (t.size === null) return null; // slice — no fixed extent to describe yet
        const base = this.diType(t.element);
        if (base === null) return null;
        const sub = this.metaCounter++;
        this.diNodes.push(`!${sub} = !DISubrange(count: ${t.size})`);
        const subs = this.metaCounter++;
        this.diNodes.push(`!${subs} = !{!${sub}}`);
        id = this.metaCounter++;
        this.diNodes.push(`!${id} = !DICompositeType(tag: DW_TAG_array_type, baseType: !${base}, size: ${this.host.typeSizeOf(t) * 8}, elements: !${subs})`);
        break;
      }
      default:
        return null; // fn / interface / void / unknown
    }
    this.diTypes.set(key, id);
    return id;
  }

  // A DILocalVariable for `varName` in `scope`, or null when its type cannot be modelled.
  localVariable(varName: string, t: TypeKind, argIndex: number, scope: number, fileId: number, line: number): number | null {
    const ty = this.diType(t);
    if (ty === null) return null;
    const varId = this.metaCounter++;
    const argAttr = argIndex > 0 ? `arg: ${argIndex}, ` : "";
    this.diNodes.push(`!${varId} = !DILocalVariable(name: "${this.diEsc(varName)}", ${argAttr}scope: !${scope}, file: !${fileId}, line: ${line}, type: !${ty})`);
    return varId;
  }

  // Resolve deferred ;MILODBG markers into real !dbg attachments over the assembled
  // module. Scope comes from the enclosing function's define-line subprogram, so
  // closures/trampolines (no subprogram) get their markers stripped instead of
  // mis-scoped — the one rule the LLVM verifier enforces on debug locations. Also
  // back-fills prologue/contract/drop instructions with the function line so that
  // any `call` in a debug-info function carries a location (verifier requirement).
  apply(out: string[]): void {
    const MARK = " ;MILODBG ";
    let curSp = -1;
    let curLine = 0;
    for (let i = 0; i < out.length; i++) {
      const l = out[i];
      if (l.startsWith("define ")) {
        const m = l.match(/ !dbg !(\d+) \{$/);
        if (m) { curSp = parseInt(m[1], 10); curLine = this.diSubprogramLine.get(curSp) ?? 0; }
        else curSp = -1;
        continue;
      }
      if (l === "}") { curSp = -1; continue; }
      const mk = l.indexOf(MARK);
      if (curSp < 0) {
        // A dbg.declare can only ride into a subprogram-less body (closure/trampoline)
        // if scope leaked during its generation; drop it so its mis-scoped variable
        // can't reach the verifier. The orphaned DILocalVariable node is harmless.
        if (l.includes("@llvm.dbg.declare")) { out.splice(i, 1); i--; continue; }
        if (mk >= 0) out[i] = l.slice(0, mk); // drop stray marker in a non-debug fn
        continue;
      }
      if (mk >= 0) {
        const parts = l.slice(mk + MARK.length).split(" ");
        const locId = this.diLocation(parseInt(parts[0], 10), parseInt(parts[1], 10) || 0, curSp);
        out[i] = l.slice(0, mk) + `, !dbg !${locId}`;
      } else if (l.length >= 2 && l[0] === " " && l[1] === " ") {
        const t = l.trimStart();
        if (t.length > 0 && t[0] !== ";" && !l.includes("!dbg")) {
          out[i] = l + `, !dbg !${this.diLocation(curLine, 0, curSp)}`;
        }
      }
    }

    if (this.diNodes.length === 0) return; // no user functions → nothing to anchor
    const cu = this.diCompileUnit();
    const dwarfVer = this.metaCounter++;
    const dbgVer = this.metaCounter++;
    out.push("");
    for (const n of this.diNodes) out.push(n);
    out.push(`!${dwarfVer} = !{i32 2, !"Dwarf Version", i32 4}`);
    out.push(`!${dbgVer} = !{i32 2, !"Debug Info Version", i32 3}`);
    out.push(`!llvm.dbg.cu = !{!${cu}}`);
    out.push(`!llvm.module.flags = !{!${dwarfVer}, !${dbgVer}}`);
  }
}
