// RUN: milo-opt %s -split-input-file -verify-diagnostics
// One case per op-verifier error not already in verify.mlir, so every error Milo.cpp can
// emit is pinned by a test (scripts/dialect-hygiene.ts counts them).

func.func @var_owned_scalar() {
  // expected-error @+1 {{owns a value with no drop glue}}
  %0 = milo.var "x" owned : !milo.ref<si64>
  milo.return
}

// -----

func.func @scope_unowned() {
  %v = milo.var "s" : !milo.ref<!milo.string>
  // expected-error @+1 {{lists a slot that is not an owned milo.var}}
  milo.scope %v : !milo.ref<!milo.string> {
    milo.yield
  }
  milo.return
}

// -----

func.func @drop_scalar() {
  %v = milo.var "x" : !milo.ref<si64>
  // expected-error @+1 {{of a value with no drop glue}}
  milo.drop %v : !milo.ref<si64>
  milo.return
}

// -----

func.func @drop_flag_param(%r: !milo.ref<!milo.string>, %f: i1) {
  // expected-error @+1 {{with a drop flag needs an owned slot}}
  milo.drop %r if %f : !milo.ref<!milo.string>
  milo.return
}

// -----

func.func @global_unnamed() {
  // expected-error @+1 {{needs a name}}
  %g = milo.global "" : !milo.ref<si64>
  milo.return
}

// -----

func.func @global_init_unnamed() {
  // expected-error @+1 {{needs a name}}
  milo.global.init ""
  milo.return
}

// -----

func.func @closure_no_body() {
  // expected-error @+1 {{names no function: nope}}
  %f = milo.closure @nope : !milo.fn<(si64) -> si64>
  milo.return
}

// -----

func.func @fn_cast_same(%f: !milo.fn<(si64) -> si64>) {
  // expected-error @+1 {{changes nothing: '!milo.fn<(si64) -> si64>'}}
  %g = milo.fn.cast %f : !milo.fn<(si64) -> si64> -> !milo.fn<(si64) -> si64>
  milo.return
}

// -----

func.func @call_result(%f: !milo.fn<(si64) -> si64>, %x: si64) {
  // expected-error @+1 {{result does not match}}
  %r = milo.closure.call %f(%x) : !milo.fn<(si64) -> si64>, si64 -> si32
  milo.return
}

// -----

func.func @append_not_string(%r: !milo.ref<si64>, %s: !milo.string) {
  // expected-error @+1 {{needs the place of a string}}
  milo.string.append %r, %s : !milo.ref<si64>
  milo.return
}

// -----

func.func @share_not_string(%r: !milo.ref<si64>) {
  // expected-error @+1 {{needs the place of a string}}
  %s = milo.string.share %r : !milo.ref<si64>
  milo.return
}

// -----

func.func @vec_place_elem(%r: !milo.ref<!milo.vecval<si64>>) {
  // expected-error @+1 {{needs the slot of a Vec of 'si32'}}
  %v = milo.vec.place %r : !milo.ref<!milo.vecval<si64>> -> !milo.vec<si32>
  milo.return
}

// -----

func.func @vectail_init_elem(%v: !milo.vecval<si32>) {
  %s = milo.var "for.vec" owned : !milo.ref<!milo.vectail<si64>>
  // expected-error @+1 {{moves a Vec of 'si32' into '!milo.vectail<si64>'}}
  milo.vectail.init %v, %s : !milo.vecval<si32>, !milo.ref<!milo.vectail<si64>>
  milo.return
}

// -----

func.func @vectail_vec_elem() {
  %s = milo.var "for.vec" owned : !milo.ref<!milo.vectail<si64>>
  // expected-error @+1 {{is the header of a Vec of 'si64', not '!milo.vec<si32>'}}
  %v = milo.vectail.vec %s : !milo.ref<!milo.vectail<si64>> -> !milo.vec<si32>
  milo.return
}

// -----

func.func @vectail_take_place_elem(%i: si64) {
  %s = milo.var "for.vec" owned : !milo.ref<!milo.vectail<si64>>
  // expected-error @+1 {{is the place of an element of '!milo.vectail<si64>', not '!milo.ref<si32>'}}
  %r = milo.vectail.take_place %s[%i] : !milo.ref<!milo.vectail<si64>> -> !milo.ref<si32>
  milo.return
}

// -----

func.func @heap_place_type(%h: !milo.heap<si64>) {
  // expected-error @+1 {{is the place of a 'si64', not '!milo.ref<f64>'}}
  %r = milo.heap.place %h : !milo.heap<si64> -> !milo.ref<f64>
  milo.return
}

// -----

func.func @index_type(%v: !milo.vec<si64>, %i: si64) {
  // expected-error @+1 {{result is not the Vec's element type}}
  %x = milo.index %v[%i] : !milo.vec<si64> -> si32
  milo.return
}

// -----

func.func @index_store_type(%v: !milo.vec<si64>, %i: si64, %x: si32) {
  // expected-error @+1 {{value is not the Vec's element type}}
  milo.index.store %x, %v[%i] : si32, !milo.vec<si64>
  milo.return
}

// -----

func.func @vec_load_type(%v: !milo.vec<f64>, %i: i64) {
  // expected-error @+1 {{result is not the Vec's element type}}
  %x = milo.vec.load %v[%i] : !milo.vec<f64> -> f32
  milo.return
}

// -----

func.func @vec_store_type(%v: !milo.vec<f64>, %i: i64, %x: f32) {
  // expected-error @+1 {{value is not the Vec's element type}}
  milo.vec.store %x, %v[%i] : f32, !milo.vec<f64>
  milo.return
}

// -----

func.func @cast_ptr_float(%p: !milo.ptr) {
  // expected-error @+1 {{converts a pointer only to or from an integer, not 'f64'}}
  %x = milo.cast %p : !milo.ptr to f64
  milo.return
}

// -----

func.func @cast_float_ptr(%x: f32) {
  // expected-error @+1 {{converts a pointer only to or from an integer, not 'f32'}}
  %p = milo.cast %x : f32 to !milo.ptr
  milo.return
}

// -----

func.func @field_ref_not_struct(%r: !milo.ref<si64>) {
  // expected-error @+1 {{needs the place of a struct}}
  %f = milo.field_ref %r[0] : !milo.ref<si64> -> !milo.ref<si64>
  milo.return
}

// -----

func.func @payload_field(%e: !milo.enum<"E", size = 16, align = 8, [0: (f64 at 8), 1: ()]>) {
  // expected-error @+1 {{has no payload field 1 of type 'f64'}}
  %x = milo.enum.payload %e[0, 1] : !milo.enum<"E", size = 16, align = 8, [0: (f64 at 8), 1: ()]> -> f64
  milo.return
}

// -----

func.func @field_ref_not_enum(%r: !milo.ref<si64>) {
  // expected-error @+1 {{needs the place of an enum}}
  %f = milo.enum.field_ref %r[0, 0] : !milo.ref<si64> -> !milo.ref<f64>
  milo.return
}

// -----

func.func @set_tag_not_enum(%r: !milo.ref<si64>) {
  // expected-error @+1 {{needs the place of an enum}}
  milo.enum.set_tag %r, 0 : !milo.ref<si64>
  milo.return
}

// -----

func.func @tag_at_not_enum(%r: !milo.ref<si64>) {
  // expected-error @+1 {{needs the place of an enum}}
  %t = milo.enum.tag_at %r : !milo.ref<si64>
  milo.return
}

// -----

func.func @match_dup(%k: si32) {
  // expected-error @+1 {{has two arms for case 1}}
  milo.match %k : si32 [1, 1] {
    milo.yield
  }, {
    milo.yield
  }
  milo.return
}

// -----

func.func @match_default_args(%k: si32) {
  // expected-error @+1 {{default arm takes no arguments}}
  milo.match %k : si32 [1] default {
    milo.yield
  }, {
  ^bb0(%x: si32):
    milo.yield
  }
  milo.return
}

// -----

func.func @match_literal_args(%k: si32) {
  // expected-error @+1 {{arm on a literal takes no arguments}}
  milo.match %k : si32 [1] {
  ^bb0(%x: si32):
    milo.yield
  }
  milo.return
}

// -----

func.func @loop_yield_value(%x: si64) {
  milo.loop {
    // expected-error @+1 {{in a loop body yields no values}}
    milo.yield %x : si64
  }
  milo.return
}

// -----

func.func @yield_in_cond() {
  milo.while {
    // expected-error @+1 {{cannot end the cond region of milo.while}}
    milo.yield
  } do {
    milo.yield
  }
  milo.return
}

// -----

func.func @condition_in_body(%c: i1) {
  milo.while {
    milo.condition %c
  } do {
    // expected-error @+1 {{must end the cond region of milo.while}}
    milo.condition %c
  }
  milo.return
}

// -----

// expected-error @+1 {{outside a function}}
milo.return

// -----

func.func @lend_read(%p: !milo.ptr) -> si64 {
  // expected-error @+1 {{is only a call's argument}}
  %r = milo.ptr.lend %p -> !milo.ref<si64>
  %v = milo.load %r : !milo.ref<si64>
  milo.return %v : si64
}

// -----

func.func @closure_body(%env: !milo.ptr, %x: si64) -> si64 {
  milo.return %x : si64
}
func.func @closure_two_envs(%n: si64) {
  %slot = milo.var "n" : !milo.ref<si64>
  // expected-error @+1 {{has one env: heap or static, not both}}
  %f = milo.closure @closure_body(%slot : !milo.ref<si64>) heap static : !milo.fn<(si64) -> si64>
  milo.return
}

// -----

func.func @arraytail_not_owned(%i: si64) -> si64 {
  %slot = milo.var "t" : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>>
  // expected-error @+1 {{needs an owned slot of a !milo.arraytail}}
  %x = milo.arraytail.take %slot[%i] : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>> -> si64
  milo.return %x : si64
}

// -----

func.func @arraytail_wrong_elem(%i: si64) -> si32 {
  %slot = milo.var "t" owned : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>>
  // expected-error @+1 {{takes an element of}}
  %x = milo.arraytail.take %slot[%i] : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>> -> si32
  milo.return %x : si32
}

// -----

func.func @arraytail_wrong_place() {
  %slot = milo.var "t" owned : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>>
  // expected-error @+1 {{gives the place of}}
  %a = milo.arraytail.array %slot : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>> -> !milo.ref<!milo.array<si64, 4>>
  milo.return
}

// -----

func.func @arraytail_take_place_wrong(%i: si64) {
  %slot = milo.var "t" owned : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>>
  // expected-error @+1 {{gives the place of an element of}}
  %p = milo.arraytail.take_place %slot[%i] : !milo.ref<!milo.arraytail<!milo.array<si64, 3>>> -> !milo.ref<si32>
  milo.return
}

// -----

func.func @contract_kind(%c: i1) {
  // expected-error @+1 {{checks a requires, ensures or invariant clause, not assert}}
  milo.contract_check %c "assert"
  milo.return
}

// -----

func.func @panic_if_stray_conversion(%b: i1) {
  // expected-error @+1 {{message has a conversion other than %lld or %%}}
  milo.panic_if %b, "at %s\n"
  milo.return
}

// -----

func.func @panic_if_value_without_conversion(%b: i1, %v: si64) {
  // expected-error @+1 {{message needs one %lld exactly when a value is given}}
  milo.panic_if %b, "100%% bad\n"(%v)
  milo.return
}

// -----

func.func @panic_if_conversion_without_value(%b: i1) {
  // expected-error @+1 {{message needs one %lld exactly when a value is given}}
  milo.panic_if %b, "n = %lld\n"
  milo.return
}

// -----

func.func @overflows_kind(%a: si32, %b: si32) {
  // expected-error @+1 {{checks add, sub, mul, div or rem, not shl}}
  %0 = milo.overflows "shl", %a, %b : si32
  milo.return
}

// -----

func.func @saturating_kind(%a: ui8, %b: ui8) {
  // expected-error @+1 {{saturates add, sub or mul, not div}}
  %0 = milo.saturating "div", %a, %b : ui8
  milo.return
}
