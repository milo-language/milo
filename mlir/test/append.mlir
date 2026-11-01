// RUN: milo-opt %s --milo-append-in-place | FileCheck %s
// `s = s + x` becomes an in-place append when the concat's only use stores it back over
// the place its left operand was read from; not when the right side reads that place, nor
// when anything in between names it.

func.func private @f() -> !milo.string
func.func private @touch(!milo.ref<!milo.string>)

// CHECK-LABEL: func.func @accumulate
// CHECK:       %[[X:.*]] = func.call @f()
// CHECK-NEXT:  milo.string.append %[[S:.*]], %[[X]]
// CHECK-NOT:   milo.string.concat
// CHECK:       milo.string.append %{{.*}}, %{{.*}} : <!milo.string>
func.func @accumulate() {
  %s = milo.var "s" owned : !milo.ref<!milo.string>
  %d = milo.var "d" : !milo.ref<!milo.struct<"Doc", !milo.string>>
  milo.scope %s : !milo.ref<!milo.string> {
    %l = milo.load %s : !milo.ref<!milo.string>
    %x = func.call @f() : () -> !milo.string
    %r = milo.string.concat %l, %x
    milo.store %r, %s : !milo.ref<!milo.string>
    %b0 = milo.field_ref %d[0] : !milo.ref<!milo.struct<"Doc", !milo.string>> -> !milo.ref<!milo.string>
    %lb = milo.load %b0 : !milo.ref<!milo.string>
    %t = milo.string.lit "t"
    %rb = milo.string.concat %lb, %t
    %b1 = milo.field_ref %d[0] : !milo.ref<!milo.struct<"Doc", !milo.string>> -> !milo.ref<!milo.string>
    milo.store %rb, %b1 : !milo.ref<!milo.string>
    milo.yield
  }
  milo.return
}

// CHECK-LABEL: func.func @leave_alone
// CHECK-NOT:   milo.string.append
// CHECK:       milo.string.concat
// CHECK:       milo.string.concat
func.func @leave_alone() {
  %s = milo.var "s" owned : !milo.ref<!milo.string>
  milo.scope %s : !milo.ref<!milo.string> {
    %l = milo.load %s : !milo.ref<!milo.string>
    %l2 = milo.load %s : !milo.ref<!milo.string>
    %r = milo.string.concat %l, %l2
    milo.store %r, %s : !milo.ref<!milo.string>
    %m = milo.load %s : !milo.ref<!milo.string>
    func.call @touch(%s) : (!milo.ref<!milo.string>) -> ()
    %x = milo.string.lit "x"
    %r2 = milo.string.concat %m, %x
    milo.store %r2, %s : !milo.ref<!milo.string>
    milo.yield
  }
  milo.return
}
