// RUN: milo-opt %s --milo-raise-to-scf | FileCheck %s
// milo-raise-to-scf: a milo.for with a signed induction variable and no early exit becomes
// scf.for (its ifs scf.if), where the Vec passes run; anything else stays milo.

// CHECK-LABEL: func @raised
// CHECK:   %[[LB:.*]] = builtin.unrealized_conversion_cast %arg0 : si64 to i64
// CHECK:   %[[UB:.*]] = builtin.unrealized_conversion_cast %arg1 : si64 to i64
// CHECK:   scf.for %[[J:.*]] = %[[LB]] to %[[UB]] step %{{.*}} : i64 {
// CHECK:     %[[I:.*]] = builtin.unrealized_conversion_cast %[[J]] : i64 to si64
// CHECK:     %[[C:.*]] = milo.cmp lt, %[[I]], %arg1 : si64
// CHECK:     %[[R:.*]] = scf.if %[[C]] -> (i1) {
// CHECK:       scf.yield %arg2 : i1
// CHECK:     } else {
// CHECK:       scf.yield %[[C]] : i1
// CHECK:     scf.if %[[R]] {
// CHECK:       func.call @use(%[[I]])
// CHECK-NOT: milo.for
func.func private @use(si64)
func.func @raised(%a: si64, %b: si64, %k: i1) {
  milo.for %a to %b : si64 {
  ^bb0(%i: si64):
    %c = milo.cmp lt, %i, %b : si64
    %r = milo.if %c -> i1 {
      milo.yield %k : i1
    } else {
      milo.yield %c : i1
    }
    milo.if %r {
      func.call @use(%i) : (si64) -> ()
      milo.yield
    }
    milo.yield
  }
  milo.return
}

// A break, an unsigned induction variable: both stay milo.for.
// CHECK-LABEL: func @kept
// CHECK: milo.for
// CHECK: milo.break
// CHECK: milo.for
// CHECK-NOT: scf.for
func.func @kept(%a: si64, %u: ui64, %k: i1) {
  milo.for %a to %a : si64 {
  ^bb0(%i: si64):
    milo.if %k {
      milo.break
    }
    milo.yield
  }
  milo.for %u to %u : ui64 {
  ^bb0(%i: ui64):
    milo.yield
  }
  milo.return
}
