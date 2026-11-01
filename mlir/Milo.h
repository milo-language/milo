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
class ConversionPatternRewriter;
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
// A string, a Vec, or a struct or enum holding one: values with drop glue, which only
// owned slots hold.
bool needsDrop(mlir::Type t);
void registerPasses();
void registerScalarPasses();
void registerDropPasses();
// How the symbol of a legacy helper (print, drop, push) spells a type; codegen builds the
// same names from Milo types (emit-mlir.ts typeKey).
std::string typeKey(mlir::Type t);
// A stack slot of LLVM type `t` at the top of the function's entry block, so code in a
// loop does not grow the frame. For ops that sit directly in the function body.
mlir::Value entrySlot(mlir::ConversionPatternRewriter &rw, mlir::Operation *op, mlir::Type t);
// Lowers the ownership ops (Drops.cpp) inside convert-milo-to-llvm.
void populateOwnedToLLVMPatterns(mlir::LLVMTypeConverter &tc,
                                 mlir::RewritePatternSet &patterns);
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
