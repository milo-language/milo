// Locates the LLVM bin directory (clang, llvm-cov, ...) for tools that must not depend on the codegen backend.
import { existsSync } from "fs";
import { join } from "path";

// The LLVM whose clang compiles the module, the one milo-opt was built against (mlir/build.sh
// looks in the same places).
function findLlvmBin(): string {
  if (process.env.MILO_LLVM_BIN) return process.env.MILO_LLVM_BIN;
  const dirs = ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin", "/home/linuxbrew/.linuxbrew/opt/llvm/bin", "/usr/lib/llvm-23/bin"];
  return dirs.find(d => existsSync(join(d, "clang"))) ?? dirs[0];
}
export const LLVM_BIN = findLlvmBin();
