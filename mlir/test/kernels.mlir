// axpy and grid exactly as a naive frontend emits them: a len read and a bounds check
// before every element access, invariant arithmetic left inside the loop.
//   fn axpy(a: &mut Vec<f64>, b: &Vec<f64>, k: f64) { for i in 0..a.len() { a[i] = a[i] + k * b[i] } }
//   fn grid(m: &mut Vec<f64>, w: i64, h: i64) { for y in 1..h { for x in 0..w {
//       m[y*w + x] = m[y*w + x] + m[(y-1)*w + x] } } }
func.func @axpy(%a: !milo.vec<f64>, %b: !milo.vec<f64>, %k: f64) {
  %c0 = arith.constant 0 : i64
  %c1 = arith.constant 1 : i64
  %n = milo.vec.len %a : !milo.vec<f64>
  scf.for %i = %c0 to %n step %c1 : i64 {
    %la = milo.vec.len %a : !milo.vec<f64>
    milo.bounds_check %i, %la loc("kernels.milo":4:5)
    %x = milo.vec.load %a[%i] : !milo.vec<f64> -> f64
    %lb = milo.vec.len %b : !milo.vec<f64>
    milo.bounds_check %i, %lb loc("kernels.milo":4:5)
    %y = milo.vec.load %b[%i] : !milo.vec<f64> -> f64
    %t = arith.mulf %k, %y : f64
    %s = arith.addf %x, %t : f64
    %la2 = milo.vec.len %a : !milo.vec<f64>
    milo.bounds_check %i, %la2 loc("kernels.milo":4:5)
    milo.vec.store %s, %a[%i] : f64, !milo.vec<f64>
  }
  return
}

func.func @grid(%m: !milo.vec<f64>, %w: i64, %h: i64) {
  %c0 = arith.constant 0 : i64
  %c1 = arith.constant 1 : i64
  scf.for %y = %c1 to %h step %c1 : i64 {
    scf.for %x = %c0 to %w step %c1 : i64 {
      %yw = arith.muli %y, %w : i64
      %i1 = arith.addi %yw, %x : i64
      %l1 = milo.vec.len %m : !milo.vec<f64>
      milo.bounds_check %i1, %l1 loc("kernels.milo":11:5)
      %v1 = milo.vec.load %m[%i1] : !milo.vec<f64> -> f64
      %ym1 = arith.subi %y, %c1 : i64
      %ym1w = arith.muli %ym1, %w : i64
      %i2 = arith.addi %ym1w, %x : i64
      %l2 = milo.vec.len %m : !milo.vec<f64>
      milo.bounds_check %i2, %l2 loc("kernels.milo":11:5)
      %v2 = milo.vec.load %m[%i2] : !milo.vec<f64> -> f64
      %s = arith.addf %v1, %v2 : f64
      %l3 = milo.vec.len %m : !milo.vec<f64>
      milo.bounds_check %i1, %l3 loc("kernels.milo":11:5)
      milo.vec.store %s, %m[%i1] : f64, !milo.vec<f64>
    }
  }
  return
}
