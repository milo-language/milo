// RUN: milo-opt %s | milo-opt | FileCheck %s
// Aggregates that hold themselves through a Vec: inside its own body a type is spelled by
// name alone and is the same type, so the printer stops there and the text round-trips.
// A body spelled again inside itself (a field type written whole) is accepted when it is
// the same body.

// CHECK-LABEL: func.func @tree
// CHECK-SAME:  !milo.struct<"Tree", !milo.string, !milo.vecval<!milo.struct<"Tree">>>
func.func @tree(%t: !milo.struct<"Tree", !milo.string, !milo.vecval<!milo.struct<"Tree">>>) {
  milo.return
}

// CHECK-LABEL: func.func @json
// CHECK-SAME:  !milo.enum<"Val", size = 32, align = 8, [0: (), 1: (!milo.vecval<!milo.enum<"Val">> at 8), 2: (!milo.vecval<!milo.struct<"Member", !milo.string, !milo.enum<"Val">>> at 8)]>
// CHECK-LABEL: func.func @member
// CHECK-SAME:  !milo.struct<"Member", !milo.string, !milo.enum<"Val", size = 32, align = 8, [0: (), 1: (!milo.vecval<!milo.enum<"Val">> at 8), 2: (!milo.vecval<!milo.struct<"Member">> at 8)]>>
func.func @json(%v: !milo.enum<"Val", size = 32, align = 8, [0: (), 1: (!milo.vecval<!milo.enum<"Val">> at 8), 2: (!milo.vecval<!milo.struct<"Member", !milo.string, !milo.enum<"Val">>> at 8)]>) {
  milo.return
}
func.func @member(%m: !milo.struct<"Member", !milo.string, !milo.enum<"Val", size = 32, align = 8, [0: (), 1: (!milo.vecval<!milo.enum<"Val", size = 32, align = 8, [0: (), 1: (!milo.vecval<!milo.enum<"Val">> at 8), 2: (!milo.vecval<!milo.struct<"Member">> at 8)]>> at 8), 2: (!milo.vecval<!milo.struct<"Member">> at 8)]>>) {
  milo.return
}

// CHECK-LABEL: func.func @empty
// CHECK-SAME:  !milo.struct<"Unit">
func.func @empty(%u: !milo.struct<"Unit">) {
  milo.return
}
