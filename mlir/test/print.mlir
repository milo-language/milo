// RUN: milo-opt %s --milo-lower-structured-cf --convert-milo-to-llvm | FileCheck %s
// milo.string.lit is legacy's %String {data, len, cap 0}; milo.print is one call of the
// legacy helper named after its part types, scalars by value, a string through a slot in
// the entry block even when the print sits in a loop.

// CHECK: llvm.mlir.global private constant @{{.*}}("hi\00")
// CHECK-LABEL: llvm.func @show
// CHECK-NEXT:   %[[ONE:.*]] = llvm.mlir.constant(1 : i64) : i64
// CHECK-NEXT:   %[[SLOT:.*]] = llvm.alloca %[[ONE]] x !llvm.struct<"String", (ptr, i64, i64)>
// CHECK:   llvm.mlir.constant(2 : i64) : i64
// CHECK:   llvm.mlir.constant(0 : i64) : i64
// CHECK:   llvm.br
// CHECK:   llvm.store %{{.*}}, %[[SLOT]]
// CHECK:   llvm.call @milo.print.string.si64.f64.i1(%[[SLOT]], %{{.*}}, %{{.*}}, %{{.*}}) : (!llvm.ptr, i64, f64, i1) -> ()
// CHECK:   llvm.call @milo.eprint() : () -> ()
func.func @show(%n: si64, %x: f64, %b: i1) {
  %s = milo.string.lit "hi"
  milo.loop {
    milo.print %s, %n, %x, %b : !milo.string, si64, f64, i1
    milo.print stderr
    milo.break
  }
  milo.return
}

// A partial print (the parts up to a string part) calls the `.part` helper, which
// writes no newline.
// CHECK-LABEL: llvm.func @streamed
// CHECK: llvm.call @milo.print.part.si64.string(
// CHECK: llvm.call @milo.print.si64(
func.func @streamed(%a: si64, %b: si64) {
  %s = milo.string.lit " then "
  milo.print partial %a, %s : si64, !milo.string
  milo.print %b : si64
  milo.return
}
