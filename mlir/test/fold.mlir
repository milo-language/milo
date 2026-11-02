// RUN: milo-opt %s --canonicalize | FileCheck %s
// Folders of the source-level ops. A checked op folds only when its constant operands
// cannot trap; one that would trap stays, so the program still panics where Milo panics.
// Floats are not folded here (LLVM folds them after lowering, NaN payloads included).

// CHECK-LABEL: func.func @add
// CHECK-DAG:     %[[A:.*]] = milo.const 7 : si32
// CHECK-DAG:     %[[W:.*]] = milo.const -56 : si8
// CHECK-DAG:     %[[O:.*]] = milo.add %{{.*}}, %{{.*}} : si8
// CHECK:         milo.print %[[A]], %[[O]], %[[W]] : si32, si8, si8
func.func @add() {
  %a = milo.const 3 : si32
  %b = milo.const 4 : si32
  %c = milo.const 100 : si8
  %s = milo.add %a, %b : si32
  %o = milo.add %c, %c : si8
  %w = milo.add %c, %c wrapping : si8
  milo.print %s, %o, %w : si32, si8, si8
  milo.return
}

// CHECK-LABEL: func.func @sub_mul_unsigned
// CHECK-DAG:     %[[W:.*]] = milo.const 255 : ui8
// CHECK-DAG:     %[[M:.*]] = milo.const 200 : ui8
// CHECK-DAG:     %[[U:.*]] = milo.sub %{{.*}}, %{{.*}} : ui8
// CHECK-DAG:     %[[O:.*]] = milo.mul %{{.*}}, %{{.*}} : ui8
// CHECK:         milo.print %[[U]], %[[W]], %[[M]], %[[O]] : ui8, ui8, ui8, ui8
func.func @sub_mul_unsigned() {
  %one = milo.const 1 : ui8
  %two = milo.const 2 : ui8
  %c100 = milo.const 100 : ui8
  %u = milo.sub %one, %two : ui8
  %w = milo.sub %one, %two wrapping : ui8
  %m = milo.mul %c100, %two : ui8
  %o = milo.mul %c100, %c100 : ui8
  milo.print %u, %w, %m, %o : ui8, ui8, ui8, ui8
  milo.return
}

// CHECK-LABEL: func.func @div_rem
// CHECK-DAG:     %[[Q:.*]] = milo.const -3 : si32
// CHECK-DAG:     %[[R:.*]] = milo.const -1 : si32
// CHECK-DAG:     %[[MIN:.*]] = milo.const -128 : si8
// CHECK-DAG:     %[[Z:.*]] = milo.const 0 : si8
// CHECK-DAG:     %[[D0:.*]] = milo.div %{{.*}}, %{{.*}} wrapping : si32
// CHECK-DAG:     %[[OV:.*]] = milo.div %{{.*}}, %{{.*}} : si8
// CHECK-DAG:     %[[RO:.*]] = milo.rem %{{.*}}, %{{.*}} : si8
// CHECK:         milo.print %[[Q]], %[[R]], %[[D0]], %[[OV]], %[[MIN]], %[[RO]], %[[Z]]
func.func @div_rem() {
  %m7 = milo.const -7 : si32
  %two = milo.const 2 : si32
  %zero = milo.const 0 : si32
  %min = milo.const -128 : si8
  %m1 = milo.const -1 : si8
  %q = milo.div %m7, %two : si32
  %r = milo.rem %m7, %two : si32
  %d0 = milo.div %m7, %zero wrapping : si32
  %ov = milo.div %min, %m1 : si8
  %ovw = milo.div %min, %m1 wrapping : si8
  %ro = milo.rem %min, %m1 : si8
  %row = milo.rem %min, %m1 wrapping : si8
  milo.print %q, %r, %d0, %ov, %ovw, %ro, %row : si32, si32, si32, si8, si8, si8, si8
  milo.return
}

// CHECK-LABEL: func.func @div_unsigned
// CHECK:         %[[Q:.*]] = milo.const 127 : ui8
// CHECK:         milo.print %[[Q]] : ui8
func.func @div_unsigned() {
  %a = milo.const 254 : ui8
  %two = milo.const 2 : ui8
  %q = milo.div %a, %two : ui8
  milo.print %q : ui8
  milo.return
}

// CHECK-LABEL: func.func @shifts
// CHECK-DAG:     %[[L:.*]] = milo.const 8 : si8
// CHECK-DAG:     %[[S:.*]] = milo.const -4 : si8
// CHECK-DAG:     %[[U:.*]] = milo.const 15 : ui8
// CHECK-DAG:     %[[W:.*]] = milo.const 1 : si8
// CHECK-DAG:     %[[N:.*]] = milo.const -128 : si8
// CHECK-DAG:     %[[O:.*]] = milo.shl %{{.*}}, %{{.*}} : si8
// CHECK-DAG:     %[[G:.*]] = milo.shr %{{.*}}, %{{.*}} : si8
// CHECK:         milo.print %[[L]], %[[S]], %[[U]], %[[O]], %[[W]], %[[G]], %[[N]]
func.func @shifts() {
  %one = milo.const 1 : si8
  %three = milo.const 3 : si8
  %eight = milo.const 8 : si8
  %m8 = milo.const -8 : si8
  %m1 = milo.const -1 : si8
  %f0 = milo.const 240 : ui8
  %four = milo.const 4 : ui8
  %l = milo.shl %one, %three : si8
  %s = milo.shr %m8, %one : si8
  %u = milo.shr %f0, %four : ui8
  %o = milo.shl %one, %eight : si8
  %w = milo.shl %one, %eight wrapping : si8
  %g = milo.shr %m8, %m1 : si8
  %n = milo.shl %one, %m1 wrapping : si8
  milo.print %l, %s, %u, %o, %w, %g, %n : si8, si8, ui8, si8, si8, si8, si8
  milo.return
}

// CHECK-LABEL: func.func @neg
// CHECK-DAG:     %[[A:.*]] = milo.const -5 : si32
// CHECK-DAG:     %[[MIN:.*]] = milo.const -128 : si8
// CHECK-DAG:     %[[UW:.*]] = milo.const 255 : ui8
// CHECK-DAG:     %[[UZ:.*]] = milo.const 0 : ui8
// CHECK-DAG:     %[[O:.*]] = milo.neg %{{.*}} : si8
// CHECK-DAG:     %[[UO:.*]] = milo.neg %{{.*}} : ui8
// CHECK:         milo.print %[[A]], %[[O]], %[[MIN]], %[[UO]], %[[UW]], %[[UZ]]
func.func @neg() {
  %five = milo.const 5 : si32
  %min = milo.const -128 : si8
  %one = milo.const 1 : ui8
  %zero = milo.const 0 : ui8
  %a = milo.neg %five : si32
  %o = milo.neg %min : si8
  %w = milo.neg %min wrapping : si8
  %uo = milo.neg %one : ui8
  %uw = milo.neg %one wrapping : ui8
  %uz = milo.neg %zero : ui8
  milo.print %a, %o, %w, %uo, %uw, %uz : si32, si8, si8, ui8, ui8, ui8
  milo.return
}

// Signedness from the operand type: 255 is -1 as si8, 255 as ui8.
// CHECK-LABEL: func.func @cmp
// CHECK-DAG:     %[[T:.*]] = milo.const true
// CHECK-DAG:     %[[F:.*]] = milo.const false
// CHECK-DAG:     %[[FL:.*]] = milo.cmp eq, %{{.*}}, %{{.*}} : f64
// CHECK:         milo.print %[[T]], %[[F]], %[[T]], %[[FL]]
func.func @cmp(%x: si64, %f: f64) {
  %a = milo.const -1 : si8
  %b = milo.const 1 : si8
  %c = milo.const 255 : ui8
  %d = milo.const 1 : ui8
  %lt = milo.cmp lt, %a, %b : si8
  %ult = milo.cmp lt, %c, %d : ui8
  %same = milo.cmp eq, %x, %x : si64
  %nan = milo.cmp eq, %f, %f : f64
  milo.print %lt, %ult, %same, %nan : i1, i1, i1, i1
  milo.return
}

// CHECK-LABEL: func.func @casts
// CHECK-SAME:    (%[[X:.*]]: si32, %[[Y:.*]]: si32)
// CHECK-DAG:     %[[E:.*]] = milo.const -1 : si64
// CHECK-DAG:     %[[Z:.*]] = milo.const 255 : ui64
// CHECK-DAG:     %[[T:.*]] = milo.const 44 : ui8
// CHECK-DAG:     %[[N:.*]] = milo.cast %[[Y]] : si32 to si16
// CHECK-DAG:     %[[NN:.*]] = milo.cast %[[N]] : si16 to si32
// CHECK:         milo.print %[[E]], %[[Z]], %[[T]], %[[X]], %[[X]], %[[NN]]
func.func @casts(%x: si32, %y: si32) {
  %m1 = milo.const -1 : si8
  %u = milo.const 255 : ui8
  %big = milo.const 300 : si32
  %e = milo.cast %m1 : si8 to si64
  %z = milo.cast %u : ui8 to ui64
  %t = milo.cast %big : si32 to ui8
  %same = milo.cast %x : si32 to si32
  %wide = milo.cast %x : si32 to ui64
  %back = milo.cast %wide : ui64 to si32
  %narrow = milo.cast %y : si32 to si16
  %nback = milo.cast %narrow : si16 to si32
  milo.print %e, %z, %t, %same, %back, %nback : si64, ui64, ui8, si32, si32, si32
  milo.return
}

// CHECK-LABEL: func.func @not_bits
// CHECK-SAME:    (%[[B:.*]]: i1)
// CHECK-DAG:     %[[N:.*]] = milo.const -6 : si32
// CHECK-DAG:     %[[A:.*]] = milo.const 4 : si32
// CHECK-DAG:     %[[O:.*]] = milo.const 7 : si32
// CHECK-DAG:     %[[X:.*]] = milo.const 3 : si32
// CHECK:         milo.print %[[B]], %[[N]], %[[A]], %[[O]], %[[X]]
func.func @not_bits(%b: i1) {
  %five = milo.const 5 : si32
  %six = milo.const 6 : si32
  %nb = milo.not %b : i1
  %nnb = milo.not %nb : i1
  %n = milo.not %five : si32
  %a = milo.and %five, %six : si32
  %o = milo.or %five, %six : si32
  %x = milo.xor %five, %six : si32
  milo.print %nnb, %n, %a, %o, %x : i1, si32, si32, si32, si32
  milo.return
}

// CHECK-LABEL: func.func @aggregates
// CHECK-SAME:    (%[[X:.*]]: si64, %[[Y:.*]]: f64)
// CHECK-DAG:     %[[T:.*]] = milo.const 1 : si32
// CHECK-NOT:     milo.struct.get
// CHECK-NOT:     milo.enum.tag
// CHECK:         milo.print %[[Y]], %[[T]] : f64, si32
func.func @aggregates(%x: si64, %y: f64) {
  %s = milo.struct.new %x, %y : si64, f64 -> !milo.struct<"P", si64, f64>
  %f = milo.struct.get %s[1] : !milo.struct<"P", si64, f64> -> f64
  %e = milo.enum.new 1 (%y : f64) -> !milo.enum<"E", size = 16, align = 8, [0: (), 1: (f64 at 8)]>
  %t = milo.enum.tag %e : !milo.enum<"E", size = 16, align = 8, [0: (), 1: (f64 at 8)]>
  milo.print %f, %t : f64, si32
  milo.return
}

// A milo.if on a constant is the region it takes; one whose region ends in a jump stays.
// CHECK-LABEL: func.func @if_const
// CHECK-SAME:    (%[[X:.*]]: si64, %[[Y:.*]]: si64)
// CHECK-NOT:     milo.if
// CHECK:         milo.print %[[X]] : si64
// CHECK-NEXT:    milo.print %[[Y]] : si64
// CHECK-NEXT:    milo.return
func.func @if_const(%x: si64, %y: si64) {
  %t = milo.const true
  %f = milo.const false
  %r = milo.if %t -> si64 {
    milo.yield %x : si64
  } else {
    milo.yield %y : si64
  }
  milo.print %r : si64
  milo.if %f {
    milo.print %x : si64
    milo.yield
  }
  milo.if %f {
    milo.print %x : si64
    milo.yield
  } else {
    milo.print %y : si64
    milo.yield
  }
  milo.return
}

// CHECK-LABEL: func.func @if_const_jump
// CHECK:         milo.if
// CHECK-NEXT:      milo.return
func.func @if_const_jump(%x: si64) -> si64 {
  %t = milo.const true
  milo.if %t {
    milo.return %x : si64
  }
  milo.return %x : si64
}

// CHECK-LABEL: func.func @if_const_break
// CHECK:         milo.loop
// CHECK-NEXT:      milo.if
// CHECK-NEXT:        milo.break
func.func @if_const_break() {
  %t = milo.const true
  milo.loop {
    milo.if %t {
      milo.break
    }
    milo.yield
  }
  milo.return
}
