// RUN: milo-opt %s --milo-verify --convert-milo-to-llvm | FileCheck %s
// An arraytail slot is `{ [N x T], i64 cursor }`: the array is its first field, start
// zeroes the cursor, take reads element i and sets the cursor to i + 1.

// CHECK-LABEL: llvm.func @walk
// CHECK:   %[[CUR0:.*]] = llvm.getelementptr %[[SLOT:.*]][0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(array<3 x i64>, i64)>
// CHECK:   llvm.store %{{.*}}, %[[CUR0]] : i64, !llvm.ptr
// CHECK:   %[[EP:.*]] = llvm.getelementptr %[[SLOT]][0, %{{.*}}] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.array<3 x i64>
// CHECK:   %[[NEXT:.*]] = llvm.add %{{.*}}, %{{.*}} : i64
// CHECK:   llvm.store %[[NEXT]], %{{.*}} : i64, !llvm.ptr
// CHECK:   llvm.load %[[EP]] : !llvm.ptr -> i64
func.func @walk(%i: si64) -> si64 {
  %slot = milo.var "t" owned : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>>
  %arr = milo.arraytail.array %slot : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>> -> !milo.ref<!milo.array<si64, 3>>
  milo.arraytail.start %slot : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>>
  %x = milo.arraytail.take %slot[%i] : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>> -> si64
  milo.return %x : si64
}
