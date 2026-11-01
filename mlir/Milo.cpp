// milo dialect registration and the tablegen'd type and op definitions.
#include "Milo.h"
#include "mlir/IR/Builders.h"
#include "mlir/IR/DialectImplementation.h"
#include "llvm/ADT/TypeSwitch.h"

using namespace mlir;
using namespace milo;

#include "MiloDialect.cpp.inc"
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
