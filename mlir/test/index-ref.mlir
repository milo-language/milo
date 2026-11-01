// RUN: milo-opt %s --milo-expand-index --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// milo.index.ref: `v[i]` on a Vec of non-scalars as a place. It expands to the same len and
// bounds check as milo.index, then the element's address: the header's data pointer (its
// TBAA tag) indexed by the element type.

// CHECK-LABEL: llvm.func @field_of_elem
// CHECK:       %[[L:.*]] = llvm.load %{{.*}} {alignment = 8 : i64, tbaa = [#{{.*}}]} : !llvm.ptr -> i64
// CHECK:       llvm.icmp "uge" %arg1, %[[L]]
// CHECK:       llvm.call @__milo_bounds_fail
// CHECK:       %[[D:.*]] = llvm.load %arg0 {alignment = 8 : i64, tbaa = [#{{.*}}]} : !llvm.ptr -> !llvm.ptr
// CHECK:       %[[E:.*]] = llvm.getelementptr %[[D]][%arg1] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.struct<"P", (i64, struct<"String", (ptr, i64, i64)>)>
// CHECK:       %[[F:.*]] = llvm.getelementptr inbounds %[[E]][0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<"P"
// CHECK:       llvm.load %[[F]] : !llvm.ptr -> i64
func.func @field_of_elem(%v: !milo.vec<!milo.struct<"P", si64, !milo.string>>, %i: si64) -> si64 {
  %e = milo.index.ref %v[%i] : !milo.vec<!milo.struct<"P", si64, !milo.string>> -> !milo.ref<!milo.struct<"P", si64, !milo.string>> loc("t.milo":4:5)
  %f = milo.field_ref %e[0] : !milo.ref<!milo.struct<"P", si64, !milo.string>> -> !milo.ref<si64>
  %x = milo.load %f : !milo.ref<si64>
  milo.return %x : si64
}
