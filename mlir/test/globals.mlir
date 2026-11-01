// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --convert-milo-to-llvm | FileCheck %s
// milo.global is the address of a global the legacy module defines (declared external
// here); a store over a string in one drops the old value first, an `init` store does
// not; milo.global.init calls legacy's guarded entry for the lazy global.

// CHECK: llvm.mlir.global external @total() {{.*}} : i64
// CHECK-LABEL: llvm.func @bump
// CHECK:   %[[G:.*]] = llvm.mlir.addressof @total : !llvm.ptr
// CHECK:   llvm.load %[[G]] : !llvm.ptr -> i64
// CHECK:   llvm.store %{{.*}}, %[[G]] : i64, !llvm.ptr
func.func @bump(%x: si64) {
  %g = milo.global "total" : !milo.ref<si64>
  %v = milo.load %g : !milo.ref<si64>
  %n = milo.add %v, %x wrapping : si64
  milo.store %n, %g : !milo.ref<si64>
  milo.return
}

// CHECK-LABEL: llvm.func @rename
// CHECK:   llvm.call @milo.drop.string(
// CHECK:   llvm.store
// CHECK-NOT: milo.drop
// CHECK-LABEL: llvm.func @fill
// CHECK-NOT: llvm.call @milo.drop
// CHECK:   llvm.call @__milo.lazy.label() : () -> ()
func.func @rename(%s: !milo.string) {
  %g = milo.global "label" : !milo.ref<!milo.string>
  milo.store %s, %g : !milo.ref<!milo.string>
  milo.return
}

func.func @fill(%s: !milo.string) {
  %g = milo.global "label" : !milo.ref<!milo.string>
  milo.store %s, %g init : !milo.ref<!milo.string>
  milo.global.init "label"
  milo.return
}
