; HashMap runtime helpers, as LLVM IR text sections (src/runtime-ir.ts).

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

; @@ milo.hash.byte
; One FNV-1a round: the hash of a bool key is its one byte.
define internal i64 @milo.hash.byte(i64 %h, i64 %b) {
entry:
  %x = xor i64 %h, %b
  %m = mul i64 %x, 1099511628211
  ret i64 %m
}

; @@ milo.hash.u64
; FNV-1a over an int key's 8 bytes, least significant first (narrow ints are widened by
; their signedness first).
define internal i64 @milo.hash.u64(i64 %h, i64 %v) {
entry:
  br label %loop
loop:
  %i = phi i64 [ 0, %entry ], [ %inext, %loop ]
  %acc = phi i64 [ %h, %entry ], [ %next, %loop ]
  %sh = shl i64 %i, 3
  %s = lshr i64 %v, %sh
  %byte = and i64 %s, 255
  %x = xor i64 %acc, %byte
  %next = mul i64 %x, 1099511628211
  %inext = add i64 %i, 1
  %more = icmp ult i64 %inext, 8
  br i1 %more, label %loop, label %done
done:
  ret i64 %next
}

; @@ milo.hash.bytes
; FNV-1a over a string key's bytes.
define internal i64 @milo.hash.bytes(i64 %h, ptr %d, i64 %n) {
entry:
  %empty = icmp eq i64 %n, 0
  br i1 %empty, label %done, label %loop
loop:
  %i = phi i64 [ 0, %entry ], [ %inext, %loop ]
  %acc = phi i64 [ %h, %entry ], [ %next, %loop ]
  %p = getelementptr i8, ptr %d, i64 %i
  %c = load i8, ptr %p
  %byte = zext i8 %c to i64
  %x = xor i64 %acc, %byte
  %next = mul i64 %x, 1099511628211
  %inext = add i64 %i, 1
  %more = icmp ult i64 %inext, %n
  br i1 %more, label %loop, label %done
done:
  %r = phi i64 [ %h, %entry ], [ %next, %loop ]
  ret i64 %r
}

; @@ milo.buf.clone
; A clone's buffer: `n * size` bytes from malloc, the `n * size` bytes at `src` copied in
; (the clone's glue then re-clones whatever in them owns something). Null for n = 0. Out
; of memory, or a size that overflows, ends the program as a failed allocation does.
define internal ptr @milo.buf.clone(ptr %src, i64 %n, i64 %size) {
entry:
  %empty = icmp eq i64 %n, 0
  br i1 %empty, label %none, label %go
none:
  ret ptr null
go:
  %m = call { i64, i1 } @llvm.umul.with.overflow.i64(i64 %n, i64 %size)
  %bytes = extractvalue { i64, i1 } %m, 0
  %ovf = extractvalue { i64, i1 } %m, 1
  br i1 %ovf, label %fail, label %alloc
alloc:
  %p = call ptr @malloc(i64 %bytes)
  %ok = icmp ne ptr %p, null
  br i1 %ok, label %copy, label %fail
copy:
  call ptr @memcpy(ptr %p, ptr %src, i64 %bytes)
  ret ptr %p
fail:
  call void @milo.str.oom()
  unreachable
}

; @@ milo.buf.alloc
; `n * size` uninitialized bytes from malloc (a Vec literal's buffer, exactly its
; elements); null when the product overflows or malloc fails, so the caller reports it.
define internal ptr @milo.buf.alloc(i64 %n, i64 %size) {
entry:
  %m = call { i64, i1 } @llvm.umul.with.overflow.i64(i64 %n, i64 %size)
  %bytes = extractvalue { i64, i1 } %m, 0
  %ovf = extractvalue { i64, i1 } %m, 1
  br i1 %ovf, label %fail, label %go
go:
  %p = call ptr @malloc(i64 %bytes)
  ret ptr %p
fail:
  ret ptr null
}

; @@ milo.vec.grow.realloc
; std's `_vecGrowBuf(data, len, cap)`: the buffer of `keep` used bytes moved to one of
; `count * size` bytes. At least {{reallocMin}} kept bytes go through realloc, a smaller
; buffer to a fresh block (copy, then free). Null when the size overflows or allocation
; fails, the old buffer then untouched; the caller reports it at its site.
define internal ptr @milo.vec.grow.realloc(ptr %old, i64 %keep, i64 %count, i64 %size) {
entry:
  %m = call { i64, i1 } @llvm.umul.with.overflow.i64(i64 %count, i64 %size)
  %bytes = extractvalue { i64, i1 } %m, 0
  %ovf = extractvalue { i64, i1 } %m, 1
  br i1 %ovf, label %fail, label %pick
pick:
  %re = icmp uge i64 %keep, {{reallocMin}}
  br i1 %re, label %grow, label %fresh
grow:
  %r = call ptr @realloc(ptr %old, i64 %bytes)
  ret ptr %r
fresh:
  %f = call ptr @malloc(i64 %bytes)
  %src = icmp ne ptr %old, null
  %dst = icmp ne ptr %f, null
  %both = and i1 %src, %dst
  br i1 %both, label %copy, label %done
copy:
  call ptr @memcpy(ptr %f, ptr %old, i64 %keep)
  call void @free(ptr %old)
  br label %done
done:
  ret ptr %f
fail:
  ret ptr null
}

; @@ milo.vec.grow.copy
; milo.vec.grow.realloc where realloc is not an option (Cortex-M's bump heap, or a
; zero-size element, since realloc(p, 0) may free p): always a fresh block.
define internal ptr @milo.vec.grow.copy(ptr %old, i64 %keep, i64 %count, i64 %size) {
entry:
  %m = call { i64, i1 } @llvm.umul.with.overflow.i64(i64 %count, i64 %size)
  %bytes = extractvalue { i64, i1 } %m, 0
  %ovf = extractvalue { i64, i1 } %m, 1
  br i1 %ovf, label %fail, label %alloc
alloc:
  %f = call ptr @malloc(i64 %bytes)
  %dst = icmp ne ptr %f, null
  br i1 %dst, label %check, label %fail
check:
  %src = icmp ne ptr %old, null
  br i1 %src, label %copy, label %done
copy:
  call ptr @memcpy(ptr %f, ptr %old, i64 %keep)
  call void @free(ptr %old)
  br label %done
done:
  ret ptr %f
fail:
  ret ptr null
}
