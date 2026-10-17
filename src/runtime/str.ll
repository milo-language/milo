; Fixed IR runtime helpers, loaded by section from src/codegen-runtime.ts.
; Whole-line `;` comments are dropped on load; `{{name}}` is filled in by the caller.

; @@ milo.strfind
define internal i64 @milo.strfind(ptr %h, i64 %hlen, ptr %n, i64 %nlen, i64 %from) {
entry:
; negative when the needle is longer than the haystack, which makes the first
; comparison below fail and the search miss without a special case
  %limit = sub i64 %hlen, %nlen
  br label %loop
loop:
  %i = phi i64 [ %from, %entry ], [ %inext, %next ]
  %past = icmp sgt i64 %i, %limit
  br i1 %past, label %miss, label %cmp
cmp:
  %p = getelementptr i8, ptr %h, i64 %i
  %c = call i32 @memcmp(ptr %p, ptr %n, i64 %nlen)
  %eq = icmp eq i32 %c, 0
  br i1 %eq, label %hit, label %next
next:
  %inext = add i64 %i, 1
  br label %loop
hit:
  ret i64 %i
miss:
  ret i64 -1
}

; @@ milo.fmt.u64
define internal i64 @milo.fmt.u64(ptr %dst, i64 %v) {
entry:
  %tmp = alloca [20 x i8], align 2
  br label %loop
loop:
  %val = phi i64 [ %v, %entry ], [ %q, %body ]
  %pos = phi i64 [ 20, %entry ], [ %pos2, %body ]
  %big = icmp uge i64 %val, 100
  br i1 %big, label %body, label %tail
body:
  %q = udiv i64 %val, 100
  %qm = mul i64 %q, 100
  %r = sub i64 %val, %qm
  %ri = shl i64 %r, 1
  %src = getelementptr i8, ptr {{table}}, i64 %ri
  %pair = load i16, ptr %src, align 1
  %pos2 = sub i64 %pos, 2
  %d = getelementptr i8, ptr %tmp, i64 %pos2
  store i16 %pair, ptr %d, align 1
  br label %loop
tail:
  %lt10 = icmp ult i64 %val, 10
  br i1 %lt10, label %one, label %two
one:
  %c = trunc i64 %val to i8
  %ch = add i8 %c, 48
  %posA = sub i64 %pos, 1
  %dA = getelementptr i8, ptr %tmp, i64 %posA
  store i8 %ch, ptr %dA
  br label %copy
two:
  %ti = shl i64 %val, 1
  %tsrc = getelementptr i8, ptr {{table}}, i64 %ti
  %tpair = load i16, ptr %tsrc, align 1
  %posB = sub i64 %pos, 2
  %dB = getelementptr i8, ptr %tmp, i64 %posB
  store i16 %tpair, ptr %dB, align 1
  br label %copy
copy:
  %start = phi i64 [ %posA, %one ], [ %posB, %two ]
  %n = sub i64 20, %start
  %from = getelementptr i8, ptr %tmp, i64 %start
  call ptr @memcpy(ptr %dst, ptr %from, i64 %n)
  ret i64 %n
}

; @@ milo.fmt.i64
define internal i64 @milo.fmt.i64(ptr %dst, i64 %v) {
entry:
  %neg = icmp slt i64 %v, 0
  br i1 %neg, label %minus, label %plus
plus:
  %p = call i64 @milo.fmt.u64(ptr %dst, i64 %v)
  ret i64 %p
minus:
  store i8 45, ptr %dst
  %rest = getelementptr i8, ptr %dst, i64 1
  ; 0 - MIN wraps back to MIN, whose unsigned reading is exactly |MIN| = 2^63.
  %mag = sub i64 0, %v
  %m = call i64 @milo.fmt.u64(ptr %rest, i64 %mag)
  %m1 = add i64 %m, 1
  ret i64 %m1
}

; @@ milo.str.oom
; Nothing to report a source line against from inside the runtime; the failed size
; is what matters and the message says it was an allocation.
define internal void @milo.str.oom() noreturn cold noinline {
entry:
  call void @__milo_overflow_fail(ptr {{where}}, i32 0)
  unreachable
}

; @@ milo.str.alloc
; n bytes of text after a fresh count of 1; null when malloc fails (or n is so large
; that n + 8 wraps), so the caller's own null check reports it.
define internal ptr @milo.str.alloc(i64 %n) {
entry:
  %huge = icmp ugt i64 %n, -9
  br i1 %huge, label %fail, label %go
go:
  %sz = add i64 %n, 8
  %p = call ptr @malloc(i64 %sz)
  %ok = icmp ne ptr %p, null
  br i1 %ok, label %init, label %fail
init:
  store i64 1, ptr %p, align 8
  %d = getelementptr i8, ptr %p, i64 8
  ret ptr %d
fail:
  ret ptr null
}

; @@ milo.str.free
; Frees a buffer this handle is known to hold alone (after @milo.str.unique).
define internal void @milo.str.free(ptr %d) {
entry:
  %h = getelementptr i8, ptr %d, i64 -8
  call void @free(ptr %h)
  ret void
}

; @@ milo.str.release
; Drops one handle to a heap buffer (the caller has checked cap > 0).
define internal void @milo.str.release(ptr %d) {
entry:
  %h = getelementptr i8, ptr %d, i64 -8
  %rc = load atomic i64, ptr %h acquire, align 8
  %only = icmp eq i64 %rc, 1
  br i1 %only, label %free, label %dec
dec:
  %old = atomicrmw sub ptr %h, i64 1 release, align 8
  %last = icmp eq i64 %old, 1
  br i1 %last, label %sync, label %done
sync:
  fence acquire
  br label %free
free:
  call void @free(ptr %h)
  br label %done
done:
  ret void
}

; @@ milo.str.from
; A fresh unique copy of `len` bytes, NUL-terminated. Aborts when out of memory.
define internal %String @milo.str.from(ptr %src, i64 %len) {
entry:
  %cap = add i64 %len, 1
  %b = call ptr @milo.str.alloc(i64 %cap)
  %ok = icmp ne ptr %b, null
  br i1 %ok, label %fill, label %oom
oom:
  call void @milo.str.oom()
  unreachable
fill:
  call ptr @memcpy(ptr %b, ptr %src, i64 %len)
  %end = getelementptr i8, ptr %b, i64 %len
  store i8 0, ptr %end
  %r0 = insertvalue %String undef, ptr %b, 0
  %r1 = insertvalue %String %r0, i64 %len, 1
  %r2 = insertvalue %String %r1, i64 %cap, 2
  ret %String %r2
}

; @@ milo.str.share
; A second owning handle to the same text. A heap buffer is shared by count. A cap-0
; string is copied: it may be a view into a buffer someone else owns, and a literal
; costs no more to copy than it does today.
define internal %String @milo.str.share(%String %s) {
entry:
  %cap = extractvalue %String %s, 2
  %heap = icmp ugt i64 %cap, 0
  br i1 %heap, label %inc, label %copy
inc:
  %d = extractvalue %String %s, 0
  %h = getelementptr i8, ptr %d, i64 -8
  %old = atomicrmw add ptr %h, i64 1 monotonic, align 8
  ret %String %s
copy:
  %d2 = extractvalue %String %s, 0
  %len = extractvalue %String %s, 1
  %r = call %String @milo.str.from(ptr %d2, i64 %len)
  ret %String %r
}

; @@ milo.str.unique
; Make the %String at %s the only handle to its buffer before a write. A cap-0 string
; is left alone (every writer already copies a literal out first); a shared heap
; buffer is copied with the same capacity and this handle's count released.
define internal void @milo.str.unique(ptr %s) {
entry:
  %capp = getelementptr %String, ptr %s, i32 0, i32 2
  %cap = load i64, ptr %capp
  %heap = icmp ugt i64 %cap, 0
  br i1 %heap, label %chk, label %done
chk:
  %datap = getelementptr %String, ptr %s, i32 0, i32 0
  %d = load ptr, ptr %datap
  %h = getelementptr i8, ptr %d, i64 -8
  %rc = load atomic i64, ptr %h acquire, align 8
  %only = icmp eq i64 %rc, 1
  br i1 %only, label %done, label %copy
copy:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %need = add i64 %len, 1
  %small = icmp ult i64 %cap, %need
  %nc = select i1 %small, i64 %need, i64 %cap
  %b = call ptr @milo.str.alloc(i64 %nc)
  %ok = icmp ne ptr %b, null
  br i1 %ok, label %fill, label %oom
oom:
  call void @milo.str.oom()
  unreachable
fill:
  call ptr @memcpy(ptr %b, ptr %d, i64 %len)
  %end = getelementptr i8, ptr %b, i64 %len
  store i8 0, ptr %end
  store ptr %b, ptr %datap
  store i64 %nc, ptr %capp
  call void @milo.str.release(ptr %d)
  br label %done
done:
  ret void
}

; @@ milo.str.realloc
; Resize a buffer this handle holds alone; the count (1) moves with the block.
define internal ptr @milo.str.realloc(ptr %d, i64 %n) {
entry:
  %huge = icmp ugt i64 %n, -9
  br i1 %huge, label %fail, label %go
go:
  %h = getelementptr i8, ptr %d, i64 -8
  %sz = add i64 %n, 8
  %p = call ptr @realloc(ptr %h, i64 %sz)
  %ok = icmp ne ptr %p, null
  br i1 %ok, label %fin, label %fail
fin:
  %r = getelementptr i8, ptr %p, i64 8
  ret ptr %r
fail:
  ret ptr null
}

; @@ milo.str.reserve.grow.realloc
  %r = call ptr @milo.str.realloc(ptr %old, i64 %newcap)
  br label %join

; @@ milo.str.reserve.grow.copy
  %r = call ptr @milo.str.alloc(i64 %newcap)
  %rok = icmp ne ptr %r, null
  br i1 %rok, label %recp, label %join
recp:
  call ptr @memcpy(ptr %r, ptr %old, i64 %len)
  call void @milo.str.free(ptr %old)
  br label %join

; @@ milo.str.reserve
define internal ptr @milo.str.reserve(ptr %s, i64 %extra) {
entry:
  call void @milo.str.unique(ptr %s)
  %datap = getelementptr %String, ptr %s, i32 0, i32 0
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %capp = getelementptr %String, ptr %s, i32 0, i32 2
  %len = load i64, ptr %lenp
  %cap = load i64, ptr %capp
  %old = load ptr, ptr %datap
  %need0 = add i64 %len, %extra
  %need = add i64 %need0, 1
  %fits = icmp ule i64 %need, %cap
  br i1 %fits, label %done, label %grow
grow:
  %dbl = shl i64 %cap, 1
  %small = icmp ult i64 %dbl, %need
  %nc0 = select i1 %small, i64 %need, i64 %dbl
  %tiny = icmp ult i64 %nc0, 16
  %newcap = select i1 %tiny, i64 16, i64 %nc0
  %owned = icmp ugt i64 %cap, 0
  %big = icmp uge i64 %len, {{reallocMin}}
  %usere = and i1 %owned, %big
  br i1 %usere, label %re, label %fresh
re:
  {{grow}}
fresh:
  %m = call ptr @milo.str.alloc(i64 %newcap)
  %hasold = icmp ne ptr %old, null
  %mok = icmp ne ptr %m, null
  %both = and i1 %hasold, %mok
  br i1 %both, label %cp, label %join
cp:
  call ptr @memcpy(ptr %m, ptr %old, i64 %len)
  br i1 %owned, label %freeold, label %join
freeold:
  call void @milo.str.free(ptr %old)
  br label %join
join:
  %nb = phi ptr {{reIn}}, [ %m, %fresh ], [ %m, %cp ], [ %m, %freeold ]
  %ok = icmp ne ptr %nb, null
  br i1 %ok, label %store, label %fail
fail:
  ret ptr null
store:
  store ptr %nb, ptr %datap
  store i64 %newcap, ptr %capp
  ret ptr %nb
done:
  ret ptr %old
}

; @@ milo.bufappend
define internal void @milo.bufappend(ptr %bufSlot, ptr %lenSlot, ptr %capSlot, ptr %src, i64 %n) {
entry:
  %len = load i64, ptr %lenSlot
  %cap = load i64, ptr %capSlot
  %end = add i64 %len, %n
  ; +1 so the NUL written below always has room
  %need = add i64 %end, 1
  %fits = icmp ule i64 %need, %cap
  br i1 %fits, label %copy, label %grow
grow:
  %dbl = shl i64 %cap, 1
  %small = icmp ult i64 %dbl, %need
  %newcap = select i1 %small, i64 %need, i64 %dbl
  %old = load ptr, ptr %bufSlot
  %nb = call ptr @realloc(ptr %old, i64 %newcap)
  store ptr %nb, ptr %bufSlot
  store i64 %newcap, ptr %capSlot
  br label %copy
copy:
  %buf = load ptr, ptr %bufSlot
  %dst = getelementptr i8, ptr %buf, i64 %len
  call ptr @memcpy(ptr %dst, ptr %src, i64 %n)
  store i64 %end, ptr %lenSlot
  %term = getelementptr i8, ptr %buf, i64 %end
  store i8 0, ptr %term
  ret void
}
