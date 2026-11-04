// RUN: milo-opt %s -split-input-file -verify-diagnostics
// One case per verifier error of the top-layer ops (milo.for_in, milo.try, milo.interp).

func.func @for_in_args(%v: !milo.vec<si32>) {
  // expected-error @+1 {{body takes two arguments, the si64 index and the element}}
  milo.for_in %v : !milo.vec<si32> {
  ^bb0(%x: si32):
    milo.yield
  }
  milo.return
}

// -----

func.func @for_in_vec_elem(%v: !milo.vec<si32>) {
  // expected-error @+1 {{element of a Vec is its type or its place, not}}
  milo.for_in %v : !milo.vec<si32> {
  ^bb0(%i: si64, %x: si64):
    milo.yield
  }
  milo.return
}

// -----

func.func @for_in_string_elem(%s: !milo.string) {
  // expected-error @+1 {{element of a string is a ui8 byte, not}}
  milo.for_in %s : !milo.string {
  ^bb0(%i: si64, %x: si8):
    milo.yield
  }
  milo.return
}

// -----

func.func @for_in_scalar_place(%r: !milo.ref<si32>) {
  // expected-error @+1 {{iterates a Vec, a string or the place of an array, not}}
  milo.for_in %r : !milo.ref<si32> {
  ^bb0(%i: si64, %x: !milo.ref<si32>):
    milo.yield
  }
  milo.return
}

// -----

func.func @for_in_array_by_value(%a: !milo.ref<!milo.array<si32, 4>>) {
  // expected-error @+1 {{element of an array is its place, not}}
  milo.for_in %a : !milo.ref<!milo.array<si32, 4>> {
  ^bb0(%i: si64, %x: si32):
    milo.yield
  }
  milo.return
}

// -----

func.func @try_same_tag(%r: !milo.enum<"R", size = 8, align = 4, [0: (si32 at 4), 1: (si32 at 4)]>) -> si32 {
  // expected-error @+1 {{needs two distinct variants of the subject for ok and err}}
  %x = milo.try %r : !milo.enum<"R"> -> si32 ok 0 err 0 {
  ^bb0(%e: si32):
    milo.return %e : si32
  }
  milo.return %x : si32
}

// -----

func.func @try_two_fields(%r: !milo.enum<"R2", size = 12, align = 4, [0: (si32 at 4, si32 at 8), 1: ()]>) {
  // expected-error @+1 {{variants carry at most one field}}
  milo.try %r : !milo.enum<"R2"> ok 0 err 1 {
    milo.return
  }
  milo.return
}

// -----

func.func @try_result(%r: !milo.enum<"R3", size = 8, align = 4, [0: (si32 at 4), 1: ()]>) {
  // expected-error @+1 {{result is not the ok variant's payload}}
  %x = milo.try %r : !milo.enum<"R3"> -> si64 ok 0 err 1 {
    milo.return
  }
  milo.return
}

// -----

func.func @try_region_args(%r: !milo.enum<"R4", size = 8, align = 4, [0: (si32 at 4), 1: ()]>) {
  // expected-error @+1 {{region arguments are not the err variant's payload}}
  %x = milo.try %r : !milo.enum<"R4"> -> si32 ok 0 err 1 {
  ^bb0(%e: si32):
    milo.return
  }
  milo.return
}

// -----

func.func @interp_glue_count(%a: si32) -> !milo.string {
  // expected-error @+1 {{needs one glue entry per part}}
  %s = "milo.interp"(%a) <{glue = [], site = "m.milo:1"}> : (si32) -> !milo.string
  milo.return %s : !milo.string
}

// -----

func.func private @"P$display"(!milo.ref<si32>, !milo.ref<!milo.string>)

func.func @interp_place_no_glue(%p: !milo.ref<si32>) -> !milo.string {
  // expected-error @+1 {{takes a display glue symbol for each place part, and only for those}}
  %s = milo.interp "m.milo:1" [%p : !milo.ref<si32>]
  milo.return %s : !milo.string
}

// -----

func.func @interp_scalar_glue(%a: si32) -> !milo.string {
  // expected-error @+1 {{takes a display glue symbol for each place part, and only for those}}
  %s = milo.interp "m.milo:1" [%a : si32 via @"P$display"]
  milo.return %s : !milo.string
}
