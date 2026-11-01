// RUN: milo-opt %s --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// A Heap<T> is legacy's malloc'd pointer: heap.new mallocs T's size and stores the value,
// heap.place is the pointer itself. A type can hold itself through one.

// CHECK-LABEL: llvm.func @box
// CHECK:       %[[N:.*]] = llvm.getelementptr %{{.*}}[1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<"P", (i64, f64)>
// CHECK:       %[[SZ:.*]] = llvm.ptrtoint %[[N]] : !llvm.ptr to i64
// CHECK:       %[[B:.*]] = llvm.call @malloc(%[[SZ]]) : (i64) -> !llvm.ptr
// CHECK:       llvm.store %arg0, %[[B]] : !llvm.struct<"P", (i64, f64)>, !llvm.ptr
// CHECK:       %[[F:.*]] = llvm.getelementptr inbounds %[[B]][0, 1]
// CHECK:       llvm.load %[[F]] : !llvm.ptr -> f64
func.func @box(%p: !milo.struct<"P", si64, f64>) -> f64 {
  %h = milo.heap.new %p : !milo.struct<"P", si64, f64> -> !milo.heap<!milo.struct<"P", si64, f64>>
  %r = milo.heap.place %h : !milo.heap<!milo.struct<"P", si64, f64>> -> !milo.ref<!milo.struct<"P", si64, f64>>
  %f = milo.field_ref %r[1] : !milo.ref<!milo.struct<"P", si64, f64>> -> !milo.ref<f64>
  %x = milo.load %f : !milo.ref<f64>
  milo.return %x : f64
}

// CHECK-LABEL: llvm.func @tree
// CHECK-SAME:  (%arg0: !llvm.ptr) -> i32
func.func @tree(%e: !milo.heap<!milo.enum<"Expr", size = 16, align = 8, [0: (si64 at 8), 1: (!milo.heap<!milo.enum<"Expr">> at 8)]>>) -> si32 {
  %r = milo.heap.place %e : !milo.heap<!milo.enum<"Expr", size = 16, align = 8, [0: (si64 at 8), 1: (!milo.heap<!milo.enum<"Expr">> at 8)]>> -> !milo.ref<!milo.enum<"Expr", size = 16, align = 8, [0: (si64 at 8), 1: (!milo.heap<!milo.enum<"Expr">> at 8)]>>
  %t = milo.enum.tag_at %r : !milo.ref<!milo.enum<"Expr", size = 16, align = 8, [0: (si64 at 8), 1: (!milo.heap<!milo.enum<"Expr">> at 8)]>>
  milo.return %t : si32
}
