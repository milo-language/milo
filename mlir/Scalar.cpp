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
#include "mlir/Dialect/Arith/IR/Arith.h"
#include "mlir/Dialect/ControlFlow/IR/ControlFlowOps.h"
#include "mlir/Dialect/SCF/IR/SCF.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/Dialect/LLVMIR/FunctionCallUtils.h"
#include "mlir/Dialect/LLVMIR/LLVMDialect.h"
#include "mlir/IR/PatternMatch.h"
#include "mlir/Pass/Pass.h"
#include "mlir/Transforms/RegionUtils.h"
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

// switch(key): one block per arm, the default arm (or an unreachable) otherwise. An enum
// arm's block arguments become payload reads at its entry, where the tag is known.
void lowerMatch(IRRewriter &rw, MatchOp op) {
  Location loc = op.getLoc();
  Block *cur = op->getBlock();
  Block *cont = rw.splitBlock(cur, std::next(op->getIterator()));
  for (Type t : op.getResultTypes())
    cont->addArgument(t, loc);
  Value subject = op.getSubject();
  auto e = dyn_cast<EnumType>(subject.getType());

  rw.setInsertionPoint(op);
  Value key = e ? Value(EnumTagOp::create(rw, loc, rw.getIntegerType(32, true), subject))
                : subject;
  unsigned width = cast<IntegerType>(key.getType()).getWidth();
  if (!cast<IntegerType>(key.getType()).isSignless())
    key = UnrealizedConversionCastOp::create(rw, loc, TypeRange{rw.getIntegerType(width)},
                                             ValueRange{key})
              .getResult(0);

  SmallVector<Block *> entries;
  for (auto [i, region] : llvm::enumerate(op.getArms())) {
    Block *entry = &region.front();
    if (e && i < op.getCases().size() && entry->getNumArguments()) {
      rw.setInsertionPointToStart(entry);
      int32_t tag = static_cast<int32_t>(op.getCases()[i]);
      for (BlockArgument a : entry->getArguments())
        a.replaceAllUsesWith(EnumPayloadOp::create(rw, loc, a.getType(), subject,
                                                   rw.getI32IntegerAttr(tag),
                                                   rw.getI64IntegerAttr(a.getArgNumber())));
      entry->eraseArguments(0, entry->getNumArguments());
    }
    rewriteTerminators<YieldOp>(region, [&](YieldOp y) {
      rw.setInsertionPoint(y);
      rw.replaceOpWithNewOp<cf::BranchOp>(y, cont, y.getValues());
    });
    entries.push_back(entry);
    rw.inlineRegionBefore(region, cont);
  }
  Block *dflt;
  if (op.getHasDefault()) {
    dflt = entries.back();
    entries.pop_back();
  } else {
    dflt = rw.createBlock(cont);
    UnreachableOp::create(rw, loc);
  }
  SmallVector<APInt> values;
  for (int64_t c : op.getCases())
    values.push_back(APInt(width, c, /*isSigned=*/true, /*implicitTrunc=*/true));
  SmallVector<ValueRange> noArgs(entries.size(), ValueRange{});
  rw.setInsertionPointToEnd(cur);
  cf::SwitchOp::create(rw, loc, key, dflt, ValueRange{}, values, entries, noArgs);
  rw.replaceOp(op, cont->getArguments());
}

//===----------------------------------------------------------------------===//
// milo-raise-to-scf
//===----------------------------------------------------------------------===//

Value castTo(OpBuilder &b, Location loc, Type t, Value v) {
  return UnrealizedConversionCastOp::create(b, loc, TypeRange{t}, ValueRange{v}).getResult(0);
}

// A milo.for scf.for can express: a signed induction variable (scf.for compares signed),
// and nothing inside that leaves the loop early or loops without bounds.
bool raisable(ForOp f) {
  auto iv = dyn_cast<IntegerType>(f.getStart().getType());
  if (!iv || !iv.isSigned())
    return false;
  WalkResult r = f.getBodyRegion().walk([](Operation *op) {
    if (isa<BreakOp, ContinueOp, ReturnOp, UnreachableOp, WhileOp, LoopOp, ForOp, MatchOp>(op))
      return WalkResult::interrupt();
    for (Region &reg : op->getRegions())
      if (!reg.hasOneBlock() && !reg.empty())
        return WalkResult::interrupt();
    return WalkResult::advance();
  });
  return !r.wasInterrupted() && f.getBodyRegion().hasOneBlock();
}

// Moves `from`'s ops into `to` before its terminator; `from`'s milo.yield becomes scf.yield.
void moveBody(OpBuilder &b, Block &from, Block *to) {
  auto y = cast<YieldOp>(from.getTerminator());
  Operation *term = to->empty() ? nullptr : &to->back();
  bool hasTerm = term && term->hasTrait<OpTrait::IsTerminator>();
  to->getOperations().splice(hasTerm ? Block::iterator(term) : to->end(), from.getOperations(),
                             from.begin(), Block::iterator(y));
  if (hasTerm && y.getValues().empty())
    return;
  if (hasTerm)
    term->erase();
  b.setInsertionPointToEnd(to);
  scf::YieldOp::create(b, y.getLoc(), y.getValues());
}

void raiseIf(OpBuilder &b, IfOp op) {
  b.setInsertionPoint(op);
  bool hasElse = !op.getElseRegion().empty();
  auto s = scf::IfOp::create(b, op.getLoc(), op.getResultTypes(), op.getCondition(), hasElse);
  moveBody(b, op.getThenRegion().front(), s.thenBlock());
  if (hasElse)
    moveBody(b, op.getElseRegion().front(), s.elseBlock());
  op.replaceAllUsesWith(s.getResults());
  op.erase();
}

void raiseFor(OpBuilder &b, ForOp f) {
  Location loc = f.getLoc();
  b.setInsertionPoint(f);
  Type t = f.getStart().getType();
  Type sl = b.getIntegerType(cast<IntegerType>(t).getWidth());
  Value lb = castTo(b, loc, sl, f.getStart()), ub = castTo(b, loc, sl, f.getEnd());
  Value one = arith::ConstantOp::create(b, loc, b.getIntegerAttr(sl, 1));
  auto s = scf::ForOp::create(b, loc, lb, ub, one);
  Block &body = f.getBodyRegion().front();
  b.setInsertionPointToStart(s.getBody());
  body.getArgument(0).replaceAllUsesWith(castTo(b, loc, t, s.getInductionVar()));
  moveBody(b, body, s.getBody());
  f.erase();
}

// Loops whose shape scf.for captures go to scf, where the Vec passes (hoisting `len`,
// versioning bounds checks) and upstream loop passes work; ifs inside them become scf.if.
// Everything else stays for milo-lower-structured-cf.
struct RaiseToScfPass : PassWrapper<RaiseToScfPass, OperationPass<func::FuncOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(RaiseToScfPass)
  StringRef getArgument() const final { return "milo-raise-to-scf"; }
  StringRef getDescription() const final {
    return "Raise milo.for loops without early exits (and their ifs) to scf";
  }
  void getDependentDialects(DialectRegistry &r) const override {
    r.insert<scf::SCFDialect, arith::ArithDialect>();
  }
  void runOnOperation() override {
    SmallVector<ForOp> fors;
    getOperation().walk<WalkOrder::PostOrder>([&](ForOp f) { fors.push_back(f); });
    OpBuilder b(&getContext());
    for (ForOp f : fors) {
      if (!raisable(f))
        continue;
      SmallVector<IfOp> ifs;
      f.getBodyRegion().walk<WalkOrder::PostOrder>([&](IfOp i) { ifs.push_back(i); });
      for (IfOp i : ifs)
        raiseIf(b, i);
      raiseFor(b, f);
    }
  }
};

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
      if (isa<IfOp, WhileOp, LoopOp, ForOp, MatchOp>(op))
        ops.push_back(op);
    });
    IRRewriter rw(&getContext());
    for (Operation *op : ops) {
      if (auto i = dyn_cast<IfOp>(op))
        lowerIf(rw, i);
      else if (auto w = dyn_cast<WhileOp>(op))
        lowerWhile(rw, w);
      else if (auto m = dyn_cast<MatchOp>(op))
        lowerMatch(rw, m);
      else if (auto f = dyn_cast<ForOp>(op))
        lowerFor(rw, f);
      else
        lowerLoop(rw, cast<LoopOp>(op));
    }
    // Code after a loop only `return` leaves is dead, and its block now has no
    // predecessor. Dialect conversion leaves such blocks unconverted, so they go here.
    (void)eraseUnreachableBlocks(rw, getOperation()->getRegions());
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
} // namespace

Value milo::globalString(OpBuilder &rw, Location loc, ModuleOp module, StringRef s) {
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

namespace {

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
    LLVM::CallOp::create(rw, loc, *fn, ValueRange{globalString(rw, loc, module, msg)});
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
    Value file = globalString(rw, loc, module, pos->file);
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
    if (isa<PtrType>(from)) {
      if (!isa<IntegerType>(toLL))
        return rw.notifyMatchFailure(op, "pointer to a non-integer");
      rw.replaceOpWithNewOp<LLVM::PtrToIntOp>(op, toLL, x);
      return success();
    }
    if (isa<PtrType>(to)) {
      // Pointers are 64-bit; inttoptr from a narrower int crashes AArch64 instruction
      // selection, so legacy codegen widens first, by the source's signedness.
      auto fromI = dyn_cast<IntegerType>(x.getType());
      if (!fromI)
        return rw.notifyMatchFailure(op, "a non-integer to a pointer");
      Value wide = x;
      if (fromI.getWidth() < 64) {
        Type i64 = rw.getI64Type();
        bool sext = cast<IntegerType>(from).isSigned();
        wide = sext ? LLVM::SExtOp::create(rw, loc, i64, x).getResult()
                    : LLVM::ZExtOp::create(rw, loc, i64, x).getResult();
      }
      rw.replaceOpWithNewOp<LLVM::IntToPtrOp>(op, toLL, wide);
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

// The address of a global the legacy module defines (the recorder's, a Milo module global).
// Declared external here with a placeholder type: with opaque pointers only the accesses
// carry types, and the splice drops the declaration for a name the module already has.
Value replayGlobal(ConversionPatternRewriter &rw, Operation *op, StringRef name, bool threadLocal = false) {
  auto module = op->getParentOfType<ModuleOp>();
  auto g = module.lookupSymbol<LLVM::GlobalOp>(name);
  if (!g) {
    OpBuilder::InsertionGuard guard(rw);
    rw.setInsertionPointToStart(module.getBody());
    g = LLVM::GlobalOp::create(rw, op->getLoc(), rw.getI64Type(), /*isConstant=*/false,
                               LLVM::Linkage::External, name, Attribute(), /*alignment=*/0,
                               /*addrSpace=*/0, /*dsoLocal=*/false, threadLocal);
  }
  return LLVM::AddressOfOp::create(rw, op->getLoc(), g);
}

// The shape of legacy codegen's replayEngineScope: depth += 1 at entry when the heap
// switch is on; depth -= 1 before a return when it is on and the depth is positive.
template <typename OpT, bool Enter>
struct ReplayLowering : ConvertOpToLLVMPattern<OpT> {
  using ConvertOpToLLVMPattern<OpT>::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(OpT op, typename OpT::Adaptor,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Type i64 = rw.getI64Type();
    Value on = LLVM::LoadOp::create(rw, loc, i64, replayGlobal(rw, op, "replay$rrHeapOn"));
    Value zero = constInt(rw, loc, i64, 0);
    Value cond = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::ne, on, zero);
    Value depthPtr = replayGlobal(rw, op, "replay$rrDepth");
    Value depth;
    if (!Enter) {
      depth = LLVM::LoadOp::create(rw, loc, i64, depthPtr);
      Value pos = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::sgt, depth, zero);
      cond = LLVM::AndOp::create(rw, loc, cond, pos);
    }
    Block *cur = rw.getInsertionBlock();
    Block *cont = rw.splitBlock(cur, rw.getInsertionPoint());
    Block *adjust = rw.createBlock(cont);
    if (Enter)
      depth = LLVM::LoadOp::create(rw, loc, i64, depthPtr);
    Value next = Enter ? LLVM::AddOp::create(rw, loc, depth, constInt(rw, loc, i64, 1)).getResult()
                       : LLVM::SubOp::create(rw, loc, depth, constInt(rw, loc, i64, 1)).getResult();
    LLVM::StoreOp::create(rw, loc, next, depthPtr);
    LLVM::BrOp::create(rw, loc, ValueRange{}, cont);
    rw.setInsertionPointToEnd(cur);
    LLVM::CondBrOp::create(rw, loc, cond, adjust, cont);
    rw.eraseOp(op);
    return success();
  }
};

// The env: { ptr drop header (null: a frame's env owns nothing), ptr capture... } in an
// entry-block slot, or a malloc'd block whose header is `free` (`heap`); the value:
// { ptr @fn, ptr env }, with a null env when nothing is captured, as legacy genClosure
// builds both.
struct ClosureLowering : ConvertOpToLLVMPattern<ClosureOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ClosureOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Value env;
    if (a.getCaptures().empty()) {
      env = LLVM::ZeroOp::create(rw, loc, ptrTy);
    } else {
      SmallVector<Type> fields(a.getCaptures().size() + 1, ptrTy);
      auto envTy = LLVM::LLVMStructType::getLiteral(rw.getContext(), fields);
      Value header;
      if (op.getHeap()) {
        // As legacy sizes it: at least 16 bytes. The header frees the block and nothing
        // else, which is all legacy's envdrop for a by-reference env does.
        auto module = op->getParentOfType<ModuleOp>();
        auto malloc = LLVM::lookupOrCreateFn(rw, module, "malloc", {rw.getI64Type()}, ptrTy);
        auto free = LLVM::lookupOrCreateFn(rw, module, "free", {ptrTy}, LLVM::LLVMVoidType::get(rw.getContext()));
        if (failed(malloc) || failed(free))
          return failure();
        Value size = constInt(rw, loc, rw.getI64Type(), std::max<int64_t>(8 * fields.size(), 16));
        env = LLVM::CallOp::create(rw, loc, *malloc, ValueRange{size}).getResult();
        header = LLVM::AddressOfOp::create(rw, loc, ptrTy, "free");
      } else if (op.getStaticEnv()) {
        // A zeroed internal global per closure body, as legacy's `@<fn>_env`.
        auto module = op->getParentOfType<ModuleOp>();
        std::string name = (op.getFn() + "_env").str();
        if (!module.lookupSymbol(name)) {
          OpBuilder::InsertionGuard guard(rw);
          rw.setInsertionPointToStart(module.getBody());
          auto g = LLVM::GlobalOp::create(rw, loc, envTy, /*isConstant=*/false, LLVM::Linkage::Internal, name, Attribute());
          Block *init = rw.createBlock(&g.getInitializerRegion());
          rw.setInsertionPointToStart(init);
          LLVM::ReturnOp::create(rw, loc, LLVM::ZeroOp::create(rw, loc, envTy).getResult());
        }
        env = LLVM::AddressOfOp::create(rw, loc, ptrTy, name);
        header = LLVM::ZeroOp::create(rw, loc, ptrTy);
      } else {
        env = entrySlot(rw, op, envTy);
        header = LLVM::ZeroOp::create(rw, loc, ptrTy);
      }
      auto field = [&](int32_t i) {
        return LLVM::GEPOp::create(rw, loc, ptrTy, envTy, env, ArrayRef<LLVM::GEPArg>{0, i});
      };
      LLVM::StoreOp::create(rw, loc, header, field(0));
      for (auto [i, c] : llvm::enumerate(a.getCaptures()))
        LLVM::StoreOp::create(rw, loc, c, field(i + 1));
    }
    Type pairTy = getTypeConverter()->convertType(op.getType());
    Value fn = LLVM::AddressOfOp::create(rw, loc, ptrTy, op.getFn());
    Value pair = LLVM::UndefOp::create(rw, loc, pairTy);
    pair = LLVM::InsertValueOp::create(rw, loc, pair, fn, ArrayRef<int64_t>{0});
    pair = LLVM::InsertValueOp::create(rw, loc, pair, env, ArrayRef<int64_t>{1});
    rw.replaceOp(op, pair);
    return success();
  }
};

struct EnvCaptureLowering : ConvertOpToLLVMPattern<EnvCaptureOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnvCaptureOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Value at = LLVM::GEPOp::create(rw, loc, ptrTy, ptrTy, a.getEnv(),
                                   ArrayRef<LLVM::GEPArg>{(int32_t)op.getIndex() + 1});
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, ptrTy, at);
    return success();
  }
};

// Both are { ptr fn, ptr env }: nothing to do.
struct FnCastLowering : ConvertOpToLLVMPattern<FnCastOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(FnCastOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getValue());
    return success();
  }
};

struct ClosureCallLowering : ConvertOpToLLVMPattern<ClosureCallOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ClosureCallOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Value fn = LLVM::ExtractValueOp::create(rw, loc, a.getCallee(), ArrayRef<int64_t>{0});
    Value env = LLVM::ExtractValueOp::create(rw, loc, a.getCallee(), ArrayRef<int64_t>{1});
    SmallVector<Value> args{fn, env};
    SmallVector<Type> argTys{ptrTy};
    for (Value v : a.getArgs()) {
      args.push_back(v);
      argTys.push_back(v.getType());
    }
    Type ret = op.getResult() ? getTypeConverter()->convertType(op.getResult().getType())
                              : LLVM::LLVMVoidType::get(rw.getContext());
    auto fty = LLVM::LLVMFunctionType::get(ret, argTys);
    auto call = LLVM::CallOp::create(rw, loc, fty, args);
    if (op.getResult())
      rw.replaceOp(op, call.getResult());
    else
      rw.eraseOp(op);
    return success();
  }
};

struct GlobalLowering : ConvertOpToLLVMPattern<GlobalOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(GlobalOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, replayGlobal(rw, op, op.getName(), op.getTls()));
    return success();
  }
};

struct GlobalInitLowering : ConvertOpToLLVMPattern<GlobalInitOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(GlobalInitOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    auto module = op->getParentOfType<ModuleOp>();
    auto fn = LLVM::lookupOrCreateFn(rw, module, ("__milo.lazy." + op.getName()).str(), {},
                                     LLVM::LLVMVoidType::get(rw.getContext()));
    if (failed(fn))
      return failure();
    LLVM::CallOp::create(rw, op.getLoc(), *fn, ValueRange{});
    rw.eraseOp(op);
    return success();
  }
};

struct PtrLoadLowering : ConvertOpToLLVMPattern<PtrLoadOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(PtrLoadOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type t = getTypeConverter()->convertType(op.getType());
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, t, a.getPtr());
    return success();
  }
};

struct PtrStoreLowering : ConvertOpToLLVMPattern<PtrStoreOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(PtrStoreOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::StoreOp>(op, a.getValue(), a.getPtr());
    return success();
  }
};

struct StringDataLowering : ConvertOpToLLVMPattern<StringDataOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringDataOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::ExtractValueOp>(op, a.getValue(), ArrayRef<int64_t>{0});
    return success();
  }
};

struct ZeroLowering : ConvertOpToLLVMPattern<ZeroOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ZeroOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::ZeroOp>(op, getTypeConverter()->convertType(op.getType()));
    return success();
  }
};

struct ArrayElemRefLowering : ConvertOpToLLVMPattern<ArrayElemRefOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ArrayElemRefOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type at = getTypeConverter()->convertType(op.getArray().getType().getPointee());
    rw.replaceOpWithNewOp<LLVM::GEPOp>(op, LLVM::LLVMPointerType::get(rw.getContext()), at,
                                       a.getArray(), ArrayRef<LLVM::GEPArg>{0, a.getIndex()});
    return success();
  }
};

// malloc(sizeof T) and the value stored in it, as legacy's HeapCreate (no null check there
// either).
struct HeapNewLowering : ConvertOpToLLVMPattern<HeapNewOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(HeapNewOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    auto module = op->getParentOfType<ModuleOp>();
    auto fn = LLVM::lookupOrCreateFn(rw, module, "malloc", {rw.getI64Type()}, ptrTy);
    if (failed(fn))
      return failure();
    Value size = getSizeInBytes(op.getLoc(), op.getValue().getType(), rw);
    Value box = LLVM::CallOp::create(rw, op.getLoc(), *fn, ValueRange{size}).getResult();
    LLVM::StoreOp::create(rw, op.getLoc(), a.getValue(), box);
    rw.replaceOp(op, box);
    return success();
  }
};

struct HeapFreeLowering : ConvertOpToLLVMPattern<HeapFreeOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(HeapFreeOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    auto module = op->getParentOfType<ModuleOp>();
    auto fn = LLVM::lookupOrCreateFn(rw, module, "free", {ptrTy}, LLVM::LLVMVoidType::get(rw.getContext()));
    if (failed(fn))
      return failure();
    rw.replaceOpWithNewOp<LLVM::CallOp>(op, *fn, ValueRange{a.getHeap()});
    return success();
  }
};

struct HeapPlaceLowering : ConvertOpToLLVMPattern<HeapPlaceOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(HeapPlaceOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getHeap());
    return success();
  }
};

struct CopyLowering : ConvertOpToLLVMPattern<CopyOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(CopyOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    // llvm.memcpy allows a source equal to its destination, but there is nothing to copy.
    if (a.getSrc() == a.getDst()) {
      rw.eraseOp(op);
      return success();
    }
    Value size = getSizeInBytes(op.getLoc(), op.getElem(), rw);
    rw.replaceOpWithNewOp<LLVM::MemcpyOp>(op, a.getDst(), a.getSrc(), size, /*isVolatile=*/false);
    return success();
  }
};

struct StringByteLowering : ConvertOpToLLVMPattern<StringByteOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringByteOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto pos = srcPos(op);
    if (failed(pos))
      return failure();
    Location loc = op.getLoc();
    auto module = op->getParentOfType<ModuleOp>();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    Type i64 = rw.getI64Type();
    auto fn = LLVM::lookupOrCreateFn(rw, module, "__milo_bounds_fail", {i64, i64, ptrTy, rw.getI32Type()},
                                     LLVM::LLVMVoidType::get(rw.getContext()));
    if (failed(fn))
      return failure();
    Value len = LLVM::ExtractValueOp::create(rw, loc, a.getValue(), ArrayRef<int64_t>{1});
    Value oob = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::uge, a.getIndex(), len);
    branchToPanic(rw, loc, oob, [&] {
      Value file = globalString(rw, loc, module, pos->file);
      Value line = constInt(rw, loc, rw.getI32Type(), pos->line);
      LLVM::CallOp::create(rw, loc, *fn, ValueRange{a.getIndex(), len, file, line});
    });
    Value data = LLVM::ExtractValueOp::create(rw, loc, a.getValue(), ArrayRef<int64_t>{0});
    Value p = LLVM::GEPOp::create(rw, loc, ptrTy, rw.getI8Type(), data, ValueRange{a.getIndex()});
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, rw.getI8Type(), p);
    return success();
  }
};

struct PtrElemLowering : ConvertOpToLLVMPattern<PtrElemOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(PtrElemOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type elem = getTypeConverter()->convertType(op.getElem());
    rw.replaceOpWithNewOp<LLVM::GEPOp>(op, LLVM::LLVMPointerType::get(rw.getContext()), elem,
                                       a.getPtr(), ValueRange{a.getIndex()});
    return success();
  }
};

struct PtrFieldLowering : ConvertOpToLLVMPattern<PtrFieldOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(PtrFieldOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type st = getTypeConverter()->convertType(op.getRecord());
    rw.replaceOpWithNewOp<LLVM::GEPOp>(op, LLVM::LLVMPointerType::get(rw.getContext()), st,
                                       a.getPtr(), ArrayRef<LLVM::GEPArg>{0, (int32_t)op.getIndex()});
    return success();
  }
};

struct AddrLowering : ConvertOpToLLVMPattern<AddrOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(AddrOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getPlace());
    return success();
  }
};

struct PtrLendLowering : ConvertOpToLLVMPattern<PtrLendOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(PtrLendOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOp(op, a.getPtr());
    return success();
  }
};

struct VecDataLowering : ConvertOpToLLVMPattern<VecDataOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(VecDataOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, ptrTy, a.getVec());
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

// `idx < len` (unsigned, so a negative index fails too), else legacy's out-of-line
// `__milo_bounds_fail(idx, len, file, line)`: one cold call on the failing edge.
struct ContractCheckLowering : ConvertOpToLLVMPattern<ContractCheckOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(ContractCheckOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    auto pos = srcPos(op);
    if (failed(pos))
      return failure();
    Location loc = op.getLoc();
    auto module = op->getParentOfType<ModuleOp>();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    auto fn = LLVM::lookupOrCreateFn(rw, module, "__milo_contract_fail", {ptrTy, ptrTy, rw.getI32Type()},
                                     LLVM::LLVMVoidType::get(rw.getContext()));
    if (failed(fn))
      return failure();
    Value bad = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, a.getCond(), constInt(rw, loc, rw.getI1Type(), 0));
    branchToPanic(rw, loc, bad, [&] {
      Value kind = globalString(rw, loc, module, op.getKind().str());
      Value file = globalString(rw, loc, module, pos->file);
      Value line = constInt(rw, loc, rw.getI32Type(), pos->line);
      LLVM::CallOp::create(rw, loc, *fn, ValueRange{kind, file, line});
    });
    rw.eraseOp(op);
    return success();
  }
};

template <typename SOv, typename UOv>
Value overflowFlag(ConversionPatternRewriter &rw, Location loc, bool isUnsigned, Value l, Value r) {
  Type t = l.getType();
  auto pairTy = LLVM::LLVMStructType::getLiteral(rw.getContext(), {t, rw.getI1Type()});
  Value pair = isUnsigned ? UOv::create(rw, loc, pairTy, l, r).getResult()
                          : SOv::create(rw, loc, pairTy, l, r).getResult();
  return LLVM::ExtractValueOp::create(rw, loc, pair, ArrayRef<int64_t>{1});
}

struct OverflowsLowering : ConvertOpToLLVMPattern<OverflowsOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(OverflowsOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    bool u = isUnsignedInt(op.getLhs().getType());
    Value l = a.getLhs(), r = a.getRhs();
    StringRef k = op.getKind();
    Value bad;
    if (k == "add")
      bad = overflowFlag<LLVM::SAddWithOverflowOp, LLVM::UAddWithOverflowOp>(rw, loc, u, l, r);
    else if (k == "sub")
      bad = overflowFlag<LLVM::SSubWithOverflowOp, LLVM::USubWithOverflowOp>(rw, loc, u, l, r);
    else if (k == "mul")
      bad = overflowFlag<LLVM::SMulWithOverflowOp, LLVM::UMulWithOverflowOp>(rw, loc, u, l, r);
    else {
      Type t = l.getType();
      unsigned w = cast<IntegerType>(t).getWidth();
      bad = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, r, constInt(rw, loc, t, 0));
      if (!u) {
        Value isMin = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, l,
                                           constInt(rw, loc, t, APInt::getSignedMinValue(w)));
        Value isNeg1 = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, r, constInt(rw, loc, t, -1));
        bad = LLVM::OrOp::create(rw, loc, bad, LLVM::AndOp::create(rw, loc, isMin, isNeg1));
      }
    }
    rw.replaceOp(op, bad);
    return success();
  }
};

// add and sub are LLVM's .sat intrinsics; there is no mul one, so mul clamps on the
// overflow flag, toward MIN when exactly one operand is negative (the product's sign).
struct SaturatingLowering : ConvertOpToLLVMPattern<SaturatingOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(SaturatingOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    bool u = isUnsignedInt(op.getType());
    Value l = a.getLhs(), r = a.getRhs();
    StringRef k = op.getKind();
    if (k == "add") {
      rw.replaceOp(op, u ? LLVM::UAddSat::create(rw, loc, l, r).getResult() : LLVM::SAddSat::create(rw, loc, l, r).getResult());
      return success();
    }
    if (k == "sub") {
      rw.replaceOp(op, u ? LLVM::USubSat::create(rw, loc, l, r).getResult() : LLVM::SSubSat::create(rw, loc, l, r).getResult());
      return success();
    }
    Type t = l.getType();
    unsigned w = cast<IntegerType>(t).getWidth();
    auto pairTy = LLVM::LLVMStructType::getLiteral(rw.getContext(), {t, rw.getI1Type()});
    Value pair = u ? LLVM::UMulWithOverflowOp::create(rw, loc, pairTy, l, r).getResult()
                   : LLVM::SMulWithOverflowOp::create(rw, loc, pairTy, l, r).getResult();
    Value prod = LLVM::ExtractValueOp::create(rw, loc, pair, ArrayRef<int64_t>{0});
    Value ov = LLVM::ExtractValueOp::create(rw, loc, pair, ArrayRef<int64_t>{1});
    Value clamp;
    if (u) {
      clamp = constInt(rw, loc, t, APInt::getMaxValue(w));
    } else {
      Value zero = constInt(rw, loc, t, 0);
      Value lNeg = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::slt, l, zero);
      Value rNeg = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::slt, r, zero);
      Value neg = LLVM::XOrOp::create(rw, loc, lNeg, rNeg);
      clamp = LLVM::SelectOp::create(rw, loc, neg, constInt(rw, loc, t, APInt::getSignedMinValue(w)),
                                     constInt(rw, loc, t, APInt::getSignedMaxValue(w)));
    }
    rw.replaceOp(op, LLVM::SelectOp::create(rw, loc, ov, clamp, prod));
    return success();
  }
};

struct CCallLowering : ConvertOpToLLVMPattern<CCallOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(CCallOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    SmallVector<Type> fixed;
    for (Value v : a.getArgs().take_front(op.getFixed()))
      fixed.push_back(v.getType());
    Type ret = op.getResult() ? getTypeConverter()->convertType(op.getResult().getType()) : LLVM::LLVMVoidType::get(rw.getContext());
    auto module = op->getParentOfType<ModuleOp>();
    auto fn = LLVM::lookupOrCreateFn(rw, module, op.getCallee(), fixed, ret, /*isVarArg=*/true);
    if (failed(fn))
      return failure();
    auto call = LLVM::CallOp::create(rw, op.getLoc(), *fn, a.getArgs());
    if (op.getResult())
      rw.replaceOp(op, call.getResult());
    else
      rw.eraseOp(op);
    return success();
  }
};

struct CallPtrLowering : ConvertOpToLLVMPattern<CallPtrOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(CallPtrOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    SmallVector<Type> params;
    for (Value v : a.getArgs())
      params.push_back(v.getType());
    Type ret = op.getResult() ? getTypeConverter()->convertType(op.getResult().getType()) : LLVM::LLVMVoidType::get(rw.getContext());
    auto fty = LLVM::LLVMFunctionType::get(ret, params);
    SmallVector<Value> ops{a.getCallee()};
    ops.append(a.getArgs().begin(), a.getArgs().end());
    auto call = LLVM::CallOp::create(rw, op.getLoc(), fty, ops);
    if (op.getResult())
      rw.replaceOp(op, call.getResult());
    else
      rw.eraseOp(op);
    return success();
  }
};

// Declared as an external byte when nothing in this module names it yet: the splice keeps
// the defining module's own global (src/mlir-backend.ts).
struct GlobalAddrLowering : ConvertOpToLLVMPattern<GlobalAddrOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(GlobalAddrOp op, OpAdaptor, ConversionPatternRewriter &rw) const override {
    auto module = op->getParentOfType<ModuleOp>();
    StringRef name = op.getName();
    if (!module.lookupSymbol(name)) {
      OpBuilder::InsertionGuard g(rw);
      rw.setInsertionPointToStart(module.getBody());
      LLVM::GlobalOp::create(rw, op.getLoc(), rw.getI8Type(), /*isConstant=*/false, LLVM::Linkage::External, name, Attribute());
    }
    rw.replaceOpWithNewOp<LLVM::AddressOfOp>(op, LLVM::LLVMPointerType::get(rw.getContext()), name);
    return success();
  }
};

struct FnAddrLowering : ConvertOpToLLVMPattern<FnAddrOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(FnAddrOp op, OpAdaptor, ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::AddressOfOp>(op, LLVM::LLVMPointerType::get(rw.getContext()), op.getFn());
    return success();
  }
};

struct BitsLowering : ConvertOpToLLVMPattern<BitsOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(BitsOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value v = a.getValue();
    Type t = v.getType();
    StringRef k = op.getKind();
    Value r;
    if (k == "ctpop")
      r = LLVM::CtPopOp::create(rw, loc, t, v);
    else if (k == "ctlz")
      r = LLVM::CountLeadingZerosOp::create(rw, loc, t, v, false);
    else if (k == "cttz")
      r = LLVM::CountTrailingZerosOp::create(rw, loc, t, v, false);
    else if (k == "bitreverse")
      r = LLVM::BitReverseOp::create(rw, loc, t, v);
    else if (k == "fshl")
      r = LLVM::FshlOp::create(rw, loc, t, v, v, a.getAmount());
    else
      r = LLVM::FshrOp::create(rw, loc, t, v, v, a.getAmount());
    if ((k == "ctpop" || k == "ctlz" || k == "cttz") && cast<IntegerType>(t).getWidth() < 64)
      r = LLVM::ZExtOp::create(rw, loc, rw.getI64Type(), r);
    rw.replaceOp(op, r);
    return success();
  }
};

// The message as the format of the module's `__milo_mlir_panic(fmt)`, or with values
// `__milo_mlir_panic_v3(fmt, a, b, c)` (unused slots 0: printf reads only what the
// format names), on the failing edge only.
struct PanicIfLowering : ConvertOpToLLVMPattern<PanicIfOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(PanicIfOp op, OpAdaptor a, ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto module = op->getParentOfType<ModuleOp>();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    bool withValue = !a.getValues().empty();
    SmallVector<Type> params{ptrTy};
    if (withValue)
      params.append(3, rw.getI64Type());
    auto fn = LLVM::lookupOrCreateFn(rw, module, withValue ? "__milo_mlir_panic_v3" : kPanic, params,
                                     LLVM::LLVMVoidType::get(rw.getContext()));
    if (failed(fn))
      return failure();
    branchToPanic(rw, loc, a.getBad(), [&] {
      SmallVector<Value> args{globalString(rw, loc, module, op.getMessage())};
      if (withValue) {
        args.append(a.getValues().begin(), a.getValues().end());
        while (args.size() < 4)
          args.push_back(constInt(rw, loc, rw.getI64Type(), 0));
      }
      LLVM::CallOp::create(rw, loc, *fn, args);
    });
    rw.eraseOp(op);
    return success();
  }
};

struct BoundsCheckLowering : ConvertOpToLLVMPattern<BoundsCheckOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(BoundsCheckOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto pos = srcPos(op);
    if (failed(pos))
      return failure();
    Location loc = op.getLoc();
    auto module = op->getParentOfType<ModuleOp>();
    auto ptrTy = LLVM::LLVMPointerType::get(rw.getContext());
    auto fn = LLVM::lookupOrCreateFn(rw, module, "__milo_bounds_fail",
                                     {rw.getI64Type(), rw.getI64Type(), ptrTy, rw.getI32Type()},
                                     LLVM::LLVMVoidType::get(rw.getContext()));
    if (failed(fn))
      return failure();
    Value oob = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::uge, a.getIndex(), a.getLen());
    branchToPanic(rw, loc, oob, [&] {
      Value file = globalString(rw, loc, module, pos->file);
      Value line = constInt(rw, loc, rw.getI32Type(), pos->line);
      LLVM::CallOp::create(rw, loc, *fn, ValueRange{a.getIndex(), a.getLen(), file, line});
    });
    rw.eraseOp(op);
    return success();
  }
};

// milo-expand-index: `v[i]`, `v[i] = x` and `v.len()` become the Vec-level ops (vec.len,
// bounds_check, vec.load/store, on a signless i64) that the hoisting and versioning
// passes work on. The check takes the access's location, so its panic names `v[i]`.
struct ExpandIndexPass : PassWrapper<ExpandIndexPass, OperationPass<ModuleOp>> {
  MLIR_DEFINE_EXPLICIT_INTERNAL_INLINE_TYPE_ID(ExpandIndexPass)
  StringRef getArgument() const final { return "milo-expand-index"; }
  StringRef getDescription() const final {
    return "Lower source-level Vec indexing to len, bounds_check and vec.load/store";
  }
  void runOnOperation() override {
    SmallVector<Operation *> ops;
    getOperation().walk([&](Operation *op) {
      if (isa<IndexOp, IndexStoreOp, IndexRefOp, ArrayIndexOp, LenOp>(op))
        ops.push_back(op);
    });
    for (Operation *op : ops) {
      OpBuilder b(op);
      Location loc = op->getLoc();
      Type i64 = b.getI64Type();
      auto signless = [&](Value v) {
        return UnrealizedConversionCastOp::create(b, loc, TypeRange{i64}, ValueRange{v}).getResult(0);
      };
      auto checked = [&](Value vec, Value index) {
        Value j = signless(index);
        Value len = VecLenOp::create(b, loc, i64, vec);
        BoundsCheckOp::create(b, loc, j, len);
        return j;
      };
      if (auto ix = dyn_cast<IndexOp>(op)) {
        Value j = checked(ix.getVec(), ix.getIndex());
        ix.replaceAllUsesWith(VecLoadOp::create(b, loc, ix.getType(), ix.getVec(), j).getResult());
      } else if (auto st = dyn_cast<IndexStoreOp>(op)) {
        Value j = checked(st.getVec(), st.getIndex());
        VecStoreOp::create(b, loc, st.getValue(), st.getVec(), j);
      } else if (auto r = dyn_cast<IndexRefOp>(op)) {
        Value j = checked(r.getVec(), r.getIndex());
        r.replaceAllUsesWith(VecElemRefOp::create(b, loc, r.getType(), r.getVec(), j).getResult());
      } else if (auto a = dyn_cast<ArrayIndexOp>(op)) {
        Value j = signless(a.getIndex());
        auto at = cast<ArrayType>(a.getArray().getType().getPointee());
        Value n = arith::ConstantOp::create(b, loc, b.getI64IntegerAttr(at.getSize()));
        BoundsCheckOp::create(b, loc, j, n);
        a.replaceAllUsesWith(ArrayElemRefOp::create(b, loc, a.getType(), a.getArray(), j).getResult());
      } else {
        auto len = cast<LenOp>(op);
        Value l = VecLenOp::create(b, loc, i64, len.getVec());
        Type si64 = len.getType();
        len.replaceAllUsesWith(
            UnrealizedConversionCastOp::create(b, loc, TypeRange{si64}, ValueRange{l}).getResult(0));
      }
      op->erase();
    }
  }
};

// legacy's `%String`, by name: the spliced body then uses the module's own definition.
LLVM::LLVMStructType stringStruct(MLIRContext *ctx) {
  auto s = LLVM::LLVMStructType::getIdentified(ctx, "String");
  if (!s.isInitialized()) {
    Type i64 = IntegerType::get(ctx, 64);
    (void)s.setBody({LLVM::LLVMPointerType::get(ctx), i64, i64}, /*isPacked=*/false);
  }
  return s;
}

struct StringLitLowering : ConvertOpToLLVMPattern<StringLitOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StringLitOp op, OpAdaptor,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    auto module = op->getParentOfType<ModuleOp>();
    StringRef text = op.getValue();
    Type i64 = rw.getI64Type();
    Value s = LLVM::UndefOp::create(rw, loc, stringStruct(rw.getContext()));
    s = LLVM::InsertValueOp::create(rw, loc, s, globalString(rw, loc, module, text), ArrayRef<int64_t>{0});
    s = LLVM::InsertValueOp::create(rw, loc, s, constInt(rw, loc, i64, (int64_t)text.size()), ArrayRef<int64_t>{1});
    s = LLVM::InsertValueOp::create(rw, loc, s, constInt(rw, loc, i64, 0), ArrayRef<int64_t>{2});
    rw.replaceOp(op, s);
    return success();
  }
};


Value byteOffset(ConversionPatternRewriter &rw, Location loc, Value base, int64_t off) {
  if (off == 0)
    return base;
  return LLVM::GEPOp::create(rw, loc, LLVM::LLVMPointerType::get(rw.getContext()),
                             rw.getI8Type(), base, ArrayRef<LLVM::GEPArg>{off},
                             LLVM::GEPNoWrapFlags::inbounds);
}

// A niche enum's tag, from the integer at offset 0 of its place (legacy loadEnumTag).
Value nicheTagAt(ConversionPatternRewriter &rw, Location loc, EnumType e, Value at) {
  Type it = rw.getIntegerType(e.getNicheBits());
  Value raw = LLVM::LoadOp::create(rw, loc, it, at);
  Value none = LLVM::ICmpOp::create(rw, loc, LLVM::ICmpPredicate::eq, raw,
                                    constInt(rw, loc, it, e.getNicheValue()));
  return LLVM::SelectOp::create(rw, loc, none, constInt(rw, loc, rw.getI32Type(), e.getNoneTag()),
                                constInt(rw, loc, rw.getI32Type(), e.getSomeTag()));
}

// Write variant `tag` of the enum at `at`. A niche enum's payload variant has no tag to
// write: its payload store is the whole value.
void storeTag(ConversionPatternRewriter &rw, Location loc, EnumType e, Value at, int32_t tag) {
  if (!e.getNicheBits()) {
    LLVM::StoreOp::create(rw, loc, constInt(rw, loc, rw.getI32Type(), tag), at);
    return;
  }
  if (tag == e.getNoneTag())
    LLVM::StoreOp::create(rw, loc,
                          constInt(rw, loc, rw.getIntegerType(e.getNicheBits()), e.getNicheValue()), at);
}

// An enum goes through memory, as in legacy codegen (enumFieldPtr): its storage array has
// no per-variant shape, so the tag and each payload field are read and written at their
// byte offsets; SROA folds the slot away.
struct EnumNewLowering : ConvertOpToLLVMPattern<EnumNewOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnumNewOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    EnumType e = op.getType();
    Type et = getTypeConverter()->convertType(e);
    Value slot = entrySlot(rw, op, et);
    storeTag(rw, loc, e, slot, op.getTag());
    unsigned v = e.variantOf(op.getTag());
    for (auto [k, f] : llvm::enumerate(a.getFields()))
      LLVM::StoreOp::create(rw, loc, f, byteOffset(rw, loc, slot, e.offsetOf(v, k)));
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, et, slot);
    return success();
  }
};

struct EnumTagLowering : ConvertOpToLLVMPattern<EnumTagOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnumTagOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Value slot = entrySlot(rw, op, a.getValue().getType());
    LLVM::StoreOp::create(rw, op.getLoc(), a.getValue(), slot);
    EnumType e = op.getValue().getType();
    if (e.getNicheBits())
      rw.replaceOp(op, nicheTagAt(rw, op.getLoc(), e, slot));
    else
      rw.replaceOpWithNewOp<LLVM::LoadOp>(op, rw.getI32Type(), slot);
    return success();
  }
};

struct EnumPayloadLowering : ConvertOpToLLVMPattern<EnumPayloadOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnumPayloadOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    EnumType e = op.getValue().getType();
    Value slot = entrySlot(rw, op, a.getValue().getType());
    LLVM::StoreOp::create(rw, loc, a.getValue(), slot);
    int64_t off = e.offsetOf(e.variantOf(op.getTag()), op.getIndex());
    rw.replaceOpWithNewOp<LLVM::LoadOp>(op, getTypeConverter()->convertType(op.getType()),
                                        byteOffset(rw, loc, slot, off));
    return success();
  }
};

struct EnumFieldRefLowering : ConvertOpToLLVMPattern<EnumFieldRefOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnumFieldRefOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto e = cast<EnumType>(op.getRef().getType().getPointee());
    int64_t off = e.offsetOf(e.variantOf(op.getTag()), op.getIndex());
    rw.replaceOp(op, byteOffset(rw, op.getLoc(), a.getRef(), off));
    return success();
  }
};

// The i32 tag is bytes 0..4 of every tagged enum (EnumLayout).
// The tag is the i32 in bytes 0..4 (EnumType).
struct EnumSetTagLowering : ConvertOpToLLVMPattern<EnumSetTagOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnumSetTagOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    storeTag(rw, op.getLoc(), cast<EnumType>(op.getRef().getType().getPointee()), a.getRef(),
             op.getTag());
    rw.eraseOp(op);
    return success();
  }
};

struct EnumTagAtLowering : ConvertOpToLLVMPattern<EnumTagAtOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(EnumTagAtOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    auto e = cast<EnumType>(op.getRef().getType().getPointee());
    if (e.getNicheBits())
      rw.replaceOp(op, nicheTagAt(rw, op.getLoc(), e, a.getRef()));
    else
      rw.replaceOpWithNewOp<LLVM::LoadOp>(op, rw.getI32Type(), a.getRef());
    return success();
  }
};

struct StructNewLowering : ConvertOpToLLVMPattern<StructNewOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StructNewOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Location loc = op.getLoc();
    Value s = LLVM::UndefOp::create(rw, loc, getTypeConverter()->convertType(op.getType()));
    for (auto [k, f] : llvm::enumerate(a.getFields()))
      s = LLVM::InsertValueOp::create(rw, loc, s, f, ArrayRef<int64_t>{(int64_t)k});
    rw.replaceOp(op, s);
    return success();
  }
};

struct StructGetLowering : ConvertOpToLLVMPattern<StructGetOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(StructGetOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    rw.replaceOpWithNewOp<LLVM::ExtractValueOp>(op, a.getValue(),
                                                ArrayRef<int64_t>{(int64_t)op.getIndex()});
    return success();
  }
};

struct FieldRefLowering : ConvertOpToLLVMPattern<FieldRefOp> {
  using ConvertOpToLLVMPattern::ConvertOpToLLVMPattern;
  LogicalResult
  matchAndRewrite(FieldRefOp op, OpAdaptor a,
                  ConversionPatternRewriter &rw) const override {
    Type st = getTypeConverter()->convertType(op.getRef().getType().getPointee());
    rw.replaceOpWithNewOp<LLVM::GEPOp>(
        op, LLVM::LLVMPointerType::get(rw.getContext()), st, a.getRef(),
        ArrayRef<LLVM::GEPArg>{0, (int32_t)op.getIndex()}, LLVM::GEPNoWrapFlags::inbounds);
    return success();
  }
};

} // namespace

std::string milo::typeKey(Type t) {
  if (auto i = dyn_cast<IntegerType>(t))
    return (i.isSigned() ? "si" : i.isUnsigned() ? "ui" : "i") + std::to_string(i.getWidth());
  if (isa<PtrType>(t))
    return "ptr";
  if (isa<StringType>(t))
    return "string";
  if (auto v = dyn_cast<VecValType>(t))
    return "vec." + typeKey(v.getElementType());
  if (auto v = dyn_cast<VecTailType>(t))
    return "vectail." + typeKey(v.getElementType());
  if (auto v = dyn_cast<ArrayTailType>(t))
    return "arraytail." + typeKey(v.getArrayType());
  if (auto h = dyn_cast<HeapType>(t))
    return "heap." + typeKey(h.getValueType());
  if (auto d = dyn_cast<DynType>(t))
    return ("dyn." + d.getIface()).str();
  if (auto d = dyn_cast<DynRefType>(t))
    return ("dynref." + d.getIface()).str();
  if (auto m = dyn_cast<MapType>(t))
    return "map." + typeKey(m.getKeyType()) + "." + typeKey(m.getValueType());
  if (auto s = dyn_cast<StructType>(t))
    return ("S" + s.getName()).str();
  if (auto e = dyn_cast<EnumType>(t))
    return ("E" + e.getName()).str();
  if (auto f = dyn_cast<FnType>(t)) {
    if (f.getOwning())
      return "ownfn";
    // Spelled by signature: a helper keyed by it takes these values as typed params. The
    // param count and `v` for no result keep the dotted key decodable.
    auto sig = f.getSignature();
    std::string s = "fn" + std::to_string(sig.getNumInputs());
    for (Type p : sig.getInputs()) {
      if (auto r = dyn_cast<RefType>(p))
        s += ".r" + typeKey(r.getPointee());
      else if (auto v = dyn_cast<VecType>(p))
        s += ".rvec." + typeKey(v.getElementType());
      else
        s += "." + typeKey(p);
    }
    return s + "." + (sig.getNumResults() ? typeKey(sig.getResult(0)) : std::string("v"));
  }
  if (auto a = dyn_cast<ArrayType>(t))
    return "arr" + std::to_string(a.getSize()) + "." + typeKey(a.getElementType());
  std::string s;
  llvm::raw_string_ostream os(s);
  os << t;
  return s;
}

Value milo::entrySlot(ConversionPatternRewriter &rw, Operation *op, Type t) {
  OpBuilder::InsertionGuard g(rw);
  rw.setInsertionPointToStart(&op->getParentRegion()->front());
  Location loc = op->getLoc();
  Value one = LLVM::ConstantOp::create(rw, loc, rw.getI64Type(), rw.getI64IntegerAttr(1));
  return LLVM::AllocaOp::create(rw, loc, LLVM::LLVMPointerType::get(rw.getContext()), t, one);
}

namespace {

// Scalars are passed by value, everything else by reference (a slot in the entry block,
// so a print in a loop does not grow the stack).
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
  tc.addConversion([ctx = &tc.getContext()](PtrType) -> Type {
    return LLVM::LLVMPointerType::get(ctx);
  });
  tc.addConversion([ctx = &tc.getContext()](StringType) -> Type { return stringStruct(ctx); });
  tc.addConversion([&tc](ArrayType a) -> std::optional<Type> {
    Type e = tc.convertType(a.getElementType());
    if (!e)
      return std::nullopt;
    return LLVM::LLVMArrayType::get(e, a.getSize());
  });
  tc.addConversion([ctx = &tc.getContext()](HeapType) -> Type {
    return LLVM::LLVMPointerType::get(ctx);
  });
  tc.addConversion([ctx = &tc.getContext()](DynType) -> Type {
    auto p = LLVM::LLVMPointerType::get(ctx);
    return LLVM::LLVMStructType::getLiteral(ctx, {p, p});
  });
  tc.addConversion([ctx = &tc.getContext()](DynRefType) -> Type {
    auto p = LLVM::LLVMPointerType::get(ctx);
    return LLVM::LLVMStructType::getLiteral(ctx, {p, p});
  });
  tc.addConversion([ctx = &tc.getContext()](FnType) -> Type {
    auto p = LLVM::LLVMPointerType::get(ctx);
    return LLVM::LLVMStructType::getLiteral(ctx, {p, p});
  });
  // Identified by legacy's names, so a spliced body's `%Point` is the module's own type.
  tc.addConversion([&tc](StructType s) -> std::optional<Type> {
    auto st = LLVM::LLVMStructType::getIdentified(&tc.getContext(), s.getName());
    if (st.isInitialized())
      return st;
    SmallVector<Type> fields;
    for (Type f : s.getFields()) {
      Type c = tc.convertType(f);
      if (!c)
        return std::nullopt;
      fields.push_back(c);
    }
    if (failed(st.setBody(fields, /*isPacked=*/false)))
      return std::nullopt;
    return st;
  });
  tc.addConversion([&tc](EnumType e) -> std::optional<Type> {
    MLIRContext *ctx = &tc.getContext();
    auto st = LLVM::LLVMStructType::getIdentified(ctx, e.getName());
    if (st.isInitialized())
      return st;
    // Legacy's niche layout, `%Name = type { P }`: the payload alone.
    if (e.getNicheBits()) {
      Type p = tc.convertType(e.getVariants()[e.variantOf(e.getSomeTag())].getType(0));
      if (!p || failed(st.setBody({p}, /*isPacked=*/false)))
        return std::nullopt;
      return st;
    }
    Type body = e.getSize() == 0
                    ? Type(IntegerType::get(ctx, 32))
                    : Type(LLVM::LLVMArrayType::get(IntegerType::get(ctx, 8 * e.getAlign()),
                                                    e.getSize() / e.getAlign()));
    if (failed(st.setBody({body}, /*isPacked=*/false)))
      return std::nullopt;
    return st;
  });
  patterns.add<AddLowering, SubLowering, MulLowering, NegLowering, DivLowering,
               RemLowering, ShiftLowering<ShlOp, true>, ShiftLowering<ShrOp, false>,
               BitLowering<AndOp, LLVM::AndOp>, BitLowering<OrOp, LLVM::OrOp>,
               BitLowering<XorOp, LLVM::XOrOp>, NotLowering, ConstLowering, CmpLowering,
               CastLowering, VarLowering, LoadLowering, StoreLowering, ReturnLowering,
               UnreachableLowering, CheckUnaliasedLowering, PtrLoadLowering,
               PtrStoreLowering, ReplayLowering<ReplayEnterOp, true>,
               ReplayLowering<ReplayExitOp, false>, BoundsCheckLowering, ContractCheckLowering, PanicIfLowering, BitsLowering, FnAddrLowering, CallPtrLowering, CCallLowering, GlobalAddrLowering, OverflowsLowering, SaturatingLowering,
               StringLitLowering, EnumNewLowering, EnumTagLowering,
               PtrElemLowering, PtrFieldLowering, AddrLowering, PtrLendLowering, VecDataLowering, StringByteLowering,
               EnumPayloadLowering, StructNewLowering, StructGetLowering, FieldRefLowering,
               GlobalLowering, GlobalInitLowering, ClosureLowering, EnvCaptureLowering, FnCastLowering,
               ClosureCallLowering, EnumFieldRefLowering, EnumTagAtLowering, EnumSetTagLowering, HeapNewLowering, HeapPlaceLowering, HeapFreeLowering, CopyLowering,
               ArrayElemRefLowering, ZeroLowering, StringDataLowering>(tc);
}

void milo::registerScalarPasses() {
  PassRegistration<LowerStructuredCFPass>();
  PassRegistration<VerifyPass>();
  PassRegistration<ExpandIndexPass>();
  PassRegistration<RaiseToScfPass>();
}
