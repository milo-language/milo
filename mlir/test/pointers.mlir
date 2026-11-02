// RUN: milo-opt %s --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// Places through raw pointers (std's Vec methods): element and field addresses are GEPs,
// addrOf is the place itself, v.ptr() loads the header's data word, and s[i] is legacy's
// bounds check then a byte load.

// CHECK-LABEL: llvm.func @bump_len
// CHECK:   %[[H:.*]] = llvm.getelementptr %arg0[%arg1] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.struct<"VecHead", (ptr, i64, i64)>
// CHECK:   %[[L:.*]] = llvm.getelementptr %[[H]][0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<"VecHead", (ptr, i64, i64)>
// CHECK:   llvm.load %[[L]] : !llvm.ptr -> i64
// CHECK:   llvm.store %{{.*}}, %[[L]] : i64, !llvm.ptr
func.func @bump_len(%p: !milo.ptr, %i: si64) {
  %h = milo.ptr.elem %p[%i] : !milo.struct<"VecHead", !milo.ptr, si64, si64>
  %l = milo.ptr.field %h[1] : !milo.struct<"VecHead", !milo.ptr, si64, si64>
  %n = milo.ptr.load %l : si64
  %one = milo.const 1 : si64
  %m = milo.add %n, %one wrapping : si64
  milo.ptr.store %m, %l : si64
  milo.return
}

// CHECK-LABEL: llvm.func @data
// CHECK-NEXT:   %[[D:.*]] = llvm.load %arg0 : !llvm.ptr -> !llvm.ptr
// CHECK-NEXT:   llvm.return %[[D]]
func.func @data(%v: !milo.vec<si64>) -> !milo.ptr {
  %d = milo.vec.data %v : !milo.vec<si64>
  milo.return %d : !milo.ptr
}

// CHECK-LABEL: llvm.func @byte
// CHECK:   %[[N:.*]] = llvm.extractvalue %arg0[1]
// CHECK:   llvm.icmp "uge" %arg1, %[[N]]
// CHECK:   llvm.call @__milo_bounds_fail(%arg1, %[[N]], %{{.*}}, %{{.*}})
// CHECK:   llvm.load %{{.*}} : !llvm.ptr -> i8
func.func @byte(%s: !milo.string, %i: si64) -> ui8 {
  %b = milo.string.byte %s[%i] loc("t.milo":3:5)
  milo.return %b : ui8
}

// `s as *u8` and the bytes of `for b in s`: field 0 of the %String.
// CHECK-LABEL: llvm.func @bytes
// CHECK-NEXT:   %[[D:.*]] = llvm.extractvalue %arg0[0] : !llvm.struct<"String", (ptr, i64, i64)>
// CHECK-NEXT:   llvm.return %[[D]] : !llvm.ptr
func.func @bytes(%s: !milo.string) -> !milo.ptr {
  %d = milo.string.data %s
  milo.return %d : !milo.ptr
}

// A place behind a raw pointer lent to a call (`(*p).items.push(v)`): the same address.
// CHECK-LABEL: llvm.func @lend_vec
// CHECK:   llvm.call @push_one(%arg0) : (!llvm.ptr) -> ()
func.func private @push_one(!milo.vec<si64>)
func.func @lend_vec(%p: !milo.ptr) {
  %v = milo.ptr.lend %p -> !milo.vec<si64>
  func.call @push_one(%v) : (!milo.vec<si64>) -> ()
  milo.return
}
