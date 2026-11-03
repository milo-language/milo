// DWARF debug metadata for `-g` builds: files, subprograms, locations and variable types,
// interned as `!N = ...` nodes and attached in one final text pass over the module.
// Extracted from codegen.ts; it reads codegen only through `DwarfHost` (names and layout).
import { resolve, dirname, basename } from "path";
import type { HIRFunction } from "./hir";
import type { TypeKind } from "./types";
import type { StructLayout, EnumLayout } from "./codegen";

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

  constructor(private host: DwarfHost) {}

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
