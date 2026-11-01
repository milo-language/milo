// Drop elaboration for owned slots (milo.var `owned`, Milo.td):
//   milo-scope-drops     structured IR: a drop of every slot a milo.scope owns wherever
//                        control leaves the scope, a drop of the old value before every
//                        store over a value with drop glue; then the scopes are inlined
//   milo-elaborate-drops after control flow is lowered: definitely-init / maybe-init of
//                        every owned slot by MLIR's dense dataflow framework; a drop of an
//                        empty slot goes, one of a full slot stays, and one that differs
//                        by path tests the slot's drop flag
// Together they decide what legacy codegen's alive flags decide (droppableLocals), but
// from the IR instead of from a side table the emitter keeps in sync.
#include "Milo.h"

#include "mlir/Analysis/DataFlow/ConstantPropagationAnalysis.h"
#include "mlir/Analysis/DataFlow/DeadCodeAnalysis.h"
#include "mlir/Analysis/DataFlow/DenseAnalysis.h"
#include "mlir/Analysis/DataFlowFramework.h"
#include "mlir/Conversion/LLVMCommon/Pattern.h"
#include "mlir/Dialect/LLVMIR/FunctionCallUtils.h"
#include "mlir/Dialect/LLVMIR/LLVMDialect.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/Interfaces/FunctionInterfaces.h"
#include "mlir/Pass/Pass.h"

using namespace mlir;
using namespace milo;

namespace {

bool isOwnedSlot(Value ref) {
  auto v = ref.getDefiningOp<VarOp>();
  return v && v.getOwned();
}

//===----------------------------------------------------------------------===//
// milo-scope-drops
//===----------------------------------------------------------------------===//

// Drops of `scope`'s slots before `at`, the last declared first.
void dropScope(OpBuilder &b, ScopeOp scope, Operation *at) {
  b.setInsertionPoint(at);
  for (Value s : llvm::reverse(scope.getSlots()))
    DropOp::create(b, at->getLoc(), s, Value());
}

// The op a jump leaves to: the loop of a break or continue, the function of a return.
Operation *jumpTarget(Operation *jump) {
  if (isa<ReturnOp>(jump))
    return jump->getParentOfType<FunctionOpInterface>();
  for (Operation *p = jump->getParentOp(); p; p = p->getParentOp())
    if (isa<LoopOp, ForOp, WhileOp>(p))
      return p;
  return nullptr;
}

// Splices the body of `scope` in its place. A body that ends in a jump makes everything
// after the scope in its block dead, so that goes.
void inlineScope(ScopeOp scope) {
  Block &body = scope.getBody().front();
  Operation *term = body.getTerminator();
  Block *parent = scope->getBlock();
  if (auto y = dyn_cast<YieldOp>(term)) {
    scope.replaceAllUsesWith(y.getValues());
    y.erase();
    parent->getOperations().splice(Block::iterator(scope), body.getOperations());
    scope.erase();
    return;
  }
  while (&parent->back() != scope.getOperation())
    parent->back().erase();
  parent->getOperations().splice(parent->end(), body.getOperations());
  scope.erase();
}

struct ScopeDropsPass : PassWrapper<ScopeDropsPass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(ScopeDropsPass)
  StringRef getArgument() const final { return "milo-scope-drops"; }
  StringRef getDescription() const final {
    return "Drop owned slots where control leaves their scope, and old values before stores";
  }
  void runOnOperation() override {
    OpBuilder b(&getContext());
    getOperation().walk([&](Operation *op) {
      if (auto st = dyn_cast<StoreOp>(op)) {
        // A slot that is not owned holds a borrowed or static copy (a spilled `&T`
        // argument) and is garbage before its first store: nothing in it to drop.
        auto var = st.getRef().getDefiningOp<VarOp>();
        if (needsDrop(st.getValue().getType()) && (!var || var.getOwned()) && !st.getInit()) {
          b.setInsertionPoint(st);
          DropOp::create(b, st.getLoc(), st.getRef(), Value());
        }
      } else if (isa<BreakOp, ContinueOp, ReturnOp>(op)) {
        Operation *target = jumpTarget(op);
        for (Operation *p = op->getParentOp(); p && p != target; p = p->getParentOp())
          if (auto s = dyn_cast<ScopeOp>(p))
            dropScope(b, s, op);
      } else if (auto s = dyn_cast<ScopeOp>(op)) {
        if (auto y = dyn_cast<YieldOp>(s.getBody().front().getTerminator()))
          dropScope(b, s, y);
      }
    });
    SmallVector<ScopeOp> scopes;
    getOperation().walk<WalkOrder::PostOrder>([&](ScopeOp s) { scopes.push_back(s); });
    for (ScopeOp s : scopes)
      inlineScope(s);
  }
};

//===----------------------------------------------------------------------===//
// milo-elaborate-drops
//===----------------------------------------------------------------------===//

//===----------------------------------------------------------------------===//
// milo-append-in-place
//===----------------------------------------------------------------------===//

// Two places that are the same memory by construction: one value, the same field of the
// same place, or the same global.
bool samePlace(Value a, Value b) {
  if (a == b)
    return true;
  auto fa = a.getDefiningOp<FieldRefOp>(), fb = b.getDefiningOp<FieldRefOp>();
  if (fa && fb)
    return fa.getIndex() == fb.getIndex() && samePlace(fa.getRef(), fb.getRef());
  auto ga = a.getDefiningOp<GlobalOp>(), gb = b.getDefiningOp<GlobalOp>();
  return ga && gb && ga.getName() == gb.getName();
}

// Does `v` read the string at `place` (a view of it, or something made from one)?
bool readsPlace(Value v, Value place) {
  auto ld = v.getDefiningOp<LoadOp>();
  return ld && samePlace(ld.getRef(), place);
}

// `s = s + x` is `%l = load %s; ...; %r = string.concat %l, %x; store %r, %s`: a new
// string with the old bytes copied, then the old one dropped (milo-scope-drops). When %r
// has no other use, nothing between the load and the store names %s, and %x is not a
// view of %s, appending %x to the string in %s gives the same value without the copy
// (legacy codegen did this by matching `place = place + rhs` in its Assign; this pass is
// the dialect's form). Runs before milo-scope-drops, so the removed store never gets a
// drop. Nothing else may run in between that names %s: an argument `&mut s` could change
// it while the old view is held.
struct AppendInPlacePass : PassWrapper<AppendInPlacePass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(AppendInPlacePass)
  StringRef getArgument() const final { return "milo-append-in-place"; }
  StringRef getDescription() const final {
    return "Rewrite `s = s + x` on strings to an in-place append";
  }
  void runOnOperation() override {
    SmallVector<StringConcatOp> concats;
    getOperation().walk([&](StringConcatOp c) { concats.push_back(c); });
    for (StringConcatOp c : concats) {
      auto load = c.getLhs().getDefiningOp<LoadOp>();
      if (!load || !c->hasOneUse())
        continue;
      auto store = dyn_cast<StoreOp>(*c->getUsers().begin());
      if (!store || store.getInit() || store->getBlock() != load->getBlock() ||
          !samePlace(store.getRef(), load.getRef()) || readsPlace(c.getRhs(), load.getRef()))
        continue;
      bool named = false;
      for (Operation *op = load->getNextNode(); op && op != store; op = op->getNextNode())
        if (op != c.getOperation())
          op->walk([&](Operation *in) {
            for (Value o : in->getOperands())
              if (samePlace(o, load.getRef()))
                named = true;
          });
      if (named)
        continue;
      OpBuilder b(store);
      StringAppendOp::create(b, store.getLoc(), store.getRef(), c.getRhs());
      store.erase();
      c.erase();
      if (load->use_empty())
        load.erase();
    }
  }
};

enum : uint8_t { kInit = 1, kUninit = 2 };

// For each owned slot, whether it may hold a value here and whether it may not.
class InitLattice : public dataflow::AbstractDenseLattice {
public:
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(InitLattice)
  using AbstractDenseLattice::AbstractDenseLattice;

  ChangeResult join(const AbstractDenseLattice &rhs) override {
    ChangeResult r = ChangeResult::NoChange;
    for (auto [slot, bits] : static_cast<const InitLattice &>(rhs).state) {
      uint8_t &mine = state[slot];
      if ((mine | bits) != mine) {
        mine |= bits;
        r = ChangeResult::Change;
      }
    }
    return r;
  }
  void print(raw_ostream &os) const override {
    for (auto [slot, bits] : state)
      os << slot << ": " << int(bits) << "\n";
  }
  uint8_t get(Value slot) const { return state.lookup(slot); }

  llvm::DenseMap<Value, uint8_t> state;
};

class InitAnalysis : public dataflow::DenseForwardDataFlowAnalysis<InitLattice> {
public:
  InitAnalysis(DataFlowSolver &solver, ArrayRef<Value> slots)
      : DenseForwardDataFlowAnalysis(solver), slots(slots) {}

  LogicalResult visitOperation(Operation *op, const InitLattice &before,
                               InitLattice *after) override {
    InitLattice next(after->getAnchor());
    next.state = before.state;
    transfer(op, next);
    propagateIfChanged(after, after->join(next));
    return success();
  }

  // A call cannot empty or fill this function's slots: by-ref arguments only borrow.
  void visitCallControlFlowTransfer(CallOpInterface, dataflow::CallControlFlowAction,
                                    const InitLattice &before, InitLattice *after) override {
    propagateIfChanged(after, after->join(before));
  }

  void setToEntryState(InitLattice *lattice) override {
    InitLattice entry(lattice->getAnchor());
    for (Value s : slots)
      entry.state[s] = kUninit;
    propagateIfChanged(lattice, lattice->join(entry));
  }

  static void transfer(Operation *op, InitLattice &l) {
    if (auto st = dyn_cast<StoreOp>(op)) {
      if (isOwnedSlot(st.getRef()))
        l.state[st.getRef()] = kInit;
    } else if (auto f = dyn_cast<FilledOp>(op)) {
      l.state[f.getRef()] = kInit;
    } else if (auto mv = dyn_cast<MoveOp>(op)) {
      if (isOwnedSlot(mv.getRef()))
        l.state[mv.getRef()] = kUninit;
    } else if (auto d = dyn_cast<DropOp>(op)) {
      if (isOwnedSlot(d.getRef()))
        l.state[d.getRef()] = kUninit;
    }
  }

private:
  ArrayRef<Value> slots;
};

struct ElaborateDropsPass
    : PassWrapper<ElaborateDropsPass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(ElaborateDropsPass)
  StringRef getArgument() const final { return "milo-elaborate-drops"; }
  StringRef getDescription() const final {
    return "Keep, erase or flag each drop of an owned slot by whether it is initialized";
  }

  void runOnOperation() override {
    func::FuncOp fn = getOperation();
    SmallVector<Value> slots;
    fn.walk([&](VarOp v) {
      if (v.getOwned())
        slots.push_back(v.getRef());
    });
    if (slots.empty())
      return;

    DataFlowSolver solver(DataFlowConfig().setInterprocedural(false));
    solver.load<dataflow::DeadCodeAnalysis>();
    solver.load<dataflow::SparseConstantPropagation>();
    solver.load<InitAnalysis>(slots);
    if (failed(solver.initializeAndRun(fn)))
      return signalPassFailure();
    // Null for an op no path reaches.
    auto before = [&](Operation *op) {
      return solver.lookupState<InitLattice>(solver.getProgramPointBefore(op));
    };

    // A read of an owned slot must find it full on every path: the checker's move rules
    // promise that, so a failure here is a compiler bug, not a user error.
    bool bad = false;
    fn.walk([&](Operation *op) {
      Value ref;
      if (auto l = dyn_cast<LoadOp>(op))
        ref = l.getRef();
      else if (auto m = dyn_cast<MoveOp>(op))
        ref = m.getRef();
      else if (auto s = dyn_cast<StringShareOp>(op))
        ref = s.getRef();
      if (!ref || !isOwnedSlot(ref))
        return;
      const InitLattice *l = before(op);
      if (l && l->get(ref) != kInit) {
        op->emitOpError("reads an owned slot that may be empty here");
        bad = true;
      }
    });
    if (bad)
      return signalPassFailure();

    SmallVector<DropOp> drops;
    fn.walk([&](DropOp d) {
      if (isOwnedSlot(d.getRef()) && !d.getFlag())
        drops.push_back(d);
    });
    llvm::SmallSetVector<Value, 4> flagged;
    SmallVector<DropOp> maybe;
    for (DropOp d : drops) {
      const InitLattice *l = before(d);
      uint8_t bits = l ? l->get(d.getRef()) : 0;
      if (bits == kInit)
        continue;
      if (bits == kInit + kUninit) {
        flagged.insert(d.getRef());
        maybe.push_back(d);
        continue;
      }
      d.erase();
    }
    if (!flagged.empty())
      addFlags(fn, flagged.getArrayRef(), maybe);
  }

  // A slot whose drop differs by path gets an i1 flag that follows it exactly: false at
  // entry, true after each store, false after each move and drop.
  void addFlags(func::FuncOp fn, ArrayRef<Value> slots, ArrayRef<DropOp> maybe) {
    OpBuilder b(&getContext());
    Block &entry = fn.getBody().front();
    Operation *afterVars = nullptr;
    for (Operation &op : entry)
      if (isa<VarOp>(op))
        afterVars = &op;
    llvm::DenseMap<Value, Value> flags;
    Location loc = fn.getLoc();
    for (Value s : slots) {
      if (afterVars)
        b.setInsertionPointAfter(afterVars);
      else
        b.setInsertionPointToStart(&entry);
      auto name = s.getDefiningOp<VarOp>().getName();
      Value flag = VarOp::create(b, loc, RefType::get(b.getContext(), b.getI1Type()),
                                 b.getStringAttr((name + ".alive").str()), UnitAttr());
      afterVars = flag.getDefiningOp();
      flags[s] = flag;
    }
    b.setInsertionPointAfter(afterVars);
    Value f = ConstOp::create(b, loc, b.getI1Type(), b.getBoolAttr(false));
    for (Value s : slots)
      StoreOp::create(b, loc, f, flags[s]);

    auto set = [&](Operation *after, Value slot, bool v) {
      b.setInsertionPointAfter(after);
      Value c = ConstOp::create(b, after->getLoc(), b.getI1Type(), b.getBoolAttr(v));
      StoreOp::create(b, after->getLoc(), c, flags[slot]);
    };
    SmallVector<std::tuple<Operation *, Value, bool>> sets;
    fn.walk([&](Operation *op) {
      if (auto st = dyn_cast<StoreOp>(op); st && flags.count(st.getRef()))
        sets.push_back({op, st.getRef(), true});
      else if (auto f = dyn_cast<FilledOp>(op); f && flags.count(f.getRef()))
        sets.push_back({op, f.getRef(), true});
      else if (auto mv = dyn_cast<MoveOp>(op); mv && flags.count(mv.getRef()))
        sets.push_back({op, mv.getRef(), false});
      else if (auto d = dyn_cast<DropOp>(op); d && flags.count(d.getRef()))
        sets.push_back({op, d.getRef(), false});
    });
    for (auto [op, slot, v] : sets)
      set(op, slot, v);
    for (DropOp d : maybe) {
      b.setInsertionPoint(d);
      Value alive = LoadOp::create(b, d.getLoc(), b.getI1Type(), flags[d.getRef()]);
      d.getFlagMutable().assign(alive);
    }
  }
};

//===----------------------------------------------------------------------===//
// Ownership ops -> LLVM
//===----------------------------------------------------------------------===//

LLVM::LLVMFuncOp legacyFn(ConversionPatternRewriter &rw, Operation *op, StringRef name,
                          ArrayRef<Type> args, Type ret) {
  auto module = op->getParentOfType<ModuleOp>();
  auto fn = LLVM::lookupOrCreateFn(rw, module, name, args, ret);
  return failed(fn) ? LLVM::LLVMFuncOp() : *fn;
}

// A drop is a call of the legacy module's drop glue for the type, `milo.drop.<key>(ptr)`
// (codegen mlirDropHelper); with a flag, only when the flag is set.
struct DropLowering : ConvertOpToLLVMPattern<DropOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(DropOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    auto fn = legacyFn(rw, op, "milo.drop." + typeKey(op.getRef().getType().getPointee()),
                       {ptrTy}, LLVM::LLVMVoidType::get(rw.getContext()));
    if (!fn)
      return failure();
    if (!a.getFlag()) {
      LLVM::CallOp::create(rw, loc, fn, ValueRange{a.getRef()});
      rw.eraseOp(op);
      return success();
    }
    Block *cur = rw.getInsertionBlock();
    Block *cont = rw.splitBlock(cur, rw.getInsertionPoint());
    Block *drop = rw.createBlock(cont);
    LLVM::CallOp::create(rw, loc, fn, ValueRange{a.getRef()});
    LLVM::BrOp::create(rw, loc, ValueRange{}, cont);
    rw.setInsertionPointToEnd(cur);
    LLVM::CondBrOp::create(rw, loc, a.getFlag(), drop, cont);
    rw.eraseOp(op);
    return success();
  }
};

struct MoveLowering : ConvertOpToLLVMPattern<MoveOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(MoveOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, getTypeConverter()->convertType(op.getType()),
                                        a.getRef());
    return success();
  }
};

// A fact for drop elaboration only: the bytes are already there.
struct FilledLowering : ConvertOpToLLVMPattern<FilledOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(FilledOp op, OpAdaptor, ConversionPatternRewriter &rw) const override {
    rw.eraseOp(op);
    return success();
  }
};

struct VecPlaceLowering : ConvertOpToLLVMPattern<VecPlaceOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecPlaceOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getRef());
    return success();
  }
};

struct VecNewLowering : ConvertOpToLLVMPattern<VecNewOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecNewOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Type t = getTypeConverter()->convertType(op.getType());
    Value zero = LLVM::ConstantOp::create(rw, loc, rw.getI64Type(), rw.getI64IntegerAttr(0));
    Value v = LLVM::UndefOp::create(rw, loc, t);
    v = LLVM::InsertValueOp::create(rw, loc, v, LLVM::ZeroOp::create(rw, loc, LLVM::LLVMPointerType::get(rw.getContext())), ArrayRef<int64_t>{0});
    v = LLVM::InsertValueOp::create(rw, loc, v, zero, ArrayRef<int64_t>{1});
    v = LLVM::InsertValueOp::create(rw, loc, v, zero, ArrayRef<int64_t>{2});
    rw.replaceOp(op, v);
    return success();
  }
};

struct StringLenLowering : ConvertOpToLLVMPattern<StringLenOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringLenOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::ExtractValueOp>(op, a.getValue(), ArrayRef<int64_t>{1});
    return success();
  }
};

// legacy's string share, a function of the legacy module (codegen mlirHelper).
struct StringShareLowering : ConvertOpToLLVMPattern<StringShareOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringShareOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Type st = getTypeConverter()->convertType(op.getType());
    auto fn = legacyFn(rw, op, "milo.share.string", {ptrTy}, st);
    if (!fn)
      return failure();
    rw.replaceOpWithNewOp<LLVM::CallOp>(op, fn, ValueRange{a.getRef()});
    return success();
  }
};

// Legacy's helpers take strings by reference: each operand goes through an entry slot.
struct StringConcatLowering : ConvertOpToLLVMPattern<StringConcatOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringConcatOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Type st = getTypeConverter()->convertType(op.getType());
    Value l = entrySlot(rw, op, st), r = entrySlot(rw, op, st);
    LLVM::StoreOp::create(rw, op.getLoc(), a.getLhs(), l);
    LLVM::StoreOp::create(rw, op.getLoc(), a.getRhs(), r);
    auto fn = legacyFn(rw, op, "milo.string.concat", {ptrTy, ptrTy}, st);
    if (!fn)
      return failure();
    rw.replaceOpWithNewOp<LLVM::CallOp>(op, fn, ValueRange{l, r});
    return success();
  }
};

struct StringAppendLowering : ConvertOpToLLVMPattern<StringAppendOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringAppendOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Value v = entrySlot(rw, op, a.getValue().getType());
    LLVM::StoreOp::create(rw, op.getLoc(), a.getValue(), v);
    auto fn = legacyFn(rw, op, "milo.string.append", {ptrTy, ptrTy},
                       LLVM::LLVMVoidType::get(rw.getContext()));
    if (!fn)
      return failure();
    rw.replaceOpWithNewOp<LLVM::CallOp>(op, fn, ValueRange{a.getDst(), v});
    return success();
  }
};

} // namespace

void milo::populateOwnedToLLVMPatterns(LLVMTypeConverter &tc, RewritePatternSet &patterns) {
  tc.addConversion([ctx = &tc.getContext()](VecValType) -> Type {
    auto s = LLVM::LLVMStructType::getIdentified(ctx, "Vec");
    if (!s.isInitialized()) {
      Type i64 = IntegerType::get(ctx, 64);
      (void)s.setBody({LLVM::LLVMPointerType::get(ctx), i64, i64}, /*isPacked=*/false);
    }
    return s;
  });
  patterns.add<DropLowering, MoveLowering, VecPlaceLowering, VecNewLowering, StringLenLowering,
               StringShareLowering, StringConcatLowering, StringAppendLowering, FilledLowering>(tc);
}

void milo::registerDropPasses() {
  PassRegistration<ScopeDropsPass>();
  PassRegistration<ElaborateDropsPass>();
  PassRegistration<AppendInPlacePass>();
}
