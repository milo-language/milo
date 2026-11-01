// RUN: milo-opt %s --milo-scope-drops --milo-lower-structured-cf --milo-elaborate-drops --convert-milo-to-llvm | FileCheck %s
// A type with its own `impl Drop` (`"Noisy" drop`) has drop glue though none of its
// fields do: an owned slot of it may exist, its scope drops it, a store over it drops the
// old value first, and the drop calls legacy's glue (which runs the user's drop).

// CHECK-LABEL: llvm.func @noisy
// CHECK:     llvm.call @milo.drop.SNoisy
// CHECK:     llvm.call @milo.drop.SNoisy
// CHECK-NOT: llvm.call @milo.drop.SNoisy
// CHECK:     llvm.return
func.func @noisy(%a: si64, %b: si64) {
  %n = milo.var "n" owned : !milo.ref<!milo.struct<"Noisy" drop, si64>>
  milo.scope %n : !milo.ref<!milo.struct<"Noisy" drop, si64>> {
    %x = milo.struct.new %a : si64 -> !milo.struct<"Noisy" drop, si64>
    milo.store %x, %n : !milo.ref<!milo.struct<"Noisy" drop, si64>>
    %y = milo.struct.new %b : si64 -> !milo.struct<"Noisy" drop, si64>
    milo.store %y, %n : !milo.ref<!milo.struct<"Noisy" drop, si64>>
    milo.yield
  }
  milo.return
}

// The marker round-trips on enums too.
// CHECK-LABEL: llvm.func @slot
// CHECK:     llvm.call @milo.drop.ESlot
func.func @slot(%a: si64) {
  %s = milo.var "s" owned : !milo.ref<!milo.enum<"Slot" drop, size = 16, align = 8, [0: (), 1: (si64 at 8)]>>
  milo.scope %s : !milo.ref<!milo.enum<"Slot" drop, size = 16, align = 8, [0: (), 1: (si64 at 8)]>> {
    %e = milo.enum.new 1 (%a : si64) -> !milo.enum<"Slot" drop, size = 16, align = 8, [0: (), 1: (si64 at 8)]>
    milo.store %e, %s : !milo.ref<!milo.enum<"Slot" drop, size = 16, align = 8, [0: (), 1: (si64 at 8)]>>
    milo.yield
  }
  milo.return
}
