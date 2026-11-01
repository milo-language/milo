// RUN: milo-opt %s --milo-expand-index --milo-lower-structured-cf --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// Fixed-size arrays: !milo.array<T, N> is LLVM's [N x T]; `a[i]` is legacy's bounds check
// against the constant size, then a GEP [0, i] into the array's place.

// CHECK-LABEL: llvm.func @get
// CHECK:       %[[N:.*]] = llvm.mlir.constant(16 : i64) : i64
// CHECK:       %[[C:.*]] = llvm.icmp "uge" %arg1, %[[N]] : i64
// CHECK:       llvm.call @__milo_bounds_fail(%arg1, %[[N]]
// CHECK:       %[[E:.*]] = llvm.getelementptr %arg0[0, %arg1] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.array<16 x i8>
// CHECK:       llvm.load %[[E]] : !llvm.ptr -> i8
func.func @get(%a: !milo.ref<!milo.array<ui8, 16>>, %i: si64) -> ui8 {
  %r = milo.array.index %a[%i] : !milo.ref<!milo.array<ui8, 16>> -> !milo.ref<ui8> loc("t.milo":3:9)
  %x = milo.load %r : !milo.ref<ui8>
  milo.return %x : ui8
}

// CHECK-LABEL: llvm.func @slot
// CHECK:       llvm.alloca %{{.*}} x !llvm.array<4096 x i8>
func.func @slot() -> !milo.ptr {
  %s = milo.var "buf" : !milo.ref<!milo.array<ui8, 4096>>
  %p = milo.addr %s : !milo.ref<!milo.array<ui8, 4096>>
  milo.return %p : !milo.ptr
}
