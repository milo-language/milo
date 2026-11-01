// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --milo-elaborate-drops | FileCheck %s
// Drop elaboration: milo-scope-drops drops what a scope owns where control leaves it and
// the old value before a store; milo-elaborate-drops then erases the drop of a slot that
// is empty on every path, keeps the one of a slot full on every path, and tests a flag
// where it depends on the path.

// `s` is moved out on one path only, `t` filled on that path only: both drops at the
// scope's end need flags; the drops before the two first stores go.
// CHECK-LABEL: func @moved_on_one_path
// CHECK:     %[[S:.*]] = milo.var "s" owned
// CHECK:     %[[T:.*]] = milo.var "t" owned
// CHECK-DAG: %[[SF:.*]] = milo.var "s.alive"
// CHECK-DAG: %[[TF:.*]] = milo.var "t.alive"
// CHECK-NOT: milo.drop
// CHECK:     milo.store %{{.*}}, %[[S]]
// CHECK-NOT: milo.drop
// CHECK:     milo.move %[[S]]
// CHECK-NOT: milo.drop
// CHECK:     milo.store %{{.*}}, %[[T]]
// CHECK:     %[[TA:.*]] = milo.load %[[TF]]
// CHECK:     milo.drop %[[T]] if %[[TA]]
// CHECK:     %[[SA:.*]] = milo.load %[[SF]]
// CHECK:     milo.drop %[[S]] if %[[SA]]
// CHECK:     milo.return
func.func @moved_on_one_path(%c: i1) {
  %s = milo.var "s" owned : !milo.ref<!milo.string>
  %t = milo.var "t" owned : !milo.ref<!milo.string>
  milo.scope %s, %t : !milo.ref<!milo.string>, !milo.ref<!milo.string> {
    %a = milo.string.lit "a"
    milo.store %a, %s : !milo.ref<!milo.string>
    milo.if %c {
      %m = milo.move %s : !milo.ref<!milo.string>
      milo.store %m, %t : !milo.ref<!milo.string>
      milo.yield
    }
    milo.yield
  }
  milo.return
}

// A `let` in a loop body reuses one slot: the body's scope empties it at the end of each
// iteration and on `continue`, so the store never drops, and the drop at the loop's
// exits and the body's end are unconditional. The `break` crosses the body scope too.
// CHECK-LABEL: func @loop_let
// CHECK-NOT: milo.var "v.alive"
// CHECK:     milo.store %{{.*}}, %[[V:[^ ]*]] : <!milo.vecval<si64>>
// CHECK:     milo.drop %[[V]] : <!milo.vecval<si64>>
// CHECK-NEXT: cf.br
// CHECK:     milo.drop %[[V]] : <!milo.vecval<si64>>
// CHECK-NEXT: cf.br
// CHECK:     milo.drop %[[V]] : <!milo.vecval<si64>>
// CHECK-NEXT: cf.br
func.func @loop_let(%c: i1, %d: i1) {
  %v = milo.var "v" owned : !milo.ref<!milo.vecval<si64>>
  milo.loop {
    milo.scope %v : !milo.ref<!milo.vecval<si64>> {
      %n = milo.vec.new : !milo.vecval<si64>
      milo.store %n, %v : !milo.ref<!milo.vecval<si64>>
      milo.if %c {
        milo.break
      }
      milo.if %d {
        milo.continue
      }
      milo.yield
    }
    milo.yield
  }
  milo.return
}

// A store through a `&mut string` drops the value it replaces, always.
// CHECK-LABEL: func @assign_through_ref
// CHECK:     milo.drop %arg0 : <!milo.string>
// CHECK-NEXT: milo.store %{{.*}}, %arg0
func.func @assign_through_ref(%r: !milo.ref<!milo.string>) {
  %a = milo.string.lit "new"
  milo.store %a, %r : !milo.ref<!milo.string>
  milo.return
}
