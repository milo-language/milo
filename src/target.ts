// host platform detection for platform-specific stdlib resolution,
// plus cross-compilation target definitions (incl. bare-metal Cortex-M).
import { arch, platform } from "os";

export interface TargetInfo {
  triple: string;
  // "none" = bare metal / freestanding (no OS, no syscalls); the stdlib
  // platform split (darwin vs linux) does not apply — such targets use the
  // freestanding core subset and semihosting for I/O instead.
  os: "darwin" | "linux" | "none";
  arch: "aarch64" | "x86_64" | "arm";
  bareMetal?: boolean;
  // clang codegen flags for embedded cores: -mcpu selects the core (drives the
  // instruction subset and pipeline model), -mfloat-abi selects how floats are
  // passed (soft = integer regs, hard = FPU regs). Omitted for hosted targets.
  mcpu?: string;
  floatAbi?: "soft" | "softfp" | "hard";
  // QEMU `-machine` that models this core, for `milo run --target=...`. All the
  // MPS2 AN-series boards QEMU ships share the same memory map our linker script
  // targets, so we pick the AN board matching each core.
  qemuMachine?: string;
}

const targets: Record<string, TargetInfo> = {
  // ── hosted (OS-backed) ──
  "macos-arm64": { triple: "aarch64-apple-darwin", os: "darwin", arch: "aarch64" },
  "macos-x64":   { triple: "x86_64-apple-darwin", os: "darwin", arch: "x86_64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", os: "linux", arch: "aarch64" },
  "linux-x64":   { triple: "x86_64-unknown-linux-gnu", os: "linux", arch: "x86_64" },

  // ── bare-metal ARM Cortex-M (Thumb-only cores; "none" OS, EABI) ──
  // Cortex-M cores execute only the Thumb (Thumb-2) instruction set, hence the
  // "thumb…" triple prefix rather than "arm…". These are the WCET-analysis
  // targets: no OS scheduler jitter, statically bounded execution.
  "cortex-m0":  { triple: "thumbv6m-none-eabi",    os: "none", arch: "arm", bareMetal: true, mcpu: "cortex-m0",  floatAbi: "soft", qemuMachine: "mps2-an385" }, // RP2040 (Pi Pico); M0 runs on M3 board under emu
  "cortex-m3":  { triple: "thumbv7m-none-eabi",    os: "none", arch: "arm", bareMetal: true, mcpu: "cortex-m3",  floatAbi: "soft", qemuMachine: "mps2-an385" }, // STM32F1; integer-only, cleanest WCET
  "cortex-m4":  { triple: "thumbv7em-none-eabi",   os: "none", arch: "arm", bareMetal: true, mcpu: "cortex-m4",  floatAbi: "soft", qemuMachine: "mps2-an386" }, // M4 without FPU usage
  "cortex-m4f": { triple: "thumbv7em-none-eabihf", os: "none", arch: "arm", bareMetal: true, mcpu: "cortex-m4",  floatAbi: "hard", qemuMachine: "mps2-an386" }, // STM32F4; hardware FPU
  "cortex-m7":  { triple: "thumbv7em-none-eabihf", os: "none", arch: "arm", bareMetal: true, mcpu: "cortex-m7",  floatAbi: "hard", qemuMachine: "mps2-an500" }, // STM32F7/H7; hardware FPU
};

// Aliases for chip families the user is more likely to name than the core.
const TARGET_ALIASES: Record<string, string> = {
  "rp2040":  "cortex-m0",
  "pico":    "cortex-m0",
  "stm32f1": "cortex-m3",
  "stm32f4": "cortex-m4f",
  "stm32f7": "cortex-m7",
  "stm32h7": "cortex-m7",
};

// Resolve a --target name (core name or chip alias) to a TargetInfo.
// Returns null for unknown names so the caller can emit a helpful error.
export function resolveTarget(name: string): TargetInfo | null {
  if (name in targets) return targets[name]!;
  if (name in TARGET_ALIASES) return targets[TARGET_ALIASES[name]!]!;
  return null;
}

export function listTargets(): string[] {
  return Object.keys(targets);
}

export function getHostTarget(): TargetInfo {
  const a = arch();
  const p = platform();
  if (p === "darwin") {
    return targets[a === "arm64" ? "macos-arm64" : "macos-x64"]!;
  }
  return targets[a === "arm64" || a === "aarch64" ? "linux-arm64" : "linux-x64"]!;
}
