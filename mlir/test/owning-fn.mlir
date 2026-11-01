// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --milo-elaborate-drops --convert-milo-to-llvm | FileCheck %s
// An owning fn value (a `move` closure, built by a legacy helper) is an owned value: its
// slot is dropped at the scope's end through legacy's glue for owning closures, and a
// call through it passes the env first, as for any fn value.

// CHECK-LABEL: llvm.func @owner
// CHECK:     llvm.call @milo.mkclosure.owner.0
// CHECK:     llvm.extractvalue
// CHECK:     llvm.call %{{.*}}(%{{.*}}, %{{.*}}) : !llvm.ptr, (!llvm.ptr, i64) -> i64
// CHECK:     llvm.call @milo.drop.ownfn
// CHECK:     llvm.return
func.func private @"milo.mkclosure.owner.0"(!milo.string) -> !milo.fn<owning (si64) -> si64>
func.func @owner(%s: !milo.string, %x: si64) -> si64 {
  %f = milo.var "f" owned : !milo.ref<!milo.fn<owning (si64) -> si64>>
  %r = milo.scope %f : !milo.ref<!milo.fn<owning (si64) -> si64>> -> si64 {
    %c = func.call @"milo.mkclosure.owner.0"(%s) : (!milo.string) -> !milo.fn<owning (si64) -> si64>
    milo.store %c, %f : !milo.ref<!milo.fn<owning (si64) -> si64>>
    %v = milo.load %f : !milo.ref<!milo.fn<owning (si64) -> si64>>
    %y = milo.closure.call %v(%x) : !milo.fn<owning (si64) -> si64>, si64 -> si64
    milo.yield %y : si64
  }
  milo.return %r : si64
}
