// RUN: milo-opt %s --milo-desugar -mlir-print-debuginfo -mlir-print-local-scope | FileCheck %s
// milo-desugar lowers the top layer to the core ops src/emit-mlir.ts prints for the same
// source: for-in to a milo.while over an entry-block index (Vec, slice, string) or a
// milo.for (array), `?` to a two-arm milo.match, `$"..."` to appends into a slot.

// The runtime pushes milo.interp calls, declared once each since the module had none.
// CHECK-DAG: func.func private @rtStringPushI64(!milo.ref<!milo.string>, si64) -> !milo.ptr
// CHECK-DAG: func.func private @rtStringPushU64(!milo.ref<!milo.string>, ui64) -> !milo.ptr
// CHECK-DAG: func.func private @rtStringPushF64(!milo.ref<!milo.string>, f64) -> !milo.ptr
// CHECK-DAG: func.func private @rtStringPushF32(!milo.ref<!milo.string>, f32) -> !milo.ptr
// CHECK-DAG: func.func private @rtStringPushBool(!milo.ref<!milo.string>, i1) -> !milo.ptr
// CHECK-DAG: func.func private @rtStringPushPtr(!milo.ref<!milo.string>, !milo.ptr) -> !milo.ptr
// CHECK-NOT: func.func private @rtStringPush
func.func private @use(si32)
func.func private @useb(ui8)
func.func private @user(!milo.ref<!milo.string>)
func.func private @"P$display"(!milo.ref<!milo.struct<"P", si32>>, !milo.ref<!milo.string>)
func.func private @"V$display"(!milo.vec<si32>, !milo.ref<!milo.string>)

// By value: data and len read once; the slot joins the entry block's slots; the index
// moves on before the element is read.
// CHECK-LABEL: func @vec_by_value
// CHECK-NEXT:   %[[K:.*]] = milo.var "k" : <si32>
// CHECK-NEXT:   %[[IDX:.*]] = milo.var "for.idx" : <si64>
// CHECK-NEXT:   milo.const 7 : si32
// CHECK-NEXT:   milo.store
// CHECK-NEXT:   %[[DATA:.*]] = milo.vec.data %arg0 : <si32>
// CHECK-NEXT:   %[[LEN:.*]] = milo.len %arg0 : <si32>
// CHECK-NEXT:   %[[Z:.*]] = milo.const 0 : si64
// CHECK-NEXT:   milo.store %[[Z]], %[[IDX]] : <si64>
// CHECK-NEXT:   milo.while {
// CHECK-NEXT:     %[[I0:.*]] = milo.load %[[IDX]] : <si64>
// CHECK-NEXT:     %[[C:.*]] = milo.cmp lt, %[[I0]], %[[LEN]] : si64
// CHECK-NEXT:     milo.condition %[[C]]
// CHECK-NEXT:   } do {
// CHECK-NEXT:     %[[I:.*]] = milo.load %[[IDX]] : <si64>
// CHECK-NEXT:     %[[ONE:.*]] = milo.const 1 : si64
// CHECK-NEXT:     %[[NEXT:.*]] = milo.add %[[I]], %[[ONE]] wrapping : si64
// CHECK-NEXT:     milo.store %[[NEXT]], %[[IDX]] : <si64>
// CHECK-NEXT:     %[[EP:.*]] = milo.ptr.elem %[[DATA]][%[[I]]] : si32
// CHECK-NEXT:     %[[X:.*]] = milo.ptr.load %[[EP]] : si32
// CHECK-NEXT:     call @use(%[[X]]) : (si32) -> ()
// CHECK-NEXT:     milo.yield
// CHECK-NEXT:   }
// CHECK-NEXT:   milo.return
// CHECK-NOT: milo.for_in
func.func @vec_by_value(%v: !milo.vec<si32>) {
  %k = milo.var "k" : !milo.ref<si32>
  %c = milo.const 7 : si32
  milo.store %c, %k : !milo.ref<si32>
  milo.for_in %v : !milo.vec<si32> {
  ^bb0(%i: si64, %x: si32):
    func.call @use(%x) : (si32) -> ()
    milo.yield
  }
  milo.return
}

// By place: no data pointer; the element's place is milo.index.ref, with the loop's loc.
// break and continue inside the body now target the milo.while.
// CHECK-LABEL: func @vec_by_place
// CHECK-NEXT:   %[[IDX:.*]] = milo.var "for.idx" : <si64>
// CHECK-NEXT:   %[[LEN:.*]] = milo.len %arg0 : <!milo.string>
// CHECK-NEXT:   %[[Z:.*]] = milo.const 0 : si64
// CHECK-NEXT:   milo.store %[[Z]], %[[IDX]] : <si64>
// CHECK-NEXT:   milo.while {
// CHECK:        } do {
// CHECK-NEXT:     %[[I:.*]] = milo.load %[[IDX]] : <si64>
// CHECK-NEXT:     milo.const 1 : si64
// CHECK-NEXT:     milo.add
// CHECK-NEXT:     milo.store
// CHECK-NEXT:     %[[R:.*]] = milo.index.ref %arg0[%[[I]]] : <!milo.string> -> <!milo.string> loc("main.milo":4:3)
// CHECK-NEXT:     call @user(%[[R]])
// CHECK-NEXT:     milo.if %arg1 {
// CHECK-NEXT:       milo.break
// CHECK-NEXT:     }
// CHECK-NEXT:     milo.continue
// CHECK-NEXT:   }
func.func @vec_by_place(%v: !milo.vec<!milo.string>, %stop: i1) {
  milo.for_in %v : !milo.vec<!milo.string> {
  ^bb0(%i: si64, %x: !milo.ref<!milo.string>):
    func.call @user(%x) : (!milo.ref<!milo.string>) -> ()
    milo.if %stop {
      milo.break
    }
    milo.continue
  } loc("main.milo":4:3)
  milo.return
}

// A string's bytes: data and len of the value, each byte a ui8 read through its data.
// CHECK-LABEL: func @string_bytes
// CHECK-NEXT:   %[[IDX:.*]] = milo.var "for.idx" : <si64>
// CHECK-NEXT:   %[[DATA:.*]] = milo.string.data %arg0
// CHECK-NEXT:   %[[LEN:.*]] = milo.string.len %arg0
// CHECK-NEXT:   milo.const 0 : si64
// CHECK-NEXT:   milo.store
// CHECK-NEXT:   milo.while {
// CHECK:          milo.cmp lt, %{{.*}}, %[[LEN]] : si64
// CHECK:        } do {
// CHECK:          %[[EP:.*]] = milo.ptr.elem %[[DATA]][%{{.*}}] : ui8
// CHECK-NEXT:     %[[B:.*]] = milo.ptr.load %[[EP]] : ui8
// CHECK-NEXT:     call @useb(%[[B]])
func.func @string_bytes(%s: !milo.string) {
  milo.for_in %s : !milo.string {
  ^bb0(%i: si64, %b: ui8):
    func.call @useb(%b) : (ui8) -> ()
    milo.yield
  }
  milo.return
}

// A fixed array: milo.for 0 to N, each element's place by milo.array.index; the index
// block argument is the for's induction variable.
// CHECK-LABEL: func @array_places
// CHECK-NEXT:   %[[Z:.*]] = milo.const 0 : si64
// CHECK-NEXT:   %[[N:.*]] = milo.const 3 : si64
// CHECK-NEXT:   milo.for %[[Z]] to %[[N]] : si64 {
// CHECK-NEXT:   ^bb0(%[[I:[^:]*]]: si64
// CHECK-NEXT:     %[[R:.*]] = milo.array.index %arg0[%[[I]]] : <!milo.array<si32, 3>> -> <si32> loc("main.milo":9:5)
// CHECK-NEXT:     %[[X:.*]] = milo.load %[[R]] : <si32>
// CHECK-NEXT:     call @use(%[[X]])
// CHECK-NEXT:     milo.yield
// CHECK-NEXT:   }
func.func @array_places(%a: !milo.ref<!milo.array<si32, 3>>) {
  milo.for_in %a : !milo.ref<!milo.array<si32, 3>> {
  ^bb0(%i: si64, %x: !milo.ref<si32>):
    %v = milo.load %x : !milo.ref<si32>
    func.call @use(%v) : (si32) -> ()
    milo.yield
  } loc("main.milo":9:5)
  milo.return
}

// Nested: the inner loop's slot joins the entry block too.
// CHECK-LABEL: func @nested
// CHECK-NEXT:   milo.var "for.idx"
// CHECK-NEXT:   milo.var "for.idx"
// CHECK-NOT:    milo.var
// CHECK:        milo.while
// CHECK:        milo.while
func.func @nested(%v: !milo.vec<si32>, %w: !milo.vec<si32>) {
  milo.for_in %v : !milo.vec<si32> {
  ^bb0(%i: si64, %x: si32):
    milo.for_in %w : !milo.vec<si32> {
    ^bb0(%j: si64, %y: si32):
      milo.yield
    }
    milo.yield
  }
  milo.return
}

// `?` with both payloads: the ok arm yields its payload, the err arm is the try's region.
// CHECK-LABEL: func @try_payloads
// CHECK-NEXT:   %[[M:.*]] = milo.match %arg0 : !milo.enum<"Res"{{.*}}> -> si32 [0, 1] {
// CHECK-NEXT:   ^bb0(%[[X:[^:]*]]: si32
// CHECK-NEXT:     milo.yield %[[X]] : si32
// CHECK-NEXT:   }, {
// CHECK-NEXT:   ^bb0(%[[E:[^:]*]]: si64
// CHECK-NEXT:     %[[W:.*]] = milo.enum.new 1(%[[E]] : si64) -> <"Res"
// CHECK-NEXT:     milo.return %[[W]]
// CHECK-NEXT:   }
// CHECK-NEXT:   call @use(%[[M]])
func.func @try_payloads(%r: !milo.enum<"Res", size = 16, align = 8, [0: (si32 at 8), 1: (si64 at 8)]>) -> !milo.enum<"Res"> {
  %x = milo.try %r : !milo.enum<"Res"> -> si32 ok 0 err 1 {
  ^bb0(%e: si64):
    %w = milo.enum.new 1 (%e : si64) -> !milo.enum<"Res">
    milo.return %w : !milo.enum<"Res">
  }
  func.call @use(%x) : (si32) -> ()
  %z = milo.zero : !milo.enum<"Res">
  milo.return %z : !milo.enum<"Res">
}

// `?` on an Option of no ok payload, and an err variant with none: no result, no block
// arguments; the err region may end in unreachable after a scope that returns.
// CHECK-LABEL: func @try_bare
// CHECK-NEXT:   milo.match %arg0 : !milo.enum<"Opt"{{.*}}> [1, 0] {
// CHECK-NEXT:     milo.yield
// CHECK-NEXT:   }, {
// CHECK-NEXT:     milo.scope {
// CHECK-NEXT:       milo.return
// CHECK-NEXT:     }
// CHECK-NEXT:     milo.unreachable
// CHECK-NEXT:   }
// CHECK-NEXT:   milo.return
func.func @try_bare(%o: !milo.enum<"Opt", size = 0, align = 4, [0: (), 1: ()]>) {
  milo.try %o : !milo.enum<"Opt"> ok 1 err 0 {
    milo.scope {
      milo.return
    }
    milo.unreachable
  }
  milo.return
}

// `$"..."`: an entry-block slot set to the empty string, then per part: an int widened by
// its signedness and pushed (a null buffer back is the overflow panic at the site), a
// float, a bool and a raw pointer pushed as they are, a string appended, a place through
// its display glue; the result is the slot's string. The rt* callees missing from the
// module are declared at its top (checked there, above).
// CHECK-LABEL: func @interp
// CHECK-NEXT:   %[[S:.*]] = milo.var "format" : <!milo.string>
// CHECK-NEXT:   %[[E:.*]] = milo.zero : !milo.string
// CHECK-NEXT:   milo.store %[[E]], %[[S]] init : <!milo.string>
// CHECK-NEXT:   %[[W:.*]] = milo.cast %arg0 : si32 to si64
// CHECK-NEXT:   %[[P:.*]] = call @rtStringPushI64(%[[S]], %[[W]]) : (!milo.ref<!milo.string>, si64) -> !milo.ptr
// CHECK-NEXT:   %[[NULL:.*]] = milo.zero : !milo.ptr
// CHECK-NEXT:   %[[BAD:.*]] = milo.cmp eq, %[[P]], %[[NULL]] : !milo.ptr
// CHECK-NEXT:   milo.panic_if %[[BAD]], "runtime error: integer overflow at main.milo:12\0A"
// CHECK-NEXT:   %[[U:.*]] = milo.cast %arg1 : ui8 to ui64
// CHECK-NEXT:   call @rtStringPushU64(%[[S]], %[[U]])
// CHECK:        call @rtStringPushI64(%[[S]], %arg2) : (!milo.ref<!milo.string>, si64) -> !milo.ptr
// CHECK:        call @rtStringPushF64(%[[S]], %arg3)
// CHECK:        call @rtStringPushF32(%[[S]], %arg4)
// CHECK:        call @rtStringPushBool(%[[S]], %arg5)
// CHECK:        call @rtStringPushPtr(%[[S]], %arg6)
// CHECK:        milo.panic_if
// CHECK-NEXT:   milo.string.append %[[S]], %arg7 : <!milo.string>
// CHECK-NEXT:   call @P$display(%arg8, %[[S]]) : (!milo.ref<!milo.struct<"P", si32>>, !milo.ref<!milo.string>) -> ()
// CHECK-NEXT:   call @V$display(%arg9, %[[S]]) : (!milo.vec<si32>, !milo.ref<!milo.string>) -> ()
// CHECK-NEXT:   %[[R:.*]] = milo.load %[[S]] : <!milo.string>
// CHECK-NEXT:   milo.return %[[R]] : !milo.string
func.func @interp(%a: si32, %b: ui8, %c: si64, %d: f64, %e: f32, %f: i1, %g: !milo.ptr,
                  %s: !milo.string, %p: !milo.ref<!milo.struct<"P", si32>>, %v: !milo.vec<si32>) -> !milo.string {
  %r = milo.interp "main.milo:12" [%a : si32, %b : ui8, %c : si64, %d : f64, %e : f32, %f : i1, %g : !milo.ptr, %s : !milo.string, %p : !milo.ref<!milo.struct<"P", si32>> via @"P$display", %v : !milo.vec<si32> via @"V$display"]
  milo.return %r : !milo.string
}

// No parts: the empty string.
// CHECK-LABEL: func @interp_empty
// CHECK-NEXT:   %[[S:.*]] = milo.var "format" : <!milo.string>
// CHECK-NEXT:   milo.zero : !milo.string
// CHECK-NEXT:   milo.store
// CHECK-NEXT:   %[[R:.*]] = milo.load %[[S]] : <!milo.string>
// CHECK-NEXT:   milo.return %[[R]]
func.func @interp_empty() -> !milo.string {
  %r = milo.interp "main.milo:13" []
  milo.return %r : !milo.string
}
