; HashMap runtime helpers, as LLVM IR text sections (src/codegen-runtime.ts).

; @@ milo.map.alloc
; `_mapAlloc(n, size)`: n * size zeroed bytes from malloc; null when the product
; overflows or malloc fails, so the caller's own check reports it at its site.
define internal ptr @milo.map.alloc(i64 %n, i64 %size) {
entry:
  %m = call { i64, i1 } @llvm.umul.with.overflow.i64(i64 %n, i64 %size)
  %bytes = extractvalue { i64, i1 } %m, 0
  %ovf = extractvalue { i64, i1 } %m, 1
  br i1 %ovf, label %fail, label %go
go:
  %p = call ptr @malloc(i64 %bytes)
  %ok = icmp ne ptr %p, null
  br i1 %ok, label %zero, label %fail
zero:
  call ptr @memset(ptr %p, i32 0, i64 %bytes)
  ret ptr %p
fail:
  ret ptr null
}
