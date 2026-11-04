// RUN: milo-opt %s --convert-milo-to-llvm | FileCheck %s
// milo.global.def is an internal global with a static initializer; `milo.global` reaches it
// whether it is lowered before or after the definition.

// CHECK: llvm.mlir.global internal @n() {{.*}} : i64 {
// CHECK:   llvm.mlir.constant(-7 : i64) : i64
// CHECK: llvm.mlir.global internal thread_local @z() {{.*}} : i32 {
// CHECK:   llvm.mlir.zero : i32
// CHECK: llvm.mlir.global internal @pair() {{.*}} : !llvm.struct<"Pair", (f32, i8)> {
// CHECK:   llvm.mlir.constant(1.500000e+00 : f32) : f32
// CHECK:   llvm.mlir.constant(3 : i8) : i8
// CHECK: llvm.mlir.global internal @tbl() {{.*}} : !llvm.array<3 x i32> {
// CHECK:   llvm.mlir.constant(dense<[1, 2, 3]> : tensor<3xi32>) : !llvm.array<3 x i32>
// CHECK: llvm.mlir.global internal @fill() {{.*}} : !llvm.array<4 x i16> {
// CHECK:   llvm.mlir.constant(dense<9> : tensor<4xi16>) : !llvm.array<4 x i16>
milo.global.def @n : si64 = -7 : i64
milo.global.def @z thread_local : si32
milo.global.def @pair : !milo.struct<"Pair", f32, ui8> = [0x3FF8000000000000 : f64, 3 : i64]
milo.global.def @tbl : !milo.array<si32, 3> = [1 : i64, 2 : i64, 3 : i64]
milo.global.def @fill : !milo.array<ui16, 4> = [9 : i64]

// CHECK-LABEL: llvm.func @bump
// CHECK:   llvm.mlir.addressof @n : !llvm.ptr
func.func @bump(%x: si64) {
  %g = milo.global "n" : !milo.ref<si64>
  %v = milo.load %g : !milo.ref<si64>
  %n = milo.add %v, %x wrapping : si64
  milo.store %n, %g : !milo.ref<si64>
  milo.return
}
