// RUN: milo-opt %s --pass-pipeline="builtin.module(milo-desugar,milo-verify,func.func(milo-append-in-place,milo-scope-drops),milo-expand-index,func.func(milo-raise-to-scf,milo-lower-structured-cf,milo-elaborate-drops,canonicalize{disable-patterns=SelectToExtUI},milo-hoist-vec-reads,loop-invariant-code-motion,milo-version-bounds-checks,cse,canonicalize{disable-patterns=SelectToExtUI},convert-scf-to-cf),convert-milo-to-llvm,reconcile-unrealized-casts)" | FileCheck %s
// The top layer through the pipeline src/mlir-backend.ts runs (MLIR_PIPELINE, up to the
// scaffold merge): milo-desugar first, then every later pass sees core ops only, down to
// the LLVM dialect.

// CHECK-NOT: {{[ =] milo\.[a-z_.]+ }}
// CHECK: "runtime error: integer overflow at main.milo:5\0A\00"
// CHECK-LABEL: llvm.func @sum
// CHECK: llvm.call @rtStringPushI64
// CHECK-NOT: {{[ =] milo\.[a-z_.]+ }}
func.func private @use(si32)

func.func @sum(%v: !milo.vec<si32>, %a: !milo.ref<!milo.array<si32, 2>>,
               %r: !milo.enum<"Res", size = 8, align = 4, [0: (si32 at 4), 1: (si32 at 4)]>) -> si32 {
  milo.for_in %v : !milo.vec<si32> {
  ^bb0(%i: si64, %x: si32):
    func.call @use(%x) : (si32) -> ()
    milo.yield
  } loc("main.milo":2:3)
  milo.for_in %a : !milo.ref<!milo.array<si32, 2>> {
  ^bb0(%i: si64, %x: !milo.ref<si32>):
    %y = milo.load %x : !milo.ref<si32>
    func.call @use(%y) : (si32) -> ()
    milo.yield
  } loc("main.milo":3:3)
  %t = milo.try %r : !milo.enum<"Res"> -> si32 ok 0 err 1 {
  ^bb0(%e: si32):
    milo.return %e : si32
  } loc("main.milo":4:3)
  %s = milo.interp "main.milo:5" [%t : si32] loc("main.milo":5:3)
  milo.return %t : si32
}
