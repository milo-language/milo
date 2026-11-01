// RUN: milo-opt %s -split-input-file -verify-diagnostics --milo-verify
// milo-verify: a !milo.ref never outlives its call, like a Milo `&T`. Passing one on is
// fine; returning one from a function or a call is not.

func.func private @takes(!milo.ref<si64>)
func.func @ok(%r: !milo.ref<si64>) {
  func.call @takes(%r) : (!milo.ref<si64>) -> ()
  milo.return
}

// -----

// expected-error @+1 {{returns a !milo.ref}}
func.func private @leaks() -> !milo.ref<si64>

// -----

// expected-error @+1 {{returns a !milo.ref}}
func.func private @g() -> !milo.ref<si64>
func.func @calls_leak() {
  // expected-error @+1 {{returns a !milo.ref}}
  %r = func.call @g() : () -> !milo.ref<si64>
  milo.return
}
