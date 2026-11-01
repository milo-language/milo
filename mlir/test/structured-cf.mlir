// RUN: milo-opt %s --milo-lower-structured-cf | FileCheck %s
// milo.if/while/loop become cf branches; every jump goes to the right block.

// An if-expression's yields feed the continuation block's argument.
// CHECK-LABEL: func @and
// CHECK:   cf.cond_br %arg0, ^[[RHS:bb[0-9]+]], ^[[FALSE:bb[0-9]+]]
// CHECK: ^[[RHS]]:
// CHECK:   cf.br ^[[JOIN:bb[0-9]+]](%arg1 : i1)
// CHECK: ^[[FALSE]]:
// CHECK:   %[[F:.*]] = milo.const false
// CHECK:   cf.br ^[[JOIN]](%[[F]] : i1)
// CHECK: ^[[JOIN]](%[[R:.*]]: i1):
// CHECK:   milo.return %[[R]] : i1
func.func @and(%a: i1, %b: i1) -> i1 {
  %0 = milo.if %a -> i1 {
    milo.yield %b : i1
  } else {
    %f = milo.const false
    milo.yield %f : i1
  }
  milo.return %0 : i1
}

// An if without else falls through to the continuation; a return inside stays a return.
// CHECK-LABEL: func @early_return
// CHECK:   cf.cond_br %arg0, ^[[THEN:bb[0-9]+]], ^[[CONT:bb[0-9]+]]
// CHECK: ^[[THEN]]:
// CHECK-NEXT:   milo.return %arg1 : si32
// CHECK: ^[[CONT]]:
// CHECK-NEXT:   milo.return %arg2 : si32
func.func @early_return(%c: i1, %a: si32, %b: si32) -> si32 {
  milo.if %c {
    milo.return %a : si32
  }
  milo.return %b : si32
}

// while: the entry jumps to the header, the condition picks body or exit, the body's
// yield and continue go back to the header, break goes to the exit.
// CHECK-LABEL: func @while_loop
// CHECK:   cf.br ^[[HEAD:bb[0-9]+]]
// CHECK: ^[[HEAD]]:
// CHECK:   cf.cond_br %arg0, ^[[BODY:bb[0-9]+]], ^[[EXIT:bb[0-9]+]]
// CHECK: ^[[BODY]]:
// CHECK:   cf.cond_br %arg1, ^[[BRK:bb[0-9]+]], ^[[NEXT:bb[0-9]+]]
// CHECK: ^[[BRK]]:
// CHECK-NEXT:   cf.br ^[[EXIT]]
// CHECK: ^[[NEXT]]:
// CHECK:   cf.cond_br %arg2, ^[[CONT:bb[0-9]+]], ^[[TAIL:bb[0-9]+]]
// CHECK: ^[[CONT]]:
// CHECK-NEXT:   cf.br ^[[HEAD]]
// CHECK: ^[[TAIL]]:
// CHECK-NEXT:   cf.br ^[[HEAD]]
// CHECK: ^[[EXIT]]:
// CHECK-NEXT:   milo.return
func.func @while_loop(%c: i1, %b: i1, %k: i1) {
  milo.while {
    milo.condition %c
  } do {
    milo.if %b {
      milo.break
    }
    milo.if %k {
      milo.continue
    }
    milo.yield
  }
  milo.return
}

// A break in an inner loop leaves only the inner loop.
// CHECK-LABEL: func @nested
// CHECK:   cf.br ^[[OUTER:bb[0-9]+]]
// CHECK: ^[[OUTER]]:
// CHECK-NEXT:   cf.br ^[[INNER:bb[0-9]+]]
// CHECK: ^[[INNER]]:
// CHECK-NEXT:   cf.cond_br %arg0, ^[[IBRK:bb[0-9]+]], ^[[IBACK:bb[0-9]+]]
// CHECK: ^[[IBRK]]:
// CHECK-NEXT:   cf.br ^[[IEXIT:bb[0-9]+]]
// CHECK: ^[[IBACK]]:
// CHECK-NEXT:   cf.br ^[[INNER]]
// CHECK: ^[[IEXIT]]:
// CHECK-NEXT:   cf.br ^[[OEXIT:bb[0-9]+]]
// CHECK: ^[[OEXIT]]:
// CHECK-NEXT:   milo.return
func.func @nested(%c: i1) {
  milo.loop {
    milo.loop {
      milo.if %c {
        milo.break
      }
      milo.yield
    }
    milo.break
  }
  milo.return
}
