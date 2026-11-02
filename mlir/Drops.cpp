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

// What drop elaboration tracks: each owned slot, and each field path of one that some
// milo.move takes a value out of (a partial move, emit-mlir moveField: only fields that
// run a user Drop, whose zeroed leftover would not read as empty). A key is the slot, or
// for a path the field_ref of the first move out of it.
struct Tracked {
  Value slot;
  SmallVector<int64_t, 4> path;
  Value key;
};

// `ref` as a place of an owned slot: the slot and the field indices down to it.
bool ownedPlace(Value ref, Value &slot, SmallVector<int64_t, 4> &path) {
  path.clear();
  while (auto f = ref.getDefiningOp<FieldRefOp>()) {
    path.push_back(f.getIndex());
    ref = f.getRef();
  }
  std::reverse(path.begin(), path.end());
  slot = ref;
  return isOwnedSlot(ref);
}

bool isPrefix(ArrayRef<int64_t> p, ArrayRef<int64_t> q) {
  return p.size() <= q.size() && p == q.take_front(p.size());
}

struct Places {
  ArrayRef<Value> slots;
  SmallVector<Tracked> paths;

  // The path tracked at exactly `path` of `slot`, or null.
  const Tracked *at(Value slot, ArrayRef<int64_t> path) const {
    for (const Tracked &t : paths)
      if (t.slot == slot && ArrayRef<int64_t>(t.path) == path)
        return &t;
    return nullptr;
  }
  bool under(Value slot, ArrayRef<int64_t> path) const {
    return llvm::any_of(paths, [&](const Tracked &t) {
      return t.slot == slot && t.path.size() > path.size() && isPrefix(path, t.path);
    });
  }

  // The keys `op` fills (true) or empties (false). A write to a place covers every path
  // under it: a store over `o.inner` puts back `o.inner.value` too.
  void effects(Operation *op, function_ref<void(Value, bool)> fn) const {
    Value ref;
    bool full;
    if (auto st = dyn_cast<StoreOp>(op))
      ref = st.getRef(), full = true;
    else if (auto f = dyn_cast<FilledOp>(op))
      ref = f.getRef(), full = true;
    else if (auto c = dyn_cast<CopyOp>(op))
      ref = c.getDst(), full = true;
    else if (auto mv = dyn_cast<MoveOp>(op))
      ref = mv.getRef(), full = false;
    else if (auto d = dyn_cast<DropOp>(op))
      ref = d.getRef(), full = false;
    else
      return;
    Value slot;
    SmallVector<int64_t, 4> path;
    if (!ownedPlace(ref, slot, path))
      return;
    // A milo.copy into the slot itself is followed by milo.filled, the fact that counts.
    if (path.empty() && !isa<CopyOp>(op))
      fn(slot, full);
    for (const Tracked &t : paths)
      if (t.slot == slot && isPrefix(path, t.path))
        fn(t.key, full);
  }
};

// For each owned slot and tracked path, whether it may hold a value here and whether it may not.
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
  InitAnalysis(DataFlowSolver &solver, const Places &places)
      : DenseForwardDataFlowAnalysis(solver), places(places) {}

  LogicalResult visitOperation(Operation *op, const InitLattice &before,
                               InitLattice *after) override {
    InitLattice next(after->getAnchor());
    next.state = before.state;
    places.effects(op, [&](Value key, bool full) { next.state[key] = full ? kInit : kUninit; });
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
    for (Value s : places.slots)
      entry.state[s] = kUninit;
    for (const Tracked &t : places.paths)
      entry.state[t.key] = kUninit;
    propagateIfChanged(lattice, lattice->join(entry));
  }

private:
  const Places &places;
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
    Places places{slots, {}};
    fn.walk([&](MoveOp mv) {
      Value slot;
      SmallVector<int64_t, 4> path;
      if (ownedPlace(mv.getRef(), slot, path) && !path.empty() && !places.at(slot, path))
        places.paths.push_back({slot, path, mv.getRef()});
    });

    DataFlowSolver solver(DataFlowConfig().setInterprocedural(false));
    solver.load<dataflow::DeadCodeAnalysis>();
    solver.load<dataflow::SparseConstantPropagation>();
    solver.load<InitAnalysis>(places);
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
      else if (auto t = dyn_cast<VecTailTakeOp>(op))
        ref = t.getRef();
      else if (auto t = dyn_cast<VecTailTakePlaceOp>(op))
        ref = t.getRef();
      else if (auto t = dyn_cast<ArrayTailTakeOp>(op))
        ref = t.getRef();
      else if (auto t = dyn_cast<ArrayTailTakePlaceOp>(op))
        ref = t.getRef();
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

    // Each drop of an owned place is kept, erased, flagged, or (a place with a moved path
    // under it) split into drops of its fields, the last field first as the glue does.
    struct Plan {
      DropOp drop;
      const InitLattice *l;
    };
    SmallVector<Plan> plans;
    fn.walk([&](DropOp d) {
      Value slot;
      SmallVector<int64_t, 4> path;
      if (!d.getFlag() && ownedPlace(d.getRef(), slot, path))
        plans.push_back({d, before(d)});
    });
    llvm::SmallSetVector<Value, 4> flagged;
    for (const Plan &p : plans)
      if (failed(lower(p.drop, p.l, places, nullptr, flagged)))
        return signalPassFailure();
    llvm::DenseMap<Value, Value> flags;
    if (!flagged.empty())
      flags = addFlags(fn, places, flagged.getArrayRef());
    for (const Plan &p : plans)
      (void)lower(p.drop, p.l, places, &flags, flagged);
  }

  static uint8_t bitsOf(const InitLattice *l, Value key) { return l ? l->get(key) : 0; }

  // The drop `d`, by what the lattice `l` before it says. With `flags` null only the
  // keys that need a drop flag are gathered; with them the IR is rewritten.
  LogicalResult lower(DropOp d, const InitLattice *l, const Places &places,
                      llvm::DenseMap<Value, Value> *flags,
                      llvm::SmallSetVector<Value, 4> &flagged) {
    Value slot;
    SmallVector<int64_t, 4> path;
    ownedPlace(d.getRef(), slot, path);
    // An untracked field (a store over it) always holds one.
    Value guard;
    if (path.empty())
      guard = slot;
    else if (const Tracked *t = places.at(slot, path))
      guard = t->key;
    bool split = places.under(slot, path) && llvm::any_of(places.paths, [&](const Tracked &t) {
      return t.slot == slot && isPrefix(path, t.path) && bitsOf(l, t.key) != kInit;
    });
    if (!split) {
      uint8_t bits = guard ? bitsOf(l, guard) : kInit;
      if (bits == kInit + kUninit) {
        if (!flags)
          flagged.insert(guard);
        else {
          OpBuilder b(d);
          d.getFlagMutable().assign(LoadOp::create(b, d.getLoc(), b.getI1Type(), (*flags)[guard]));
        }
      } else if (bits != kInit && flags) {
        d.erase();
      }
      return success();
    }
    OpBuilder b(d);
    if (failed(split1(b, d, flags ? d.getRef() : Value(), d.getRef().getType().getPointee(), slot, path,
                      guard, l, places, flags, flagged)))
      return failure();
    if (flags)
      d.erase();
    return success();
  }

  // The drops of the place `ref` (a `ty`, at `path` of `slot`; null when only gathering).
  LogicalResult split1(OpBuilder &b, DropOp d, Value ref, Type ty, Value slot, SmallVector<int64_t, 4> path,
                       Value guard, const InitLattice *l, const Places &places,
                       llvm::DenseMap<Value, Value> *flags, llvm::SmallSetVector<Value, 4> &flagged) {
    if (const Tracked *t = places.at(slot, path))
      guard = t->key;
    uint8_t bits = guard ? bitsOf(l, guard) : kInit;
    if (!(bits & kInit))
      return success();
    if (!places.under(slot, path)) {
      if (bits != kInit && !flags)
        flagged.insert(guard);
      if (!flags)
        return success();
      Value flag;
      if (bits != kInit)
        flag = LoadOp::create(b, d.getLoc(), b.getI1Type(), (*flags)[guard]);
      DropOp::create(b, d.getLoc(), ref, flag);
      return success();
    }
    auto st = dyn_cast<StructType>(ty);
    if (!st)
      return d.emitOpError("splits a place that is not a struct");
    ArrayRef<Type> fields = st.getFields();
    for (int64_t i = fields.size() - 1; i >= 0; i--) {
      if (!needsDrop(fields[i]))
        continue;
      SmallVector<int64_t, 4> sub(path);
      sub.push_back(i);
      Value fr;
      if (flags)
        fr = FieldRefOp::create(b, d.getLoc(), RefType::get(b.getContext(), fields[i]), ref, b.getI64IntegerAttr(i));
      if (failed(split1(b, d, fr, fields[i], slot, sub, guard, l, places, flags, flagged)))
        return failure();
    }
    return success();
  }

  // A key whose drop differs by path gets an i1 flag that follows it exactly: false at
  // entry, true after each op that fills it, false after each that empties it.
  llvm::DenseMap<Value, Value> addFlags(func::FuncOp fn, const Places &places, ArrayRef<Value> keys) {
    OpBuilder b(&getContext());
    Block &entry = fn.getBody().front();
    Operation *afterVars = nullptr;
    for (Operation &op : entry)
      if (isa<VarOp>(op))
        afterVars = &op;
    llvm::DenseMap<Value, Value> flags;
    Location loc = fn.getLoc();
    for (Value k : keys) {
      if (afterVars)
        b.setInsertionPointAfter(afterVars);
      else
        b.setInsertionPointToStart(&entry);
      Value slot;
      SmallVector<int64_t, 4> path;
      ownedPlace(k, slot, path);
      std::string name = slot.getDefiningOp<VarOp>().getName().str();
      for (int64_t i : path)
        name += "." + std::to_string(i);
      Value flag = VarOp::create(b, loc, RefType::get(b.getContext(), b.getI1Type()),
                                 b.getStringAttr(name + ".alive"), UnitAttr());
      afterVars = flag.getDefiningOp();
      flags[k] = flag;
    }
    b.setInsertionPointAfter(afterVars);
    Value f = ConstOp::create(b, loc, b.getI1Type(), b.getBoolAttr(false));
    for (Value k : keys)
      StoreOp::create(b, loc, f, flags[k]);

    SmallVector<std::tuple<Operation *, Value, bool>> sets;
    fn.walk([&](Operation *op) {
      places.effects(op, [&](Value key, bool full) {
        if (flags.count(key))
          sets.push_back({op, key, full});
      });
    });
    for (auto [op, key, v] : sets) {
      b.setInsertionPointAfter(op);
      Value c = ConstOp::create(b, op->getLoc(), b.getI1Type(), b.getBoolAttr(v));
      StoreOp::create(b, op->getLoc(), c, flags[key]);
    }
    return flags;
  }
};

//===----------------------------------------------------------------------===//
// Ownership ops -> LLVM
//===----------------------------------------------------------------------===//

LLVM::LLVMFuncOp runtimeFn(ConversionPatternRewriter &rw, Operation *op, StringRef name,
                          ArrayRef<Type> args, Type ret) {
  auto module = op->getParentOfType<ModuleOp>();
  auto fn = LLVM::lookupOrCreateFn(rw, module, name, args, ret);
  return failed(fn) ? LLVM::LLVMFuncOp() : *fn;
}

// A drop is a call of the legacy module's drop glue for the type, `milo.drop.<key>(ptr)`
// (codegen mlirDropHelper), or `milo.sdrop.<key>` for a structural slot; with a flag, only
// when the flag is set.
struct DropLowering : ConvertOpToLLVMPattern<DropOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(DropOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    auto var = op.getRef().getDefiningOp<VarOp>();
    auto fn = runtimeFn(rw, op, (var && var.getStructural() ? "milo.sdrop." : "milo.drop.") + typeKey(op.getRef().getType().getPointee()),
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
    // One that only empties its slot (after a milo.copy out of it) loads nothing: even a
    // dead whole load of a 128+ byte aggregate is split per element by SROA.
    if (op->use_empty()) {
      rw.eraseOp(op);
      return success();
    }
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

// A vectail slot is `{ %Vec, i64 cursor }`: the header at offset 0, the cursor after it.
Value vecTailCursor(ConversionPatternRewriter &rw, Location loc, const TypeConverter *tc,
                    VecTailType t, Value slot) {
  return LLVM::GEPOp::create(rw, loc, LLVM::LLVMPointerType::get(rw.getContext()),
                             tc->convertType(t), slot, ArrayRef<LLVM::GEPArg>{0, 1});
}

struct VecTailInitLowering : ConvertOpToLLVMPattern<VecTailInitOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecTailInitOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto t = cast<VecTailType>(op.getRef().getType().getPointee());
    LLVM::StoreOp::create(rw, loc, a.getVec(), a.getRef());
    Value zero = LLVM::ConstantOp::create(rw, loc, rw.getI64Type(), rw.getI64IntegerAttr(0));
    LLVM::StoreOp::create(rw, loc, zero, vecTailCursor(rw, loc, getTypeConverter(), t, a.getRef()));
    rw.eraseOp(op);
    return success();
  }
};

struct VecTailVecLowering : ConvertOpToLLVMPattern<VecTailVecOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecTailVecOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getRef());
    return success();
  }
};

// The address of element `index` of the vectail at `slot`, and the cursor set past it.
Value vecTailTake(ConversionPatternRewriter &rw, Location loc, const TypeConverter *tc,
                  Value ref, Value slot, Value index) {
  auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
  auto t = cast<VecTailType>(cast<RefType>(ref.getType()).getPointee());
  Type elem = tc->convertType(t.getElementType());
  Value data = LLVM::LoadOp::create(rw, loc, ptrTy, slot);
  Value ep = LLVM::GEPOp::create(rw, loc, ptrTy, elem, data, ValueRange{index});
  Value one = LLVM::ConstantOp::create(rw, loc, rw.getI64Type(), rw.getI64IntegerAttr(1));
  Value next = LLVM::AddOp::create(rw, loc, index, one);
  LLVM::StoreOp::create(rw, loc, next, vecTailCursor(rw, loc, tc, t, slot));
  return ep;
}

struct VecTailTakeLowering : ConvertOpToLLVMPattern<VecTailTakeOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecTailTakeOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Value ep = vecTailTake(rw, op.getLoc(), getTypeConverter(), op.getRef(), a.getRef(), a.getIndex());
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, getTypeConverter()->convertType(op.getType()), ep);
    return success();
  }
};

struct VecTailTakePlaceLowering : ConvertOpToLLVMPattern<VecTailTakePlaceOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecTailTakePlaceOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, vecTailTake(rw, op.getLoc(), getTypeConverter(), op.getRef(), a.getRef(), a.getIndex()));
    return success();
  }
};

// An arraytail slot is `{ [N x T], i64 cursor }`: the array at offset 0, the cursor after it.
Value arrayTailCursor(ConversionPatternRewriter &rw, Location loc, const TypeConverter *tc, Value ref, Value slot) {
  auto t = cast<ArrayTailType>(cast<RefType>(ref.getType()).getPointee());
  return LLVM::GEPOp::create(rw, loc, LLVM::LLVMPointerType::get(rw.getContext()),
                             tc->convertType(t), slot, ArrayRef<LLVM::GEPArg>{0, 1});
}

struct ArrayTailArrayLowering : ConvertOpToLLVMPattern<ArrayTailArrayOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ArrayTailArrayOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getRef());
    return success();
  }
};

struct ArrayTailStartLowering : ConvertOpToLLVMPattern<ArrayTailStartOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ArrayTailStartOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value zero = LLVM::ConstantOp::create(rw, loc, rw.getI64Type(), rw.getI64IntegerAttr(0));
    LLVM::StoreOp::create(rw, loc, zero, arrayTailCursor(rw, loc, getTypeConverter(), op.getRef(), a.getRef()));
    rw.eraseOp(op);
    return success();
  }
};

// The address of element `index` of the arraytail at `slot`, and the cursor set past it.
Value arrayTailTake(ConversionPatternRewriter &rw, Location loc, const TypeConverter *tc, Value ref, Value slot, Value index) {
  auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
  auto t = cast<ArrayTailType>(cast<RefType>(ref.getType()).getPointee());
  Type arr = tc->convertType(t.getArrayType());
  Value ep = LLVM::GEPOp::create(rw, loc, ptrTy, arr, slot, ArrayRef<LLVM::GEPArg>{0, index});
  Value one = LLVM::ConstantOp::create(rw, loc, rw.getI64Type(), rw.getI64IntegerAttr(1));
  Value next = LLVM::AddOp::create(rw, loc, index, one);
  LLVM::StoreOp::create(rw, loc, next, arrayTailCursor(rw, loc, tc, ref, slot));
  return ep;
}

struct ArrayTailTakeLowering : ConvertOpToLLVMPattern<ArrayTailTakeOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ArrayTailTakeOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    Value ep = arrayTailTake(rw, op.getLoc(), getTypeConverter(), op.getRef(), a.getRef(), a.getIndex());
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, getTypeConverter()->convertType(op.getType()), ep);
    return success();
  }
};

struct ArrayTailTakePlaceLowering : ConvertOpToLLVMPattern<ArrayTailTakePlaceOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ArrayTailTakePlaceOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, arrayTailTake(rw, op.getLoc(), getTypeConverter(), op.getRef(), a.getRef(), a.getIndex()));
    return success();
  }
};

struct MapLenLowering : ConvertOpToLLVMPattern<MapLenOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(MapLenOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::ExtractValueOp>(op, a.getValue(), ArrayRef<int64_t>{1});
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

// The runtime's `@milo.str.share` (src/runtime/str.ll): a new handle to the same buffer.
struct StringShareLowering : ConvertOpToLLVMPattern<StringShareOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringShareOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type st = getTypeConverter()->convertType(op.getType());
    Value s = LLVM::LoadOp::create(rw, op.getLoc(), st, a.getRef());
    auto fn = runtimeFn(rw, op, "milo.str.share", {st}, st);
    if (!fn)
      return failure();
    rw.replaceOpWithNewOp<LLVM::CallOp>(op, fn, ValueRange{s});
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
    auto fn = runtimeFn(rw, op, "milo.string.concat", {ptrTy, ptrTy}, st);
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
    auto fn = runtimeFn(rw, op, "milo.string.append", {ptrTy, ptrTy},
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
  tc.addConversion([ctx = &tc.getContext()](MapType) -> Type {
    auto s = LLVM::LLVMStructType::getIdentified(ctx, "HashMap");
    if (!s.isInitialized()) {
      Type i64 = IntegerType::get(ctx, 64);
      (void)s.setBody({LLVM::LLVMPointerType::get(ctx), i64, i64, i64, i64}, /*isPacked=*/false);
    }
    return s;
  });
  tc.addConversion([&tc](VecTailType t) -> Type {
    MLIRContext *ctx = &tc.getContext();
    return LLVM::LLVMStructType::getLiteral(
        ctx, {tc.convertType(VecValType::get(ctx, t.getElementType())), IntegerType::get(ctx, 64)});
  });
  tc.addConversion([&tc](ArrayTailType t) -> Type {
    return LLVM::LLVMStructType::getLiteral(&tc.getContext(), {tc.convertType(t.getArrayType()), IntegerType::get(&tc.getContext(), 64)});
  });
  patterns.add<VecTailInitLowering, VecTailVecLowering, VecTailTakeLowering, VecTailTakePlaceLowering, MapLenLowering>(tc);
  patterns.add<ArrayTailArrayLowering, ArrayTailStartLowering, ArrayTailTakeLowering, ArrayTailTakePlaceLowering>(tc);
  patterns.add<DropLowering, MoveLowering, VecPlaceLowering, VecNewLowering, StringLenLowering,
               StringShareLowering, StringConcatLowering, StringAppendLowering, FilledLowering>(tc);
}

void milo::registerDropPasses() {
  PassRegistration<ScopeDropsPass>();
  PassRegistration<ElaborateDropsPass>();
  PassRegistration<AppendInPlacePass>();
}
