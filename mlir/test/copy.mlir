// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --milo-elaborate-drops --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// milo.copy: a 128+ byte aggregate from place to place as one memcpy of its size, never a
// whole load. An owned source given up is emptied by an unused milo.move, which loads
// nothing and leaves the slot with nothing for its scope to drop.

// CHECK-LABEL: llvm.func @push_big
// CHECK-NOT:   llvm.load %{{.*}} : !llvm.ptr -> !llvm.struct<"Row"
// CHECK:       %[[E:.*]] = llvm.getelementptr %arg0[%arg1]
// CHECK:       %[[N:.*]] = llvm.getelementptr %{{.*}}[1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<"Row"
// CHECK:       %[[SZ:.*]] = llvm.ptrtoint %[[N]] : !llvm.ptr to i64
// CHECK:       "llvm.intr.memcpy"(%[[E]], %{{.*}}, %[[SZ]]) <{isVolatile = false}>
// CHECK-NOT:   milo.drop
// CHECK-NOT:   llvm.call @milo.drop.SRow
// CHECK:       llvm.return
func.func @push_big(%p: !milo.ptr, %i: si64, %x: !milo.struct<"Row", !milo.string, si64>) {
  %s = milo.var "x" owned : !milo.ref<!milo.struct<"Row", !milo.string, si64>>
  milo.scope %s : !milo.ref<!milo.struct<"Row", !milo.string, si64>> {
    milo.store %x, %s : !milo.ref<!milo.struct<"Row", !milo.string, si64>>
    %e = milo.ptr.elem %p[%i] : !milo.struct<"Row", !milo.string, si64>
    milo.copy %s, %e : !milo.ref<!milo.struct<"Row", !milo.string, si64>>, !milo.ptr of !milo.struct<"Row", !milo.string, si64>
    %m = milo.move %s : !milo.ref<!milo.struct<"Row", !milo.string, si64>>
    milo.yield
  }
  milo.return
}

// CHECK-LABEL: llvm.func @slot_to_slot
// CHECK:       "llvm.intr.memcpy"(%arg0, %arg1, %{{.*}}) <{isVolatile = false}>
func.func @slot_to_slot(%dst: !milo.ref<!milo.struct<"W", si64, si64>>, %src: !milo.ref<!milo.struct<"W", si64, si64>>) {
  milo.copy %src, %dst : !milo.ref<!milo.struct<"W", si64, si64>>, !milo.ref<!milo.struct<"W", si64, si64>> of !milo.struct<"W", si64, si64>
  milo.return
}
