// RUN: milo-opt %s --milo-verify --convert-milo-to-llvm | FileCheck %s
// A contract clause checked at run time: unless it holds, the kind, file and line go to
// the out-of-line __milo_contract_fail, which reports and aborts.

// CHECK-LABEL: llvm.func @check
// CHECK:   %[[BAD:.*]] = llvm.icmp "eq" %arg0, %{{.*}} : i1
// CHECK:   llvm.cond_br %[[BAD]]
// CHECK:   llvm.call @__milo_contract_fail(%{{.*}}, %{{.*}}, %{{.*}}) : (!llvm.ptr, !llvm.ptr, i32) -> ()
func.func @check(%c: i1) {
  milo.contract_check %c "requires" loc("contracts.milo":3:1)
  milo.return
}
