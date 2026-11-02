// RUN: milo-opt %s --int-range-optimizations | FileCheck %s
// The region ops describe their control flow to MLIR (RegionBranchOpInterface,
// LoopLikeOpInterface), so upstream IntegerRangeAnalysis proves ranges through them, and
// --int-range-optimizations replaces each comparison it decides with a milo.const.
// Each case fails if a region op names the wrong successors: a region left out is dead
// code to the analysis, a value from it never joins, and a comparison folds wrongly or
// not at all.

// Opaque uses: a value passed to a sink stays live.
func.func private @sink0(i1, i1, i1)
func.func private @sink1(i1)
func.func private @sink2(i1, i1)

// The iv of a signed milo.for is in [start, end - 1].
// (Decided values become one milo.const at the top of the function.)
// CHECK-LABEL: func.func @for_iv
// CHECK:         %[[T:.*]] = milo.const true
// CHECK:         milo.for
// CHECK:           %[[U:.*]] = milo.cmp lt, %{{.*}}, %{{.*}} : si64
// CHECK:           call @sink0(%[[T]], %[[T]], %[[U]]) : (i1, i1, i1) -> ()
func.func @for_iv() {
  %c0 = milo.const 0 : si64
  %c9 = milo.const 9 : si64
  %c10 = milo.const 10 : si64
  milo.for %c0 to %c10 : si64 {
  ^bb0(%i: si64):
    %lt = milo.cmp lt, %i, %c10 : si64
    %ge = milo.cmp ge, %i, %c0 : si64
    %lt9 = milo.cmp lt, %i, %c9 : si64
    func.call @sink0(%lt, %ge, %lt9) : (i1, i1, i1) -> ()
    milo.yield
  }
  milo.return
}

// An unsigned loop compares unsigned, which the analysis's signed loop bounds cannot
// describe: its iv stays unknown.
// CHECK-LABEL: func.func @for_unsigned
// CHECK:         milo.cmp lt
func.func @for_unsigned(%n: ui32) {
  %c0 = milo.const 0 : ui32
  %big = milo.const 2147483648 : ui32
  milo.for %c0 to %n : ui32 {
  ^bb0(%i: ui32):
    %lt = milo.cmp lt, %i, %big : ui32
    func.call @sink1(%lt) : (i1) -> ()
    milo.yield
  }
  milo.return
}

// A milo.if result is the join of what both regions yield: 1 or 5.
// CHECK-LABEL: func.func @if_join
// CHECK:         %[[T:.*]] = milo.const true
// CHECK:         %[[U:.*]] = milo.cmp lt, %{{.*}}, %{{.*}} : si64
// CHECK:         call @sink2(%[[T]], %[[U]]) : (i1, i1) -> ()
func.func @if_join(%c: i1) {
  %c1 = milo.const 1 : si64
  %c3 = milo.const 3 : si64
  %c5 = milo.const 5 : si64
  %r = milo.if %c -> si64 {
    milo.yield %c1 : si64
  } else {
    milo.yield %c5 : si64
  }
  %le = milo.cmp le, %r, %c5 : si64
  %lt = milo.cmp lt, %r, %c3 : si64
  func.call @sink2(%le, %lt) : (i1, i1) -> ()
  milo.return
}

// The same through milo.match arms (2 or 8) and a milo.scope (8, so the scope folds away).
// CHECK-LABEL: func.func @match_scope_join
// CHECK:         %[[T:.*]] = milo.const true
// CHECK-NOT:     milo.scope
// CHECK:         %[[U:.*]] = milo.cmp eq, %{{.*}}, %{{.*}} : si64
// CHECK:         call @sink2(%[[T]], %[[U]]) : (i1, i1) -> ()
func.func @match_scope_join(%k: si32) {
  %c2 = milo.const 2 : si64
  %c4 = milo.const 4 : si64
  %c8 = milo.const 8 : si64
  %m = milo.match %k : si32 -> si64 [1] default {
    milo.yield %c2 : si64
  }, {
    %s = milo.scope -> si64 {
      milo.yield %c8 : si64
    }
    milo.yield %s : si64
  }
  %ge = milo.cmp ge, %m, %c2 : si64
  %eq = milo.cmp eq, %m, %c4 : si64
  func.call @sink2(%ge, %eq) : (i1, i1) -> ()
  milo.return
}

// A milo.while body runs (cond -> body), and the code after it is reached (cond -> exit).
// CHECK-LABEL: func.func @while_live
// CHECK:         %[[T:.*]] = milo.const true
// CHECK:         milo.while
// CHECK:           milo.condition
// CHECK:         } do {
// CHECK-NEXT:      call @sink1(%[[T]]) : (i1) -> ()
// CHECK:         }
// CHECK-NEXT:    call @sink1(%[[T]]) : (i1) -> ()
func.func @while_live(%c: i1) {
  %c1 = milo.const 1 : si64
  %c2 = milo.const 2 : si64
  milo.while {
    milo.condition %c
  } do {
    %b = milo.cmp lt, %c1, %c2 : si64
    func.call @sink1(%b) : (i1) -> ()
    milo.yield
  }
  %a = milo.cmp lt, %c1, %c2 : si64
  func.call @sink1(%a) : (i1) -> ()
  milo.return
}

// Only a break leaves a milo.loop, and no region edge says so; the code after it stays
// live because the analysis tracks liveness per block.
// CHECK-LABEL: func.func @loop_exit_live
// CHECK:         %[[T:.*]] = milo.const true
// CHECK:         milo.loop
// CHECK:           milo.break
// CHECK:         }
// CHECK-NEXT:    call @sink1(%[[T]]) : (i1) -> ()
func.func @loop_exit_live() {
  %c1 = milo.const 1 : si64
  %c2 = milo.const 2 : si64
  milo.loop {
    milo.break
  }
  %a = milo.cmp lt, %c1, %c2 : si64
  func.call @sink1(%a) : (i1) -> ()
  milo.return
}
