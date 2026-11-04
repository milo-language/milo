// milo-opt: mlir-opt with the milo dialect and passes registered.
//
// `milo-opt --emit-llvmir <passes...> < in.mlir` runs the passes and prints LLVM IR (the
// runtime sections linked in, Link.cpp), what
// `milo-opt <passes> | mlir-translate --mlir-to-llvmir` prints, in one process: a build
// through MLIR spends most of its extra time starting processes.
#include "Milo.h"
#include "mlir/IR/MLIRContext.h"
#include "mlir/InitAllDialects.h"
#include "mlir/InitAllPasses.h"
#include "mlir/Parser/Parser.h"
#include "mlir/Pass/PassManager.h"
#include "mlir/Pass/PassRegistry.h"
#include "mlir/Support/Timing.h"
#include "mlir/Target/LLVMIR/Dialect/Builtin/BuiltinToLLVMIRTranslation.h"
#include "mlir/Target/LLVMIR/Dialect/LLVMIR/LLVMToLLVMIRTranslation.h"
#include "mlir/Target/LLVMIR/Export.h"
#include "mlir/Tools/mlir-opt/MlirOptMain.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/CommandLine.h"
#include "llvm/Support/InitLLVM.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/BinaryFormat/Dwarf.h"
#include "llvm/IR/DebugInfo.h"
#include "llvm/IR/DebugInfoMetadata.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Support/SourceMgr.h"
#include <cstring>

// MLIR's debug-info attributes have no enumerator, so the DI type builder writes each one as
// a DW_TAG_member flagged EnumClass (no real member has that flag) with its value in
// `offsetInBits` (the LLVM verifier rejects DW_TAG_enumerator there). Here each such element
// of an enumeration type becomes the DIEnumerator lldb reads an enum's variant names from.
// The composites are distinct nodes, so their elements tuple can be replaced in place.
static void rewriteEnumerators(llvm::Module &m) {
  llvm::DebugInfoFinder finder;
  finder.processModule(m);
  llvm::LLVMContext &c = m.getContext();
  for (llvm::DIType *t : finder.types()) {
    auto *ct = llvm::dyn_cast<llvm::DICompositeType>(t);
    if (!ct || ct->getTag() != llvm::dwarf::DW_TAG_enumeration_type)
      continue;
    llvm::SmallVector<llvm::Metadata *> elems;
    bool changed = false;
    for (llvm::Metadata *e : ct->getElements()) {
      auto *d = llvm::dyn_cast_or_null<llvm::DIDerivedType>(e);
      if (d && d->getTag() == llvm::dwarf::DW_TAG_member && (d->getFlags() & llvm::DINode::FlagEnumClass)) {
        elems.push_back(llvm::DIEnumerator::get(c, llvm::APInt(64, d->getOffsetInBits()), /*IsUnsigned=*/false, d->getName()));
        changed = true;
      } else {
        elems.push_back(e);
      }
    }
    if (changed)
      ct->replaceElements(llvm::MDTuple::get(c, elems));
  }
}

static int emitLLVMIR(int argc, char **argv, mlir::DialectRegistry &registry) {
  llvm::InitLLVM init(argc, argv);
  mlir::registerPassManagerCLOptions();
  // --mlir-disable-threading and --mlir-timing: the build-time profile of a real compile.
  mlir::registerMLIRContextCLOptions();
  mlir::registerDefaultTimingManagerCLOptions();
  mlir::PassPipelineCLParser pipeline("", "Passes to run before translating");
  llvm::cl::ParseCommandLineOptions(argc, argv, "milo-opt --emit-llvmir\n");

  mlir::registerBuiltinDialectTranslation(registry);
  mlir::registerLLVMDialectTranslation(registry);
  mlir::MLIRContext ctx(registry);
  auto input = llvm::MemoryBuffer::getSTDIN();
  if (!input) {
    llvm::errs() << "milo-opt: cannot read stdin\n";
    return 1;
  }
  llvm::SourceMgr sm;
  sm.AddNewSourceBuffer(std::move(*input), llvm::SMLoc());
  mlir::OwningOpRef<mlir::ModuleOp> module = mlir::parseSourceFile<mlir::ModuleOp>(sm, &ctx);
  if (!module)
    return 1;
  mlir::PassManager pm(&ctx, mlir::ModuleOp::getOperationName(),
                       mlir::OpPassManager::Nesting::Implicit);
  if (failed(mlir::applyPassManagerCLOptions(pm)))
    return 1;
  auto tm = std::make_unique<mlir::DefaultTimingManager>();
  mlir::applyDefaultTimingManagerCLOptions(*tm);
  pm.enableTiming(std::move(tm));
  auto err = [](const llvm::Twine &msg) {
    llvm::errs() << msg << "\n";
    return mlir::failure();
  };
  if (failed(pipeline.addToPipeline(pm, err)) || failed(pm.run(*module)))
    return 1;
  milo::ModuleConfig config = milo::takeModuleConfig(*module);
  llvm::LLVMContext llctx;
  auto ll = mlir::translateModuleToLLVMIR(*module, llctx);
  if (!ll || !milo::finishModule(*ll, config))
    return 1;
  rewriteEnumerators(*ll);
  ll->print(llvm::outs(), nullptr);
  return 0;
}

int main(int argc, char **argv) {
  mlir::DialectRegistry registry;
  mlir::registerAllDialects(registry);
  registry.insert<milo::MiloDialect>();
  mlir::registerAllPasses();
  milo::registerPasses();
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--emit-llvmir") != 0)
      continue;
    for (int j = i; j + 1 < argc; j++)
      argv[j] = argv[j + 1];
    return emitLLVMIR(argc - 1, argv, registry);
  }
  return mlir::asMainReturnCode(
      mlir::MlirOptMain(argc, argv, "milo optimizer driver\n", registry));
}
