// RUN: milo-opt %s --cse --canonicalize | FileCheck %s
// milo.string.share adds a count to the buffer: two shares of one place are two owners
// (`pair(s, s)`), never one value used twice, so CSE keeps both.

// CHECK-LABEL: func @two_owners
// CHECK:       %[[A:.*]] = milo.string.share %arg0
// CHECK:       %[[B:.*]] = milo.string.share %arg0
// CHECK:       call @pair(%[[A]], %[[B]])
func.func private @pair(!milo.string, !milo.string)
func.func @two_owners(%s: !milo.ref<!milo.string>) {
  %a = milo.string.share %s : !milo.ref<!milo.string>
  %b = milo.string.share %s : !milo.ref<!milo.string>
  func.call @pair(%a, %b) : (!milo.string, !milo.string) -> ()
  milo.return
}
