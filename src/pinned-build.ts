// Pinned build pipeline per safety profile (docs/plans/object-level-assurance.md step 1).
// A profile is a claim about the BINARY, so it fixes what produced the binary: the opt level,
// the milo-opt pass pipeline, no LTO, one codegen unit, and the LLVM major. `milo build
// --safety=<p>` builds with exactly that and writes the record into the binary; `milo verify
// --profile <p> <binary>` reads it back and refuses a mismatch.
//
// Where the record lives: a constant global `__milo_pin` (kept by llvm.used, which also
// carries SHF_GNU_RETAIN through lld's --gc-sections) in section `.rodata.milo_pin` on ELF
// and `__TEXT,__milo_pin` on Mach-O. A note section was the first choice, but Mach-O has no
// notes and `.note.*` needs a per-format directive; a named constant global is one IR line
// on every target. The reader does not parse section tables: it finds the magic bytes.
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { join } from "path";
import type { SafetyLevel } from "./safety";
import type { TargetInfo } from "./target";
import { MLIR_PIPELINE, MILO_OPT } from "./mlir-backend";
import { LLVM_BIN } from "./llvm-toolchain";

export const PIN_MAGIC = "MILO-PIN\0";
export const PIN_SYMBOL = "__milo_pin";

export interface PinRecord {
  v: 1;
  profile: SafetyLevel;
  opt: string;            // clang -O level of the object compile
  pipeline: string;       // the milo-opt --pass-pipeline text
  lto: "none";
  cgus: 1;                // one module, so no cross-unit promotion decides inlining
  llvmMajor: number;
  llvm: string;           // clang --version first line, for the human
  miloOptSha256: string;  // identity of the milo-opt that ran the pipeline
  triple: string;
  overflowChecks: boolean;
  noalias: boolean;
}

/** What a profile fixes. Every profile pins the same toolchain today; the table is per
 *  profile so one can diverge (a looser DAL C) without touching the check. */
export interface Pin { opt: string; pipeline: string; lto: "none"; cgus: 1; llvmMajor: number; overflowChecks: boolean }

export function pinFor(_level: SafetyLevel): Pin {
  return { opt: "-O2", pipeline: MLIR_PIPELINE, lto: "none", cgus: 1, llvmMajor: PINNED_LLVM_MAJOR, overflowChecks: true };
}
export const PINNED_LLVM_MAJOR = 23;

function llvmVersionLine(): string {
  const r = spawnSync(join(LLVM_BIN, "clang"), ["--version"], { encoding: "utf-8" });
  return (r.stdout ?? "").split("\n")[0] ?? "";
}
export function llvmMajorOf(line: string): number {
  const m = /version (\d+)/.exec(line);
  return m ? Number(m[1]) : 0;
}

/** Why this build cannot carry the profile's pin, or null. Anything that changes the code
 *  after the pins (a different -O, extra passes via -g, sanitizers, wrapping arithmetic) is
 *  a refusal, not a quiet override. */
export function buildRefusal(level: SafetyLevel, o: { optFlag: string; emitDebug: boolean; sanitize: boolean; hot: boolean; overflowChecks: boolean | null; cgus: number | null; target: TargetInfo }): string | null {
  const pin = pinFor(level);
  if (o.optFlag !== pin.opt) return `--safety=${level} pins ${pin.opt}, not ${o.optFlag} (drop --release/--debug/--fast)`;
  if (o.emitDebug) return `--safety=${level} pins the pass pipeline, and -g adds a pass; drop -g`;
  if (o.sanitize || o.hot) return `--safety=${level} cannot be combined with --sanitize/--hot`;
  if (o.overflowChecks === false) return `--safety=${level} pins overflow traps on; drop --no-overflow-checks/--fast`;
  if (o.cgus !== null && o.cgus !== 1) return `--safety=${level} pins one codegen unit, not --cgus=${o.cgus}`;
  if (o.target.arch === "wasm64") return `--safety=${level} has no pinned pipeline for wasm64`;
  return null;
}

export function buildRecord(level: SafetyLevel, o: { target: TargetInfo; optFlag: string }): PinRecord {
  const llvm = llvmVersionLine();
  let sha = "unknown";
  try { sha = createHash("sha256").update(readFileSync(MILO_OPT)).digest("hex"); } catch {}
  return {
    v: 1, profile: level, opt: o.optFlag, pipeline: MLIR_PIPELINE, lto: "none", cgus: 1,
    llvmMajor: llvmMajorOf(llvm), llvm, miloOptSha256: sha, triple: o.target.triple,
    overflowChecks: true, noalias: process.env.MILO_NOALIAS === "1",
  };
}

// LLVM IR `c"..."` escaping: printable ASCII except `"` and `\` stays, the rest is \XX.
function irBytes(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf-8")) out += b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : "\\" + b.toString(16).toUpperCase().padStart(2, "0");
  return out;
}

/** IR text appended to the module (after milo-opt, so the record names what ran, and the
 *  pipeline cannot be changed without this line saying so). */
export function recordIr(rec: PinRecord, target: TargetInfo): string {
  const payload = PIN_MAGIC + JSON.stringify(rec) + "\0";
  const n = Buffer.byteLength(payload);
  const section = target.os === "darwin" ? "__TEXT,__milo_pin" : ".rodata.milo_pin";
  return `\n@${PIN_SYMBOL} = constant [${n} x i8] c"${irBytes(payload)}", section "${section}", align 1\n` +
    `@llvm.used = appending global [1 x ptr] [ptr @${PIN_SYMBOL}], section "llvm.metadata"\n`;
}

/** The record in a linked binary. Throws when there is none or more than one: a binary
 *  with two records was linked from two builds and claims neither. */
export function readRecord(binPath: string): PinRecord {
  const buf = readFileSync(binPath);
  const magic = Buffer.from(PIN_MAGIC, "latin1");
  const at = buf.indexOf(magic);
  if (at < 0) throw new Error(`${binPath} carries no pinned-build record (not built with --safety=<profile>)`);
  if (buf.indexOf(magic, at + 1) >= 0) throw new Error(`${binPath} carries more than one pinned-build record`);
  const start = at + magic.length;
  const end = buf.indexOf(0, start);
  if (end < 0) throw new Error(`${binPath}: pinned-build record is truncated`);
  try { return JSON.parse(buf.subarray(start, end).toString("utf-8")) as PinRecord; }
  catch { throw new Error(`${binPath}: pinned-build record is not valid JSON`); }
}

/** Every way the record differs from what `level` pins. Empty = the binary was built to the pin. */
export function pinMismatches(rec: PinRecord, level: SafetyLevel): string[] {
  const pin = pinFor(level);
  const bad: string[] = [];
  if (rec.profile !== level) bad.push(`built for profile ${rec.profile}, verifying ${level}`);
  if (rec.opt !== pin.opt) bad.push(`opt level ${rec.opt}, pinned ${pin.opt}`);
  if (rec.pipeline !== pin.pipeline) bad.push("milo-opt pass pipeline differs from the pinned pipeline");
  if (rec.lto !== pin.lto) bad.push(`lto ${rec.lto}, pinned ${pin.lto}`);
  if (rec.cgus !== pin.cgus) bad.push(`${rec.cgus} codegen units, pinned ${pin.cgus}`);
  if (rec.llvmMajor !== pin.llvmMajor) bad.push(`LLVM ${rec.llvmMajor}, pinned ${pin.llvmMajor}`);
  if (rec.overflowChecks !== pin.overflowChecks) bad.push("overflow checks off, pinned on");
  return bad;
}
