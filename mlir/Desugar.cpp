// milo-desugar: lowers the top layer of the milo dialect (milo.for_in, milo.try,
// milo.interp: one op per source construct) to the core ops, into exactly the sequences
// src/emit-mlir.ts printed for those constructs before the top layer existed. It runs
// first, so every other pass sees core ops only. Each lowering decision cites the rule of
// docs/semantics/milo.md it implements, as the reference interpreter (src/interp.ts) does.
#include "Milo.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/IR/PatternMatch.h"
#include "mlir/Pass/Pass.h"

using namespace mlir;
using namespace milo;

namespace {

Type si64Type(MLIRContext *ctx) { return IntegerType::get(ctx, 64, IntegerType::Signed); }

// A slot at the top of the function's entry block, after the slots already there: a
// milo.var must sit in the entry block (milo.var's verifier), where the emitter puts them.
Value entrySlot(OpBuilder &b, Operation *at, StringRef name, Type pointee) {
  OpBuilder::InsertionGuard g(b);
  Block &entry = at->getParentOfType<func::FuncOp>().getBody().front();
  auto it = entry.begin();
  while (it != entry.end() && isa<VarOp>(*it))
    ++it;
  b.setInsertionPoint(&entry, it);
  return VarOp::create(b, at->getLoc(), RefType::get(b.getContext(), pointee),
                       b.getStringAttr(name), UnitAttr(), UnitAttr());
}

Value constI64(OpBuilder &b, Location loc, int64_t v) {
  Type t = si64Type(b.getContext());
  return ConstOp::create(b, loc, t, b.getIntegerAttr(t, v));
}

// The body of `op` moved into `dst`, whose entry block (already holding the binding's
// ops) takes the place of the body's entry block: its arguments become `args`.
void moveBody(RewriterBase &rw, Region &body, Block *dst, ValueRange args) {
  Block *entry = &body.front();
  Region *into = dst->getParent();
  rw.inlineRegionBefore(body, *into, into->end());
  rw.mergeBlocks(entry, dst, args);
}

void lowerForIn(IRRewriter &rw, ForInOp op) {
  MLIRContext *ctx = rw.getContext();
  Location loc = op.getLoc();
  Type si64 = si64Type(ctx);
  Type ptr = PtrType::get(ctx);
  Value it = op.getIterable();
  Type elemArg = op.getBodyRegion().front().getArgument(1).getType();
  rw.setInsertionPoint(op);

  // E-FOR-IN: over an array, a counted milo.for from 0 to N, binding each element's place
  // (E-INDEX-COPY: the binding is a view of the element, never a move out of the array).
  if (auto r = dyn_cast<RefType>(it.getType())) {
    auto a = cast<ArrayType>(r.getPointee());
    Value zero = constI64(rw, loc, 0);
    Value n = constI64(rw, loc, a.getSize());
    auto f = ForOp::create(rw, loc, zero, n);
    Block *b = rw.createBlock(&f.getBodyRegion(), {}, TypeRange{si64}, {loc});
    Value i = b->getArgument(0);
    Value x = ArrayIndexOp::create(rw, loc, elemArg, it, i);
    moveBody(rw, op.getBodyRegion(), b, {i, x});
    rw.eraseOp(op);
    return;
  }

  // E-FOR-IN: data and length read once, before the loop (E-VEC: a Vec or slice is a
  // header over its buffer, which nothing grows while the loop borrows it). A string's
  // bytes the same way, one ui8 each.
  Value data, len;
  bool byPlace = false;
  Type elem;
  if (isa<StringType>(it.getType())) {
    elem = elemArg;
    data = StringDataOp::create(rw, loc, ptr, it);
    len = StringLenOp::create(rw, loc, si64, it);
  } else {
    elem = cast<VecType>(it.getType()).getElementType();
    byPlace = isa<RefType>(elemArg);
    if (!byPlace)
      data = VecDataOp::create(rw, loc, ptr, it);
    len = LenOp::create(rw, loc, si64, it);
  }
  Value idx = entrySlot(rw, op, "for.idx", si64);
  StoreOp::create(rw, loc, constI64(rw, loc, 0), idx, UnitAttr());

  auto w = WhileOp::create(rw, loc);
  rw.createBlock(&w.getCondRegion());
  Value ci = LoadOp::create(rw, loc, si64, idx);
  ConditionOp::create(rw, loc, CmpOp::create(rw, loc, rw.getI1Type(), CmpPredicate::lt, ci, len));

  // E-FOR-IN: the index moves on at the top of the body, so a `continue` (back to the
  // condition) cannot skip it.
  Block *body = rw.createBlock(&w.getBodyRegion());
  Value i = LoadOp::create(rw, loc, si64, idx);
  Value next = AddOp::create(rw, loc, si64, i, constI64(rw, loc, 1), rw.getUnitAttr());
  StoreOp::create(rw, loc, next, idx, UnitAttr());
  Value x;
  if (byPlace) {
    // E-INDEX-COPY: by place, the binding is the element's place (in bounds by the
    // condition), carrying the loop's location for the bounds check it lowers to.
    x = IndexRefOp::create(rw, loc, elemArg, it, i);
  } else {
    // E-INDEX-COPY: by value, the element is read at the top of each iteration, a view
    // that never owns: nothing writes the container while the loop borrows it.
    Value ep = PtrElemOp::create(rw, loc, ptr, data, i, TypeAttr::get(elem));
    x = PtrLoadOp::create(rw, loc, elem, ep);
  }
  moveBody(rw, op.getBodyRegion(), body, {i, x});
  rw.eraseOp(op);
}

void lowerTry(IRRewriter &rw, TryOp op) {
  Location loc = op.getLoc();
  EnumType e = op.getSubject().getType();
  TupleType okFields = e.getVariants()[e.variantOf(op.getOk())];
  rw.setInsertionPoint(op);
  // E-PROPAGATE: `e?` is a match on the subject's two variants. E-MATCH: the subject is
  // owned and consumed whole, so each arm takes its variant's payload (at most one field)
  // as its block argument, with no holder slot in between.
  auto m = MatchOp::create(rw, loc, op->getResultTypes(), op.getSubject(),
                           rw.getDenseI64ArrayAttr({int64_t(op.getOk()), int64_t(op.getErr())}), UnitAttr(),
                           /*armsCount=*/2);
  // E-PROPAGATE: on ok, the match's value is the payload.
  SmallVector<Location> locs(okFields.size(), loc);
  Block *ok = rw.createBlock(&m.getArms()[0], {}, okFields.getTypes(), locs);
  YieldOp::create(rw, loc, ValueRange(ok->getArguments()));
  // E-PROPAGATE: on err, the try's region, which returns from the function (the emitter
  // has put the conversion and the scope drops in it).
  rw.inlineRegionBefore(op.getErrRegion(), m.getArms()[1], m.getArms()[1].end());
  rw.replaceOp(op, m->getResults());
}

// The runtime's push of a scalar's text: src/runtime-ir.ts PUSH_SCALAR_FN.
StringRef pushScalarFn(Type t) {
  if (auto i = dyn_cast<IntegerType>(t)) {
    if (i.getWidth() == 1)
      return "rtStringPushBool";
    return i.isUnsigned() ? "rtStringPushU64" : "rtStringPushI64";
  }
  if (t.isF64())
    return "rtStringPushF64";
  if (t.isF32())
    return "rtStringPushF32";
  return "rtStringPushPtr";
}

// A call of `name`, declared `func.func private` at the top of the module when nothing
// there names it yet (the emitter declares every callee it calls).
func::CallOp call(OpBuilder &b, Location loc, ModuleOp module, StringRef name,
                  TypeRange results, ValueRange args) {
  auto fnTy = b.getFunctionType(args.getTypes(), results);
  if (!module.lookupSymbol(name)) {
    OpBuilder::InsertionGuard g(b);
    b.setInsertionPointToStart(module.getBody());
    auto f = func::FuncOp::create(b, loc, name, fnTy);
    f.setPrivate();
  }
  return func::CallOp::create(b, loc, name, results, args);
}

void lowerInterp(IRRewriter &rw, InterpOp op, ModuleOp module) {
  MLIRContext *ctx = rw.getContext();
  Location loc = op.getLoc();
  Type str = StringType::get(ctx);
  Type ptr = PtrType::get(ctx);
  rw.setInsertionPoint(op);
  // E-INTERP: a fresh string, empty to start with. Every part is an operand, evaluated
  // (left to right) before the op, so nothing can leave between here and the result: the
  // slot need not be an owned one.
  Value slot = entrySlot(rw, op, "format", str);
  StoreOp::create(rw, loc, ZeroOp::create(rw, loc, str), slot, rw.getUnitAttr());
  std::string overflow = ("runtime error: integer overflow at " + op.getSite() + "\n").str();
  for (auto [v, glue] : llvm::zip(op.getParts(), op.getGlue())) {
    Type t = v.getType();
    if (auto g = dyn_cast<FlatSymbolRefAttr>(glue)) {
      // E-INTERP: a struct, enum or Vec part appends its text through its display glue.
      call(rw, loc, module, g.getValue(), {}, {v, slot});
    } else if (isa<StringType>(t)) {
      // E-INTERP: a string part appends its bytes.
      StringAppendOp::create(rw, loc, slot, v);
    } else {
      // E-INTERP: an int in decimal (a narrow one widened by its signedness first), a float
      // as its shortest round-trip digits, a bool as true/false. A null buffer back from
      // the runtime is a failed allocation, which panics as the emitter's allocCheck does.
      Value arg = v;
      auto i = dyn_cast<IntegerType>(t);
      if (i && i.getWidth() != 1 && i.getWidth() != 64) {
        Type w = IntegerType::get(ctx, 64, i.isUnsigned() ? IntegerType::Unsigned : IntegerType::Signed);
        arg = CastOp::create(rw, loc, w, v);
      }
      Value p = call(rw, loc, module, pushScalarFn(t), {ptr}, {slot, arg}).getResult(0);
      Value bad = CmpOp::create(rw, loc, rw.getI1Type(), CmpPredicate::eq, p, ZeroOp::create(rw, loc, ptr));
      PanicIfOp::create(rw, loc, bad, rw.getStringAttr(overflow), ValueRange{});
    }
  }
  // E-INTERP: the result is owned by whoever takes it; the slot is left behind unread.
  rw.replaceOp(op, LoadOp::create(rw, loc, str, slot)->getResults());
}

struct DesugarPass : PassWrapper<DesugarPass, OperationPass<ModuleOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(DesugarPass)
  StringRef getArgument() const final { return "milo-desugar"; }
  StringRef getDescription() const final {
    return "Lower the top layer (milo.for_in, milo.try, milo.interp) to core milo ops";
  }
  void runOnOperation() override {
    ModuleOp module = getOperation();
    SmallVector<Operation *> ops;
    module.walk([&](Operation *op) {
      if (isa<ForInOp, TryOp, InterpOp>(op))
        ops.push_back(op);
    });
    IRRewriter rw(&getContext());
    // Moving a region keeps the ops inside it, so the order does not matter.
    for (Operation *op : ops) {
      if (auto f = dyn_cast<ForInOp>(op))
        lowerForIn(rw, f);
      else if (auto t = dyn_cast<TryOp>(op))
        lowerTry(rw, t);
      else
        lowerInterp(rw, cast<InterpOp>(op), module);
    }
  }
};

} // namespace

void milo::registerDesugarPasses() { PassRegistration<DesugarPass>(); }
