; Atomic intrinsics (std's _atomic*), seq_cst as legacy codegen emits them; one instance
; per width and op: {{name}}, {{ty}} (i64, i32, or i8 for a bool's byte), {{align}}.

; @@ milo.atomic.load
define internal {{ty}} @{{name}}(ptr %p) {
entry:
  %v = load atomic {{ty}}, ptr %p seq_cst, align {{align}}
  ret {{ty}} %v
}

; @@ milo.atomic.store
define internal void @{{name}}(ptr %p, {{ty}} %v) {
entry:
  store atomic {{ty}} %v, ptr %p seq_cst, align {{align}}
  ret void
}

; @@ milo.atomic.rmw
; The old value; {{op}} is add, sub or xchg.
define internal {{ty}} @{{name}}(ptr %p, {{ty}} %v) {
entry:
  %old = atomicrmw {{op}} ptr %p, {{ty}} %v seq_cst, align {{align}}
  ret {{ty}} %old
}

; @@ milo.atomic.cas
; The value found: the swap happened when it equals %expected.
define internal {{ty}} @{{name}}(ptr %p, {{ty}} %expected, {{ty}} %desired) {
entry:
  %pair = cmpxchg ptr %p, {{ty}} %expected, {{ty}} %desired seq_cst seq_cst, align {{align}}
  %old = extractvalue { {{ty}}, i1 } %pair, 0
  ret {{ty}} %old
}
