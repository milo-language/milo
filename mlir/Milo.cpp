// milo dialect registration and the tablegen'd type and op definitions.
#include "Milo.h"
#include "mlir/Dialect/Func/IR/FuncOps.h"
#include "mlir/IR/Builders.h"
#include "mlir/IR/DialectImplementation.h"
#include "mlir/Interfaces/FunctionInterfaces.h"
#include "mlir/Interfaces/Utils/InferIntRangeCommon.h"
#include "llvm/ADT/TypeSwitch.h"

using namespace mlir;
using namespace milo;

#include "MiloDialect.cpp.inc"
#include "MiloEnums.cpp.inc"
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

//===----------------------------------------------------------------------===//
// Aggregate types.
//===----------------------------------------------------------------------===//

// !milo.struct<"Name", T0, T1>, or `!milo.struct<"Name">` inside its own body. A bare name
// that is neither being parsed nor defined yet is the struct with no fields. A body may be
// spelled again inside itself (a field type spelled whole): it must be the same body.
Type StructType::parse(AsmParser &p) {
  std::string name;
  SMLoc loc = p.getCurrentLocation();
  if (p.parseLess() || p.parseString(&name))
    return {};
  auto t = StructType::get(p.getContext(), name);
  FailureOr<AsmParser::CyclicParseReset> cycle = p.tryStartCyclicParse(t);
  if (succeeded(p.parseOptionalGreater())) {
    if (failed(cycle) || t.isInitialized())
      return t;
    (void)t.setBody({}, false);
    return t;
  }
  bool userDrop = succeeded(p.parseOptionalKeyword("drop"));
  SmallVector<Type> fields;
  while (succeeded(p.parseOptionalComma())) {
    Type f;
    if (p.parseType(f))
      return {};
    fields.push_back(f);
  }
  if (p.parseGreater())
    return {};
  if (failed(t.setBody(fields, userDrop))) {
    p.emitError(loc) << "struct \"" << name << "\" has two different bodies";
    return {};
  }
  return t;
}

void StructType::print(AsmPrinter &p) const {
  FailureOr<AsmPrinter::CyclicPrintReset> cycle = p.tryStartCyclicPrint(*this);
  p << "<\"" << getName() << "\"";
  if (succeeded(cycle)) {
    p << (getUserDrop() ? " drop" : "");
    for (Type t : getFields())
      p << ", " << t;
  }
  p << ">";
}

StringRef StructType::getName() const { return getImpl()->name; }
ArrayRef<Type> StructType::getFields() const { return getImpl()->fields; }
bool StructType::getUserDrop() const { return getImpl()->userDrop; }
bool StructType::isInitialized() const { return getImpl()->initialized; }
LogicalResult StructType::setBody(ArrayRef<Type> fields, bool userDrop) {
  return Base::mutate(fields, userDrop);
}

Type FnType::parse(AsmParser &p) {
  FunctionType sig;
  if (p.parseLess())
    return {};
  bool owning = succeeded(p.parseOptionalKeyword("owning"));
  if (p.parseType(sig) || p.parseGreater())
    return {};
  return FnType::get(p.getContext(), sig, owning);
}

void FnType::print(AsmPrinter &p) const {
  p << "<" << (getOwning() ? "owning " : "") << getSignature() << ">";
}

// !milo.enum<"Name", size = N, align = A, [tag: (T at off, ...), ...]>, or
// `!milo.enum<"Name">`, the same type by name (inside its own body, or defined elsewhere).
Type EnumType::parse(AsmParser &p) {
  std::string name;
  int64_t size, align;
  SmallVector<int32_t> tags;
  SmallVector<TupleType> variants;
  SmallVector<int64_t> offsets;
  bool userDrop = false;
  SMLoc loc = p.getCurrentLocation();
  if (p.parseLess() || p.parseString(&name))
    return {};
  auto t = EnumType::get(p.getContext(), name);
  if (succeeded(p.parseOptionalGreater()))
    return t;
  userDrop = succeeded(p.parseOptionalKeyword("drop"));
  if (p.parseComma() || p.parseKeyword("size") ||
      p.parseEqual() || p.parseInteger(size) || p.parseComma() || p.parseKeyword("align") ||
      p.parseEqual() || p.parseInteger(align) || p.parseComma())
    return {};
  auto variant = [&]() -> ParseResult {
    int32_t tag;
    SmallVector<Type> fields;
    auto field = [&]() -> ParseResult {
      Type t;
      int64_t off;
      if (p.parseType(t) || p.parseKeyword("at") || p.parseInteger(off))
        return failure();
      fields.push_back(t);
      offsets.push_back(off);
      return success();
    };
    if (p.parseInteger(tag) || p.parseColon() ||
        p.parseCommaSeparatedList(AsmParser::Delimiter::Paren, field))
      return failure();
    tags.push_back(tag);
    variants.push_back(TupleType::get(p.getContext(), fields));
    return success();
  };
  if (p.parseCommaSeparatedList(AsmParser::Delimiter::Square, variant) || p.parseGreater())
    return {};
  if (failed(t.setBody([&] { return p.emitError(loc); }, size, align, tags, variants, offsets,
                       userDrop)))
    return {};
  return t;
}

void EnumType::print(AsmPrinter &p) const {
  FailureOr<AsmPrinter::CyclicPrintReset> cycle = p.tryStartCyclicPrint(*this);
  if (failed(cycle) || !isInitialized()) {
    p << "<\"" << getName() << "\">";
    return;
  }
  p << "<\"" << getName() << "\"" << (getUserDrop() ? " drop" : "") << ", size = " << getSize() << ", align = " << getAlign() << ", [";
  unsigned k = 0;
  llvm::interleaveComma(llvm::zip(getTags(), getVariants()), p, [&](auto tv) {
    p << std::get<0>(tv) << ": (";
    llvm::interleaveComma(std::get<1>(tv).getTypes(), p,
                          [&](Type t) { p << t << " at " << getOffsets()[k++]; });
    p << ")";
  });
  p << "]>";
}

StringRef EnumType::getName() const { return getImpl()->name; }
int64_t EnumType::getSize() const { return getImpl()->size; }
int64_t EnumType::getAlign() const { return getImpl()->align; }
ArrayRef<int32_t> EnumType::getTags() const { return getImpl()->tags; }
ArrayRef<TupleType> EnumType::getVariants() const { return getImpl()->variants; }
ArrayRef<int64_t> EnumType::getOffsets() const { return getImpl()->offsets; }
bool EnumType::getUserDrop() const { return getImpl()->userDrop; }
bool EnumType::isInitialized() const { return getImpl()->initialized; }

LogicalResult EnumType::setBody(function_ref<InFlightDiagnostic()> emitError, int64_t size,
                                int64_t align, ArrayRef<int32_t> tags,
                                ArrayRef<TupleType> variants, ArrayRef<int64_t> offsets,
                                bool userDrop) {
  if (tags.size() != variants.size())
    return emitError() << "needs one tag per variant";
  size_t fields = 0;
  for (TupleType v : variants)
    fields += v.size();
  if (offsets.size() != fields)
    return emitError() << "needs one offset per payload field";
  if ((align != 4 && align != 8) || size % align)
    return emitError() << "size " << size << " is not stored as " << align << "-byte words";
  if (size == 0 && fields)
    return emitError() << "of size 0 has payload fields";
  for (int64_t off : offsets)
    if (off < 4 || off >= size)
      return emitError() << "payload offset " << off << " is outside bytes 4.." << size;
  if (failed(Base::mutate(size, align, tags, variants, offsets, userDrop)))
    return emitError() << "enum \"" << getName() << "\" has two different bodies";
  return success();
}

int EnumType::variantOf(int32_t tag) const {
  for (auto [i, t] : llvm::enumerate(getTags()))
    if (t == tag)
      return i;
  return -1;
}

int64_t EnumType::offsetOf(unsigned v, unsigned k) const {
  unsigned base = 0;
  for (unsigned i = 0; i < v; i++)
    base += getVariants()[i].size();
  return getOffsets()[base + k];
}

//===----------------------------------------------------------------------===//
// Verifiers and effects of the source-level ops.
//===----------------------------------------------------------------------===//

OpFoldResult ConstOp::fold(FoldAdaptor) { return getValue(); }

// A fold that yields a constant of a milo type gets a milo.const.
Operation *MiloDialect::materializeConstant(OpBuilder &b, Attribute value, Type type,
                                            Location loc) {
  auto typed = dyn_cast<TypedAttr>(value);
  if (!typed || typed.getType() != type)
    return nullptr;
  if (!isa<IntegerType, FloatType>(type))
    return nullptr;
  if (auto it = dyn_cast<IntegerType>(type); it && it.isSignless() && it.getWidth() != 1)
    return nullptr;
  return ConstOp::create(b, loc, type, typed);
}

static bool isMiloInt(Type t) {
  auto i = dyn_cast<IntegerType>(t);
  return i && !i.isSignless();
}

// Only integer arithmetic can overflow, so only it may carry `wrapping`.
static LogicalResult verifyWrapping(Operation *op, bool wrapping) {
  if (wrapping && !isMiloInt(op->getResult(0).getType()))
    return op->emitOpError("'wrapping' applies to integer ops only");
  return success();
}

// An op that can panic writes the panic resource: that orders it against other panic
// points and keeps it alive when its result is unused (a dead `a / b` must still trap).
#define MILO_ARITH(OpT, PANICS)                                                \
  LogicalResult OpT::verify() { return verifyWrapping(*this, getWrapping()); } \
  void OpT::getEffects(                                                        \
      SmallVectorImpl<SideEffects::EffectInstance<MemoryEffects::Effect>>      \
          &effects) {                                                          \
    if (isMiloInt(getType()) && (PANICS))                                      \
      effects.emplace_back(MemoryEffects::Write::get(), PanicResource::get()); \
  }
MILO_ARITH(AddOp, !getWrapping())
MILO_ARITH(SubOp, !getWrapping())
MILO_ARITH(MulOp, !getWrapping())
MILO_ARITH(ShlOp, !getWrapping())
MILO_ARITH(ShrOp, !getWrapping())
// A zero divisor panics even under `wrapping`.
MILO_ARITH(DivOp, true)
MILO_ARITH(RemOp, true)
MILO_ARITH(NegOp, !getWrapping())
#undef MILO_ARITH

bool milo::needsDrop(Type t) {
  if (isa<StringType, VecValType, VecTailType, MapType, HeapType, DynType>(t))
    return true;
  if (auto f = dyn_cast<FnType>(t))
    return f.getOwning();
  if (auto a = dyn_cast<ArrayType>(t))
    return needsDrop(a.getElementType());
  if (auto s = dyn_cast<StructType>(t))
    return s.getUserDrop() || llvm::any_of(s.getFields(), needsDrop);
  if (auto e = dyn_cast<EnumType>(t))
    return e.getUserDrop() || llvm::any_of(e.getVariants(), [](TupleType v) { return llvm::any_of(v.getTypes(), needsDrop); });
  return false;
}

LogicalResult VarOp::verify() {
  if (!(*this)->getBlock()->isEntryBlock() ||
      !isa<FunctionOpInterface>((*this)->getParentOp()))
    return emitOpError("must be in the function's entry block");
  if (getOwned() && !needsDrop(getRef().getType().getPointee()))
    return emitOpError("owns a value with no drop glue");
  return success();
}

LogicalResult ScopeOp::verify() {
  for (Value s : getSlots()) {
    auto v = s.getDefiningOp<VarOp>();
    if (!v || !v.getOwned())
      return emitOpError("lists a slot that is not an owned milo.var");
  }
  return success();
}

LogicalResult DropOp::verify() {
  if (!needsDrop(getRef().getType().getPointee()))
    return emitOpError("of a value with no drop glue");
  auto v = getRef().getDefiningOp<VarOp>();
  if (getFlag() && !(v && v.getOwned()))
    return emitOpError("with a drop flag needs an owned slot");
  return success();
}

LogicalResult GlobalOp::verify() {
  if (getName().empty())
    return emitOpError("needs a name");
  // A reference is second-class and never stored, so no global holds one.
  Type t = getRef().getType().getPointee();
  if (!isa<IntegerType, FloatType, PtrType, StructType, EnumType, ArrayType, StringType, VecValType, MapType, HeapType, DynType, FnType>(t))
    return emitOpError("holds a ") << t << ": a global holds a value";
  return success();
}

LogicalResult ClosureOp::verify() {
  auto body = SymbolTable::lookupNearestSymbolFrom<func::FuncOp>(*this, getFnAttr());
  if (!body)
    return emitOpError("names no function: ") << getFn();
  if (getType().getOwning())
    return emitOpError("builds a by-reference closure, which owns nothing: not ") << getType();
  FunctionType sig = getType().getSignature();
  FunctionType fty = body.getFunctionType();
  if (fty.getNumInputs() != sig.getNumInputs() + 1 || !isa<PtrType>(fty.getInput(0)) ||
      fty.getInputs().drop_front() != sig.getInputs() || fty.getResults() != sig.getResults())
    return emitOpError("body @") << getFn() << " is " << fty << ", not (!milo.ptr env) + " << sig;
  return success();
}

LogicalResult FnCastOp::verify() {
  FnType from = getValue().getType(), to = getType();
  if (from.getSignature() != to.getSignature())
    return emitOpError("changes the signature: ") << from << " to " << to;
  if (from.getOwning() == to.getOwning())
    return emitOpError("changes nothing: ") << from;
  return success();
}

LogicalResult EnvCaptureOp::verify() {
  auto fn = (*this)->getParentOfType<func::FuncOp>();
  auto arg = dyn_cast<BlockArgument>(getEnv());
  if (!fn || !arg || arg.getOwner() != &fn.getBody().front() || arg.getArgNumber() != 0)
    return emitOpError("reads an env that is not its closure body's first argument");
  return success();
}

LogicalResult ClosureCallOp::verify() {
  FunctionType sig = getCallee().getType().getSignature();
  if (TypeRange(getArgs()) != sig.getInputs())
    return emitOpError("arguments do not match ") << sig;
  if (TypeRange(getOperation()->getResultTypes()) != sig.getResults())
    return emitOpError("result does not match ") << sig;
  return success();
}

LogicalResult StringAppendOp::verify() {
  if (!isa<StringType>(getDst().getType().getPointee()))
    return emitOpError("needs the place of a string");
  return success();
}

LogicalResult FilledOp::verify() {
  auto v = getRef().getDefiningOp<VarOp>();
  if (!v || !v.getOwned())
    return emitOpError("needs an owned slot");
  return success();
}

LogicalResult ZeroOp::verify() {
  // A fn value's zero would be a call through null; nothing spells one.
  if (isa<FnType>(getType()))
    return emitOpError("has no zero of a fn value");
  return success();
}

LogicalResult CopyOp::verify() {
  if (!isa<StructType, EnumType, ArrayType>(getElem()))
    return emitOpError("copies a struct, an enum or an array, not ") << getElem();
  for (Value side : {getSrc(), getDst()})
    if (auto r = dyn_cast<RefType>(side.getType()); r && r.getPointee() != getElem())
      return emitOpError("needs places of ") << getElem() << ", not " << side.getType();
  if (getSrc() == getDst())
    return emitOpError("copies a place onto itself");
  return success();
}

LogicalResult GlobalInitOp::verify() {
  if (getName().empty())
    return emitOpError("needs a name");
  return success();
}

LogicalResult VecPlaceOp::verify() {
  auto v = dyn_cast<VecValType>(getRef().getType().getPointee());
  if (!v || v.getElementType() != getType().getElementType())
    return emitOpError("needs the slot of a Vec of ") << getType().getElementType();
  return success();
}

// The vectail ops' slot: an owned one (only its drop glue frees what no iteration took).
static VecTailType vecTailSlot(Operation *op, Value ref) {
  auto t = dyn_cast<VecTailType>(cast<RefType>(ref.getType()).getPointee());
  auto v = ref.getDefiningOp<VarOp>();
  if (!t || !v || !v.getOwned()) {
    op->emitOpError("needs an owned slot of a !milo.vectail");
    return {};
  }
  return t;
}

LogicalResult VecTailInitOp::verify() {
  auto t = vecTailSlot(*this, getRef());
  if (!t)
    return failure();
  if (getVec().getType().getElementType() != t.getElementType())
    return emitOpError("moves a Vec of ") << getVec().getType().getElementType() << " into " << t;
  return success();
}

LogicalResult VecTailVecOp::verify() {
  auto t = vecTailSlot(*this, getRef());
  if (!t)
    return failure();
  if (getType().getElementType() != t.getElementType())
    return emitOpError("is the header of a Vec of ") << t.getElementType() << ", not " << getType();
  return success();
}

LogicalResult VecTailTakeOp::verify() {
  auto t = vecTailSlot(*this, getRef());
  if (!t)
    return failure();
  if (getType() != t.getElementType())
    return emitOpError("takes an element of ") << t << ", not " << getType();
  return success();
}

LogicalResult VecTailTakePlaceOp::verify() {
  auto t = vecTailSlot(*this, getRef());
  if (!t)
    return failure();
  if (getType().getPointee() != t.getElementType())
    return emitOpError("is the place of an element of ") << t << ", not " << getType();
  return success();
}

LogicalResult HeapNewOp::verify() {
  if (getValue().getType() != getType().getValueType())
    return emitOpError("boxes a ") << getValue().getType() << " as " << getType();
  return success();
}

LogicalResult HeapPlaceOp::verify() {
  if (getType().getPointee() != getHeap().getType().getValueType())
    return emitOpError("is the place of a ") << getHeap().getType().getValueType() << ", not " << getType();
  return success();
}

LogicalResult PtrFieldOp::verify() {
  auto s = dyn_cast<StructType>(getRecord());
  if (!s || getIndex() >= s.getFields().size())
    return emitOpError("has no field ") << getIndex() << " in " << getRecord();
  return success();
}

LogicalResult StringShareOp::verify() {
  if (!isa<StringType>(getRef().getType().getPointee()))
    return emitOpError("needs the place of a string");
  return success();
}

LogicalResult IfOp::verify() {
  if (!getResults().empty() && getElseRegion().empty())
    return emitOpError("with results needs an else region");
  return success();
}

LogicalResult IndexOp::verify() {
  if (getType() != getVec().getType().getElementType())
    return emitOpError("result is not the Vec's element type");
  return success();
}

LogicalResult IndexRefOp::verify() {
  if (getRef().getType().getPointee() != getVec().getType().getElementType())
    return emitOpError("is not a place of the Vec's element type");
  return success();
}

LogicalResult VecElemRefOp::verify() {
  if (getRef().getType().getPointee() != getVec().getType().getElementType())
    return emitOpError("is not a place of the Vec's element type");
  return success();
}

// An array.index / array.elem_ref: from an array's place to one of its element's.
template <typename OpT> static LogicalResult verifyArrayElem(OpT op) {
  auto a = dyn_cast<ArrayType>(op.getArray().getType().getPointee());
  if (!a)
    return op.emitOpError("needs the place of an array, not ") << op.getArray().getType();
  if (op.getRef().getType().getPointee() != a.getElementType())
    return op.emitOpError("is not a place of the array's element type");
  return success();
}

LogicalResult ArrayIndexOp::verify() { return verifyArrayElem(*this); }
LogicalResult ArrayElemRefOp::verify() { return verifyArrayElem(*this); }

LogicalResult IndexStoreOp::verify() {
  if (getValue().getType() != getVec().getType().getElementType())
    return emitOpError("value is not the Vec's element type");
  return success();
}

LogicalResult PrintOp::verify() {
  for (Type t : getParts().getTypes()) {
    auto i = dyn_cast<IntegerType>(t);
    bool ok = (i && (!i.isSignless() || i.getWidth() == 1)) || t.isF32() || t.isF64() ||
              isa<PtrType, StringType, StructType, EnumType>(t);
    if (!ok)
      return emitOpError("cannot display a part of type ") << t;
  }
  if (getPartial() && (getParts().empty() || !isa<StringType>(getParts().back().getType())))
    return emitOpError("partial must end at a string part");
  return success();
}

LogicalResult StructNewOp::verify() {
  if (getFields().getTypes() != getType().getFields())
    return emitOpError("operands are not the fields of ") << getType();
  return success();
}

LogicalResult StructGetOp::verify() {
  ArrayRef<Type> fields = getValue().getType().getFields();
  if (getIndex() >= fields.size() || fields[getIndex()] != getType())
    return emitOpError("has no field ") << getIndex() << " of type " << getType();
  return success();
}

LogicalResult FieldRefOp::verify() {
  auto s = dyn_cast<StructType>(getRef().getType().getPointee());
  if (!s)
    return emitOpError("needs the place of a struct");
  ArrayRef<Type> fields = s.getFields();
  if (getIndex() >= fields.size() || fields[getIndex()] != getType().getPointee())
    return emitOpError("has no field ") << getIndex() << " of type " << getType().getPointee();
  return success();
}

// Variant `tag` of `e`, its fields checked against `types` when given.
static LogicalResult verifyVariant(Operation *op, EnumType e, int32_t tag,
                                   std::optional<TypeRange> types) {
  int v = e.variantOf(tag);
  if (v < 0)
    return op->emitOpError("has no variant with tag ") << tag;
  if (types && *types != TypeRange(e.getVariants()[v].getTypes()))
    return op->emitOpError("payload is not the fields of variant ") << tag;
  return success();
}

LogicalResult EnumNewOp::verify() {
  return verifyVariant(*this, getType(), getTag(), TypeRange(getFields().getTypes()));
}

LogicalResult EnumPayloadOp::verify() {
  EnumType e = getValue().getType();
  if (failed(verifyVariant(*this, e, getTag(), std::nullopt)))
    return failure();
  TupleType fields = e.getVariants()[e.variantOf(getTag())];
  if (getIndex() >= fields.size() || fields.getType(getIndex()) != getType())
    return emitOpError("has no payload field ") << getIndex() << " of type " << getType();
  return success();
}

LogicalResult EnumFieldRefOp::verify() {
  auto e = dyn_cast<EnumType>(getRef().getType().getPointee());
  if (!e)
    return emitOpError("needs the place of an enum");
  if (failed(verifyVariant(*this, e, getTag(), std::nullopt)))
    return failure();
  TupleType fields = e.getVariants()[e.variantOf(getTag())];
  if (getIndex() >= fields.size() || fields.getType(getIndex()) != getType().getPointee())
    return emitOpError("has no payload field ") << getIndex() << " of type " << getType().getPointee();
  return success();
}

LogicalResult EnumSetTagOp::verify() {
  auto e = dyn_cast<EnumType>(getRef().getType().getPointee());
  if (!e)
    return emitOpError("needs the place of an enum");
  return verifyVariant(*this, e, getTag(), std::nullopt);
}

LogicalResult EnumTagAtOp::verify() {
  if (!isa<EnumType>(getRef().getType().getPointee()))
    return emitOpError("needs the place of an enum");
  return success();
}

LogicalResult MatchOp::verify() {
  size_t arms = getArms().size();
  if (getCases().size() + (getHasDefault() ? 1 : 0) != arms)
    return emitOpError("needs one region per case") << (getHasDefault() ? ", plus the default" : "");
  llvm::SmallDenseSet<int64_t> seen;
  for (int64_t c : getCases())
    if (!seen.insert(c).second)
      return emitOpError("has two arms for case ") << c;
  auto e = dyn_cast<EnumType>(getSubject().getType());
  for (auto [i, region] : llvm::enumerate(getArms())) {
    TypeRange args = region.front().getArgumentTypes();
    if (i == getCases().size()) {
      if (!args.empty())
        return emitOpError("default arm takes no arguments");
      continue;
    }
    int64_t c = getCases()[i];
    if (e) {
      if (failed(verifyVariant(*this, e, static_cast<int32_t>(c), args)))
        return failure();
    } else if (!args.empty()) {
      return emitOpError("arm on a literal takes no arguments");
    }
  }
  return success();
}

LogicalResult ForOp::verify() {
  Type t = getStart().getType();
  Block &entry = getBodyRegion().front();
  if (entry.getNumArguments() != 1 || entry.getArgument(0).getType() != t)
    return emitOpError("body takes one argument, the induction variable of type ") << t;
  return success();
}

LogicalResult YieldOp::verify() {
  Operation *parent = (*this)->getParentOp();
  if (isa<IfOp, MatchOp, ScopeOp>(parent)) {
    if (getValues().getTypes() != parent->getResultTypes())
      return emitOpError("yields types that do not match the enclosing ") << parent->getName();
    return success();
  }
  if (!getValues().empty())
    return emitOpError("in a loop body yields no values");
  auto w = dyn_cast<WhileOp>(parent);
  if (w && (*this)->getParentRegion() != &w.getBodyRegion())
    return emitOpError("cannot end the cond region of milo.while");
  return success();
}

LogicalResult ConditionOp::verify() {
  auto w = cast<WhileOp>((*this)->getParentOp());
  if ((*this)->getParentRegion() != &w.getCondRegion())
    return emitOpError("must end the cond region of milo.while");
  return success();
}

// The innermost loop around `op` inside its function, or null. A jump inside the cond
// region of a while has no loop to target: the cond is the loop's header.
static Operation *enclosingLoop(Operation *op) {
  Region *from = op->getParentRegion();
  for (Operation *p = op->getParentOp(); p && !isa<FunctionOpInterface>(p);
       from = p->getParentRegion(), p = p->getParentOp()) {
    if (isa<LoopOp, ForOp>(p))
      return p;
    if (auto w = dyn_cast<WhileOp>(p))
      return from == &w.getBodyRegion() ? p : nullptr;
  }
  return nullptr;
}

LogicalResult BreakOp::verify() {
  if (!enclosingLoop(*this))
    return emitOpError("outside a loop body");
  return success();
}

LogicalResult ContinueOp::verify() {
  if (!enclosingLoop(*this))
    return emitOpError("outside a loop body");
  return success();
}

LogicalResult ReturnOp::verify() {
  auto fn = (*this)->getParentOfType<FunctionOpInterface>();
  if (!fn)
    return emitOpError("outside a function");
  ArrayRef<Type> results = fn.getResultTypes();
  Value v = getValue();
  bool ok = results.size() <= 1 && results.empty() == !v &&
            (!v || v.getType() == results[0]);
  if (!ok)
    return emitOpError("does not match the function's result type");
  return success();
}

//===----------------------------------------------------------------------===//
// Region control flow, described to MLIR (RegionBranchOpInterface, LoopLikeOpInterface),
// so upstream dataflow (dead code, constant propagation, integer ranges) and LICM see
// through milo.if, milo.match, milo.scope and the loops.
//
// milo.yield and milo.condition are the region branch terminators. break, continue and
// return are not: they leave any depth of regions at once, which the interface cannot
// say. A sparse (SSA value) analysis stays sound without those edges: no value travels
// along them (loops have no results and no loop-carried block arguments; mutable locals are
// slots), and it tracks liveness per block, so the ops after a loop in its block stay live
// even when only a break reaches them. A dense (memory state) analysis would miss the
// state a break or return carries out, and would take the code after a milo.loop for
// unreachable: none runs before milo-lower-structured-cf (milo-elaborate-drops runs after).
//===----------------------------------------------------------------------===//

// The results of an op whose regions yield to it; no region takes forwarded inputs.
static ValueRange resultsOrNone(Operation *op, RegionSuccessor s) {
  return s.isOperation() ? ValueRange(op->getResults()) : ValueRange();
}

void IfOp::getSuccessorRegions(RegionBranchPoint point,
                               SmallVectorImpl<RegionSuccessor> &regions) {
  if (!point.isParent()) {
    regions.push_back(RegionSuccessor(getOperation()));
    return;
  }
  regions.push_back(RegionSuccessor(&getThenRegion()));
  if (getElseRegion().empty())
    regions.push_back(RegionSuccessor(getOperation()));
  else
    regions.push_back(RegionSuccessor(&getElseRegion()));
}

void IfOp::getEntrySuccessorRegions(ArrayRef<Attribute> operands,
                                    SmallVectorImpl<RegionSuccessor> &regions) {
  auto c = dyn_cast_or_null<BoolAttr>(operands[0]);
  if (!c)
    return getSuccessorRegions(RegionBranchPoint::parent(), regions);
  if (c.getValue())
    regions.push_back(RegionSuccessor(&getThenRegion()));
  else if (getElseRegion().empty())
    regions.push_back(RegionSuccessor(getOperation()));
  else
    regions.push_back(RegionSuccessor(&getElseRegion()));
}

ValueRange IfOp::getSuccessorInputs(RegionSuccessor s) { return resultsOrNone(*this, s); }

void ScopeOp::getSuccessorRegions(RegionBranchPoint point,
                                  SmallVectorImpl<RegionSuccessor> &regions) {
  if (point.isParent())
    regions.push_back(RegionSuccessor(&getBody()));
  else
    regions.push_back(RegionSuccessor(getOperation()));
}

ValueRange ScopeOp::getSuccessorInputs(RegionSuccessor s) { return resultsOrNone(*this, s); }

// Every arm may run; without a default some arm always does (the checker proved the match
// exhaustive). An arm's payload arguments come from the subject, not from a forwarded
// operand, so analyses take them as unknown.
void MatchOp::getSuccessorRegions(RegionBranchPoint point,
                                  SmallVectorImpl<RegionSuccessor> &regions) {
  if (!point.isParent()) {
    regions.push_back(RegionSuccessor(getOperation()));
    return;
  }
  for (Region &arm : getArms())
    regions.push_back(RegionSuccessor(&arm));
}

ValueRange MatchOp::getSuccessorInputs(RegionSuccessor s) { return resultsOrNone(*this, s); }

void WhileOp::getSuccessorRegions(RegionBranchPoint point,
                                  SmallVectorImpl<RegionSuccessor> &regions) {
  if (point.isParent()) {
    regions.push_back(RegionSuccessor(&getCondRegion()));
    return;
  }
  if (point.getTerminatorPredecessorOrNull()->getParentRegion() == &getCondRegion()) {
    regions.push_back(RegionSuccessor(&getBodyRegion()));
    regions.push_back(RegionSuccessor(getOperation()));
    return;
  }
  regions.push_back(RegionSuccessor(&getCondRegion()));
}

// Only a break leaves a milo.loop, and a break is not a region branch: no edge returns
// to the parent.
void LoopOp::getSuccessorRegions(RegionBranchPoint,
                                 SmallVectorImpl<RegionSuccessor> &regions) {
  regions.push_back(RegionSuccessor(&getBodyRegion()));
}

// Zero or more iterations; the induction variable is not forwarded from an operand (it is
// start, then the step), so analyses read its range from the loop bounds below.
void ForOp::getSuccessorRegions(RegionBranchPoint,
                                SmallVectorImpl<RegionSuccessor> &regions) {
  regions.push_back(RegionSuccessor(&getBodyRegion()));
  regions.push_back(RegionSuccessor(getOperation()));
}

SmallVector<Region *> WhileOp::getLoopRegions() { return {&getCondRegion(), &getBodyRegion()}; }
SmallVector<Region *> LoopOp::getLoopRegions() { return {&getBodyRegion()}; }
SmallVector<Region *> ForOp::getLoopRegions() { return {&getBodyRegion()}; }

// IntegerRangeAnalysis reads loop bounds as signed (as for scf.for), but an unsigned
// milo.for compares unsigned: its iv can pass the signed max. So only a signed loop
// names its induction variable and bounds.
std::optional<SmallVector<Value>> ForOp::getLoopInductionVars() {
  if (!getStart().getType().isSignedInteger())
    return std::nullopt;
  return SmallVector<Value>{getBodyRegion().front().getArgument(0)};
}

std::optional<SmallVector<OpFoldResult>> ForOp::getLoopLowerBounds() {
  if (!getStart().getType().isSignedInteger())
    return std::nullopt;
  return SmallVector<OpFoldResult>{getStart()};
}

std::optional<SmallVector<OpFoldResult>> ForOp::getLoopUpperBounds() {
  if (!getStart().getType().isSignedInteger())
    return std::nullopt;
  return SmallVector<OpFoldResult>{getEnd()};
}

std::optional<SmallVector<OpFoldResult>> ForOp::getLoopSteps() {
  if (!getStart().getType().isSignedInteger())
    return std::nullopt;
  return SmallVector<OpFoldResult>{IntegerAttr::get(getStart().getType(), 1)};
}

bool ForOp::isValidInductionVarType(Type t) { return isa<IntegerType>(t); }

MutableOperandRange YieldOp::getMutableSuccessorOperands(RegionSuccessor) {
  return getValuesMutable();
}

// The condition picks the successor; no value is forwarded.
MutableOperandRange ConditionOp::getMutableSuccessorOperands(RegionSuccessor) {
  return MutableOperandRange(getOperation(), 0, 0);
}

//===----------------------------------------------------------------------===//
// Integer ranges (InferIntRangeInterface), for IntegerRangeAnalysis.
//===----------------------------------------------------------------------===//

void ConstOp::inferResultRanges(ArrayRef<ConstantIntRanges>, SetIntRangeFn set) {
  if (auto i = dyn_cast<IntegerAttr>(getValue()))
    set(getResult(), ConstantIntRanges::constant(i.getValue()));
}

// Signedness from the operand type, as the lowering compares (bool as signed i1).
void CmpOp::inferResultRanges(ArrayRef<ConstantIntRanges> args, SetIntRangeFn set) {
  std::optional<bool> known;
  if (auto t = dyn_cast<IntegerType>(getLhs().getType())) {
    using P = intrange::CmpPredicate;
    bool u = t.isUnsigned();
    P p = P::eq;
    switch (getPredicate()) {
    case CmpPredicate::eq: p = P::eq; break;
    case CmpPredicate::ne: p = P::ne; break;
    case CmpPredicate::lt: p = u ? P::ult : P::slt; break;
    case CmpPredicate::le: p = u ? P::ule : P::sle; break;
    case CmpPredicate::gt: p = u ? P::ugt : P::sgt; break;
    case CmpPredicate::ge: p = u ? P::uge : P::sge; break;
    }
    known = intrange::evaluatePred(p, args[0], args[1]);
  }
  set(getResult(), known ? ConstantIntRanges::constant(APInt(1, *known))
                         : ConstantIntRanges::fromUnsigned(APInt(1, 0), APInt(1, 1)));
}
