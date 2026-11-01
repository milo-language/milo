// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --milo-elaborate-drops --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// A Heap of an interface, !milo.dyn<I>, is legacy's { ptr data, ptr itable } pair, owned:
// an owned slot of one is dropped through legacy's glue, milo.drop.dyn.<I>.

// CHECK-LABEL: llvm.func @hold
// CHECK-SAME:  (%arg0: !llvm.struct<(ptr, ptr)>)
// CHECK:       llvm.store %arg0, %[[S:.*]] : !llvm.struct<(ptr, ptr)>, !llvm.ptr
// CHECK:       llvm.call @milo.drop.dyn.Shape(%[[S]]) : (!llvm.ptr) -> ()
func.func @hold(%d: !milo.dyn<"Shape">) {
  %s = milo.var "s" owned : !milo.ref<!milo.dyn<"Shape">>
  milo.scope %s : !milo.ref<!milo.dyn<"Shape">> {
    milo.store %d, %s : !milo.ref<!milo.dyn<"Shape">>
    milo.yield
  }
  milo.return
}
