// RUN: milo-opt %s --milo-hoist-vec-reads --milo-version-bounds-checks --canonicalize | FileCheck %s

// v[i - 1] from i = 0 underflows on the first iteration, so no check-free copy may
// exist: the versioning guard folds to false and only the checked loop survives.
// CHECK-LABEL: func @negative_offset
// CHECK-NOT: scf.if
// CHECK: milo.bounds_check
// CHECK-NOT: scf.if
// CHECK: return
func.func @negative_offset(%v: !milo.vec<f64>, %n: i64) {
  %c0 = arith.constant 0 : i64
  %c1 = arith.constant 1 : i64
  %cm1 = arith.constant -1 : i64
  scf.for %i = %c0 to %n step %c1 : i64 {
    %j = arith.addi %i, %cm1 : i64
    %l = milo.vec.len %v : !milo.vec<f64>
    milo.bounds_check %j, %l {line = 1 : i32}
    %x = milo.vec.load %v[%j] : !milo.vec<f64> -> f64
  }
  return
}

// A call may grow the Vec, so its len must stay inside the loop and the check with it.
// CHECK-LABEL: func @opaque_call
// CHECK: scf.for
// CHECK-NEXT: func.call @mayGrow
// CHECK-NEXT: milo.vec.len
// CHECK-NEXT: milo.bounds_check
func.func private @mayGrow()
func.func @opaque_call(%v: !milo.vec<f64>, %n: i64) {
  %c0 = arith.constant 0 : i64
  %c1 = arith.constant 1 : i64
  scf.for %i = %c0 to %n step %c1 : i64 {
    func.call @mayGrow() : () -> ()
    %l = milo.vec.len %v : !milo.vec<f64>
    milo.bounds_check %i, %l {line = 1 : i32}
  }
  return
}
