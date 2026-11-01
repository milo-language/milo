// milo dialect registration and the tablegen'd type and op definitions.
#include "Milo.h"
#include "mlir/IR/Builders.h"
#include "mlir/IR/DialectImplementation.h"
#include "mlir/Interfaces/FunctionInterfaces.h"
#include "llvm/ADT/TypeSwitch.h"

using namespace mlir;
using namespace milo;

#include "MiloDialect.cpp.inc"
#include "MiloEnums.cpp.inc"
#define GET_TYPEDEF_CLASSES
#include "MiloTypes.cpp.inc"
#define GET_OP_CLASSES
#include "MiloOps.cpp.inc"

void MiloDialect::initialize() {
  addTypes<
#define GET_TYPEDEF_LIST
#include "MiloTypes.cpp.inc"
      >();
  addOperations<
#define GET_OP_LIST
#include "MiloOps.cpp.inc"
      >();
}

//===----------------------------------------------------------------------===//
// Verifiers and effects of the source-level ops.
//===----------------------------------------------------------------------===//

OpFoldResult ConstOp::fold(FoldAdaptor) { return getValue(); }

// A fold that yields a constant of a milo type gets a milo.const.
Operation *MiloDialect::materializeConstant(OpBuilder &b, Attribute value, Type type,
                                            Location loc) {
  auto typed = dyn_cast<TypedAttr>(value);
  if (!typed || typed.getType() != type)
    return nullptr;
  if (!isa<IntegerType, FloatType>(type))
    return nullptr;
  if (auto it = dyn_cast<IntegerType>(type); it && it.isSignless() && it.getWidth() != 1)
    return nullptr;
  return ConstOp::create(b, loc, type, typed);
}

static bool isMiloInt(Type t) {
  auto i = dyn_cast<IntegerType>(t);
  return i && !i.isSignless();
}

// Only integer arithmetic can overflow, so only it may carry `wrapping`.
static LogicalResult verifyWrapping(Operation *op, bool wrapping) {
  if (wrapping && !isMiloInt(op->getResult(0).getType()))
    return op->emitOpError("'wrapping' applies to integer ops only");
  return success();
}

// An op that can panic writes the panic resource: that orders it against other panic
// points and keeps it alive when its result is unused (a dead `a / b` must still trap).
#define MILO_ARITH(OpT, PANICS)                                                \
  LogicalResult OpT::verify() { return verifyWrapping(*this, getWrapping()); } \
  void OpT::getEffects(                                                        \
      SmallVectorImpl<SideEffects::EffectInstance<MemoryEffects::Effect>>      \
          &effects) {                                                          \
    if (isMiloInt(getType()) && (PANICS))                                      \
      effects.emplace_back(MemoryEffects::Write::get(), PanicResource::get()); \
  }
MILO_ARITH(AddOp, !getWrapping())
MILO_ARITH(SubOp, !getWrapping())
MILO_ARITH(MulOp, !getWrapping())
MILO_ARITH(ShlOp, !getWrapping())
MILO_ARITH(ShrOp, !getWrapping())
// A zero divisor panics even under `wrapping`.
MILO_ARITH(DivOp, true)
MILO_ARITH(RemOp, true)
MILO_ARITH(NegOp, !getWrapping())
#undef MILO_ARITH

LogicalResult VarOp::verify() {
  if (!(*this)->getBlock()->isEntryBlock() ||
      !isa<FunctionOpInterface>((*this)->getParentOp()))
    return emitOpError("must be in the function's entry block");
  return success();
}

LogicalResult IfOp::verify() {
  if (!getResults().empty() && getElseRegion().empty())
    return emitOpError("with results needs an else region");
  return success();
}

LogicalResult IndexOp::verify() {
  if (getType() != getVec().getType().getElementType())
    return emitOpError("result is not the Vec's element type");
  return success();
}

LogicalResult IndexStoreOp::verify() {
  if (getValue().getType() != getVec().getType().getElementType())
    return emitOpError("value is not the Vec's element type");
  return success();
}

LogicalResult PrintOp::verify() {
  for (Type t : getParts().getTypes()) {
    auto i = dyn_cast<IntegerType>(t);
    bool ok = (i && (!i.isSignless() || i.getWidth() == 1)) || t.isF32() || t.isF64() ||
              isa<PtrType, StringType>(t);
    if (!ok)
      return emitOpError("cannot display a part of type ") << t;
  }
  return success();
}

LogicalResult ForOp::verify() {
  Type t = getStart().getType();
  Block &entry = getBodyRegion().front();
  if (entry.getNumArguments() != 1 || entry.getArgument(0).getType() != t)
    return emitOpError("body takes one argument, the induction variable of type ") << t;
  return success();
}

LogicalResult YieldOp::verify() {
  Operation *parent = (*this)->getParentOp();
  if (auto ifOp = dyn_cast<IfOp>(parent)) {
    if (getValues().getTypes() != ifOp.getResultTypes())
      return emitOpError("yields types that do not match the enclosing milo.if");
    return success();
  }
  if (!getValues().empty())
    return emitOpError("in a loop body yields no values");
  auto w = dyn_cast<WhileOp>(parent);
  if (w && (*this)->getParentRegion() != &w.getBodyRegion())
    return emitOpError("cannot end the cond region of milo.while");
  return success();
}

LogicalResult ConditionOp::verify() {
  auto w = cast<WhileOp>((*this)->getParentOp());
  if ((*this)->getParentRegion() != &w.getCondRegion())
    return emitOpError("must end the cond region of milo.while");
  return success();
}

// The innermost loop around `op` inside its function, or null. A jump inside the cond
// region of a while has no loop to target: the cond is the loop's header.
static Operation *enclosingLoop(Operation *op) {
  Region *from = op->getParentRegion();
  for (Operation *p = op->getParentOp(); p && !isa<FunctionOpInterface>(p);
       from = p->getParentRegion(), p = p->getParentOp()) {
    if (isa<LoopOp, ForOp>(p))
      return p;
    if (auto w = dyn_cast<WhileOp>(p))
      return from == &w.getBodyRegion() ? p : nullptr;
  }
  return nullptr;
}

LogicalResult BreakOp::verify() {
  if (!enclosingLoop(*this))
    return emitOpError("outside a loop body");
  return success();
}

LogicalResult ContinueOp::verify() {
  if (!enclosingLoop(*this))
    return emitOpError("outside a loop body");
  return success();
}

LogicalResult ReturnOp::verify() {
  auto fn = (*this)->getParentOfType<FunctionOpInterface>();
  if (!fn)
    return emitOpError("outside a function");
  ArrayRef<Type> results = fn.getResultTypes();
  Value v = getValue();
  bool ok = results.size() <= 1 && results.empty() == !v &&
            (!v || v.getType() == results[0]);
  if (!ok)
    return emitOpError("does not match the function's result type");
  return success();
}
