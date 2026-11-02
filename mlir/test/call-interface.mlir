// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --milo-elaborate-drops | FileCheck %s
// milo.closure.call is a CallOpInterface (an indirect call), so MLIR's dataflow framework
// takes it through its call path: milo-elaborate-drops' call transfer (a call cannot fill
// or empty this function's slots) decides the slot state after it. A transfer that lost
// the state would drop `s` behind a flag, or not at all.

// CHECK-LABEL: func @drop_after_call
// CHECK:         %[[S:.*]] = milo.var "s" owned
// CHECK:         milo.store %{{.*}}, %[[S]]
// CHECK:         milo.closure.call
// CHECK-NEXT:    milo.drop %[[S]] :
// CHECK-NEXT:    milo.return
func.func @drop_after_call(%f: !milo.fn<(si64) -> si64>, %x: si64) {
  %s = milo.var "s" owned : !milo.ref<!milo.string>
  milo.scope %s : !milo.ref<!milo.string> {
    %a = milo.string.lit "a"
    milo.store %a, %s : !milo.ref<!milo.string>
    %r = milo.closure.call %f(%x) : !milo.fn<(si64) -> si64>, si64 -> si64
    milo.yield
  }
  milo.return
}
