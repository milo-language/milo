// RUN: milo-opt %s --convert-milo-to-llvm | FileCheck %s
// An itable is a private constant struct of method pointers plus a destructor slot: the
// drop helper, or null. A symbol the module does not define is declared.

// CHECK-DAG: llvm.func @T$show()
// CHECK-DAG: llvm.func @milo.drop.struct.T()
// CHECK: llvm.mlir.global private unnamed_addr constant @itable.T.Show() {{.*}} : !llvm.struct<(ptr, ptr)>
// CHECK:   llvm.mlir.addressof @T$show : !llvm.ptr
// CHECK:   llvm.mlir.addressof @milo.drop.struct.T : !llvm.ptr
// CHECK: llvm.mlir.global private unnamed_addr constant @itable.U.Show() {{.*}} : !llvm.struct<(ptr, ptr)>
// CHECK:   llvm.mlir.zero : !llvm.ptr
milo.itable @"itable.T.Show" [@"T$show"] drop @"milo.drop.struct.T"
milo.itable @"itable.U.Show" [@"T$show"]
