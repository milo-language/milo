// Declarations for the milo dialect, its side-effect resources and its passes.
#pragma once
#include "mlir/Bytecode/BytecodeOpInterface.h"
#include "mlir/IR/BuiltinTypes.h"
#include "mlir/IR/Dialect.h"
#include "mlir/IR/OpDefinition.h"
#include "mlir/Interfaces/SideEffectInterfaces.h"

namespace milo {
struct VecHeaderResource
    : mlir::SideEffects::Resource::Base<VecHeaderResource> {
  llvm::StringRef getName() const final { return "milo.vec.header"; }
};
struct VecElemsResource : mlir::SideEffects::Resource::Base<VecElemsResource> {
  llvm::StringRef getName() const final { return "milo.vec.elems"; }
};
struct PanicResource : mlir::SideEffects::Resource::Base<PanicResource> {
  llvm::StringRef getName() const final { return "milo.panic"; }
  bool isAddressable() const final { return false; }
};
void registerPasses();
} // namespace milo

#include "MiloDialect.h.inc"
#define GET_TYPEDEF_CLASSES
#include "MiloTypes.h.inc"
#define GET_OP_CLASSES
#include "MiloOps.h.inc"
