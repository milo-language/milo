// RUN: milo-opt %s --milo-scope-drops --milo-expand-index --milo-lower-structured-cf --milo-elaborate-drops --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// A consuming for-in's Vec in a vectail slot: init stores the header and a zero cursor,
// take reads the element through the data pointer and moves the cursor past it, and the
// slot's drop is the tail glue (milo.drop.vectail.<elem>). vectail.vec is the slot itself:
// the header is its first field.

// CHECK-LABEL: llvm.func @take_first
// CHECK:       %[[S:.*]] = llvm.alloca %{{.*}} x !llvm.struct<(struct<"Vec", (ptr, i64, i64)>, i64)>
// CHECK:       llvm.store %arg0, %[[S]] : !llvm.struct<"Vec", (ptr, i64, i64)>, !llvm.ptr
// CHECK:       %[[C0:.*]] = llvm.getelementptr %[[S]][0, 1] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<(struct<"Vec", (ptr, i64, i64)>, i64)>
// CHECK:       llvm.store %{{.*}}, %[[C0]] : i64, !llvm.ptr
// CHECK:       %[[D:.*]] = llvm.load %[[S]] : !llvm.ptr -> !llvm.ptr
// CHECK:       %[[E:.*]] = llvm.getelementptr %[[D]][%{{.*}}] : (!llvm.ptr, i64) -> !llvm.ptr, !llvm.struct<"String"
// CHECK:       llvm.load %[[E]] : !llvm.ptr -> !llvm.struct<"String"
// CHECK:       %[[N:.*]] = llvm.add %{{.*}}, %{{.*}} : i64
// CHECK:       %[[C1:.*]] = llvm.getelementptr %[[S]][0, 1]
// CHECK:       llvm.store %[[N]], %[[C1]] : i64, !llvm.ptr
// CHECK:       llvm.call @milo.drop.vectail.string(%[[S]])
// CHECK:       llvm.return
func.func @take_first(%v: !milo.vecval<!milo.string>, %i: si64) -> !milo.string {
  %s = milo.var "for.vec" owned : !milo.ref<!milo.vectail<!milo.string>>
  %r = milo.scope %s : !milo.ref<!milo.vectail<!milo.string>> -> !milo.string {
    milo.vectail.init %v, %s : !milo.vecval<!milo.string>, !milo.ref<!milo.vectail<!milo.string>>
    milo.filled %s : !milo.ref<!milo.vectail<!milo.string>>
    %x = milo.vectail.take %s[%i] : !milo.ref<!milo.vectail<!milo.string>> -> !milo.string
    milo.yield %x : !milo.string
  }
  milo.return %r : !milo.string
}

// CHECK-LABEL: llvm.func @header
// CHECK:       %[[S:.*]] = llvm.alloca
// CHECK:       %[[L:.*]] = llvm.getelementptr inbounds %[[S]][8] : (!llvm.ptr) -> !llvm.ptr, i8
// CHECK:       %[[N:.*]] = llvm.load %[[L]]
// CHECK:       llvm.call @milo.drop.vectail.si64(%[[S]])
// CHECK:       llvm.return %[[N]]
func.func @header(%v: !milo.vecval<si64>) -> si64 {
  %s = milo.var "for.vec" owned : !milo.ref<!milo.vectail<si64>>
  %r = milo.scope %s : !milo.ref<!milo.vectail<si64>> -> si64 {
    milo.vectail.init %v, %s : !milo.vecval<si64>, !milo.ref<!milo.vectail<si64>>
    milo.filled %s : !milo.ref<!milo.vectail<si64>>
    %h = milo.vectail.vec %s : !milo.ref<!milo.vectail<si64>> -> !milo.vec<si64>
    %n = milo.len %h : !milo.vec<si64>
    milo.yield %n : si64
  }
  milo.return %r : si64
}
