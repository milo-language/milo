// RUN: milo-opt %s --milo-verify --milo-lower-structured-cf --convert-milo-to-llvm | FileCheck %s
// A static closure env is a module global, printed before every function.
// CHECK: llvm.mlir.global internal @user$closure0_env() {{.*}} : !llvm.struct<(ptr, ptr)>
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

// A static env (a global initializer's closure): one zeroed internal global per body.
// CHECK-LABEL: llvm.func @ginit
// CHECK:   %[[SENV:.*]] = llvm.mlir.addressof @user$closure0_env
// CHECK:   %[[SH:.*]] = llvm.getelementptr %[[SENV]][0, 0]
func.func @ginit(%n: si64) -> si64 {
  %slot = milo.var "n" : !milo.ref<si64>
  milo.store %n, %slot : !milo.ref<si64>
  %f = milo.closure @"user$closure0"(%slot : !milo.ref<si64>) static : !milo.fn<(si64) -> si64>
  %r = milo.closure.call %f(%n) : !milo.fn<(si64) -> si64>, si64 -> si64
  milo.return %r : si64
}

// A heap env (a scoped task's literal): malloc'd, at least 16 bytes, its header `free`.
// CHECK-LABEL: llvm.func @scoped
// CHECK:   %[[SZ:.*]] = llvm.mlir.constant(16 : i64) : i64
// CHECK:   %[[HENV:.*]] = llvm.call @malloc(%[[SZ]])
// CHECK:   %[[FREE:.*]] = llvm.mlir.addressof @free
// CHECK:   %[[HH:.*]] = llvm.getelementptr %[[HENV]][0, 0]
// CHECK:   llvm.store %[[FREE]], %[[HH]]
// CHECK:   %[[HC:.*]] = llvm.getelementptr %[[HENV]][0, 1]
// CHECK:   llvm.store %{{.*}}, %[[HC]] : !llvm.ptr, !llvm.ptr
func.func @scoped(%n: si64) -> si64 {
  %slot = milo.var "n" : !milo.ref<si64>
  milo.store %n, %slot : !milo.ref<si64>
  %f = milo.closure @"user$closure0"(%slot : !milo.ref<si64>) heap : !milo.fn<(si64) -> si64>
  %r = milo.closure.call %f(%n) : !milo.fn<(si64) -> si64>, si64 -> si64
  milo.return %r : si64
}
