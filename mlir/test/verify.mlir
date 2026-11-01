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

// -----

func.func @for_iv(%a: si64) {
  // expected-error @+1 {{body takes one argument, the induction variable}}
  milo.for %a to %a : si64 {
  ^bb0(%i: si32):
    milo.yield
  }
  milo.return
}

// -----

func.func @print_signless(%a: i32) {
  // expected-error @+1 {{cannot display a part of type 'i32'}}
  milo.print %a : i32
  milo.return
}

// -----

func.func @print_partial_scalar(%a: si64) {
  // expected-error @+1 {{partial must end at a string part}}
  milo.print partial %a : si64
  milo.return
}

// -----

func.func @struct_fields(%a: si64) {
  // expected-error @+1 {{operands are not the fields of}}
  %0 = milo.struct.new %a : si64 -> !milo.struct<"P", si64, f64>
  milo.return
}

// -----

func.func @struct_get(%p: !milo.struct<"P", si64, f64>) {
  // expected-error @+1 {{has no field 1 of type 'si64'}}
  %0 = milo.struct.get %p[1] : !milo.struct<"P", si64, f64> -> si64
  milo.return
}

// -----

func.func @enum_tag(%x: f64) {
  // expected-error @+1 {{has no variant with tag 5}}
  %0 = milo.enum.new 5 (%x : f64) -> !milo.enum<"S", size = 16, align = 8, [0: (f64 at 8), 1: ()]>
  milo.return
}

// -----

// expected-error @+1 {{payload offset 2 is outside bytes 4..16}}
func.func @enum_offset(%e: !milo.enum<"S", size = 16, align = 8, [0: (f64 at 2), 1: ()]>) {
  milo.return
}

// -----

func.func @match_arity(%e: !milo.enum<"S", size = 16, align = 8, [0: (f64 at 8), 1: ()]>) {
  // expected-error @+1 {{payload is not the fields of variant 0}}
  milo.match %e : !milo.enum<"S", size = 16, align = 8, [0: (f64 at 8), 1: ()]> [0, 1] {
    milo.yield
  }, {
    milo.yield
  }
  milo.return
}

// -----

func.func @match_cases(%n: si32) {
  // expected-error @+1 {{needs one region per case}}
  milo.match %n : si32 [0, 1] {
    milo.yield
  }
  milo.return
}

// -----

func.func @global_of_ref() {
  // expected-error @+1 {{a global holds a value}}
  %g = milo.global "g" : !milo.ref<!milo.ref<si64>>
  milo.return
}

// -----

func.func @body(%env: !milo.ptr, %x: si32) -> si32 {
  milo.return %x : si32
}

func.func @closure_sig() {
  // expected-error @+1 {{not (!milo.ptr env) + }}
  %f = milo.closure @body : !milo.fn<(si64) -> si64>
  milo.return
}

// -----

func.func @capture_outside(%e: !milo.ptr, %env: !milo.ptr) {
  // expected-error @+1 {{reads an env that is not its closure body's first argument}}
  %c = milo.env.capture %env[0] : !milo.ref<si64>
  milo.return
}

// -----

func.func @call_args(%f: !milo.fn<(si64) -> si64>, %x: si32) {
  // expected-error @+1 {{arguments do not match}}
  %r = milo.closure.call %f(%x) : !milo.fn<(si64) -> si64>, si32 -> si64
  milo.return
}
