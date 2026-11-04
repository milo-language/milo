// RUN: milo-opt %s --milo-merge-scaffold | FileCheck %s
// The scaffold's symbols join the program's: a scaffold definition replaces the program's
// declaration, a scaffold declaration of what the program defines (or also declares) goes,
// and on-demand symbols are listed on the module for the link step to prune.

// CHECK: module attributes {milo.on_demand = ["panic", "unused"]}
// CHECK-NOT: module @milo.scaffold
// CHECK-DAG: llvm.func @main() -> i32
// CHECK-DAG: llvm.func internal @panic(%{{.*}}: !llvm.ptr)
// CHECK-DAG: llvm.func internal @unused()
// CHECK-DAG: llvm.func @write(i32, !llvm.ptr, i64) -> i64
// CHECK-NOT: llvm.func @write
module {
  llvm.func @panic(!llvm.ptr)
  llvm.func @write(i32, !llvm.ptr, i64) -> i64
  llvm.func @main() -> i32 {
    %0 = llvm.mlir.zero : !llvm.ptr
    llvm.call @panic(%0) : (!llvm.ptr) -> ()
    %1 = llvm.mlir.constant(0 : i32) : i32
    llvm.return %1 : i32
  }
  module @milo.scaffold {
    llvm.func @main() -> i32
    llvm.func @write(i32, !llvm.ptr, i64) -> i64 attributes {milo.on_demand}
    llvm.func internal @panic(%m: !llvm.ptr) attributes {milo.on_demand} {
      llvm.unreachable
    }
    llvm.func internal @unused() attributes {milo.on_demand} {
      llvm.return
    }
  }
}
