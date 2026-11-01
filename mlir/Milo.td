// The milo dialect: Milo's Vec and bounds-check semantics as first-class IR, so loop
// transforms can use facts LLVM IR cannot carry (a Vec header is never written by an
// element store; a bounds check is a panic point ordered against element writes).
include "mlir/IR/OpBase.td"
include "mlir/IR/AttrTypeBase.td"
include "mlir/Interfaces/SideEffectInterfaces.td"
include "mlir/IR/EnumAttr.td"
include "mlir/IR/OpBase.td"
include "mlir/Interfaces/InferTypeOpInterface.td"
include "mlir/IR/BuiltinAttributeInterfaces.td"

def Milo_Dialect : Dialect {
  let name = "milo";
  let cppNamespace = "::milo";
  let useDefaultTypePrinterParser = 1;
  let hasConstantMaterializer = 1;
}

// A Vec<T> passed by reference: the address of its {ptr, len, cap} header.
def Milo_VecType : TypeDef<Milo_Dialect, "Vec"> {
  let mnemonic = "vec";
  let parameters = (ins "::mlir::Type":$elementType);
  let assemblyFormat = "`<` $elementType `>`";
}

// Header memory ({ptr, len, cap}) and element memory are disjoint resources: only a
// growing op writes the header, so element stores never clobber a cached len or data
// pointer. Panic orders bounds checks among themselves and keeps them alive.
def Milo_VecHeader : Resource<"::milo::VecHeaderResource">;
def Milo_VecElems : Resource<"::milo::VecElemsResource">;
def Milo_Panic : Resource<"::milo::PanicResource">;
// Stack slots of `var`s and the scalars a `&T` param points at: never a Vec header or
// element, so slot traffic in a loop does not stop vec.len from being hoisted.
def Milo_Slot : Resource<"::milo::SlotResource">;

class Milo_Op<string mnemonic, list<Trait> traits = []>
    : Op<Milo_Dialect, mnemonic, traits>;

def Milo_VecLenOp : Milo_Op<"vec.len"> {
  let arguments = (ins Arg<Milo_VecType, "", [MemRead<Milo_VecHeader>]>:$vec);
  let results = (outs I64:$len);
  let assemblyFormat = "$vec attr-dict `:` type($vec)";
}

// Unchecked element read; the frontend emits a bounds_check before it.
def Milo_VecLoadOp : Milo_Op<"vec.load"> {
  let arguments = (ins
    Arg<Milo_VecType, "", [MemRead<Milo_VecHeader>, MemRead<Milo_VecElems>]>:$vec,
    I64:$index);
  let results = (outs AnyType:$result);
  let assemblyFormat = "$vec `[` $index `]` attr-dict `:` type($vec) `->` type($result)";
}

def Milo_VecStoreOp : Milo_Op<"vec.store"> {
  let arguments = (ins AnyType:$value,
    Arg<Milo_VecType, "", [MemRead<Milo_VecHeader>, MemWrite<Milo_VecElems>]>:$vec,
    I64:$index);
  let assemblyFormat = "$value `,` $vec `[` $index `]` attr-dict `:` type($value) `,` type($vec)";
}

// Panics unless 0 <= index < len (one unsigned compare). Reading VecElems pins it after
// every earlier element store: a task that recovers from the panic observes exactly
// the writes made before the failing index. The panic names the op's location.
def Milo_BoundsCheckOp : Milo_Op<"bounds_check",
    [MemoryEffects<[MemRead<Milo_VecElems>, MemWrite<Milo_Panic>]>]> {
  let arguments = (ins I64:$index, I64:$len);
  let assemblyFormat = "$index `,` $len attr-dict";
}

//===----------------------------------------------------------------------===//
// Source-level ops: Milo's scalar language as written, before any lowering.
//
// The TypeScript emitter prints these from HIR (src/emit-mlir.ts); every rewrite after
// that is a milo-opt pass. Modeled on ClangIR (cir.if/cir.while/cir.break) and Mojo's
// lit dialect (control flow as region ops, locals as var/load/store until a pass lowers
// them). Ints carry their signedness in the type (si32, ui8): `/`, `>>`, `<` and the
// overflow check all depend on it, so no attribute can disagree with the operands.
// bool is i1.
//===----------------------------------------------------------------------===//

def Milo_Int : AnyTypeOf<[AnySignedInteger, AnyUnsignedInteger]>;
def Milo_Float : AnyTypeOf<[F32, F64]>;
def Milo_Number : AnyTypeOf<[Milo_Int, Milo_Float]>;
def Milo_Bits : AnyTypeOf<[Milo_Int, I1]>;
def Milo_Scalar : AnyTypeOf<[Milo_Int, Milo_Float, I1]>;

// The address of a mutable local (Mojo's !lit.ref, ClangIR's !cir.ptr).
def Milo_RefType : TypeDef<Milo_Dialect, "Ref"> {
  let mnemonic = "ref";
  let parameters = (ins "::mlir::Type":$pointee);
  let assemblyFormat = "`<` $pointee `>`";
}

// A raw pointer `*T` (unsafe code only). Untyped, like LLVM's: `*T` can be reinterpreted,
// so the pointee type rides on each access (milo.ptr.load/store), not on the pointer.
// Unlike a !milo.ref it is a first-class value: stored, returned, compared, cast.
def Milo_PtrType : TypeDef<Milo_Dialect, "Ptr"> {
  let mnemonic = "ptr";
}

// A Vec<T> value: legacy's `%Vec = { ptr data, i64 len, i64 cap }`. Its place, the address
// of that header, is !milo.vec<T> (milo.vec.place), which the indexing ops take.
def Milo_VecValType : TypeDef<Milo_Dialect, "VecVal"> {
  let mnemonic = "vecval";
  let parameters = (ins "::mlir::Type":$elementType);
  let assemblyFormat = "`<` $elementType `>`";
}

// A HashMap<K, V> value: legacy's `%HashMap = { ptr data, i64 len, i64 cap, i64 seed,
// i64 tombs }` (codegen-map.ts). Its methods are Milo code in std/hashmap that reads it
// through a raw pointer, so no op here looks inside; K and V only name its drop glue
// (legacy's, milo.drop.map.<k>.<v>).
def Milo_MapType : TypeDef<Milo_Dialect, "Map"> {
  let mnemonic = "map";
  let parameters = (ins "::mlir::Type":$keyType, "::mlir::Type":$valueType);
  let assemblyFormat = "`<` $keyType `,` $valueType `>`";
}

// A `Heap<T>`: legacy's malloc'd pointer to one T, owned (its drop glue, legacy's
// milo.drop.heap.<t>, drops the T and frees the box). `*h` is the place milo.heap.place
// gives. Through it a type can hold itself (`enum Expr { Add(Heap<Expr>, ...) }`).
def Milo_HeapType : TypeDef<Milo_Dialect, "Heap"> {
  let mnemonic = "heap";
  let parameters = (ins "::mlir::Type":$valueType);
  let assemblyFormat = "`<` $valueType `>`";
}

// A `Heap<I>` of an interface: legacy's `{ ptr data, ptr itable }`, owned (its drop glue,
// legacy's milo.drop.dyn.<I>, runs the concrete type's drop through the itable and frees
// the box). Opaque: a method call through it is legacy's dispatch in a helper.
def Milo_DynType : TypeDef<Milo_Dialect, "Dyn"> {
  let mnemonic = "dyn";
  let parameters = (ins StringRefParameter<>:$iface);
  let assemblyFormat = "`<` $iface `>`";
}

// What is left of a Vec a consuming `for x in makeVec()` takes apart from the front:
// legacy's `{ %Vec, i64 cursor }` (genConsumedIterable). The elements before the cursor
// were moved out; the drop glue drops those from the cursor on, then frees the buffer, so
// a break or a return out of the loop frees exactly what no iteration took. Lives only in
// an owned slot (milo.vectail.init), never as an SSA value.
def Milo_VecTailType : TypeDef<Milo_Dialect, "VecTail"> {
  let mnemonic = "vectail";
  let parameters = (ins "::mlir::Type":$elementType);
  let assemblyFormat = "`<` $elementType `>`";
}

// Milo's `string` value: legacy's `%String = { ptr data, i64 len, i64 cap }`, the same
// bytes on both sides of the splice. A literal has cap 0: its buffer is static, so its
// drop glue does nothing. Strings and Vecs are owned values: see milo.var `owned`.
def Milo_StringType : TypeDef<Milo_Dialect, "String"> {
  let mnemonic = "string";
}

// A struct by value, named as legacy codegen names its LLVM type (`%Point`), with its
// fields' types in declaration order: `!milo.struct<"Point", si64, f64>`. It lowers to
// the identified LLVM struct of that name, so a spliced body uses the module's own
// definition and the layout is LLVM's natural one, which is legacy's.
// A type with its own `impl Drop` says so after its name, `!milo.struct<"Noisy" drop, si64>`
// (enums the same way): it has drop glue whatever its fields are, and the glue runs the
// user's drop first (legacy's, through milo.drop.<key>).
// Structs and enums are identified by name, as LLVM's identified structs are: the body is
// set once, after the type exists, so a type can hold itself through a Vec (a JSON value,
// a tree). Inside its own body it is spelled by name alone, `!milo.enum<"Json">`, which is
// the same type. A second body for a name must equal the first (the parser checks).
def Milo_StructType : TypeDef<Milo_Dialect, "Struct", [MutableType]> {
  let mnemonic = "struct";
  let storageClass = "StructTypeStorage";
  let genStorageClass = 0;
  let parameters = (ins StringRefParameter<>:$name);
  let hasCustomAssemblyFormat = 1;
  let extraClassDeclaration = [{
    ::llvm::ArrayRef<::mlir::Type> getFields() const;
    bool getUserDrop() const;
    bool isInitialized() const;
    // Fails when the body was already set to another one.
    ::mlir::LogicalResult setBody(::llvm::ArrayRef<::mlir::Type> fields, bool userDrop);
  }];
}

// A tagged enum by value, with the layout legacy codegen computed (EnumLayout), spelled
// out so nothing here recomputes it: `size` bytes stored as `[size/align x i(8*align)]`
// (or `{ i32 }` when size is 0, a fieldless enum), the i32 tag in bytes 0..4, and each
// variant's fields at the byte offsets after `at`:
//   !milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16), 2: ()]>
// Niche-packed enums (EnumLayout.niche) have no tag word and are not expressible here.
def Milo_EnumType : TypeDef<Milo_Dialect, "Enum", [MutableType]> {
  let mnemonic = "enum";
  let storageClass = "EnumTypeStorage";
  let genStorageClass = 0;
  let parameters = (ins StringRefParameter<>:$name);
  let hasCustomAssemblyFormat = 1;
  let extraClassDeclaration = [{
    int64_t getSize() const;
    int64_t getAlign() const;
    ::llvm::ArrayRef<int32_t> getTags() const;
    ::llvm::ArrayRef<::mlir::TupleType> getVariants() const;
    ::llvm::ArrayRef<int64_t> getOffsets() const;
    bool getUserDrop() const;
    bool isInitialized() const;
    // Checks the layout, then sets it; fails when it was already set to another one.
    ::mlir::LogicalResult setBody(::llvm::function_ref<::mlir::InFlightDiagnostic()> emitError,
                                  int64_t size, int64_t align, ::llvm::ArrayRef<int32_t> tags,
                                  ::llvm::ArrayRef<::mlir::TupleType> variants,
                                  ::llvm::ArrayRef<int64_t> offsets, bool userDrop);
    // The variant with this tag, or -1.
    int variantOf(int32_t tag) const;
    // Byte offset of field `k` of variant `v`.
    int64_t offsetOf(unsigned v, unsigned k) const;
  }];
}

// A fixed-size array `[T; N]`, legacy's `[N x T]`. Held only in places, as a 128+ byte
// aggregate is, whatever its size: an SSA value exists only at the ABI (a by-value param
// or argument), so a large buffer is never split per element. Its elements own nothing.
def Milo_ArrayType : TypeDef<Milo_Dialect, "Array"> {
  let mnemonic = "array";
  let parameters = (ins "::mlir::Type":$elementType, "int64_t":$size);
  let assemblyFormat = "`<` $elementType `,` $size `>`";
}

def Milo_Aggregate : AnyTypeOf<[Milo_StructType, Milo_EnumType, Milo_ArrayType]>;

// A fn value `(T) => R`: legacy's `{ ptr fn, ptr env }`. The fn takes the env first, then
// the params of `signature` (a `&T` param is a !milo.ref, a `&Vec<T>` a !milo.vec). A
// plain one's env is null or a frame's (milo.closure), never owned, so the value is Copy
// and has no drop glue. An `owning` one (`move (T) => R`, `!milo.fn<owning (T) -> R>`)
// holds a heap env whose first word is its drop glue: it is an owned value, dropped
// through legacy's glue for owning closures (milo.drop.ownfn).
def Milo_FnType : TypeDef<Milo_Dialect, "Fn"> {
  let mnemonic = "fn";
  let parameters = (ins "::mlir::FunctionType":$signature, "bool":$owning);
  let hasCustomAssemblyFormat = 1;
}

// What a local, a parameter or a result can hold.
def Milo_Value : AnyTypeOf<[Milo_Scalar, Milo_PtrType, Milo_Aggregate, Milo_StringType, Milo_VecValType, Milo_MapType, Milo_HeapType, Milo_DynType, Milo_FnType]>;
// What compares and casts.
def Milo_Simple : AnyTypeOf<[Milo_Scalar, Milo_PtrType]>;

// `S { a: x, b: y }`: the fields in declaration order (the emitter evaluates them in
// source order first).
def Milo_StructNewOp : Milo_Op<"struct.new", [Pure]> {
  let arguments = (ins Variadic<Milo_Value>:$fields);
  let results = (outs Milo_StructType:$result);
  let assemblyFormat = "($fields^ `:` type($fields))? attr-dict `->` type($result)";
  let hasVerifier = 1;
}

// Field `index` of a struct value.
def Milo_StructGetOp : Milo_Op<"struct.get", [Pure]> {
  let arguments = (ins Milo_StructType:$value, I64Attr:$index);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$value `[` $index `]` attr-dict `:` type($value) `->` type($result)";
  let hasVerifier = 1;
}

// The place of field `index` inside the struct at `ref`: still second-class, it only
// feeds loads, stores and by-ref arguments.
def Milo_FieldRefOp : Milo_Op<"field_ref", [Pure]> {
  let arguments = (ins Milo_RefType:$ref, I64Attr:$index);
  let results = (outs Milo_RefType:$result);
  let assemblyFormat = "$ref `[` $index `]` attr-dict `:` type($ref) `->` type($result)";
  let hasVerifier = 1;
}

// `E.V(args)`: the variant with tag `tag`, its payload fields from the operands.
def Milo_EnumNewOp : Milo_Op<"enum.new", [Pure]> {
  let arguments = (ins I32Attr:$tag, Variadic<Milo_Value>:$fields);
  let results = (outs Milo_EnumType:$result);
  let assemblyFormat = "$tag ( `(` $fields^ `:` type($fields) `)` )? attr-dict `->` type($result)";
  let hasVerifier = 1;
}

// The tag of an enum value (`x is V` compares it; milo.match switches on it).
def Milo_EnumTagOp : Milo_Op<"enum.tag", [Pure]> {
  let arguments = (ins Milo_EnumType:$value);
  let results = (outs SI32:$tag);
  let assemblyFormat = "$value attr-dict `:` type($value)";
}

// Field `index` of the payload of variant `tag`. Meaningful only when the value has that
// tag: milo-lower-structured-cf makes these at the entry of the arm that matched it.
def Milo_EnumPayloadOp : Milo_Op<"enum.payload", [Pure]> {
  let arguments = (ins Milo_EnumType:$value, I32Attr:$tag, I64Attr:$index);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$value `[` $tag `,` $index `]` attr-dict `:` type($value) `->` type($result)";
  let hasVerifier = 1;
}

// The place of field `index` of the payload of variant `tag`, inside the enum at `ref`:
// what a `&mut` match subject binds, so an assignment to the binding writes the payload.
// Meaningful only while the enum has that tag (inside the arm that matched it).
def Milo_EnumFieldRefOp : Milo_Op<"enum.field_ref", [Pure]> {
  let arguments = (ins Milo_RefType:$ref, I32Attr:$tag, I64Attr:$index);
  let results = (outs Milo_RefType:$result);
  let assemblyFormat = "$ref `[` $tag `,` $index `]` attr-dict `:` type($ref) `->` type($result)";
  let hasVerifier = 1;
}

// The tag of the enum at `ref`, read in place: how a 128+ byte enum, never an SSA value,
// is matched (a switch on this, payload bindings through enum.field_ref).
def Milo_EnumTagAtOp : Milo_Op<"enum.tag_at"> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead<Milo_Slot>]>:$ref);
  let results = (outs SI32:$tag);
  let assemblyFormat = "$ref attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

// The tag of the enum at `ref` written in place: with the payload stored through
// enum.field_ref, how a 128+ byte enum literal is built where it lives.
def Milo_EnumSetTagOp : Milo_Op<"enum.set_tag"> {
  let arguments = (ins Arg<Milo_RefType, "", [MemWrite<Milo_Slot>]>:$ref, I32Attr:$tag);
  let assemblyFormat = "$ref `,` $tag attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

// A string literal: the bytes as a private constant, len, cap 0.
def Milo_StringLitOp : Milo_Op<"string.lit", [Pure]> {
  let arguments = (ins StrAttr:$value);
  let results = (outs Milo_StringType:$result);
  let assemblyFormat = "$value attr-dict";
}

// `print(a, b, ...)` (or `eprint` with `stderr`): each part displayed the way Milo
// displays its type, then a newline. Lowered to one call of a function the legacy module
// defines for exactly this sequence of part types (codegen mlirPrintHelper), so the text
// is legacy's byte for byte. Writes a stream: no traits, so nothing moves it or drops it.
// `partial`: the first parts of one print, up to and including a string part, with no
// newline (legacy writes a string part as soon as it is evaluated).
def Milo_PrintOp : Milo_Op<"print"> {
  let arguments = (ins Variadic<AnyType>:$parts, UnitAttr:$stderr, UnitAttr:$partial);
  let assemblyFormat = "(`stderr` $stderr^)? (`partial` $partial^)? ($parts^ `:` type($parts))? attr-dict";
  let hasVerifier = 1;
}

def Milo_PtrLoadOp : Milo_Op<"ptr.load"> {
  let arguments = (ins Arg<Milo_PtrType, "", [MemRead]>:$ptr);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$ptr attr-dict `:` type($result)";
}

def Milo_PtrStoreOp : Milo_Op<"ptr.store"> {
  let arguments = (ins Milo_Value:$value, Arg<Milo_PtrType, "", [MemWrite]>:$ptr);
  let assemblyFormat = "$value `,` $ptr attr-dict `:` type($value)";
}

// A `T` copied from one place to another, as legacy's llvm.memcpy: how a 128+ byte
// aggregate moves between places without becoming an SSA value (SROA splits a whole
// aggregate load per element). Either side is a slot (!milo.ref<T>) or a raw pointer to a
// T. It moves no ownership by itself: an owned source that gives its value up is emptied
// right after with an unused milo.move, an owned destination is marked milo.filled.
def Milo_CopyOp : Milo_Op<"copy"> {
  let arguments = (ins Arg<AnyTypeOf<[Milo_RefType, Milo_PtrType]>, "", [MemRead]>:$src,
                       Arg<AnyTypeOf<[Milo_RefType, Milo_PtrType]>, "", [MemWrite]>:$dst,
                       TypeAttr:$elem);
  let assemblyFormat = "$src `,` $dst attr-dict `:` type($src) `,` type($dst) `of` $elem";
  let hasVerifier = 1;
}

// `p[i]` on a `*T` as a place: the address of element `i` (unchecked, as in C). The
// element is then read and written with ptr.load/ptr.store, whose unknown memory may be a
// Vec's header or elements: std's Vec methods write their header this way, so a place
// reached through a pointer is never a milo.ref (whose Slot resource excludes both).
def Milo_PtrElemOp : Milo_Op<"ptr.elem", [Pure]> {
  let arguments = (ins Milo_PtrType:$ptr, SI64:$index, TypeAttr:$elem);
  let results = (outs Milo_PtrType:$result);
  let assemblyFormat = "$ptr `[` $index `]` `:` $elem attr-dict";
}

// The address of field `index` of the struct at `ptr`.
def Milo_PtrFieldOp : Milo_Op<"ptr.field", [Pure]> {
  let arguments = (ins Milo_PtrType:$ptr, I64Attr:$index, TypeAttr:$record);
  let results = (outs Milo_PtrType:$result);
  let assemblyFormat = "$ptr `[` $index `]` `:` $record attr-dict";
  let hasVerifier = 1;
}

// `x.addrOf()` on a place (unsafe): its address as a raw pointer, which may outlive the
// borrow; what it may then touch is the unsafe code's promise.
def Milo_AddrOp : Milo_Op<"addr", [Pure]> {
  let arguments = (ins AnyTypeOf<[Milo_RefType, Milo_VecType]>:$place);
  let results = (outs Milo_PtrType:$result);
  let assemblyFormat = "$place attr-dict `:` type($place)";
}

// A string's data pointer (its bytes, no NUL promised): `s as *u8` and the bytes a
// `for b in s` walks, as legacy reads field 0 of %String. The ODS types are its verifier.
def Milo_StringDataOp : Milo_Op<"string.data", [Pure]> {
  let arguments = (ins Milo_StringType:$value);
  let results = (outs Milo_PtrType:$result);
  let assemblyFormat = "$value attr-dict";
}

// `zeroed<T>()`: every byte of a T zero, legacy's zeroinitializer. For a string or a Vec
// that is the empty one (null data, cap 0), whose drop does nothing.
def Milo_ZeroOp : Milo_Op<"zero", [Pure]> {
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "attr-dict `:` type($result)";
  let hasVerifier = 1;
}

def Milo_ConstOp : Milo_Op<"const", [ConstantLike, Pure,
    AllTypesMatch<["value", "result"]>]> {
  let summary = "an int, float or bool literal";
  let arguments = (ins TypedAttrInterface:$value);
  let results = (outs Milo_Scalar:$result);
  let assemblyFormat = "$value attr-dict";
  // ConstantLike: generic folds (an arith.select canonicalize made from a branch) read
  // the value through this.
  let hasFolder = 1;
}

// `wrapping` is Milo's @wrapping (or --no-overflow-checks for + - *): two's complement
// instead of a panic. Without it an integer op panics where Milo panics, with a message
// naming the op's location. Float ops never trap and never carry it.
class Milo_ArithOp<string mnemonic, Type operandType>
    : Milo_Op<mnemonic, [SameOperandsAndResultType,
        DeclareOpInterfaceMethods<MemoryEffectsOpInterface>]> {
  let arguments = (ins operandType:$lhs, operandType:$rhs, UnitAttr:$wrapping);
  let results = (outs operandType:$result);
  let assemblyFormat = "$lhs `,` $rhs (`wrapping` $wrapping^)? attr-dict `:` type($result)";
  let hasVerifier = 1;
}

// + - *: panic on overflow unless `wrapping`.
def Milo_AddOp : Milo_ArithOp<"add", Milo_Number>;
def Milo_SubOp : Milo_ArithOp<"sub", Milo_Number>;
def Milo_MulOp : Milo_ArithOp<"mul", Milo_Number>;
// / %: an integer divisor of zero always panics; signed MIN / -1 panics unless
// `wrapping`, which yields MIN (quotient) or 0 (remainder).
def Milo_DivOp : Milo_ArithOp<"div", Milo_Number>;
def Milo_RemOp : Milo_ArithOp<"rem", Milo_Number>;
// << >>: an amount >= the bit width (or negative) panics unless `wrapping`, which masks
// it to the width. `>>` is arithmetic on signed ints, logical on unsigned.
def Milo_ShlOp : Milo_ArithOp<"shl", Milo_Int>;
def Milo_ShrOp : Milo_ArithOp<"shr", Milo_Int>;

class Milo_BitOp<string mnemonic> : Milo_Op<mnemonic, [Pure, SameOperandsAndResultType]> {
  let arguments = (ins Milo_Bits:$lhs, Milo_Bits:$rhs);
  let results = (outs Milo_Bits:$result);
  let assemblyFormat = "$lhs `,` $rhs attr-dict `:` type($result)";
}
def Milo_AndOp : Milo_BitOp<"and">;
def Milo_OrOp : Milo_BitOp<"or">;
def Milo_XorOp : Milo_BitOp<"xor">;

// Unary `-`: panics on overflow (signed MIN, any nonzero unsigned) unless `wrapping`.
def Milo_NegOp : Milo_Op<"neg", [SameOperandsAndResultType,
    DeclareOpInterfaceMethods<MemoryEffectsOpInterface>]> {
  let arguments = (ins Milo_Number:$operand, UnitAttr:$wrapping);
  let results = (outs Milo_Number:$result);
  let assemblyFormat = "$operand (`wrapping` $wrapping^)? attr-dict `:` type($result)";
  let hasVerifier = 1;
}
// `!` on bool, `~` on an int.
def Milo_NotOp : Milo_Op<"not", [Pure, SameOperandsAndResultType]> {
  let arguments = (ins Milo_Bits:$operand);
  let results = (outs Milo_Bits:$result);
  let assemblyFormat = "$operand attr-dict `:` type($result)";
}

def Milo_CmpPredicate : I64EnumAttr<"CmpPredicate", "comparison", [
    I64EnumAttrCase<"eq", 0>, I64EnumAttrCase<"ne", 1>, I64EnumAttrCase<"lt", 2>,
    I64EnumAttrCase<"le", 3>, I64EnumAttrCase<"gt", 4>, I64EnumAttrCase<"ge", 5>]> {
  let cppNamespace = "::milo";
}

// Signedness comes from the operand type (bool compares as signed i1, as legacy codegen
// does). On floats every comparison is ordered except `ne`, which holds when either side
// is NaN, so `x != x` is true for NaN.
def Milo_CmpOp : Milo_Op<"cmp", [Pure, SameTypeOperands]> {
  let arguments = (ins Milo_CmpPredicate:$predicate, Milo_Simple:$lhs, Milo_Simple:$rhs);
  let results = (outs I1:$result);
  let assemblyFormat = "$predicate `,` $lhs `,` $rhs attr-dict `:` type($lhs)";
}

// `x as T` between scalars. Float to int saturates (NaN is 0); it never traps.
def Milo_CastOp : Milo_Op<"cast", [Pure]> {
  let arguments = (ins Milo_Simple:$operand);
  let results = (outs Milo_Simple:$result);
  let assemblyFormat = "$operand attr-dict `:` type($operand) `to` type($result)";
}

// `var name`: a mutable local. Must sit in the function's entry block, so the frame is
// fixed: a slot allocated inside a loop would grow the stack every iteration.
//
// `owned`: the slot holds a value with drop glue (a string, a Vec) that it owns. Such a
// slot is listed by the milo.scope that owns it; from there on the IR says only where the
// value is stored (milo.store), moved out (milo.move) and read in place (milo.load, a view
// that never owns), and milo-scope-drops / milo-elaborate-drops decide where it dies.
def Milo_VarOp : Milo_Op<"var"> {
  let arguments = (ins StrAttr:$name, UnitAttr:$owned);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$name (`owned` $owned^)? attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

// A lexical scope that owns the slots it lists: whatever they still hold dies when control
// leaves it, by falling off its end or by a break, continue or return out of it
// (milo-scope-drops puts the drops there). With results it yields them, like milo.if.
def Milo_ScopeOp : Milo_Op<"scope", [NoRegionArguments, RecursiveMemoryEffects]> {
  let arguments = (ins Variadic<Milo_RefType>:$slots);
  let results = (outs Variadic<Milo_Value>:$results);
  let regions = (region SizedRegion<1>:$body);
  let assemblyFormat = "($slots^ `:` type($slots))? (`->` type($results)^)? $body attr-dict";
  let hasVerifier = 1;
}

// The owned slot `ref` now holds a value that was written into it in place (field by
// field, or by an sret call through its address) rather than by milo.store: for drop
// elaboration it is a store. A 128+ byte aggregate is filled this way, never loaded whole.
def Milo_FilledOp : Milo_Op<"filled"> {
  let arguments = (ins Arg<Milo_RefType, "", [MemWrite<Milo_Slot>]>:$ref);
  let assemblyFormat = "$ref attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

// The value in an owned slot, moved out: the slot holds nothing after it.
def Milo_MoveOp : Milo_Op<"move", [
    TypesMatchWith<"result is the slot's type", "ref", "result",
                   "::llvm::cast<RefType>($_self).getPointee()">]> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead<Milo_Slot>, MemWrite<Milo_Slot>]>:$ref);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$ref attr-dict `:` type($ref)";
}

// The value in the slot dies: its drop glue runs (legacy's, codegen mlirDropHelper). On an
// owned slot this is "if it holds one" until milo-elaborate-drops decides: it erases the
// drop where the slot is empty on every path, keeps it where it is full on every path,
// and gives it the slot's drop flag (`if %flag`) where that differs by path. On any other
// place (a `&mut` param, a field) it always holds one.
def Milo_DropOp : Milo_Op<"drop"> {
  let arguments = (ins Milo_RefType:$ref, Optional<I1>:$flag);
  let assemblyFormat = "$ref (`if` $flag^)? attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

// The header of the Vec in a slot, for indexing and len: the same address.
def Milo_VecPlaceOp : Milo_Op<"vec.place", [Pure]> {
  let arguments = (ins Milo_RefType:$ref);
  let results = (outs Milo_VecType:$vec);
  let assemblyFormat = "$ref attr-dict `:` type($ref) `->` type($vec)";
  let hasVerifier = 1;
}

// The Vec `vec` moved into the owned slot `ref` with its cursor at 0. A fill in place: the
// emitter follows it with milo.filled.
def Milo_VecTailInitOp : Milo_Op<"vectail.init"> {
  let arguments = (ins Milo_VecValType:$vec, Arg<Milo_RefType, "", [MemWrite<Milo_Slot>]>:$ref);
  let assemblyFormat = "$vec `,` $ref attr-dict `:` type($vec) `,` type($ref)";
  let hasVerifier = 1;
}

// The header of the Vec in a vectail slot, for its data pointer and len: the same address.
def Milo_VecTailVecOp : Milo_Op<"vectail.vec", [Pure]> {
  let arguments = (ins Milo_RefType:$ref);
  let results = (outs Milo_VecType:$vec);
  let assemblyFormat = "$ref attr-dict `:` type($ref) `->` type($vec)";
  let hasVerifier = 1;
}

// Element `index` moved out of the vectail in `ref`, and the cursor set past it: from here
// on the element is the result's, not the Vec's. Unchecked: the loop condition keeps
// `index` below len, and the elements come in order, so the cursor only moves forward.
def Milo_VecTailTakeOp : Milo_Op<"vectail.take"> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead<Milo_Slot>, MemWrite<Milo_Slot>, MemRead<Milo_VecHeader>, MemRead<Milo_VecElems>]>:$ref,
                       SI64:$index);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$ref `[` $index `]` attr-dict `:` type($ref) `->` type($result)";
  let hasVerifier = 1;
}

// vectail.take for a place-only element (128+ bytes, or holding an array): the element's
// place, which the caller copies out of (milo.copy), with the cursor set past it.
def Milo_VecTailTakePlaceOp : Milo_Op<"vectail.take_place"> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead<Milo_Slot>, MemWrite<Milo_Slot>, MemRead<Milo_VecHeader>]>:$ref,
                       SI64:$index);
  let results = (outs Milo_RefType:$result);
  let assemblyFormat = "$ref `[` $index `]` attr-dict `:` type($ref) `->` type($result)";
  let hasVerifier = 1;
}

// `Heap.new(v)`: a box of T's size from malloc, `value` moved into it. It allocates, so
// two are never one (not Pure).
def Milo_HeapNewOp : Milo_Op<"heap.new"> {
  let arguments = (ins Milo_Value:$value);
  let results = (outs Arg<Milo_HeapType, "", [MemAlloc]>:$result);
  let assemblyFormat = "$value attr-dict `:` type($value) `->` type($result)";
  let hasVerifier = 1;
}

// `*h`: the place of the T in the box, the box's pointer itself.
def Milo_HeapPlaceOp : Milo_Op<"heap.place", [Pure]> {
  let arguments = (ins Milo_HeapType:$heap);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$heap attr-dict `:` type($heap) `->` type($ref)";
  let hasVerifier = 1;
}

// The box freed and its payload not dropped: what is left after the payload moved out
// (`let x = *h`), as legacy's genHeapMoveOut frees it.
def Milo_HeapFreeOp : Milo_Op<"heap.free"> {
  let arguments = (ins Arg<Milo_HeapType, "", [MemFree]>:$heap);
  let assemblyFormat = "$heap attr-dict `:` type($heap)";
}

// `m.len()` of a HashMap value (a view is enough): the header's len field.
def Milo_MapLenOp : Milo_Op<"map.len", [Pure]> {
  let arguments = (ins Milo_MapType:$value);
  let results = (outs SI64:$len);
  let assemblyFormat = "$value attr-dict `:` type($value)";
}

// `v.ptr()`: the Vec's data pointer, read out of its header.
def Milo_VecDataOp : Milo_Op<"vec.data"> {
  let arguments = (ins Arg<Milo_VecType, "", [MemRead<Milo_VecHeader>]>:$vec);
  let results = (outs Milo_PtrType:$result);
  let assemblyFormat = "$vec attr-dict `:` type($vec)";
}

// `Vec.new()`: no buffer, len 0, cap 0.
def Milo_VecNewOp : Milo_Op<"vec.new", [Pure]> {
  let results = (outs Milo_VecValType:$result);
  let assemblyFormat = "attr-dict `:` type($result)";
}

// `s.len()` of a string value (a view is enough).
def Milo_StringLenOp : Milo_Op<"string.len", [Pure]> {
  let arguments = (ins Milo_StringType:$value);
  let results = (outs SI64:$len);
  let assemblyFormat = "$value attr-dict";
}

// `s[i]`: byte `i` of the string, after legacy's bounds check (`__milo_bounds_fail` with
// the op's location, the same panic as a Vec index).
def Milo_StringByteOp : Milo_Op<"string.byte",
    [MemoryEffects<[MemRead, MemWrite<Milo_Panic>]>]> {
  let arguments = (ins Milo_StringType:$value, SI64:$index);
  let results = (outs UI8:$byte);
  let assemblyFormat = "$value `[` $index `]` attr-dict";
}

// `a + b` on strings: a new owned string, made by legacy's concatenation (a helper of the
// legacy module, `milo.string.concat`, the operands through slots). Allocates, so two are
// never merged: each result is an owner of its own.
def Milo_StringConcatOp : Milo_Op<"string.concat", [MemoryEffects<[MemRead, MemAlloc]>]> {
  let arguments = (ins Milo_StringType:$lhs, Milo_StringType:$rhs);
  let results = (outs Milo_StringType:$result);
  let assemblyFormat = "$lhs `,` $rhs attr-dict";
}

// The bytes of `value` appended to the string at `dst`, in place: legacy's pushStr
// (amortized growth; a shared buffer is made unique first). milo-append-in-place makes
// these out of `s = s + x`.
def Milo_StringAppendOp : Milo_Op<"string.append", [MemoryEffects<[MemRead, MemWrite]>]> {
  let arguments = (ins Milo_RefType:$dst, Milo_StringType:$value);
  let assemblyFormat = "$dst `,` $value attr-dict `:` type($dst)";
  let hasVerifier = 1;
}

// A new owner of the string at `ref` (Milo's implicit copy of a string, HIR StringClone):
// legacy's share, one more count on a heap buffer.
// It writes that count, so two shares of one place are two owners: CSE must not fold them.
def Milo_StringShareOp : Milo_Op<"string.share", [MemoryEffects<[MemWrite]>]> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead<Milo_Slot>]>:$ref);
  let results = (outs Milo_StringType:$result);
  let assemblyFormat = "$ref attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

def Milo_LoadOp : Milo_Op<"load", [
    TypesMatchWith<"result is the slot's type", "ref", "result",
                   "::llvm::cast<RefType>($_self).getPointee()">]> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead<Milo_Slot>]>:$ref);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$ref attr-dict `:` type($ref)";
}

// Before a call with two by-ref arguments of which one is `&mut`: panics if they are the
// same place. The checker rejects the aliasing it can prove; this is the runtime half, and
// what makes `noalias` on a `&mut` param sound.
def Milo_CheckUnaliasedOp : Milo_Op<"check_unaliased",
    [MemoryEffects<[MemWrite<Milo_Panic>]>]> {
  let arguments = (ins AnyTypeOf<[Milo_RefType, Milo_VecType]>:$lhs,
                       AnyTypeOf<[Milo_RefType, Milo_VecType]>:$rhs);
  let assemblyFormat = "$lhs `,` $rhs attr-dict `:` type($lhs) `,` type($rhs)";
}

// Entry to and exit from a record/replay engine function (std/replay; HIRFunction
// replayEngine): while the recorder's heap switch is on, the engine's own allocations go
// to libc's malloc rather than the recorded fixed-address heap, so their nesting depth is
// counted in `replay$rrDepth`. Enter at the top of the body, exit before every return.
def Milo_ReplayEnterOp : Milo_Op<"replay.enter"> {
  let assemblyFormat = "attr-dict";
}
def Milo_ReplayExitOp : Milo_Op<"replay.exit"> {
  let assemblyFormat = "attr-dict";
}

// Source-level Vec access through a `&Vec<T>` / `&mut Vec<T>` (or slice) param, as the
// language writes it: `v[i]`, `v[i] = x`, `v.len()`. The index is Milo's i64 (narrower
// ints are cast to it first, by their own signedness). milo-expand-index lowers these to
// vec.len, bounds_check and vec.load/store above, which the loop passes understand.
def Milo_IndexOp : Milo_Op<"index"> {
  let arguments = (ins Milo_VecType:$vec, SI64:$index);
  let results = (outs Milo_Scalar:$result);
  let assemblyFormat = "$vec `[` $index `]` attr-dict `:` type($vec) `->` type($result)";
  let hasVerifier = 1;
}

def Milo_IndexStoreOp : Milo_Op<"index.store"> {
  let arguments = (ins Milo_Scalar:$value, Milo_VecType:$vec, SI64:$index);
  let assemblyFormat = "$value `,` $vec `[` $index `]` attr-dict `:` type($value) `,` type($vec)";
  let hasVerifier = 1;
}

// `v[i]` as a place, for an element that is not a scalar: its address after legacy's
// bounds check (the panic names the op's location), lent to a `&T` argument, read or
// written field by field, or stored over. Read as a value it is a load, or for an owning
// element legacy's deep copy of the place. milo-expand-index lowers it to len,
// bounds_check and vec.elem_ref.
def Milo_IndexRefOp : Milo_Op<"index.ref"> {
  let arguments = (ins Milo_VecType:$vec, SI64:$index);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$vec `[` $index `]` attr-dict `:` type($vec) `->` type($ref)";
  let hasVerifier = 1;
}

// The place of element `index`, unchecked (the bounds_check is before it): reads only the
// header's data pointer.
def Milo_VecElemRefOp : Milo_Op<"vec.elem_ref"> {
  let arguments = (ins Arg<Milo_VecType, "", [MemRead<Milo_VecHeader>]>:$vec, I64:$index);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$vec `[` $index `]` attr-dict `:` type($vec) `->` type($ref)";
  let hasVerifier = 1;
}

// `a[i]` on the place of a fixed-size array: the element's place after legacy's bounds
// check against the size (genBoundsCheckedPtr; the panic names the op's location).
// milo-expand-index lowers it to bounds_check and array.elem_ref.
def Milo_ArrayIndexOp : Milo_Op<"array.index"> {
  let arguments = (ins Milo_RefType:$array, SI64:$index);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$array `[` $index `]` attr-dict `:` type($array) `->` type($ref)";
  let hasVerifier = 1;
}

// The place of element `index` of an array place, unchecked.
def Milo_ArrayElemRefOp : Milo_Op<"array.elem_ref", [Pure]> {
  let arguments = (ins Milo_RefType:$array, I64:$index);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$array `[` $index `]` attr-dict `:` type($array) `->` type($ref)";
  let hasVerifier = 1;
}

def Milo_LenOp : Milo_Op<"len",
    [MemoryEffects<[MemRead<Milo_VecHeader>]>]> {
  let arguments = (ins Milo_VecType:$vec);
  let results = (outs SI64:$len);
  let assemblyFormat = "$vec attr-dict `:` type($vec)";
}

// `init`: the place holds no value yet (a lazy global's first fill, HIR Assign isInit), so
// nothing is dropped before the store even when the type has drop glue.
def Milo_StoreOp : Milo_Op<"store", [
    TypesMatchWith<"value is the slot's type", "ref", "value",
                   "::llvm::cast<RefType>($_self).getPointee()">]> {
  let arguments = (ins Milo_Value:$value, Arg<Milo_RefType, "", [MemWrite<Milo_Slot>]>:$ref,
                       UnitAttr:$init);
  let assemblyFormat = "$value `,` $ref (`init` $init^)? attr-dict `:` type($ref)";
}

// The place of module global `name` (a `let`/`var` at module level), defined by the legacy
// module. Not an owned slot: what it holds outlives every function, so no scope drops it;
// a store over it drops the old value (milo-scope-drops), as through a `&mut` param.
// `thread_local`: a `thread_local` global, one per OS thread. Its address is taken as legacy
// takes it (a plain use of the symbol), so it is as constant within a function here as it
// is there.
def Milo_GlobalOp : Milo_Op<"global", [Pure]> {
  let arguments = (ins StrAttr:$name, UnitAttr:$tls);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$name (`thread_local` $tls^)? attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

// A by-reference closure literal: `fn` is its body, a func.func taking `(!milo.ptr env,
// params...)`, and the env (an entry-block slot of this frame: null drop header, then
// the captures' addresses in order) lends it every capture in place. The checker keeps
// such a closure from outliving the frame; no captures means a null env. Not Pure: the
// body may write any capture whenever the value is called.
// A fn value retyped between owning and plain, with the same signature and bits. Plain to
// owning: a named fn's trampoline or a frame closure handed to a `move` param; the owning
// drop glue skips a null env and a null header, so dropping it frees nothing. Owning to
// plain: a `move` closure stored into a plain fn field, where nobody drops it (legacy
// leaks its env the same way).
def Milo_FnCastOp : Milo_Op<"fn.cast", [Pure]> {
  let arguments = (ins Milo_FnType:$value);
  let results = (outs Milo_FnType:$result);
  let assemblyFormat = "$value attr-dict `:` type($value) `->` type($result)";
  let hasVerifier = 1;
}

def Milo_ClosureOp : Milo_Op<"closure"> {
  let arguments = (ins FlatSymbolRefAttr:$fn,
                       Variadic<AnyTypeOf<[Milo_RefType, Milo_VecType]>>:$captures);
  let results = (outs Milo_FnType:$result);
  let assemblyFormat = "$fn (`(` $captures^ `:` type($captures) `)`)? attr-dict `:` type($result)";
  let hasVerifier = 1;
}

// Inside a closure body: the place of capture `index`, read out of the env, which must be
// the function's first argument.
def Milo_EnvCaptureOp : Milo_Op<"env.capture", [Pure]> {
  let arguments = (ins Milo_PtrType:$env, I64Attr:$index);
  let results = (outs AnyTypeOf<[Milo_RefType, Milo_VecType]>:$place);
  let assemblyFormat = "$env `[` $index `]` attr-dict `:` type($place)";
  let hasVerifier = 1;
}

// `f(args)` through a fn value: its fn pointer called with its env first. Unknown code,
// so no traits.
def Milo_ClosureCallOp : Milo_Op<"closure.call"> {
  let arguments = (ins Milo_FnType:$callee, Variadic<AnyType>:$args);
  let results = (outs Optional<Milo_Value>:$result);
  let assemblyFormat = "$callee `(` $args `)` attr-dict `:` type($callee) (`,` type($args)^)? (`->` type($result)^)?";
  let hasVerifier = 1;
}

// Lazy global `name` is filled before the next statement reads it: a call of legacy's
// guarded entry (`__milo.lazy.<name>`, src/lazy-globals.ts), which runs the initializer
// the first time. It runs arbitrary code, so it declares no effects (any memory).
def Milo_GlobalInitOp : Milo_Op<"global.init"> {
  let arguments = (ins StrAttr:$name);
  let assemblyFormat = "$name attr-dict";
  let hasVerifier = 1;
}

// `if cond { } else { }`. With results it is an expression (`&&`, `||`): both regions
// then yield values of the result types. A region may instead end in return, break,
// continue or unreachable.
def Milo_IfOp : Milo_Op<"if", [NoRegionArguments, RecursiveMemoryEffects]> {
  let arguments = (ins I1:$condition);
  let results = (outs Variadic<Milo_Value>:$results);
  let regions = (region MinSizedRegion<1>:$thenRegion, AnyRegion:$elseRegion);
  let assemblyFormat = "$condition (`->` type($results)^)? $thenRegion (`else` $elseRegion^)? attr-dict";
  let hasVerifier = 1;
}

// `while cond { body }`: the cond region ends in milo.condition, the body in a yield
// (next iteration) or a jump.
def Milo_WhileOp : Milo_Op<"while", [NoRegionArguments, RecursiveMemoryEffects]> {
  let regions = (region MinSizedRegion<1>:$condRegion, MinSizedRegion<1>:$bodyRegion);
  let assemblyFormat = "$condRegion `do` $bodyRegion attr-dict";
}

// `while true { body }`: only break or return leaves it.
def Milo_LoopOp : Milo_Op<"loop", [NoRegionArguments, RecursiveMemoryEffects]> {
  let regions = (region MinSizedRegion<1>:$bodyRegion);
  let assemblyFormat = "$bodyRegion attr-dict";
}

// `for i in start..end { body }`: both bounds evaluated once, before the loop; the body's
// entry block argument is `i`, immutable inside the body. `<` follows the signedness of
// the type and the step is a plain (wrapping) +1, as legacy codegen emits it: i < end
// already bounds i, so the step cannot overflow.
def Milo_ForOp : Milo_Op<"for", [RecursiveMemoryEffects, AllTypesMatch<["start", "end"]>]> {
  let arguments = (ins Milo_Int:$start, Milo_Int:$end);
  let regions = (region MinSizedRegion<1>:$bodyRegion);
  let assemblyFormat = "$start `to` $end `:` type($start) $bodyRegion attr-dict";
  let hasVerifier = 1;
}

// `match subject { arms }`, one region per arm. On an enum, `cases` holds each arm's tag
// and the arm's entry block takes that variant's payload fields as arguments (what the
// pattern binds); on an int or bool, `cases` are the literal values and arms take none.
// With `default` the last region is the `_` arm; without one, a value matching no case
// is unreachable (the checker proved the match exhaustive). With results it is an
// expression: each arm yields them or ends in a jump.
def Milo_MatchOp : Milo_Op<"match", [RecursiveMemoryEffects]> {
  let arguments = (ins AnyTypeOf<[Milo_EnumType, Milo_Int, I1]>:$subject,
                       DenseI64ArrayAttr:$cases, UnitAttr:$hasDefault);
  let results = (outs Variadic<Milo_Value>:$results);
  let regions = (region VariadicRegion<MinSizedRegion<1>>:$arms);
  let assemblyFormat = "$subject `:` type($subject) (`->` type($results)^)? $cases (`default` $hasDefault^)? $arms attr-dict";
  let hasVerifier = 1;
}

def Milo_YieldOp : Milo_Op<"yield", [Pure, Terminator,
    ParentOneOf<["IfOp", "WhileOp", "LoopOp", "ForOp", "MatchOp", "ScopeOp"]>]> {
  let arguments = (ins Variadic<Milo_Value>:$values);
  let assemblyFormat = "($values^ `:` type($values))? attr-dict";
  let hasVerifier = 1;
}

def Milo_ConditionOp : Milo_Op<"condition", [Pure, Terminator, HasParent<"WhileOp">]> {
  let arguments = (ins I1:$condition);
  let assemblyFormat = "$condition attr-dict";
  let hasVerifier = 1;
}

// Not Pure: a jump out of a region is control flow its parent must keep. A Pure one
// would let canonicalize erase an `if c { return x }` whose ops are otherwise pure.
class Milo_JumpOp<string mnemonic> : Milo_Op<mnemonic, [Terminator]> {
  let assemblyFormat = "attr-dict";
  let hasVerifier = 1;
}
// Leave / restart the innermost enclosing milo.while, milo.loop or milo.for.
def Milo_BreakOp : Milo_JumpOp<"break">;
def Milo_ContinueOp : Milo_JumpOp<"continue">;

// `return`, from any depth of nested regions.
def Milo_ReturnOp : Milo_Op<"return", [Terminator]> {
  let arguments = (ins Optional<Milo_Value>:$value);
  let assemblyFormat = "($value^ `:` type($value))? attr-dict";
  let hasVerifier = 1;
}

// Control cannot get here (past a `while true` with no break); traps if it does.
def Milo_UnreachableOp : Milo_Op<"unreachable", [Terminator]> {
  let assemblyFormat = "attr-dict";
}
