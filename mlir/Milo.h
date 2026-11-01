// Declarations for the milo dialect, its side-effect resources and its passes.
#pragma once
#include "mlir/Bytecode/BytecodeOpInterface.h"
#include "mlir/IR/Builders.h"
#include "mlir/IR/BuiltinOps.h"
#include "mlir/IR/BuiltinTypes.h"
#include "mlir/IR/Dialect.h"
#include "mlir/IR/OpDefinition.h"
#include "mlir/Interfaces/SideEffectInterfaces.h"
#include "mlir/Interfaces/InferTypeOpInterface.h"

namespace mlir {
class LLVMTypeConverter;
class RewritePatternSet;
} // namespace mlir

namespace milo {
struct VecHeaderResource
    : mlir::SideEffects::Resource::Base<VecHeaderResource> {
  llvm::StringRef getName() const final { return "milo.vec.header"; }
};
struct VecElemsResource : mlir::SideEffects::Resource::Base<VecElemsResource> {
  llvm::StringRef getName() const final { return "milo.vec.elems"; }
};
struct SlotResource : mlir::SideEffects::Resource::Base<SlotResource> {
  llvm::StringRef getName() const final { return "milo.slot"; }
};
struct PanicResource : mlir::SideEffects::Resource::Base<PanicResource> {
  llvm::StringRef getName() const final { return "milo.panic"; }
  bool isAddressable() const final { return false; }
};
void registerPasses();
void registerScalarPasses();
// The address of a private NUL-terminated constant holding `s`, one per distinct text.
mlir::Value globalString(mlir::OpBuilder &b, mlir::Location loc, mlir::ModuleOp module,
                         llvm::StringRef s);
// Lowers the source-level scalar ops (Scalar.cpp) inside convert-milo-to-llvm.
void populateScalarToLLVMPatterns(mlir::LLVMTypeConverter &tc,
                                  mlir::RewritePatternSet &patterns);
} // namespace milo

#include "MiloDialect.h.inc"
#include "MiloEnums.h.inc"
#define GET_TYPEDEF_CLASSES
#include "MiloTypes.h.inc"
#define GET_OP_CLASSES
#include "MiloOps.h.inc"
