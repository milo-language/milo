// RUN: milo-opt %s --milo-verify --milo-lower-structured-cf --convert-milo-to-llvm | FileCheck %s
// A by-reference closure: its env is an entry-block slot holding a null drop header and
// the captures' addresses; the body reads a capture's place out of the env; a call goes
// through the fn pointer with the env first. No captures: a null env.

// CHECK-LABEL: llvm.func internal @user$closure0(%arg0: !llvm.ptr, %arg1: i64) -> i64
// CHECK:   %[[AT:.*]] = llvm.getelementptr %arg0[1] : (!llvm.ptr) -> !llvm.ptr, !llvm.ptr
// CHECK:   %[[P:.*]] = llvm.load %[[AT]] : !llvm.ptr -> !llvm.ptr
// CHECK:   llvm.load %[[P]] : !llvm.ptr -> i64
func.func @"user$closure0"(%env: !milo.ptr, %x: si64) -> si64 attributes {llvm.linkage = #llvm.linkage<internal>} {
  %c = milo.env.capture %env[0] : !milo.ref<si64>
  %v = milo.load %c : !milo.ref<si64>
  %r = milo.add %v, %x wrapping : si64
  milo.return %r : si64
}

func.func @"user$closure1"(%env: !milo.ptr) attributes {llvm.linkage = #llvm.linkage<internal>} {
  milo.return
}

// CHECK-LABEL: llvm.func @user
// CHECK:   %[[ENV:.*]] = llvm.alloca %{{.*}} x !llvm.struct<(ptr, ptr)>
// CHECK:   %[[H:.*]] = llvm.getelementptr %[[ENV]][0, 0]
// CHECK:   llvm.store %{{.*}}, %[[H]]
// CHECK:   %[[C:.*]] = llvm.getelementptr %[[ENV]][0, 1]
// CHECK:   llvm.store %{{.*}}, %[[C]] : !llvm.ptr, !llvm.ptr
// CHECK:   llvm.mlir.addressof @user$closure0
// CHECK:   %[[FN:.*]] = llvm.extractvalue %{{.*}}[0] : !llvm.struct<(ptr, ptr)>
// CHECK:   %[[E:.*]] = llvm.extractvalue %{{.*}}[1] : !llvm.struct<(ptr, ptr)>
// CHECK:   llvm.call %[[FN]](%[[E]], %{{.*}}) : !llvm.ptr, (!llvm.ptr, i64) -> i64
// CHECK:   llvm.mlir.zero : !llvm.ptr
// CHECK:   llvm.mlir.addressof @user$closure1
func.func @user(%n: si64) -> si64 {
  %slot = milo.var "n" : !milo.ref<si64>
  milo.store %n, %slot : !milo.ref<si64>
  %f = milo.closure @"user$closure0"(%slot : !milo.ref<si64>) : !milo.fn<(si64) -> si64>
  %r = milo.closure.call %f(%n) : !milo.fn<(si64) -> si64>, si64 -> si64
  %g = milo.closure @"user$closure1" : !milo.fn<() -> ()>
  milo.closure.call %g() : !milo.fn<() -> ()>
  milo.return %r : si64
}
