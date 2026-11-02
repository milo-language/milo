// RUN: milo-opt %s --milo-lower-structured-cf --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// A niche enum is legacy's `{ P }`: no tag word. The fieldless variant is the niche value
// in the payload's leading integer, so building it stores that value, building the payload
// variant stores only the payload, and the tag is a compare of that integer with the niche.

// CHECK-LABEL: llvm.func @none
// CHECK:   %[[N:.*]] = llvm.mlir.constant(2147483647 : i32) : i32
// CHECK:   llvm.store %[[N]], %{{.*}} : i32, !llvm.ptr
// CHECK:   llvm.load %{{.*}} : !llvm.ptr -> !llvm.struct<"Opt", (i32)>
func.func @none() -> !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]> {
  %e = milo.enum.new 1 -> !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]>
  milo.return %e : !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]>
}

// CHECK-LABEL: llvm.func @some
// CHECK-NOT:   llvm.mlir.constant({{.*}} : i32)
// CHECK:   llvm.store %arg0, %{{.*}} : i32, !llvm.ptr
// CHECK:   llvm.load %{{.*}} : !llvm.ptr -> !llvm.struct<"Opt", (i32)>
func.func @some(%x: si32) -> !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]> {
  %e = milo.enum.new 0 (%x : si32) -> !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]>
  milo.return %e : !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]>
}

// A payload that is a one-field struct: the niche is its leading i8 (u8 201, written -55).
// CHECK-LABEL: llvm.func @tag
// CHECK:   %[[R:.*]] = llvm.load %{{.*}} : !llvm.ptr -> i8
// CHECK:   %[[C:.*]] = llvm.icmp "eq" %[[R]], %{{.*}} : i8
// CHECK:   llvm.select %[[C]], %{{.*}}, %{{.*}} : i1, i32
func.func @tag(%e: !milo.enum<"OptB", niche = -55 : i8, [0: (), 1: (!milo.struct<"B", ui8> at 0)]>) -> si32 {
  %t = milo.enum.tag %e : !milo.enum<"OptB", niche = -55 : i8, [0: (), 1: (!milo.struct<"B", ui8> at 0)]>
  milo.return %t : si32
}

// A match reads the arm's payload at offset 0.
// CHECK-LABEL: llvm.func @unwrap_or
// CHECK:   llvm.icmp "eq" %{{.*}}, %{{.*}} : i32
// CHECK:   llvm.switch
// CHECK:   llvm.load %{{.*}} : !llvm.ptr -> i32
func.func @unwrap_or(%e: !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]>, %d: si32) -> si32 {
  %r = milo.match %e : !milo.enum<"Opt", niche = 2147483647 : i32, [0: (si32 at 0), 1: ()]> -> si32 [0, 1] {
  ^bb0(%x: si32):
    milo.yield %x : si32
  }, {
    milo.yield %d : si32
  }
  milo.return %r : si32
}

// In place: setting the fieldless variant writes the niche, the payload variant writes
// nothing, and tag_at compares the integer at the place.
// CHECK-LABEL: llvm.func @in_place
// CHECK:   %[[N:.*]] = llvm.mlir.constant(-32768 : i16) : i16
// CHECK:   llvm.store %[[N]], %arg0 : i16, !llvm.ptr
// CHECK-NEXT:   %[[R:.*]] = llvm.load %arg0 : !llvm.ptr -> i16
// CHECK:   llvm.icmp "eq" %[[R]], %{{.*}} : i16
func.func @in_place(%r: !milo.ref<!milo.enum<"OptN", niche = -32768 : i16, [0: (si16 at 0), 1: ()]>>) -> si32 {
  milo.enum.set_tag %r, 1 : !milo.ref<!milo.enum<"OptN", niche = -32768 : i16, [0: (si16 at 0), 1: ()]>>
  milo.enum.set_tag %r, 0 : !milo.ref<!milo.enum<"OptN", niche = -32768 : i16, [0: (si16 at 0), 1: ()]>>
  %t = milo.enum.tag_at %r : !milo.ref<!milo.enum<"OptN", niche = -32768 : i16, [0: (si16 at 0), 1: ()]>>
  milo.return %t : si32
}
