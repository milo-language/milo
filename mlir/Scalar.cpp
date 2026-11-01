// Lowering of the source-level scalar ops (Milo.td, "Source-level ops"):
//   milo-verify               rules that span ops (a !milo.ref never escapes a call)
//   milo-lower-structured-cf  milo.if/while/loop/for + their jumps -> cf
//   populateScalarToLLVMPatterns  milo arithmetic, casts, locals, return -> LLVM dialect,
//                             used by convert-milo-to-llvm
//
// The traps reproduce legacy codegen (src/codegen.ts emitScalarBinOp and friends) byte
// for byte on stderr: overflow calls the module's `__milo_overflow_fail(file, line)`,
// every other panic calls `__milo_mlir_panic(msg)`, which prints msg the way the legacy
// inline sequence does and then aborts through the panic hook. Both routines are defined
// by the legacy module this function is linked into (src/mlir-backend.ts).
#include "Milo.h"

#include "mlir/Conversion/LLVMCommon/Pattern.h"
#include "mlir/Dialect/ControlFlow/IR/ControlFlowOps.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/Dialect/LLVMIR/FunctionCallUtils.h"
#include "mlir/Dialect/LLVMIR/LLVMDialect.h"
#include "mlir/IR/PatternMatch.h"
#include "mlir/Pass/Pass.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/Support/xxhash.h"

using namespace mlir;
using namespace milo;

namespace {

//===----------------------------------------------------------------------===//
// milo-lower-structured-cf
//===----------------------------------------------------------------------===//

Operation *terminatorOf(Block &b) { return b.empty() ? nullptr : &b.back(); }

// Rewrites every terminator of type T in the blocks directly inside `r`. Run after the
// ops nested in `r` are lowered, so every such terminator belongs to r's owner.
template <typename T, typename F>
void rewriteTerminators(Region &r, F fn) {
  for (Block &b : r)
    if (auto t = dyn_cast_or_null<T>(terminatorOf(b)))
      fn(t);
}

// Jumps out of a loop body. Nested loops are lowered first, so every break or continue
// still nested in `body` targets this loop.
void lowerJumps(IRRewriter &rw, Region &body, Block *breakTo, Block *continueTo,
                ValueRange continueArgs = {}) {
  SmallVector<Operation *> jumps;
  body.walk([&](Operation *op) {
    if (isa<BreakOp, ContinueOp>(op))
      jumps.push_back(op);
  });
  for (Operation *j : jumps) {
    rw.setInsertionPoint(j);
    if (isa<BreakOp>(j))
      rw.replaceOpWithNewOp<cf::BranchOp>(j, breakTo);
    else
      rw.replaceOpWithNewOp<cf::BranchOp>(j, continueTo, continueArgs);
  }
}

void lowerIf(IRRewriter &rw, IfOp op) {
  Location loc = op.getLoc();
  Block *cur = op->getBlock();
  Block *cont = rw.splitBlock(cur, std::next(op->getIterator()));
  for (Type t : op.getResultTypes())
    cont->addArgument(t, loc);
  auto yieldsToCont = [&](Region &r) {
    rewriteTerminators<YieldOp>(r, [&](YieldOp y) {
      rw.setInsertionPoint(y);
      rw.replaceOpWithNewOp<cf::BranchOp>(y, cont, y.getValues());
    });
  };
  Block *thenEntry = &op.getThenRegion().front();
  yieldsToCont(op.getThenRegion());
  rw.inlineRegionBefore(op.getThenRegion(), cont);
  Block *elseEntry = cont;
  if (!op.getElseRegion().empty()) {
    elseEntry = &op.getElseRegion().front();
    yieldsToCont(op.getElseRegion());
    rw.inlineRegionBefore(op.getElseRegion(), cont);
  }
  rw.setInsertionPointToEnd(cur);
  cf::CondBranchOp::create(rw, loc, op.getCondition(), thenEntry, ValueRange{},
                           elseEntry, ValueRange{});
  rw.replaceOp(op, cont->getArguments());
}

void lowerWhile(IRRewriter &rw, WhileOp op) {
  Location loc = op.getLoc();
  Block *cur = op->getBlock();
  Block *cont = rw.splitBlock(cur, std::next(op->getIterator()));
  Block *head = &op.getCondRegion().front();
  Block *body = &op.getBodyRegion().front();
  rewriteTerminators<ConditionOp>(op.getCondRegion(), [&](ConditionOp c) {
    rw.setInsertionPoint(c);
    rw.replaceOpWithNewOp<cf::CondBranchOp>(c, c.getCondition(), body, ValueRange{},
                                            cont, ValueRange{});
  });
  rewriteTerminators<YieldOp>(op.getBodyRegion(), [&](YieldOp y) {
    rw.setInsertionPoint(y);
    rw.replaceOpWithNewOp<cf::BranchOp>(y, head);
  });
  lowerJumps(rw, op.getBodyRegion(), cont, head);
  rw.inlineRegionBefore(op.getCondRegion(), cont);
  rw.inlineRegionBefore(op.getBodyRegion(), cont);
  rw.setInsertionPointToEnd(cur);
  cf::BranchOp::create(rw, loc, head);
  rw.eraseOp(op);
}

void lowerLoop(IRRewriter &rw, LoopOp op) {
  Location loc = op.getLoc();
  Block *cur = op->getBlock();
  Block *cont = rw.splitBlock(cur, std::next(op->getIterator()));
  Block *body = &op.getBodyRegion().front();
  rewriteTerminators<YieldOp>(op.getBodyRegion(), [&](YieldOp y) {
    rw.setInsertionPoint(y);
    rw.replaceOpWithNewOp<cf::BranchOp>(y, body);
  });
  lowerJumps(rw, op.getBodyRegion(), cont, body);
  rw.inlineRegionBefore(op.getBodyRegion(), cont);
  rw.setInsertionPointToEnd(cur);
  cf::BranchOp::create(rw, loc, body);
  rw.eraseOp(op);
}

// head(i): i < end ? body(i) : exit;  body ... incr(i);  incr(i): head(i + 1).
// `continue` goes to the increment, as in legacy codegen.
void lowerFor(IRRewriter &rw, ForOp op) {
  Location loc = op.getLoc();
  Type t = op.getStart().getType();
  Block *cur = op->getBlock();
  Block *cont = rw.splitBlock(cur, std::next(op->getIterator()));
  Block *body = &op.getBodyRegion().front();
  Value iv = body->getArgument(0);
  Block *head = rw.createBlock(cont, TypeRange{t}, {loc});
  Block *incr = rw.createBlock(cont, TypeRange{t}, {loc});

  rw.setInsertionPointToEnd(incr);
  Value one = ConstOp::create(rw, loc, t, rw.getIntegerAttr(t, 1));
  Value next = AddOp::create(rw, loc, t, incr->getArgument(0), one, rw.getUnitAttr());
  cf::BranchOp::create(rw, loc, head, ValueRange{next});

  rw.setInsertionPointToEnd(head);
  Value more = CmpOp::create(rw, loc, rw.getI1Type(), CmpPredicate::lt, head->getArgument(0), op.getEnd());
  cf::CondBranchOp::create(rw, loc, more, body, ValueRange{head->getArgument(0)}, cont, ValueRange{});

  rewriteTerminators<YieldOp>(op.getBodyRegion(), [&](YieldOp y) {
    rw.setInsertionPoint(y);
    rw.replaceOpWithNewOp<cf::BranchOp>(y, incr, ValueRange{iv});
  });
  lowerJumps(rw, op.getBodyRegion(), cont, incr, ValueRange{iv});
  rw.inlineRegionBefore(op.getBodyRegion(), incr);
  rw.setInsertionPointToEnd(cur);
  cf::BranchOp::create(rw, loc, head, ValueRange{op.getStart()});
  rw.eraseOp(op);
}

struct LowerStructuredCFPass
    : PassWrapper<LowerStructuredCFPass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(LowerStructuredCFPass)
  StringRef getArgument() const final { return "milo-lower-structured-cf"; }
  StringRef getDescription() const final {
    return "Lower milo.if/while/loop/for and their jumps to cf branches";
  }
  void getDependentDialects(DialectRegistry &r) const override {
    r.insert<cf::ControlFlowDialect>();
  }
  void runOnOperation() override {
    // Innermost first: by the time a loop is lowered, every jump left inside it is its own.
    SmallVector<Operation *> ops;
    getOperation().walk<WalkOrder::PostOrder>([&](Operation *op) {
      if (isa<IfOp, WhileOp, LoopOp, ForOp>(op))
        ops.push_back(op);
    });
    IRRewriter rw(&getContext());
    for (Operation *op : ops) {
      if (auto i = dyn_cast<IfOp>(op))
        lowerIf(rw, i);
      else if (auto w = dyn_cast<WhileOp>(op))
        lowerWhile(rw, w);
      else if (auto f = dyn_cast<ForOp>(op))
        lowerFor(rw, f);
      else
        lowerLoop(rw, cast<LoopOp>(op));
    }
  }
};

//===----------------------------------------------------------------------===//
// milo scalar ops -> LLVM
//===----------------------------------------------------------------------===//

constexpr StringLiteral kOverflowFail = "__milo_overflow_fail";
constexpr StringLiteral kPanic = "__milo_mlir_panic";

bool isUnsignedInt(Type t) {
  auto i = dyn_cast<IntegerType>(t);
  return i && i.isUnsigned();
}

// Where a check sits, as legacy codegen prints it: the display path, line and column.
struct SrcPos {
  std::string file;
  unsigned line = 0, col = 0;
  std::string at() const {
    return file + ":" + std::to_string(line) + ":" + std::to_string(col);
  }
};

FailureOr<SrcPos> srcPos(Operation *op) {
  auto fl = op->getLoc()->findInstanceOf<FileLineColLoc>();
  if (!fl)
    return op->emitOpError("can panic, so it needs a file:line:col location");
  return SrcPos{fl.getFilename().str(), fl.getLine(), fl.getColumn()};
}

// The address of a NUL-terminated private constant holding `s`, one global per text.
Value stringPtr(ConversionPatternRewriter &rw, Location loc, ModuleOp module,
                StringRef s) {
  std::string bytes = (s + Twine('\0')).str();
  std::string name = "milo.mlir.s." + llvm::utohexstr(llvm::xxh3_64bits(bytes));
  auto global = module.lookupSymbol<LLVM::GlobalOp>(name);
  if (!global) {
    OpBuilder::InsertionGuard g(rw);
    rw.setInsertionPointToStart(module.getBody());
    auto ty = LLVM::LLVMArrayType::get(rw.getI8Type(), bytes.size());
    global = LLVM::GlobalOp::create(rw, loc, ty, /*isConstant=*/true,
                                    LLVM::Linkage::Private, name,
                                    rw.getStringAttr(bytes));
  }
  return LLVM::AddressOfOp::create(rw, loc, global);
}

// Branches to a fresh block that panics when `failed` holds; continues after it in a
// new block, where the rewriter is left. The call happens in the failing block only, so
// the hot path stays a compare and a branch, as in legacy codegen.
template <typename EmitFail>
void branchToPanic(ConversionPatternRewriter &rw, Location loc, Value failed,
                   EmitFail emitFail) {
  Block *cur = rw.getInsertionBlock();
  Block *cont = rw.splitBlock(cur, rw.getInsertionPoint());
  Block *fail = rw.createBlock(cont);
  emitFail();
  LLVM::UnreachableOp::create(rw, loc);
  rw.setInsertionPointToEnd(cur);
  LLVM::CondBrOp::create(rw, loc, failed, fail, cont);
  rw.setInsertionPointToStart(cont);
}

// "milo: <what> at <file:line:col><tail>\n", the shape of every legacy panic message.
LogicalResult panicIf(ConversionPatternRewriter &rw, Operation *op, Value bad,
                      StringRef what, StringRef tail = "") {
  auto pos = srcPos(op);
  if (failed(pos))
    return failure();
  auto module = op->getParentOfType<ModuleOp>();
  Location loc = op->getLoc();
  auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
  auto fn = LLVM::lookupOrCreateFn(rw, module, kPanic, {ptrTy},
                                   LLVM::LLVMVoidType::get(rw.getContext()));
  if (failed(fn))
    return failure();
  std::string msg = ("milo: " + what + " at " + pos->at() + tail + "\n").str();
  branchToPanic(rw, loc, bad, [&] {
    LLVM::CallOp::create(rw, loc, *fn, ValueRange{stringPtr(rw, loc, module, msg)});
  });
  return success();
}

Value constInt(ConversionPatternRewriter &rw, Location loc, Type t, const APInt &v) {
  return LLVM::ConstantOp::create(rw, loc, t, rw.getIntegerAttr(t, v));
}
Value constInt(ConversionPatternRewriter &rw, Location loc, Type t, int64_t v) {
  unsigned w = cast<IntegerType>(t).getWidth();
  return constInt(rw, loc, t, APInt(w, v, /*isSigned=*/true));
}

// `op.with.overflow`, then the overflow routine on the failing edge.
template <typename SignedOv, typename UnsignedOv>
FailureOr<Value> checkedArith(ConversionPatternRewriter &rw, Operation *op, Type milo,
                              Value l, Value r) {
  auto pos = srcPos(op);
  if (failed(pos))
    return failure();
  Location loc = op->getLoc();
  Type t = l.getType();
  auto pairTy = LLVM::LLVMStructType::getLiteral(rw.getContext(), {t, rw.getI1Type()});
  Value pair = isUnsignedInt(milo)
                   ? UnsignedOv::create(rw, loc, pairTy, l, r).getResult()
                   : SignedOv::create(rw, loc, pairTy, l, r).getResult();
  Value v = LLVM::ExtractValueOp::create(rw, loc, pair, ArrayRef<int64_t>{0});
  Value ov = LLVM::ExtractValueOp::create(rw, loc, pair, ArrayRef<int64_t>{1});
  auto module = op->getParentOfType<ModuleOp>();
  auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
  auto fn = LLVM::lookupOrCreateFn(rw, module, kOverflowFail, {ptrTy, rw.getI32Type()},
                                   LLVM::LLVMVoidType::get(rw.getContext()));
  if (failed(fn))
    return failure();
  branchToPanic(rw, loc, ov, [&] {
    Value file = stringPtr(rw, loc, module, pos->file);
    Value line = constInt(rw, loc, rw.getI32Type(), pos->line);
    LLVM::CallOp::create(rw, loc, *fn, ValueRange{file, line});
  });
  return v;
}

template <typename OpT, typename FloatOp, typename IntOp, typename SignedOv,
          typename UnsignedOv>
struct AddLikeLowering : ConvertOpToLLVMPattern<OpT> {
  using ConvertOpToLLVMPattern<OpT>::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(OpT op, typename OpT::Adaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value l = a.getLhs(), r = a.getRhs();
    if (isa<FloatType>(op.getType())) {
      rw.replaceOp(op, FloatOp::create(rw, loc, l, r));
      return success();
    }
    if (op.getWrapping()) {
      rw.replaceOp(op, IntOp::create(rw, loc, l, r));
      return success();
    }
    auto v = checkedArith<SignedOv, UnsignedOv>(rw, op, op.getType(), l, r);
    if (failed(v))
      return failure();
    rw.replaceOp(op, *v);
    return success();
  }
};

using AddLowering = AddLikeLowering<AddOp, LLVM::FAddOp, LLVM::AddOp,
                                    LLVM::SAddWithOverflowOp, LLVM::UAddWithOverflowOp>;
using SubLowering = AddLikeLowering<SubOp, LLVM::FSubOp, LLVM::SubOp,
                                    LLVM::SSubWithOverflowOp, LLVM::USubWithOverflowOp>;
using MulLowering = AddLikeLowering<MulOp, LLVM::FMulOp, LLVM::MulOp,
                                    LLVM::SMulWithOverflowOp, LLVM::UMulWithOverflowOp>;

struct NegLowering : ConvertOpToLLVMPattern<NegOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(NegOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value x = a.getOperand();
    if (isa<FloatType>(op.getType())) {
      rw.replaceOp(op, LLVM::FNegOp::create(rw, loc, x));
      return success();
    }
    Value zero = constInt(rw, loc, x.getType(), 0);
    if (op.getWrapping()) {
      rw.replaceOp(op, LLVM::SubOp::create(rw, loc, zero, x));
      return success();
    }
    auto v = checkedArith<LLVM::SSubWithOverflowOp, LLVM::USubWithOverflowOp>(
        rw, op, op.getType(), zero, x);
    if (failed(v))
      return failure();
    rw.replaceOp(op, *v);
    return success();
  }
};

// Division by zero panics in every mode; signed MIN / -1 panics, or under `wrapping`
// yields MIN (quotient) or 0 (remainder), routed around the instruction with a select
// because sdiv/srem of that pair is UB.
template <typename OpT, typename FloatOp, typename SOp, typename UOp, bool IsDiv>
struct DivLikeLowering : ConvertOpToLLVMPattern<OpT> {
  using ConvertOpToLLVMPattern<OpT>::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(OpT op, typename OpT::Adaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value l = a.getLhs(), r = a.getRhs();
    if (isa<FloatType>(op.getType())) {
      rw.replaceOp(op, FloatOp::create(rw, loc, l, r));
      return success();
    }
    Type t = l.getType();
    unsigned bits = cast<IntegerType>(t).getWidth();
    bool isSigned = !isUnsignedInt(op.getType());
    Value isZero = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, r,
                                        constInt(rw, loc, t, 0));
    if (failed(panicIf(rw, op, isZero, "division by zero")))
      return failure();
    if (!isSigned) {
      rw.replaceOp(op, UOp::create(rw, loc, l, r));
      return success();
    }
    Value isMin = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, l,
                                       constInt(rw, loc, t, APInt::getSignedMinValue(bits)));
    Value isNeg1 = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, r,
                                        constInt(rw, loc, t, -1));
    Value ovf = LLVM::AndOp::create(rw, loc, isMin, isNeg1);
    if (!op.getWrapping()) {
      std::string what = "division overflow (i" + std::to_string(bits) + "::MIN / -1)";
      if (failed(panicIf(rw, op, ovf, what)))
        return failure();
      rw.replaceOp(op, SOp::create(rw, loc, l, r));
      return success();
    }
    Value safe = LLVM::SelectOp::create(rw, loc, ovf, constInt(rw, loc, t, 1), r);
    Value raw = SOp::create(rw, loc, l, safe);
    Value wrapped = IsDiv ? constInt(rw, loc, t, APInt::getSignedMinValue(bits))
                          : constInt(rw, loc, t, 0);
    rw.replaceOp(op, LLVM::SelectOp::create(rw, loc, ovf, wrapped, raw));
    return success();
  }
};

using DivLowering = DivLikeLowering<DivOp, LLVM::FDivOp, LLVM::SDivOp, LLVM::UDivOp, true>;
using RemLowering = DivLikeLowering<RemOp, LLVM::FRemOp, LLVM::SRemOp, LLVM::URemOp, false>;

// An amount >= the width (a negative one is huge as unsigned) panics; `wrapping` masks it.
template <typename OpT, bool IsShl>
struct ShiftLowering : ConvertOpToLLVMPattern<OpT> {
  using ConvertOpToLLVMPattern<OpT>::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(OpT op, typename OpT::Adaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value l = a.getLhs(), r = a.getRhs();
    Type t = l.getType();
    unsigned bits = cast<IntegerType>(t).getWidth();
    if (op.getWrapping()) {
      r = LLVM::AndOp::create(rw, loc, r, constInt(rw, loc, t, bits - 1));
    } else {
      Value bad = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::uge, r,
                                       constInt(rw, loc, t, bits));
      std::string what = "shift amount out of range (>= " + std::to_string(bits) + ")";
      if (failed(panicIf(rw, op, bad, what)))
        return failure();
    }
    Value v;
    if (IsShl)
      v = LLVM::ShlOp::create(rw, loc, l, r);
    else if (isUnsignedInt(op.getType()))
      v = LLVM::LShrOp::create(rw, loc, l, r);
    else
      v = LLVM::AShrOp::create(rw, loc, l, r);
    rw.replaceOp(op, v);
    return success();
  }
};

template <typename OpT, typename LLOp>
struct BitLowering : ConvertOpToLLVMPattern<OpT> {
  using ConvertOpToLLVMPattern<OpT>::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(OpT op, typename OpT::Adaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, LLOp::create(rw, op.getLoc(), a.getLhs(), a.getRhs()));
    return success();
  }
};

struct NotLowering : ConvertOpToLLVMPattern<NotOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(NotOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Value x = a.getOperand();
    unsigned w = cast<IntegerType>(x.getType()).getWidth();
    Value ones = constInt(rw, op.getLoc(), x.getType(), APInt::getAllOnes(w));
    rw.replaceOp(op, LLVM::XOrOp::create(rw, op.getLoc(), x, ones));
    return success();
  }
};

struct ConstLowering : ConvertOpToLLVMPattern<ConstOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ConstOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    Type t = getTypeConverter()->convertType(op.getType());
    Attribute v = op.getValue();
    if (auto i = dyn_cast<IntegerAttr>(v))
      v = rw.getIntegerAttr(t, i.getValue());
    rw.replaceOpWithNewOp<LLVM::ConstantOp>(op, t, cast<TypedAttr>(v));
    return success();
  }
};

struct CmpLowering : ConvertOpToLLVMPattern<CmpOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(CmpOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    CmpPredicate p = op.getPredicate();
    Type t = op.getLhs().getType();
    if (isa<FloatType>(t)) {
      using F = LLVM::FCmpPredicate;
      // `ne` is unordered: NaN != NaN.
      F fp[] = {F::oeq, F::une, F::olt, F::ole, F::ogt, F::oge};
      rw.replaceOpWithNewOp<LLVM::FCmpOp>(op, fp[static_cast<int>(p)], a.getLhs(), a.getRhs());
      return success();
    }
    using I = LLVM::ICmpPredicate;
    I sp[] = {I::eq, I::ne, I::slt, I::sle, I::sgt, I::sge};
    I up[] = {I::eq, I::ne, I::ult, I::ule, I::ugt, I::uge};
    I pred = (isUnsignedInt(t) ? up : sp)[static_cast<int>(p)];
    rw.replaceOpWithNewOp<LLVM::ICmpOp>(op, pred, a.getLhs(), a.getRhs());
    (void)loc;
    return success();
  }
};

// Mirrors legacy emitScalarCast: same LLVM type is a no-op; widening follows the source's
// signedness (bool zero-extends); float to int saturates; bool to float is sitofp.
struct CastLowering : ConvertOpToLLVMPattern<CastOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(CastOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Type from = op.getOperand().getType(), to = op.getType();
    Value x = a.getOperand();
    Type toLL = getTypeConverter()->convertType(to);
    if (x.getType() == toLL) {
      rw.replaceOp(op, x);
      return success();
    }
    auto fromF = dyn_cast<FloatType>(from);
    auto toF = dyn_cast<FloatType>(to);
    Value v;
    if (fromF && toF) {
      if (toF.getWidth() > fromF.getWidth())
        v = LLVM::FPExtOp::create(rw, loc, toLL, x);
      else
        v = LLVM::FPTruncOp::create(rw, loc, toLL, x);
    } else if (fromF) {
      std::string name = std::string("llvm.") + (isUnsignedInt(to) ? "fptoui" : "fptosi") +
                         ".sat.i" + std::to_string(cast<IntegerType>(toLL).getWidth()) +
                         (fromF.getWidth() == 64 ? ".f64" : ".f32");
      v = LLVM::CallIntrinsicOp::create(rw, loc, toLL, rw.getStringAttr(name), ValueRange{x})
              .getResult(0);
    } else if (toF) {
      if (isUnsignedInt(from))
        v = LLVM::UIToFPOp::create(rw, loc, toLL, x);
      else
        v = LLVM::SIToFPOp::create(rw, loc, toLL, x);
    } else {
      unsigned fw = cast<IntegerType>(x.getType()).getWidth();
      unsigned tw = cast<IntegerType>(toLL).getWidth();
      bool zext = fw == 1 || isUnsignedInt(from);
      if (tw > fw)
        v = zext ? LLVM::ZExtOp::create(rw, loc, toLL, x).getResult()
                 : LLVM::SExtOp::create(rw, loc, toLL, x).getResult();
      else
        v = LLVM::TruncOp::create(rw, loc, toLL, x);
    }
    rw.replaceOp(op, v);
    return success();
  }
};

struct VarLowering : ConvertOpToLLVMPattern<VarOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VarOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Type elem = getTypeConverter()->convertType(op.getRef().getType().getPointee());
    Value one = constInt(rw, loc, rw.getI64Type(), 1);
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    rw.replaceOpWithNewOp<LLVM::AllocaOp>(op, ptrTy, elem, one);
    return success();
  }
};

struct LoadLowering : ConvertOpToLLVMPattern<LoadOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(LoadOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type t = getTypeConverter()->convertType(op.getType());
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, t, a.getRef());
    return success();
  }
};

struct StoreLowering : ConvertOpToLLVMPattern<StoreOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StoreOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::StoreOp>(op, a.getValue(), a.getRef());
    return success();
  }
};

struct ReturnLowering : ConvertOpToLLVMPattern<ReturnOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ReturnOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::ReturnOp>(op, a.getOperands());
    return success();
  }
};

// A trap, not a bare `unreachable`, as legacy codegen does: a shape the checker misses
// aborts instead of running past the end of the function.
struct UnreachableLowering : ConvertOpToLLVMPattern<UnreachableOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(UnreachableOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    LLVM::Trap::create(rw, op.getLoc());
    rw.replaceOpWithNewOp<LLVM::UnreachableOp>(op);
    return success();
  }
};

struct CheckUnaliasedLowering : ConvertOpToLLVMPattern<CheckUnaliasedOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(CheckUnaliasedOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Value same = LLVM::ICmpOp::create(rw, op.getLoc(), LLVM::ICmpPredicate::eq,
                                      a.getLhs(), a.getRhs());
    if (failed(panicIf(rw, op, same, "aliasing '&mut' arguments",
                       " (two mutable borrows of the same value in one call)")))
      return failure();
    rw.eraseOp(op);
    return success();
  }
};

// milo-verify: rules no single op can check. A `!milo.ref` is second-class, like a Milo
// `&T`: it may be a parameter or a call argument, never a result. Store, yield and
// return already refuse one by operand type; this covers function and call signatures.
struct VerifyPass : PassWrapper<VerifyPass, OperationPass<ModuleOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(VerifyPass)
  StringRef getArgument() const final { return "milo-verify"; }
  StringRef getDescription() const final {
    return "Check the rules of the source-level dialect that span ops";
  }
  void runOnOperation() override {
    auto isRef = [](Type t) { return isa<RefType>(t); };
    getOperation().walk([&](Operation *op) {
      if (auto fn = dyn_cast<func::FuncOp>(op)) {
        if (llvm::any_of(fn.getResultTypes(), isRef)) {
          fn.emitOpError("returns a !milo.ref: a reference cannot outlive its call");
          signalPassFailure();
        }
      } else if (auto call = dyn_cast<func::CallOp>(op)) {
        if (llvm::any_of(call.getResultTypes(), isRef)) {
          call.emitOpError("returns a !milo.ref: a reference cannot outlive its call");
          signalPassFailure();
        }
      }
    });
  }
};

} // namespace

void milo::populateScalarToLLVMPatterns(LLVMTypeConverter &tc,
                                        RewritePatternSet &patterns) {
  tc.addConversion([ctx = &tc.getContext()](RefType) -> Type {
    return LLVM::LLVMPointerType::get(ctx);
  });
  patterns.add<AddLowering, SubLowering, MulLowering, NegLowering, DivLowering,
               RemLowering, ShiftLowering<ShlOp, true>, ShiftLowering<ShrOp, false>,
               BitLowering<AndOp, LLVM::AndOp>, BitLowering<OrOp, LLVM::OrOp>,
               BitLowering<XorOp, LLVM::XOrOp>, NotLowering, ConstLowering, CmpLowering,
               CastLowering, VarLowering, LoadLowering, StoreLowering, ReturnLowering,
               UnreachableLowering, CheckUnaliasedLowering>(tc);
}

void milo::registerScalarPasses() {
  PassRegistration<LowerStructuredCFPass>();
  PassRegistration<VerifyPass>();
}
