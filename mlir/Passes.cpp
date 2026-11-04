// milo passes:
//   milo-hoist-vec-reads      move vec.len out of loops that never write a Vec header
//   milo-version-bounds-checks  run a check-free copy of a loop when one up-front test
//                             proves every check in it passes, the original otherwise
//   milo-expand-checks        bounds_check -> compare + call to the panic routine
//   convert-milo-to-llvm      everything (milo, func, arith, cf) to the LLVM dialect
//   milo-lower-debug-vars     -g: milo.dbg.var to llvm.intr.dbg.declare
#include "Milo.h"

#include "mlir/Conversion/ArithToLLVM/ArithToLLVM.h"
#include "mlir/Conversion/ControlFlowToLLVM/ControlFlowToLLVM.h"
#include "mlir/Conversion/FuncToLLVM/ConvertFuncToLLVM.h"
#include "mlir/Conversion/LLVMCommon/ConversionTarget.h"
#include "mlir/Conversion/LLVMCommon/Pattern.h"
#include "mlir/Conversion/LLVMCommon/TypeConverter.h"
#include "mlir/Dialect/Arith/IR/Arith.h"
#include "mlir/Dialect/ControlFlow/IR/ControlFlowOps.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/Dialect/LLVMIR/LLVMDialect.h"
#include "mlir/Dialect/SCF/IR/SCF.h"
#include "mlir/IR/IRMapping.h"
#include "mlir/Interfaces/DataLayoutInterfaces.h"
#include "llvm/BinaryFormat/Dwarf.h"
#include "mlir/Pass/Pass.h"
#include "mlir/Transforms/DialectConversion.h"

using namespace mlir;
using namespace milo;

namespace {

// True when anything nested in `loop` may write a Vec header: an explicit header
// write, a write to unknown memory, or an op that declares no effects at all.
bool mayWriteVecHeader(scf::ForOp loop) {
  bool writes = false;
  loop.getBody()->walk([&](Operation *op) {
    if (writes)
      return;
    // A type cast between Milo's signed ints and signless ones moves no memory.
    if (isa<UnrealizedConversionCastOp>(op))
      return;
    auto iface = dyn_cast<MemoryEffectOpInterface>(op);
    if (!iface) {
      if (!op->hasTrait<OpTrait::HasRecursiveMemoryEffects>())
        writes = true;
      return;
    }
    SmallVector<MemoryEffects::EffectInstance> effects;
    iface.getEffects(effects);
    for (auto &e : effects) {
      if (!isa<MemoryEffects::Write, MemoryEffects::Free>(e.getEffect()))
        continue;
      SideEffects::Resource *r = e.getResource();
      if (r == SideEffects::DefaultResource::get() || isa<VecHeaderResource>(r))
        writes = true;
    }
  });
  return writes;
}

struct HoistVecReadsPass
    : PassWrapper<HoistVecReadsPass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(HoistVecReadsPass)
  StringRef getArgument() const final { return "milo-hoist-vec-reads"; }
  StringRef getDescription() const final {
    return "Hoist vec.len out of loops that never write a Vec header";
  }
  void runOnOperation() override {
    // Post-order: an inner loop's hoisted lens land in the outer body before the
    // outer loop is visited, so they can keep climbing.
    getOperation().walk([](scf::ForOp loop) {
      if (mayWriteVecHeader(loop))
        return;
      for (Operation &op : llvm::make_early_inc_range(*loop.getBody())) {
        auto len = dyn_cast<VecLenOp>(op);
        if (len && loop.isDefinedOutsideOfLoop(len.getVec()))
          len->moveBefore(loop);
      }
    });
  }
};

// A check whose index is `iv + offset` (offset loop-invariant; null means 0).
struct AffineCheck {
  BoundsCheckOp op;
  Value offset;
};

std::optional<AffineCheck> matchAffineCheck(BoundsCheckOp check,
                                            scf::ForOp loop) {
  if (!loop.isDefinedOutsideOfLoop(check.getLen()))
    return std::nullopt;
  Value iv = loop.getInductionVar();
  Value idx = check.getIndex();
  if (idx == iv)
    return AffineCheck{check, Value()};
  if (auto add = idx.getDefiningOp<arith::AddIOp>()) {
    if (add.getLhs() == iv && loop.isDefinedOutsideOfLoop(add.getRhs()))
      return AffineCheck{check, add.getRhs()};
    if (add.getRhs() == iv && loop.isDefinedOutsideOfLoop(add.getLhs()))
      return AffineCheck{check, add.getLhs()};
  }
  return std::nullopt;
}

struct VersionBoundsChecksPass
    : PassWrapper<VersionBoundsChecksPass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(VersionBoundsChecksPass)
  StringRef getArgument() const final { return "milo-version-bounds-checks"; }
  StringRef getDescription() const final {
    return "Version loops so a proven-in-range copy runs without bounds checks";
  }

  void runOnOperation() override {
    SmallVector<scf::ForOp> loops;
    getOperation().walk([&](scf::ForOp loop) { loops.push_back(loop); });
    for (scf::ForOp loop : loops)
      version(loop);
  }

  void version(scf::ForOp loop) {
    if (!loop.getInductionVar().getType().isInteger(64))
      return;
    SmallVector<AffineCheck> checks;
    for (Operation &op : *loop.getBody())
      if (auto check = dyn_cast<BoundsCheckOp>(op))
        if (auto m = matchAffineCheck(check, loop))
          checks.push_back(*m);
    if (checks.empty())
      return;

    // In-range for every iteration iff lb + c >= 0 and (ub - 1) + c < len. The
    // sums are taken in i128 so they cannot wrap; when both hold, every iv + c the
    // loop computes in i64 lies in [0, len) exactly, so the i64 add did not wrap
    // either and the removed checks would all have passed. Using ub - 1 rather than
    // the true last iv only rejects some provable loops when step > 1.
    Location loc = loop.getLoc();
    OpBuilder b(loop);
    Type i128 = b.getIntegerType(128);
    auto wide = [&](Value v) -> Value {
      return arith::ExtSIOp::create(b, loc, i128, v);
    };
    auto cst = [&](int64_t v) -> Value {
      return arith::ConstantOp::create(b, loc, b.getIntegerAttr(i128, v));
    };
    Value lb = wide(loop.getLowerBound());
    Value last = arith::SubIOp::create(b, loc, wide(loop.getUpperBound()), cst(1));
    Value zero = cst(0);
    Value all = arith::ConstantOp::create(b, loc, b.getBoolAttr(true));
    for (AffineCheck &c : checks) {
      Value off = c.offset ? wide(c.offset) : zero;
      Value lo = arith::AddIOp::create(b, loc, lb, off);
      Value hi = arith::AddIOp::create(b, loc, last, off);
      Value loOk = arith::CmpIOp::create(b, loc, arith::CmpIPredicate::sge, lo, zero);
      Value hiOk = arith::CmpIOp::create(b, loc, arith::CmpIPredicate::slt, hi,
                                         wide(c.op.getLen()));
      all = arith::AndIOp::create(b, loc, all, arith::AndIOp::create(b, loc, loOk, hiOk));
    }

    auto ifOp = scf::IfOp::create(b, loc, loop.getResultTypes(), all,
                                  /*withElseRegion=*/true);
    for (Block *blk : {ifOp.thenBlock(), ifOp.elseBlock()})
      if (!blk->empty())
        blk->back().erase();

    OpBuilder tb = OpBuilder::atBlockEnd(ifOp.thenBlock());
    IRMapping map;
    auto fast = cast<scf::ForOp>(tb.clone(*loop, map));
    for (AffineCheck &c : checks)
      map.lookup(c.op.getOperation())->erase();
    scf::YieldOp::create(tb, loc, fast.getResults());

    loop.getResults().replaceAllUsesWith(ifOp.getResults());
    loop->moveBefore(ifOp.elseBlock(), ifOp.elseBlock()->end());
    OpBuilder eb = OpBuilder::atBlockEnd(ifOp.elseBlock());
    scf::YieldOp::create(eb, loc, loop.getResults());
  }
};

constexpr StringLiteral kBoundsFail = "__milo_bounds_fail";

struct ExpandChecksPass
    : PassWrapper<ExpandChecksPass, OperationPass<ModuleOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(ExpandChecksPass)
  StringRef getArgument() const final { return "milo-expand-checks"; }
  StringRef getDescription() const final {
    return "Expand bounds_check into a compare and a call to the panic routine";
  }
  void getDependentDialects(DialectRegistry &r) const override {
    r.insert<LLVM::LLVMDialect, scf::SCFDialect, arith::ArithDialect>();
  }
  void runOnOperation() override {
    ModuleOp module = getOperation();
    MLIRContext *ctx = module.getContext();
    Type i64 = IntegerType::get(ctx, 64), i32 = IntegerType::get(ctx, 32);
    if (!module.lookupSymbol(kBoundsFail)) {
      OpBuilder b = OpBuilder::atBlockBegin(module.getBody());
      auto fnTy = LLVM::LLVMFunctionType::get(LLVM::LLVMVoidType::get(ctx),
                                              {i64, i64, LLVM::LLVMPointerType::get(ctx), i32});
      auto fn = LLVM::LLVMFuncOp::create(b, module.getLoc(), kBoundsFail, fnTy);
      // noreturn lets LLVM treat the failure branch as a dead end, so the checked
      // loop still optimizes like the one the old codegen produced.
      fn.setPassthroughAttr(b.getArrayAttr(
          {b.getStringAttr("noreturn"), b.getStringAttr("cold")}));
    }
    module.walk([&](BoundsCheckOp check) {
      OpBuilder b(check);
      Location loc = check.getLoc();
      auto pos = loc->findInstanceOf<FileLineColLoc>();
      if (!pos) {
        check.emitOpError("can panic, so it needs a file:line:col location");
        return signalPassFailure();
      }
      Value oob = arith::CmpIOp::create(b, loc, arith::CmpIPredicate::uge,
                                        check.getIndex(), check.getLen());
      auto ifOp = scf::IfOp::create(b, loc, TypeRange{}, oob, false);
      b.setInsertionPointToStart(ifOp.thenBlock());
      Value line = arith::ConstantOp::create(b, loc, b.getI32IntegerAttr(pos.getLine()));
      Value file = globalString(b, loc, module, pos.getFilename());
      LLVM::CallOp::create(b, loc, TypeRange{}, kBoundsFail,
                           ValueRange{check.getIndex(), check.getLen(), file, line});
      check.erase();
    });
  }
};

// Header and element accesses get sibling TBAA scalar types under one root, so LLVM
// knows an element store never changes a header's data pointer or len. Valid because
// header memory is only ever touched through these header tags.
ArrayAttr tbaaTag(MLIRContext *ctx, StringRef name) {
  auto root = LLVM::TBAARootAttr::get(ctx, StringAttr::get(ctx, "milo"));
  auto ty = LLVM::TBAATypeDescriptorAttr::get(
      ctx, name, {LLVM::TBAAMemberAttr::get(ctx, root, 0)});
  return ArrayAttr::get(ctx, {LLVM::TBAATagAttr::get(ty, ty, 0)});
}

std::string elemTagName(Type t) {
  std::string s;
  llvm::raw_string_ostream os(s);
  os << "milo.elem." << t;
  return s;
}

Value headerField(ConversionPatternRewriter &rw, Location loc, Value hdr,
                  int64_t offset, Type ty, StringRef tag) {
  auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
  Value p = hdr;
  if (offset)
    p = LLVM::GEPOp::create(rw, loc, ptrTy, rw.getI8Type(), hdr,
                            ArrayRef<LLVM::GEPArg>{offset},
                            LLVM::GEPNoWrapFlags::inbounds);
  auto ld = LLVM::LoadOp::create(rw, loc, ty, p, /*alignment=*/8);
  ld.setTbaaAttr(tbaaTag(rw.getContext(), tag));
  return ld;
}

Value elemPtr(ConversionPatternRewriter &rw, Location loc, Value hdr,
              Value index, Type elemTy) {
  auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
  Value data = headerField(rw, loc, hdr, 0, ptrTy, "milo.vec.data");
  return LLVM::GEPOp::create(rw, loc, ptrTy, elemTy, data,
                             ArrayRef<LLVM::GEPArg>{index});
}

struct VecLenLowering : ConvertOpToLLVMPattern<VecLenOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecLenOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, headerField(rw, op.getLoc(), a.getVec(), 8,
                                 rw.getI64Type(), "milo.vec.len"));
    return success();
  }
};

struct VecLoadLowering : ConvertOpToLLVMPattern<VecLoadOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecLoadOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type t = getTypeConverter()->convertType(op.getType());
    Value p = elemPtr(rw, op.getLoc(), a.getVec(), a.getIndex(), t);
    auto ld = LLVM::LoadOp::create(rw, op.getLoc(), t, p);
    ld.setTbaaAttr(tbaaTag(rw.getContext(), elemTagName(t)));
    rw.replaceOp(op, ld.getResult());
    return success();
  }
};

struct VecElemRefLowering : ConvertOpToLLVMPattern<VecElemRefOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecElemRefOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type t = getTypeConverter()->convertType(op.getType().getPointee());
    rw.replaceOp(op, elemPtr(rw, op.getLoc(), a.getVec(), a.getIndex(), t));
    return success();
  }
};

struct VecStoreLowering : ConvertOpToLLVMPattern<VecStoreOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecStoreOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type t = a.getValue().getType();
    Value p = elemPtr(rw, op.getLoc(), a.getVec(), a.getIndex(), t);
    auto st = LLVM::StoreOp::create(rw, op.getLoc(), a.getValue(), p);
    st.setTbaaAttr(tbaaTag(rw.getContext(), elemTagName(t)));
    rw.eraseOp(op);
    return success();
  }
};

// -g local variables: milo.dbg.var survives convert-milo-to-llvm (and mem2reg, which cannot
// promote past it) with the DI type of its slot; milo-lower-debug-vars then makes it a
// dbg.declare in the function's DISubprogram.

// The DI type of a slot's pointee: a scalar, or a struct of them. Null for what the
// debugger cannot read as such (enums, strings, Vecs): they get no variable.
LLVM::DITypeAttr diTypeOf(Type t, const LLVMTypeConverter &tc, const DataLayout &dl, DictionaryAttr names,
                          unsigned depth = 0) {
  MLIRContext *ctx = &tc.getContext();
  auto basic = [&](StringRef name, uint64_t bits, unsigned enc) {
    return LLVM::DIBasicTypeAttr::get(ctx, llvm::dwarf::DW_TAG_base_type, StringAttr::get(ctx, name), bits, enc);
  };
  if (auto i = dyn_cast<IntegerType>(t)) {
    unsigned w = i.getWidth();
    if (w == 1)
      return basic("bool", 8, llvm::dwarf::DW_ATE_boolean);
    bool sg = i.isSigned();
    // C names, so a debugger renders an i32 as `int`.
    const char *n = w == 8    ? (sg ? "signed char" : "unsigned char")
                    : w == 16 ? (sg ? "short" : "unsigned short")
                    : w == 32 ? (sg ? "int" : "unsigned int")
                    : w == 64 ? (sg ? "long" : "unsigned long")
                              : (sg ? "__int128" : "unsigned __int128");
    return basic(n, w, sg ? llvm::dwarf::DW_ATE_signed : llvm::dwarf::DW_ATE_unsigned);
  }
  if (auto f = dyn_cast<FloatType>(t))
    return basic(f.getWidth() == 32 ? "float" : "double", f.getWidth(), llvm::dwarf::DW_ATE_float);
  auto s = dyn_cast<StructType>(t);
  if (!s || !s.isInitialized() || depth > 4)
    return nullptr;
  auto fieldNames = names ? names.getAs<ArrayAttr>(s.getName()) : ArrayAttr();
  if (!fieldNames || fieldNames.size() != s.getFields().size())
    return nullptr;
  SmallVector<LLVM::DINodeAttr> members;
  uint64_t off = 0, maxAlign = 1;
  for (auto [fty, fname] : llvm::zip(s.getFields(), fieldNames)) {
    Type lt = tc.convertType(fty);
    if (!lt)
      return nullptr;
    uint64_t al = dl.getTypeABIAlignment(lt), sz = dl.getTypeSize(lt);
    off = llvm::alignTo(off, al);
    maxAlign = std::max(maxAlign, al);
    // A field the debugger cannot read is left out; the others keep their real offsets.
    if (auto ft = diTypeOf(fty, tc, dl, names, depth + 1))
      members.push_back(LLVM::DIDerivedTypeAttr::get(ctx, llvm::dwarf::DW_TAG_member, cast<StringAttr>(fname),
                                                     nullptr, 0, nullptr, ft, sz * 8, al * 8, off * 8,
                                                     std::nullopt, LLVM::DIFlags::Zero, nullptr));
    off += sz;
  }
  return LLVM::DICompositeTypeAttr::get(ctx, llvm::dwarf::DW_TAG_structure_type, StringAttr::get(ctx, s.getName()),
                                        nullptr, 0, nullptr, nullptr, LLVM::DIFlags::Zero,
                                        llvm::alignTo(off, maxAlign) * 8, maxAlign * 8, nullptr, nullptr, nullptr,
                                        nullptr, nullptr, nullptr, members);
}

struct DbgVarLowering : ConvertOpToLLVMPattern<DbgVarOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult matchAndRewrite(DbgVarOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    auto ref = dyn_cast<RefType>(op.getRef().getType());
    if (!ref)
      return failure();
    DataLayout dl = DataLayout::closest(op);
    auto di = diTypeOf(ref.getPointee(), *getTypeConverter(), dl, op.getFieldsAttr());
    // A pointee with no DI type has no variable: the slot stays, the op goes.
    if (!di) {
      rw.eraseOp(op);
      return success();
    }
    rw.modifyOpInPlace(op, [&] {
      op.getRefMutable().assign(a.getRef());
      op.setDiTypeAttr(di);
    });
    return success();
  }
};

struct LowerDebugVarsPass : PassWrapper<LowerDebugVarsPass, OperationPass<LLVM::LLVMFuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(LowerDebugVarsPass)
  StringRef getArgument() const final { return "milo-lower-debug-vars"; }
  StringRef getDescription() const final {
    return "milo.dbg.var to llvm.intr.dbg.declare in the function's DISubprogram";
  }
  void getDependentDialects(DialectRegistry &r) const override { r.insert<LLVM::LLVMDialect>(); }
  void runOnOperation() override {
    LLVM::LLVMFuncOp fn = getOperation();
    SmallVector<DbgVarOp> vars;
    fn.walk([&](DbgVarOp v) { vars.push_back(v); });
    if (vars.empty())
      return;
    auto fused = dyn_cast<FusedLocWith<LLVM::DISubprogramAttr>>(fn.getLoc());
    MLIRContext *ctx = &getContext();
    for (DbgVarOp v : vars) {
      if (fused && v.getDiType()) {
        Location l = v.getLoc();
        if (auto f = dyn_cast<FusedLoc>(l))
          l = f.getLocations().front();
        unsigned line = 0;
        if (auto fl = dyn_cast<FileLineColLoc>(l))
          line = fl.getLine();
        LLVM::DISubprogramAttr sp = fused.getMetadata();
        auto var = LLVM::DILocalVariableAttr::get(ctx, sp, v.getNameAttr(), sp.getFile(), line,
                                                  v.getArg().value_or(0), 0,
                                                  cast<LLVM::DITypeAttr>(*v.getDiType()), LLVM::DIFlags::Zero);
        OpBuilder b(v);
        LLVM::DbgDeclareOp::create(b, v.getLoc(), v.getRef(), var);
      }
      v.erase();
    }
  }
};

struct ConvertMiloToLLVMPass
    : PassWrapper<ConvertMiloToLLVMPass, OperationPass<ModuleOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(ConvertMiloToLLVMPass)
  StringRef getArgument() const final { return "convert-milo-to-llvm"; }
  StringRef getDescription() const final {
    return "Lower milo, func, arith and cf to the LLVM dialect";
  }
  void getDependentDialects(DialectRegistry &r) const override {
    r.insert<LLVM::LLVMDialect>();
  }
  void runOnOperation() override {
    MLIRContext *ctx = &getContext();
    LLVMTypeConverter tc(ctx);
    tc.addConversion(
        [ctx](VecType) -> Type { return LLVM::LLVMPointerType::get(ctx); });
    RewritePatternSet patterns(ctx);
    populateFuncToLLVMConversionPatterns(tc, patterns);
    arith::populateArithToLLVMConversionPatterns(tc, patterns);
    cf::populateControlFlowToLLVMConversionPatterns(tc, patterns);
    patterns.add<VecLenLowering, VecLoadLowering, VecStoreLowering, VecElemRefLowering, DbgVarLowering>(tc);
    populateScalarToLLVMPatterns(tc, patterns);
    populateOwnedToLLVMPatterns(tc, patterns);
    LLVMConversionTarget target(*ctx);
    target.addLegalOp<ModuleOp>();
    target.addDynamicallyLegalOp<DbgVarOp>(
        [](DbgVarOp o) { return isa<LLVM::LLVMPointerType>(o.getRef().getType()); });
    if (failed(applyFullConversion(getOperation(), target, std::move(patterns))))
      signalPassFailure();
  }
};

} // namespace

void milo::registerPasses() {
  PassRegistration<HoistVecReadsPass>();
  PassRegistration<VersionBoundsChecksPass>();
  PassRegistration<ExpandChecksPass>();
  PassRegistration<ConvertMiloToLLVMPass>();
  PassRegistration<LowerDebugVarsPass>();
  registerScalarPasses();
  registerDropPasses();
}
