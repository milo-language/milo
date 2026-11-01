// RUN: milo-opt %s --milo-expand-index | FileCheck %s
// milo-expand-index: source-level `v[i]`, `v[i] = x`, `v.len()` become the Vec-level ops
// the loop passes read: a len, a bounds check at the access's location, then the access.

// CHECK-LABEL: func @read
// CHECK:   %[[J:.*]] = builtin.unrealized_conversion_cast %arg1 : si64 to i64
// CHECK:   %[[L:.*]] = milo.vec.len %arg0 : <f64>
// CHECK:   milo.bounds_check %[[J]], %[[L]]
// CHECK:   %[[X:.*]] = milo.vec.load %arg0[%[[J]]] : <f64> -> f64
// CHECK:   milo.return %[[X]] : f64
func.func @read(%v: !milo.vec<f64>, %i: si64) -> f64 {
  %x = milo.index %v[%i] : !milo.vec<f64> -> f64 loc("t.milo":2:3)
  milo.return %x : f64
}

// CHECK-LABEL: func @write_len
// CHECK:   milo.bounds_check
// CHECK:   milo.vec.store %arg2, %arg0[%{{.*}}] : si64, <si64>
// CHECK:   %[[L:.*]] = milo.vec.len %arg0 : <si64>
// CHECK:   %[[N:.*]] = builtin.unrealized_conversion_cast %[[L]] : i64 to si64
// CHECK:   milo.return %[[N]] : si64
func.func @write_len(%v: !milo.vec<si64>, %i: si64, %x: si64) -> si64 {
  milo.index.store %x, %v[%i] : si64, !milo.vec<si64> loc("t.milo":3:3)
  %n = milo.len %v : !milo.vec<si64>
  milo.return %n : si64
}
