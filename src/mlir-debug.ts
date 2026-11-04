// -g: the module's DICompileUnit and a DISubprogram per Milo function and closure body, as
// LLVM-dialect debug attributes fused into their locs. What has no source of its own (glue,
// the scaffold) gets no subprogram, so the translation drops its locations: inlined into a
// Milo function it takes the call's line, as C's libc calls do, and never shows up as a
// frame of its own.
import { basename, dirname } from "path";
import type { HIRFunction } from "./hir";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export class DebugInfo {
  private readonly defs: string[] = [];
  private readonly files = new Map<string, string>();
  private readonly sps = new Map<string, string>();
  private readonly cu: string;

  /** `entry`: the absolute path of the file being compiled. `name`: a symbol as the program spells it. */
  constructor(private readonly entry: string, private readonly name: (symbol: string) => string, private readonly dwarfPath: (file: string | undefined) => string) {
    this.defs.push(`#milo_st = #llvm.di_subroutine_type<types = #llvm.di_null_type>`);
    this.cu = "#milo_cu";
    this.defs.push(`${this.cu} = #llvm.di_compile_unit<id = distinct[0]<>, sourceLanguage = DW_LANG_C99, file = ${this.file(entry)}, producer = "milo", isOptimized = false, emissionKind = Full>`);
  }

  private file(abs: string): string {
    const known = this.files.get(abs);
    if (known) return known;
    const id = `#milo_file${this.files.size}`;
    this.files.set(abs, id);
    this.defs.push(`${id} = #llvm.di_file<"${esc(basename(abs))}" in "${esc(dirname(abs))}">`);
    return id;
  }

  // A DWARF display name is what a debugger shows: `tone`, not the per-module `gfx$tone`. No
  // linkageName on purpose: lldb DISPLAYS the linkage name in every backtrace frame when it
  // is present. The DIE is matched to code by DW_AT_low_pc, not by name.
  /** `loc` (the function's `"file":line:col`) fused with fn's subprogram. */
  fnLoc(fn: HIRFunction, loc: string): string {
    return this.subprogram(fn.name, this.name(fn.name), fn.sourceFile, fn.line ?? 0, loc);
  }

  /** A closure body's loc fused with a subprogram of its own, named by its symbol. */
  closureLoc(symbol: string, file: string | undefined, line: number, loc: string): string {
    return this.subprogram(symbol, symbol, file, line, loc);
  }

  private subprogram(key: string, name: string, src: string | undefined, line: number, loc: string): string {
    let sp = this.sps.get(key);
    if (!sp) {
      sp = `#milo_sp${this.sps.size}`;
      this.sps.set(key, sp);
      const file = this.file(this.dwarfPath(src));
      this.defs.push(`${sp} = #llvm.di_subprogram<id = distinct[${this.sps.size}]<>, compileUnit = ${this.cu}, scope = ${file}, name = "${esc(name)}", file = ${file}, line = ${line}, scopeLine = ${line}, subprogramFlags = Definition, type = #milo_st>`);
    }
    return `loc(fused<${sp}>[${loc.slice(4, -1)}])`;
  }

  /** The attribute aliases, ahead of the module. */
  aliases(): string { return this.defs.join("\n") + "\n"; }
  /** The module's own loc: where the compile unit is found. */
  moduleLoc(): string { return `loc(fused<${this.cu}>["${esc(this.entry)}":0:0])`; }
}
