// RUN: milo-opt %s --milo-lower-structured-cf --convert-milo-to-llvm | FileCheck %s
// milo.enum.field_ref is the payload field's place inside the enum: its byte offset
// from the enum's address, so a store through it writes the payload in place.

// CHECK-LABEL: llvm.func @grow
// CHECK:   %[[P:.*]] = llvm.getelementptr inbounds %arg0[8] : (!llvm.ptr) -> !llvm.ptr, i8
// CHECK:   llvm.load %[[P]] : !llvm.ptr -> f64
// CHECK:   llvm.store %{{.*}}, %[[P]] : f64, !llvm.ptr
func.func @grow(%s: !milo.ref<!milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16)]>>) {
  %r = milo.enum.field_ref %s[0, 0] : !milo.ref<!milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16)]>> -> !milo.ref<f64>
  %v = milo.load %r : !milo.ref<f64>
  %d = milo.add %v, %v : f64
  milo.store %d, %r : !milo.ref<f64>
  milo.return
}
