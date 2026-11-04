// The module-level steps of a milo build that no single function sees: milo-merge-scaffold
// folds the process scaffold (src/scaffold.ts: main, panic routines, lazy globals, stdio and
// C ABI helpers) into the lowered program, and finishModule links the fixed runtime sections
// (src/runtime/*.ll) into the translated LLVM module and sets the attributes every function
// of the module gets (sanitize, the record/replay heap's allocator family).
#include "Milo.h"
#include "mlir/Dialect/LLVMIR/LLVMDialect.h"
#include "mlir/IR/BuiltinOps.h"
#include "mlir/IR/SymbolTable.h"
#include "mlir/Pass/Pass.h"
#include "llvm/ADT/StringSet.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Module.h"
#include "llvm/Linker/Linker.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"

using namespace mlir;

namespace {

bool isDeclaration(Operation *op) {
  if (auto f = dyn_cast<LLVM::LLVMFuncOp>(op))
    return f.isExternal();
  if (auto g = dyn_cast<LLVM::GlobalOp>(op))
    return !g.getValueOrNull() && g.getInitializerRegion().empty() &&
           g.getLinkage() == LLVM::Linkage::External;
  return false;
}

// A declaration on one side stands for the definition on the other only when both are
// functions of one type. Globals are told apart by name alone: with opaque pointers an
// address carries no type, and the lowering declares a global it does not describe as a
// placeholder byte (GlobalAddrLowering).
LogicalResult agree(Operation *have, Operation *got) {
  auto hf = dyn_cast<LLVM::LLVMFuncOp>(have), gf = dyn_cast<LLVM::LLVMFuncOp>(got);
  if (!hf != !gf)
    return got->emitOpError("names a symbol the program has as another kind of op");
  if (hf && hf.getFunctionType() != gf.getFunctionType())
    return got->emitOpError() << "is " << gf.getFunctionType() << " in the scaffold but "
                              << hf.getFunctionType() << " in the program";
  return success();
}

// After convert-milo-to-llvm: the program declares what it calls in the scaffold and the
// scaffold declares what it calls in the program (and the libc both call), so each side
// verifies on its own and a C symbol a user extern names too is one declaration here.
// Scaffold symbols marked `milo.on_demand` are listed on the module for finishModule,
// which deletes the ones nothing uses once the runtime is linked in.
struct MergeScaffoldPass : PassWrapper<MergeScaffoldPass, OperationPass<ModuleOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(MergeScaffoldPass)
  StringRef getArgument() const final { return "milo-merge-scaffold"; }
  StringRef getDescription() const final {
    return "Move the milo.scaffold module's symbols into the program, one per name";
  }
  void runOnOperation() override {
    ModuleOp top = getOperation();
    ModuleOp scaffold;
    for (ModuleOp m : top.getOps<ModuleOp>())
      if (m.getSymName() == "milo.scaffold")
        scaffold = m;
    if (!scaffold)
      return;
    SymbolTable table(top);
    SmallVector<Attribute> onDemand;
    for (Operation &op : llvm::make_early_inc_range(scaffold.getBody()->getOperations())) {
      auto sym = dyn_cast<SymbolOpInterface>(&op);
      if (!sym) {
        op.emitOpError("in the scaffold is not a symbol");
        return signalPassFailure();
      }
      StringAttr name = sym.getNameAttr();
      bool lazy = op.removeAttr("milo.on_demand") != nullptr;
      if (Operation *have = table.lookup(name)) {
        if (failed(agree(have, &op)))
          return signalPassFailure();
        if (isDeclaration(&op)) {
          op.erase();
          continue;
        }
        if (!isDeclaration(have)) {
          op.emitOpError("is defined in both the program and the scaffold");
          return signalPassFailure();
        }
        table.erase(have);
      }
      op.remove();
      table.insert(&op);
      if (lazy)
        onDemand.push_back(name);
    }
    scaffold.erase();
    if (!onDemand.empty())
      top->setAttr("milo.on_demand", ArrayAttr::get(&getContext(), onDemand));
  }
};

} // namespace

void milo::registerLinkPasses() { PassRegistration<MergeScaffoldPass>(); }

milo::ModuleConfig milo::takeModuleConfig(ModuleOp m) {
  ModuleConfig c;
  if (auto s = m->getAttrOfType<StringAttr>("milo.runtime_ir"))
    c.runtimeIR = s.str();
  if (auto d = m->getAttrOfType<DictionaryAttr>("milo.link_names"))
    for (NamedAttribute a : d)
      c.linkNames.emplace_back(a.getName().str(), cast<StringAttr>(a.getValue()).str());
  if (auto a = m->getAttrOfType<ArrayAttr>("milo.on_demand"))
    for (Attribute s : a)
      c.onDemand.push_back(cast<StringAttr>(s).str());
  if (auto s = m->getAttrOfType<StringAttr>("milo.sanitize"))
    c.sanitize = s.str();
  c.replayHeap = m->hasAttr("milo.replay_heap");
  for (StringRef k : {"milo.runtime_ir", "milo.link_names", "milo.on_demand", "milo.sanitize", "milo.replay_heap"})
    m->removeAttr(k);
  return c;
}

namespace {

// A per-module extern (`linkName`) is one more typed view of a C symbol: every view's
// calls go to the one declaration. The calls keep their own function types, which an
// LLVM call carries itself (the MLIR call verifier would hold them to one).
void applyLinkNames(llvm::Module &ll, const milo::ModuleConfig &c) {
  for (auto &[from, to] : c.linkNames) {
    llvm::Function *f = ll.getFunction(from);
    if (!f || !f->isDeclaration())
      continue;
    if (llvm::GlobalValue *g = ll.getNamedValue(to)) {
      f->replaceAllUsesWith(g);
      f->eraseFromParent();
    } else {
      f->setName(to);
    }
  }
}

// The runtime sections define their functions internal, as the program's own. A local
// symbol takes no part in linking, so every name one module defines and the other
// declares is made external for the link and internal again after it.
bool linkRuntime(llvm::Module &ll, const std::string &text) {
  if (text.empty())
    return true;
  llvm::SMDiagnostic err;
  std::unique_ptr<llvm::Module> rt = llvm::parseAssemblyString(text, err, ll.getContext());
  if (!rt) {
    err.print("milo runtime", llvm::errs());
    return false;
  }
  rt->setTargetTriple(ll.getTargetTriple());
  rt->setDataLayout(ll.getDataLayout());
  llvm::StringSet<> promoted;
  auto promote = [&](llvm::GlobalValue &g) {
    if (g.hasLocalLinkage()) {
      g.setLinkage(llvm::GlobalValue::ExternalLinkage);
      g.setVisibility(llvm::GlobalValue::DefaultVisibility);
    }
  };
  for (llvm::GlobalValue &g : rt->global_values()) {
    llvm::GlobalValue *d = ll.getNamedValue(g.getName());
    if (!d || d->isDeclaration() == g.isDeclaration())
      continue;
    promote(g);
    promote(*d);
    promoted.insert(g.getName());
  }
  if (llvm::Linker::linkModules(ll, std::move(rt)))
    return false;
  for (auto &p : promoted)
    if (llvm::GlobalValue *g = ll.getNamedValue(p.getKey()); g && !g->isDeclaration())
      g->setLinkage(llvm::GlobalValue::InternalLinkage);
  return true;
}

// Scaffold symbols exist for whoever uses them (a panic routine, a process global); with the
// runtime linked in, a use from either side is known.
void pruneOnDemand(llvm::Module &ll, const milo::ModuleConfig &c) {
  for (bool changed = true; changed;) {
    changed = false;
    for (const std::string &name : c.onDemand) {
      llvm::GlobalValue *g = ll.getNamedValue(name);
      if (!g)
        continue;
      g->removeDeadConstantUsers();
      if (!g->use_empty())
        continue;
      g->eraseFromParent();
      changed = true;
    }
  }
}

// clang attaches sanitize_* in its frontend, which a .ll input bypasses: without it
// `-fsanitize=address` links the runtime and instruments nothing.
void applySanitize(llvm::Module &ll, const std::string &kind) {
  if (kind.empty())
    return;
  auto a = kind == "thread" ? llvm::Attribute::SanitizeThread : llvm::Attribute::SanitizeAddress;
  for (llvm::Function &f : ll)
    if (!f.isDeclaration())
      f.addFnAttr(a);
}

// std/replay's fixed-address heap: every allocation the program makes, the runtime's and
// the compiler's helpers' included, goes through replayHeapMalloc/Realloc/Free, which hand
// it to libc unless the heap is on. The allocator's own functions are what call libc. The
// three are an allocation family, as malloc/realloc/free are, so LLVM still deletes an
// allocation that never escapes along with its free.
bool applyReplayHeap(llvm::Module &ll) {
  llvm::LLVMContext &cx = ll.getContext();
  llvm::Function *m = ll.getFunction("replayHeapMalloc");
  llvm::Function *r = ll.getFunction("replayHeapRealloc");
  llvm::Function *f = ll.getFunction("replayHeapFree");
  if (!m || !r || !f || m->isDeclaration() || r->isDeclaration() || f->isDeclaration()) {
    llvm::errs() << "milo: the replay heap is on but std/replay's allocator is not defined\n";
    return false;
  }
  m->addFnAttr(llvm::Attribute::get(cx, llvm::Attribute::AllocKind,
                                    uint64_t(llvm::AllocFnKind::Alloc | llvm::AllocFnKind::Uninitialized)));
  m->addFnAttr(llvm::Attribute::getWithAllocSizeArgs(cx, 0, std::nullopt));
  r->addFnAttr(llvm::Attribute::get(cx, llvm::Attribute::AllocKind, uint64_t(llvm::AllocFnKind::Realloc)));
  r->addFnAttr(llvm::Attribute::getWithAllocSizeArgs(cx, 1, std::nullopt));
  r->addParamAttr(0, llvm::Attribute::AllocatedPointer);
  f->addFnAttr(llvm::Attribute::get(cx, llvm::Attribute::AllocKind, uint64_t(llvm::AllocFnKind::Free)));
  f->addParamAttr(0, llvm::Attribute::AllocatedPointer);
  for (llvm::Function *a : {m, r, f})
    a->addFnAttr("alloc-family", "milo");
  llvm::StringMap<llvm::Function *> to = {{"malloc", m}, {"realloc", r}, {"free", f}};
  for (llvm::Function &fn : ll) {
    llvm::StringRef n = fn.getName();
    if (fn.isDeclaration() || n.starts_with("replayHeap") || n.starts_with("replay$heap"))
      continue;
    for (llvm::Instruction &i : llvm::instructions(fn)) {
      auto *call = llvm::dyn_cast<llvm::CallBase>(&i);
      llvm::Function *callee = call ? call->getCalledFunction() : nullptr;
      if (!callee)
        continue;
      auto it = to.find(callee->getName());
      if (it != to.end())
        call->setCalledFunction(it->second);
    }
  }
  return true;
}

} // namespace

bool milo::finishModule(llvm::Module &ll, const ModuleConfig &c) {
  applyLinkNames(ll, c);
  if (!linkRuntime(ll, c.runtimeIR))
    return false;
  pruneOnDemand(ll, c);
  applySanitize(ll, c.sanitize);
  return !c.replayHeap || applyReplayHeap(ll);
}
