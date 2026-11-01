// The milo dialect: Milo's Vec and bounds-check semantics as first-class IR, so loop
// transforms can use facts LLVM IR cannot carry (a Vec header is never written by an
// element store; a bounds check is a panic point ordered against element writes).
include "mlir/IR/OpBase.td"
include "mlir/IR/AttrTypeBase.td"
include "mlir/Interfaces/SideEffectInterfaces.td"

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
