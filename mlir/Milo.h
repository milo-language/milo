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
#include "mlir/Interfaces/ControlFlowInterfaces.h"
#include "mlir/Interfaces/InferIntRangeInterface.h"
#include "mlir/Interfaces/LoopLikeInterface.h"
#include "mlir/Interfaces/CallInterfaces.h"
#include "mlir/IR/SymbolTable.h"

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

namespace milo::detail {
// Storage of the identified aggregates (Milo.td StructType, EnumType): uniqued by name,
// the body set once by mutate, after the type exists, so it can refer to itself.
struct StructTypeStorage : mlir::TypeStorage {
  using KeyTy = llvm::StringRef;
  explicit StructTypeStorage(llvm::StringRef name) : name(name) {}
  bool operator==(const KeyTy &k) const { return k == name; }
  static llvm::hash_code hashKey(const KeyTy &k) { return llvm::hash_value(k); }
  static StructTypeStorage *construct(mlir::TypeStorageAllocator &a, const KeyTy &k) {
    return new (a.allocate<StructTypeStorage>()) StructTypeStorage(a.copyInto(k));
  }
  llvm::LogicalResult mutate(mlir::TypeStorageAllocator &a, llvm::ArrayRef<mlir::Type> f,
                             bool drop) {
    if (initialized)
      return llvm::success(f == fields && drop == userDrop);
    fields = a.copyInto(f);
    userDrop = drop;
    initialized = true;
    return llvm::success();
  }
  llvm::StringRef name;
  llvm::ArrayRef<mlir::Type> fields;
  bool userDrop = false;
  bool initialized = false;
};

struct EnumTypeStorage : mlir::TypeStorage {
  using KeyTy = llvm::StringRef;
  explicit EnumTypeStorage(llvm::StringRef name) : name(name) {}
  bool operator==(const KeyTy &k) const { return k == name; }
  static llvm::hash_code hashKey(const KeyTy &k) { return llvm::hash_value(k); }
  static EnumTypeStorage *construct(mlir::TypeStorageAllocator &a, const KeyTy &k) {
    return new (a.allocate<EnumTypeStorage>()) EnumTypeStorage(a.copyInto(k));
  }
  llvm::LogicalResult mutate(mlir::TypeStorageAllocator &a, int64_t sz, int64_t al,
                             llvm::ArrayRef<int32_t> tg, llvm::ArrayRef<mlir::TupleType> vs,
                             llvm::ArrayRef<int64_t> offs, bool drop) {
    if (initialized)
      return llvm::success(sz == size && al == align && tg == tags && vs == variants &&
                           offs == offsets && drop == userDrop);
    size = sz;
    align = al;
    tags = a.copyInto(tg);
    variants = a.copyInto(vs);
    offsets = a.copyInto(offs);
    userDrop = drop;
    initialized = true;
    return llvm::success();
  }
  llvm::StringRef name;
  int64_t size = 0, align = 0;
  llvm::ArrayRef<int32_t> tags;
  llvm::ArrayRef<mlir::TupleType> variants;
  llvm::ArrayRef<int64_t> offsets;
  bool userDrop = false;
  bool initialized = false;
};
} // namespace milo::detail

#include "MiloDialect.h.inc"
#include "MiloEnums.h.inc"
#define GET_TYPEDEF_CLASSES
#include "MiloTypes.h.inc"
#define GET_OP_CLASSES
#include "MiloOps.h.inc"
