// RUN: milo-opt %s --milo-lower-structured-cf --convert-milo-to-llvm --reconcile-unrealized-casts | FileCheck %s
// Structs are LLVM's identified structs of legacy's names, built and read by value; a
// field place is a struct GEP. Enums go through an entry-block slot: the i32 tag at
// byte 0, each payload field at the byte offset its type spells. milo.match switches on
// the tag and reads an arm's payload at the arm's entry.

// CHECK-LABEL: llvm.func @point
// CHECK:   %[[U:.*]] = llvm.mlir.undef : !llvm.struct<"Point", (i64, f64)>
// CHECK:   %[[A:.*]] = llvm.insertvalue %arg0, %[[U]][0]
// CHECK:   %[[B:.*]] = llvm.insertvalue %arg1, %[[A]][1]
// CHECK:   llvm.extractvalue %[[B]][1] : !llvm.struct<"Point", (i64, f64)>
func.func @point(%x: si64, %y: f64) -> f64 {
  %p = milo.struct.new %x, %y : si64, f64 -> !milo.struct<"Point", si64, f64>
  %f = milo.struct.get %p[1] : !milo.struct<"Point", si64, f64> -> f64
  milo.return %f : f64
}

// CHECK-LABEL: llvm.func @bump
// CHECK:   llvm.getelementptr inbounds %arg0[0, 0] : (!llvm.ptr) -> !llvm.ptr, !llvm.struct<"Point", (i64, f64)>
func.func @bump(%r: !milo.ref<!milo.struct<"Point", si64, f64>>, %x: si64) {
  %f = milo.field_ref %r[0] : !milo.ref<!milo.struct<"Point", si64, f64>> -> !milo.ref<si64>
  milo.store %x, %f : !milo.ref<si64>
  milo.return
}

// CHECK-LABEL: llvm.func @rect
// CHECK:   %[[S:.*]] = llvm.alloca %{{.*}} x !llvm.struct<"Shape", (array<3 x i64>)>
// CHECK:   llvm.store %{{.*}}, %[[S]] : i32, !llvm.ptr
// CHECK:   %[[P8:.*]] = llvm.getelementptr inbounds %[[S]][8] : (!llvm.ptr) -> !llvm.ptr, i8
// CHECK:   llvm.store %arg0, %[[P8]] : f64, !llvm.ptr
// CHECK:   %[[P16:.*]] = llvm.getelementptr inbounds %[[S]][16] : (!llvm.ptr) -> !llvm.ptr, i8
// CHECK:   llvm.store %arg1, %[[P16]] : f64, !llvm.ptr
// CHECK:   llvm.load %[[S]] : !llvm.ptr -> !llvm.struct<"Shape", (array<3 x i64>)>
func.func @rect(%w: f64, %h: f64) -> !milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16), 2: ()]> {
  %s = milo.enum.new 1 (%w, %h : f64, f64) -> !milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16), 2: ()]>
  milo.return %s : !milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16), 2: ()]>
}

// CHECK-LABEL: llvm.func @area
// CHECK:   llvm.switch %{{.*}} : i32, ^[[DEAD:.*]] [
// CHECK-NEXT:     0: ^[[C:[a-z0-9]+]],
// CHECK-NEXT:     1: ^[[R:[a-z0-9]+]],
// CHECK-NEXT:     2: ^[[E:[a-z0-9]+]]
// CHECK-NEXT:   ]
// CHECK: ^[[R]]:
// CHECK:   llvm.getelementptr inbounds %{{.*}}[16] : (!llvm.ptr) -> !llvm.ptr, i8
// CHECK:   llvm.fmul
// CHECK: ^[[DEAD]]:
// CHECK-NEXT:   llvm.intr.trap
func.func @area(%s: !milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16), 2: ()]>) -> f64 {
  %a = milo.match %s : !milo.enum<"Shape", size = 24, align = 8, [0: (f64 at 8), 1: (f64 at 8, f64 at 16), 2: ()]> -> f64 [0, 1, 2] {
  ^bb0(%r: f64):
    %rr = milo.mul %r, %r : f64
    milo.yield %rr : f64
  }, {
  ^bb0(%w: f64, %h: f64):
    %wh = milo.mul %w, %h : f64
    milo.yield %wh : f64
  }, {
    %z = milo.const 0.0 : f64
    milo.yield %z : f64
  }
  milo.return %a : f64
}

// A literal match with a default arm: the switch is on the int itself.
// CHECK-LABEL: llvm.func @digit
// CHECK:   llvm.switch %arg0 : i8, ^[[D:.*]] [
// CHECK-NEXT:     48: ^{{.*}},
// CHECK-NEXT:     -1: ^{{.*}}
func.func @digit(%c: ui8) -> si64 {
  %r = milo.match %c : ui8 -> si64 [48, 255] default {
    %a = milo.const 0 : si64
    milo.yield %a : si64
  }, {
    %b = milo.const 255 : si64
    milo.yield %b : si64
  }, {
    %m = milo.const -1 : si64
    milo.return %m : si64
  }
  milo.return %r : si64
}

// A place-only enum literal is built where it lives: the tag stored at offset 0, then the
// payload through its field place.
// CHECK-LABEL: llvm.func @set_tag
// CHECK:       %[[T:.*]] = llvm.mlir.constant(2 : i32) : i32
// CHECK:       llvm.store %[[T]], %arg0 : i32, !llvm.ptr
// CHECK:       %[[F:.*]] = llvm.getelementptr inbounds %arg0[8] : (!llvm.ptr) -> !llvm.ptr, i8
// CHECK:       llvm.store %arg1, %[[F]] : f64, !llvm.ptr
func.func @set_tag(%e: !milo.ref<!milo.enum<"Big", size = 16, align = 8, [0: (), 2: (f64 at 8)]>>, %x: f64) {
  milo.enum.set_tag %e, 2 : !milo.ref<!milo.enum<"Big", size = 16, align = 8, [0: (), 2: (f64 at 8)]>>
  %f = milo.enum.field_ref %e[2, 0] : !milo.ref<!milo.enum<"Big", size = 16, align = 8, [0: (), 2: (f64 at 8)]>> -> !milo.ref<f64>
  milo.store %x, %f init : !milo.ref<f64>
  milo.return
}
