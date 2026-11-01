// RUN: milo-opt %s -split-input-file -verify-diagnostics
// The source-level ops' verifiers: each case is a shape the emitter must never print.

func.func @signless(%a: i32) -> i32 {
  // expected-error @+1 {{operand #0 must be}}
  %0 = milo.add %a, %a : i32
  milo.return %0 : i32
}

// -----

func.func @float_wrapping(%a: f64) -> f64 {
  // expected-error @+1 {{'wrapping' applies to integer ops only}}
  %0 = milo.add %a, %a wrapping : f64
  milo.return %0 : f64
}

// -----

func.func @var_in_loop() {
  milo.loop {
    // expected-error @+1 {{must be in the function's entry block}}
    %0 = milo.var "x" : !milo.ref<si32>
    milo.break
  }
  milo.return
}

// -----

func.func @break_outside_loop(%c: i1) {
  milo.if %c {
    // expected-error @+1 {{outside a loop body}}
    milo.break
  }
  milo.return
}

// -----

func.func @break_in_cond(%c: i1) {
  milo.while {
    milo.if %c {
      // expected-error @+1 {{outside a loop body}}
      milo.break
    }
    milo.condition %c
  } do {
    milo.yield
  }
  milo.return
}

// -----

func.func @return_type(%a: si32) -> si64 {
  // expected-error @+1 {{does not match the function's result type}}
  milo.return %a : si32
}

// -----

func.func @missing_return_value() -> si64 {
  // expected-error @+1 {{does not match the function's result type}}
  milo.return
}

// -----

func.func @yield_type(%c: i1, %a: si32) -> si64 {
  %0 = milo.if %c -> si64 {
    // expected-error @+1 {{yields types that do not match the enclosing milo.if}}
    milo.yield %a : si32
  } else {
    milo.unreachable
  }
  milo.return %0 : si64
}

// -----

func.func @if_result_needs_else(%c: i1, %a: si32) -> si32 {
  // expected-error @+1 {{with results needs an else region}}
  %0 = milo.if %c -> si32 {
    milo.yield %a : si32
  }
  milo.return %0 : si32
}

// -----

func.func @store_type(%a: si64) {
  %r = milo.var "x" : !milo.ref<si32>
  // expected-error @+1 {{value is the slot's type}}
  "milo.store"(%a, %r) : (si64, !milo.ref<si32>) -> ()
  milo.return
}

// -----

func.func @const_kind() -> f64 {
  // expected-error @+1 {{all of {value, result} have same type}}
  %0 = "milo.const"() {value = 1 : si64} : () -> f64
  milo.return %0 : f64
}
