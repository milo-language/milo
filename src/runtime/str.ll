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

; @@ milo.strview.step
; One step of `for v in s.lines()` / `s.splitView(sep)` (legacy genForStrView's loop body,
; for the MLIR backend): false when the pieces ran out; else the next piece, a view into
; s's buffer (cap 0), in *out and the next start in *posp. Lines pass sep = "\n", split=0.
define internal i1 @milo.strview.step(ptr %s, ptr %sep, i1 %split, ptr %posp, ptr %out) {
entry:
  %data = load ptr, ptr %s
  %lenp = getelementptr inbounds { ptr, i64, i64 }, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %sdata = load ptr, ptr %sep
  %slenp = getelementptr inbounds { ptr, i64, i64 }, ptr %sep, i32 0, i32 1
  %slen = load i64, ptr %slenp
  %pos = load i64, ptr %posp
; a trailing newline ends the last line; `pos == len` still yields the piece after a
; trailing separator, except for an empty one, which runs out one step earlier
  %lt = icmp slt i64 %pos, %len
  %le = icmp sle i64 %pos, %len
  %sepEmpty = icmp eq i64 %slen, 0
  %okEmpty = select i1 %sepEmpty, i1 %lt, i1 true
  %splitMore = and i1 %le, %okEmpty
  %more = select i1 %split, i1 %splitMore, i1 %lt
  br i1 %more, label %body, label %done
done:
  ret i1 false
body:
  %found = call i64 @milo.strfind(ptr %data, i64 %len, ptr %sdata, i64 %slen, i64 %pos)
; an empty needle matches at pos and would never advance: the next byte is the separator
  %pos1 = add i64 %pos, 1
  %emptySplit = and i1 %split, %sepEmpty
  %sepIdx = select i1 %emptySplit, i64 %pos1, i64 %found
  %hasSep = icmp sge i64 %sepIdx, 0
  %pieceEnd = select i1 %hasSep, i64 %sepIdx, i64 %len
  br i1 %split, label %emit, label %crlf
crlf:
; CRLF: the '\r' belongs to the line ending; the probe is clamped inside the buffer
  %nonEmpty = icmp sgt i64 %pieceEnd, %pos
  %prev = sub i64 %pieceEnd, 1
  %probeIdx = select i1 %nonEmpty, i64 %prev, i64 %pos
  %probeP = getelementptr i8, ptr %data, i64 %probeIdx
  %probe = load i8, ptr %probeP
  %isCR = icmp eq i8 %probe, 13
  %strip = and i1 %nonEmpty, %isCR
  %lineEnd = select i1 %strip, i64 %prev, i64 %pieceEnd
  br label %emit
emit:
  %viewEnd = phi i64 [ %pieceEnd, %body ], [ %lineEnd, %crlf ]
  %vp = getelementptr i8, ptr %data, i64 %pos
  %vl = sub i64 %viewEnd, %pos
  store ptr %vp, ptr %out
  %olp = getelementptr inbounds { ptr, i64, i64 }, ptr %out, i32 0, i32 1
  store i64 %vl, ptr %olp
  %ocp = getelementptr inbounds { ptr, i64, i64 }, ptr %out, i32 0, i32 2
  store i64 0, ptr %ocp
  %after = add i64 %pieceEnd, %slen
  %pastEnd = add i64 %len, 1
  %next = select i1 %hasSep, i64 %after, i64 %pastEnd
  store i64 %next, ptr %posp
  ret i1 true
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

; @@ milo.fmt.g
; The "%.*g" format both float formatters hand snprintf.
@milo.fmt.g = private unnamed_addr constant [5 x i8] c"%.*g\00"

; @@ milo.fmt.f64
; A double as the shortest %.*g that strtod reads back exactly (at most 17 digits),
; written to %buf (F64_BUF bytes); returns its length. -0.0 prints as "-0".
define private i64 @milo.fmt.f64(double %v, ptr %buf) {
entry.bb:
  %d = fadd double %v, -0.000000e+00
  %isneg = fcmp olt double %d, 0.000000e+00
  %negd = fneg double %d
  %av = select i1 %isneg, double %negd, double %d
  br label %dloop
dloop:
  %dig = phi i32 [ 1, %entry.bb ], [ %dignext, %dnext ]
  %pow = phi double [ 1.000000e+01, %entry.bb ], [ %pownext, %dnext ]
  %room = icmp slt i32 %dig, 17
  %over = fcmp oge double %av, %pow
  %grow = and i1 %room, %over
  br i1 %grow, label %dnext, label %ploop
dnext:
  %dignext = add i32 %dig, 1
  %pownext = fmul double %pow, 1.000000e+01
  br label %dloop
ploop:
  %p = phi i32 [ %dig, %dloop ], [ %pnext, %again ]
  %n = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %buf, i64 32, ptr @milo.fmt.g, i32 %p, double %d)
  %back = call double @strtod(ptr %buf, ptr null)
  %exact = fcmp oeq double %back, %v
  %last = icmp sge i32 %p, 17
  %stop = or i1 %exact, %last
  br i1 %stop, label %fin, label %again
again:
  %pnext = add i32 %p, 1
  br label %ploop
fin:
  %n64 = sext i32 %n to i64
  ret i64 %n64
}

; @@ milo.fmt.f32
; milo.fmt.f64 for a float: at most 9 digits, read back with strtof.
define private i64 @milo.fmt.f32(float %v, ptr %buf) {
entry.bb:
  %d = fpext float %v to double
  %isneg = fcmp olt double %d, 0.000000e+00
  %negd = fneg double %d
  %av = select i1 %isneg, double %negd, double %d
  br label %dloop
dloop:
  %dig = phi i32 [ 1, %entry.bb ], [ %dignext, %dnext ]
  %pow = phi double [ 1.000000e+01, %entry.bb ], [ %pownext, %dnext ]
  %room = icmp slt i32 %dig, 9
  %over = fcmp oge double %av, %pow
  %grow = and i1 %room, %over
  br i1 %grow, label %dnext, label %ploop
dnext:
  %dignext = add i32 %dig, 1
  %pownext = fmul double %pow, 1.000000e+01
  br label %dloop
ploop:
  %p = phi i32 [ %dig, %dloop ], [ %pnext, %again ]
  %n = call i32 (ptr, i64, ptr, ...) @snprintf(ptr %buf, i64 32, ptr @milo.fmt.g, i32 %p, double %d)
  %back = call float @strtof(ptr %buf, ptr null)
  %exact = fcmp oeq float %back, %v
  %last = icmp sge i32 %p, 9
  %stop = or i1 %exact, %last
  br i1 %stop, label %fin, label %again
again:
  %pnext = add i32 %p, 1
  br label %ploop
fin:
  %n64 = sext i32 %n to i64
  ret i64 %n64
}

; @@ milo.string.concat
; `a + b`, a fresh string of both (count 1, NUL-terminated); the MLIR path's string
; concat (milo.string.concat lowers to a call of this).
define internal %String @milo.string.concat(ptr nonnull dereferenceable(24) align 8 %a, ptr nonnull dereferenceable(24) align 8 %b) {
entry:
  %as = load %String, ptr %a
  %bs = load %String, ptr %b
  %ad = extractvalue %String %as, 0
  %al = extractvalue %String %as, 1
  %bd = extractvalue %String %bs, 0
  %bl = extractvalue %String %bs, 1
  %len = add i64 %al, %bl
  %cap = add i64 %len, 1
  %buf = call ptr @milo.str.alloc(i64 %cap)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %fill, label %oom
oom:
  call void @milo.str.oom()
  unreachable
fill:
  call ptr @memcpy(ptr %buf, ptr %ad, i64 %al)
  %tail = getelementptr i8, ptr %buf, i64 %al
  call ptr @memcpy(ptr %tail, ptr %bd, i64 %bl)
  %end = getelementptr i8, ptr %buf, i64 %len
  store i8 0, ptr %end
  %s0 = insertvalue %String undef, ptr %buf, 0
  %s1 = insertvalue %String %s0, i64 %len, 1
  %s2 = insertvalue %String %s1, i64 %cap, 2
  ret %String %s2
}

; @@ milo.string.append
; `s.pushStr(x)`: x's bytes appended to s in place (unique first, then grown by
; milo.str.reserve). x may point into s's own buffer (`s.pushStr(s)`): its data pointer
; is re-based onto the buffer reserve returns.
define internal void @milo.string.append(ptr noalias nonnull dereferenceable(24) align 8 %s, ptr nonnull dereferenceable(24) align 8 %x) {
entry:
  %xs = load %String, ptr %x
  %xd = extractvalue %String %xs, 0
  %xl = extractvalue %String %xs, 1
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %datap = getelementptr %String, ptr %s, i32 0, i32 0
  %old = load ptr, ptr %datap
  %oldi = ptrtoint ptr %old to i64
  %buf = call ptr @milo.str.reserve(ptr %s, i64 %xl)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %copy, label %oom
oom:
  call void @milo.str.oom()
  unreachable
copy:
  %dst = getelementptr i8, ptr %buf, i64 %len
  %xdi = ptrtoint ptr %xd to i64
  %off = sub i64 %xdi, %oldi
  %inside = icmp ult i64 %off, %len
  %moved = getelementptr i8, ptr %buf, i64 %off
  %src = select i1 %inside, ptr %moved, ptr %xd
  call ptr @memcpy(ptr %dst, ptr %src, i64 %xl)
  %nlen = add i64 %len, %xl
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret void
}

; @@ milo.string.eq
; `a == b` on strings: equal lengths, then equal bytes.
define internal i1 @milo.string.eq(ptr nonnull dereferenceable(24) align 8 %a, ptr nonnull dereferenceable(24) align 8 %b) {
entry:
  %as = load %String, ptr %a
  %bs = load %String, ptr %b
  %al = extractvalue %String %as, 1
  %bl = extractvalue %String %bs, 1
  %leq = icmp eq i64 %al, %bl
  br i1 %leq, label %bytes, label %done
bytes:
  %ad = extractvalue %String %as, 0
  %bd = extractvalue %String %bs, 0
  %c = call i32 @memcmp(ptr %ad, ptr %bd, i64 %al)
  %ceq = icmp eq i32 %c, 0
  br label %done
done:
  %r = phi i1 [ false, %entry ], [ %ceq, %bytes ]
  ret i1 %r
}

; @@ milo.string.cmp
; String ordering, three-way: negative, zero or positive as a sorts before, with or after
; b. Bytes compare unsigned over the shorter length (memcmp); a prefix sorts first.
define internal i32 @milo.string.cmp(ptr nonnull dereferenceable(24) align 8 %a, ptr nonnull dereferenceable(24) align 8 %b) {
entry:
  %as = load %String, ptr %a
  %bs = load %String, ptr %b
  %ad = extractvalue %String %as, 0
  %al = extractvalue %String %as, 1
  %bd = extractvalue %String %bs, 0
  %bl = extractvalue %String %bs, 1
  %short = icmp ult i64 %al, %bl
  %n = select i1 %short, i64 %al, i64 %bl
  %c = call i32 @memcmp(ptr %ad, ptr %bd, i64 %n)
  %same = icmp eq i32 %c, 0
  br i1 %same, label %bylen, label %done
bylen:
  %gt = icmp ugt i64 %al, %bl
  %gti = zext i1 %gt to i32
  %lti = zext i1 %short to i32
  %l = sub i32 %gti, %lti
  br label %done
done:
  %r = phi i32 [ %c, %entry ], [ %l, %bylen ]
  ret i32 %r
}

; @@ milo.string.reserve
; `_strReserve(&mut s, extra)`: s's data pointer with room for `extra` more bytes and the
; NUL, in a buffer s holds alone; null when growing fails. The fast path (room, and a count
; of 1, which a heap buffer with room implies is safe to write) is small enough to inline;
; anything else goes through @milo.str.reserve, which copies or grows.
define internal ptr @milo.string.reserve(ptr noalias nonnull dereferenceable(24) align 8 %s, i64 %extra) {
entry:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %capp = getelementptr %String, ptr %s, i32 0, i32 2
  %cap = load i64, ptr %capp
  %need = add i64 %len, %extra
  %room = icmp ult i64 %need, %cap
  br i1 %room, label %chk, label %slow
chk:
  %datap = getelementptr %String, ptr %s, i32 0, i32 0
  %data = load ptr, ptr %datap
  %hdr = getelementptr i8, ptr %data, i64 -8
  %rc = {{rcload}}
  %only = icmp eq i64 %rc, 1
  br i1 %only, label %fast, label %slow
fast:
  ret ptr %data
slow:
  %grown = call ptr @milo.str.reserve(ptr %s, i64 %extra)
  ret ptr %grown
}

; @@ milo.string.push_i64
; Appends v's decimal digits to s in place (unique first). Returns s's buffer, or null
; when growing fails, so the caller's check reports it at its site.
define internal ptr @milo.string.push_i64(ptr noalias nonnull dereferenceable(24) align 8 %s, i64 %v) {
entry:
  %buf = call ptr @milo.str.reserve(ptr %s, i64 20)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %fmt, label %fail
fmt:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %dst = getelementptr i8, ptr %buf, i64 %len
  %n = call i64 @milo.fmt.i64(ptr %dst, i64 %v)
  %nlen = add i64 %len, %n
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}

; @@ milo.string.push_u64
; milo.string.push_i64 for an unsigned value.
define internal ptr @milo.string.push_u64(ptr noalias nonnull dereferenceable(24) align 8 %s, i64 %v) {
entry:
  %buf = call ptr @milo.str.reserve(ptr %s, i64 20)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %fmt, label %fail
fmt:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %dst = getelementptr i8, ptr %buf, i64 %len
  %n = call i64 @milo.fmt.u64(ptr %dst, i64 %v)
  %nlen = add i64 %len, %n
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}

; @@ milo.string.push_f64
; Appends v as milo.fmt.f64 writes it (the shortest round-tripping digits).
define internal ptr @milo.string.push_f64(ptr noalias nonnull dereferenceable(24) align 8 %s, double %v) {
entry:
  %tmp = alloca [32 x i8], align 1
  %n = call i64 @milo.fmt.f64(double %v, ptr %tmp)
  %buf = call ptr @milo.str.reserve(ptr %s, i64 %n)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %copy, label %fail
copy:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %dst = getelementptr i8, ptr %buf, i64 %len
  call ptr @memcpy(ptr %dst, ptr %tmp, i64 %n)
  %nlen = add i64 %len, %n
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}

; @@ milo.string.push_f32
; milo.string.push_f64 for an f32, through milo.fmt.f32 (the shortest f32 digits).
define internal ptr @milo.string.push_f32(ptr noalias nonnull dereferenceable(24) align 8 %s, float %v) {
entry:
  %tmp = alloca [32 x i8], align 1
  %n = call i64 @milo.fmt.f32(float %v, ptr %tmp)
  %buf = call ptr @milo.str.reserve(ptr %s, i64 %n)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %copy, label %fail
copy:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %dst = getelementptr i8, ptr %buf, i64 %len
  call ptr @memcpy(ptr %dst, ptr %tmp, i64 %n)
  %nlen = add i64 %len, %n
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}

; @@ milo.string.push_bool
; Appends "true" or "false" to s in place; null when growing fails.
@milo.string.true = private unnamed_addr constant [4 x i8] c"true"
@milo.string.false = private unnamed_addr constant [5 x i8] c"false"
define internal ptr @milo.string.push_bool(ptr noalias nonnull dereferenceable(24) align 8 %s, i1 %v) {
entry:
  %src = select i1 %v, ptr @milo.string.true, ptr @milo.string.false
  %n = select i1 %v, i64 4, i64 5
  %buf = call ptr @milo.str.reserve(ptr %s, i64 %n)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %copy, label %fail
copy:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %dst = getelementptr i8, ptr %buf, i64 %len
  call ptr @memcpy(ptr %dst, ptr %src, i64 %n)
  %nlen = add i64 %len, %n
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}

; @@ milo.string.push_ptr
; Appends a pointer as `0x` and lowercase hex digits (`0x0` for null), the same text on
; every target.
define internal ptr @milo.string.push_ptr(ptr noalias nonnull dereferenceable(24) align 8 %s, ptr %p) {
entry:
  %v = ptrtoint ptr %p to i64
  %tmp = alloca [18 x i8], align 1
  br label %count
count:
  %i = phi i64 [ 0, %entry ], [ %inext, %count ]
  %sh = shl i64 %i, 2
  %rest = lshr i64 %v, %sh
  %inext = add i64 %i, 1
  %more = icmp ugt i64 %rest, 15
  br i1 %more, label %count, label %digits
digits:
  %nd = add i64 %i, 1
  %n = add i64 %nd, 2
  store i8 48, ptr %tmp
  %x = getelementptr i8, ptr %tmp, i64 1
  store i8 120, ptr %x
  br label %emit
emit:
  %k = phi i64 [ 0, %digits ], [ %knext, %emit ]
  %pos = sub i64 %i, %k
  %psh = shl i64 %pos, 2
  %pv = lshr i64 %v, %psh
  %nib = and i64 %pv, 15
  %big = icmp ugt i64 %nib, 9
  %lo = add i64 %nib, 48
  %hi = add i64 %nib, 87
  %ch = select i1 %big, i64 %hi, i64 %lo
  %c8 = trunc i64 %ch to i8
  %at = add i64 %k, 2
  %dst = getelementptr i8, ptr %tmp, i64 %at
  store i8 %c8, ptr %dst
  %knext = add i64 %k, 1
  %done = icmp ugt i64 %knext, %i
  br i1 %done, label %append, label %emit
append:
  %buf = call ptr @milo.str.reserve(ptr %s, i64 %n)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %copy, label %fail
copy:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len = load i64, ptr %lenp
  %out = getelementptr i8, ptr %buf, i64 %len
  call ptr @memcpy(ptr %out, ptr %tmp, i64 %n)
  %nlen = add i64 %len, %n
  store i64 %nlen, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %nlen
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}

; @@ milo.string.drop
; Drops the string at %s: one handle fewer on a heap buffer (cap > 0); a literal or an
; empty string holds none.
define internal void @milo.string.drop(ptr %s) {
entry:
  %capp = getelementptr %String, ptr %s, i32 0, i32 2
  %cap = load i64, ptr %capp
  %heap = icmp ugt i64 %cap, 0
  br i1 %heap, label %rel, label %done
rel:
  %datap = getelementptr %String, ptr %s, i32 0, i32 0
  %d = load ptr, ptr %datap
  call void @milo.str.release(ptr %d)
  br label %done
done:
  ret void
}

; @@ milo.closure.drop
; Drops the owning closure { fn, env } at %c: an env's first word is its drop function,
; null for a by-reference closure (its env is a frame's slot); a closure that captured
; nothing has no env at all.
define internal void @milo.closure.drop(ptr %c) {
entry:
  %envp = getelementptr { ptr, ptr }, ptr %c, i32 0, i32 1
  %env = load ptr, ptr %envp
  %has = icmp ne ptr %env, null
  br i1 %has, label %mid, label %done
mid:
  %fn = load ptr, ptr %env
  %hasfn = icmp ne ptr %fn, null
  br i1 %hasfn, label %call, label %done
call:
  call void %fn(ptr %env)
  br label %done
done:
  ret void
}

; @@ milo.iface.drop
; Drops the Heap<Interface> { data, itable } at %h: the concrete type's destructor from the
; itable's slot %slot (after the methods; null when the type has none), then the box.
define internal void @milo.iface.drop(ptr %h, i64 %slot) {
entry:
  %data = load ptr, ptr %h
  %live = icmp ne ptr %data, null
  br i1 %live, label %drop, label %done
drop:
  %itp = getelementptr { ptr, ptr }, ptr %h, i32 0, i32 1
  %it = load ptr, ptr %itp
  %sp = getelementptr ptr, ptr %it, i64 %slot
  %fn = load ptr, ptr %sp
  %hasfn = icmp ne ptr %fn, null
  br i1 %hasfn, label %call, label %free
call:
  call void %fn(ptr %data)
  br label %free
free:
  call void @free(ptr %data)
  br label %done
done:
  ret void
}

; @@ milo.string.push_json
; Appends the n bytes at %d to s JSON-escaped (RFC 8259, as std/json's jsonEscapeStr):
; " \ newline tab return as two-byte escapes, any other byte below 0x20 as \u00xx.
; Null when growing fails.
define internal ptr @milo.string.push_json(ptr noalias nonnull dereferenceable(24) align 8 %s, ptr %d, i64 %n) {
entry:
  %worst = mul i64 %n, 6
  %buf = call ptr @milo.str.reserve(ptr %s, i64 %worst)
  %ok = icmp ne ptr %buf, null
  br i1 %ok, label %start, label %fail
start:
  %lenp = getelementptr %String, ptr %s, i32 0, i32 1
  %len0 = load i64, ptr %lenp
  br label %loop
loop:
  %i = phi i64 [ 0, %start ], [ %inext, %next ]
  %o = phi i64 [ %len0, %start ], [ %onext, %next ]
  %more = icmp ult i64 %i, %n
  br i1 %more, label %byte, label %done
byte:
  %cp = getelementptr i8, ptr %d, i64 %i
  %c = load i8, ptr %cp
  %isq = icmp eq i8 %c, 34
  %isb = icmp eq i8 %c, 92
  %isn = icmp eq i8 %c, 10
  %ist = icmp eq i8 %c, 9
  %isr = icmp eq i8 %c, 13
  %e1 = or i1 %isq, %isb
  %e2 = or i1 %isn, %ist
  %e3 = or i1 %e1, %e2
  %named = or i1 %e3, %isr
  br i1 %named, label %esc, label %notnamed
esc:
  %s1 = select i1 %isn, i8 110, i8 %c
  %s2 = select i1 %ist, i8 116, i8 %s1
  %s3 = select i1 %isr, i8 114, i8 %s2
  %ep0 = getelementptr i8, ptr %buf, i64 %o
  store i8 92, ptr %ep0
  %eo1 = add i64 %o, 1
  %ep1 = getelementptr i8, ptr %buf, i64 %eo1
  store i8 %s3, ptr %ep1
  %eo2 = add i64 %o, 2
  br label %next
notnamed:
  %isctl = icmp ult i8 %c, 32
  br i1 %isctl, label %ctl, label %plain
ctl:
  %c0 = getelementptr i8, ptr %buf, i64 %o
  store i8 92, ptr %c0
  %o1 = add i64 %o, 1
  %c1 = getelementptr i8, ptr %buf, i64 %o1
  store i8 117, ptr %c1
  %o2 = add i64 %o, 2
  %c2 = getelementptr i8, ptr %buf, i64 %o2
  store i8 48, ptr %c2
  %o3 = add i64 %o, 3
  %c3 = getelementptr i8, ptr %buf, i64 %o3
  store i8 48, ptr %c3
  %hi = lshr i8 %c, 4
  %hid = add i8 %hi, 48
  %o4 = add i64 %o, 4
  %c4 = getelementptr i8, ptr %buf, i64 %o4
  store i8 %hid, ptr %c4
  %lo = and i8 %c, 15
  %lodig = add i8 %lo, 48
  %loalpha = add i8 %lo, 87
  %lolt = icmp ult i8 %lo, 10
  %lod = select i1 %lolt, i8 %lodig, i8 %loalpha
  %o5 = add i64 %o, 5
  %c5 = getelementptr i8, ptr %buf, i64 %o5
  store i8 %lod, ptr %c5
  %o6 = add i64 %o, 6
  br label %next
plain:
  %pp = getelementptr i8, ptr %buf, i64 %o
  store i8 %c, ptr %pp
  %op1 = add i64 %o, 1
  br label %next
next:
  %onext = phi i64 [ %eo2, %esc ], [ %o6, %ctl ], [ %op1, %plain ]
  %inext = add i64 %i, 1
  br label %loop
done:
  store i64 %o, ptr %lenp
  %end = getelementptr i8, ptr %buf, i64 %o
  store i8 0, ptr %end
  ret ptr %buf
fail:
  ret ptr null
}
