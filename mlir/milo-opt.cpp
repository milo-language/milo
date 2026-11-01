// milo-opt: mlir-opt with the milo dialect and passes registered.
#include "Milo.h"
#include "mlir/InitAllDialects.h"
#include "mlir/InitAllPasses.h"
#include "mlir/Tools/mlir-opt/MlirOptMain.h"

int main(int argc, char **argv) {
  mlir::DialectRegistry registry;
  mlir::registerAllDialects(registry);
  registry.insert<milo::MiloDialect>();
  mlir::registerAllPasses();
  milo::registerPasses();
  return mlir::asMainReturnCode(
      mlir::MlirOptMain(argc, argv, "milo optimizer driver\n", registry));
}
