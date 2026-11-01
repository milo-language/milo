// RUN: milo-opt %s --convert-milo-to-llvm | FileCheck %s
// Each scalar op's lowering, traps included: the messages and routines must match legacy
// codegen exactly (src/codegen.ts emitScalarBinOp, emitDivByZeroCheck, emitShiftCheck).

// CHECK-DAG: llvm.mlir.global private constant @{{.*}}("t.milo\00")
// CHECK-DAG: llvm.mlir.global private constant @{{.*}}("milo: division by zero at t.milo:4:9\0A\00")
// CHECK-DAG: llvm.mlir.global private constant @{{.*}}("milo: division overflow (i32::MIN / -1) at t.milo:4:9\0A\00")
// CHECK-DAG: llvm.mlir.global private constant @{{.*}}("milo: shift amount out of range (>= 16) at t.milo:6:2\0A\00")
// CHECK-DAG: llvm.mlir.global private constant @{{.*}}("milo: aliasing '&mut' arguments at t.milo:8:3 (two mutable borrows of the same value in one call)\0A\00")

// Signed add: sadd.with.overflow, the overflow routine with file and line on the failing
// edge, the sum on the other.
// CHECK-LABEL: llvm.func @add
// CHECK:   %[[P:.*]] = "llvm.intr.sadd.with.overflow"(%arg0, %arg1)
// CHECK:   %[[V:.*]] = llvm.extractvalue %[[P]][0]
// CHECK:   %[[O:.*]] = llvm.extractvalue %[[P]][1]
// CHECK:   llvm.cond_br %[[O]], ^[[FAIL:bb[0-9]+]], ^[[OK:bb[0-9]+]]
// CHECK: ^[[FAIL]]:
// CHECK:   %[[LINE:.*]] = llvm.mlir.constant(3 : i32)
// CHECK:   llvm.call @__milo_overflow_fail(%{{.*}}, %[[LINE]])
// CHECK-NEXT:   llvm.unreachable
// CHECK: ^[[OK]]:
// CHECK-NEXT:   llvm.return %[[V]] : i32
func.func @add(%a: si32, %b: si32) -> si32 {
  %0 = milo.add %a, %b : si32 loc("t.milo":3:7)
  milo.return %0 : si32
}

// CHECK-LABEL: llvm.func @unsigned_sub
// CHECK: "llvm.intr.usub.with.overflow"
func.func @unsigned_sub(%a: ui8, %b: ui8) -> ui8 {
  %0 = milo.sub %a, %b : ui8 loc("t.milo":3:7)
  milo.return %0 : ui8
}

// CHECK-LABEL: llvm.func @wrapping_mul
// CHECK-NEXT: llvm.mul %arg0, %arg1 : i64
// CHECK-NEXT: llvm.return
func.func @wrapping_mul(%a: si64, %b: si64) -> si64 {
  %0 = milo.mul %a, %b wrapping : si64 loc("t.milo":3:7)
  milo.return %0 : si64
}

// Checked negation is 0 - x through ssub.with.overflow.
// CHECK-LABEL: llvm.func @neg
// CHECK: %[[Z:.*]] = llvm.mlir.constant(0 : i32)
// CHECK: "llvm.intr.ssub.with.overflow"(%[[Z]], %arg0)
func.func @neg(%a: si32) -> si32 {
  %0 = milo.neg %a : si32 loc("t.milo":3:7)
  milo.return %0 : si32
}

// Zero first, then MIN / -1, then the division.
// CHECK-LABEL: llvm.func @sdiv
// CHECK:   %[[Z:.*]] = llvm.icmp "eq" %arg1, %{{.*}} : i32
// CHECK:   llvm.cond_br %[[Z]]
// CHECK:   llvm.call @__milo_mlir_panic
// CHECK:   llvm.icmp "eq" %arg0, %{{.*}} : i32
// CHECK:   llvm.icmp "eq" %arg1, %{{.*}} : i32
// CHECK:   %[[OVF:.*]] = llvm.and
// CHECK:   llvm.cond_br %[[OVF]]
// CHECK:   llvm.call @__milo_mlir_panic
// CHECK:   llvm.sdiv %arg0, %arg1 : i32
func.func @sdiv(%a: si32, %b: si32) -> si32 {
  %0 = milo.div %a, %b : si32 loc("t.milo":4:9)
  milo.return %0 : si32
}

// @wrapping: zero still traps; MIN / -1 divides by 1 and selects MIN.
// CHECK-LABEL: llvm.func @wrapping_rem
// CHECK:   llvm.call @__milo_mlir_panic
// CHECK:   %[[SAFE:.*]] = llvm.select %{{.*}}, %{{.*}}, %arg1
// CHECK:   %[[RAW:.*]] = llvm.srem %arg0, %[[SAFE]]
// CHECK:   llvm.select %{{.*}}, %{{.*}}, %[[RAW]]
func.func @wrapping_rem(%a: si32, %b: si32) -> si32 {
  %0 = milo.rem %a, %b wrapping : si32 loc("t.milo":4:9)
  milo.return %0 : si32
}

// Unsigned: only the zero check.
// CHECK-LABEL: llvm.func @udiv
// CHECK-COUNT-1: llvm.call @__milo_mlir_panic
// CHECK-NOT: llvm.call
// CHECK: llvm.udiv
func.func @udiv(%a: ui32, %b: ui32) -> ui32 {
  %0 = milo.div %a, %b : ui32 loc("t.milo":4:9)
  milo.return %0 : ui32
}

// CHECK-LABEL: llvm.func @shifts
// CHECK:   %[[W:.*]] = llvm.mlir.constant(16 : i16)
// CHECK:   %[[BAD:.*]] = llvm.icmp "uge" %arg1, %[[W]]
// CHECK:   llvm.cond_br %[[BAD]]
// CHECK:   llvm.call @__milo_mlir_panic
// CHECK:   %[[S:.*]] = llvm.lshr %arg0, %arg1
// CHECK:   %[[M:.*]] = llvm.mlir.constant(15 : i16)
// CHECK:   %[[A:.*]] = llvm.and %arg1, %[[M]]
// CHECK:   llvm.shl %[[S]], %[[A]]
func.func @shifts(%a: ui16, %b: ui16) -> ui16 {
  %0 = milo.shr %a, %b : ui16 loc("t.milo":6:2)
  %1 = milo.shl %0, %b wrapping : ui16 loc("t.milo":6:2)
  milo.return %1 : ui16
}

// CHECK-LABEL: llvm.func @ashr
// CHECK: llvm.ashr
func.func @ashr(%a: si16, %b: si16) -> si16 {
  %0 = milo.shr %a, %b : si16 loc("t.milo":6:2)
  milo.return %0 : si16
}

// Signedness picks the predicate; float `ne` is unordered.
// CHECK-LABEL: llvm.func @cmps
// CHECK: llvm.icmp "slt"
// CHECK: llvm.icmp "ult"
// CHECK: llvm.fcmp "une"
// CHECK: llvm.fcmp "oge"
func.func @cmps(%a: si32, %b: ui32, %x: f64) -> i1 {
  %0 = milo.cmp lt, %a, %a : si32
  %1 = milo.cmp lt, %b, %b : ui32
  %2 = milo.cmp ne, %x, %x : f64
  %3 = milo.cmp ge, %x, %x : f64
  %4 = milo.and %0, %1 : i1
  %5 = milo.or %2, %3 : i1
  %6 = milo.xor %4, %5 : i1
  milo.return %6 : i1
}

// CHECK-LABEL: llvm.func @casts
// CHECK: llvm.call_intrinsic "llvm.fptosi.sat.i32.f64"(%arg0)
// CHECK: llvm.fptrunc %arg0 : f64 to f32
// CHECK: llvm.call_intrinsic "llvm.fptoui.sat.i8.f32"
// CHECK: llvm.zext %{{.*}} : i8 to i64
// CHECK: llvm.sext %{{.*}} : i32 to i64
// CHECK: llvm.zext %arg1 : i1 to i64
// CHECK: llvm.sitofp %arg1 : i1 to f64
// CHECK: llvm.uitofp %{{.*}} : i8 to f32
// CHECK: llvm.trunc %{{.*}} : i64 to i16
// CHECK: llvm.fpext
func.func @casts(%x: f64, %b: i1) -> si64 {
  %0 = milo.cast %x : f64 to si32
  %f = milo.cast %x : f64 to f32
  %1 = milo.cast %f : f32 to ui8
  %2 = milo.cast %1 : ui8 to si64
  %3 = milo.cast %0 : si32 to si64
  %4 = milo.cast %b : i1 to si64
  %5 = milo.cast %b : i1 to f64
  %6 = milo.cast %1 : ui8 to f32
  %7 = milo.cast %3 : si64 to ui16
  %8 = milo.cast %6 : f32 to f64
  %9 = milo.add %2, %4 wrapping : si64
  milo.return %9 : si64
}

// Same LLVM type: no instruction at all.
// CHECK-LABEL: llvm.func @same_width
// CHECK-NEXT: llvm.return %arg0 : i32
func.func @same_width(%a: si32) -> ui32 {
  %0 = milo.cast %a : si32 to ui32
  milo.return %0 : ui32
}

// CHECK-LABEL: llvm.func @locals
// CHECK: %[[S:.*]] = llvm.alloca %{{.*}} x i32
// CHECK: llvm.store %{{.*}}, %[[S]]
// CHECK: llvm.load %[[S]] : !llvm.ptr -> i32
// CHECK: llvm.xor
func.func @locals() -> si32 {
  %r = milo.var "x" : !milo.ref<si32>
  %c = milo.const -7 : si32
  milo.store %c, %r : !milo.ref<si32>
  %v = milo.load %r : !milo.ref<si32>
  %n = milo.not %v : si32
  milo.return %n : si32
}

// CHECK-LABEL: llvm.func @unreachable
// CHECK: llvm.intr.trap
// CHECK-NEXT: llvm.unreachable
func.func @unreachable() -> si32 {
  milo.unreachable
}

// Two by-ref args, one `&mut`: equal addresses panic with the legacy message.
// CHECK-LABEL: llvm.func @unaliased
// CHECK:   %[[EQ:.*]] = llvm.icmp "eq" %arg0, %arg1 : !llvm.ptr
// CHECK:   llvm.cond_br %[[EQ]], ^[[BAD:bb[0-9]+]], ^[[OK:bb[0-9]+]]
// CHECK: ^[[BAD]]:
// CHECK:   llvm.call @__milo_mlir_panic
// CHECK: ^[[OK]]:
// CHECK-NEXT: llvm.return
func.func @unaliased(%a: !milo.ref<si64>, %b: !milo.ref<f64>) {
  milo.check_unaliased %a, %b : !milo.ref<si64>, !milo.ref<f64> loc("t.milo":8:3)
  milo.return
}
