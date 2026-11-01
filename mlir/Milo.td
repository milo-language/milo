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
// the writes made before the failing index.
def Milo_BoundsCheckOp : Milo_Op<"bounds_check",
    [MemoryEffects<[MemRead<Milo_VecElems>, MemWrite<Milo_Panic>]>]> {
  let arguments = (ins I64:$index, I64:$len, I32Attr:$line);
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

// What a local, a parameter or a result can hold.
def Milo_Value : AnyTypeOf<[Milo_Scalar, Milo_PtrType]>;

def Milo_PtrLoadOp : Milo_Op<"ptr.load"> {
  let arguments = (ins Arg<Milo_PtrType, "", [MemRead]>:$ptr);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$ptr attr-dict `:` type($result)";
}

def Milo_PtrStoreOp : Milo_Op<"ptr.store"> {
  let arguments = (ins Milo_Value:$value, Arg<Milo_PtrType, "", [MemWrite]>:$ptr);
  let assemblyFormat = "$value `,` $ptr attr-dict `:` type($value)";
}

def Milo_ConstOp : Milo_Op<"const", [ConstantLike, Pure,
    AllTypesMatch<["value", "result"]>]> {
  let summary = "an int, float or bool literal";
  let arguments = (ins TypedAttrInterface:$value);
  let results = (outs Milo_Scalar:$result);
  let assemblyFormat = "$value attr-dict";
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
  let arguments = (ins Milo_CmpPredicate:$predicate, Milo_Value:$lhs, Milo_Value:$rhs);
  let results = (outs I1:$result);
  let assemblyFormat = "$predicate `,` $lhs `,` $rhs attr-dict `:` type($lhs)";
}

// `x as T` between scalars. Float to int saturates (NaN is 0); it never traps.
def Milo_CastOp : Milo_Op<"cast", [Pure]> {
  let arguments = (ins Milo_Value:$operand);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$operand attr-dict `:` type($operand) `to` type($result)";
}

// `var name`: a mutable local. Must sit in the function's entry block, so the frame is
// fixed: a slot allocated inside a loop would grow the stack every iteration.
def Milo_VarOp : Milo_Op<"var"> {
  let arguments = (ins StrAttr:$name);
  let results = (outs Milo_RefType:$ref);
  let assemblyFormat = "$name attr-dict `:` type($ref)";
  let hasVerifier = 1;
}

def Milo_LoadOp : Milo_Op<"load", [
    TypesMatchWith<"result is the slot's type", "ref", "result",
                   "::llvm::cast<RefType>($_self).getPointee()">]> {
  let arguments = (ins Arg<Milo_RefType, "", [MemRead]>:$ref);
  let results = (outs Milo_Value:$result);
  let assemblyFormat = "$ref attr-dict `:` type($ref)";
}

// Before a call with two by-ref arguments of which one is `&mut`: panics if they are the
// same place. The checker rejects the aliasing it can prove; this is the runtime half, and
// what makes `noalias` on a `&mut` param sound.
def Milo_CheckUnaliasedOp : Milo_Op<"check_unaliased",
    [MemoryEffects<[MemWrite<Milo_Panic>]>]> {
  let arguments = (ins Milo_RefType:$lhs, Milo_RefType:$rhs);
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

def Milo_StoreOp : Milo_Op<"store", [
    TypesMatchWith<"value is the slot's type", "ref", "value",
                   "::llvm::cast<RefType>($_self).getPointee()">]> {
  let arguments = (ins Milo_Value:$value, Arg<Milo_RefType, "", [MemWrite]>:$ref);
  let assemblyFormat = "$value `,` $ref attr-dict `:` type($ref)";
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

def Milo_YieldOp : Milo_Op<"yield", [Pure, Terminator,
    ParentOneOf<["IfOp", "WhileOp", "LoopOp", "ForOp"]>]> {
  let arguments = (ins Variadic<Milo_Value>:$values);
  let assemblyFormat = "($values^ `:` type($values))? attr-dict";
  let hasVerifier = 1;
}

def Milo_ConditionOp : Milo_Op<"condition", [Pure, Terminator, HasParent<"WhileOp">]> {
  let arguments = (ins I1:$condition);
  let assemblyFormat = "$condition attr-dict";
  let hasVerifier = 1;
}

class Milo_JumpOp<string mnemonic> : Milo_Op<mnemonic, [Pure, Terminator]> {
  let assemblyFormat = "attr-dict";
  let hasVerifier = 1;
}
// Leave / restart the innermost enclosing milo.while, milo.loop or milo.for.
def Milo_BreakOp : Milo_JumpOp<"break">;
def Milo_ContinueOp : Milo_JumpOp<"continue">;

// `return`, from any depth of nested regions.
def Milo_ReturnOp : Milo_Op<"return", [Pure, Terminator]> {
  let arguments = (ins Optional<Milo_Value>:$value);
  let assemblyFormat = "($value^ `:` type($value))? attr-dict";
  let hasVerifier = 1;
}

// Control cannot get here (past a `while true` with no break); traps if it does.
def Milo_UnreachableOp : Milo_Op<"unreachable", [Terminator]> {
  let assemblyFormat = "attr-dict";
}
